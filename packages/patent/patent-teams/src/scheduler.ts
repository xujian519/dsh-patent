/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member.
 * @module dsh-patent-teams/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeMailbox,
  claimMailboxDelivery,
  readUnreadMailbox,
  releaseMailboxDelivery,
  withMailboxLease,
} from './mailbox.ts'
import { deliverToMember } from './members.ts'
import {
  beginTaskAttempt,
  findTeamByParticipant,
  readTeam,
  unsatisfiedDependencies,
  writeTeam,
} from './state.ts'
import { memberOpenTask } from './team-access.ts'

/**
 * Run a scheduler kick after durable state has already been committed.
 *
 * A dispatch failure must not turn the committed operation into a tool error:
 * the caller would retry and duplicate the entity (or hit "already exists").
 * The durable record is the source of truth; the next idle edge retries the
 * dispatch.
 * @param ctx - plugin context used for the warning.
 * @param operation - what the kick was dispatching, for the warning.
 * @param kick - the scheduler call.
 */
export async function kickAfterPersist(
  ctx: Context,
  operation: string,
  kick: () => Promise<void>,
): Promise<void> {
  try {
    await kick()
  } catch (error) {
    ctx.logger.warn(`patent-teams: ${operation} failed after the change was persisted: ${String(error)}`)
  }
}
import {
  serialize,
  stateRootOf,
  teamLockKey,
  withTeamLock,
} from './team-lock.ts'
import type { TeamActivity } from './team-activity.ts'
import type { TeamMember, TeamState, TeamTask } from './types.ts'

/** Scheduler configuration: where team state lives on disk. */
interface SchedulerConfig {
  readonly stateDir: string
  /** Waiter registry woken on every member status edge this scheduler mirrors. */
  readonly activity: TeamActivity
  /** Live-delivery lease before a claimed mailbox message is retried. */
  readonly deliveryLeaseMs: number
}

/** The team scheduler: serialized, ready-work dispatch to idle members. */
export interface TeamScheduler {
  /**
   * Try to give every genuinely idle/ready member one unit of ready work.
   * @param workspace - the team's workspace.
   * @param teamId - the team id.
   * @param captain - the live captain, when the caller already has it.
   * @param signal - caller cancellation.
   * @param snapshot - an already-read team record; the scheduler avoids a
   * second read and treats it as a best-effort dispatch hint.
   */
  kickTeam(
    workspace: string,
    teamId: string,
    captain?: Agent,
    signal?: AbortSignal,
    snapshot?: TeamState,
  ): Promise<void>
  /**
   * Try to flush fallback mail or give one member one ready task.
   * @param workspace - the team's workspace.
   * @param teamId - the team id.
   * @param memberName - the member to kick.
   * @param captain - the live captain, when the caller already has it.
   * @param signal - caller cancellation.
   * @param snapshot - an already-read team record; the claim path still
   * re-reads under the team lock before changing state.
   */
  kickMember(
    workspace: string,
    teamId: string,
    memberName: string,
    captain?: Agent,
    signal?: AbortSignal,
    snapshot?: TeamState,
  ): Promise<void>
  /**
   * Record a freshly persisted member so its status events skip the state
   * directory scan (spawning is the only way a live agent becomes a member).
   * @param memberId - the member's durable child session id.
   * @param teamId - the member's team id.
   * @param memberName - the member's display name.
   */
  trackMember(memberId: string, teamId: string, memberName: string): void
  /**
   * Drop a member's observer fast-path entry so its next event rescans.
   * @param memberId - the member's durable child session id.
   */
  untrackMember(memberId: string): void
}

interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly previousAssignee?: string
  readonly subject: string
  readonly description?: string
}

function liveCaptain(ctx: Context, captainSessionId: string, supplied?: Agent): Agent | undefined {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied
  return ctx.get('agents')?.get(captainSessionId as SessionId)
}

function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  const live = ctx.get('agents')?.get(member.id as SessionId)
  return live === undefined || live.status === 'idle'
}

function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  return ready.find(task => task.assignee === memberName)
    ?? ready.find(task => task.assignee === undefined)
}

/** Whether a snapshot shows any work the member could claim. */
function hasDispatchCandidate(team: TeamState, memberName: string): boolean {
  return memberOpenTask(team, memberName) !== undefined
    || nextReadyTask(team.tasks, memberName) !== undefined
}

function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  return `PatentTeams automatic task assignment from the shared task list.

Task: ${ticket.taskId} — ${ticket.subject}${description}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call patent_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every patent_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. Work only this task in this turn, report the result to the captain, then become idle so the scheduler can select your next ready task.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through patent_teams_* tools.`
}

function fallbackMailboxPrompt(messages: Awaited<ReturnType<typeof readUnreadMailbox>>): string {
  return [
    'PatentTeams delivered messages that were persisted while live delivery was unavailable:',
    ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
    '\nHandle these messages in this turn. Task assignments still require patent_teams_claim_task and the current attempt_id.',
  ].join('\n')
}

/**
 * Deliver a member's unread mailbox as its fallback work item. A mailbox-only
 * fallback is real pending work, so it is delivered before a fresh task, and
 * the claim is acknowledged only after the Harness accepts the follow-up. The
 * durable member record is re-read under the team lock so a stale team
 * snapshot cannot deliver to a member removed after the snapshot.
 * @param ctx - registrant context carrying the agent registry.
 * @param args - state root, team id, member, live captain, cancellation signal, and lease duration.
 * @returns whether the mailbox path handled this kick.
 */
async function deliverMailboxFallback(ctx: Context, args: {
  stateRoot: string
  teamId: string
  member: TeamMember
  captain: Agent
  signal: AbortSignal
  deliveryLeaseMs: number
}): Promise<boolean> {
  const { stateRoot, teamId, member, captain, signal, deliveryLeaseMs } = args
  const unread = await readUnreadMailbox(
    stateRoot,
    teamId,
    member.name,
    undefined,
    deliveryLeaseMs,
  )
  if (unread.length === 0) return false
  // The caller may hold a pre-removal team snapshot. Revalidate membership
  // under the same lock that claims the lease, so a member removed after the
  // snapshot cannot receive fallback mail from a stale kick.
  const claimedIds = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId)
    const current = fresh?.members.find(candidate => candidate.id === member.id
      && candidate.name === member.name
      && candidate.status !== 'removed')
    if (current === undefined) return undefined
    return claimMailboxDelivery(stateRoot, teamId, member.name, unread.map(message => message.id))
  })
  if (claimedIds === undefined || claimedIds.length === 0) return true
  // The snapshot may contain messages acknowledged after it was read; deliver
  // only the records the claim actually leased.
  const claimed = new Set(claimedIds)
  const messages = unread.filter(message => claimed.has(message.id))
  const accepted = await deliverToMember(
    ctx,
    captain,
    member.id,
    fallbackMailboxPrompt(messages),
    signal,
  )
  if (accepted) {
    await withMailboxLease(stateRoot, teamId, member.name, key => (
      acknowledgeMailbox(stateRoot, teamId, key, claimedIds)
    ))
  } else {
    await withMailboxLease(stateRoot, teamId, member.name, key => (
      releaseMailboxDelivery(stateRoot, teamId, key, claimedIds)
    ))
  }
  return true
}

/**
 * Claim one dispatch under the team lock, re-reading the team first: an
 * idle/ready member that still owns an open task lost the turn executing it
 * (model stopped early, interrupt settlement, or process restart), so that
 * task is retried with a fresh capability instead of being read as "busy".
 * @param ctx - registrant context carrying the agent registry.
 * @param args - state root, team id, and member name.
 * @returns the ticket, or undefined when no task is ready or the member is gone.
 */
async function claimDispatchTicket(ctx: Context, args: {
  stateRoot: string
  teamId: string
  memberName: string
}): Promise<DispatchTicket | undefined> {
  const { stateRoot, teamId, memberName } = args
  return withTeamLock(teamLockKey(stateRoot, teamId), async (): Promise<DispatchTicket | undefined> => {
    const fresh = await readTeam(stateRoot, teamId)
    if (fresh === undefined) return undefined
    const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
    if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)) return undefined
    const task = memberOpenTask(fresh, currentMember.name)
      ?? nextReadyTask(fresh.tasks, currentMember.name)
    if (task === undefined) {
      if (currentMember.status !== 'idle') {
        currentMember.status = 'idle'
        await writeTeam(stateRoot, fresh)
      }
      return undefined
    }
    const previousAssignee = task.assignee
    const attemptId = beginTaskAttempt(task, currentMember.name)
    currentMember.status = 'working'
    await writeTeam(stateRoot, fresh)
    return {
      taskId: task.id,
      memberName: currentMember.name,
      memberId: currentMember.id,
      // v8 ignore next -- beginTaskAttempt always sets attempt before the ticket is built
      attempt: task.attempt ?? 1,
      attemptId,
      ...previousAssignee === undefined ? {} : { previousAssignee },
      subject: task.subject,
      ...task.description === undefined ? {} : { description: task.description },
    }
  })
}

/**
 * Roll back a failed dispatch, and only that one: a concurrent captain handoff
 * has already changed the capability and wins, so the restore compares the
 * ticket's attempt id before touching the task.
 * @param args - state root, team id, and the failed ticket.
 */
async function rollbackFailedDispatch(args: {
  stateRoot: string
  teamId: string
  ticket: DispatchTicket
}): Promise<void> {
  const { stateRoot, teamId, ticket } = args
  await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
    const fresh = await readTeam(stateRoot, teamId)
    if (fresh === undefined) return
    const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
    if (task?.attemptId !== ticket.attemptId) return
    task.status = 'pending'
    if (ticket.previousAssignee === undefined) {
      delete task.assignee
    } else {
      task.assignee = ticket.previousAssignee
    }
    delete task.attemptId
    delete task.handoffId
    task.reassigning = false
    task.updatedAt = Date.now()
    const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
    if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
    await writeTeam(stateRoot, fresh)
  })
}

/**
 * Install one scheduler and its member activity observer.
 * @param ctx - registrant context carrying the agent registry.
 * @param config - the scheduler's state-directory configuration.
 * @returns the installed scheduler runtime.
 */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  /**
   * Observer fast path: agent session id → the team it works for. `null`
   * marks an agent already proven to captain or lie outside every team, so
   * its status events stop rescanning the whole state directory; only
   * `addMember` turns a live agent into a member, and it tracks itself.
   * Null entries insert only when no entry exists: a scan that started
   * before `addMember` persisted must resolve without clobbering the
   * positive entry the spawn path recorded, while the positive set always
   * overwrites a transient null.
   */
  const memberIndex = new Map<string, { teamId: string; memberName: string } | null>()

  const runtime: TeamScheduler = {
    async kickTeam(workspace, teamId, suppliedCaptain, signal, snapshot) {
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const team = snapshot ?? await readTeam(stateRoot, teamId)
      if (team === undefined) return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) return
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(workspace, teamId, member.name, captain, signal, team)
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain, signal, snapshot) {
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const queueKey = `${stateRoot}\u0000${teamId}\u0000${memberName}`
      await serialize(queueKey, async () => {
        const team = snapshot ?? await readTeam(stateRoot, teamId)
        if (team === undefined) return
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return
        const member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member)) return

        if (await deliverMailboxFallback(ctx, {
          stateRoot,
          teamId: team.id,
          member,
          captain,
          signal: signal ?? new AbortController().signal,
          deliveryLeaseMs: config.deliveryLeaseMs,
        })) return

        // The snapshot is enough to skip an idle member with no candidate;
        // the claim path re-reads under the team lock before changing state.
        if (member.status === 'idle' && !hasDispatchCandidate(team, memberName)) return

        const ticket = await claimDispatchTicket(ctx, { stateRoot, teamId: team.id, memberName })
        if (ticket === undefined) return

        const accepted = await deliverToMember(
          ctx,
          captain,
          ticket.memberId,
          assignmentPrompt(ticket, config.stateDir, team.id),
          signal ?? new AbortController().signal,
        )
        if (accepted) return

        await rollbackFailedDispatch({ stateRoot, teamId: team.id, ticket })
      })
    },

    trackMember(memberId, teamId, memberName) {
      memberIndex.set(memberId, { teamId, memberName })
    },

    untrackMember(memberId) {
      memberIndex.delete(memberId)
    },
  }

  /** Mirror one agent status edge into its member record and kick it idle. */
  const syncKnownMember = async (
    agent: Agent,
    status: AgentStatus,
    member: { teamId: string; memberName: string },
  ): Promise<void> => {
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config.stateDir)
    await withTeamLock(teamLockKey(stateRoot, member.teamId), async () => {
      const fresh = await readTeam(stateRoot, member.teamId)
      const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      const next = status === 'running' ? 'working' : 'idle'
      if (current.status === next) return
      current.status = next
      await writeTeam(stateRoot, fresh)
      config.activity.notify(fresh.id)
    })
    if (status === 'idle') await runtime.kickMember(workspace, member.teamId, member.memberName)
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const cached = memberIndex.get(agent.id)
    if (cached !== undefined) {
      if (cached !== null) await syncKnownMember(agent, status, cached)
      return
    }
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config.stateDir)
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located === undefined || located.captainSessionId === agent.id) {
      /* v8 ignore next -- a cached undefined entry only exists when the key is absent */
      if (!memberIndex.has(agent.id)) memberIndex.set(agent.id, null)
      return
    }
    /* v8 ignore start -- findTeamByParticipant only matches surviving members, so this guard and its return are defensive */
    const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) {
      if (!memberIndex.has(agent.id)) memberIndex.set(agent.id, null)
      return
    }
    /* v8 ignore stop */
    const entry = { teamId: located.id, memberName: member.name }
    memberIndex.set(agent.id, entry)
    await syncKnownMember(agent, status, entry)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`patent-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })

  return runtime
}
