/**
 * Pure cross-session board projection: fold the session list's `todosLatest`
 * projection column into the three kanban columns, scoped to the workspace of
 * the current session. No DOM, no React, no protocol — the view renders
 * whatever this returns.
 *
 * @module @deepseek-ai/dsh-client-ui-todo-board/client/board-model
 */

import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One board card: a todo line plus the session it came from. */
interface BoardCard {
  /** The todo's imperative content line, verbatim. */
  readonly content: string
  /** Optional model-authored category labels; empty when the todo is untagged. */
  readonly tags: readonly string[]
  /** Session that wrote this todo list; the badge navigates back to it. */
  readonly sessionId: SessionId
  /** Human-facing session label for the card badge. */
  readonly sessionTitle: string
}

/** The three kanban columns, keyed by todo status. */
type BoardColumns = Readonly<Record<TodoItem['status'], readonly BoardCard[]>>

/** Column keys in render order. */
export const BOARD_COLUMNS = ['pending', 'in_progress', 'completed'] as const

/**
 * Project the board columns from the session list and workspace catalog.
 *
 * Scope: the workspace owning the current session, matched through the
 * workspace catalog's `sessionIds` — the same membership the sidebar's
 * browser groups render. When the current session belongs to no workspace
 * (or none is selected), the scope is the sessions outside every workspace.
 * Each scoped session contributes the cards of its `todosLatest` projection
 * value; sessions without one contribute nothing.
 * @param list - session list snapshot (rows, order, and current selection).
 * @param workspaces - workspace catalog rows in stable host order.
 * @returns the three columns with cards in session-list order.
 */
export function projectBoard(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
): BoardColumns {
  const scoped = scopedSessions(list, workspaces)
  const columns: { -readonly [K in TodoItem['status']]: BoardCard[] } = {
    pending: [],
    in_progress: [],
    completed: [],
  }
  for (const summary of scoped) {
    const todos = summary.projectionValues?.todosLatest
    if (!Array.isArray(todos)) continue
    for (const todo of todos) {
      columns[todo.status].push({
        content: todo.content,
        tags: todo.tags ?? [],
        sessionId: summary.id,
        sessionTitle: summary.displayTitle,
      })
    }
  }
  return columns
}

/**
 * The board's tag filter options: every distinct tag across all cards, in
 * stable alphabetical order. Empty when no card carries a tag.
 * @param columns - the projected board columns.
 * @returns the sorted unique tag set.
 */
export function boardTags(columns: BoardColumns): readonly string[] {
  const tags = new Set<string>()
  for (const key of BOARD_COLUMNS) {
    for (const card of columns[key]) {
      for (const tag of card.tags) tags.add(tag)
    }
  }
  return [...tags].sort((left, right) => left.localeCompare(right))
}

/**
 * The filtered columns for one active tag: cards whose tags include it.
 * `null` keeps every card — the unfiltered board.
 * @param columns - the projected board columns.
 * @param tag - the active tag filter, or `null` for no filter.
 * @returns the filtered columns, or the input columns when unfiltered.
 */
export function filterBoard(columns: BoardColumns, tag: string | null): BoardColumns {
  if (tag === null) return columns
  const filtered: { -readonly [K in TodoItem['status']]: BoardCard[] } = {
    pending: [], in_progress: [], completed: [],
  }
  for (const key of BOARD_COLUMNS) {
    filtered[key] = columns[key].filter(card => card.tags.includes(tag))
  }
  return filtered
}

/**
 * Total card count across the columns — zero renders the empty state.
 * @param columns - the projected board columns.
 * @returns the number of cards in all three columns combined.
 */
export function boardCardCount(columns: BoardColumns): number {
  return BOARD_COLUMNS.reduce((sum, key) => sum + columns[key].length, 0)
}

/** Sessions of the current session's workspace, or strays; list order. */
function scopedSessions(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
): readonly SessionSummary[] {
  const ownerOf = (id: SessionId): WorkspaceView | undefined =>
    workspaces.find(workspace => workspace.sessionIds.includes(id))
  const summariesOf = (ids: readonly SessionId[]): readonly SessionSummary[] => ids
    .map(id => list.byId[id])
    .filter((summary): summary is SessionSummary => summary !== undefined)
  const current = Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  if (current !== undefined) {
    const owner = ownerOf(current)
    if (owner !== undefined) return summariesOf(owner.sessionIds)
  }
  return summariesOf(list.ids).filter(summary => ownerOf(summary.id) === undefined)
}
