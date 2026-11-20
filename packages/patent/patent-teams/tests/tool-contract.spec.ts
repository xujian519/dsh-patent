// Real ToolRuntime contract tests: every call crosses the registry's argument
// and output-schema validation, so a tool whose returned keys exceed its
// declared output schema fails here instead of only in production.
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { readTeam } from '../src/state.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let context: Context | undefined
const roots: string[] = []
let callSeq = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patent-teams-tool-contract-'))
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

async function mount(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  ctx.provide('agents', { get: () => undefined })
  ctx.provide('llm', { resolveCallConfig: async (config: unknown) => config })
  ctx.provide('subagents', {
    getProvider: () => undefined,
    list: () => [],
    startActivation: async () => { throw new Error('unused') },
    listChildren: async () => [],
    listDescendants: async () => [],
    sendMessage: async () => 'msg',
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({
    name,
    inject,
    Config,
    apply: (c: Context) => { apply(c, Config({ stateDir: '.patent-teams' })) },
  })
  return ctx
}

function call(ctx: Context, agent: Agent, tool: string, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callSeq}`),
    name: tool,
    arguments: args,
    agent,
  })
}

describe('patent-teams tool output contracts', () => {
  it('accepts create_task with a worker through the real tool runtime', async () => {
    const workspace = await tmpWorkspace()
    const ctx = await mount()
    const captain = fakeCaptain('captain-1', workspace)

    const created = await call(ctx, captain, 'patent_teams_create', { name: 'Alpha', description: 'goal' })
    expect(created.isError).toBe(false)

    const task = await call(ctx, captain, 'patent_teams_create_task', {
      subject: 'search prior art',
      worker: 'patent-search-commander',
    })
    expect(task.isError).toBe(false)
    if (task.isError) return
    expect(task.value).toMatchObject({
      subject: 'search prior art',
      status: 'pending',
      worker: 'patent-search-commander',
    })
    const rendered = task.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(rendered).toContain('worker patent-search-commander')

    const state = await readTeam(join(workspace, '.patent-teams'), 'alpha')
    expect(state?.tasks).toHaveLength(1)
    expect(state?.tasks[0]?.worker).toBe('patent-search-commander')

    // The persisted team record is the source of truth: a retry after a
    // validation error must not be the only way the task exists.
    const raw = JSON.parse(await readFile(
      join(workspace, '.patent-teams', 'alpha', 'team.json'),
      'utf8',
    )) as { tasks: Array<{ worker?: string }> }
    expect(raw.tasks).toHaveLength(1)
    expect(raw.tasks[0]?.worker).toBe('patent-search-commander')
  })

  it('accepts create_task without a worker', async () => {
    const workspace = await tmpWorkspace()
    const ctx = await mount()
    const captain = fakeCaptain('captain-2', workspace)
    const created = await call(ctx, captain, 'patent_teams_create', { name: 'Beta' })
    expect(created.isError).toBe(false)
    const task = await call(ctx, captain, 'patent_teams_create_task', { subject: 'draft claims' })
    expect(task.isError).toBe(false)
    if (task.isError) return
    expect(task.value).not.toHaveProperty('worker')
  })

  it('runs update_task and status through the real tool runtime', async () => {
    const workspace = await tmpWorkspace()
    const ctx = await mount()
    const captain = fakeCaptain('captain-3', workspace)
    expect((await call(ctx, captain, 'patent_teams_create', { name: 'Alpha' })).isError).toBe(false)
    expect((await call(ctx, captain, 'patent_teams_create_task', { subject: 'draft' })).isError).toBe(false)

    const reassigned = await call(ctx, captain, 'patent_teams_reassign_task', {
      task_id: 't1',
      assignee: 'captain',
    })
    expect(reassigned.isError).toBe(false)

    const claimed = await call(ctx, captain, 'patent_teams_claim_task', { task_id: 't1' })
    expect(claimed.isError).toBe(false)
    if (claimed.isError) return
    const attemptId = (claimed.value as { attempt_id?: string }).attempt_id
    expect(attemptId).toBeTruthy()

    const started = await call(ctx, captain, 'patent_teams_update_task', {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: attemptId,
    })
    expect(started.isError).toBe(false)
    const completed = await call(ctx, captain, 'patent_teams_update_task', {
      task_id: 't1',
      status: 'completed',
      output: 'done',
      attempt_id: attemptId,
    })
    expect(completed.isError).toBe(false)
    if (completed.isError) return
    expect(completed.value).toMatchObject({ status: 'completed', output: 'done' })

    const status = await call(ctx, captain, 'patent_teams_status', {})
    expect(status.isError).toBe(false)
    if (status.isError) return
    const text = status.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(text).toContain('Team "Alpha"')
    expect(text).toContain('t1 [completed]')
  })
})
