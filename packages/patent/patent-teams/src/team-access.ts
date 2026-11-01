/**
 * Team resolution and the authorization rechecks every mutation performs.
 *
 * A caller reaches a team two ways: as the captain that leads it, or as a
 * member that belongs to it. Both routes re-read durable state and re-derive
 * the caller's role inside the team lock, so an operation never acts on the
 * stale lookup that located it. These lookups are pure reads of the team file
 * plus `sanitizeKey`-derived paths; the mutations that consume them own the lock.
 * @module dsh-patent-teams/team-access
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { CAPTAIN_KEY, findTeamByCaptain, findTeamByParticipant, readTeam } from './state.ts'
import { sanitizeKey, stateRootOf, teamLockKey, withTeamLock } from './team-lock.ts'
import type { TeamMember, TeamState, TeamTask } from './types.ts'

/** A caller's role in a team, re-derived from fresh state. */
type ParticipantIdentity =
  | { kind: 'captain'; name: typeof CAPTAIN_KEY }
  | { kind: 'member'; name: string; sessionId: string }

/** The captain's workspace directory (team state root parent). */
function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/**
 * The absolute team-state root of one agent's workspace.
 * @param agent - the agent whose workspace owns the root.
 * @param stateDir - configured state directory name.
 * @returns the absolute path holding every team directory of that workspace.
 */
export function stateRootFor(agent: Agent, stateDir: string): string {
  return stateRootOf(workspaceOf(agent), stateDir)
}

/**
 * Re-derive a caller's role from fresh state while holding the team lock.
 * @param team - the fresh team record.
 * @param agentId - the calling session id.
 * @returns the caller's identity, or undefined when it is no longer a participant.
 */
function participantIdentityOf(team: TeamState, agentId: string): ParticipantIdentity | undefined {
  if (team.captainSessionId === agentId) return { kind: 'captain', name: CAPTAIN_KEY }
  const member = team.members.find(candidate => candidate.id === agentId && candidate.status !== 'removed')
  return member === undefined ? undefined : { kind: 'member', name: member.name, sessionId: member.id }
}

/**
 * Fresh state for a team that still exists; never falls back to stale lookup data.
 * @param stateRoot - the workspace's team-state root.
 * @param teamId - the team to re-read.
 * @returns the current team record.
 */
async function requireFreshTeam(stateRoot: string, teamId: string): Promise<TeamState> {
  const fresh = await readTeam(stateRoot, teamId)
  if (fresh === undefined) throw new Error(`team "${teamId}" is no longer active`)
  return fresh
}

/**
 * Look up one live (non-removed) member by display name.
 * @param team - the fresh team record.
 * @param name - the member's display name.
 * @returns the matching member.
 */
export function requireMember(team: TeamState, name: string): TeamMember {
  const member = team.members.find(candidate => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) {
    throw new Error(`no active member named "${name}" in team "${team.name}"`)
  }
  return member
}

/**
 * Look up one task by id.
 * @param team - the fresh team record.
 * @param taskId - the task id.
 * @returns the matching task.
 */
export function requireTask(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) {
    throw new Error(`no task "${taskId}" in team "${team.name}" — use patent_teams_status to list tasks`)
  }
  return task
}

/**
 * Admit one new member name into fresh state (inside the team lock). Runs
 * before the spawn and again before the persist, so a concurrent winner is
 * still rejected after its loser has already spawned.
 * @param team - the fresh team record.
 * @param rawName - the caller-supplied member name, for error text.
 * @param memberKey - the sanitized member key.
 * @param maxMembers - the configured team size cap.
 */
export function requireAddableMember(team: TeamState, rawName: string, memberKey: string, maxMembers: number): void {
  if (team.members.some(candidate => sanitizeKey(candidate.name) === memberKey)) {
    throw new Error(`member name "${rawName}" has already been used in team "${team.name}"`)
  }
  if (team.members.filter(candidate => candidate.status !== 'removed').length >= maxMembers) {
    throw new Error(`team "${team.name}" is at its member cap (${maxMembers})`)
  }
}

/**
 * The task this member still owes, excluding one task under consideration.
 * @param team - the fresh team record.
 * @param memberName - the member's display name.
 * @param exceptTaskId - a task to disregard, so a task never conflicts with itself.
 * @returns the open task, or undefined when the member owes none.
 */
export function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

/** The workspace, state root, and team one caller reaches through a single lookup. */
interface LocatedTeam {
  workspace: string
  stateRoot: string
  team: TeamState
}

/**
 * Locate the one team a caller reaches, or fail with that route's own message.
 * @param agent - the calling agent.
 * @param stateDir - configured state directory name.
 * @param locate - the captain or participant lookup.
 * @param absent - the message for a caller that reaches no active team.
 * @returns the caller's workspace, the state root, and the located team.
 */
async function locateTeam(
  agent: Agent,
  stateDir: string,
  locate: (stateRoot: string, agentId: string) => Promise<TeamState | undefined>,
  absent: string,
): Promise<LocatedTeam> {
  const workspace = workspaceOf(agent)
  const stateRoot = stateRootOf(workspace, stateDir)
  const team = await locate(stateRoot, agent.id)
  if (team === undefined) throw new Error(absent)
  return { workspace, stateRoot, team }
}

/**
 * Resolve the calling captain and the team it leads (loud when absent).
 * @param agent - the calling agent.
 * @param stateDir - configured state directory name.
 * @returns the captain's workspace, the state root, and the team it leads.
 */
export function captainTeam(agent: Agent, stateDir: string): Promise<LocatedTeam> {
  return locateTeam(agent, stateDir, findTeamByCaptain, 'you are not leading any team yet — call patent_teams_create first')
}

/**
 * Resolve the calling participant and the team it belongs to (loud when absent).
 * @param agent - the calling agent.
 * @param stateDir - configured state directory name.
 * @returns the participant's workspace, the state root, and the team it belongs to.
 */
export function participantTeam(agent: Agent, stateDir: string): Promise<LocatedTeam> {
  return locateTeam(agent, stateDir, findTeamByParticipant, 'you do not lead or belong to any active team yet')
}

/**
 * Fresh state with captain authorization rechecked inside the lock.
 * @param stateRoot - the workspace's team-state root.
 * @param teamId - the team to re-read.
 * @param captainId - the calling captain's session id.
 * @returns the fresh team record.
 */
export async function freshCaptainTeam(
  stateRoot: string,
  teamId: string,
  captainId: string,
): Promise<TeamState> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  /* v8 ignore next 2 -- the caller was located by captainSessionId already; this recheck is defensive */
  if (fresh.captainSessionId !== captainId) {
    throw new Error(`only the captain of team "${fresh.name}" may perform this operation`)
  }
  return fresh
}

/**
 * Fresh state and caller identity rechecked inside the lock.
 * @param stateRoot - the workspace's team-state root.
 * @param teamId - the team to re-read.
 * @param callerId - the calling session id.
 * @returns the fresh team record and the caller's re-derived identity.
 */
export async function freshParticipant(
  stateRoot: string,
  teamId: string,
  callerId: string,
): Promise<{ team: TeamState; identity: ParticipantIdentity }> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer an active participant in team "${fresh.name}"`)
  return { team: fresh, identity }
}

/**
 * Run one participant-scoped mutation under the team lock with fresh state.
 *
 * Every such mutation needs the same three facts at once — the caller still
 * belongs to the team, the record it acts on is current, and no other mutation
 * is between the read and the write — so the lock and the re-read travel
 * together and a caller cannot take one without the other.
 * @param stateRoot - the workspace's team-state root.
 * @param teamId - the team being mutated.
 * @param callerId - the calling session id.
 * @param fn - runs against the fresh record and the caller's re-derived identity.
 * @returns what `fn` returns.
 */
export async function withParticipant<T>(
  stateRoot: string,
  teamId: string,
  callerId: string,
  fn: (team: TeamState, identity: ParticipantIdentity) => Promise<T>,
): Promise<T> {
  return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const { team: fresh, identity } = await freshParticipant(stateRoot, teamId, callerId)
    return fn(fresh, identity)
  })
}
