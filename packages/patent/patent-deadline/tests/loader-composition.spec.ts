// Proves the plugin is real, Loader-composed config: booting a cordis.yml
// through the Loader registers patent_deadlines and the shipped holiday
// calendar resolves from the packaged assets.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentDeadline from '@deepseek-ai/dsh-patent-deadline'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-patent-deadline-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-patent-deadline'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-patent-deadline', PatentDeadline],
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

describe('patent-deadline real Loader composition through cordis.yml', () => {
  it('boots, registers patent_deadlines, and resolves the packaged calendar', async () => {
    const ctx = await boot([])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('patent_deadlines')

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-deadlines'),
      name: 'patent_deadlines',
      arguments: { patentType: 'invention', filingDate: '2023-10-01', claimsPriority: false },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { computed: { id: string; dueDate: string }[] }
    // Resolved through the packaged assets: 2026-10-01 is 国庆节, so the
    // three-year examination request ends on the first working day after it.
    expect(value.computed.find(entry => entry.id === 'substantive-exam-request')?.dueDate).toBe('2026-10-08')
  }, 30_000)

  it('honours a configured warning horizon', async () => {
    const ctx = await boot(['    reminderLeadDays: 20000'])
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-deadlines-lead'),
      name: 'patent_deadlines',
      arguments: { patentType: 'invention', filingDate: '2023-10-01', claimsPriority: false },
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as { computed: { id: string; status: string }[] }
    expect(value.computed.find(entry => entry.id === 'patent-term')?.status).toBe('urgent')
  }, 30_000)
})
