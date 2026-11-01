/**
 * Pure subagent-membership helpers over the sessions list feed (structural
 * mirror world — no runtime imports). Used by the sidebar's auto-activation
 * effect and the Subagent page:
 *
 * - {@link directSubagentCount}: direct durable children of one session,
 * - {@link detectNewDirectSubagent}: the 0 → N transition that means "a new
 *   subagent just spawned under the current session" (the auto-open trigger),
 * - {@link countSubagentDescendants}: uninterrupted subagent-origin lineage
 *   totals (mirror of the official `indexSubagentDescendants` over the
 *   plugin's own summary rows).
 */
import type {
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalog,
} from '../context-types.ts'
import { SIDE_LABEL_PREFIX } from '../sidechat-core.ts'

/**
 * Side Chat threads ride the subagent origin (main-list hiding + the RPC
 * ownership fence) but they are NOT subagent topology: they carry the
 * durable 'Side: ' label and live as sidebar tabs. Excluding them here
 * keeps the auto-open trigger and the Subagent page counts clean.
 * @param summary - Session summary to test.
 * @returns Whether the subagent-origin row carries the Side Chat label.
 */
export function isSideThreadSummary(summary: SidebarSessionSummary): boolean {
  return summary.origin === 'subagent' && summary.displayTitle.startsWith(SIDE_LABEL_PREFIX)
}

/**
 * Count the direct subagent children of one session (durable `origin` rows).
 * @param byId - Session summary map scanned for children.
 * @param sessionId - Parent session id.
 * @returns The number of direct subagent children, excluding Side Chat threads.
 */
export function directSubagentCount(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): number {
  let count = 0
  for (const summary of Object.values(byId)) {
    if (summary.origin === 'subagent' && summary.parentId === sessionId
      && !isSideThreadSummary(summary)) count += 1
  }
  return count
}

/**
 * The main agent of the current session's tree: walk the durable parent
 * chain upward until the first non-subagent session. The Subagent page shows
 * THIS root's full topology regardless of how deep the current selection is
 * (a session whose row is still hydrating, or a broken chain, degrades to
 * the session itself).
 * @param byId - Session summary map providing the parent chain.
 * @param sessionId - Session to walk upward from; undefined yields undefined.
 * @returns The nearest non-subagent ancestor's id, or the session itself when the chain is broken or still hydrating.
 */
export function rootAncestor(
  byId: SidebarSessionList['byId'],
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined) return undefined
  const seen = new Set<string>()
  let current: SidebarSessionSummary | undefined = byId[sessionId]
  while (current !== undefined && current.origin === 'subagent'
    && current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId[current.parentId]
  }
  return current?.id ?? sessionId
}

/**
 * Collect every catalog branch (an entry with `hasChildren`) reachable from
 * the root — the set of catalogs the always-expanded topology consumes.
 * Cycles fail soft.
 * @param catalogs - Per-session subagent catalogs to descend.
 * @param rootId - Catalog root to descend from; undefined yields an empty list.
 * @returns Ids of every reachable child entry with children, depth-first; cycles stop the descent.
 */
export function collectBranchIds(
  catalogs: Readonly<Record<string, SidebarSubagentCatalog>>,
  rootId: string | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (parentId: string): void => {
    if (seen.has(parentId)) return
    seen.add(parentId)
    for (const entry of catalogs[parentId]?.entries ?? []) {
      if (entry.kind === 'child' && entry.hasChildren) {
        out.push(entry.id)
        visit(entry.id)
      }
    }
  }
  if (rootId !== undefined) visit(rootId)
  return out
}

/**
 * Whether a new direct subagent appeared under `sessionId` between two
 * consecutive list snapshots (the count crossed 0 → >0). Switching to a
 * session that already has subagents yields `false` (its baseline starts at
 * the current count), so the auto-open never fights an existing layout.
 * @param prev - Earlier list snapshot serving as the baseline.
 * @param next - Later list snapshot.
 * @param sessionId - Session whose direct subagent count is compared.
 * @returns Whether the direct subagent count crossed 0 → >0 between the snapshots.
 */
export function detectNewDirectSubagent(
  prev: SidebarSessionList,
  next: SidebarSessionList,
  sessionId: string,
): boolean {
  return directSubagentCount(prev.byId, sessionId) === 0
    && directSubagentCount(next.byId, sessionId) > 0
}

/** Descendant totals of one session through an uninterrupted subagent-origin chain. */
interface SubagentDescendantTotals {
  count: number
  runningCount: number
}

/**
 * Index every subagent descendant under each ancestor it reaches through an
 * uninterrupted subagent-origin chain (same semantics as the official
 * `indexSubagentDescendants`; cycles fail soft).
 * @param byId - Session summary map indexed for descendants.
 * @param sessionId - Ancestor session whose descendants are counted.
 * @returns Total and running counts of the descendants reached through uninterrupted subagent-origin chains.
 */
export function countSubagentDescendants(
  byId: SidebarSessionList['byId'],
  sessionId: string,
): SubagentDescendantTotals {
  const totals: SubagentDescendantTotals = { count: 0, runningCount: 0 }
  for (const descendant of Object.values(byId)) {
    if (descendant.origin !== 'subagent' || isSideThreadSummary(descendant)) continue
    const seen = new Set<string>()
    let current: SidebarSessionSummary | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined
      && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.parentId === sessionId) {
        totals.count += 1
        if (descendant.running === true) totals.runningCount += 1
        break
      }
      current = byId[current.parentId]
    }
  }
  return totals
}
