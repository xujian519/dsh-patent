import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '../src/index.ts'
import { WRITING_PATTERNS_SECTION_NAME } from '../src/prompt.ts'
import type { QueryWritingPatternsOutput } from '../src/tool/query-writing-patterns.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function install(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const fiber = await ctx.plugin(Pkg, config)
  return { ctx, fiber }
}

describe('@deepseek-ai/dsh-writing-patterns plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('writing-patterns')
    expect(Pkg.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
  })

  it('exports the library API', () => {
    expect(typeof Pkg.PatternStore).toBe('function')
    expect(typeof Pkg.loadPatternStore).toBe('function')
    expect(typeof Pkg.loadPatternCorpus).toBe('function')
    expect(typeof Pkg.parsePatternFile).toBe('function')
    expect(typeof Pkg.patternKeywords).toBe('function')
    expect(typeof Pkg.compileWritingSkills).toBe('function')
    expect(typeof Pkg.compileWritingPatternIndex).toBe('function')
    expect(typeof Pkg.WritingPatternsService).toBe('function')
    expect(typeof Pkg.escapeXmlText).toBe('function')
    expect(typeof Pkg.renderWritingSkillsSection).toBe('function')
    expect(typeof Pkg.createQueryWritingPatternsTool).toBe('function')
    expect(typeof Pkg.renderQueryWritingPatterns).toBe('function')
    expect(typeof Pkg.isPatternCategory).toBe('function')
    expect(Pkg.PATTERN_FILE_SUFFIXES).toEqual(['.yaml', '.yml'])
    expect(Pkg.PATTERN_CATEGORIES.length).toBeGreaterThan(0)
    expect(new Set(Pkg.PATTERN_CATEGORIES).size).toBe(Pkg.PATTERN_CATEGORIES.length)
    expect(Pkg.DEFAULT_PATTERN_QUALITY).toBe(0.8)
    expect(Pkg.WRITING_PATTERNS_SECTION_NAME).toBe('writing-patterns:skills')
  })

  it('registers the tool and the section, and removes both on dispose', async () => {
    const { ctx, fiber } = await install()
    expect(ctx.tools.schemas().some(schema => schema.name === 'query_writing_patterns')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain(WRITING_PATTERNS_SECTION_NAME)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'query_writing_patterns')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain(WRITING_PATTERNS_SECTION_NAME)
  })

  it('indexes the whole library by default and narrows it to the configured categories', async () => {
    const whole = await install()
    const wholeText = (await whole.ctx.systemPrompt.assemble()).sections
      .find(section => section.name === WRITING_PATTERNS_SECTION_NAME)?.text ?? ''
    expect(wholeText).toContain(Pkg.WRITING_PATTERNS_PROMPT_TEXT)
    expect(wholeText).toContain('<pattern id="wp-claim-utility-model"')
    expect(wholeText).toContain('<pattern id="wp-oa-inventiveness-3step"')
    expect(wholeText).not.toContain('<steps>')

    const narrow = await install({ sectionCategories: ['claim_drafting'] })
    const narrowText = (await narrow.ctx.systemPrompt.assemble()).sections
      .find(section => section.name === WRITING_PATTERNS_SECTION_NAME)?.text ?? ''
    expect(narrowText).toContain('<pattern id="wp-claim-dependent-layering"')
    expect(narrowText).not.toContain('wp-oa-inventiveness-3step')
  })

  it('uses its built-in defaults when a direct caller supplies no optional config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    Pkg.apply(ctx, {})
    expect(ctx.tools.schemas().some(schema => schema.name === 'query_writing_patterns')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain(WRITING_PATTERNS_SECTION_NAME)
  })

  it('lists a pattern once when a requested category is also its sub-category', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-writing-patterns-overlap-'))
    await writeFile(join(root, 'overlap.yaml'), [
      'id: overlap-pattern',
      'name: 重叠类目模式',
      'category: spec_drafting',
      'sub_category: disclosure',
      'summary: 同时属于两个请求类目',
      '',
    ].join('\n'))
    const { ctx } = await install({ patternDir: root, sectionCategories: ['spec_drafting', 'disclosure'] })
    const text = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === WRITING_PATTERNS_SECTION_NAME)?.text ?? ''
    expect(text.match(/<pattern id="overlap-pattern"/gu)).toHaveLength(1)
  })

  it('fences the compiled index so the section keeps one physical line per paragraph', async () => {
    const { ctx } = await install({ sectionCategories: ['claim_drafting'] })
    const text = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === WRITING_PATTERNS_SECTION_NAME)?.text ?? ''
    expect(text).toContain('```xml\n<pattern_index>')
    expect(text.endsWith('</pattern_index>\n```')).toBe(true)
  })

  it('keeps the section out of the prompt when it is disabled', async () => {
    const { ctx } = await install({ registerSection: false })
    expect(ctx.tools.schemas().some(schema => schema.name === 'query_writing_patterns')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain(WRITING_PATTERNS_SECTION_NAME)
  })

  it('places the section at the configured order', async () => {
    const { ctx } = await install({ sectionCategories: [], sectionOrder: 700 })
    ctx.systemPrompt.section({ name: 'test:anchor', order: 900, text: 'anchor' })
    const names = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(names.indexOf(WRITING_PATTERNS_SECTION_NAME)).toBeLessThan(names.indexOf('test:anchor'))
  })

  it('applies the configured result cap to narrowed calls but not to the argument-free listing', async () => {
    const { ctx } = await install({ matchLimit: 1 })
    const narrowed = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('query-writing-patterns-cap'),
      name: 'query_writing_patterns',
      arguments: { query: '创造性' },
    })
    if (narrowed.isError) throw new Error('expected success')
    expect((narrowed.value as QueryWritingPatternsOutput).patterns).toHaveLength(1)

    const catalog = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('query-writing-patterns-catalog'),
      name: 'query_writing_patterns',
      arguments: {},
    })
    if (catalog.isError) throw new Error('expected success')
    const value = catalog.value as QueryWritingPatternsOutput
    expect(value.patterns).toHaveLength(value.librarySize)
    expect(value.patterns.length).toBeGreaterThan(1)
  })

  it('fails loud at load when the configured corpus directory has no asset', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await expect(ctx.plugin(Pkg, { patternDir: '/nonexistent/pattern-dir' })).rejects.toThrow(/无法读取写作模式资产目录/)
  })

  it('replaces the packaged corpus with the configured directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-writing-patterns-config-'))
    await writeFile(join(root, 'custom.yaml'), [
      'id: deployment-pattern',
      'name: 本所独权模板',
      'category: claim_drafting',
      'summary: 本部署专用的独权写法',
      'quality: 1',
      '',
    ].join('\n'))
    const { ctx } = await install({ patternDir: root })

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('query-writing-patterns-custom'),
      name: 'query_writing_patterns',
      arguments: {},
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as QueryWritingPatternsOutput
    expect(value.patterns.map(pattern => pattern.id)).toEqual(['deployment-pattern'])
    expect(value.librarySize).toBe(1)

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === WRITING_PATTERNS_SECTION_NAME)
    expect(section?.text).toContain('<pattern id="deployment-pattern"')
    expect(section?.text).not.toContain('wp-claim-utility-model')
  })

  it('resolves a stage to its declared patterns and compiles only those', async () => {
    const { ctx } = await install({
      stagePatterns: {
        draft_claims: ['wp-claim-dependent-layering', 'wp-claim-utility-model', 'wp-claim-3step-prior-art-check'],
      },
    })
    expect(ctx.writingPatterns.stageIds()).toEqual(['draft_claims'])
    expect(ctx.writingPatterns.patternsForStage('draft_claims').map(pattern => pattern.id))
      .toEqual(['wp-claim-dependent-layering', 'wp-claim-utility-model', 'wp-claim-3step-prior-art-check'])
    const compiled = ctx.writingPatterns.compiledForStage('draft_claims')
    expect(compiled).toContain('<skill id="wp-claim-dependent-layering">')
    expect(compiled).not.toContain('wp-oa-inventiveness-3step')
    expect(() => ctx.writingPatterns.patternsForStage('spec_check')).toThrow(/未声明阶段 "spec_check"/)
  })

  it('fails loud on an invalid stage map', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    expect(() => { Pkg.apply(ctx, { stagePatterns: { s: ['a', 'b'] } }) })
      .toThrow(/应为 3 到 5 条/)
    expect(() => { Pkg.apply(ctx, { stagePatterns: { s: ['wp-claim-utility-model', 'wp-claim-utility-model', 'wp-claim-dependent-layering'] } }) })
      .toThrow(/重复声明写作模式 "wp-claim-utility-model"/)
    expect(() => { Pkg.apply(ctx, { stagePatterns: { s: ['a', 'b', 'c'] } }) })
      .toThrow(/不存在的写作模式/)
  })
})
