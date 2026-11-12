// Composition and HMR-safety test: mounts the plugin's apply() on a real
// Context with the real tools registry and system-prompt service, asserts the
// service, all twelve patent_teams_* tools, and the usage section are live,
// proves the retired-member guard is installed, then disposes the fiber and
// observes every registration removed and the guard restored. This is the
// disposal proof required by packages/AGENTS.md for registry contributions.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, inject, name, type PatentTeamsService } from '../src/index.ts'
import { recordRetiredMemberIds } from '../src/state.ts'
import { PATENT_TEAMS_TOOL_NAMES } from '../src/tools.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

let context: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patent-teams-composition-'))
  roots.push(dir)
  return dir
}

function fakeCaptain(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  })
  const agent: Agent = {
    id: SessionId(id),
    session,
    model: { current: () => undefined, select: () => {} },
    options: { provider: 'spawn', model: 'deepseek-v4' },
    status: 'idle',
    ctx: new Context(),
    inbox: {
      nextTurn: [],
      nextStep: [],
      clear() {},
      append() {},
      prepend() {},
      replace: () => false,
      remove: () => false,
      splice: () => [],
    },
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  return agent
}

interface MountOptions {
  stateDir?: string
  captain?: Agent
  children?: Array<{ id: string }>
}

function makeSubagentsStub(children: Array<{ id: string }>, captainSessionId: string): Record<string, unknown> {
  const guardProbe = {
    listDescendants: async () => children.map(child => ({
      kind: 'child',
      id: child.id,
      activity: 'inactive',
      mode: 'continuable',
      hasChildren: false,
      parentId: SessionId(captainSessionId),
      depth: 1,
    })),
    sendMessage: async () => 'msg',
  }
  return {
    getProvider: () => undefined,
    startActivation: async () => { throw new Error('unused') },
    listDescendants: guardProbe.listDescendants,
    sendMessage: guardProbe.sendMessage,
    guardProbe,
  }
}

async function mount(options: MountOptions = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  const captain = options.captain
  ctx.provide('agents', {
    get: (id: string) => captain !== undefined && id === captain.id ? captain : undefined,
  })
  ctx.provide('llm', { resolveCallConfig: async (config: unknown) => config })
  ctx.provide('subagents', makeSubagentsStub(options.children ?? [], options.captain?.id ?? 'captain-1'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin({
    name,
    inject,
    Config,
    apply: (c: Context) => {
      apply(c, options.stateDir === undefined ? {} : { stateDir: options.stateDir })
    },
  })
  return ctx
}

describe('patent-teams composition', () => {
  it('registers the service, all twelve tools, and the usage section', async () => {
    const ctx = await mount()
    expect(ctx.get('patentTeams')).toBeDefined()
    expect(PATENT_TEAMS_TOOL_NAMES).toHaveLength(12)
    for (const name of PATENT_TEAMS_TOOL_NAMES) {
      expect(ctx.tools.get(name), `tool ${name} should be registered`).toBeDefined()
    }
    const prompt = await ctx.systemPrompt.assemble()
    const sectionNames = prompt.sections.map(section => section.name)
    expect(sectionNames).toContain('patent-teams:usage')
    const usageText = prompt.sections.find(section => section.name === 'patent-teams:usage')?.text ?? ''
    expect(usageText).toContain('patent_teams_create')
  })

  it('installs the retired-member guard while mounted', async () => {
    const workspace = await tmpWorkspace()
    const captain = fakeCaptain('captain-1', workspace)
    const stateDir = '.patent-teams'
    await recordRetiredMemberIds(join(workspace, stateDir), ['retired-1'])
    const ctx = await mount({
      stateDir,
      captain,
      children: [{ id: 'retired-1' }, { id: 'live-1' }],
    })

    const descendants = await ctx.subagents.listDescendants(SessionId('captain-1'))
    expect(descendants.map(entry => entry.id)).toEqual(['live-1'])
    await expect(ctx.subagents.sendMessage(
      captain,
      SessionId('retired-1'),
      [{ type: 'text', text: 'x' }],
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  })

  it('removes every registration and restores the guard on dispose', async () => {
    const ctx = await mount()
    const stub = ctx.get('subagents') as unknown as ReturnType<typeof makeSubagentsStub>
    const guardProbe = stub.guardProbe as {
      listDescendants: () => Promise<unknown[]>
      sendMessage: () => Promise<unknown>
    }
    // The guard wraps the runtime methods while mounted.
    expect(stub.listDescendants).not.toBe(guardProbe.listDescendants)
    expect(stub.sendMessage).not.toBe(guardProbe.sendMessage)
    const tools = ctx.get('tools') as ToolRuntime
    const systemPrompt = ctx.get('systemPrompt') as SystemPrompt

    await ctx.fiber.dispose()
    context = undefined

    for (const name of [
      'patent_teams_create',
      'patent_teams_status',
      'patent_teams_delete',
    ]) {
      expect(tools.get(name), `tool ${name} should be removed after dispose`).toBeUndefined()
    }
    // The usage section left the assembled prompt.
    const prompt = await systemPrompt.assemble()
    const sectionNames = prompt.sections.map(section => section.name)
    expect(sectionNames).not.toContain('patent-teams:usage')
    // The guard restored the original implementations.
    expect(stub.listDescendants).toBe(guardProbe.listDescendants)
    expect(stub.sendMessage).toBe(guardProbe.sendMessage)
  })

  it('releases a live team wait when the plugin fiber disposes', async () => {
    const cwd = await tmpWorkspace()
    const captain = fakeCaptain('captain-wait', cwd)
    const ctx = await mount({ stateDir: cwd, captain })
    const teams = ctx.get('patentTeams') as PatentTeamsService
    await teams.create(captain, 'alpha', 'lifecycle')
    const pending = teams.wait(captain, 60_000, new AbortController().signal)

    await ctx.fiber.dispose()
    context = undefined

    const outcome = await Promise.race([
      pending.then(value => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        setTimeout(() => { resolve({ settled: false }) }, 1_000)
      }),
    ])
    expect(outcome).toEqual({ settled: true, value: { timed_out: false } })
  })
})
