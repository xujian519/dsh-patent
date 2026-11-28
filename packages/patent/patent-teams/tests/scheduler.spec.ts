// Event-driven shared-task scheduler: team/member kicks (mailbox fallback and
// task dispatch with rollback) and the member status observer. Real team state
// files under temp directories; ctx.agents / ctx.subagents are stubs.
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { installTeamScheduler, kickAfterPersist } from '../src/scheduler.ts'
import { TeamActivity } from '../src/team-activity.ts'
import {
  appendMailbox,
  createMessage,
  readMailbox,
} from '../src/mailbox.ts'
import {
  createTeamDir,
  readTeam,
  writeTeam,
} from '../src/state.ts'
import {
  teamLockKey,
  withTeamLock,
} from '../src/team-lock.ts'
import type { TeamState, TeamTask } from '../src/types.ts'

const tmpRoots: string[] = []

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'patent-teams-scheduler-'))
  tmpRoots.push(dir)
  return dir
}

function fakeAgent(id: string, cwd: string, status: 'idle' | 'running' = 'idle'): Agent {
  return {
    id: SessionId(id),
    session: Session.create(SessionId(id), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now(),
      cwd,
      isSeeded: false,
    }),
    options: { provider: 'spawn', model: 'm' },
    status,
    whenIdle: () => Promise.resolve(),
    steer: () => {},
  } as unknown as Agent
}

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    subject: 'do the thing',
    status: 'pending',
    dependencies: [],
    attempt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeState(overrides: Partial<TeamState> = {}): TeamState {
  return {
    name: 'Alpha',
    id: 'team1',
    captainSessionId: 'captain-1',
    createdAt: 1,
    members: [
      { id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' },
      { id: 'member-2', name: 'bob', joinedAt: 1, status: 'idle' },
    ],
    tasks: [],
    taskSeq: 0,
    ...overrides,
  }
}

async function makeHarness(options?: {
  live?: Map<string, Agent>
  sendMessage?: (captain: Agent, childId: SessionId) => Promise<unknown>
}) {
  const ctx = new Context()
  const stateDir = '.patent-teams-scheduler'
  const workspace = await tmpWorkspace()
  const live = options?.live ?? new Map<string, Agent>()
  const sendMessage = options?.sendMessage ?? (async () => 'msg')
  ctx.provide('agents', {
    get: (id: string) => live.get(id),
  } as never)
  ctx.provide('subagents', {
    sendMessage,
    interrupt: () => {},
  } as never)
  const scheduler = installTeamScheduler(ctx, {
    stateDir,
    activity: new TeamActivity(),
    deliveryLeaseMs: 60_000,
  })
  return { ctx, workspace, stateDir, scheduler, live }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kickAfterPersist', () => {
  it('swallows a dispatch failure after the change was persisted and logs it', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await expect(kickAfterPersist(ctx, 'dispatch after test', async () => {
      throw new Error('scheduler offline')
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scheduler offline'))
  })
})

describe('installTeamScheduler kickTeam', () => {
  it('is a no-op when the team does not exist', async () => {
    const { workspace, scheduler } = await makeHarness()
    await expect(scheduler.kickTeam(workspace, 'ghost', fakeAgent('captain-1', workspace)))
      .resolves.toBeUndefined()
  })

  it('is a no-op when no live captain can be found', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState())
    await expect(scheduler.kickTeam(workspace, 'team1')).resolves.toBeUndefined()
  })

  it('kicks every live member and skips removed ones', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    const captain = fakeAgent('captain-1', workspace)
    const alice = fakeAgent('member-1', workspace)
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [
        { id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' },
        { id: 'member-removed', name: 'gone', joinedAt: 1, status: 'removed' },
      ],
      tasks: [makeTask()],
    }))
    await scheduler.kickTeam(workspace, 'team1', captain)
    expect(alice.status).toBe('idle')
    const team = await readTeam(join(workspace, stateDir), 'team1')
    // The dispatch claimed the task for alice and marked her working.
    expect(team?.tasks[0]?.status).toBe('claimed')
    expect(team?.tasks[0]?.assignee).toBe('alice')
    expect(team?.members[0]?.status).toBe('working')
  })
})

describe('installTeamScheduler kickMember', () => {
  it('is a no-op when the team, captain, or member is missing', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState())
    await scheduler.kickMember(workspace, 'team1', 'ghost', fakeAgent('captain-1', workspace))
    await scheduler.kickMember(workspace, 'team1', 'alice')
    await scheduler.kickMember(workspace, 'ghost-team', 'alice', fakeAgent('captain-1', workspace))
    // A genuinely idle member with no ready work stays idle (no status write).
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team?.members[0]?.status).toBe('idle')
  })

  it('serializes concurrent kicks for one member without leaking the queue entry', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    const captain = fakeAgent('captain-1', workspace)
    await Promise.all([
      scheduler.kickMember(workspace, 'team1', 'alice', captain),
      scheduler.kickMember(workspace, 'team1', 'alice', captain),
    ])
    // Only the first kick claims the task; the second finds no ready work.
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.tasks[0]!.status).toBe('claimed')
    // The member queue was cleaned up: a later kick still works.
    await scheduler.kickMember(workspace, 'team1', 'bob', captain)
  })

  it('skips a member with a live running turn', async () => {
    const { workspace, stateDir, scheduler, live } = await makeHarness()
    live.set('member-1', fakeAgent('member-1', workspace, 'running'))
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'working' }],
      tasks: [makeTask({ assignee: 'alice' })],
    }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    // The running member was skipped entirely; its task stays untouched.
    expect(team?.tasks[0]?.status).toBe('pending')
    expect(team?.members[0]?.status).toBe('working')
  })

  it('delivers mailbox fallback messages and acknowledges accepted deliveries', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState())
    const message = createMessage('captain', 'alice', 'please respond')
    await appendMailbox(join(workspace, stateDir), 'team1', 'alice', message)
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    // The delivery was accepted, so the durable message is acknowledged.
    const mailbox = await readMailbox(join(workspace, stateDir), 'team1', 'alice')
    expect(mailbox[0]!.readAt).toBeGreaterThan(0)
    expect(mailbox[0]!.deliveredAt).toBeGreaterThan(0)
  })

  it('releases the lease when mailbox delivery is rejected', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => { throw new Error('member busy') },
    })
    await createTeamDir(join(workspace, stateDir), makeState())
    const message = createMessage('captain', 'alice', 'please respond')
    await appendMailbox(join(workspace, stateDir), 'team1', 'alice', message)
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const mailbox = await readMailbox(join(workspace, stateDir), 'team1', 'alice')
    expect(mailbox[0]!.deliveryClaimedAt).toBeUndefined()
    expect(mailbox[0]!.readAt).toBeUndefined()
  })

  it('does not deliver mailbox fallback from a stale snapshot after removal', async () => {
    const sendMessage = vi.fn(async () => 'msg')
    const { workspace, stateDir, scheduler } = await makeHarness({ sendMessage })
    const root = join(workspace, stateDir)
    await createTeamDir(root, makeState())
    await appendMailbox(
      root,
      'team1',
      'alice',
      createMessage('captain', 'alice', 'stale mail'),
    )
    const snapshot = await readTeam(root, 'team1')
    expect(snapshot).toBeDefined()
    const removed = {
      ...snapshot!,
      members: snapshot!.members.map(member => member.name === 'alice'
        ? { ...member, status: 'removed' as const }
        : member),
    }
    await writeTeam(root, removed)

    await scheduler.kickTeam(
      workspace,
      'team1',
      fakeAgent('captain-1', workspace),
      undefined,
      snapshot,
    )

    expect(sendMessage).not.toHaveBeenCalled()
    const mailbox = await readMailbox(root, 'team1', 'alice')
    expect(mailbox[0]!.readAt).toBeUndefined()
    expect(mailbox[0]!.deliveryClaimedAt).toBeUndefined()
  })

  it('dispatches the next ready task with the exact attempt capability', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    const withDescription = makeTask({ description: 'detailed work' })
    delete (withDescription as Partial<TeamTask>).attempt
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [withDescription] }))
    const captain = fakeAgent('captain-1', workspace)
    await scheduler.kickMember(workspace, 'team1', 'alice', captain)
    const team = await readTeam(join(workspace, stateDir), 'team1')
    const task = team!.tasks[0]!
    expect(task.status).toBe('claimed')
    expect(task.assignee).toBe('alice')
    // No durable generation existed, so the fresh attempt starts at 1.
    expect(task.attempt).toBe(1)
    expect(task.attemptId).toBeDefined()
    expect(team!.members[0]!.status).toBe('working')
  })

  it('prefers an owned open task when an idle member lost its turn', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    const lost = makeTask({ id: 't1', status: 'claimed', assignee: 'alice', attempt: 3, attemptId: 'stale' })
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
      tasks: [lost],
    }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.tasks[0]!.attempt).toBe(4)
    expect(team!.tasks[0]!.attemptId).not.toBe('stale')
  })

  it('rolls back the dispatch when the member inbox rejects the assignment', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => { throw new Error('delivery failed') },
    })
    await createTeamDir(join(workspace, stateDir), makeState({
      tasks: [makeTask({ assignee: 'alice' })],
    }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    const task = team!.tasks[0]!
    expect(task.status).toBe('pending')
    expect(task.assignee).toBe('alice')
    expect(task.attemptId).toBeUndefined()
    expect(task.handoffId).toBeUndefined()
    expect(team!.members[0]!.status).toBe('idle')
  })

  it('clears the assignee when an unassigned dispatch is rolled back', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => { throw new Error('delivery failed') },
    })
    await createTeamDir(join(workspace, stateDir), makeState({
      tasks: [makeTask()],
    }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    const task = team!.tasks[0]!
    expect(task.status).toBe('pending')
    expect(task.assignee).toBeUndefined()
    expect(task.attemptId).toBeUndefined()
    expect(team!.members[0]!.status).toBe('idle')
  })

  it('gives up the ticket when the team vanishes while the dispatch lock waits', async () => {
    const sendMessage = vi.fn(async () => 'msg')
    const { workspace, stateDir, scheduler } = await makeHarness({ sendMessage })
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    const stateRoot = join(workspace, stateDir)
    // Hold the team lock while the kick queues its dispatch; the holder then
    // removes the team, so the queued ticket read finds no team at all.
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const holder = withTeamLock(teamLockKey(stateRoot, 'team1'), async () => {
      await promise
      await rm(join(stateRoot, 'team1'), { recursive: true, force: true })
    })
    const kick = scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    resolve(undefined)
    // Giving up means the queued ticket is dropped: nothing is delivered and no
    // state is recreated for the vanished team.
    await expect(Promise.all([holder, kick])).resolves.toBeDefined()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(existsSync(join(stateRoot, 'team1'))).toBe(false)
  })

  it('gives up the ticket when the member is removed while the dispatch lock waits', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    const stateRoot = join(workspace, stateDir)
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const holder = withTeamLock(teamLockKey(stateRoot, 'team1'), async () => {
      await promise
      const current = await readTeam(stateRoot, 'team1')
      current!.members[0]!.status = 'removed'
      await writeTeam(stateRoot, current!)
    })
    const kick = scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    resolve(undefined)
    await Promise.all([holder, kick])
    // The queued ticket re-read the member, found her removed, and gave up
    // without rewriting her record or claiming the task.
    const team = await readTeam(stateRoot, 'team1')
    expect(team!.members[0]!.status).toBe('removed')
    expect(team!.tasks[0]!.status).toBe('pending')
    expect(team!.tasks[0]!.assignee).toBeUndefined()
  })

  it('skips the rollback when the whole team vanished during delivery', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => {
        await rm(join(workspace, stateDir, 'team1'), { recursive: true, force: true })
        throw new Error('delivery failed')
      },
    })
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    expect(await readTeam(join(workspace, stateDir), 'team1')).toBeUndefined()
  })

  it('rolls back the task but not the member state when the member was removed', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => {
        const current = await readTeam(join(workspace, stateDir), 'team1')
        current!.members[0]!.status = 'removed'
        await writeTeam(join(workspace, stateDir), current!)
        throw new Error('delivery failed')
      },
    })
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask({ assignee: 'alice' })] }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.tasks[0]!.status).toBe('pending')
    expect(team!.members[0]!.status).toBe('removed')
  })

  it('rolls back only its own failed dispatch and respects a newer attempt', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      // The delivery rejects AFTER a concurrent handoff already replaced the
      // capability; the rollback must not clobber the newer attempt.
      sendMessage: async () => {
        const current = await readTeam(join(workspace, stateDir), 'team1')
        const task = current!.tasks[0]!
        task.status = 'claimed'
        task.attemptId = 'newer-attempt'
        task.updatedAt = Date.now()
        await writeTeam(join(workspace, stateDir), current!)
        throw new Error('delivery failed')
      },
    })
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const afterDispatch = await readTeam(join(workspace, stateDir), 'team1')
    // The newer attempt survived the failed dispatch, and the member stays
    // working because that attempt is its open task.
    expect(afterDispatch!.tasks[0]!.attemptId).toBe('newer-attempt')
    expect(afterDispatch!.tasks[0]!.status).toBe('claimed')
    expect(afterDispatch!.members[0]!.status).toBe('working')
  })

  it('marks the member idle when a newer handoff left it no open task', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => {
        const current = await readTeam(join(workspace, stateDir), 'team1')
        const task = current!.tasks[0]!
        // A concurrent handoff moved the task back to the shared pool with a
        // newer capability, so this dispatch no longer owns it.
        task.status = 'pending'
        delete task.assignee
        task.attemptId = 'newer-attempt'
        task.updatedAt = Date.now()
        await writeTeam(join(workspace, stateDir), current!)
        throw new Error('delivery failed')
      },
    })
    await createTeamDir(join(workspace, stateDir), makeState({ tasks: [makeTask()] }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const afterDispatch = await readTeam(join(workspace, stateDir), 'team1')
    expect(afterDispatch!.tasks[0]!.attemptId).toBe('newer-attempt')
    expect(afterDispatch!.tasks[0]!.status).toBe('pending')
    expect(afterDispatch!.members[0]!.status).toBe('idle')
  })

  it('leaves an already idle member untouched when the snapshot task vanished', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    const captain = fakeAgent('captain-1', workspace)
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
    }))
    const snapshot = makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
      tasks: [makeTask()],
    })
    await scheduler.kickMember(workspace, 'team1', 'alice', captain, undefined, snapshot)
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team?.members[0]?.status).toBe('idle')
    expect(team?.tasks).toEqual([])
  })

  it('marks a working member idle when no ready work remains', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'working' }],
      tasks: [makeTask({ status: 'completed' })],
    }))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace))
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.members[0]!.status).toBe('idle')
  })
})

describe('member status observer', () => {
  it('mirrors agent status into the durable member record', async () => {
    const { ctx, workspace, stateDir } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
    }))
    const alice = fakeAgent('member-1', workspace)
    ctx.emit('agent/status', { agent: alice, status: 'running' })
    await vi.waitFor(async () => {
      expect((await readTeam(join(workspace, stateDir), 'team1'))!.members[0]!.status).toBe('working')
    })
  })

  it('kicks the member after it becomes idle', async () => {
    const { ctx, workspace, stateDir, live } = await makeHarness()
    live.set('captain-1', fakeAgent('captain-1', workspace))
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'working' }],
      tasks: [makeTask()],
    }))
    const alice = fakeAgent('member-1', workspace)
    ctx.emit('agent/status', { agent: alice, status: 'idle' })
    await vi.waitFor(async () => {
      const team = await readTeam(join(workspace, stateDir), 'team1')
      expect(team!.members[0]!.status).toBe('working')
      expect(team!.tasks[0]!.status).toBe('claimed')
    })
  })

  it('ignores the captain and agents outside any team', async () => {
    const { ctx, workspace, stateDir } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
    }))
    const captain = fakeAgent('captain-1', workspace)
    const stranger = fakeAgent('stranger', workspace)
    ctx.emit('agent/status', { agent: captain, status: 'running' })
    ctx.emit('agent/status', { agent: stranger, status: 'idle' })
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.members[0]!.status).toBe('idle')
  })

  it('does not rescan for an agent already known to be outside every team', async () => {
    const { ctx, workspace, stateDir } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState())
    const stranger = fakeAgent('stranger', workspace)
    ctx.emit('agent/status', { agent: stranger, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Membership changes flow through addMember (which tracks the member), so
    // an out-of-band roster edit after the scan is deliberately not picked up.
    const team = await readTeam(join(workspace, stateDir), 'team1')
    team!.members.push({ id: 'stranger', name: 'stranger', joinedAt: 1, status: 'idle' })
    await writeTeam(join(workspace, stateDir), team!)
    ctx.emit('agent/status', { agent: stranger, status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const after = await readTeam(join(workspace, stateDir), 'team1')
    expect(after?.members.find(member => member.id === 'stranger')?.status).toBe('idle')
  })

  it('skips removed members and redundant status writes', async () => {
    const { ctx, workspace, stateDir } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [
        { id: 'member-removed', name: 'gone', joinedAt: 1, status: 'removed' },
        { id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' },
      ],
    }))
    const gone = fakeAgent('member-removed', workspace)
    ctx.emit('agent/status', { agent: gone, status: 'idle' })
    // Alice is already idle: the redundant write is skipped.
    ctx.emit('agent/status', { agent: fakeAgent('member-1', workspace), status: 'idle' })
    await vi.waitFor(async () => {
      expect((await readTeam(join(workspace, stateDir), 'team1'))!.members[1]!.status).toBe('idle')
    })
    const team = await readTeam(join(workspace, stateDir), 'team1')
    expect(team!.members[0]!.status).toBe('removed')
  })

  it('resolves the workspace from the process cwd when the member has none', async () => {
    const { ctx, stateDir } = await makeHarness()
    const cwd = await tmpWorkspace()
    // The agent's session carries no cwd, so the status edge can only find its
    // team through the process-cwd fallback; a mirrored status proves it did.
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    await createTeamDir(join(cwd, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'working' }],
    }))
    const cwdless = {
      ...fakeAgent('member-1', cwd),
      session: Session.create(SessionId('member-1'), [], {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('member-1'),
        createdAt: Date.now(),
        isSeeded: false,
      }),
    }
    ctx.emit('agent/status', { agent: cwdless, status: 'idle' })
    await vi.waitFor(async () => {
      expect((await readTeam(join(cwd, stateDir), 'team1'))?.members[0]?.status).toBe('idle')
    })
  })

  it('gives up the status write when the team vanishes while the lock waits', async () => {
    const { ctx, workspace, stateDir, scheduler } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'idle' }],
    }))
    const stateRoot = join(workspace, stateDir)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A tracked member reaches its status write without the state-directory
    // scan, so the team lock below is its only wait point.
    scheduler.trackMember('member-1', 'team1', 'alice')
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const holder = withTeamLock(teamLockKey(stateRoot, 'team1'), async () => {
      await promise
      await rm(join(stateRoot, 'team1'), { recursive: true, force: true })
    })
    // A `running` edge leaves no kick behind the write, so the queued write is
    // the whole observed chain.
    ctx.emit('agent/status', { agent: fakeAgent('member-1', workspace), status: 'running' })
    resolve(undefined)
    await holder
    // The queued write runs before this acquire, so the assertions below observe
    // a settled state: the vanished team neither came back nor turned into a
    // reported failure.
    await withTeamLock(teamLockKey(stateRoot, 'team1'), () => Promise.resolve())
    expect(existsSync(join(stateRoot, 'team1'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('rolls back the dispatch when the caller signal aborts the delivery', async () => {
    const { workspace, stateDir, scheduler } = await makeHarness({
      sendMessage: async () => { throw new Error('aborted') },
    })
    await createTeamDir(join(workspace, stateDir), makeState({
      tasks: [makeTask({ assignee: 'alice' })],
    }))
    const signal = AbortSignal.abort(new Error('caller cancelled'))
    await scheduler.kickMember(workspace, 'team1', 'alice', fakeAgent('captain-1', workspace), signal)
    const team = await readTeam(join(workspace, stateDir), 'team1')
    const task = team!.tasks[0]!
    expect(task.status).toBe('pending')
    expect(task.assignee).toBe('alice')
    expect(task.attemptId).toBeUndefined()
    expect(team!.members[0]!.status).toBe('idle')
  })

  it('logs a warning when the status observer fails', async () => {
    const { ctx, workspace, stateDir } = await makeHarness()
    await createTeamDir(join(workspace, stateDir), makeState({
      members: [{ id: 'member-1', name: 'alice', joinedAt: 1, status: 'working' }],
    }))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A read-only team directory makes the status write fail.
    await chmod(join(workspace, stateDir, 'team1'), 0o555)
    try {
      ctx.emit('agent/status', { agent: fakeAgent('member-1', workspace), status: 'idle' })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('member status scheduling failed'))
      })
    } finally {
      await chmod(join(workspace, stateDir, 'team1'), 0o755)
    }
  })
})
