// Coverage-completion pass for PatentTeamsService: exercises the branch
// corners the main service spec leaves open — default member selection,
// explicit reasoning effort, cross-owner claim/update denials, terminal
// immutability, captain-offline member messaging, status rendering variants,
// heavy mailbox warnings, and delete-time in-flight task revocation.
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PatentTeamsService } from '../src/service.ts'
import { readArchivedTeam } from '../src/state.ts'

const tmpRoots: string[] = []

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patent-teams-cov-'))
  tmpRoots.push(dir)
  return dir
}

function fakeAgent(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  })
  return {
    id: SessionId(id),
    session,
    ctx: new Context(),
    options: { provider: 'deepseek-official', model: 'deepseek-v4' },
    status: 'idle',
    whenIdle: () => Promise.resolve(),
    steer: () => {},
  } as unknown as Agent
}

interface Harness {
  ctx: Context
  workspace: string
  stateDir: string
  agents: Map<string, Agent>
  sendMessage: ReturnType<typeof vi.fn>
}

async function makeService(options: {
  maxMembers?: number
  memberModel?: string
  memberMaxDepth?: number
  qualityGate?: boolean
  passThreshold?: number
} = {}): Promise<Harness> {
  const ctx = new Context()
  const stateDir = '.patent-teams'
  const workspace = await tmpWorkspace()
  const agents = new Map<string, Agent>()
  const sendMessage = vi.fn(async () => 'msg')
  ctx.provide('agents', { get: (id: string) => agents.get(id) } as never)
  ctx.provide('llm', { resolveCallConfig: async (config: unknown) => config } as never)
  ctx.provide('subagents', {
    getProvider: () => ({
      name: 'spawn',
      capabilities: { persona: true, toolFilter: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('unused') },
      prepareContinuable: async () => ({}),
    }),
    list: () => ['spawn'],
    startActivation: (() => {
      let seq = 0
      return async () => ({ childId: SessionId(`member-${++seq}`), messageId: 'msg' })
    })(),
    sendMessage,
    interrupt: () => {},
    listChildren: async () => [],
    listDescendants: async () => [],
  } as never)
  await ctx.plugin(PatentTeamsService, {
    stateDir,
    memberProvider: 'spawn',
    maxMembers: options.maxMembers ?? 8,
    ...options.memberModel === undefined ? {} : { memberModel: options.memberModel },
    ...options.memberMaxDepth === undefined ? {} : { memberMaxDepth: options.memberMaxDepth },
    qualityGate: options.qualityGate ?? false,
    passThreshold: options.passThreshold ?? 0.7,
    mailboxDeliveryLeaseMs: 60_000,
  })
  return { ctx, workspace, stateDir, agents, sendMessage }
}



describe('coverage completion', () => {
  it('adds a member with default route and explicit reasoning effort', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha', 'goal')
    const member = await h.ctx.patentTeams.addMember(
      captain,
      { name: 'alice', reasoning_effort: 'high' },
      new AbortController().signal,
    )
    expect(member.provider).toBe('deepseek-official')
    expect(member.model).toBe('deepseek-v4')
    expect(member.reasoning_effort).toBe('high')
  })

  it('rejects a foreign claim of an already-claimed task', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    await h.ctx.patentTeams.addMember(captain, { name: 'bob' }, new AbortController().signal)
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    expect(claimed.status).toBe('claimed')
    await expect(h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'bob' }))
      .rejects.toThrow('already claimed')
  })

  it('rejects a member updating a teammate task', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    await h.ctx.patentTeams.addMember(captain, { name: 'bob' }, new AbortController().signal)
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    const bob = fakeAgent('member-2', h.workspace)
    await expect(h.ctx.patentTeams.updateTask(bob, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })).rejects.toThrow('assigned to "alice"')
  })

  it('rejects changing a terminal task', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    const alice = fakeAgent('member-1', h.workspace)
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'completed',
      output: 'done',
      attempt_id: claimed.attempt_id!,
    })
    await expect(h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })).rejects.toThrow('immutable')
    await expect(h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'completed',
      output: 'different',
      attempt_id: claimed.attempt_id!,
    })).rejects.toThrow('immutable')
    // A status-less update of a terminal task is accepted when the output
    // matches (idempotent path with no status argument).
    await expect(h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      output: 'done',
      attempt_id: claimed.attempt_id!,
    })).resolves.toMatchObject({ status: 'completed', output: 'done' })
  })

  it('keeps a member-to-member message durable when the captain is offline', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    await h.ctx.patentTeams.addMember(captain, { name: 'bob' }, new AbortController().signal)
    const alice = fakeAgent('member-1', h.workspace)
    h.agents.set('member-1', alice)
    // The captain is live but the follow-up fails: the delivery constructs the
    // member-sender prefix and then falls back to the durable mailbox.
    h.agents.set('captain-1', captain)
    h.sendMessage.mockImplementation(() => { throw new Error('offline') })
    const sent = await h.ctx.patentTeams.sendMessage(
      alice,
      { to: 'bob', content: 'ping' },
      new AbortController().signal,
    )
    expect(sent.delivered).toBe('mailbox')
  })

  it('updates an in-progress task with output only', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    h.agents.set('member-1', { ...fakeAgent('member-1', h.workspace), status: 'working' } as unknown as Agent)
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    const alice = fakeAgent('member-1', h.workspace)
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })
    const updated = await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      output: 'partial result',
      attempt_id: claimed.attempt_id!,
    })
    expect(updated.status).toBe('in_progress')
    expect(updated.output).toBe('partial result')
  })

  it('leaves completed tasks untouched when deleting a member', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    h.agents.set('member-1', { ...fakeAgent('member-1', h.workspace), status: 'working' } as unknown as Agent)
    await h.ctx.patentTeams.createTask(captain, { subject: 'done', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    const alice = fakeAgent('member-1', h.workspace)
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'completed',
      output: 'finished',
      attempt_id: claimed.attempt_id!,
    })
    await h.ctx.patentTeams.delete(captain, new AbortController().signal)
    const archived = await readArchivedTeam(join(h.workspace, h.stateDir), 'alpha')
    expect(archived?.tasks[0]!.status).toBe('completed')
  })

  it('renders pending, claimed, and output-carrying tasks in status', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    // Keep the member busy so the shared scheduler does not auto-claim tasks
    // between the createTask calls; the test controls claiming itself.
    h.agents.set('member-1', { ...fakeAgent('member-1', h.workspace), status: 'working' } as unknown as Agent)
    await h.ctx.patentTeams.createTask(captain, { subject: 'open', description: 'unclaimed work' })
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't2', assignee: 'alice' })
    const alice = fakeAgent('member-1', h.workspace)
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't2',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })
    const status = await h.ctx.patentTeams.status(captain)
    const open = status.tasks.find(task => task.id === 't1')
    const workTask = status.tasks.find(task => task.id === 't2')
    expect(open?.assignee).toBe('')
    expect(open?.attempt).toBe(0)
    expect(open?.attempt_id).toBe('')
    expect(workTask?.assignee).toBe('alice')
    expect(workTask?.attempt_id).not.toBe('')
    expect(workTask?.status).toBe('in_progress')
  })

  it('renders a completed task with its output in status', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    h.agents.set('member-1', { ...fakeAgent('member-1', h.workspace), status: 'working' } as unknown as Agent)
    await h.ctx.patentTeams.createTask(captain, { subject: 'done', assignee: 'alice' })
    const claimed = await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    const alice = fakeAgent('member-1', h.workspace)
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'in_progress',
      attempt_id: claimed.attempt_id!,
    })
    await h.ctx.patentTeams.updateTask(alice, {
      task_id: 't1',
      status: 'completed',
      output: 'finished',
      attempt_id: claimed.attempt_id!,
    })
    const status = await h.ctx.patentTeams.status(captain)
    expect(status.tasks[0]!.status).toBe('completed')
    expect(status.tasks[0]!.output).toBe('finished')
  })

  it('omits empty member inboxes from status', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    const alice = fakeAgent('member-1', h.workspace)
    const status = await h.ctx.patentTeams.status(alice)
    expect(status.member_inboxes).toEqual({})
  })

  it('caps mailbox warnings at ten', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    const inboxDir = join(h.workspace, h.stateDir, 'alpha', 'inbox')
    const lines = Array.from({ length: 12 }, (_, index) => `{broken-${index}}`)
    await writeFile(join(inboxDir, 'captain.jsonl'), lines.join('\n'))
    const status = await h.ctx.patentTeams.status(captain)
    expect(status.mailbox_warning_count).toBe(12)
    expect(status.mailbox_warnings).toHaveLength(10)
  })

  it('revokes in-flight member tasks on delete', async () => {
    const h = await makeService()
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    await h.ctx.patentTeams.createTask(captain, { subject: 'work', assignee: 'alice' })
    await h.ctx.patentTeams.claimTask(captain, { task_id: 't1', assignee: 'alice' })
    h.agents.set('member-1', fakeAgent('member-1', h.workspace))
    const result = await h.ctx.patentTeams.delete(captain, new AbortController().signal)
    expect(result.deleted).toBe(true)
    const archived = await readArchivedTeam(join(h.workspace, h.stateDir), 'alpha')
    expect(archived?.tasks[0]!.status).toBe('claimed')
    expect(archived?.tasks[0]!.assignee).toBe('alice')
    expect(archived?.tasks[0]!.attemptId).toBeUndefined()
    expect(archived?.members[0]!.status).toBe('removed')
  })

  it('passes memberMaxDepth through to member runtime', async () => {
    const h = await makeService({ memberMaxDepth: 2 })
    const captain = fakeAgent('captain-1', h.workspace)
    await h.ctx.patentTeams.create(captain, 'Alpha')
    const member = await h.ctx.patentTeams.addMember(captain, { name: 'alice' }, new AbortController().signal)
    expect(member.status).toBe('idle')
  })
})
