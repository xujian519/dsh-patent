/**
 * Pure layout and relationship projections for the Teams-tab task DAG —
 * no React, no fold state. The dashboard renders the emitted geometry
 * verbatim; the dependency closure powers the hover/pin chain highlight and
 * the segment counts drive the hero progress bar.
 * @module dsh-client-ui-patent-teams/teams-dag
 */
import type { PatentTeamsCardTask } from './teams-model.ts'

/** Fixed node geometry: compact nodes with room for curved dependency edges. */
const DAG_NODE_WIDTH = 140
/** Node height in canvas units. */
const DAG_NODE_HEIGHT = 52
/** Minimum horizontal gap between dependency columns. */
const DAG_COLUMN_GAP = 36
/** Minimum vertical gap between sibling rows. */
const DAG_ROW_GAP = 14

/** One laid-out DAG node: the task plus its top-left canvas position. */
interface DagNodePosition {
  readonly task: PatentTeamsCardTask
  readonly depth: number
  readonly x: number
  readonly y: number
}

/** One dependency edge routed between two nodes (SVG path in canvas coordinates). */
interface DagEdgePath {
  readonly from: string
  readonly to: string
  readonly path: string
}

/** Complete canvas geometry of one team's task DAG. */
interface TeamsDagLayout {
  readonly width: number
  readonly height: number
  readonly nodes: readonly DagNodePosition[]
  readonly edges: readonly DagEdgePath[]
}

/**
 * Longest-path depth per task, cycle-safe: a dependency back-edge whose target
 * is still being resolved is treated as root-level, so a malformed chain keeps
 * the layout finite and deterministic.
 * @param tasks - the team's tasks in fold (creation) order.
 * @returns depth per task id.
 */
function taskDepths(tasks: readonly PatentTeamsCardTask[]): ReadonlyMap<string, number> {
  const byId = new Map(tasks.map(task => [task.taskId, task]))
  const depths = new Map<string, number>()
  const depthOf = (taskId: string, resolving: ReadonlySet<string>): number => {
    const known = depths.get(taskId)
    if (known !== undefined) return known
    if (resolving.has(taskId)) return 0
    const next = new Set(resolving).add(taskId)
    const task = byId.get(taskId)
    const depth = task === undefined || task.dependencies.length === 0
      ? 0
      : Math.max(...task.dependencies.map(dependency => depthOf(dependency, next) + 1))
    depths.set(taskId, depth)
    return depth
  }
  for (const task of tasks) depthOf(task.taskId, new Set())
  return depths
}

/** One cubic-bezier edge routed left-to-right between two anchor points. */
function bezierEdge(fromX: number, fromY: number, toX: number, toY: number): string {
  const midX = (fromX + toX) / 2
  return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`
}

/**
 * Layer the tasks by dependency depth and route one curved edge per
 * dependency. Input order fixes the row order inside a column, so the same
 * fold always yields the same geometry.
 * @param tasks - the team's tasks in fold order.
 * @returns canvas size, positioned nodes, and edge paths.
 */
export function layoutTeamsDag(tasks: readonly PatentTeamsCardTask[]): TeamsDagLayout {
  if (tasks.length === 0) return { width: 0, height: 0, nodes: [], edges: [] }
  const depths = taskDepths(tasks)
  const columns = new Map<number, PatentTeamsCardTask[]>()
  for (const task of tasks) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- taskDepths assigned every task id above
    const depth = depths.get(task.taskId)!
    const column = columns.get(depth)
    if (column === undefined) columns.set(depth, [task])
    else column.push(task)
  }
  const rows = Math.max(...[...columns.values()].map(column => column.length))
  const width = columns.size * (DAG_NODE_WIDTH + DAG_COLUMN_GAP) - DAG_COLUMN_GAP
  const height = rows * (DAG_NODE_HEIGHT + DAG_ROW_GAP) - DAG_ROW_GAP
  const positions = new Map<string, DagNodePosition>()
  const nodes: DagNodePosition[] = []
  for (const [depth, column] of [...columns.entries()].sort((left, right) => left[0] - right[0])) {
    const columnHeight = column.length * (DAG_NODE_HEIGHT + DAG_ROW_GAP) - DAG_ROW_GAP
    const top = (height - columnHeight) / 2
    column.forEach((task, index) => {
      const position: DagNodePosition = {
        task,
        depth,
        x: depth * (DAG_NODE_WIDTH + DAG_COLUMN_GAP),
        y: top + index * (DAG_NODE_HEIGHT + DAG_ROW_GAP),
      }
      positions.set(task.taskId, position)
      nodes.push(position)
    })
  }
  const edges: DagEdgePath[] = []
  for (const node of nodes) {
    for (const dependency of node.task.dependencies) {
      const from = positions.get(dependency)
      if (from === undefined) continue
      edges.push({
        from: dependency,
        to: node.task.taskId,
        path: bezierEdge(
          from.x + DAG_NODE_WIDTH,
          from.y + DAG_NODE_HEIGHT / 2,
          node.x - 6,
          node.y + DAG_NODE_HEIGHT / 2,
        ),
      })
    }
  }
  return { width, height, nodes, edges }
}

/** Transitive dependency closure of one task: upstream, downstream, and both. */
interface DagDependencyChain {
  readonly upstream: ReadonlySet<string>
  readonly downstream: ReadonlySet<string>
  readonly all: ReadonlySet<string>
}

/**
 * Walk the dependency graph outward from one task: `upstream` holds every
 * transitive dependency, `downstream` every transitive dependent.
 * @param tasks - the team's tasks in fold order.
 * @param taskId - the task to trace from.
 * @returns the chain closure; empty when the task id is unknown.
 */
export function dagDependencyChain(
  tasks: readonly PatentTeamsCardTask[],
  taskId: string,
): DagDependencyChain {
  const dependenciesOf = new Map(tasks.map(task => [task.taskId, task.dependencies]))
  const dependentsOf = new Map(tasks.map(task => [task.taskId, [] as string[]]))
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      dependentsOf.get(dependency)?.push(task.taskId)
    }
  }
  const walk = (start: string, next: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> => {
    const seen = new Set<string>()
    const queue = [start]
    for (let at = 0; at < queue.length; at += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the loop bound pins the index to a pushed entry
      const current = queue[at]!
      for (const neighbor of next.get(current) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    return seen
  }
  if (!dependenciesOf.has(taskId)) {
    return { upstream: new Set(), downstream: new Set(), all: new Set() }
  }
  const upstream = walk(taskId, dependenciesOf)
  const downstream = walk(taskId, dependentsOf)
  return { upstream, downstream, all: new Set([taskId, ...upstream, ...downstream]) }
}

/** Task counts behind the segmented progress bar. */
interface TeamsTaskSegments {
  /** Tasks whose latest status is `completed`. */
  readonly done: number
  /** Tasks claimed or in progress right now. */
  readonly running: number
  /** Every remaining task: pending, failed, cancelled, or not yet updated. */
  readonly waiting: number
}

/**
 * Segment the team's tasks for the hero progress bar.
 * @param tasks - the team's tasks in fold order.
 * @returns done/running/waiting counts summing to the task count.
 */
export function taskSegments(tasks: readonly PatentTeamsCardTask[]): TeamsTaskSegments {
  let done = 0
  let running = 0
  for (const task of tasks) {
    if (task.status === 'completed') done += 1
    else if (task.status === 'claimed' || task.status === 'in_progress') running += 1
  }
  return { done, running, waiting: tasks.length - done - running }
}

/** The task a member is working on now and the last one it completed. */
interface MemberTaskBinding {
  readonly current?: PatentTeamsCardTask
  readonly last?: PatentTeamsCardTask
}

/**
 * Bind one member to its tasks: the first claimed/in-progress assignment is
 * the current task, the last completed assignment in fold order is the
 * previous one.
 * @param tasks - the team's tasks in fold order.
 * @param memberName - the member's display name (the task assignee key).
 * @returns the current and last completed task, each absent when none.
 */
export function memberTaskBinding(
  tasks: readonly PatentTeamsCardTask[],
  memberName: string,
): MemberTaskBinding {
  let current: PatentTeamsCardTask | undefined
  let last: PatentTeamsCardTask | undefined
  for (const task of tasks) {
    if (task.assignee !== memberName) continue
    if (task.status === 'claimed' || task.status === 'in_progress') {
      current ??= task
      continue
    }
    if (task.status === 'completed') last = task
  }
  return {
    ...current === undefined ? {} : { current },
    ...last === undefined ? {} : { last },
  }
}
