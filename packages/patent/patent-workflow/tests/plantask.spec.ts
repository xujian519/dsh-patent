import { describe, expect, it } from 'vitest'
import {
  PlanTaskSemanticError,
  PlanTaskStateError,
  PlanTaskStateMachine,
  TRANSITIONS,
  hashStep,
  replanTasks,
  syncPlanToTasks,
  type DocketIssue,
  type PlanTaskState,
} from '@deepseek-ai/dsh-patent-workflow'

/** 一条 open 条目；默认不阻塞，按用例逐项改档位。 */
function issue(overrides: Partial<DocketIssue> = {}): DocketIssue {
  return {
    id: 'issue-1',
    summary: '示例',
    kind: 'machine_format',
    disposition: 'application_fix',
    status: 'open',
    blocking: 'none',
    round_opened: 1,
    ...overrides,
  }
}

describe('plantask state machine', () => {
  it('转移表封闭：六个状态都有出边定义，目标都在词表内，finished 无出边', () => {
    const states: PlanTaskState[] = [
      'planning',
      'awaiting_approval',
      'executing',
      'awaiting_feedback',
      'replanning',
      'finished',
    ]
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...states].sort())
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) expect(states).toContain(target)
    }
    expect(TRANSITIONS.finished).toEqual([])

    // 每个状态至少从 planning 出发可达：图里没有孤立状态。
    const reached = new Set<PlanTaskState>(['planning'])
    const queue: PlanTaskState[] = ['planning']
    while (queue.length > 0) {
      const from = queue.shift()!
      for (const to of TRANSITIONS[from]) {
        if (reached.has(to)) continue
        reached.add(to)
        queue.push(to)
      }
    }
    expect([...reached].sort()).toEqual([...states].sort())
  })

  it('follows the allowed transition chain', () => {
    const sm = new PlanTaskStateMachine()
    expect(sm.state).toBe('planning')
    sm.transition('awaiting_approval')
    sm.transition('executing', { tasks: syncPlanToTasks(['步骤A']).tasks })
    sm.transition('awaiting_feedback')
    sm.transition('replanning', { feedback: '补充检索范围' })
    sm.transition('awaiting_approval')
    sm.transition('executing', { tasks: syncPlanToTasks(['步骤A', '步骤B']).tasks })
    sm.transition('finished')
    expect(sm.state).toBe('finished')
  })

  it('rejects illegal transitions', () => {
    const sm = new PlanTaskStateMachine()
    expect(() => sm.transition('executing')).toThrow(PlanTaskStateError)
    expect(() => sm.transition('finished')).toThrow(PlanTaskStateError)
    expect(sm.canTransition('awaiting_approval')).toBe(true)
    expect(sm.state).toBe('planning')
  })

  it('enforces tasks before executing (fail-closed)', () => {
    const sm = new PlanTaskStateMachine('awaiting_approval')
    expect(() => sm.transition('executing')).toThrow(PlanTaskSemanticError)
    expect(() => sm.transition('executing', {})).toThrow(PlanTaskSemanticError)
    expect(() => sm.transition('executing', { tasks: [] })).toThrow(PlanTaskSemanticError)
    sm.transition('executing', { tasks: syncPlanToTasks(['步骤A']).tasks })
    expect(sm.state).toBe('executing')
  })

  it('enforces feedback before replanning (fail-closed)', () => {
    const sm = new PlanTaskStateMachine('awaiting_feedback')
    expect(() => sm.transition('replanning')).toThrow(PlanTaskSemanticError)
    expect(() => sm.transition('replanning', { feedback: '   ' })).toThrow(PlanTaskSemanticError)
    sm.transition('replanning', { feedback: '对比文件 D3 需纳入' })
    expect(sm.state).toBe('replanning')
  })

  it('blocking 禁止派工：存在未闭合的阻塞条目时拒绝进入 executing', () => {
    const tasks = syncPlanToTasks(['步骤A']).tasks
    const blocked = new PlanTaskStateMachine('awaiting_approval')
    expect(() => blocked.transition('executing', { tasks, issues: [issue({ blocking: 'blocking' })] }))
      .toThrow(/executing 前必须先闭合阻塞条目：issue-1/)

    // 升级为终态的条目同属未闭合的阻塞条目，同样拦住派工。
    const terminal = new PlanTaskStateMachine('awaiting_approval')
    expect(() => terminal.transition('executing', { tasks, issues: [issue({ blocking: 'terminal' })] }))
      .toThrow(/issue-1/)

    // 条目闭合后放行；未登记条目与不阻塞的条目不拦。
    const closed = new PlanTaskStateMachine('awaiting_approval')
    closed.transition('executing', { tasks, issues: [issue({ blocking: 'blocking', status: 'closed' })] })
    expect(closed.state).toBe('executing')

    const unregistered = new PlanTaskStateMachine('awaiting_approval')
    unregistered.transition('executing', { tasks, issues: [issue()] })
    expect(unregistered.state).toBe('executing')

    const noDocket = new PlanTaskStateMachine('awaiting_approval')
    noDocket.transition('executing', { tasks })
    expect(noDocket.state).toBe('executing')
  })

  it('轮次上限封顶：已达上限的反馈只能收在终态，不再重规划', () => {
    const capped = new PlanTaskStateMachine('awaiting_feedback')
    expect(() => capped.transition('replanning', { feedback: '再改一版', rounds: 3, maxRounds: 3 }))
      .toThrow(/规划轮次已达上限 3，本轮只能收在终态/)

    const underCap = new PlanTaskStateMachine('awaiting_feedback')
    underCap.transition('replanning', { feedback: '再改一版', rounds: 2, maxRounds: 3 })
    expect(underCap.state).toBe('replanning')

    // 终态条目也拦住重规划：本轮只能收在终态。
    const terminal = new PlanTaskStateMachine('awaiting_feedback')
    expect(() => terminal.transition('replanning', {
      feedback: '再改一版',
      rounds: 0,
      maxRounds: 3,
      issues: [issue({ blocking: 'terminal' })],
    })).toThrow(/存在升级为终态的条目，本轮只能收在终态：issue-1/)
  })

  it('syncPlanToTasks builds ordered task list with blockedBy dependencies', () => {
    const steps = ['解析交底书', '检索现有技术', '对比特征', '生成结论']
    const { tasks, toRun } = syncPlanToTasks(steps)
    expect(tasks).toHaveLength(4)
    expect(tasks[0]!.blockedBy).toBeUndefined()
    expect(tasks[1]!.blockedBy).toEqual(['task-1'])
    expect(tasks[3]!.blockedBy).toEqual(['task-3'])
    expect(toRun).toHaveLength(4)
    expect(tasks.every(t => t.status === 'pending')).toBe(true)
  })

  it('hashStep is stable for identical input and differs for different input', () => {
    expect(hashStep('解析交底书')).toBe(hashStep('解析交底书'))
    expect(hashStep('解析交底书')).not.toBe(hashStep('检索现有技术'))
  })

  it('replanTasks preserves completed steps by hash and marks new steps to run', () => {
    const initial = syncPlanToTasks(['步骤A', '步骤B'])
    initial.tasks[0]!.status = 'completed'
    const replanned = replanTasks(initial.tasks, ['步骤A', '步骤B', '步骤C'])
    expect(replanned.preserved).toHaveLength(1)
    expect(replanned.preserved[0]).toBe('task-1')
    expect(replanned.toRun).toEqual(['task-2', 'task-3'])
    expect(replanned.tasks[0]!.status).toBe('completed')
    expect(replanned.tasks[1]!.status).toBe('pending')
    expect(replanned.tasks[2]!.status).toBe('pending')
  })
})
