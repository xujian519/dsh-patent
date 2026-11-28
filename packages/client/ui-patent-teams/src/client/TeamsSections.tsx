/**
 * Shared member and task row lists, rendered by both the chat card and the
 * Teams tab. Pure presentation of one {@link PatentTeamsCardData}; live
 * member activity arrives as the set of member ids currently running.
 */
import type { ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PatentTeamsCardData, PatentTeamsCardStatus, PatentTeamsCardTask } from './teams-model.ts'
import type { PatentTeamsKey } from './locales.ts'
import css from './TeamsSections.module.css'

/** Locale key per team lifecycle status (shared by both renderers). */
export const STATUS_KEYS = {
  active: 'status.active',
  completed: 'status.completed',
  deleted: 'status.deleted',
} as const satisfies Record<PatentTeamsCardStatus, PatentTeamsKey>

/** Team-status dot semantics (shared by both renderers). */
export function teamDotState(status: PatentTeamsCardStatus): StateDotState {
  switch (status) {
    case 'active': return 'ongoing'
    case 'completed': return 'done'
    case 'deleted': return 'warning'
    /* v8 ignore next -- PatentTeamsCardStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** Translate function for this plugin's namespace. */
type Translate = PropsLocale<'patentTeams'>['t']

/** Member rows show activity through these three dots; idle shows no dot. */
function memberDot(running: boolean, removed: boolean): StateDotState | null {
  if (removed) return 'warning'
  if (running) return 'ongoing'
  return null
}

const TASK_DOTS: Record<string, StateDotState> = {
  claimed: 'ongoing',
  in_progress: 'ongoing',
  completed: 'done',
  failed: 'error',
  cancelled: 'warning',
}

/** Task rows color exactly the states with a clear semantic; pending and unknown stay plain. */
function taskDot(status: string | undefined): StateDotState | null {
  return status === undefined ? null : TASK_DOTS[status] ?? null
}

/** Locale label for one raw task status (shared by rows, the DAG, and the feed). */
export function statusLabel(status: string | undefined, t: Translate): string {
  switch (status) {
    case undefined: return t('task.noStatus')
    case 'pending': return t('task.pending')
    case 'claimed': return t('task.claimed')
    case 'in_progress': return t('task.in_progress')
    case 'completed': return t('task.completed')
    case 'failed': return t('task.failed')
    case 'cancelled': return t('task.cancelled')
    default: return t('task.unknownStatus', { status })
  }
}

function taskStatusLabel(task: PatentTeamsCardTask, t: Translate): string {
  return statusLabel(task.status, t)
}

/** Navigation action shared with the plugin's SessionRuntime access. */
export interface TeamsOpenSession {
  readonly openSession: (id: SessionId) => void
}

/**
 * Render one team's member rows; a running member with a live ordinary row is
 * a button that opens its subagent session.
 */
export function TeamsMemberList({ team, runningMemberIds, openSession, t }: {
  readonly team: PatentTeamsCardData
  readonly runningMemberIds: ReadonlySet<string>
  readonly openSession: TeamsOpenSession['openSession']
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.memberList} data-patent-teams-members>
      {team.members.map((member) => {
        const running = runningMemberIds.has(member.memberId)
        const dot = memberDot(running, member.removed)
        const label = member.removed
          ? t('member.removed')
          : running ? t('member.running') : t('member.idle')
        const content = (
          <>
            <span className={css.dotSlot}>{dot === null ? null : <StateDot state={dot} />}</span>
            <span className={css.memberName}>{member.name}</span>
            {member.role === undefined ? null : <span className={css.memberRole}>{member.role}</span>}
            <span className={css.memberStatus}>{label}</span>
          </>
        )
        return running
          ? (
            <button
              key={member.memberId}
              type="button"
              className={css.memberButton}
              onClick={() => { openSession(member.memberId) }}
            >
              {content}
              <span className={css.srOnly}>{t('member.open', { name: member.name })}</span>
            </button>
          )
          : (
            <div key={member.memberId} className={css.memberRow} data-member-state={member.removed ? 'removed' : 'idle'}>
              {content}
            </div>
          )
      })}
    </div>
  )
}

/**
 * Render one team's task rows: status label, subject, assignee, unmet
 * dependencies, and contract/gate callouts.
 */
export function TeamsTaskList({ team, t }: {
  readonly team: PatentTeamsCardData
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.taskList} data-patent-teams-tasks>
      {team.tasks.map((task) => {
        const dot = taskDot(task.status)
        return (
          <div key={task.taskId} className={css.taskRow} data-task-status={task.status ?? 'none'}>
            <span className={css.dotSlot}>{dot === null ? null : <StateDot state={dot} />}</span>
            <span className={css.taskId}>{task.taskId}</span>
            <span className={css.taskSubject}>{task.subject}</span>
            <span className={css.taskStatus}>{taskStatusLabel(task, t)}</span>
            <span className={css.taskAssignee}>{task.assignee ?? t('task.unassigned')}</span>
            {task.dependencies.length === 0 ? null : (
              <span className={css.taskDeps}>{t('task.deps', { deps: task.dependencies.join(t('list.separator')) })}</span>
            )}
            {task.missingHardFields === undefined ? null : (
              <span className={css.taskFlag}>{t('task.contractDegraded', { fields: task.missingHardFields.join(t('list.separator')) })}</span>
            )}
            {task.gated ? <span className={css.taskFlag}>{t('task.gated')}</span> : null}
          </div>
        )
      })}
    </div>
  )
}
