/**
 * Viewer-scoped status projection for `ctx.patentTeams.status`.
 *
 * The projection lives beside the Service Definition rather than inside it:
 * the service keeps the delegations and this module owns the mailbox paging
 * and task/member shaping. A captain sees a latest-message preview per member
 * and consumes only its own inbox; a member sees whole messages from its own
 * inbox in pages of ten, and only the page it was shown is acknowledged.
 * @module dsh-patent-teams/status-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { roleContract, workerDeliverables } from '@deepseek-ai/dsh-patent-workflow'
import { acknowledgeMailbox, readUnreadMailbox, withMailboxLease } from './mailbox.ts'
import { memberActivity } from './members.ts'
import type { TeamScheduler } from './scheduler.ts'
import { CAPTAIN_KEY } from './state.ts'
import { taskBase } from './task-view.ts'
import { freshParticipant, participantTeam } from './team-access.ts'
import { teamLockKey, withTeamLock } from './team-lock.ts'
import type { PatentTeamsMemberInbox, PatentTeamsStatus } from './service.ts'

/** Dependencies the status projection reads from the owning service. */
interface StatusViewHost {
  /** Plugin context: agent registry, logger, and event services. */
  readonly ctx: Context
  /** State directory name under the captain's workspace. */
  readonly stateDir: string
  /** Scheduler that may wake idle members before the snapshot is read. */
  readonly scheduler: TeamScheduler
  /** Live-delivery lease before a claimed mailbox message is retried. */
  readonly deliveryLeaseMs: number
}

/**
 * Summarize a member's role contract for the status payload: its stance and
 * the flat list of required deliverable fields across its workers.
 * @param role - the member's SKILL role id.
 * @returns the summary, or undefined when the role is not registered.
 */
function contractSummary(role: string): { stance: string; deliverables: string } | undefined {
  const contract = roleContract(role)
  if (contract === undefined) return undefined
  return { stance: contract.stance, deliverables: workerDeliverables(role) }
}

/**
 * Build the viewer-scoped team snapshot.
 * @param host - the owning service's context, state directory, and scheduler.
 * @param agent - the calling captain or member.
 * @param signal - caller cancellation, forwarded to scheduling and the team lock.
 * @returns the full status payload.
 */
export async function buildTeamStatus(
  host: StatusViewHost,
  agent: Agent,
  signal?: AbortSignal,
): Promise<PatentTeamsStatus> {
  const { workspace, stateRoot, team } = await participantTeam(agent, host.stateDir)
  if (team.captainSessionId === agent.id) {
    await host.scheduler.kickTeam(workspace, team.id, agent, signal, team)
  }
  const { team: fresh, identity } = await withTeamLock(
    teamLockKey(stateRoot, team.id),
    () => freshParticipant(stateRoot, team.id, agent.id),
  )
  const activity = await memberActivity(host.ctx, fresh.captainSessionId)
  const members = fresh.members
    .filter(member => member.status !== 'removed')
    .map((member) => {
      const summary = member.role === undefined || member.role === ''
        ? undefined
        : contractSummary(member.role)
      return {
        name: member.name,
        role: member.role ?? '',
        provider: member.provider ?? '',
        model: member.model ?? '',
        reasoning_effort: member.reasoningEffort ?? '',
        status: member.status,
        /* v8 ignore next -- durable state validation rejects empty member ids, so only the live-id branch is reachable */
        activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
        ...summary !== undefined ? { role_contract: summary } : {},
      }
    })
  const tasks = fresh.tasks.map(task => ({
    ...taskBase(task),
    attempt: task.attempt ?? 0,
    attempt_id: task.attemptId ?? '',
    reassigning: task.reassigning === true,
    ...task.output !== undefined ? { output: task.output } : {},
    ...task.worker !== undefined ? { worker: task.worker } : {},
    ...task.contractValidation !== undefined
      ? {
        contract_validation: {
          valid: task.contractValidation.valid,
          missing_hard_fields: task.contractValidation.missingHardFields,
          degraded: task.contractValidation.degraded,
        },
      }
      : {},
    ...task.gateFeedback !== undefined
      ? { gate_feedback: task.gateFeedback }
      : {},
    ...task.gateRejections !== undefined
      ? { gate_rejections: task.gateRejections }
      : {},
  }))
  const mailboxWarnings: string[] = []
  let mailboxWarningCount = 0
  const reportMalformed = (agentKey: string) => (lineNumber: number): void => {
    mailboxWarningCount += 1
    if (mailboxWarnings.length < 10) {
      mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`)
    }
  }
  const captainInbox = identity.kind === 'captain'
    ? await readUnreadMailbox(
      stateRoot,
      team.id,
      CAPTAIN_KEY,
      reportMalformed(CAPTAIN_KEY),
      host.deliveryLeaseMs,
    )
    : []
  const visibleCaptainInbox = captainInbox.slice(-10)
  const memberInboxes: Record<string, PatentTeamsMemberInbox> = {}
  let memberAcknowledged: string[] = []
  const visibleMembers = identity.kind === 'captain'
    ? members
    : members.filter(member => member.name === identity.name)
  for (const member of visibleMembers) {
    const messages = await readUnreadMailbox(
      stateRoot,
      team.id,
      member.name,
      reportMalformed(member.name),
      host.deliveryLeaseMs,
    )
    if (messages.length === 0) continue
    if (identity.kind === 'captain') {
      // The captain only previews a member's inbox; that member consumes it.
      memberInboxes[member.name] = {
        count: messages.length,
        omitted: messages.length - 1,
        /* v8 ignore next -- the empty-mailbox continue above guarantees a last message */
        latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
      }
      continue
    }
    // A member sees whole messages oldest-first and acknowledges exactly
    // those; any older page stays unread for the next status call.
    const visible = messages.slice(0, 10)
    memberAcknowledged = visible.map(message => message.id)
    memberInboxes[member.name] = {
      count: messages.length,
      omitted: messages.length - visible.length,
      messages: visible.map(message => ({
        from: message.from,
        content: message.content,
        ts: message.ts,
      })),
    }
  }
  const result = {
    team_id: team.id,
    team_name: team.name,
    description: team.description ?? '',
    viewer: identity.name,
    members,
    tasks,
    captain_inbox: visibleCaptainInbox.map(message => ({
      from: message.from,
      content: message.content,
      ts: message.ts,
    })),
    captain_inbox_omitted: captainInbox.length - visibleCaptainInbox.length,
    member_inboxes: memberInboxes,
    mailbox_warnings: mailboxWarnings,
    mailbox_warning_count: mailboxWarningCount,
  }
  const acknowledged = identity.kind === 'captain'
    ? visibleCaptainInbox.map(message => message.id)
    : memberAcknowledged
  if (acknowledged.length > 0) {
    await withMailboxLease(
      stateRoot,
      team.id,
      identity.kind === 'captain' ? CAPTAIN_KEY : identity.name,
      key => acknowledgeMailbox(stateRoot, team.id, key, acknowledged),
    )
  }
  return result
}
