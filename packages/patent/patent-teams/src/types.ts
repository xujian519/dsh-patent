/**
 * Durable PatentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-patent-teams/types
 */

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Stable failure codes for model-visible PatentTeams operations. */
type PatentTeamsErrorCode =
  | 'STALE_ATTEMPT'
  | 'ALREADY_CLAIMED'
  | 'OWNERSHIP_MISMATCH'
  | 'TASK_TERMINAL'
  | 'INVALID_TRANSITION'
  | 'DEPENDENCIES_OPEN'
  | 'WORKER_OUTPUT_REQUIRED'
  | 'WORKER_CONTRACT_UNKNOWN'
  | 'TEAM_RESERVED_ID'
  | 'TEAM_NAME_ARCHIVED'

/**
 * A PatentTeams operation failure with a stable machine-readable code.
 *
 * The message stays human-readable and carries the code suffix so a tool
 * result rendered as text still exposes the stable failure class.
 */
export class PatentTeamsError extends Error {
  /** Stable failure code. */
  readonly code: PatentTeamsErrorCode

  /**
   * @param code - stable failure code.
   * @param message - model-facing explanation.
   * @param options - optional wrapped cause.
   */
  constructor(code: PatentTeamsErrorCode, message: string, options?: ErrorOptions) {
    super(`${message} (code: ${code})`, options)
    this.name = 'PatentTeamsError'
    this.code = code
  }
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  /** Optional worker contract the task's output is validated against on completion. */
  worker?: string
  /** Recorded contract verdict when the task completes with a `worker` set. */
  contractValidation?: TaskContractValidation
  /** Quality-gate verdict recorded when a completion is rejected (soft; never blocks `completed`). */
  gateFeedback?: TaskGateFeedback
  /**
   * How many completion submissions the quality gate has rejected on this task.
   * A bounce keeps the attempt open, so this count is the task's only record of
   * repeated rework; it stays absent until the first rejection.
   */
  gateRejections?: number
  createdAt: number
  updatedAt: number
}

/** Contract validation verdict recorded at task completion (soft; never blocks `completed`). */
export interface TaskContractValidation {
  /** The worker contract the output was validated against. */
  worker: string
  /** Whether all hard required fields were present. */
  valid: boolean
  /** Hard-contract fields absent from the output. */
  missingHardFields: string[]
  /** Whether the output was marked degraded. */
  degraded: boolean
}

/**
 * Quality-gate verdict recorded when the composite gate rejects a completion.
 * The gate blocks the `completed` transition: the task stays `in_progress`/
 * `claimed` and the member revises then resubmits with the same `attempt_id`.
 */
export interface TaskGateFeedback {
  /** Comprehensive-eval score (0..1); advisory — the verdict is decided by `failures`, not the composite score alone. */
  score: number
  /** Whether every gate dimension passed. */
  satisfied: boolean
  /** Human-readable labels for the failing dimensions (e.g. `内容充分性(0.3)`). */
  failures: string[]
  /** Revisions suggested to the member, keyed to the failing dimensions. */
  feedback: string
}

/** Member lifecycle status. */
type MemberStatus = 'idle' | 'working' | 'removed'

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain or target model default. */
  reasoningEffort?: string
  joinedAt: number
  status: MemberStatus
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
}

/**
 * Source stamped on a member report delivered live into the captain's session.
 *
 * A report is one agent addressing another, so it declares the `relay` form
 * and the sender's durable subagent session id — the transcript renders the
 * sending session from that record rather than from the message text.
 */
interface PatentTeamsReportSource {
  readonly kind: 'patent-teams-report'
  readonly form: 'relay'
  /** Sending member's team display name. */
  readonly from: string
  /** Sending member's durable continuable subagent session id. */
  readonly senderSessionId: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Relayed member report; readers without this producer retain the recorded
     * content and every source property, while rendering the sending session
     * from `senderSessionId` stays producer-local.
     * @persistenceAttribution
     */
    'patent-teams-report': PatentTeamsReportSource
  }
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
}
