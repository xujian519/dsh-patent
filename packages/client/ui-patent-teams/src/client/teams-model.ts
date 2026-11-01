/**
 * Pure fold of the nine `patent-teams/*` session-event kinds into per-team
 * records and UI projections — no React, no Context. Both the chat-card
 * Definition and the view-target Definition run this same reducer, so the
 * in-stream card and the Teams tab are two projections of one fold and can
 * never disagree.
 *
 * Payload types come from the host package's zero-import `event-types.ts`:
 * that file pulls no host `Context` augmentation, so the browser program can
 * load the `SessionEventMap` merge without colliding with the client
 * services.
 * @module dsh-client-ui-patent-teams/teams-model
 */
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationLocation, ConversationNodeDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-patent-teams/src/event-types.ts'

/** One folded team member (identity plus removal state). */
interface TeamsMemberState {
  readonly memberId: string
  readonly name: string
  readonly role?: string
  readonly removed: boolean
}

/** One folded task (creation facts plus the latest transition evidence). */
interface TeamsTaskState {
  readonly taskId: string
  readonly subject: string
  readonly dependencies: readonly string[]
  readonly assignee?: string
  /** Latest status reported by a `patent-teams/task-updated`; absent until the first update. */
  readonly status?: string
  /** Hard-contract fields the completion was reported missing. */
  readonly missingHardFields?: readonly string[]
  /** Whether a composite quality gate rejected the latest completion. */
  readonly gated: boolean
}

/** Per-team fold state accumulated from `team-created` onward. */
export interface TeamsTeamState {
  readonly teamId: string
  readonly name: string
  readonly description?: string
  readonly deleted: boolean
  readonly members: readonly TeamsMemberState[]
  readonly tasks: readonly TeamsTaskState[]
  readonly messageCount: number
  readonly activity: readonly TeamsActivityEntry[]
}

/** Kind of one capped recent-activity record kept for the Teams-tab feed. */
type TeamsActivityKind =
  | 'task-created'
  | 'task-updated'
  | 'task-validated'
  | 'task-gated'
  | 'message-sent'

/**
 * One recent task/message transition projected for the activity feed. Only
 * fields the kind carries are present; `subject` resolves from the folded
 * task when the event itself does not name it.
 */
export interface TeamsActivityEntry {
  readonly kind: TeamsActivityKind
  readonly seq: number
  readonly taskId?: string
  readonly subject?: string
  readonly status?: string
  readonly valid?: boolean
  readonly missingHardFields?: readonly string[]
  readonly from?: string
  readonly to?: string
}

/** Newest activity entries kept per team; older transitions age out. */
const TEAMS_ACTIVITY_LIMIT = 8

/**
 * Extract the owning team id from one event.
 * @param event - any session event (standard or compact history entry).
 * @returns the `teamId` when the event is one of the nine `patent-teams/*` kinds, else null.
 */
export function teamsEventTeamId(event: SessionEventLike): string | null {
  if (event.type === 'patent-teams/team-created') return event.data.teamId
  if (event.type === 'patent-teams/member-added') return event.data.teamId
  if (event.type === 'patent-teams/member-removed') return event.data.teamId
  if (event.type === 'patent-teams/task-created') return event.data.teamId
  if (event.type === 'patent-teams/task-updated') return event.data.teamId
  if (event.type === 'patent-teams/task-validated') return event.data.teamId
  if (event.type === 'patent-teams/task-gated') return event.data.teamId
  if (event.type === 'patent-teams/message-sent') return event.data.teamId
  if (event.type === 'patent-teams/team-deleted') return event.data.teamId
  return null
}

/** Team lifecycle as the UI projects it. */
export type PatentTeamsCardStatus = 'active' | 'completed' | 'deleted'

/** One member projected for both renderers. */
interface PatentTeamsCardMember {
  readonly memberId: string
  readonly name: string
  readonly role?: string
  readonly removed: boolean
}

/** One task projected for both renderers. */
export interface PatentTeamsCardTask {
  readonly taskId: string
  readonly subject: string
  readonly dependencies: readonly string[]
  readonly assignee?: string
  readonly status?: string
  readonly missingHardFields?: readonly string[]
  readonly gated: boolean
}

/** Final projection of one team for the chat card and the Teams tab. */
export interface PatentTeamsCardData {
  readonly teamId: string
  readonly name: string
  readonly description?: string
  readonly status: PatentTeamsCardStatus
  readonly members: readonly PatentTeamsCardMember[]
  readonly tasks: readonly PatentTeamsCardTask[]
  readonly completedTasks: number
  readonly messageCount: number
  /** Newest-first capped activity feed (the fold's latest transitions). */
  readonly activity: readonly TeamsActivityEntry[]
}

/**
 * Create the fold state from the unique `team-created` start event.
 * @param event - the start event payload source.
 * @returns the initial state.
 */
export function startTeamsState(event: SessionEventLike): TeamsTeamState {
  if (event.type !== 'patent-teams/team-created') {
    throw new Error('patent-teams start requires patent-teams/team-created')
  }
  return {
    teamId: event.data.teamId,
    name: event.data.name,
    ...event.data.description === undefined ? {} : { description: event.data.description },
    deleted: false,
    members: [],
    tasks: [],
    messageCount: 0,
    activity: [],
  }
}

/**
 * Append one activity entry to the capped newest-last feed.
 * @param state - current fold state.
 * @param entry - the resolved entry to record.
 * @returns the next state.
 */
function withActivity(state: TeamsTeamState, entry: TeamsActivityEntry): TeamsTeamState {
  return { ...state, activity: [...state.activity, entry].slice(-TEAMS_ACTIVITY_LIMIT) }
}

/**
 * Resolve the subject of one folded task.
 * @param state - current fold state.
 * @param taskId - the task id.
 * @returns the subject when the task record exists.
 */
function taskSubject(state: TeamsTeamState, taskId: string): string | undefined {
  return state.tasks.find(task => task.taskId === taskId)?.subject
}

/**
 * Apply one contract verdict: an invalid verdict records the missing fields,
 * a later valid verdict clears them (the latest verdict owns the task view).
 * @param task - current task state.
 * @param valid - whether the hard contract held.
 * @param missingHardFields - fields the invalid verdict reported missing.
 * @returns the next task state.
 */
function applyValidationVerdict(
  task: TeamsTaskState,
  valid: boolean,
  missingHardFields: readonly string[],
): TeamsTaskState {
  const { missingHardFields: _earlier, ...rest } = task
  return valid ? rest : { ...rest, missingHardFields }
}

/**
 * Apply one post-start team event in log order.
 * @param state - current fold state.
 * @param event - one of the nine team events (non-start kinds fall through unchanged).
 * @returns the next state.
 */
export function applyTeamsEvent(state: TeamsTeamState, event: SessionEventLike): TeamsTeamState {
  if (event.type === 'patent-teams/member-added') {
    return {
      ...state,
      members: [...state.members, {
        memberId: event.data.memberId,
        name: event.data.name,
        ...event.data.role === undefined ? {} : { role: event.data.role },
        removed: false,
      }],
    }
  }
  if (event.type === 'patent-teams/member-removed') {
    return {
      ...state,
      members: state.members.map(member => member.memberId === event.data.memberId
        ? { ...member, removed: true }
        : member),
    }
  }
  if (event.type === 'patent-teams/task-created') {
    return withActivity({
      ...state,
      tasks: [...state.tasks, {
        taskId: event.data.taskId,
        subject: event.data.subject,
        dependencies: event.data.dependencies,
        ...event.data.assignee === undefined ? {} : { assignee: event.data.assignee },
        gated: false,
      }],
    }, {
      kind: 'task-created',
      seq: event.seq,
      taskId: event.data.taskId,
      subject: event.data.subject,
    })
  }
  if (event.type === 'patent-teams/task-updated') {
    const subject = taskSubject(state, event.data.taskId)
    return withActivity({
      ...state,
      tasks: state.tasks.map(task => task.taskId === event.data.taskId
        ? {
          ...task,
          status: event.data.status,
          ...event.data.assignee === undefined ? {} : { assignee: event.data.assignee },
        }
        : task),
    }, {
      kind: 'task-updated',
      seq: event.seq,
      taskId: event.data.taskId,
      ...subject === undefined ? {} : { subject },
      status: event.data.status,
    })
  }
  if (event.type === 'patent-teams/task-validated') {
    const subject = taskSubject(state, event.data.taskId)
    return withActivity({
      ...state,
      tasks: state.tasks.map(task => task.taskId === event.data.taskId
        ? applyValidationVerdict(task, event.data.valid, event.data.missingHardFields)
        : task),
    }, {
      kind: 'task-validated',
      seq: event.seq,
      taskId: event.data.taskId,
      ...subject === undefined ? {} : { subject },
      valid: event.data.valid,
      ...event.data.valid ? {} : { missingHardFields: event.data.missingHardFields },
    })
  }
  if (event.type === 'patent-teams/task-gated') {
    const subject = taskSubject(state, event.data.taskId)
    return withActivity({
      ...state,
      tasks: state.tasks.map(task => task.taskId === event.data.taskId
        ? { ...task, gated: true }
        : task),
    }, {
      kind: 'task-gated',
      seq: event.seq,
      taskId: event.data.taskId,
      ...subject === undefined ? {} : { subject },
    })
  }
  if (event.type === 'patent-teams/message-sent') {
    return withActivity({ ...state, messageCount: state.messageCount + 1 }, {
      kind: 'message-sent',
      seq: event.seq,
      from: event.data.from,
      to: event.data.to,
    })
  }
  if (event.type === 'patent-teams/team-deleted') {
    return { ...state, deleted: true }
  }
  return state
}

/**
 * Project the fold state into renderer data.
 * @param state - current fold state.
 * @returns the card/tab projection.
 */
export function projectTeamsCard(state: TeamsTeamState): PatentTeamsCardData {
  const status: PatentTeamsCardStatus = state.deleted
    ? 'deleted'
    : state.tasks.length > 0 && state.tasks.every(task => task.status === 'completed')
      ? 'completed'
      : 'active'
  return {
    teamId: state.teamId,
    name: state.name,
    ...state.description === undefined ? {} : { description: state.description },
    status,
    members: state.members.map(member => ({
      memberId: member.memberId,
      name: member.name,
      ...member.role === undefined ? {} : { role: member.role },
      removed: member.removed,
    })),
    tasks: state.tasks.map(task => ({
      taskId: task.taskId,
      subject: task.subject,
      dependencies: task.dependencies,
      ...task.assignee === undefined ? {} : { assignee: task.assignee },
      ...task.status === undefined ? {} : { status: task.status },
      ...task.missingHardFields === undefined ? {} : { missingHardFields: task.missingHardFields },
      gated: task.gated,
    })),
    completedTasks: state.tasks.filter(task => task.status === 'completed').length,
    messageCount: state.messageCount,
    activity: [...state.activity].reverse(),
  }
}

/**
 * Build the shared Conversation Node Definition body over this fold: matching,
 * start, and update are identical for every target; only the kind, the view
 * target, and the node materialization differ per surface.
 * @param kind - Definition kind (also the keyed Chat kind for the chat target).
 * @param target - sole view target the Definition owns.
 * @param buildNode - materialize one target node from a started Context.
 * @returns the complete Definition.
 */
export function teamsNodeDefinition(
  kind: string,
  target: string,
  buildNode: (context: {
    readonly key: string
    readonly id: string
    readonly state: TeamsTeamState
    readonly anchorSeq: number
    readonly location: ConversationLocation
  }) => ConversationViewNode | null,
): ConversationNodeDefinition<TeamsTeamState> {
  return {
    kind,
    target,
    match: (event) => {
      const teamId = teamsEventTeamId(event)
      if (teamId === null) return null
      return { id: teamId, role: event.type === 'patent-teams/team-created' ? 'start' : 'update' }
    },
    start: (_context, match) => startTeamsState(match.event),
    update: (context, match) => applyTeamsEvent(context.state, match.event),
    buildViewNode: context => context.start === undefined
      ? null
      : buildNode({
        key: context.key,
        id: context.id,
        state: context.state as TeamsTeamState,
        anchorSeq: context.start.event.seq,
        location: context.start.location,
      }),
  }
}
