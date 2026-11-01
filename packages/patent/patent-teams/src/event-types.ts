/**
 * PatentTeams session event types — pure types only, zero runtime imports.
 *
 * This file intentionally imports no runtime value: both the host program (the
 * emitter in `events.ts`) and the browser program (the Conversation Node
 * definition) must be able to load these types and the `SessionEventMap`
 * declaration merge without pulling in host-side `Context` augmentations
 * (dsh-session's index declares `Context.sessions: SessionStore`, which
 * collides with the browser runtime's `ISessions` under the same name).
 * @module dsh-patent-teams/event-types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PatentTeamsAttemptId,
  PatentTeamsMessageId,
  PatentTeamsTaskId,
  PatentTeamsTeamId,
} from './ids.ts'

/** Opens one team record: the captain created the team. */
export interface PatentTeamsTeamCreatedData {
  readonly teamId: PatentTeamsTeamId
  /** The captain session that owns this team (UI follows it). */
  readonly captainSessionId: SessionId
  readonly name: string
  readonly description?: string
}

/** Records one member after its continuable subagent is spawned. */
interface PatentTeamsMemberAddedData {
  readonly teamId: PatentTeamsTeamId
  /** The member's durable child session id. */
  readonly memberId: SessionId
  readonly name: string
  readonly role?: string
}

/** Marks one member removed. */
interface PatentTeamsMemberRemovedData {
  readonly teamId: PatentTeamsTeamId
  /** The member's durable child session id. */
  readonly memberId: SessionId
}

/** Records one task in the team's task list. */
export interface PatentTeamsTaskCreatedData {
  readonly teamId: PatentTeamsTeamId
  readonly taskId: PatentTeamsTaskId
  readonly subject: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  readonly dependencies: readonly PatentTeamsTaskId[]
  readonly assignee?: string
  /** The worker contract the task output is validated against, when set. */
  readonly worker?: string
}

/** Records one task status/assignee/output transition. */
interface PatentTeamsTaskUpdatedData {
  readonly teamId: PatentTeamsTeamId
  readonly taskId: PatentTeamsTaskId
  readonly status: string
  readonly assignee?: string
  readonly output?: string
  readonly attempt?: number
  readonly attemptId?: PatentTeamsAttemptId
}

/** Records a contract-validation verdict on a completed task. */
interface PatentTeamsTaskValidatedData {
  readonly teamId: PatentTeamsTeamId
  readonly taskId: PatentTeamsTaskId
  readonly worker: string
  readonly valid: boolean
  readonly missingHardFields: readonly string[]
  readonly degraded: boolean
}

/** Records a completion rejected by the composite quality gate. */
interface PatentTeamsTaskGatedData {
  readonly teamId: PatentTeamsTeamId
  readonly taskId: PatentTeamsTaskId
  readonly score: number
  readonly failures: readonly string[]
  readonly feedback: string
}

/** Closes one team record: the team was deleted. */
interface PatentTeamsTeamDeletedData {
  readonly teamId: PatentTeamsTeamId
}

/** Records one mailbox message sent between team agents. */
export interface PatentTeamsMessageSentData {
  readonly teamId: PatentTeamsTeamId
  readonly messageId: PatentTeamsMessageId
  /** `captain` or a member name. */
  readonly from: string
  /** `captain` or a member name. */
  readonly to: string
  readonly content: string
  readonly ts: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one team record.
     * @param data - stable team identity and display name.
     */
    'patent-teams/team-created': PatentTeamsTeamCreatedData
    /**
     * Records one team member.
     * @param data - team identity, member child session, and display identity.
     */
    'patent-teams/member-added': PatentTeamsMemberAddedData
    /**
     * Records one member removal.
     * @param data - team identity and the member's child session id.
     */
    'patent-teams/member-removed': PatentTeamsMemberRemovedData
    /**
     * Records one task creation.
     * @param data - team identity, task id, subject, dependencies, assignee, worker.
     */
    'patent-teams/task-created': PatentTeamsTaskCreatedData
    /**
     * Records one task transition.
     * @param data - team identity, task id, the new status/assignee/output, and the attempt identity.
     */
    'patent-teams/task-updated': PatentTeamsTaskUpdatedData
    /**
     * Records a contract-validation verdict on a completed task.
     * @param data - team identity, task id, worker, and the missing-field verdict.
     */
    'patent-teams/task-validated': PatentTeamsTaskValidatedData
    /**
     * Records a completion rejected by the composite quality gate.
     * @param data - team identity, task id, score, failing dimensions, and feedback.
     */
    'patent-teams/task-gated': PatentTeamsTaskGatedData
    /**
     * Records one mailbox message.
     * @param data - team identity, sender, recipient, and content.
     */
    'patent-teams/message-sent': PatentTeamsMessageSentData
    /**
     * Closes one team record after deletion.
     * @param data - stable team identity.
     */
    'patent-teams/team-deleted': PatentTeamsTeamDeletedData
  }
}

/** The full set of `patent-teams/*` event names. */
export type PatentTeamsEventType =
  | 'patent-teams/team-created'
  | 'patent-teams/member-added'
  | 'patent-teams/member-removed'
  | 'patent-teams/task-created'
  | 'patent-teams/task-updated'
  | 'patent-teams/task-validated'
  | 'patent-teams/task-gated'
  | 'patent-teams/message-sent'
  | 'patent-teams/team-deleted'
