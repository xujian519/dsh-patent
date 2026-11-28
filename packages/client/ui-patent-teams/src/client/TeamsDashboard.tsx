/**
 * One team's dashboard body for the fixed Teams tab: hero with a progress
 * ring, segmented task progress, the member roster, the dependency DAG, and
 * the capped activity feed. Pure presentation of one {@link PatentTeamsCardData};
 * live member activity arrives as the set of member ids currently running.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { avatarGradient } from './teams-avatar.ts'
import {
  dagDependencyChain, layoutTeamsDag, memberTaskBinding, taskSegments,
} from './teams-dag.ts'
import type {
  PatentTeamsCardData, PatentTeamsCardTask, TeamsActivityEntry,
} from './teams-model.ts'
import { STATUS_KEYS, statusLabel, type TeamsOpenSession } from './TeamsSections.tsx'
import css from './TeamsDashboard.module.css'

/** Translate function for this plugin's namespace. */
type Translate = PropsLocale<'patentTeams'>['t']

/** Join class names, dropping absent ones. */
const cx = (...names: ReadonlyArray<string | undefined>): string => names.filter(name => name !== undefined && name !== '').join(' ')

/** Glyph per activity kind (decorative; the text carries the meaning). */
const ACTIVITY_GLYPHS: Record<TeamsActivityEntry['kind'], string> = {
  'task-created': '＋',
  'task-updated': '◔',
  'task-validated': '⛨',
  'task-gated': '⊘',
  'message-sent': '✉',
}

/** Icon tint class per activity kind (absent classes fall back to the base tint). */
const ACTIVITY_ICON_CLASS: Record<TeamsActivityEntry['kind'], string | undefined> = {
  'task-created': css.feedIconTaskCreated,
  'task-updated': css.feedIconTaskUpdated,
  'task-validated': css.feedIconTaskValidated,
  'task-gated': css.feedIconTaskGated,
  'message-sent': css.feedIconMessageSent,
}

/** Dot semantics for one DAG node: gate rejections read as failures. */
function nodeStateClass(task: PatentTeamsCardTask): string | undefined {
  if (task.gated || task.status === 'failed') return css.nodeStateFailed
  if (task.status === 'completed') return css.nodeStateCompleted
  if (task.status === 'claimed' || task.status === 'in_progress') return css.nodeStateRunning
  return css.nodeStatePending
}

/** First grapheme of a display name (the avatar monogram). */
function monogram(name: string): string {
  return Array.from(name)[0] ?? name
}

/** Completed-task count bound to one member name. */
function completedCount(team: PatentTeamsCardData, memberName: string): number {
  return team.tasks.filter(task => task.assignee === memberName && task.status === 'completed').length
}

/** Locale text for one activity entry. */
function activityText(entry: TeamsActivityEntry, t: Translate): string {
  switch (entry.kind) {
    case 'task-created':
      return t('activity.taskCreated', { taskId: entry.taskId ?? '', subject: entry.subject ?? '' })
    case 'task-updated':
      return t('activity.taskUpdated', {
        taskId: entry.taskId ?? '',
        subject: entry.subject ?? '',
        status: statusLabel(entry.status, t),
      })
    case 'task-validated':
      return entry.valid === true
        ? t('activity.validatedOk', { taskId: entry.taskId ?? '', subject: entry.subject ?? '' })
        : t('activity.validatedMissing', {
          taskId: entry.taskId ?? '',
          subject: entry.subject ?? '',
          fields: (entry.missingHardFields ?? []).join(t('list.separator')),
        })
    case 'task-gated':
      return t('activity.taskGated', { taskId: entry.taskId ?? '', subject: entry.subject ?? '' })
    case 'message-sent':
      return t('activity.messageSent', { from: entry.from ?? '', to: entry.to ?? '' })
    /* v8 ignore next -- TeamsActivityKind is closed and every variant is handled above. */
    default:
      return entry.kind satisfies never
  }
}

/** The progress ring: one SVG circle whose dash offset tracks completion. */
function ProgressRing({ done, total }: { readonly done: number; readonly total: number }): ReactNode {
  const radius = 26
  const circumference = 2 * Math.PI * radius
  const fraction = total === 0 ? 0 : done / total
  return (
    <span className={css.ringWrap} aria-hidden>
      <svg width={58} height={58} viewBox="0 0 58 58">
        <circle className={css.ringTrack} cx={29} cy={29} r={radius} fill="none" strokeWidth={5} />
        <circle
          className={css.ringFill}
          cx={29}
          cy={29}
          r={radius}
          fill="none"
          strokeWidth={5}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span className={css.ringLabel}>{done}/{total}</span>
    </span>
  )
}

/** One DAG node button: hover traces, click pins the dependency chain. */
function DagNodeButton({ node, dim, hot, pinned, onHover, onPin, t }: {
  readonly node: { readonly task: PatentTeamsCardTask; readonly x: number; readonly y: number }
  readonly dim: boolean
  readonly hot: boolean
  readonly pinned: boolean
  readonly onHover: (taskId: string | null) => void
  readonly onPin: (taskId: string) => void
  readonly t: Translate
}): ReactNode {
  const { task } = node
  return (
    <button
      type="button"
      className={cx(css.dagNode, hot ? css.dagNodeHot : '', dim ? css.dagNodeDim : '', task.gated ? css.dagNodeGated : '')}
      style={{ left: node.x, top: node.y }}
      data-dag-task={task.taskId}
      data-dag-hot={hot || undefined}
      data-dag-dim={dim || undefined}
      aria-pressed={pinned}
      title={task.subject}
      onMouseEnter={() => { onHover(task.taskId) }}
      onMouseLeave={() => { onHover(null) }}
      onFocus={() => { onHover(task.taskId) }}
      onBlur={() => { onHover(null) }}
      onClick={() => { onPin(task.taskId) }}
    >
      <span className={css.nodeHead}>
        <span className={css.nodeId}>{task.taskId}</span>
        {task.gated ? <span className={css.gateBadge}><span aria-hidden>⊘</span> {t('task.gated')}</span> : null}
        <span className={cx(css.nodeState, nodeStateClass(task))} aria-hidden />
      </span>
      <span className={css.nodeSubject}>{task.subject}</span>
      <span className={css.nodeAssignee}>{task.assignee ?? t('task.unassigned')}</span>
      {/* The dot above carries the task state by colour alone. */}
      <span className={css.srOnly}>{statusLabel(task.status, t)}</span>
    </button>
  )
}

/** Full dashboard body of one folded team. */
export function TeamsDashboard({ team, running, openSession, t }: {
  readonly team: PatentTeamsCardData
  readonly running: ReadonlySet<string>
  readonly openSession: TeamsOpenSession['openSession']
  readonly t: Translate
}): ReactNode {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const layout = useMemo(() => layoutTeamsDag(team.tasks), [team.tasks])
  const segments = useMemo(() => taskSegments(team.tasks), [team.tasks])
  // Hovering previews a chain over the pinned one: a pinned node must not
  // shadow every later hover, or the hint's promise stops holding.
  const activeId = hoveredId ?? pinnedId
  const chain = useMemo(
    () => activeId === null ? undefined : dagDependencyChain(team.tasks, activeId),
    [team.tasks, activeId],
  )
  const ring = <ProgressRing done={team.completedTasks} total={team.tasks.length} />
  return (
    <section className={css.team} data-patent-teams-team={team.teamId} data-team-status={team.status}>
      <div className={css.hero}>
        <div className={css.teamId}>
          <span className={css.glyph} aria-hidden>{monogram(team.name)}</span>
          <span className={css.teamIdText}>
            <span className={css.teamName}>{team.name}</span>{' '}
            <span className={cx(css.statusPill, team.status === 'active' ? css.pillLive : '')}>
              <span className={css.pillDot} aria-hidden />
              {t(STATUS_KEYS[team.status])}
            </span>
            {team.description === undefined ? null : <p className={css.description}>{team.description}</p>}
          </span>
        </div>
        <div className={css.metrics}>
          <span className={css.metric}>
            <span className={css.metricLabel}>{t('metric.members')}</span>
            <span className={css.metricValue}>{team.members.length}</span>
          </span>
          {ring}
          <span className={css.metric}>
            <span className={css.metricLabel}>{t('metric.messages')}</span>
            <span className={css.metricValue}>{team.messageCount}</span>
          </span>
        </div>
      </div>

      <div>
        <div className={css.sectionHead}>
          <span className={css.sectionTitle}>{t('dash.progress')}</span>
          <span className={css.hint}>{t('dash.tasksProgress', { done: team.completedTasks, total: team.tasks.length })}</span>
        </div>
        <div className={css.segBar} role="img" aria-label={t('dash.tasksProgress', { done: team.completedTasks, total: team.tasks.length })}>
          {segments.done === 0 ? null : <span className={cx(css.seg, css.segDone)} style={{ flexGrow: segments.done }} />}
          {segments.running === 0 ? null : <span className={cx(css.seg, css.segRunning)} style={{ flexGrow: segments.running }} />}
          {segments.waiting === 0 ? null : <span className={cx(css.seg, css.segWaiting)} style={{ flexGrow: segments.waiting }} />}
        </div>
        <div className={css.legend}>
          <span className={css.legendItem}>
            <span className={cx(css.legendSwatch, css.legendDone)} aria-hidden />
            {t('dash.legendDone')} <span className={css.legendNum}>{segments.done}</span>
          </span>
          <span className={css.legendItem}>
            <span className={cx(css.legendSwatch, css.legendRunning)} aria-hidden />
            {t('dash.legendRunning')} <span className={css.legendNum}>{segments.running}</span>
          </span>
          <span className={css.legendItem}>
            <span className={cx(css.legendSwatch, css.legendWaiting)} aria-hidden />
            {t('dash.legendWaiting')} <span className={css.legendNum}>{segments.waiting}</span>
          </span>
        </div>
      </div>

      <div>
        <div className={css.sectionHead}>
          <span className={css.sectionTitle}>{t('section.members')}</span>
          <span className={css.countChip}>{team.members.length}</span>
          <span className={css.hint}>{t('dash.membersHint')}</span>
        </div>
        <div className={css.memberGrid} data-patent-teams-members>
          <div className={cx(css.memberCard, css.captainStrip)}>
            <span className={css.avatar} style={{ background: 'linear-gradient(135deg, var(--dsw-alias-state-business-primary), var(--dsw-alias-brand-primary))' }} aria-hidden>
              {monogram(t('member.captain'))}
            </span>
            <span className={css.memberBody}>
              <span className={css.memberTop}>
                <span className={css.memberName}>{t('member.captain')}</span>
                <span className={cx(css.stateChip, css.stateIdle)} aria-hidden>★</span>
              </span>
              <span className={css.memberTask}>
                <span className={css.taskSubject}>
                  {t('member.captainSummary', { count: team.tasks.length, members: team.members.length })}
                </span>
              </span>
            </span>
          </div>
          {team.members.map((member) => {
            const isRunning = running.has(member.memberId)
            const binding = memberTaskBinding(team.tasks, member.name)
            const bound = isRunning ? binding.current : binding.last
            const stateChip = member.removed
              ? <span className={cx(css.stateChip, css.stateIdle)}>{t('member.removed')}</span>
              : isRunning
                ? <span className={cx(css.stateChip, css.stateRunning)}>{t('member.running')}</span>
                : <span className={cx(css.stateChip, css.stateIdle)}>{t('member.idle')}</span>
            const body = (
              <>
                <span
                  className={css.avatar}
                  style={{ background: avatarGradient(member.memberId) }}
                  aria-hidden
                >
                  {monogram(member.name)}
                </span>
                <span className={css.memberBody}>
                  <span className={css.memberTop}>
                    <span className={css.memberName}>{member.name}</span>
                    {member.role === undefined ? null : <span className={css.roleChip}>{member.role}</span>}
                    {stateChip}
                  </span>
                  {bound === undefined ? null : (
                    <span className={css.memberTask}>
                      <span className={css.taskIdChip}>{bound.taskId}</span>
                      <span className={css.taskSubject}>
                        {isRunning ? t('member.current') : t('member.lastTask')} · {bound.subject}
                      </span>
                    </span>
                  )}
                  <span className={css.memberMeta}>
                    {t('member.tasksDone', { n: completedCount(team, member.name) })}
                  </span>
                </span>
              </>
            )
            return isRunning ? (
              <button
                key={member.memberId}
                type="button"
                className={css.memberButton}
                onClick={() => { openSession(member.memberId) }}
              >
                {body}
                <span className={css.srOnly}>{t('member.open', { name: member.name })}</span>
              </button>
            ) : (
              <div
                key={member.memberId}
                className={css.memberCard}
                data-member-state={member.removed ? 'removed' : 'idle'}
              >
                {body}
              </div>
            )
          })}
        </div>
      </div>

      {team.tasks.length === 0 ? null : (
        <div>
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>{t('section.tasks')}</span>
            <span className={css.countChip}>{team.tasks.length}</span>
            <span className={css.hint}>{t('dag.hint')}</span>
          </div>
          <div className={css.dagScroll}>
            <div className={css.dagCanvas} style={{ width: layout.width, height: layout.height }}>
              <svg
                className={css.dagSvg}
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
                aria-hidden
              >
                {layout.edges.map((edge) => {
                  const hot = chain !== undefined && chain.all.has(edge.from) && chain.all.has(edge.to)
                  return (
                    <path
                      key={`${edge.from}->${edge.to}`}
                      d={edge.path}
                      className={cx(css.dagEdge, hot ? css.dagEdgeHot : '', chain !== undefined && !hot ? css.dagEdgeDim : '')}
                    />
                  )
                })}
              </svg>
              {layout.nodes.map(node => (
                <DagNodeButton
                  key={node.task.taskId}
                  node={node}
                  dim={chain !== undefined && !chain.all.has(node.task.taskId)}
                  hot={chain !== undefined && chain.all.has(node.task.taskId)}
                  pinned={pinnedId === node.task.taskId}
                  onHover={setHoveredId}
                  onPin={(taskId) => { setPinnedId(current => current === taskId ? null : taskId) }}
                  t={t}
                />
              ))}
            </div>
          </div>
          <p className={css.dagNote}>{t('dag.note')}</p>
        </div>
      )}

      <div>
        <div className={css.sectionHead}>
          <span className={css.sectionTitle}>{t('section.activity')}</span>
        </div>
        <div className={css.feed} data-patent-teams-activity>
          {team.activity.length === 0
            ? <span className={css.emptyFeed}>{t('activity.empty')}</span>
            : team.activity.map(entry => (
              <div key={entry.seq} className={css.feedRow}>
                <span className={cx(css.feedIcon, ACTIVITY_ICON_CLASS[entry.kind])} aria-hidden>
                  {ACTIVITY_GLYPHS[entry.kind]}
                </span>
                <span className={css.feedText}>{activityText(entry, t)}</span>
              </div>
            ))}
        </div>
      </div>
    </section>
  )
}
