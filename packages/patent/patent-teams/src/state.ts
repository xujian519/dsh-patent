/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code PatentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-patent-teams/state
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isENOENT, isRecord } from '@deepseek-ai/dsh-value'
import type { TaskContractValidation, TaskGateFeedback, TaskStatus, TeamMember, TeamState, TeamTask } from './types.ts'
import { atomicWriteText, renameWithRetry, sanitizeKey, stripLeadingBom, withTeamLock } from './team-lock.ts'
import { isFiniteNumber } from './value.ts'

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain'
/** Durable deny-list for PatentTeams members that must never be resumed. */
const RETIRED_MEMBERS_FILE = 'retired-members.json'
/** State-root directory names the archive layout reserves; a team id must never collide with them. */
export const RESERVED_TEAM_IDS: ReadonlySet<string> = new Set(['archive'])

/**
 * Whether `dependencies` are all satisfied (every named task exists and
 * completed) for the given task list.
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
export function unsatisfiedDependencies(tasks: TeamTask[], dependencies: string[]): string[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  return dependencies.filter(id => byId.get(id)?.status !== 'completed')
}

/**
 * The allowed task status transitions, keyed by current status.
 * Terminal statuses have no outgoing transitions.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * Validate one task status transition. The error names the legal next step,
 * because the caller that guessed a jump (typically `claimed → completed`) needs
 * to know which intermediate status to enter, not only that it was refused.
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the transition error, or undefined when allowed.
 */
export function transitionError(current: TaskStatus, next: TaskStatus): string | undefined {
  if (current === next) return undefined
  if (!TASK_TRANSITIONS[current].includes(next)) {
    const allowed = TASK_TRANSITIONS[current]
    const guidance = allowed.length === 0
      ? `"${current}" is terminal — retry or reassign the task instead`
      : `allowed next: ${allowed.map(status => `"${status}"`).join(', ')}`
    return `task status cannot move from "${current}" to "${next}" (${guidance})`
  }
  return undefined
}

/**
 * Activate the task's current generation for one owner.
 * @param task - the task to claim.
 * @param assignee - the member name taking ownership.
 * @returns the new attempt's capability id.
 */
export function activateTaskAttempt(task: TeamTask, assignee: string): string {
  const attemptId = randomUUID()
  task.status = 'claimed'
  task.assignee = assignee
  task.attemptId = attemptId
  delete task.handoffId
  task.reassigning = false
  delete task.output
  task.updatedAt = Date.now()
  return attemptId
}

/**
 * Start a fresh task generation for one owner.
 * @param task - the task to start.
 * @param assignee - the member name taking ownership.
 * @returns the new attempt's capability id.
 */
export function beginTaskAttempt(task: TeamTask, assignee: string): string {
  task.attempt = (task.attempt ?? 0) + 1
  return activateTaskAttempt(task, assignee)
}

/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 * @param task - the task whose generation to revoke.
 * @param nextAssignee - optional member to reassign the task to.
 * @param reassigning - whether this invalidation is part of a reassignment.
 * @returns the handoff id that now owns the pending generation.
 */
export function invalidateTaskAttempt(
  task: TeamTask,
  nextAssignee?: string,
  reassigning = false,
): string {
  const handoffId = randomUUID()
  delete task.attemptId
  task.handoffId = handoffId
  task.status = 'pending'
  if (nextAssignee === undefined) {
    delete task.assignee
  } else {
    task.assignee = nextAssignee
  }
  task.reassigning = reassigning
  delete task.output
  task.updatedAt = Date.now()
  return handoffId
}

/**
 * Revoke a task's current capability without changing its lifecycle state or
 * recorded result. Used when a team is archived: late member updates must fail,
 * while the archived record keeps the terminal status, assignee, and output for
 * later review.
 * @param task - the task whose attempt to revoke.
 */
export function revokeTaskAttempt(task: TeamTask): void {
  delete task.attemptId
  delete task.handoffId
  delete task.reassigning
  task.updatedAt = Date.now()
}

/**
 * Create the team directory structure and the initial team record.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the initial team record.
 */
export async function createTeamDir(stateRoot: string, state: TeamState): Promise<void> {
  const dir = join(stateRoot, state.id)
  await mkdir(join(dir, 'inbox'), { recursive: true })
  await atomicWriteText(join(dir, 'team.json'), JSON.stringify(state, null, 2))
}

/** Parse and validate one team record's file content. */
function parseTeamRecord(raw: string, teamId: string, file: string): TeamState {
  let value: unknown
  try {
    value = JSON.parse(stripLeadingBom(raw))
  } catch (error: unknown) {
    /* v8 ignore next -- JSON.parse throws SyntaxError, which is an Error */
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid PatentTeams state in team "${teamId}" (${file}): ${detail}`, { cause: error })
  }
  if (!isTeamState(value, teamId)) {
    throw new Error(`invalid PatentTeams state in team "${teamId}" (${file})`)
  }
  return value
}

/**
 * Read one team record; `undefined` when absent.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 * @returns the team record, or `undefined` when absent.
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  const file = join(stateRoot, teamId, 'team.json')
  try {
    return parseTeamRecord(await readFile(file, 'utf8'), teamId, file)
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Persist one team record (inside the caller's lock).
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the record to persist.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  await atomicWriteText(join(stateRoot, state.id, 'team.json'), JSON.stringify(state, null, 2))
}

/**
 * Read the durable set of member session ids retired by remove/delete.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the retired member session ids.
 */
export async function readRetiredMemberIds(stateRoot: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(
      await readFile(join(stateRoot, RETIRED_MEMBERS_FILE), 'utf8'),
    ))
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || value === '')) {
      throw new Error('invalid PatentTeams retired member index')
    }
    return new Set(parsed)
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return new Set()
    }
    throw error
  }
}

/**
 * Atomically add session ids to the durable retired-member deny-list.
 * @param stateRoot - resolved absolute state root directory.
 * @param memberIds - the member session ids to retire.
 */
export async function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void> {
  const additions = memberIds.filter(id => id !== '')
  if (additions.length === 0) return
  await withTeamLock(`retired-members:${stateRoot}`, async () => {
    const retired = await readRetiredMemberIds(stateRoot)
    for (const id of additions) retired.add(id)
    await mkdir(stateRoot, { recursive: true })
    await atomicWriteText(
      join(stateRoot, RETIRED_MEMBERS_FILE),
      `${JSON.stringify([...retired].sort(), null, 2)}\n`,
    )
  })
}

/** Read every live team record under the state root (missing root = none). */
async function scanTeams(stateRoot: string): Promise<TeamState[]> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (isENOENT(error)) return []
    throw error
  }
  const teams: TeamState[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    if (team !== undefined) teams.push(team)
  }
  return teams
}

/** The single team satisfying `matches`, or a loud failure when several do. */
async function findTeamOnce(
  stateRoot: string,
  matches: (team: TeamState) => boolean,
  ambiguityMessage: (first: TeamState, second: TeamState) => string,
): Promise<TeamState | undefined> {
  let found: TeamState | undefined
  for (const team of await scanTeams(stateRoot)) {
    if (!matches(team)) continue
    if (found !== undefined) throw new Error(ambiguityMessage(found, team))
    found = team
  }
  return found
}

/**
 * Find the team owned by one captain session (at most one per captain).
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the owning session id.
 * @returns the team record, or undefined when the captain leads no team.
 */
export async function findTeamByCaptain(
  stateRoot: string,
  captainSessionId: string,
): Promise<TeamState | undefined> {
  return findTeamOnce(
    stateRoot,
    team => team.captainSessionId === captainSessionId,
    (first, second) => `captain session leads multiple active teams ("${first.id}", "${second.id}"); archive one before continuing`,
  )
}

/**
 * Find the team in which one session is an active participant.
 * Captains match `captainSessionId`; members match their durable child session
 * id. Removed members no longer have access to team-scoped tools.
 * @param stateRoot - resolved absolute state root directory.
 * @param agentSessionId - calling captain/member session id.
 * @returns the team record, or undefined when the caller belongs to no team.
 */
export async function findTeamByParticipant(
  stateRoot: string,
  agentSessionId: string,
): Promise<TeamState | undefined> {
  return findTeamOnce(
    stateRoot,
    team => team.captainSessionId === agentSessionId
      || team.members.some(member => member.id === agentSessionId && member.status !== 'removed'),
    (first, second) => `agent session belongs to multiple active teams ("${first.id}", "${second.id}"); the target team is ambiguous`,
  )
}

/** Whether a value is an optional string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a non-negative safe integer counter. */
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Validate a recorded worker-contract verdict. */
function isTaskContractValidation(value: unknown): value is TaskContractValidation {
  if (!isRecord(value)) return false
  return typeof value['worker'] === 'string'
    && typeof value['valid'] === 'boolean'
    && Array.isArray(value['missingHardFields'])
    && value['missingHardFields'].every(item => typeof item === 'string')
    && typeof value['degraded'] === 'boolean'
}

/** Validate a recorded quality-gate verdict. */
function isTaskGateFeedback(value: unknown): value is TaskGateFeedback {
  if (!isRecord(value)) return false
  return isFiniteNumber(value['score'])
    && typeof value['satisfied'] === 'boolean'
    && Array.isArray(value['failures'])
    && value['failures'].every(item => typeof item === 'string')
    && typeof value['feedback'] === 'string'
}

/** Validate one member record at the durable JSON boundary. */
function isTeamMember(value: unknown): value is TeamMember {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isFiniteNumber(value['joinedAt'])
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed')
}

/** Validate one task record at the durable JSON boundary. */
function isTeamTask(value: unknown): value is TeamTask {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled')
    && isOptionalString(value['assignee'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every(dependency => typeof dependency === 'string')
    && isOptionalString(value['output'])
    && (value['attempt'] === undefined || isNonNegativeInteger(value['attempt']))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['handoffId'])
    && (value['reassigning'] === undefined || typeof value['reassigning'] === 'boolean')
    && isOptionalString(value['worker'])
    && (value['contractValidation'] === undefined || isTaskContractValidation(value['contractValidation']))
    && (value['gateFeedback'] === undefined || isTaskGateFeedback(value['gateFeedback']))
    && (value['gateRejections'] === undefined || isNonNegativeInteger(value['gateRejections']))
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt'])
}

/** Validate the full team record before it can participate in authorization. */
function isTeamState(value: unknown, expectedId: string): value is TeamState {
  if (!isRecord(value)) return false
  const validShape = value['id'] === expectedId
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && typeof value['captainSessionId'] === 'string'
    && value['captainSessionId'] !== ''
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members'])
    && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks'])
    && value['tasks'].every(isTeamTask)
    && Number.isSafeInteger(value['taskSeq'])
    && (value['taskSeq'] as number) >= 0
  if (!validShape) return false

  const members = value['members'] as TeamMember[]
  const tasks = value['tasks'] as TeamTask[]
  const memberIds = new Set<string>()
  const memberKeys = new Set<string>()
  for (const member of members) {
    const key = sanitizeKey(member.name)
    if (member.id === '' || key === CAPTAIN_KEY || memberIds.has(member.id) || memberKeys.has(key)) return false
    memberIds.add(member.id)
    memberKeys.add(key)
  }
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (task.id === '' || taskIds.has(task.id)) return false
    taskIds.add(task.id)
  }
  return true
}

/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function archiveTeamDir(stateRoot: string, teamId: string): Promise<void> {
  const archiveRoot = join(stateRoot, 'archive')
  await mkdir(archiveRoot, { recursive: true })
  const source = join(stateRoot, teamId)
  const target = join(archiveRoot, teamId)
  const previous = join(archiveRoot, `.${teamId}.previous-${randomUUID()}`)
  let displaced = false
  try {
    // The same Windows EPERM-on-rename applies at the directory boundary: a
    // delete-sharing violation on any file below `target` blocks the move, so
    // retry the transient-lock case before giving up.
    await renameWithRetry(target, previous)
    displaced = true
  } catch (error: unknown) {
    // Only ENOENT means there was nothing to displace; any other failure
    // (including a persistent EPERM lock) surfaces to the caller.
    if (!isENOENT(error)) {
      throw error
    }
  }

  try {
    await renameWithRetry(source, target)
  } catch (error: unknown) {
    if (displaced) {
      try {
        await renameWithRetry(previous, target)
      } catch (restoreError: unknown) {
        throw new AggregateError(
          [error, restoreError],
          `failed to archive team "${teamId}" and restore its previous archive`,
        )
      }
    }
    throw error
  }

  // The new generation is authoritative. A failed cleanup only leaves a
  // hidden recovery directory, which archive discovery deliberately ignores.
  if (displaced) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Read one archived team (already moved under `archive/`), or undefined when
 * it was never archived.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @returns the archived team record, or `undefined` when never archived.
 */
export async function readArchivedTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  return readTeam(join(stateRoot, 'archive'), teamId)
}

/**
 * List every archived team id under the state root.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the archived team ids, empty when the archive does not exist.
 */
export async function listArchivedTeamIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateRoot, 'archive'), { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }
}
