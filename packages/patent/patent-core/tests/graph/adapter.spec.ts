import { expect, it } from 'vitest'
import {
  APPROVAL_GRANTED_KEY,
  ApprovalGateHandler,
  AtomRegistry,
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  InMemoryCheckpointStore,
  InterruptStageError,
  StageHandlerRegistry,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  grantApproval,
  manifestToGraph,
  registerBuiltinAtoms,
  runGraphWithCheckpoints,
  type StageHandler,
  type StageProvider,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-core'
import { APPROVAL_GRANTED_NODES_KEY } from '../../src/atoms/handlers/builtin/gate.ts'
import { GraphBuilder } from '../../src/graph/engine.ts'
import { handlerNode } from '../../src/graph/domains/shared.ts'

registerBuiltinAtoms()

// ---------------------------------------------------------------------------
// mock provider（prompt 特征匹配，对齐 tests/patent/atoms.spec.ts 风格）
// ---------------------------------------------------------------------------

const provider: StageProvider = {
  callLLM: async (prompt) => {
    if (prompt.includes('技术分析助手')) {
      return JSON.stringify({ features: ['特征A', '特征B'], problems: ['问题1'], effects: ['效果1'] })
    }
    if (prompt.includes('交底书分析师')) {
      return JSON.stringify({
        scores: [
          { feature: '特征A', score: 0.9, reason: '原文记载' },
          { feature: '特征B', score: 0.3, reason: '推断' },
        ],
        feedback: '特征B依据不足',
      })
    }
    if (prompt.includes('检索关键词')) {
      return JSON.stringify({ keywords: ['分拣', '自动化', '传感器'] })
    }
    if (prompt.includes('新颖性分析专家')) {
      return JSON.stringify({
        assessments: [{ feature: '特征A', prior_art: 'D1', disclosed: false, reasoning: '未公开' }],
        conclusion: '具备新颖性（置信度 0.8）',
      })
    }
    if (prompt.includes('权利要求撰写专家')) {
      return JSON.stringify({
        claims: ['1. 一种自动化分拣装置，其特征在于，包括传送带与识别传感器。'],
        notes: '独立权利要求',
      })
    }
    return '默认推理结论'
  },
  search: async query => [{ title: `文献: ${query}`, snippet: '摘要', url: 'https://example.com/1' }],
}

const okExecutor = (stage: WorkflowStage, ctx: WorkflowContext): Promise<string> =>
  Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ''}`)

// ---------------------------------------------------------------------------
// handlerNode
// ---------------------------------------------------------------------------

it('handlerNode: 普通 handler 作为图节点执行', async () => {
  const handler: StageHandler = {
    name: 't',
    category: 'extract',
    execute: async () => ({ out: 'hello' }),
  }
  const builder = new GraphBuilder()
  builder.addNode('t', handlerNode(handler)).addEdge('t', '__end__')
  const graph = builder.compile('t')
  const result = await graph.run({})
  expect(result.state.out).toBe('hello')
})

it('handlerNode: InterruptStageError 转 GraphInterruptError（引擎暂停）', async () => {
  const handler: StageHandler = {
    name: 'approve',
    category: 'gate',
    execute: async () => {
      throw new InterruptStageError('approve', '需要确认', { ctx: 'x' })
    },
  }
  const builder = new GraphBuilder()
  builder
    .addNode('approve', handlerNode(handler))
    .addNode('after', async () => ({ never: true }))
    .addEdge('approve', 'after')
  const graph = builder.compile('approve')
  const result = await graph.run({})
  expect(result.completed).toBe(false)
  expect(result.interrupted).toEqual({ node: 'approve', message: '需要确认', data: { ctx: 'x' } })
  expect(result.state.never).toBeUndefined()
})

// ---------------------------------------------------------------------------
// manifestToGraph（WorkflowManifest → 图）
// ---------------------------------------------------------------------------

it('handlerNode: 审批门按门粒度构建执行态放行（共享 state 不含放行布尔）', async () => {
  // 放行记录里的门 id 与本节点在图内的名字一致 → 放行；不一致 → 仍中断（不外溢）。
  const buildOnce = (state: Record<string, unknown>) => {
    const builder = new GraphBuilder()
    builder.addNode('gate', handlerNode(new ApprovalGateHandler())).addEdge('gate', '__end__')
    return builder.compile('gate').run(state)
  }

  const approved = await buildOnce({ [APPROVAL_GRANTED_NODES_KEY]: ['gate'] })
  expect(approved.completed).toBe(true)
  expect(approved.interrupted).toBeUndefined()
  expect(approved.state[APPROVAL_GRANTED_KEY]).toBeUndefined()

  const other = await buildOnce({ [APPROVAL_GRANTED_NODES_KEY]: ['another-gate'] })
  expect(other.completed).toBe(false)
  expect(other.interrupted?.node).toBe('gate')
})

it('manifestToGraph: 简单线性 manifest 输出各阶段结果', async () => {
  const manifest: WorkflowManifest = {
    id: 'equiv_linear',
    name: '线性等价',
    caseType: 'test',
    stages: [
      { id: 's1', strategy: 'chain', description: '一' },
      { id: 's2', strategy: 'chain', description: '二' },
      { id: 's3', strategy: 'chain', description: '三' },
    ],
  }
  const ctx = { input: '输入' }
  const graph = manifestToGraph(manifest, { executor: okExecutor })
  const gr = await graph.run({ ...ctx })
  expect(gr.completed).toBe(true)
  for (const stage of manifest.stages) {
    expect(gr.state[stage.id]).toBe(await okExecutor(stage, ctx))
  }
})

it('manifestToGraph: handler 返回 _error → 节点级降级标记且不泄漏内部键', async () => {
  const handlers = new StageHandlerRegistry()
  const atoms = new AtomRegistry()
  handlers.register({
    name: 'degraded-atom',
    category: 'extract',
    execute: async () => ({
      result: '部分结果',
      [DEGRADED_ERROR_KEY]: '[degraded-atom] 缺少输入',
      [DEGRADED_RETRYABLE_KEY]: true,
    }),
  })
  atoms.register({
    name: 'degraded-atom',
    description: '降级语义',
    category: 'extract',
    inputSchema: [],
    outputSchema: ['result'],
  })
  const manifest: WorkflowManifest = {
    id: 'degraded_node',
    name: '降级节点',
    caseType: 'test',
    stages: [{ id: 's1', strategy: 'chain', description: '降级', atom: 'degraded-atom' }],
  }
  const gr = await manifestToGraph(manifest, { handlers, atoms }).run({})
  expect(gr.state.s1).toBe('部分结果')
  expect(gr.state[DEGRADED_ERROR_KEY]).toBeUndefined()
  expect(gr.state[DEGRADED_RETRYABLE_KEY]).toBeUndefined()
  expect(gr.degraded).toEqual([
    { reason: 'node_failed', message: '[degraded-atom] 缺少输入（可重试）', severity: 'critical' },
  ])
})

it('manifestToGraph: executor 收到累积执行态（consumes 声明的上游产出可读）', async () => {
  const manifest: WorkflowManifest = {
    id: 'equiv_consumes',
    name: '链式依赖',
    caseType: 'test',
    stages: [
      { id: 's1', strategy: 'chain', description: '一' },
      { id: 's2', strategy: 'chain', description: '二', consumes: ['s1'] },
    ],
  }
  const seen: unknown[] = []
  const graph = manifestToGraph(manifest, {
    executor: async (stage, _ctx, state) => {
      seen.push({ ...state })
      return `${stage.id} 产出`
    },
  })
  await graph.run({ input: '输入' })
  expect(seen[0]).not.toHaveProperty('s1')
  expect(seen[1]).toMatchObject({ input: '输入', s1: 's1 产出' })
})

it('manifestToGraph: 门粒度放行记录命中后审批门阶段放行（不中断）', async () => {
  const manifest: WorkflowManifest = {
    id: 'gate_approved',
    name: '审批门放行',
    caseType: 'test',
    stages: [
      { id: 'gate', strategy: 'chain', description: '审批', atom: 'approval-gate' },
      { id: 's2', strategy: 'chain', description: '后续' },
    ],
  }
  const graph = manifestToGraph(manifest, { executor: okExecutor })
  const store = new InMemoryCheckpointStore()

  // 第一次：审批门中断（未批准）。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'gate_approved' })
  expect(first.result.completed).toBe(false)
  expect(first.result.interrupted?.node).toBe('gate')

  // 人工批准该门：门粒度放行记录写入 checkpoint state（不是全局布尔）。
  const granted = await grantApproval(store, first.checkpointId!)
  expect(granted!.state[APPROVAL_GRANTED_NODES_KEY]).toEqual(['gate'])

  // resume：门节点按自身 id 判定放行 → handler 收到执行态放行标记 → 不再中断。
  const second = await runGraphWithCheckpoints(graph, {}, {
    store,
    graphId: 'gate_approved',
    resumeFrom: granted!,
  })
  expect(second.result.completed).toBe(true)
  expect(second.result.interrupted).toBeUndefined()
  expect(second.result.state.s2).toBe('[s2] 完成。输入: ')
})

it('manifestToGraph: retry 回退重跑 extract', async () => {
  const retryManifest: WorkflowManifest = {
    id: 'equiv_retry',
    name: '回退等价',
    caseType: 'test',
    stages: [
      {
        id: 'extract',
        strategy: 'chain',
        description: '提取',
        atom: 'extract',
        params: { extraction_type: '提取技术特征', output_key: 'features' },
      },
      {
        id: 'check',
        strategy: 'chain',
        description: '一致性检查',
        retry: { whenOutputMatches: '不一致', rewindTo: 'extract', maxRetries: 1 },
      },
      { id: 'done', strategy: 'chain', description: '结束' },
    ],
  }
  const grExecutor = makeFlakyExecutor()
  const ctx = { input: '一种装置' }

  const graph = manifestToGraph(retryManifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor: grExecutor.fn,
    provider,
  })
  const gr = await graph.run({ ...ctx })

  // 回退触发：extract 被重跑两次，check 最终输出 "一致"。
  expect(gr.state.check).toBe('一致')
  expect(grExecutor.calls()).toBe(2)
  expect(gr.state.done).toBe('[done] 完成')
})

it('manifestToGraph: 只声明结构化触发的 retry 阶段没有文本回退边', async () => {
  // whenRevisionRequested 由 workflow 执行器消费；图路径只认识文本信号，
  // 未声明 whenOutputMatches 时该阶段直连下一节点。
  const manifest: WorkflowManifest = {
    id: 'equiv_revision_only',
    name: '结构化回退',
    caseType: 'test',
    stages: [
      { id: 's1', strategy: 'chain', description: '一' },
      { id: 's2', strategy: 'chain', description: '二', retry: { whenRevisionRequested: true, rewindTo: 's1' } },
    ],
  }
  const gr = await manifestToGraph(manifest, { executor: okExecutor }).run({ input: '输入' })
  expect(gr.completed).toBe(true)
  expect(gr.state.s2).toBe('[s2] 完成。输入: 输入')
})

/** 第 1 次返回"存在不一致"（触发回退），之后"一致"；记录调用次数。 */
function makeFlakyExecutor(): { fn: (stage: WorkflowStage) => Promise<string>; calls: () => number } {
  const state = { calls: 0 }
  return {
    calls: () => state.calls,
    fn: async (stage: WorkflowStage) => {
      if (stage.id === 'check') {
        state.calls += 1
        return state.calls === 1 ? '存在不一致' : '一致'
      }
      return `[${stage.id}] 完成`
    },
  }
}

// ---------------------------------------------------------------------------
// 回退清理：不残留混代
// ---------------------------------------------------------------------------

it('manifestToGraph: 回退重跑中某路提取解析失败 → 旧一代 outputSchema 键被清理', async () => {
  // 两路 extract 分键产出 features / problems；check 回退到第一路。
  // 第 2 轮特征路返回非 JSON（extract 只写 extraction_result），故 features 无人写回。
  // 若回退只删 stage-id 键，第 1 轮的 features 会残留成"混代"结果。
  const manifest: WorkflowManifest = {
    id: 'equiv_no_stale_outputs',
    name: '回退清理',
    caseType: 'test',
    stages: [
      {
        id: 'extract_features',
        strategy: 'chain',
        description: '提取特征',
        atom: 'extract',
        params: { extraction_type: '提取技术特征', output_key: 'features' },
      },
      {
        id: 'extract_problems',
        strategy: 'chain',
        description: '提取问题',
        atom: 'extract',
        params: { extraction_type: '提取技术问题', output_key: 'problems' },
      },
      {
        id: 'check',
        strategy: 'chain',
        description: '一致性检查',
        retry: { whenOutputMatches: '不一致', rewindTo: 'extract_features', maxRetries: 1 },
      },
    ],
  }
  const executor = makeCheckExecutor()
  const graph = manifestToGraph(manifest, {
    handlers: globalStageHandlerRegistry,
    atoms: globalAtomRegistry,
    executor: executor.fn,
    provider: makeMixedGenerationProvider(),
  })
  const gr = await graph.run({ text: '一种分拣装置，包括传送带与识别传感器。' })

  expect(executor.calls()).toBe(2)
  expect(gr.state.features).toBeUndefined()
  expect(gr.state.problems).toEqual(['新问题'])
  expect(gr.completed).toBe(true)
})

/** 第 2 轮特征路返回非 JSON（extract 解析失败兜底只写 extraction_result）。 */
function makeMixedGenerationProvider(): StageProvider {
  let featureRounds = 0
  return {
    callLLM: async (prompt) => {
      if (prompt.includes('提取技术特征')) {
        featureRounds += 1
        return featureRounds > 1 ? '这不是 JSON' : JSON.stringify({ features: ['旧特征'] })
      }
      if (prompt.includes('提取技术问题')) {
        return JSON.stringify({ features: [], problems: [featureRounds > 1 ? '新问题' : '旧问题'] })
      }
      return '默认推理结论'
    },
    search: async () => [],
  }
}

/** 第 1 次"存在不一致"触发回退，之后"一致"；记录 check 调用次数。 */
function makeCheckExecutor(): { fn: (stage: WorkflowStage) => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    fn: async (stage: WorkflowStage) => {
      if (stage.id === 'check') {
        calls += 1
        return calls === 1 ? '存在不一致' : '一致'
      }
      return `[${stage.id}] 完成`
    },
  }
}

it('manifestToGraph: 未知 atom fail-fast', () => {
  const manifest: WorkflowManifest = {
    id: 'bad',
    name: '未知原子',
    caseType: 'test',
    stages: [{ id: 's1', strategy: 'chain', description: '一', atom: 'no-such-atom' }],
  }
  expect(() => manifestToGraph(manifest)).toThrow(/未知 atom/)
  expect(() => manifestToGraph(manifest)).toThrow(/请确认已加载提供该原子的插件/)
})
