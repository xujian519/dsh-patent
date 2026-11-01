/**
 * The fixed Teams conversation view: every team folded from this session's
 * `patent-teams/*` events, read from the `patentTeams` view snapshot, rendered
 * as one dashboard per team. Because the fold needs each team's
 * `team-created` start event, an open with only the tail history window keeps
 * paging backwards while no team has materialized yet — otherwise long
 * sessions whose teams predate the loaded window would forever show the empty
 * state. Sessions without team records still get the empty state.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { shallowEqual } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { runningMemberIds } from './TeamsCard.tsx'
import { TeamsDashboard } from './TeamsDashboard.tsx'
import type { TeamsOpenSession } from './TeamsSections.tsx'
import type { PatentTeamsCardData } from './teams-model.ts'
import type { PatentTeamsViewSnapshot } from './teams-view.ts'
import { PATENT_TEAMS_TARGET } from './teams-view.ts'
import css from './TeamsView.module.css'

/** Teams view props: runtime session share, injected actions, and copy. */
export type TeamsViewProps = ConvViewProps
  & PropsLocale<'patentTeams'>
  & TeamsOpenSession
  & TeamsViewInjected

/** Business callbacks injected by the plugin's slot registration. */
interface TeamsViewInjected {
  /** Page the session history backwards by one window (the Session face's `loadOlder`). */
  readonly loadOlder: () => Promise<void>
}

/** Safety bound on backwards paging while hunting for team start events. */
const DRAIN_PAGE_LIMIT = 400

/** Stable empty list so the selector never allocates per store tick. */
const EMPTY_TEAMS: readonly PatentTeamsCardData[] = []

function snapshotTeams(value: PatentTeamsViewSnapshot | undefined): readonly PatentTeamsCardData[] {
  return value?.teams ?? EMPTY_TEAMS
}

function runningIdsFor(
  sessions: SessionListState,
  teams: readonly PatentTeamsCardData[],
  sessionId: ConvViewProps['sessionId'],
): ReadonlySet<string> {
  const result = new Set<string>()
  for (const team of teams) {
    for (const id of runningMemberIds(sessions, team, sessionId)) result.add(id)
  }
  return result
}

/**
 * Render the session's folded teams as dashboards.
 * @param props - session runtime share, injected actions, and locale share.
 * @returns the Teams tab body.
 */
export function TeamsView({
  sessionId, useConversation, useSessions, useSession, openSession, loadOlder, t,
}: TeamsViewProps): ReactNode {
  const snapshot = useConversation(state => state.views.get(PATENT_TEAMS_TARGET))
  const list = useMemo(() => snapshotTeams(snapshot), [snapshot])
  const running = useSessions(
    sessions => runningIdsFor(sessions, list, sessionId),
    shallowEqual,
  )
  const hasMore = useSession(state => state.hasMore)

  // Drain history while no team has started: each loadOlder prepends one
  // window into the fold, so the snapshot re-evaluates between pages.
  const [drainTick, setDrainTick] = useState(0)
  const drainAttempts = useRef(0)
  useEffect(() => {
    if (list.length > 0 || !hasMore || drainAttempts.current >= DRAIN_PAGE_LIMIT) return
    drainAttempts.current += 1
    let cancelled = false
    void loadOlder().finally(() => {
      if (!cancelled) setDrainTick(tick => tick + 1)
    })
    return () => { cancelled = true }
  }, [list.length, hasMore, loadOlder, drainTick])

  if (list.length === 0) {
    return <p className={css.emptyState} data-patent-teams-empty>{t('view.empty')}</p>
  }
  return (
    <div className={css.root}>
      {list.map(team => (
        <TeamsDashboard
          key={team.teamId}
          team={team}
          running={running}
          openSession={openSession}
          t={t}
        />
      ))}
    </div>
  )
}
