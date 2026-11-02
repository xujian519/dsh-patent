// Proves the plugin is real, Loader-composed config: booting a cordis.yml
// through the Loader registers query_writing_patterns and injects the
// writing-patterns section whose patterns resolve from the packaged assets.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
// Relative: the package has no tsconfig.base.json alias, and the Loader maps
// the cordis.yml specifier to the plugin module handed to it below.
import * as WritingPatterns from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-writing-patterns-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-writing-patterns'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-writing-patterns', WritingPatterns],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('writing-patterns real Loader composition through cordis.yml', () => {
  it('boots, registers the tool, and resolves the packaged corpus', async () => {
    const ctx = await boot([])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('query_writing_patterns')

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('write-patterns-search'),
      name: 'query_writing_patterns',
      arguments: { query: '创造性三步法' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { patterns: { id: string }[]; librarySize: number }
    expect(value.librarySize).toBe(18)
    expect(value.patterns.length).toBeLessThanOrEqual(value.librarySize)
    expect(value.patterns[0]?.id).toBe('wp-oa-inventiveness-3step')
  }, 30_000)

  it('injects the compiled writing skills into the assembled prompt', async () => {
    const ctx = await boot([])
    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === WritingPatterns.WRITING_PATTERNS_SECTION_NAME)
    expect(section?.text).toContain('query_writing_patterns')
    expect(section?.text).toContain('<pattern_index>')
    expect(section?.text).toContain('<pattern id="wp-oa-inventiveness-3step" category="oa_inventiveness">')
  }, 30_000)

  it('honours the corpus, cap, and section scope given in cordis.yml', async () => {
    const ctx = await boot([
      '    matchLimit: 1',
      '    sectionCategories:',
      '      - oa_inventiveness',
    ])
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('write-patterns-cap'),
      name: 'query_writing_patterns',
      arguments: { query: '创造性' },
    })
    if (result.isError) throw new Error('expected success')
    expect((result.value as { patterns: unknown[] }).patterns).toHaveLength(1)

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === WritingPatterns.WRITING_PATTERNS_SECTION_NAME)
    expect(section?.text).toContain('<pattern id="wp-oa-inventiveness-3step" category="oa_inventiveness">')
    expect(section?.text).not.toContain('wp-claim-utility-model')
  }, 30_000)
})
