// Pure DAG geometry and relationship projections: deterministic layout from a
// given fold order, cycle-safe depths, chain closures, and the hero bindings.
import { describe, expect, it } from 'vitest'
import {
  dagDependencyChain, layoutTeamsDag, memberTaskBinding, taskSegments,
} from '../src/client/teams-dag.ts'
import type { PatentTeamsCardTask } from '../src/client/teams-model.ts'

function task(overrides: Partial<PatentTeamsCardTask> & { taskId: string }): PatentTeamsCardTask {
  return {
    subject: `subject-${overrides.taskId}`,
    dependencies: [],
    gated: false,
    ...overrides,
  }
}

const LINEAR = [
  task({ taskId: 't1' }),
  task({ taskId: 't2', dependencies: ['t1'] }),
  task({ taskId: 't3', dependencies: ['t2'] }),
]

describe('layoutTeamsDag', () => {
  it('lays out an empty task list flat', () => {
    expect(layoutTeamsDag([])).toEqual({ width: 0, height: 0, nodes: [], edges: [] })
  })

  it('stacks a linear chain left to right with one edge per dependency', () => {
    const layout = layoutTeamsDag(LINEAR)
    expect(layout.nodes.map(node => [node.task.taskId, node.depth, node.x])).toEqual([
      ['t1', 0, 0],
      ['t2', 1, 176],
      ['t3', 2, 352],
    ])
    expect(layout.width).toBe(3 * (140 + 36) - 36)
    // 76: a head row, a two-line subject, and the assignee row plus padding.
    expect(layout.height).toBe(76)
    expect(layout.edges.map(edge => [edge.from, edge.to])).toEqual([['t1', 't2'], ['t2', 't3']])
    for (const edge of layout.edges) expect(edge.path).toMatch(/^M \d+ 38 C \d+ 38, \d+ 38, \d+ 38$/)
  })

  it('centers later columns when a depth holds several rows', () => {
    const layout = layoutTeamsDag([
      task({ taskId: 't1' }),
      task({ taskId: 't2', dependencies: ['t1'] }),
      task({ taskId: 't3', dependencies: ['t1'] }),
      task({ taskId: 't4', dependencies: ['t2', 't3'] }),
    ])
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]))
    expect(byId.get('t4')!.depth).toBe(2)
    expect(byId.get('t2')!.y).toBe(0)
    expect(byId.get('t3')!.y).toBe(76 + 14)
    expect(byId.get('t4')!.y).toBe(45)
  })

  it('keeps a malformed dependency cycle finite', () => {
    const layout = layoutTeamsDag([
      task({ taskId: 't1', dependencies: ['t2'] }),
      task({ taskId: 't2', dependencies: ['t1'] }),
    ])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges).toHaveLength(2)
  })

  it('drops edges whose dependency is absent from the task list', () => {
    const layout = layoutTeamsDag([task({ taskId: 't1', dependencies: ['ghost'] })])
    expect(layout.edges).toEqual([])
    expect(layout.nodes).toHaveLength(1)
  })
})

describe('dagDependencyChain', () => {
  const DIAMOND = [
    task({ taskId: 't1' }),
    task({ taskId: 't2', dependencies: ['t1'] }),
    task({ taskId: 't3', dependencies: ['t1'] }),
    task({ taskId: 't4', dependencies: ['t2', 't3'] }),
  ]

  it('returns both closures through the diamond', () => {
    const chain = dagDependencyChain(DIAMOND, 't4')
    expect(chain.upstream).toEqual(new Set(['t2', 't3', 't1']))
    expect(chain.downstream).toEqual(new Set())
    expect(chain.all).toEqual(new Set(['t4', 't2', 't3', 't1']))
  })

  it('traces downstream dependents from a root', () => {
    const chain = dagDependencyChain(DIAMOND, 't1')
    expect(chain.upstream).toEqual(new Set())
    expect(chain.downstream).toEqual(new Set(['t2', 't3', 't4']))
  })

  it('yields empty closures for an unknown task id', () => {
    expect(dagDependencyChain(DIAMOND, 'ghost')).toEqual({
      upstream: new Set(),
      downstream: new Set(),
      all: new Set(),
    })
  })

  it('tolerates a dependency id absent from the task list while walking', () => {
    const chain = dagDependencyChain([task({ taskId: 't1', dependencies: ['ghost'] })], 't1')
    expect(chain.upstream).toEqual(new Set(['ghost']))
    expect(chain.all).toEqual(new Set(['t1', 'ghost']))
  })
})

describe('taskSegments', () => {
  it('counts empty lists as all-zero', () => {
    expect(taskSegments([])).toEqual({ done: 0, running: 0, waiting: 0 })
  })

  it('buckets every status into done, running, or waiting', () => {
    const segments = taskSegments([
      task({ taskId: 't1', status: 'completed' }),
      task({ taskId: 't2', status: 'claimed' }),
      task({ taskId: 't3', status: 'in_progress' }),
      task({ taskId: 't4', status: 'pending' }),
      task({ taskId: 't5', status: 'failed' }),
      task({ taskId: 't6' }),
    ])
    expect(segments).toEqual({ done: 1, running: 2, waiting: 3 })
  })
})

describe('memberTaskBinding', () => {
  const TASKS = [
    task({ taskId: 't1', assignee: 'alice', status: 'completed' }),
    task({ taskId: 't2', assignee: 'alice', status: 'in_progress' }),
    task({ taskId: 't3', assignee: 'bob', status: 'pending' }),
    task({ taskId: 't4', status: 'pending' }),
  ]

  it('binds the first open assignment and the last completed one', () => {
    expect(memberTaskBinding(TASKS, 'alice')).toEqual({
      current: TASKS[1],
      last: TASKS[0],
    })
  })

  it('leaves unbound members without current or last tasks', () => {
    expect(memberTaskBinding(TASKS, 'bob')).toEqual({})
    expect(memberTaskBinding(TASKS, 'carol')).toEqual({})
  })
})
