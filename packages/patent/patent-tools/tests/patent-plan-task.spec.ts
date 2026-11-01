import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { hashStep } from '@deepseek-ai/dsh-patent-workflow'
import { PatentToolError } from '../src/error.ts'
import {
  createPatentPlanTaskTool,
  renderPlanTask,
  type PatentPlanTaskOutput,
} from '../src/tool/patent-plan-task.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const exec = { signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]

describe('patent_plan_task', () => {
  const tool = createPatentPlanTaskTool()

  it('registers under patent_plan_task', () => {
    expect(tool.name).toBe('patent_plan_task')
  })

  it('transitions planning → awaiting_approval', async () => {
    const value = (await tool.execute({ action: 'transition', currentState: 'planning', to: 'awaiting_approval' }, exec)) as PatentPlanTaskOutput
    expect(value.ok).toBe(true)
    expect(value.from).toBe('planning')
    expect(value.state).toBe('awaiting_approval')
  })

  it('rejects executing without synced tasks (semantic guard)', async () => {
    await expect(
      tool.execute({ action: 'transition', currentState: 'awaiting_approval', to: 'executing' }, exec),
    ).rejects.toThrow(PatentToolError)
  })

  it('rejects an illegal transition', async () => {
    await expect(
      tool.execute({ action: 'transition', currentState: 'planning', to: 'finished' }, exec),
    ).rejects.toThrow('非法状态迁移')
  })

  it('rejects an unknown state name', async () => {
    await expect(
      tool.execute({ action: 'transition', currentState: 'nonsense', to: 'planning' }, exec),
    ).rejects.toThrow('非法状态')
  })

  it('rejects an unknown action via args validation', async () => {
    await expect(tool.execute({ action: 'nope' }, exec)).rejects.toThrow('invalid arguments')
  })

  it('syncs plan steps into ordered tasks with blockedBy deps', async () => {
    const value = (await tool.execute({ action: 'sync', planSteps: ['a', 'b', 'c'] }, exec)) as PatentPlanTaskOutput
    expect(value.ok).toBe(true)
    expect(value.tasks).toHaveLength(3)
    expect(value.tasks?.[0]?.blockedBy).toBeUndefined()
    expect(value.tasks?.[1]?.blockedBy).toEqual(['task-1'])
    expect(value.tasks?.[2]?.blockedBy).toEqual(['task-2'])
    expect(value.toRun).toEqual(['task-1', 'task-2', 'task-3'])
  })

  it('replans preserving completed steps by hash', async () => {
    const previousTasks = [
      { id: 'task-1', description: 'a', hash: hashStep('a'), status: 'completed' as const },
      { id: 'task-2', description: 'b', hash: hashStep('b'), status: 'pending' as const },
    ]
    const value = (await tool.execute(
      { action: 'replan', planSteps: ['a', 'b2'], previousTasks },
      exec,
    )) as PatentPlanTaskOutput
    expect(value.ok).toBe(true)
    expect(value.preserved).toEqual(['task-1'])
    expect(value.toRun).toEqual(['task-2'])
    expect(value.tasks).toHaveLength(2)
    expect(value.tasks?.[0]?.status).toBe('completed')
  })

  it('renders transition, sync, and error prose', () => {
    const transition = renderPlanTask({ ok: true, action: 'transition', from: 'planning', state: 'awaiting_approval' })
    expect(transition).toContain('planning → awaiting_approval')
    const sync = renderPlanTask({
      ok: true,
      action: 'sync',
      tasks: [{ id: 'task-1', description: 'a', hash: 'h', status: 'pending' }],
      preserved: [],
      toRun: ['task-1'],
    })
    expect(sync).toContain('同步 1 个任务')
    expect(sync).toContain('- task-1 pending: a')
    const error = renderPlanTask({ ok: false, action: 'sync', error: 'sync 需要 planSteps 非空' })
    expect(error).toContain('patent_plan_task: sync 需要 planSteps 非空')
  })

  it('renders dependent tasks, replan prose, and fallbacks', () => {
    const blocked = renderPlanTask({
      ok: true,
      action: 'sync',
      tasks: [{ id: 'task-2', description: 'b', hash: 'h', status: 'pending', blockedBy: ['task-1'] }],
      preserved: [],
      toRun: [],
    })
    expect(blocked).toContain('（依赖 task-1）')
    expect(blocked).toContain('待执行: ')

    const bareSync = renderPlanTask({ ok: true, action: 'sync', preserved: [] })
    expect(bareSync).toContain('同步 0 个任务')
    expect(bareSync).toContain('待执行: ')

    const replan = renderPlanTask({
      ok: true,
      action: 'replan',
      tasks: [{ id: 'task-1', description: 'a', hash: 'h', status: 'completed' }],
      preserved: ['task-1'],
      toRun: [],
    })
    expect(replan).toContain('保留已完成: task-1')
    expect(replan).toContain('（全部已完成）')

    const noPreserved = renderPlanTask({ ok: true, action: 'replan', tasks: [], preserved: [], toRun: ['t1'] })
    expect(noPreserved).toContain('无保留步骤')
    expect(noPreserved).toContain('需执行: t1')

    const bareReplan = renderPlanTask({ ok: true, action: 'replan' })
    expect(bareReplan).toContain('无保留步骤')
    expect(bareReplan).toContain('（全部已完成）')

    const bareError = renderPlanTask({ ok: false, action: 'sync' })
    expect(bareError).toContain('失败')
  })

  it('transitions with tasks and feedback through the tool render', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createPatentPlanTaskTool())
    const signal = new AbortController().signal
    const executing = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('pt-1'),
      name: 'patent_plan_task',
      arguments: { action: 'transition', currentState: 'awaiting_approval', to: 'executing', tasks: [{ id: 'task-1' }] },
    })
    expect(executing.isError).toBe(false)
    if (executing.isError) throw new Error('expected success')
    expect(text(executing)).toContain('awaiting_approval → executing')

    const replanning = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('pt-2'),
      name: 'patent_plan_task',
      arguments: { action: 'transition', currentState: 'awaiting_feedback', to: 'replanning', feedback: '补充检索' },
    })
    expect(replanning.isError).toBe(false)
    if (replanning.isError) throw new Error('expected success')
    expect(text(replanning)).toContain('awaiting_feedback → replanning')

    const defaultFrom = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('pt-3'),
      name: 'patent_plan_task',
      arguments: { action: 'transition', to: 'awaiting_approval' },
    })
    expect(defaultFrom.isError).toBe(false)
  })

  it('replans without previous tasks and rejects empty sync/replan steps', async () => {
    const tool = createPatentPlanTaskTool()
    const value = (await tool.execute({ action: 'replan', planSteps: ['a'] }, exec)) as PatentPlanTaskOutput
    expect(value.ok).toBe(true)
    expect(value.tasks).toHaveLength(1)
    await expect(tool.execute({ action: 'replan' }, exec)).rejects.toThrow('replan 需要 planSteps 非空')
    await expect(tool.execute({ action: 'sync' }, exec)).rejects.toThrow('sync 需要 planSteps 非空')
  })

  it('requires a planning round for docket entries and rejects a non-positive one', async () => {
    const issue = { id: 'i-1', summary: '对比文件缺公开日', kind: 'evidence_gap' as const }
    await expect(
      tool.execute({ action: 'transition', currentState: 'planning', to: 'awaiting_approval', issues: [issue] }, exec),
    ).rejects.toThrow('issues 需要 round')
    await expect(
      tool.execute({ action: 'transition', currentState: 'planning', to: 'awaiting_approval', issues: [issue], round: 0 }),
    ).rejects.toThrow('issues 必须是正整数')
    await expect(
      tool.execute({
        action: 'transition', currentState: 'planning', to: 'awaiting_approval',
        issues: [{ ...issue, round_opened: 1.5 }], round: 1,
      }),
    ).rejects.toThrow('issues[].round_opened 必须是正整数')
  })

  it('resolves docket defaults and echoes the resolved entries', async () => {
    const value = (await tool.execute({
      action: 'transition',
      currentState: 'planning',
      to: 'awaiting_approval',
      issues: [{ id: 'i-1', summary: '对比文件缺公开日', kind: 'evidence_gap' }],
      round: 2,
    }, exec)) as PatentPlanTaskOutput
    expect(value.ok).toBe(true)
    expect(value.issues?.[0]).toMatchObject({
      id: 'i-1', kind: 'evidence_gap', disposition: 'ask_human', blocking: 'blocking', status: 'open', round_opened: 2,
    })
  })

  it('refuses dispatch while a blocking docket entry is open and allows it once closed', async () => {
    const tasks = [{ id: 'task-1', description: 'a', hash: 'h', status: 'pending' as const }]
    const issue = { id: 'i-1', summary: '对比文件缺公开日', kind: 'evidence_gap' as const }
    await expect(tool.execute({
      action: 'transition', currentState: 'awaiting_approval', to: 'executing', tasks, issues: [issue], round: 1,
    }, exec)).rejects.toThrow('executing 前必须先闭合阻塞条目：i-1')
    const closed = (await tool.execute({
      action: 'transition', currentState: 'awaiting_approval', to: 'executing', tasks,
      issues: [{ ...issue, status: 'closed' }], round: 1,
    }, exec)) as PatentPlanTaskOutput
    expect(closed.state).toBe('executing')
  })

  it('refuses replanning on a terminal entry or an exhausted round cap', async () => {
    await expect(tool.execute({
      action: 'transition', currentState: 'awaiting_feedback', to: 'replanning', feedback: '补充检索',
      issues: [{ id: 'i-2', summary: '说明书未充分公开', kind: 'insufficient_disclosure' }], round: 1,
    }, exec)).rejects.toThrow('本轮只能收在终态：i-2')
    await expect(tool.execute({
      action: 'transition', currentState: 'awaiting_feedback', to: 'replanning', feedback: '补充检索',
      rounds: 2, maxRounds: 2,
    }, exec)).rejects.toThrow('规划轮次已达上限 2')
  })

  it('renders resolved docket entries in the transition prose', () => {
    const text = renderPlanTask({
      ok: true,
      action: 'transition',
      from: 'planning',
      state: 'awaiting_approval',
      issues: [{
        id: 'i-1', summary: '对比文件缺公开日', kind: 'evidence_gap', disposition: 'ask_human',
        blocking: 'blocking', status: 'open', round_opened: 1,
      }],
    })
    expect(text).toContain('planning → awaiting_approval')
    expect(text).toContain('案卷条目 1 条')
    expect(text).toContain('- i-1 evidence_gap/blocking/open: 对比文件缺公开日')
  })
})

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}
