// Real-Loader composition test: boots a test cordis.yml through the real
// Loader mounting @deepseek-ai/dsh-patent-teams over the services it needs
// (dsh-subagent, dsh-tools, dsh-system-prompt, dsh-tool-subagent-control), and
// asserts the service, all twelve patent_teams_* tools, the usage section, and the
// member capability filter are live on the real context. This is the shipped
// entry path: a hand-mounted plugin would not catch invalid Loader exports or
// missing inject services.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import FsService from '@deepseek-ai/dsh-fs'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as plugin from '../src/index.ts'
import { MEMBER_DENIED_TOOLS, memberToolAllowList } from '../src/members.ts'
import { PATENT_TEAMS_TOOL_NAMES } from '../src/tools.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineTool } from '@deepseek-ai/dsh-tools'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-patent-teams-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-fs'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-working-directory'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tool-subagent-control'",
    "- name: '@deepseek-ai/dsh-patent-teams'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-fs', FsService],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tool-subagent-control', ToolSubagentControl],
    ['@deepseek-ai/dsh-patent-teams', plugin],
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

describe('dsh-patent-teams real Loader composition', () => {
  it('mounts the service, all twelve tools, and the usage section', async () => {
    const ctx = await boot()
    expect(ctx.get('patentTeams')).toBeDefined()
    expect(PATENT_TEAMS_TOOL_NAMES).toHaveLength(12)
    for (const name of PATENT_TEAMS_TOOL_NAMES) {
      expect(ctx.tools.get(name), `tool ${name} should be registered`).toBeDefined()
    }
    const assembly = await ctx.get('systemPrompt')!.assemble()
    const sectionNames = assembly.sections.map(section => section.name)
    expect(sectionNames).toContain('patent-teams:usage')
  })

  it('accepts the member deny list and masks send_message while keeping the team channel', async () => {
    const ctx = await boot()
    // The subagent runtime hands MEMBER_DENIED_TOOLS to tools.restrict(), which
    // rejects any name outside the scope's inherited surface — so an unknown or
    // renamed entry fails member creation at patent_teams_add_member. Applying
    // the real list against a real registry is what makes that a test failure
    // instead of a first-add_member failure in a deployment.
    const key = { id: 'member-scope' as SessionId } as Agent
    let scope!: Scope
    // The subagent runtime that owns the global `send_message` tool mounts
    // beside this plugin in a deployment; this composition stands in for it.
    ctx.tools.register(defineTool({
      name: 'send_message',
      description: 'test stand-in',
      parameters: { content: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: () => [] },
      async execute() { return null },
    }))
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt'] }))
    expect(() => scope.ctx.tools.restrict({ deny: [...MEMBER_DENIED_TOOLS] })).not.toThrow()
    expect(ctx.tools.get('send_message', key)).toBeUndefined()
    expect(ctx.tools.get('patent_teams_send_message', key)).toBeDefined()
  })

  it('trims a role-scoped member to its role tools plus the shared baseline', async () => {
    const ctx = await boot()
    const standIn = (name: string) => defineTool({
      name,
      description: 'test stand-in',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      async execute() { return null },
    })
    for (const name of ['patent_search', 'patent_eval', 'mcp__cnlaw__search', 'unrelated_tool', 'send_message']) {
      ctx.tools.register(standIn(name))
    }

    // The allow list is built from the real registry: declared role tools and
    // baseline entries the composition does not carry are dropped, not passed
    // to `restrict()`, which rejects unknown names.
    const allow = memberToolAllowList(ctx, 'researcher')
    expect(allow).toBeDefined()
    expect(allow).toContain('patent_search')
    expect(allow).toContain('patent_eval')
    expect(allow).toContain('mcp__cnlaw__search')
    expect(allow).not.toContain('unrelated_tool')
    expect(allow).not.toContain('web_search')

    const key = { id: 'trimmed-member' as SessionId } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt'] }))
    scope.ctx.tools.restrict({ allow: allow!, deny: [...MEMBER_DENIED_TOOLS] })

    expect(ctx.tools.get('patent_search', key)).toBeDefined()
    expect(ctx.tools.get('patent_teams_send_message', key)).toBeDefined()
    expect(ctx.tools.get('unrelated_tool', key)).toBeUndefined()
    expect(ctx.tools.get('send_message', key)).toBeUndefined()
  })
})
