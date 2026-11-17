import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerBuiltinAtoms, type PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import type { FlexiblePlanState, FlexiblePlanStore, WorkflowRunResult } from '@deepseek-ai/dsh-patent-workflow'
import { PatentToolError } from '../src/error.ts'
import {
  createFlexiblePlanTool,
  renderFlexiblePlan,
  type FlexiblePlanAction,
  type FlexiblePlanOutput,
} from '../src/tool/patent-flexible-plan.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

type WorkflowRunResultLike = Pick<WorkflowRunResult, 'manifestId' | 'caseType' | 'summary' | 'completed' | 'stages' | 'degradedSteps'> & { interrupted?: { stageId: string; message: string } }

registerBuiltinAtoms()

const exec = { signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]

/** In-memory plan store so tests never touch the real filesystem for plans. */
class MemoryPlanStore implements FlexiblePlanStore {
  private readonly plans = new Map<string, FlexiblePlanState>()

  async savePlan(state: FlexiblePlanState): Promise<void> {
    this.plans.set(state.caseId, structuredClone(state))
  }

  async loadPlan(caseId: string): Promise<FlexiblePlanState | undefined> {
    const plan = this.plans.get(caseId)
    return plan === undefined ? undefined : structuredClone(plan)
  }

  async listCaseIds(): Promise<string[]> {
    return [...this.plans.keys()]
  }
}

function fakeModel(): PatentModelPort {
  return {
    stream: async function* () {
      yield { type: 'delta', text: 'plain text output' }
      yield { type: 'done' }
    },
  }
}

const STAGES = [
  { id: 'extract', name: '提取', goal: '提取技术特征', strategy: 'chain' as const },
  { id: 'report', name: '报告', goal: '生成报告', strategy: 'chain' as const },
]

let temp: string | undefined

afterEach(async () => {
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

describe('flexible_plan', () => {
  it('registers under flexible_plan', () => {
    expect(createFlexiblePlanTool().name).toBe('flexible_plan')
  })

  it('creates and gets a plan', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    const created = (await tool.execute(
      { action: 'create', caseId: 'case-1', caseType: 'novelty_search', stages: STAGES },
      exec,
    )) as FlexiblePlanOutput
    expect(created.plan?.status).toBe('active')
    expect(created.plan?.stages).toHaveLength(2)
    expect(created.plan?.currentStageId).toBe('extract')

    const got = (await tool.execute({ action: 'get', caseId: 'case-1' }, exec)) as FlexiblePlanOutput
    expect(got.plan?.caseId).toBe('case-1')
  })

  it('confirms then rolls back a stage', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    const confirmed = (await tool.execute({ action: 'confirm', caseId: 'c', stageId: 'extract' }, exec)) as FlexiblePlanOutput
    expect(confirmed.plan?.stages[0]?.status).toBe('confirmed')

    const rolled = (await tool.execute({
      action: 'rollback',
      caseId: 'c',
      stageId: 'extract',
      rationale: '权利要求 1 的对应事实未提取',
      before: 'digest-of-old-output',
    }, exec)) as FlexiblePlanOutput
    expect(rolled.plan?.stages[0]?.status).toBe('rolled_back')
    expect(rolled.plan?.revisions?.[0]).toMatchObject({
      rationale: '权利要求 1 的对应事实未提取',
      before: 'digest-of-old-output',
    })

    // 只给 stageId 时使用默认原因与摘要。
    const defaulted = (await tool.execute({ action: 'rollback', caseId: 'c', stageId: 'extract' }, exec)) as FlexiblePlanOutput
    expect(defaulted.plan?.revisions?.[1]).toMatchObject({
      rationale: '人工回退到 extract',
    })
  })

  it('adds, removes, reorders, and completes', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)

    const added = (await tool.execute(
      { action: 'add', caseId: 'c', stage: { id: 'extra', name: '额外', goal: 'g', strategy: 'chain' } },
      exec,
    )) as FlexiblePlanOutput
    expect(added.plan?.stages).toHaveLength(3)

    const removed = (await tool.execute({ action: 'remove', caseId: 'c', stageId: 'extra' }, exec)) as FlexiblePlanOutput
    expect(removed.plan?.stages).toHaveLength(2)

    const reordered = (await tool.execute(
      { action: 'reorder', caseId: 'c', stageIds: ['report', 'extract'] },
      exec,
    )) as FlexiblePlanOutput
    expect(reordered.plan?.stages[0]?.id).toBe('report')

    const completed = (await tool.execute({ action: 'complete', caseId: 'c' }, exec)) as FlexiblePlanOutput
    expect(completed.plan?.status).toBe('completed')
  })

  it('abandons with a reason kept for audit', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    const abandoned = (await tool.execute(
      { action: 'abandon', caseId: 'c', reason: '客户撤回' },
      exec,
    )) as FlexiblePlanOutput
    expect(abandoned.plan?.status).toBe('abandoned')
    expect(abandoned.plan?.abandonReason).toBe('客户撤回')
  })

  it('runs unconfirmed stages through runWorkflow', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-'))
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store, model: fakeModel(), cwd: temp })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', inputText: '交底书', stages: STAGES }, exec)

    const run = (await tool.execute({ action: 'run', caseId: 'c' }, exec)) as FlexiblePlanOutput
    expect(run.run?.manifestId).toBe('flexible_c')
    expect(run.run?.completed).toBe(true)
    expect(run.run?.stages).toHaveLength(2)
  })

  it('rejects a blank caseId', async () => {
    const tool = createFlexiblePlanTool({ store: new MemoryPlanStore() })
    await expect(tool.execute({ action: 'get', caseId: '  ' }, exec)).rejects.toThrow(/caseId 不能为空/)
  })

  it('fails closed on create without caseType', async () => {
    const tool = createFlexiblePlanTool({ store: new MemoryPlanStore() })
    await expect(tool.execute({ action: 'create', caseId: 'c' }, exec)).rejects.toThrow('create 需要 caseType')
  })

  it('fails closed on a missing plan', async () => {
    const tool = createFlexiblePlanTool({ store: new MemoryPlanStore() })
    await expect(tool.execute({ action: 'get', caseId: 'nope' }, exec)).rejects.toThrow(PatentToolError)
  })

  it('fails closed on an unknown action via args validation', async () => {
    const tool = createFlexiblePlanTool({ store: new MemoryPlanStore() })
    await expect(tool.execute({ action: 'nope', caseId: 'c' }, exec)).rejects.toThrow('invalid arguments')
  })

  it('renders plan summary prose', () => {
    const plan: FlexiblePlanState = {
      caseId: 'c',
      caseType: 'drafting',
      status: 'active',
      stages: [
        { id: 'extract', name: '提取', goal: '提取特征', strategy: 'chain', status: 'pending', artifacts: [], constraintIds: [], articleJudgments: [] },
      ],
      currentStageId: 'extract',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const text = renderFlexiblePlan(
      { action: 'get', caseId: 'c' },
      { action: 'get', caseId: 'c', plan },
    )
    expect(text).toContain('flexible_plan(caseId=c, caseType=drafting, status=active)')
    expect(text).toContain('- ⏳ extract（chain）: 提取特征')
  })

  it('renders rich plan details and every mutation message', () => {
    const plan: FlexiblePlanState = {
      caseId: 'c',
      caseType: 'drafting',
      status: 'active',
      technicalField: '机械',
      stages: [
        {
          id: 'extract', name: '提取', goal: '提取特征', strategy: 'chain', status: 'pending',
          atom: 'extract', artifacts: ['a.md'], constraintIds: [], articleJudgments: [],
        },
        { id: 'report', name: '报告', goal: '生成报告', strategy: 'chain', status: 'confirmed', artifacts: [], constraintIds: [], articleJudgments: [] },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const get = renderFlexiblePlan({ action: 'get', caseId: 'c' }, { action: 'get', caseId: 'c', plan })
    expect(get).toContain('技术领域: 机械')
    expect(get).toContain('[atom:extract]')
    expect(get).toContain('（产物: 1 项）')
    expect(get).toContain('✅ report（chain）')

    const messages: Array<[FlexiblePlanAction, Record<string, unknown>]> = [
      ['confirm', { stageId: 'extract' }],
      ['rollback', { stageId: 'extract' }],
      ['add', { stage: { id: 'x', name: 'X', goal: 'g', strategy: 'chain' } }],
      ['remove', { stageId: 'extract' }],
      ['reorder', { stageIds: ['report', 'extract'] }],
      ['complete', {}],
      ['abandon', { reason: '客户撤回' }],
    ]
    for (const [action, args] of messages) {
      const out = renderFlexiblePlan({ action, caseId: 'c', ...args }, { action, caseId: 'c', plan })
      expect(out).toContain('flexible_plan(caseId=c')
    }
  })

  it('renders a stage-less plan with no current stage', () => {
    const plan: FlexiblePlanState = {
      caseId: 'c',
      caseType: 'drafting',
      status: 'active',
      stages: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const out = renderFlexiblePlan({ action: 'get', caseId: 'c' }, { action: 'get', caseId: 'c', plan })
    expect(out).toContain('（无待执行阶段）')
  })

  it('renders create and run prose', () => {
    const plan: FlexiblePlanState = {
      caseId: 'c',
      caseType: 'drafting',
      status: 'active',
      stages: [
        { id: 'extract', name: '提取', goal: '提取特征', strategy: 'chain', status: 'rolled_back', artifacts: [], constraintIds: [], articleJudgments: [] },
      ],
      currentStageId: 'extract',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const created = renderFlexiblePlan({ action: 'create', caseId: 'c' }, { action: 'create', caseId: 'c', plan })
    expect(created).toContain('已创建并持久化')
    expect(created).toContain('↩️ extract')

    const run: WorkflowRunResultLike = {
      manifestId: 'flexible_c',
      caseType: 'drafting',
      summary: 's',
      completed: true,
      stages: [{ stageId: 'extract', strategy: 'chain', output: 'out', degraded: false, retries: 0 }],
      degradedSteps: [],
    }
    const runText = renderFlexiblePlan(
      { action: 'run', caseId: 'c' },
      { action: 'run', caseId: 'c', plan, run: run as never, persistNote: '持久化: x' },
    )
    expect(runText).toContain('flexible_plan(run)')
    expect(runText).toContain('完成状态: completed')
    expect(runText).toContain('持久化: x')

    const bareRunText = renderFlexiblePlan(
      { action: 'run', caseId: 'c' },
      { action: 'run', caseId: 'c', plan, run: run as never },
    )
    expect(bareRunText).toContain('持久化: 未启用')

    const interrupted = renderFlexiblePlan(
      { action: 'run', caseId: 'c' },
      {
        action: 'run',
        caseId: 'c',
        plan,
        run: { ...run, interrupted: { stageId: 'report', message: '等待确认' } } as never,
        persistNote: '持久化: x',
      },
    )
    expect(interrupted).toContain('审批门暂停')
  })

  it('creates without stages, runs without a model, and runs without input text', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    const created = (await tool.execute(
      { action: 'create', caseId: 'c', caseType: 'drafting' },
      exec,
    )) as FlexiblePlanOutput
    expect(created.plan?.stages).toEqual([])
    expect(created.plan?.currentStageId).toBeUndefined()

    await expect(tool.execute({ action: 'run', caseId: 'c' }, exec)).rejects.toThrow('没有待执行阶段')

    const noModelStore = new MemoryPlanStore()
    const noModelTool = createFlexiblePlanTool({ store: noModelStore })
    await noModelTool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    await expect(noModelTool.execute({ action: 'run', caseId: 'c' }, exec)).rejects.toThrow('未提供模型客户端')

    const toolWithModel = createFlexiblePlanTool({ store: new MemoryPlanStore(), model: fakeModel(), cwd: join(tmpdir(), 'dsh-patent-tools-plan-run-') })
    await toolWithModel.execute({ action: 'create', caseId: 'c2', caseType: 'drafting', stages: STAGES }, exec)
    const run = (await toolWithModel.execute({ action: 'run', caseId: 'c2' }, exec)) as FlexiblePlanOutput
    expect(run.run?.manifestId).toBe('flexible_c2')
  })

  it('wraps a non-Error store failure as tool_execution_failed', async () => {
    const throwing = {
      savePlan: async () => { throw 'save-boom' },
      loadPlan: async () => { throw 'load-boom' },
      listCaseIds: async () => [],
    } as unknown as FlexiblePlanStore
    const tool = createFlexiblePlanTool({ store: throwing })
    let err: unknown
    try {
      await tool.execute({ action: 'get', caseId: 'c' }, exec)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PatentToolError)
    expect((err as { message: string }).message).toContain('load-boom')
  })

  it('fails closed on every mutation missing its argument', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['confirm', {}],
      ['rollback', {}],
      ['add', {}],
      ['remove', {}],
      ['reorder', {}],
      ['abandon', {}],
      ['abandon', { reason: '  ' }],
    ]
    for (const [action, args] of cases) {
      await expect(tool.execute({ action, caseId: 'c', ...args }, exec)).rejects.toThrow(PatentToolError)
    }
  })

  it('creates a plan through the default on-disk store', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-plan-'))
    const tool = createFlexiblePlanTool({ cwd: temp, now: () => '2024-01-01T00:00:00.000Z' })
    const created = (await tool.execute({
      action: 'create',
      caseId: 'disk-case',
      caseType: 'drafting',
      inputText: '交底书',
      technicalField: '软件',
      stages: [{ id: 'extract', name: '提取', goal: 'g', strategy: 'chain', atom: 'extract', params: { p: 1 } }],
    }, exec)) as FlexiblePlanOutput
    expect(created.plan?.technicalField).toBe('软件')
    expect(created.plan?.stages[0]?.atom).toBe('extract')
    expect(created.plan?.stages[0]?.params).toEqual({ p: 1 })
  })

  it('runs with auto-confirm, input override, and max results', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-'))
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store, model: fakeModel(), cwd: temp })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    const run = (await tool.execute({
      action: 'run', caseId: 'c', inputText: '新交底书', maxResults: 3, autoConfirm: true,
    }, exec)) as FlexiblePlanOutput
    expect(run.run?.completed).toBe(true)
    expect(run.plan?.stages.every(s => s.status === 'confirmed' || s.status === 'pending')).toBe(true)
  })

  it('renders through the registered tool', async () => {
    const store = new MemoryPlanStore()
    const tool = createFlexiblePlanTool({ store })
    await tool.execute({ action: 'create', caseId: 'c', caseType: 'drafting', stages: STAGES }, exec)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(tool)
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('fp-1'),
      name: 'flexible_plan',
      arguments: { action: 'get', caseId: 'c' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(text).toContain('flexible_plan(caseId=c')
  })

  it('wraps broken-store failures as tool_execution_failed', async () => {
    const throwing = {
      savePlan: async () => { throw 'save-boom' },
      loadPlan: async () => { throw new Error('load-boom') },
      listCaseIds: async () => [],
    } as unknown as FlexiblePlanStore
    const tool = createFlexiblePlanTool({ store: throwing })
    let err: unknown
    try {
      await tool.execute({ action: 'get', caseId: 'c' }, exec)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PatentToolError)
    expect((err as { message: string }).message).toContain('load-boom')
  })
})
