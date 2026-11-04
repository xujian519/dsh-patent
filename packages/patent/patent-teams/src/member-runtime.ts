/**
 * Team-side member lifecycle: admit a member and retire one.
 *
 * A member is a durable continuable subagent whose session id is recorded in
 * the team file. Both operations run their slow half (route resolution, child
 * spawn, interrupt, quiescence) outside the team lock so one member operation
 * never stalls the team's other tools, and revalidate admission and persistence
 * inside the lock so a concurrent race loses cleanly.
 * @module dsh-patent-teams/member-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { roleContract } from '@deepseek-ai/dsh-patent-workflow'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import { PatentTeamsTeamId } from './ids.ts'
import {
  interruptMember,
  resolveMemberLlmSelection,
  spawnMember,
  waitForMemberIdle,
  type MemberRuntimeConfig,
} from './members.ts'
import { kickAfterPersist, type TeamScheduler } from './scheduler.ts'
import { CAPTAIN_KEY, invalidateTaskAttempt, recordRetiredMemberIds, writeTeam } from './state.ts'
import { captainTeam, freshCaptainTeam, requireAddableMember, requireMember } from './team-access.ts'
import type { TeamActivity } from './team-activity.ts'
import { sanitizeKey, teamLockKey, withTeamLock } from './team-lock.ts'
import type { TeamMember, TeamState } from './types.ts'

/**
 * The service-side dependencies the member lifecycle operations run against.
 *
 * The owning service projects its resolved configuration into these fields, so
 * this module reads only the knobs a member operation actually consults.
 */
export interface MemberOpsHost {
  /** Plugin context: event records, the agent registry, and the subagent provider. */
  readonly ctx: Context
  /** State directory name under the captain's workspace. */
  readonly stateDir: string
  /** Member subagent provider name. */
  readonly memberProvider: string
  /** Optional member model override. */
  readonly memberModel?: string
  /** Member delegation depth cap. */
  readonly memberMaxDepth?: number
  /** Team size cap (members). */
  readonly maxMembers: number
  /** Scheduler that dispatches work the roster change leaves ready. */
  readonly scheduler: TeamScheduler
  /** Waiter registry woken after each committed roster change. */
  readonly activity: TeamActivity
}

/** Arguments of one `patent_teams_add_member` call. */
export interface AddMemberArgs {
  name: string
  role?: string
  provider?: string
  model?: string
  reasoning_effort?: string
}

/** The new member's identity and the route it was spawned on. */
export interface AddMemberResult {
  member_name: string
  member_id: string
  provider: string
  model: string
  reasoning_effort?: string
  status: string
}

/** The outcome of removing one member. */
export interface RemoveMemberResult {
  member_name: string
  status: string
  requeued_tasks: string[]
}

/** The admission one spawn must prove again before its roster write lands. */
interface MemberAdmission {
  /** Caller-supplied name, for error text. */
  rawName: string
  /** Sanitized member key. */
  memberKey: string
  /** Configured team size cap. */
  maxMembers: number
  /** Role id the member will carry, when the captain supplied one. */
  role?: string
}

/**
 * Re-read fresh team state and re-validate that this name may still be added.
 *
 * Admission runs before the spawn and again before the persist, so a
 * concurrent winner is still rejected after its loser has already spawned.
 * @param stateRoot - the workspace's team-state root.
 * @param teamId - the team being mutated.
 * @param captainId - the calling captain's session id.
 * @param admission - the name and cap this add must satisfy.
 * @returns the fresh team record.
 */
async function freshAdmitted(
  stateRoot: string,
  teamId: string,
  captainId: string,
  admission: MemberAdmission,
): Promise<TeamState> {
  const fresh = await freshCaptainTeam(stateRoot, teamId, captainId)
  requireAddableMember(fresh, admission.rawName, admission.memberKey, admission.maxMembers, admission.role)
  return fresh
}

/**
 * Add a durable continuable member. By default it snapshots the captain's
 * current LLM route and effort; supply provider/model only for an explicitly
 * requested role-specific route. The route resolution and the child spawn
 * run outside the team lock so one add never stalls the team's other tools;
 * admission and persistence revalidate inside the lock, and a spawn that
 * loses a concurrent race is retired before its failure surfaces.
 * @param host - the owning service's member-lifecycle dependencies.
 * @param agent - the calling captain.
 * @param args - member name, role, optional route/effort.
 * @param signal - caller cancellation, forwarded to the spawn.
 * @returns the created member's identity.
 */
export async function addMember(
  host: MemberOpsHost,
  agent: Agent,
  args: AddMemberArgs,
  signal: AbortSignal,
): Promise<AddMemberResult> {
  const { workspace, stateRoot, team } = await captainTeam(agent, host.stateDir)
  const memberName = args.name.trim()
  if (memberName === '') throw new Error('member name must not be empty')
  const memberKey = sanitizeKey(memberName)
  if (memberKey === CAPTAIN_KEY) {
    throw new Error(`member name "${args.name}" is reserved for the captain`)
  }
  const admission: MemberAdmission = {
    rawName: args.name,
    memberKey,
    maxMembers: host.maxMembers,
    ...args.role === undefined ? {} : { role: args.role },
  }
  // Read-only spawn view: the persona reads immutable team identity; a
  // concurrent task change can only stale the welcome's task count.
  const snapshot = await withTeamLock(
    teamLockKey(stateRoot, team.id),
    () => freshAdmitted(stateRoot, team.id, agent.id, admission),
  )
  const selection = await resolveMemberLlmSelection(host.ctx, agent, {
    ...args.provider === undefined ? {} : { provider: args.provider },
    ...args.model === undefined ? {} : { model: args.model },
    ...host.memberModel === undefined ? {} : { defaultModel: host.memberModel },
    ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort },
  }, signal)
  const member: TeamMember = {
    id: '',
    name: memberName,
    ...args.role === undefined ? {} : { role: args.role },
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    joinedAt: Date.now(),
    status: 'idle',
  }
  const memberContract = args.role === undefined ? undefined : roleContract(args.role)
  await spawnMember(
    host.ctx,
    memberRuntime(host),
    selection,
    agent,
    snapshot,
    member,
    host.stateDir,
    signal,
    memberContract,
  )
  let created: AddMemberResult
  try {
    created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
      const fresh = await freshAdmitted(stateRoot, team.id, agent.id, admission)
      fresh.members.push(member)
      await writeTeam(stateRoot, fresh)
      appendTeamEvent(host.ctx, captainSessionOf(host.ctx, SessionId(fresh.captainSessionId), agent.session), 'patent-teams/member-added', {
        teamId: PatentTeamsTeamId(fresh.id),
        memberId: SessionId(member.id),
        name: member.name,
        ...member.role !== undefined ? { role: member.role } : {},
      })
      host.activity.notify(fresh.id)
      return {
        member_name: member.name,
        member_id: member.id,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: selection.reasoningEffort },
        status: member.status,
      }
    })
  } catch (error: unknown) {
    // v8 ignore next -- spawnMember fills the id before this lock is entered
    if (member.id !== '') {
      // The continuable child is already live, but the durable team record
      // never saw it: every throwing statement inside the lock callback
      // precedes writeTeam (appendTeamEvent contains its own failure
      // handling), so reaching this catch means the persist never landed.
      // Retire the orphan so it disappears from subagent listings and
      // cannot be resumed, then surface the failure.
      await recordRetiredMemberIds(stateRoot, [member.id]).catch(() => undefined)
      interruptMember(host.ctx, agent, member.id)
    }
    throw error
  }
  host.scheduler.trackMember(member.id, team.id, member.name)
  await kickAfterPersist(host.ctx, `dispatch after adding member ${created.member_name}`, () =>
    host.scheduler.kickMember(workspace, team.id, created.member_name, agent, signal))
  return created
}

/**
 * Remove a member safely: revoke its current attempts, return all unfinished
 * owned tasks to the shared pending pool, interrupt its live turn, and mark
 * it removed.
 * @param host - the owning service's member-lifecycle dependencies.
 * @param agent - the calling captain.
 * @param name - member name to remove.
 * @param signal - caller cancellation, forwarded to quiescence waits.
 * @returns the removed member and requeued task ids.
 */
export async function removeMember(
  host: MemberOpsHost,
  agent: Agent,
  name: string,
  signal: AbortSignal,
): Promise<RemoveMemberResult> {
  const { workspace, stateRoot, team } = await captainTeam(agent, host.stateDir)
  const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
    const fresh = await freshCaptainTeam(stateRoot, team.id, agent.id)
    const member = requireMember(fresh, name)
    const requeued: string[] = []
    for (const task of fresh.tasks) {
      if (task.assignee !== member.name || task.status === 'completed') continue
      invalidateTaskAttempt(task)
      task.reassigning = false
      requeued.push(task.id)
    }
    member.status = 'removed'
    await writeTeam(stateRoot, fresh)
    appendTeamEvent(host.ctx, captainSessionOf(host.ctx, SessionId(fresh.captainSessionId), agent.session), 'patent-teams/member-removed', {
      teamId: PatentTeamsTeamId(fresh.id),
      memberId: SessionId(member.id),
    })
    host.activity.notify(fresh.id)
    return { member: { ...member }, requeued }
  })
  // v8 ignore next -- every persisted member was spawned, so the id is never empty
  if (revoked.member.id !== '') {
    host.scheduler.untrackMember(revoked.member.id)
    await recordRetiredMemberIds(stateRoot, [revoked.member.id])
    interruptMember(host.ctx, agent, revoked.member.id)
    await waitForMemberIdle(host.ctx, revoked.member, signal)
  }
  await kickAfterPersist(host.ctx, `dispatch after removing member ${revoked.member.name}`, () =>
    host.scheduler.kickTeam(workspace, team.id, agent, signal))
  return {
    member_name: revoked.member.name,
    status: revoked.member.status,
    requeued_tasks: revoked.requeued,
  }
}

/**
 * Build the member runtime knobs handed to member helpers.
 * @param host - the owning service's member-lifecycle dependencies.
 * @returns the provider and depth knobs the spawn consumes.
 */
function memberRuntime(host: MemberOpsHost): MemberRuntimeConfig {
  return {
    provider: host.memberProvider,
    ...host.memberMaxDepth === undefined ? {} : { maxDepth: host.memberMaxDepth },
  }
}
