import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { loadPatternStore } from '../src/pattern-store.ts'
import {
  createQueryWritingPatternsTool,
  renderQueryWritingPatterns,
  type QueryWritingPatternsOutput,
} from '../src/tool/query-writing-patterns.ts'
import { PATTERN_CATEGORIES } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const MATCH_LIMIT = 5

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createQueryWritingPatternsTool({ store: loadPatternStore(), matchLimit: MATCH_LIMIT }))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('query-writing-patterns'),
    name: 'query_writing_patterns',
    arguments: args,
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('query_writing_patterns schema', () => {
  it('declares the category enum, the feature list, and the result limit', async () => {
    const ctx = await host()
    const tool = ctx.tools.get('query_writing_patterns')
    const properties = (tool?.parameters as { properties: Record<string, { enum?: string[]; type?: string }> }).properties
    expect(Object.keys(properties).sort()).toEqual(['category', 'features', 'limit', 'query'])
    expect(properties['category']?.enum).toEqual(PATTERN_CATEGORIES)
    expect(properties['features']?.type).toEqual('array')
    expect(properties['limit']?.type).toEqual('integer')
  })

  it('declares the compiled block and the selection mode as required output', async () => {
    const ctx = await host()
    const schema = ctx.tools.get('query_writing_patterns')?.output.schema as {
      required: string[]
      properties: Record<string, { enum?: string[]; items?: { properties: Record<string, unknown> } }>
    }
    expect(schema.required.sort()).toEqual(['librarySize', 'mode', 'patterns', 'skills'])
    expect(schema.properties['mode']?.enum).toEqual(['search', 'match', 'category', 'catalog'])
    expect(Object.keys(schema.properties['patterns']?.items?.properties ?? {}).sort())
      .toEqual(['category', 'id', 'name'])
  })

  it('states that the argument-free listing returns the whole library', async () => {
    const ctx = await host()
    expect(ctx.tools.get('query_writing_patterns')?.description).toContain('the whole library is listed')
  })
})

describe('query_writing_patterns output.render', () => {
  const value: QueryWritingPatternsOutput = {
    mode: 'category',
    patterns: [{
      id: 'wp-oa-inventiveness-3step',
      name: '创造性三步法 OA 答复框架',
      category: 'oa_inventiveness',
    }],
    librarySize: 10,
    skills: '<writing_skills>\n</writing_skills>',
  }

  it('renders the selected patterns and the compiled block', () => {
    expect(renderQueryWritingPatterns({ category: 'oa_inventiveness' }, value)).toBe([
      '写作模式库：命中 1 / 10 个模式（按类目列举）。',
      '',
      '匹配到的模式：',
      '- `wp-oa-inventiveness-3step` · OA 答复-创造性 · **创造性三步法 OA 答复框架**',
      '',
      '编译后的写作技能：',
      '<writing_skills>',
      '</writing_skills>',
    ].join('\n'))
  })

  it('renders the no-match guidance without a skills block', () => {
    const rendered = renderQueryWritingPatterns({ query: 'zzzz' }, { ...value, mode: 'search', patterns: [], skills: '' })
    expect(rendered).toBe('写作模式库：没有匹配的模式（库中共 10 个）。改用其他关键词或类目，或省略全部参数以列举库中的模式。')
  })
})

describe('query_writing_patterns execution', () => {
  it('lists the whole library when nothing narrows it', async () => {
    const ctx = await host()
    const result = await execute(ctx, {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('catalog')
    expect(value.librarySize).toBeGreaterThan(MATCH_LIMIT)
    expect(value.patterns).toHaveLength(value.librarySize)
    expect(value.skills).toContain('<skill id="wp-claim-dependent-layering">')
    expect(textOf(result)).toContain(
      `写作模式库：命中 ${String(value.librarySize)} / ${String(value.librarySize)} 个模式（列举模式库）。`,
    )
  })

  it('lists one category in id order', async () => {
    const ctx = await host()
    const result = await execute(ctx, { category: 'claim_drafting', limit: 10 })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('category')
    expect(value.patterns.map(pattern => pattern.id)).toEqual([
      'wp-claim-3step-prior-art-check',
      'wp-claim-dependent-layering',
      'wp-claim-functional-limitation',
      'wp-claim-markush-equivalents',
      'wp-claim-software-trio',
      'wp-claim-unity-special-feature',
      'wp-claim-utility-model',
    ])
    expect(value.skills).toContain('<skill id="wp-claim-utility-model">')
    expect(value.skills).not.toContain('wp-spec-background')
  })

  it('searches within a category when both a query and a category are given', async () => {
    const ctx = await host()
    const result = await execute(ctx, { query: '新颖性', category: 'oa_novelty' })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('search')
    expect(value.patterns.map(pattern => pattern.id)).toEqual(['wp-oa-novelty-separate'])
  })

  it('matches features within a category and ignores blank features', async () => {
    const ctx = await host()
    const result = await execute(ctx, { category: 'claim_drafting', features: ['引用关系', '   '] })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('match')
    expect(value.patterns.map(pattern => pattern.id)).toContain('wp-claim-dependent-layering')
  })

  it('matches case features without a category', async () => {
    const ctx = await host()
    const result = await execute(ctx, { features: ['创造性'] })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('match')
    expect(value.patterns.map(pattern => pattern.id)).toContain('wp-oa-inventiveness-3step')
  })

  it('caps an argument-free catalog listing with an explicit limit', async () => {
    const ctx = await host()
    const result = await execute(ctx, { limit: 2 })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('catalog')
    expect(value.patterns).toHaveLength(2)
    expect(value.librarySize).toBeGreaterThan(2)
  })

  it('searches by keyword and honours a per-call limit', async () => {
    const ctx = await host()
    const result = await execute(ctx, { query: '三步法', limit: 1 })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('search')
    expect(value.patterns.map(pattern => pattern.id)).toEqual(['wp-oa-inventiveness-3step'])
    expect(Object.keys(value.patterns[0] ?? {}).sort()).toEqual(['category', 'id', 'name'])
    expect(textOf(result)).toContain('（按关键词检索）')
  })

  it('finds patterns from a natural-language Chinese query', async () => {
    const ctx = await host()
    const result = await execute(ctx, { query: '创造性答复怎么写' })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('search')
    expect(value.patterns[0]?.id).toBe('wp-oa-inventiveness-3step')
  })

  it('matches case features and keeps the category as the case type', async () => {
    const ctx = await host()
    const result = await execute(ctx, { category: 'oa_clarity', features: ['功能性限定'] })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('match')
    expect(value.patterns.map(pattern => pattern.id)).toEqual([
      'wp-oa-clarity-support',
      'wp-claim-functional-limitation',
    ])
    expect(value.skills).toContain('<step order="3">')
  })

  it('returns an empty result when nothing matches', async () => {
    const ctx = await host()
    const result = await execute(ctx, { query: 'zzzz' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.mode).toBe('search')
    expect(value.patterns).toEqual([])
    expect(value.skills).toBe('')
    expect(value.librarySize).toBeGreaterThan(0)
    expect(textOf(result)).toContain('没有匹配的模式')
  })

  it('fails loud on a limit that is not positive', async () => {
    const ctx = await host()
    const result = await execute(ctx, { limit: 0 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('limit must be a positive integer')
  })

  it('rejects an unknown category at the schema boundary', async () => {
    const ctx = await host()
    const result = await execute(ctx, { category: 'oa_inventivness' })
    expect(result.isError).toBe(true)
  })
})
