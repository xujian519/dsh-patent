/**
 * The durable PatentTeams chat card: one keyed Chat renderer per folded team.
 * Collapsed it is a one-line progress summary; expanded it lists the member
 * rows (a running member opens its subagent session) and the task rows —
 * the same two row lists the Teams tab renders.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DisclosureRow, IconUserOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { shallowEqual } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  STATUS_KEYS, TeamsMemberList, TeamsTaskList, teamDotState, type TeamsOpenSession,
} from './TeamsSections.tsx'
import type { PatentTeamsCardData } from './teams-model.ts'
import css from './TeamsCard.module.css'

/** Complete keyed Chat renderer props. */
export type TeamsCardProps =
  PropsRuntime<'conversation.chat.node', 'patent-teams'>
  & PropsLocale<'patentTeams'>
  & TeamsOpenSession

/**
 * Member ids that are proven live children of this session and currently
 * running: an ordinary Session-list row (`ids`), `origin: 'subagent'`, parented
 * to this Session, and running. The workflow-run panel reaches the same verdict
 * from the richer `byId` rows plus its status map, so a member it can open from
 * a catalog row is still briefly inert here until the list row arrives — a
 * transient race, never a dead button.
 */
export function runningMemberIds(
  sessions: SessionListState,
  team: PatentTeamsCardData,
  parentId: SessionId,
): ReadonlySet<string> {
  const ordinary = new Set(sessions.ids)
  const result = new Set<string>()
  for (const member of team.members) {
    const memberId = member.memberId
    const summary = sessions.byId[memberId]
    if (ordinary.has(memberId)
      && summary?.origin === 'subagent'
      && summary.parentId === parentId
      && summary.running) {
      result.add(member.memberId)
    }
  }
  return result
}

/**
 * Render one folded team as a chat card.
 * @param props - keyed Chat runtime share, locale share, and the open-session action.
 * @returns the card.
 */
export function TeamsCard({ node, sessionId, useSessions, openSession, t }: TeamsCardProps): ReactNode {
  const team = node.data
  const [open, setOpen] = useState(team.status === 'active')
  const running = useSessions(
    sessions => runningMemberIds(sessions, team, sessionId),
    shallowEqual,
  )
  const summary = useMemo(() => {
    const members = t('card.members', { count: team.members.length })
    const tasks = team.tasks.length === 0
      ? t('card.noTasks')
      : t('card.tasks', { done: team.completedTasks, total: team.tasks.length })
    return `${members} · ${tasks}`
  }, [team.members.length, team.tasks.length, team.completedTasks, t])

  return (
    <section
      className={css.root}
      data-patent-teams-card
      data-team-status={team.status}
    >
      <DisclosureRow
        expandable
        icon={<IconUserOutlineRegular />}
        title={team.name}
        open={open}
        onToggle={() => { setOpen(current => !current) }}
        expandOnRowClick
        previewChevron={false}
        keepContentWhenOpen
        rowClassName={css.header}
        leadingClassName={css.leading}
        titleClassName={css.title}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary}>{summary}</span>
            <span className={css.statusTail} data-status={team.status}>
              <StateDot state={teamDotState(team.status)} />
              <span>{t(STATUS_KEYS[team.status])}</span>
            </span>
          </>
        )}
      >
        <div className={css.body}>
          {team.description === undefined ? null : <p className={css.description}>{team.description}</p>}
          <h4 className={css.sectionLabel}>{t('section.members')}</h4>
          {team.members.length === 0
            ? <span className={css.empty}>{t('card.members', { count: 0 })}</span>
            : (
              <TeamsMemberList
                team={team}
                runningMemberIds={running}
                openSession={openSession}
                t={t}
              />
            )}
          <h4 className={css.sectionLabel}>{t('section.tasks')}</h4>
          {team.tasks.length === 0
            ? <span className={css.empty}>{t('card.noTasks')}</span>
            : <TeamsTaskList team={team} t={t} />}
          {team.messageCount === 0 ? null : (
            <span className={css.messages}>{t('card.messages', { count: team.messageCount })}</span>
          )}
        </div>
      </DisclosureRow>
    </section>
  )
}
