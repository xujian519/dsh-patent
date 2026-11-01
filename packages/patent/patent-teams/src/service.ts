/**
 * Service Definition for the patent-team capability (ctx.patentTeams): a
 * captain-led durable team of continuable subagents with dependency-aware
 * tasks, mailbox messaging, and an event-driven shared-task scheduler.
 *
 * The service owns team state transitions (create/read/update/archive), the
 * task status machine with attempt revocation, member lifecycle (spawn,
 * interrupt, retire), mailbox persistence, and the scheduler kicks. The
 * `patent_teams_*` tools in this package are its sole Consumer; the member
 * spawn/fork provider is a configurable internal backend.
 * @module @deepseek-ai/dsh-patent-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import { PatentTeamsMessageId, PatentTeamsTeamId } from './ids.ts'
import {
  acknowledgeMailbox,
  appendMailbox,
  createMessage,
  releaseMailboxDelivery,
  withMailboxLease,
} from './mailbox.ts'
import {
  addMember as addMemberImpl,
  type AddMemberArgs,
  type AddMemberResult,
  type MemberOpsHost,
  removeMember as removeMemberImpl,
  type RemoveMemberResult,
} from './member-runtime.ts'
import { deliverToMember, interruptMember, waitForMemberIdle } from './members.ts'
import { installTeamScheduler, type TeamScheduler } from './scheduler.ts'
import { buildTeamStatus } from './status-view.ts'
import {
  archiveTeamDir,
  CAPTAIN_KEY,
  createTeamDir,
  findTeamByCaptain,
  listArchivedTeamIds,
  readArchivedTeam,
  readTeam,
  recordRetiredMemberIds,
  RESERVED_TEAM_IDS,
  revokeTaskAttempt,
  writeTeam,
} from './state.ts'
import {
  claimTask as claimTaskImpl,
  type ClaimTaskArgs,
  type ClaimTaskResult,
  createTask as createTaskImpl,
  type CreateTaskArgs,
  type CreateTaskResult,
  reassignTask as reassignTaskImpl,
  type ReassignTaskArgs,
  type ReassignTaskResult,
  type TaskOpsHost,
  updateTask as updateTaskImpl,
  type UpdateTaskArgs,
  type UpdateTaskResult,
} from './task-ops.ts'
import {
  captainTeam,
  freshCaptainTeam,
  participantTeam,
  requireMember,
  stateRootFor,
  withParticipant,
} from './team-access.ts'
import { TEAM_WAIT_MAX_MS, TEAM_WAIT_MIN_MS, TeamActivity } from './team-activity.ts'
import { taskBase } from './task-view.ts'
import { sanitizeKey, teamLockKey, withTeamLock } from './team-lock.ts'
import { PatentTeamsError, type TeamMessage, type TeamState } from './types.ts'

/** Resolved plugin config consumed by the service. */
export interface PatentTeamsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Member subagent provider name. */
  memberProvider: string
  /** Optional member model override. */
  memberModel?: string
  /** Member delegation depth cap. */
  memberMaxDepth?: number
  /** Team size cap (members). */
  maxMembers: number
  /** Run the composite quality gate on contract-backed task completion. */
  qualityGate: boolean
  /** Comprehensive-eval pass score threshold (0..1). */
  passThreshold: number
  /** Live-delivery lease before a claimed mailbox message is retried (ms). */
  mailboxDeliveryLeaseMs: number
}

/** The caller agent, or a loud failure for non-agent callers. */
function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('patent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/**
 * Deliver a durable member report at the captain's nearest model boundary.
 *
 * `Agent.steer()` targets the next step while the captain is running, wakes a
 * new turn when it is idle, and lets the Agent runtime reclassify an aborted
 * activity to `next-turn`. This prevents reports from waiting behind the
 * captain's entire orchestration turn.
 */
function steerCaptainReport(
  captain: Pick<Agent, 'steer'>,
  from: string,
  senderSessionId: string,
  content: string,
): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: `PatentTeams message from member ${from}:\n\n${content}` }],
      source: { kind: 'patent-teams-report', form: 'relay', from, senderSessionId },
    }))
    return true
  } catch {
    // The plugin mailbox was persisted before this best-effort live delivery.
    return false
  }
}

/**
 * The durable team capability service.
 *
 * One captain leads one active team at a time; every mutation runs inside the
 * per-team in-process lock and is persisted atomically before any notification
 * fires. Members are continuable subagents whose durable session ids are
 * recorded in the team file, so a team survives harness restarts.
 */
export class PatentTeamsService extends Service {
  private readonly config: PatentTeamsConfig
  private readonly scheduler: TeamScheduler
  private readonly activity = new TeamActivity()
  private readonly tasks: TaskOpsHost
  private readonly members: MemberOpsHost

  /**
   * @param ctx - the plugin context the service registers on.
   * @param config - the resolved plugin configuration.
   */
  constructor(ctx: Context, config: PatentTeamsConfig) {
    super(ctx, 'patentTeams')
    this.config = config
    this.scheduler = installTeamScheduler(ctx, {
      stateDir: config.stateDir,
      activity: this.activity,
      deliveryLeaseMs: config.mailboxDeliveryLeaseMs,
    })
    this.tasks = {
      ctx,
      stateDir: config.stateDir,
      scheduler: this.scheduler,
      activity: this.activity,
      qualityGate: config.qualityGate,
      passThreshold: config.passThreshold,
    }
    this.members = {
      ctx,
      stateDir: config.stateDir,
      memberProvider: config.memberProvider,
      ...config.memberModel === undefined ? {} : { memberModel: config.memberModel },
      ...config.memberMaxDepth === undefined ? {} : { memberMaxDepth: config.memberMaxDepth },
      maxMembers: config.maxMembers,
      scheduler: this.scheduler,
      activity: this.activity,
    }
    ctx.effect(() => () => { this.activity.close() })
  }

  /**
   * Create a team: the calling agent becomes its captain. A captain leads one
   * team at a time.
   * @param agent - the calling agent (the new captain).
   * @param name - team name, sanitized into the stable team id.
   * @param description - team purpose / goal.
   * @returns the created team's id, name, and state directory.
   */
  async create(agent: Agent, name: string, description?: string): Promise<{
    team_id: string
    team_name: string
    state_dir: string
  }> {
    const stateRoot = stateRootFor(agent, this.config.stateDir)
    const teamName = name.trim()
    if (teamName === '') throw new Error('team name must not be empty')
    const teamId = sanitizeKey(teamName)
    if (RESERVED_TEAM_IDS.has(teamId)) {
      throw new PatentTeamsError('TEAM_RESERVED_ID', `team id "${teamId}" is reserved for the archive directory — pick a different team name`)
    }
    const captainLockKey = `captain:${stateRoot}:${agent.id}`
    return withTeamLock(captainLockKey, async () => {
      const current = await findTeamByCaptain(stateRoot, agent.id)
      if (current !== undefined) {
        // v8 ignore next -- findTeamByCaptain matches the caller's own id, so the team is always its own
        const relationship = current.captainSessionId === agent.id ? 'lead' : 'belong to'
        throw new Error(`you already ${relationship} team "${current.name}" — end or leave it before creating another`)
      }
      return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
        const existing = await readTeam(stateRoot, teamId)
        if (existing !== undefined) {
          throw new Error(`team id "${teamId}" is taken by another captain — pick a different team name`)
        }
        // Archive directories are keyed by team id. Reusing a name would make
        // the next delete overwrite the previous generation, so a name stays
        // reserved once its team has been archived.
        if (await readArchivedTeam(stateRoot, teamId) !== undefined) {
          throw new PatentTeamsError(
            'TEAM_NAME_ARCHIVED',
            `team name "${teamName}" belongs to an archived team — pick a different team name; archived teams stay reviewable through patent_teams_archive`,
          )
        }
        const state: TeamState = {
          name: teamName,
          id: teamId,
          ...description === undefined ? {} : { description },
          captainSessionId: agent.id,
          createdAt: Date.now(),
          members: [],
          tasks: [],
          taskSeq: 0,
        }
        await createTeamDir(stateRoot, state)
        appendTeamEvent(this.ctx, agent.session, 'patent-teams/team-created', {
          teamId: PatentTeamsTeamId(state.id),
          captainSessionId: agent.id,
          name: state.name,
          ...state.description !== undefined ? { description: state.description } : {},
        })
        return { team_id: state.id, team_name: state.name, state_dir: join(stateRoot, state.id) }
      })
    })
  }

  /**
   * Add a durable continuable member. By default it snapshots the captain's
   * current LLM route and effort; supply provider/model only for an explicitly
   * requested role-specific route. The route resolution and the child spawn
   * run outside the team lock so one add never stalls the team's other tools;
   * admission and persistence revalidate inside the lock, and a spawn that
   * loses a concurrent race is retired before its failure surfaces.
   * @param agent - the calling captain.
   * @param args - member name, role, optional route/effort.
   * @param signal - caller cancellation, forwarded to the spawn.
   * @returns the created member's identity.
   */
  async addMember(
    agent: Agent,
    args: AddMemberArgs,
    signal: AbortSignal,
  ): Promise<AddMemberResult> {
    return addMemberImpl(this.members, agent, args, signal)
  }

  /**
   * Remove a member safely: revoke its current attempts, return all unfinished
   * owned tasks to the shared pending pool, interrupt its live turn, and mark
   * it removed.
   * @param agent - the calling captain.
   * @param name - member name to remove.
   * @param signal - caller cancellation, forwarded to quiescence waits.
   * @returns the removed member and requeued task ids.
   */
  async removeMember(agent: Agent, name: string, signal: AbortSignal): Promise<RemoveMemberResult> {
    return removeMemberImpl(this.members, agent, name, signal)
  }

  /**
   * Create a task in the team's task list. Tasks can depend on other tasks;
   * a task is only claimable once every dependency is completed.
   * @param agent - the calling captain.
   * @param args - subject, description, dependencies, optional assignee.
   * @param signal - caller cancellation, forwarded to scheduling.
   * @returns the created task's identity.
   */
  async createTask(
    agent: Agent,
    args: CreateTaskArgs,
    signal?: AbortSignal,
  ): Promise<CreateTaskResult> {
    return createTaskImpl(this.tasks, agent, args, signal)
  }

  /**
   * Atomically retry, reassign, or let the captain take over any unfinished or
   * failed task. The old attempt is revoked before its member is interrupted,
   * so late updates cannot overwrite the new owner.
   * @param agent - the calling captain.
   * @param args - task id, target assignee ("captain" for takeover), reason.
   * @param signal - caller cancellation, forwarded to quiescence waits.
   * @returns the task's post-handoff state.
   */
  async reassignTask(
    agent: Agent,
    args: ReassignTaskArgs,
    signal: AbortSignal,
  ): Promise<ReassignTaskResult> {
    return reassignTaskImpl(this.tasks, agent, args, signal)
  }

  /**
   * Claim one ready task for a member (or yourself). A member cannot own a
   * second unfinished task. The returned attempt_id is required for that
   * member's updates and becomes stale after retry/reassignment.
   * @param agent - the calling captain or member.
   * @param args - task id, optional assignee (captain only).
   * @returns the claimed task's capability.
   */
  async claimTask(
    agent: Agent,
    args: ClaimTaskArgs,
  ): Promise<ClaimTaskResult> {
    return claimTaskImpl(this.tasks, agent, args)
  }

  /**
   * Update a task status/output. Members must supply the current attempt_id
   * returned by claim_task; stale attempts are rejected after takeover or
   * reassignment. Terminal results are immutable.
   * @param agent - the calling captain or member.
   * @param args - task id, status, output, attempt_id.
   * @param signal - caller cancellation, forwarded to scheduling.
   * @returns the task's updated state.
   */
  async updateTask(
    agent: Agent,
    args: UpdateTaskArgs,
    signal?: AbortSignal,
  ): Promise<UpdateTaskResult> {
    return updateTaskImpl(this.tasks, agent, args, signal)
  }

  /**
   * Send a message to the captain or to a teammate. Messages go straight into
   * the recipient's mailbox; when the recipient agent is online the service
   * also schedules live delivery.
   * @param agent - the calling captain or member.
   * @param args - recipient ("captain" or a member name), content, optional from.
   * @param signal - caller cancellation, forwarded to live delivery.
   * @returns the message identity and delivery path.
   */
  async sendMessage(
    agent: Agent,
    args: { to: string; content: string; from?: string },
    signal: AbortSignal,
  ): Promise<{
    message_id: string
    from: string
    to: string
    delivered: 'live' | 'wake' | 'mailbox'
  }> {
    const { stateRoot, team } = await participantTeam(agent, this.config.stateDir)
    const to = args.to.trim()
    const prepared = await withParticipant(stateRoot, team.id, agent.id, async (fresh, identity) => {
      const from = identity.name
      // `from` may only be the caller's own identity: impersonating another
      // member (or the captain) would poison the mailbox and event records.
      if (args.from !== undefined && args.from !== from) {
        throw new Error(`patent_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`)
      }
      if (to === CAPTAIN_KEY) {
        const message = { ...createMessage(from, CAPTAIN_KEY, args.content), deliveryClaimedAt: Date.now() }
        await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message)
        recordMessageSent(this.ctx, fresh, agent, message, from, CAPTAIN_KEY)
        this.activity.notify(fresh.id)
        return { kind: 'captain' as const, fresh, identity, message, from }
      }
      const recipient = requireMember(fresh, to)
      const message = { ...createMessage(from, recipient.name, args.content), deliveryClaimedAt: Date.now() }
      await appendMailbox(stateRoot, fresh.id, recipient.name, message)
      recordMessageSent(this.ctx, fresh, agent, message, from, recipient.name)
      this.activity.notify(fresh.id)
      return { kind: 'member' as const, fresh, identity, message, from, recipient }
    })

    // Resolve the exact live captain only after releasing the state lock.
    // The mailbox is already durable if live delivery cannot proceed.
    const captain = this.ctx.get('agents')?.get(prepared.fresh.captainSessionId as SessionId)
    if (prepared.kind === 'captain') {
      let delivered: 'live' | 'mailbox' = 'mailbox'
      if (captain !== undefined && prepared.identity.kind === 'member') {
        delivered = steerCaptainReport(captain, prepared.from, prepared.identity.sessionId, args.content) ? 'live' : 'mailbox'
      }
      if (delivered === 'live') {
        await withMailboxLease(stateRoot, prepared.fresh.id, CAPTAIN_KEY, key => (
          acknowledgeMailbox(stateRoot, prepared.fresh.id, key, [prepared.message.id])
        ))
      } else {
        await withMailboxLease(stateRoot, prepared.fresh.id, CAPTAIN_KEY, key => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, key, [prepared.message.id])
        ))
      }
      return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered }
    }
    let delivered: 'wake' | 'mailbox' = 'mailbox'
    // v8 ignore next 2 -- a live member recipient always has a spawned id
    if (captain !== undefined && prepared.recipient.id !== '') {
      const senderText = prepared.from === CAPTAIN_KEY
        ? args.content
        : `Message from team member ${prepared.from}:\n\n${args.content}`
      const text = `PatentTeams state policy: inspect ${this.config.stateDir}/${prepared.fresh.id}/ read-only; never edit team.json or inbox files directly. Use patent_teams_* tools for team state.\n\n${senderText}`
      const accepted = await deliverToMember(this.ctx, captain, prepared.recipient.id, text, signal)
      delivered = accepted ? 'wake' : 'mailbox'
      if (accepted) {
        await withMailboxLease(stateRoot, prepared.fresh.id, prepared.recipient.name, key => (
          acknowledgeMailbox(stateRoot, prepared.fresh.id, key, [prepared.message.id])
        ))
      }
    }
    if (delivered === 'mailbox') {
      await withMailboxLease(stateRoot, prepared.fresh.id, prepared.recipient.name, key => (
        releaseMailboxDelivery(stateRoot, prepared.fresh.id, key, [prepared.message.id])
      ))
    }
    return {
      message_id: prepared.message.id,
      from: prepared.from,
      to: prepared.recipient.name,
      delivered,
    }
  }

  /**
   * Wait for the team's next committed change: a task transition, a mailbox
   * delivery, a roster change, or a member status edge. The captain leads by
   * waiting on work instead of polling for it. A wait observes announcements
   * only, so durable team state stays authoritative — re-read it after waking.
   * @param agent - the calling captain.
   * @param timeoutMs - bounded wait from {@link TEAM_WAIT_MIN_MS} through {@link TEAM_WAIT_MAX_MS}.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout rather than by a change.
   */
  async wait(agent: Agent, timeoutMs: number, signal: AbortSignal): Promise<{ timed_out: boolean }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TEAM_WAIT_MIN_MS || timeoutMs > TEAM_WAIT_MAX_MS) {
      throw new Error(`patent_teams_wait: timeout_ms must be an integer from ${TEAM_WAIT_MIN_MS} through ${TEAM_WAIT_MAX_MS}`)
    }
    const { team } = await captainTeam(agent, this.config.stateDir)
    const { timedOut } = await this.activity.wait(team.id, timeoutMs, signal)
    return { timed_out: timedOut }
  }

  /**
   * Team snapshot: members with live activity and tasks with status, assignee,
   * dependencies, and output. Captains also see every team mailbox; members
   * see only their own inbox. Reading as captain acknowledges the captain
   * inbox and schedules idle members.
   * @param agent - the calling captain or member.
   * @param signal - caller cancellation, forwarded to scheduling and the team lock.
   * @returns the full team status payload.
   */
  async status(agent: Agent, signal?: AbortSignal): Promise<PatentTeamsStatus> {
    return buildTeamStatus({
      ctx: this.ctx,
      stateDir: this.config.stateDir,
      scheduler: this.scheduler,
      deliveryLeaseMs: this.config.mailboxDeliveryLeaseMs,
    }, agent, signal)
  }

  /**
   * End the team: interrupt all members (best effort), archive the team's
   * state directory (team file, tasks, mailboxes) under `archive/`.
   * @param agent - the calling captain.
   * @param signal - caller cancellation, forwarded to quiescence waits.
   * @returns whether the team was archived.
   */
  async delete(agent: Agent, signal: AbortSignal): Promise<{ deleted: boolean; team_name: string }> {
    const { stateRoot, team } = await captainTeam(agent, this.config.stateDir)
    const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
      const fresh = await freshCaptainTeam(stateRoot, team.id, agent.id)
      // Include previously removed members so deleting a pre-fix team also
      // retires durable catalog entries left behind by removeMember.
      const roster = fresh.members.map(member => ({ ...member }))
      for (const member of fresh.members) {
        if (member.status === 'removed') continue
        member.status = 'removed'
      }
      // The archive keeps each task's lifecycle state and result, but no task
      // may retain a live capability: a late update must fail after closure.
      for (const task of fresh.tasks) revokeTaskAttempt(task)
      await writeTeam(stateRoot, fresh)
      return roster
    })
    await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
    for (const member of members) {
      this.scheduler.untrackMember(member.id)
    }
    // v8 ignore start -- every persisted member was spawned, so ids are never empty
    for (const member of members) {
      if (member.id === '') continue
      interruptMember(this.ctx, agent, member.id)
    }
    // v8 ignore stop
    const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(this.ctx, member, signal)))
    for (const result of quiescence) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn(`patent-teams: member did not quiesce cleanly before team archive: ${String(result.reason)}`)
      }
    }
    await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
      const fresh = await freshCaptainTeam(stateRoot, team.id, agent.id)
      appendTeamEvent(this.ctx, captainSessionOf(this.ctx, SessionId(fresh.captainSessionId), agent.session), 'patent-teams/team-deleted', {
        teamId: PatentTeamsTeamId(fresh.id),
      })
      // Archive, not delete: tasks (with their dependency graph) and the
      // mailboxes stay on disk for later review and dependency rebuilds.
      await archiveTeamDir(stateRoot, fresh.id)
    })
    return { deleted: true, team_name: team.name }
  }

  /**
   * Read this workspace's archived teams: one team's full record in detail,
   * or a summary row per archived team. Archived records are immutable after
   * {@link PatentTeamsService.delete}; this method only reads them.
   * @param agent - any calling agent in the workspace (the archive is workspace-scoped).
   * @param teamId - optional archived team id to show in detail.
   * @returns the archive listing, or the one team's detail record.
   */
  async archive(agent: Agent, teamId?: string): Promise<PatentTeamsArchive> {
    const stateRoot = stateRootFor(agent, this.config.stateDir)
    if (teamId !== undefined) {
      const team = await readArchivedTeam(stateRoot, teamId)
      if (team === undefined) {
        const available = (await listArchivedTeamIds(stateRoot)).join(', ') || 'none'
        throw new Error(`no archived team "${teamId}" in this workspace — archived teams: ${available}`)
      }
      return {
        mode: 'detail',
        team: {
          team_id: team.id,
          team_name: team.name,
          created_at: team.createdAt,
          ...team.description !== undefined ? { description: team.description } : {},
          members: team.members.map(member => ({
            name: member.name,
            role: member.role ?? '',
          })),
          tasks: team.tasks.map(task => ({
            ...taskBase(task),
            ...task.output !== undefined ? { output: task.output } : {},
          })),
        },
      }
    }
    const teams: PatentTeamsArchiveSummary[] = []
    for (const archivedId of await listArchivedTeamIds(stateRoot)) {
      const team = await readArchivedTeam(stateRoot, archivedId)
      if (team === undefined) continue
      teams.push({
        team_id: team.id,
        team_name: team.name,
        created_at: team.createdAt,
        members: team.members.length,
        tasks: team.tasks.length,
        completed_tasks: team.tasks.filter(task => task.status === 'completed').length,
      })
    }
    return { mode: 'list', teams }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    patentTeams: PatentTeamsService
  }
}

/** One member row of the status payload. */
export interface PatentTeamsStatusMember {
  name: string
  role: string
  provider: string
  model: string
  reasoning_effort: string
  status: string
  activity: string
  /** Role contract summary (stance + required deliverables) when the member carries a known role. */
  role_contract?: { stance: string; deliverables: string }
}

/** One task row of the status payload. */
export interface PatentTeamsStatusTask {
  id: string
  subject: string
  status: string
  assignee: string
  dependencies: string[]
  attempt: number
  attempt_id: string
  reassigning: boolean
  output?: string
  /** Optional worker contract the task output is validated against. */
  worker?: string
  /** Recorded contract verdict when the task completed with a worker. */
  contract_validation?: { valid: boolean; missing_hard_fields: string[]; degraded: boolean }
  /** Quality-gate verdict when a completion was bounced back for rework. */
  gate_feedback?: { score: number; satisfied: boolean; failures: string[]; feedback: string }
  /** Running count of gate rejections on this task; absent until the first rejection. */
  gate_rejections?: number
}

/** One captain-inbox preview row. */
export interface PatentTeamsStatusMessage {
  from: string
  content: string
  ts: number
}

/** One member-inbox view: a captain preview or the member's own full page. */
export interface PatentTeamsMemberInbox {
  /** Total unread messages in this mailbox. */
  count: number
  /** Unread messages not included in this view. */
  omitted: number
  /** Latest-message preview in a captain's cross-member view. */
  latest?: string
  /** Full unread messages, oldest first, in the member's own view. */
  messages?: PatentTeamsStatusMessage[]
}

/** The full status payload returned by {@link PatentTeamsService.status}. */
export interface PatentTeamsStatus {
  team_id: string
  team_name: string
  description: string
  viewer: string
  members: PatentTeamsStatusMember[]
  tasks: PatentTeamsStatusTask[]
  captain_inbox: PatentTeamsStatusMessage[]
  /** Unread captain messages older than the shown page. */
  captain_inbox_omitted: number
  member_inboxes: Record<string, PatentTeamsMemberInbox>
  mailbox_warnings: string[]
  mailbox_warning_count: number
}

/** One archived-team summary row. */
export interface PatentTeamsArchiveSummary {
  team_id: string
  team_name: string
  created_at: number
  members: number
  tasks: number
  completed_tasks: number
}

/** One archived team's detail record (members and tasks as archived). */
export interface PatentTeamsArchiveDetail {
  team_id: string
  team_name: string
  created_at: number
  description?: string
  members: { name: string; role: string }[]
  tasks: { id: string; subject: string; status: string; assignee: string; dependencies: string[]; output?: string }[]
}

/** The payload returned by {@link PatentTeamsService.archive}: the listing or one team's detail. */
export type PatentTeamsArchive =
  | { mode: 'list'; teams: PatentTeamsArchiveSummary[] }
  | { mode: 'detail'; team: PatentTeamsArchiveDetail }

/**
 * Append the durable message-sent event for one outbound mailbox write.
 * @param ctx - the plugin context carrying the event log.
 * @param team - the team the message belongs to.
 * @param agent - the sending agent.
 * @param message - the persisted message record.
 * @param from - the sender's team key.
 * @param to - the recipient's team key.
 */
function recordMessageSent(
  ctx: Context,
  team: TeamState,
  agent: Agent,
  message: TeamMessage,
  from: string,
  to: string,
): void {
  appendTeamEvent(
    ctx,
    captainSessionOf(ctx, SessionId(team.captainSessionId), agent.session),
    'patent-teams/message-sent',
    {
      teamId: PatentTeamsTeamId(team.id),
      messageId: PatentTeamsMessageId(message.id),
      from,
      to,
      content: message.content,
      ts: message.ts,
    },
  )
}

/**
 * The calling agent from a tool exec, for the tools Consumer.
 * @param exec - the tool run context of the calling agent.
 * @returns the calling agent.
 */
export function callingAgent(exec: ToolRunContext): Agent {
  return requireAgent(exec)
}
