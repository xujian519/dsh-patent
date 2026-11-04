// Pure team-state logic and durable state helpers (fs-backed). Every test gets
// its own temporary state root; real fs primitives are used except for
// replaceFileAtomicOrDirect, whose primitives are injected.

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeMailbox,
  appendMailbox,
  claimMailboxDelivery,
  createMessage,
  readMailbox,
  readMailboxSnapshot,
  readUnreadMailbox,
  releaseMailboxDelivery,
} from '../src/mailbox.ts'
import {
  activateTaskAttempt,
  archiveTeamDir,
  beginTaskAttempt,
  CAPTAIN_KEY,
  createTeamDir,
  findTeamByCaptain,
  findTeamByParticipant,
  invalidateTaskAttempt,
  listArchivedTeamIds,
  readArchivedTeam,
  readRetiredMemberIds,
  readTeam,
  recordRetiredMemberIds,
  TASK_TRANSITIONS,
  transitionError,
  unsatisfiedDependencies,
  writeTeam,
} from '../src/state.ts'
import {
  replaceFileAtomicOrDirect,
  sanitizeKey,
  stateRootOf,
  teamLockKey,
  withTeamLock,
} from '../src/team-lock.ts'
import type { TeamMember, TeamMessage, TeamState, TeamTask } from '../src/types.ts'

const tmpRoots: string[] = []

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patent-teams-state-'))
  tmpRoots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
})

function makeState(overrides: Partial<TeamState> = {}): TeamState {
  return {
    name: 'Alpha',
    id: 'alpha',
    captainSessionId: 'captain-1',
    createdAt: 1000,
    members: [],
    tasks: [],
    taskSeq: 0,
    ...overrides,
  }
}

function makeTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 't1',
    subject: 'do the thing',
    status: 'pending',
    dependencies: [],
    attempt: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('sanitizeKey', () => {
  it('folds punctuation, spaces and path separators to dashes and lowercases', () => {
    expect(sanitizeKey('Hello World!')).toBe('hello-world')
    expect(sanitizeKey('  a/b\\c:d ')).toBe('a-b-c-d')
    expect(sanitizeKey('---padded---')).toBe('padded')
  })

  it('keeps Unicode letters and digits distinct and readable', () => {
    expect(sanitizeKey('团队 研究')).toBe('团队-研究')
    expect(sanitizeKey('Исследователь-2')).toBe('исследователь-2')
    expect(sanitizeKey('abc')).toBe('abc')
  })

  it('normalizes NFC so composed and decomposed names collide safely', () => {
    const composed = sanitizeKey('café')
    const decomposed = sanitizeKey('cafe\u0301')
    expect(composed).toBe('café')
    expect(decomposed).toBe(composed)
  })

  it('digests names with no letters or digits at all (pure emoji/symbols)', () => {
    const first = sanitizeKey('😀😀')
    const second = sanitizeKey('🎉🎉')
    expect(first).toMatch(/^k-[0-9a-f]{8}$/)
    expect(second).toMatch(/^k-[0-9a-f]{8}$/)
    // Distinct inputs never collapse onto one shared constant.
    expect(first).not.toBe(second)
    expect(sanitizeKey('!!!')).toMatch(/^k-[0-9a-f]{8}$/)
  })

  it('truncates over-long names with a digest so long-prefix names stay distinct', () => {
    const longA = sanitizeKey('x'.repeat(60))
    const longB = sanitizeKey('x'.repeat(60) + 'y')
    expect(longA).toHaveLength(48 + 1 + 8)
    expect(longA).toMatch(/^x{48}-[0-9a-f]{8}$/)
    expect(longB).toMatch(/^x{48}-[0-9a-f]{8}$/)
    expect(longA).not.toBe(longB)
  })
})

describe('unsatisfiedDependencies', () => {
  const tasks = [
    makeTask({ id: 't1', status: 'completed' }),
    makeTask({ id: 't2', status: 'pending' }),
  ]

  it('returns no ids when every dependency is completed', () => {
    expect(unsatisfiedDependencies(tasks, ['t1'])).toEqual([])
    expect(unsatisfiedDependencies(tasks, [])).toEqual([])
  })

  it('lists unfinished and missing dependencies', () => {
    expect(unsatisfiedDependencies(tasks, ['t2'])).toEqual(['t2'])
    expect(unsatisfiedDependencies(tasks, ['t1', 't2', 'ghost'])).toEqual(['t2', 'ghost'])
  })
})

describe('task transitions', () => {
  it('exposes the full transition table', () => {
    expect({
      pending: [...TASK_TRANSITIONS.pending],
      claimed: [...TASK_TRANSITIONS.claimed],
      in_progress: [...TASK_TRANSITIONS.in_progress],
      completed: [...TASK_TRANSITIONS.completed],
      failed: [...TASK_TRANSITIONS.failed],
      cancelled: [...TASK_TRANSITIONS.cancelled],
    }).toEqual({
      pending: ['claimed', 'cancelled'],
      claimed: ['in_progress', 'failed', 'cancelled'],
      in_progress: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    })
  })

  it('allows same-status updates and every declared edge', () => {
    expect(transitionError('pending', 'pending')).toBeUndefined()
    expect(transitionError('pending', 'claimed')).toBeUndefined()
    expect(transitionError('claimed', 'in_progress')).toBeUndefined()
    expect(transitionError('in_progress', 'completed')).toBeUndefined()
    expect(transitionError('in_progress', 'failed')).toBeUndefined()
    expect(transitionError('pending', 'cancelled')).toBeUndefined()
  })

  it('rejects undeclared and terminal-outgoing transitions', () => {
    expect(transitionError('pending', 'in_progress')).toBe('task status cannot move from "pending" to "in_progress" (allowed next: "claimed", "cancelled")')
    expect(transitionError('claimed', 'completed')).toBe('task status cannot move from "claimed" to "completed" (allowed next: "in_progress", "failed", "cancelled")')
    expect(transitionError('completed', 'pending')).toBe('task status cannot move from "completed" to "pending" ("completed" is terminal — retry or reassign the task instead)')
    expect(transitionError('failed', 'claimed')).toBe('task status cannot move from "failed" to "claimed" ("failed" is terminal — retry or reassign the task instead)')
    expect(transitionError('cancelled', 'in_progress')).toBe('task status cannot move from "cancelled" to "in_progress" ("cancelled" is terminal — retry or reassign the task instead)')
  })
})

describe('task attempt generation', () => {
  it('activateTaskAttempt opens a fresh capability for one owner', () => {
    const task = makeTask({ status: 'pending', assignee: 'alice', output: 'old', attemptId: 'stale', handoffId: 'h1', reassigning: true })
    const attemptId = activateTaskAttempt(task, 'alice')
    expect(typeof attemptId).toBe('string')
    expect(attemptId.length).toBeGreaterThan(0)
    expect(task.status).toBe('claimed')
    expect(task.assignee).toBe('alice')
    expect(task.attemptId).toBe(attemptId)
    expect(task.handoffId).toBeUndefined()
    expect(task.reassigning).toBe(false)
    expect(task.output).toBeUndefined()
    expect(task.updatedAt).toBeGreaterThanOrEqual(1000)
  })

  it('beginTaskAttempt increments the generation counter', () => {
    const task = makeTask()
    beginTaskAttempt(task, 'bob')
    expect(task.attempt).toBe(1)
    const second = beginTaskAttempt(task, 'bob')
    expect(task.attempt).toBe(2)
    expect(task.attemptId).toBe(second)
  })

  it('beginTaskAttempt starts from zero when no generation exists yet', () => {
    const task = makeTask()
    delete (task as Partial<TeamTask>).attempt
    beginTaskAttempt(task, 'bob')
    expect(task.attempt).toBe(1)
    expect(task.attemptId).toBeDefined()
  })

  it('invalidateTaskAttempt revokes the capability and starts a handoff generation', () => {
    const task = makeTask({ status: 'in_progress', assignee: 'alice', attempt: 3, attemptId: 'cap', output: 'wip' })
    invalidateTaskAttempt(task)
    expect(task.attemptId).toBeUndefined()
    expect(task.handoffId).toMatch(/^[0-9a-f-]{36}$/)
    expect(task.status).toBe('pending')
    expect(task.assignee).toBeUndefined()
    expect(task.reassigning).toBe(false)
    expect(task.output).toBeUndefined()
  })

  it('invalidateTaskAttempt keeps the next assignee and the reassigning marker', () => {
    const task = makeTask({ status: 'claimed', assignee: 'alice', attemptId: 'cap' })
    invalidateTaskAttempt(task, 'captain', true)
    expect(task.assignee).toBe('captain')
    expect(task.reassigning).toBe(true)
    expect(task.attemptId).toBeUndefined()
    expect(task.handoffId).toBeDefined()
    expect(task.status).toBe('pending')
  })
})

describe('team directory persistence', () => {
  it('creates the inbox layout and round-trips the record', async () => {
    const root = await tmpRoot()
    const state = makeState()
    await createTeamDir(root, state)
    expect(await readTeam(root, 'alpha')).toEqual(state)
    // The team file is the authoritative copy.
    const raw = await readFile(join(root, 'alpha', 'team.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual(state)
  })

  it('readTeam returns undefined for absent teams and throws on corrupt state', async () => {
    const root = await tmpRoot()
    expect(await readTeam(root, 'missing')).toBeUndefined()

    await mkdir(join(root, 'bad'), { recursive: true })
    await writeFile(join(root, 'bad', 'team.json'), 'not json {')
    await expect(readTeam(root, 'bad')).rejects.toThrow(join(root, 'bad', 'team.json'))

    await writeFile(join(root, 'bad', 'team.json'), JSON.stringify({ id: 'other' }))
    await expect(readTeam(root, 'bad')).rejects.toThrow('invalid PatentTeams state in team "bad"')
    await expect(readTeam(root, 'bad')).rejects.toThrow(join(root, 'bad', 'team.json'))
  })

  it('readTeam strips a leading UTF-8 BOM from the durable file', async () => {
    const root = await tmpRoot()
    const state = makeState()
    await createTeamDir(root, state)
    await writeFile(join(root, 'alpha', 'team.json'), '\uFEFF' + JSON.stringify(state))
    expect(await readTeam(root, 'alpha')).toEqual(state)
  })

  it('writeTeam persists a replacement record', async () => {
    const root = await tmpRoot()
    const state = makeState()
    await createTeamDir(root, state)
    state.name = 'Beta'
    await writeTeam(root, state)
    expect((await readTeam(root, 'alpha'))?.name).toBe('Beta')
  })

  it('writeTeam surfaces a temp-write failure and removes the partial temp file', async () => {
    const root = await tmpRoot()
    // No team directory exists: the temp file write fails with ENOENT.
    await expect(writeTeam(root, makeState())).rejects.toThrow()
    const leftovers = await readdir(root)
    expect(leftovers.filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('swallows a temp-file cleanup failure when the temp write fails', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    // A read-only team directory makes both the temp write and its cleanup
    // fail with EACCES; the cleanup failure is swallowed, the write surfaces.
    await chmod(join(root, 'alpha'), 0o555)
    try {
      await expect(writeTeam(root, makeState())).rejects.toThrow()
    } finally {
      await chmod(join(root, 'alpha'), 0o755)
    }
  })

  it('writeTeam degrades to a direct write when the target blocks the atomic rename', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    // team.json is now a directory: rename(tmp, team.json) fails and the
    // direct-write fallback (also into a directory) fails, so the combined
    // error surfaces as an AggregateError.
    await rm(join(root, 'alpha', 'team.json'))
    await mkdir(join(root, 'alpha', 'team.json'))
    await expect(writeTeam(root, makeState())).rejects.toThrow(AggregateError)
  })
})

describe('durable record validation', () => {
  const validMember: TeamMember = { id: 'm1', name: 'alice', role: 'researcher', provider: 'p', model: 'm', reasoningEffort: 'high', joinedAt: 1, status: 'idle' }
  const validTask: TeamTask = {
    id: 't1', subject: 's', description: 'd', status: 'claimed', assignee: 'alice',
    dependencies: [], output: 'o', attempt: 1, attemptId: 'a', handoffId: 'h',
    reassigning: false,
    worker: 'patent-search-commander',
    contractValidation: {
      worker: 'patent-search-commander', valid: true, missingHardFields: [], degraded: false,
    },
    gateFeedback: { score: 0.8, satisfied: true, failures: [], feedback: '' },
    gateRejections: 1,
    createdAt: 1, updatedAt: 1,
  }

  async function writeStateRoot(root: string, value: unknown): Promise<void> {
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(join(root, 'alpha', 'team.json'), JSON.stringify(value))
  }

  it('accepts a fully populated record with members and tasks', async () => {
    const root = await tmpRoot()
    const state = makeState({
      description: 'purpose',
      members: [validMember],
      tasks: [validTask],
      taskSeq: 1,
    })
    await createTeamDir(root, state)
    expect(await readTeam(root, 'alpha')).toEqual(state)
  })

  it('rejects malformed member records', async () => {
    const root = await tmpRoot()
    const badMembers: Array<[string, unknown]> = [
      ['id', 5],
      ['name', 5],
      ['name', '   '],
      ['role', 5],
      ['provider', 5],
      ['model', 5],
      ['reasoningEffort', 5],
      ['joinedAt', Number.NaN],
      ['joinedAt', '1'],
      ['status', 'busy'],
    ]
    for (const [field, value] of badMembers) {
      const member = { ...validMember, [field]: value }
      await writeStateRoot(root, makeState({ members: [member] }))
      await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)
    }
  })

  it('rejects malformed task records', async () => {
    const root = await tmpRoot()
    const badTasks: Array<[string, unknown]> = [
      ['id', 5],
      ['subject', 5],
      ['description', 5],
      ['status', 'done'],
      ['assignee', 5],
      ['dependencies', 'x'],
      ['dependencies', ['t0', 5]],
      ['output', 5],
      ['attempt', 1.5],
      ['attempt', -1],
      ['attempt', '1'],
      ['attemptId', 5],
      ['handoffId', 5],
      ['reassigning', 'yes'],
      ['worker', 5],
      ['contractValidation', []],
      ['contractValidation', { worker: 'x', valid: 'yes', missingHardFields: [], degraded: false }],
      ['gateFeedback', []],
      ['gateFeedback', { score: '0.5', satisfied: false, failures: [], feedback: '' }],
      ['gateRejections', -1],
      ['gateRejections', 1.5],
      ['createdAt', 'x'],
      ['updatedAt', 'x'],
    ]
    for (const [field, value] of badTasks) {
      const task = { ...validTask, [field]: value }
      await writeStateRoot(root, makeState({ tasks: [task] }))
      await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)
    }
  })

  it('rejects malformed team-state records', async () => {
    const root = await tmpRoot()
    const base = makeState({ description: 'purpose' })
    const badStates: Array<[string, unknown]> = [
      ['id', 'beta'],
      ['name', 5],
      ['name', ''],
      ['description', 5],
      ['captainSessionId', 5],
      ['captainSessionId', ''],
      ['createdAt', 'x'],
      ['members', 'x'],
      ['tasks', 'x'],
      ['taskSeq', 1.5],
      ['taskSeq', -1],
    ]
    for (const [field, value] of badStates) {
      await writeStateRoot(root, { ...base, [field]: value })
      await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)
    }
  })

  it('rejects non-record member and task entries', async () => {
    const root = await tmpRoot()
    await writeStateRoot(root, makeState({ members: [42] } as unknown as Partial<TeamState>))
    await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)
    await writeStateRoot(root, makeState({ tasks: ['not-a-task'] } as unknown as Partial<TeamState>))
    await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)
  })

  it('rejects non-record team files and member/task identity collisions', async () => {
    const root = await tmpRoot()
    await writeStateRoot(root, 42)
    await expect(readTeam(root, 'alpha')).rejects.toThrow(/invalid PatentTeams state in team "alpha"/)

    await writeStateRoot(root, makeState({ members: [{ ...validMember, id: '' }] }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()

    await writeStateRoot(root, makeState({ members: [{ ...validMember, name: 'Captain!' }] }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()

    const duplicateId = [
      { ...validMember },
      { ...validMember, name: 'bob', id: 'm1' },
    ]
    await writeStateRoot(root, makeState({ members: duplicateId }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()

    // Distinct names that sanitize to the same key collide.
    const keyCollision = [
      { ...validMember },
      { ...validMember, name: 'Alice', id: 'm2' },
    ]
    await writeStateRoot(root, makeState({ members: keyCollision }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()

    await writeStateRoot(root, makeState({ tasks: [{ ...validTask, id: '' }] }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()

    await writeStateRoot(root, makeState({ tasks: [{ ...validTask }, { ...validTask, id: 't1' }] }))
    await expect(readTeam(root, 'alpha')).rejects.toThrow()
  })
})

describe('retired member index', () => {
  it('returns an empty set when the index file is absent', async () => {
    const root = await tmpRoot()
    expect([...(await readRetiredMemberIds(root))]).toEqual([])
  })

  it('records ids sorted, skips empties, and reads them back', async () => {
    const root = await tmpRoot()
    await recordRetiredMemberIds(root, ['b', 'a', ''])
    await recordRetiredMemberIds(root, ['c'])
    expect([...(await readRetiredMemberIds(root))]).toEqual(['a', 'b', 'c'])
  })

  it('does nothing when no ids are added', async () => {
    const root = await tmpRoot()
    await recordRetiredMemberIds(root, [])
    await expect(readFile(join(root, 'retired-members.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws on a corrupt index', async () => {
    const root = await tmpRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'retired-members.json'), '{"not":"an array"}')
    await expect(readRetiredMemberIds(root)).rejects.toThrow('invalid PatentTeams retired member index')
    await writeFile(join(root, 'retired-members.json'), '["ok", ""]')
    await expect(readRetiredMemberIds(root)).rejects.toThrow('invalid PatentTeams retired member index')
  })
})

describe('team lookup', () => {
  it('findTeamByCaptain finds the single team led by a captain', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState({ captainSessionId: 'c1' }))
    const team = await findTeamByCaptain(root, 'c1')
    expect(team?.id).toBe('alpha')
    expect(await findTeamByCaptain(root, 'nobody')).toBeUndefined()
  })

  it('findTeamByCaptain fails loud on multiple teams for one captain', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState({ id: 'alpha', captainSessionId: 'c1' }))
    await createTeamDir(root, makeState({ id: 'beta', name: 'Beta', captainSessionId: 'c1' }))
    await expect(findTeamByCaptain(root, 'c1')).rejects.toThrow(
      'captain session leads multiple active teams ("alpha", "beta"); archive one before continuing',
    )
  })

  it('findTeamByParticipant matches the captain or a live member', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState({
      id: 'alpha',
      captainSessionId: 'c1',
      members: [
        { id: 'm1', name: 'alice', joinedAt: 1, status: 'idle' },
        { id: 'm2', name: 'bob', joinedAt: 1, status: 'removed' },
      ],
    }))
    expect((await findTeamByParticipant(root, 'c1'))?.id).toBe('alpha')
    expect((await findTeamByParticipant(root, 'm1'))?.id).toBe('alpha')
    // Removed members no longer count as participants.
    expect(await findTeamByParticipant(root, 'm2')).toBeUndefined()
    expect(await findTeamByParticipant(root, 'stranger')).toBeUndefined()
  })

  it('findTeamByParticipant fails loud when one session is in several teams', async () => {
    const root = await tmpRoot()
    const member: TeamMember = { id: 'm1', name: 'alice', joinedAt: 1, status: 'idle' }
    await createTeamDir(root, makeState({ id: 'alpha', members: [member] }))
    await createTeamDir(root, makeState({ id: 'beta', name: 'Beta', members: [member] }))
    await expect(findTeamByParticipant(root, 'm1')).rejects.toThrow(
      'agent session belongs to multiple active teams ("alpha", "beta"); the target team is ambiguous',
    )
  })

  it('returns undefined when the state root is missing (ENOENT scan)', async () => {
    const root = await tmpRoot()
    const missing = join(root, 'does-not-exist')
    expect(await findTeamByCaptain(missing, 'c1')).toBeUndefined()
    expect(await findTeamByParticipant(missing, 'm1')).toBeUndefined()
  })

  it('surfaces non-ENOENT scan failures', async () => {
    const root = await tmpRoot()
    const asFile = join(root, 'not-a-dir')
    await writeFile(asFile, 'plain file')
    await expect(findTeamByCaptain(asFile, 'c1')).rejects.toThrow()
  })

  it('skips non-directory and team-less entries while scanning', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState({ captainSessionId: 'c1' }))
    // A stray file and a directory without a team record are ignored.
    await writeFile(join(root, 'stray.txt'), 'noise')
    await mkdir(join(root, 'empty-dir'))
    expect((await findTeamByCaptain(root, 'c1'))?.id).toBe('alpha')
    expect(await findTeamByCaptain(root, 'nobody')).toBeUndefined()
  })
})

describe('mailbox persistence', () => {
  function message(id: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
    return { id, from: 'alice', to: 'captain', content: `hello ${id}`, ts: 1, ...overrides }
  }

  it('appendMailbox creates the JSONL file and appends without losing existing content', async () => {
    const root = await tmpRoot()
    await appendMailbox(root, 'alpha', CAPTAIN_KEY, message('m1'))
    await appendMailbox(root, 'alpha', CAPTAIN_KEY, message('m2'))
    const mailbox = await readMailbox(root, 'alpha', CAPTAIN_KEY)
    expect(mailbox.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(mailbox[0]).toMatchObject({ from: 'alice', to: 'captain', content: 'hello m1' })
  })

  it('appends without a separator to an existing empty mailbox', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), '')
    await appendMailbox(root, 'alpha', CAPTAIN_KEY, message('m1'))
    expect(await readFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), 'utf8'))
      .toBe(`${JSON.stringify(message('m1'))}\n`)
  })

  it('readMailbox returns [] when the mailbox does not exist', async () => {
    const root = await tmpRoot()
    expect(await readMailbox(root, 'alpha', CAPTAIN_KEY)).toEqual([])
  })

  it('skips blank and malformed lines and reports them to the hook', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    const good = message('m1')
    await writeFile(
      join(root, 'alpha', 'inbox', 'captain.jsonl'),
      ['', JSON.stringify(good), 'not-json', JSON.stringify({ id: 'm2' })].join('\n'),
    )
    const malformed: Array<[number, unknown]> = []
    const mailbox = await readMailbox(root, 'alpha', CAPTAIN_KEY, (line, error) => malformed.push([line, error]))
    expect(mailbox.map(m => m.id)).toEqual(['m1'])
    expect(malformed).toHaveLength(2)
    expect(malformed[0]![0]).toBe(3)
    expect(String(malformed[0]![1])).toContain('invalid JSON')
    expect(String(malformed[1]![1])).toContain('invalid message shape')
  })

  it('strips a BOM from the first mailbox line', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(
      join(root, 'alpha', 'inbox', 'captain.jsonl'),
      '\uFEFF' + JSON.stringify(message('m1')) + '\n',
    )
    const mailbox = await readMailbox(root, 'alpha', CAPTAIN_KEY)
    expect(mailbox.map(m => m.id)).toEqual(['m1'])
  })

  it('readUnreadMailbox excludes acknowledged messages and fresh delivery leases', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    const now = Date.now()
    const lines = [
      message('read', { readAt: now }),
      message('claimed-recent', { deliveryClaimedAt: now }),
      message('claimed-expired', { deliveryClaimedAt: now - 120_000 }),
      message('fresh'),
    ].map(m => JSON.stringify(m))
    await writeFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), lines.join('\n'))
    const unread = await readUnreadMailbox(root, 'alpha', CAPTAIN_KEY)
    expect(unread.map(m => m.id)).toEqual(['claimed-expired', 'fresh'])
  })

  it('splits unread messages from those held by a live-delivery lease', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    const now = Date.now()
    const lines = [
      message('read', { readAt: now }),
      message('claimed-recent', { deliveryClaimedAt: now }),
      message('claimed-expired', { deliveryClaimedAt: now - 120_000 }),
      message('fresh'),
    ].map(m => JSON.stringify(m))
    await writeFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), lines.join('\n'))
    const snapshot = await readMailboxSnapshot(root, 'alpha', CAPTAIN_KEY)
    expect(snapshot.unread.map(m => m.id)).toEqual(['claimed-expired', 'fresh'])
    expect(snapshot.leased.map(m => m.id)).toEqual(['claimed-recent'])
  })

  it('honors a custom delivery lease', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(
      join(root, 'alpha', 'inbox', 'captain.jsonl'),
      JSON.stringify(message('claimed', { deliveryClaimedAt: Date.now() - 10 })),
    )
    expect(await readUnreadMailbox(root, 'alpha', CAPTAIN_KEY)).toHaveLength(0)
    expect((await readUnreadMailbox(root, 'alpha', CAPTAIN_KEY, undefined, 1)).map(m => m.id))
      .toEqual(['claimed'])
  })

  it('claim/release/acknowledge mutate only the selected records and preserve malformed lines', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    const m1 = message('m1')
    const m2 = message('m2')
    await writeFile(
      join(root, 'alpha', 'inbox', 'alice.jsonl'),
      [JSON.stringify(m1), 'broken-line', JSON.stringify(m2)].join('\n') + '\n',
    )

    await claimMailboxDelivery(root, 'alpha', 'alice', ['m1'])
    let mailbox = await readMailbox(root, 'alpha', 'alice')
    expect(mailbox[0]!.deliveryClaimedAt).toBeGreaterThan(0)
    expect(mailbox[1]!.deliveryClaimedAt).toBeUndefined()

    await releaseMailboxDelivery(root, 'alpha', 'alice', ['m1'])
    mailbox = await readMailbox(root, 'alpha', 'alice')
    expect(mailbox[0]!.deliveryClaimedAt).toBeUndefined()
    expect(mailbox[0]).toEqual(m1)

    await acknowledgeMailbox(root, 'alpha', 'alice', ['m1', 'm2'])
    mailbox = await readMailbox(root, 'alpha', 'alice')
    expect(mailbox[0]!.deliveredAt).toBeGreaterThan(0)
    expect(mailbox[0]!.readAt).toBeGreaterThan(0)
    expect(mailbox[1]!.deliveredAt).toBeGreaterThan(0)
    // Malformed line is untouched.
    const raw = await readFile(join(root, 'alpha', 'inbox', 'alice.jsonl'), 'utf8')
    expect(raw).toContain('broken-line')
    expect(raw.split('\n')).toHaveLength(4)
  })

  it('does not lease a message that was already acknowledged', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(
      join(root, 'alpha', 'inbox', 'alice.jsonl'),
      JSON.stringify(message('read-1', { readAt: 1234 })) + '\n',
    )
    const claimed = await claimMailboxDelivery(root, 'alpha', 'alice', ['read-1'])
    expect(claimed).toEqual([])
    const [kept] = await readMailbox(root, 'alpha', 'alice')
    expect(kept!.readAt).toBe(1234)
    expect(kept!.deliveryClaimedAt).toBeUndefined()
  })

  it('returns only the ids leased by the claim', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(
      join(root, 'alpha', 'inbox', 'alice.jsonl'),
      [
        JSON.stringify(message('read-1', { readAt: 1234 })),
        JSON.stringify(message('unread-1')),
      ].join('\n') + '\n',
    )
    const claimed = await claimMailboxDelivery(root, 'alpha', 'alice', ['read-1', 'unread-1'])
    expect(claimed).toEqual(['unread-1'])
    const mailbox = await readMailbox(root, 'alpha', 'alice')
    expect(mailbox[0]!.deliveryClaimedAt).toBeUndefined()
    expect(mailbox[1]!.deliveryClaimedAt).toBeGreaterThan(0)
  })

  it('acknowledge preserves an existing readAt and mutating an empty or missing mailbox is a no-op', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    const earlier = 1000
    await writeFile(join(root, 'alpha', 'inbox', 'alice.jsonl'), JSON.stringify(message('m1', { deliveredAt: earlier, readAt: earlier })) + '\n')
    await acknowledgeMailbox(root, 'alpha', 'alice', ['m1'])
    const [kept] = await readMailbox(root, 'alpha', 'alice')
    expect(kept!.deliveredAt).toBe(earlier)
    expect(kept!.readAt).toBe(earlier)

    await claimMailboxDelivery(root, 'alpha', 'ghost', ['m1'])
    await releaseMailboxDelivery(root, 'alpha', 'ghost', ['m1'])
    await acknowledgeMailbox(root, 'alpha', 'ghost', ['m1'])
    await acknowledgeMailbox(root, 'alpha', 'alice', [])
    // Nothing threw; the mailbox still holds exactly one record.
    expect(await readMailbox(root, 'alpha', 'alice')).toHaveLength(1)
  })

  it('createMessage builds a fresh record with the given route', () => {
    const m = createMessage('from-x', 'to-y', 'content-z')
    expect(m).toMatchObject({ from: 'from-x', to: 'to-y', content: 'content-z' })
    expect(typeof m.id).toBe('string')
    expect(m.id.length).toBeGreaterThan(0)
    expect(m.ts).toBeGreaterThan(0)
  })

  it('appends with a newline separator when the mailbox lacks a trailing newline', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), JSON.stringify(message('m1')))
    await appendMailbox(root, 'alpha', CAPTAIN_KEY, message('m2'))
    const mailbox = await readMailbox(root, 'alpha', CAPTAIN_KEY)
    expect(mailbox.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('surfaces non-ENOENT mailbox read failures instead of swallowing them', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    // A directory where the mailbox file should be: readFile throws EISDIR.
    await mkdir(join(root, 'alpha', 'inbox', 'captain.jsonl'))
    await expect(appendMailbox(root, 'alpha', CAPTAIN_KEY, message('m1'))).rejects.toThrow()
    await expect(readMailbox(root, 'alpha', CAPTAIN_KEY)).rejects.toThrow()
    await expect(claimMailboxDelivery(root, 'alpha', CAPTAIN_KEY, ['m1'])).rejects.toThrow()
    await expect(releaseMailboxDelivery(root, 'alpha', CAPTAIN_KEY, ['m1'])).rejects.toThrow()
    await expect(acknowledgeMailbox(root, 'alpha', CAPTAIN_KEY, ['m1'])).rejects.toThrow()
  })

  it('skips non-record mailbox lines as malformed', async () => {
    const root = await tmpRoot()
    await mkdir(join(root, 'alpha', 'inbox'), { recursive: true })
    await writeFile(join(root, 'alpha', 'inbox', 'captain.jsonl'), '42\n' + JSON.stringify(message('m1')) + '\n')
    const malformed: Array<[number, unknown]> = []
    const mailbox = await readMailbox(root, 'alpha', CAPTAIN_KEY, (line, error) => malformed.push([line, error]))
    expect(mailbox.map(m => m.id)).toEqual(['m1'])
    expect(String(malformed[0]![1])).toContain('invalid message shape')
  })
})

describe('replaceFileAtomicOrDirect', () => {
  function primitives(overrides: Partial<{
    rename: (from: string, to: string) => Promise<void>
    writeFile: (file: string, content: string) => Promise<void>
    remove: (file: string) => Promise<void>
  }> = {}) {
    return {
      rename: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      ...overrides,
    }
  }

  it('prefers the atomic rename and never touches the fallback', async () => {
    const p = primitives()
    await replaceFileAtomicOrDirect('tmp', 'file', 'content', p)
    expect(p.rename).toHaveBeenCalledWith('tmp', 'file')
    expect(p.writeFile).not.toHaveBeenCalled()
    expect(p.remove).not.toHaveBeenCalled()
  })

  it('retries transient rename errors before succeeding', async () => {
    let attempts = 0
    const p = primitives({
      rename: vi.fn(async () => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('lock'), { code: 'EPERM' })
      }),
    })
    await replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 3, retryDelayMs: 0 })
    expect(attempts).toBe(3)
    expect(p.writeFile).not.toHaveBeenCalled()
  })

  it('falls back to a direct write after retries are exhausted and cleans the temp file', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw Object.assign(new Error('lock'), { code: 'EPERM' }) }),
    })
    await replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 2, retryDelayMs: 0 })
    expect(p.writeFile).toHaveBeenCalledWith('file', 'content')
    expect(p.remove).toHaveBeenCalledWith('tmp')
  })

  it('falls back immediately for a non-retryable rename error', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }),
    })
    await replaceFileAtomicOrDirect('tmp', 'file', 'content', p)
    expect(p.writeFile).toHaveBeenCalledWith('file', 'content')
    expect(p.remove).toHaveBeenCalledWith('tmp')
  })

  it('uses zero-retry options verbatim', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw Object.assign(new Error('lock'), { code: 'EBUSY' }) }),
    })
    await replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 0 })
    expect(p.rename).toHaveBeenCalledTimes(1)
    expect(p.writeFile).toHaveBeenCalledTimes(1)
  })

  it('throws an AggregateError when both the rename and the direct write fail', async () => {
    const renameError = Object.assign(new Error('rename failed'), { code: 'EPERM' })
    const writeError = new Error('write failed')
    const p = primitives({
      rename: vi.fn(async () => { throw renameError }),
      writeFile: vi.fn(async () => { throw writeError }),
    })
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 1, retryDelayMs: 0 }))
      .rejects.toThrow(AggregateError)
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 1, retryDelayMs: 0 }))
      .rejects.toThrow(/failed to replace "file" atomically .* or by direct write/)
    expect(p.remove).toHaveBeenCalledWith('tmp')
  })

  it('serializes non-Error failures into the AggregateError message', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw 'rename-boom' }),
      writeFile: vi.fn(async () => { throw 'write-boom' }),
    })
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 0 }))
      .rejects.toThrow(AggregateError)
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 0 }))
      .rejects.toThrow(/failed to replace "file" atomically \("rename-boom"\) or by direct write \("write-boom"\)/)
  })

  it('treats a code-less error as non-retryable and falls back', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw Object.assign(new Error('codeless'), { code: null }) }),
    })
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 2, retryDelayMs: 0 }))
      .resolves.toBeUndefined()
    expect(p.writeFile).toHaveBeenCalledWith('file', 'content')
  })

  it('swallows a temp-file removal failure before reporting the fallback outcome', async () => {
    const p = primitives({
      rename: vi.fn(async () => { throw Object.assign(new Error('lock'), { code: 'EACCES' }) }),
      remove: vi.fn(async () => { throw new Error('remove failed') }),
    })
    await expect(replaceFileAtomicOrDirect('tmp', 'file', 'content', p, { retries: 0 }))
      .resolves.toBeUndefined()
    expect(p.writeFile).toHaveBeenCalledWith('file', 'content')
  })
})

describe('team archiving', () => {
  it('moves a live team under archive/', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    expect(await readTeam(root, 'alpha')).toBeUndefined()
    expect((await readArchivedTeam(root, 'alpha'))?.id).toBe('alpha')
    expect(await listArchivedTeamIds(root)).toEqual(['alpha'])
  })

  it('displaces a previous archive generation and cleans the recovery directory', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    const oldArchived = await readArchivedTeam(root, 'alpha')
    expect(oldArchived?.name).toBe('Alpha')

    // A second generation replaces the archived copy.
    await createTeamDir(root, makeState({ name: 'Alpha v2' }))
    await archiveTeamDir(root, 'alpha')
    expect((await readArchivedTeam(root, 'alpha'))?.name).toBe('Alpha v2')
    // No hidden recovery directories remain.
    const entries = await readdir(join(root, 'archive'))
    expect(entries.filter(name => name.startsWith('.'))).toEqual([])
  })

  it('rolls the previous archive back when the live team cannot be moved', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    const archived = await readArchivedTeam(root, 'alpha')
    expect(archived?.name).toBe('Alpha')

    // The live team is gone; archiving again fails after displacing the old
    // archive, and the displaced archive is restored.
    await expect(archiveTeamDir(root, 'alpha')).rejects.toThrow()
    expect((await readArchivedTeam(root, 'alpha'))?.name).toBe('Alpha')
  })

  it('rethrows when archiving a never-created team', async () => {
    const root = await tmpRoot()
    await expect(archiveTeamDir(root, 'ghost')).rejects.toThrow()
  })

  it('surfaces non-ENOENT displacement failures', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    // `archive` is a file: renaming below it fails with ENOTDIR.
    await writeFile(join(root, 'archive'), 'blocker')
    await expect(archiveTeamDir(root, 'alpha')).rejects.toThrow()
  })

  it('retries transient rename locks and then surfaces the failure', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    await createTeamDir(root, makeState({ name: 'Alpha v2' }))
    const archiveRoot = join(root, 'archive')
    // A read-only archive blocks the displacement move (EACCES is retryable);
    // after the retries are exhausted the error propagates.
    await chmod(archiveRoot, 0o555)
    try {
      await expect(archiveTeamDir(root, 'alpha')).rejects.toThrow()
    } finally {
      await chmod(archiveRoot, 0o755)
    }
  })

  it('tolerates a failed cleanup of the displaced recovery directory', async () => {
    const root = await tmpRoot()
    // v1 is archived WITH an unreadable subdirectory, so its removal later
    // fails and the best-effort cleanup is swallowed.
    await createTeamDir(root, makeState())
    const blocked = join(root, 'alpha', 'inbox', 'blocked')
    await mkdir(blocked)
    await writeFile(join(blocked, 'file.txt'), 'x')
    await chmod(blocked, 0o555)
    try {
      await archiveTeamDir(root, 'alpha')

      // v2 displaces the archived v1 (rename does not recurse into the locked
      // subtree); the recovery-dir cleanup then fails and is ignored.
      await createTeamDir(root, makeState({ name: 'Alpha v2' }))
      await archiveTeamDir(root, 'alpha')
      expect((await readArchivedTeam(root, 'alpha'))?.name).toBe('Alpha v2')
    } finally {
      await chmod(blocked, 0o755).catch(() => undefined)
      await chmod(join(root, 'archive', '.alpha' + '-placeholder'), 0o755).catch(() => undefined)
    }
  })

  it('listArchivedTeamIds surfaces non-ENOENT archive failures', async () => {
    const root = await tmpRoot()
    await writeFile(join(root, 'archive'), 'blocker')
    await expect(listArchivedTeamIds(root)).rejects.toThrow()
  })

  it('listArchivedTeamIds is empty when no archive exists and hides dot-directories', async () => {
    const root = await tmpRoot()
    expect(await listArchivedTeamIds(root)).toEqual([])
    await mkdir(join(root, 'archive', '.hidden'), { recursive: true })
    await mkdir(join(root, 'archive', 'real'), { recursive: true })
    expect(await listArchivedTeamIds(root)).toEqual(['real'])
  })
})

describe('withTeamLock', () => {
  it('serializes concurrent mutations of one key and returns the result', async () => {
    const events: string[] = []
    const run = (label: string, delay: number) => withTeamLock('k', async () => {
      events.push(`start:${label}`)
      const { promise, resolve } = Promise.withResolvers<undefined>()
      setTimeout(resolve, delay)
      await promise
      events.push(`end:${label}`)
      return label
    })
    const results = await Promise.all([run('a', 30), run('b', 0)])
    expect(results).toEqual(['a', 'b'])
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('releases the lock when the mutation rejects and independent keys stay parallel', async () => {
    await expect(withTeamLock('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // The failed lock was cleaned up: a new mutation on the same key runs.
    await expect(withTeamLock('k', async () => 'after')).resolves.toBe('after')

    const order: string[] = []
    const slowA = withTeamLock('a', async () => {
      order.push('a')
      const { promise, resolve } = Promise.withResolvers<undefined>()
      setTimeout(resolve, 20)
      await promise
    })
    await Promise.all([slowA, withTeamLock('b', async () => { order.push('b') })])
    expect(order).toEqual(['a', 'b'])
  })
})

describe('path helpers', () => {
  it('stateRootOf and teamLockKey derive stable values', () => {
    expect(stateRootOf('/ws', '.teams')).toBe(join('/ws', '.teams'))
    expect(teamLockKey('/root', 'alpha')).toBe('team:/root:alpha')
    expect(teamLockKey('/other', 'alpha')).toBe('team:/other:alpha')
  })
})
