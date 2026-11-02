import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GraphBuilder,
  GraphEngineError,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  KeywordsHandler,
  StageHandlerRegistry,
  buildEnablementGraph,
  buildInventivenessGraph,
  buildNoveltyGraph,
  cloneState,
  extractEnablementResult,
  extractInventivenessResult,
  extractNumericRanges,
  manifestToGraph,
  mergeWithSchema,
  registerBuiltinAtoms,
  runGraphWithCheckpoints,
  runNodeWithPolicy,
  runStageHandler,
  type GraphCheckpoint,
  type GraphState,
  type RuleEvaluator,
  type StageHandler,
  type StageProvider,
  type WorkflowManifest,
} from '@deepseek-ai/dsh-patent-core'

registerBuiltinAtoms()

/** 规则门评估器替身：覆盖图接线与审计键，不加载规则语料。 */
const stubRuleEvaluator: RuleEvaluator = {
  id: 'test:stub-rules',
  evaluate: () => ({ verdict: 'pass', failures: [], evaluatedRules: 1 }),
}

// ---------------------------------------------------------------------------
// 状态工具 / 合并
// ---------------------------------------------------------------------------

it('cloneState：structuredClone 失败时降级 JSON 往返', () => {
  const state = { fn: (): void => undefined } as unknown as GraphState
  expect(cloneState(state)).toEqual({})
})

it('mergeWithSchema：union 对象/空值去重键', () => {
  const state: GraphState = {}
  mergeWithSchema(state, [{ node: 'a', delta: { list: [{ id: 1 }, null, 'x'] } }], { list: 'union' })
  expect(state.list).toEqual([{ id: 1 }, null, 'x'])

  const dedup: GraphState = {}
  mergeWithSchema(dedup, [
    { node: 'a', delta: { list: [{ id: 1 }] } },
    { node: 'b', delta: { list: [{ id: 1 }] } },
  ], { list: 'union' })
  expect(dedup.list).toEqual([{ id: 1 }])
})

it('mergeWithSchema：merge_map 非对象兜底', () => {
  const state: GraphState = { m: 'not-an-object' }
  mergeWithSchema(state, [{ node: 'a', delta: { m: { b: 2 } } }], { m: 'merge_map' })
  expect(state.m).toEqual({ b: 2 })

  const state2: GraphState = { m: { a: 1 } }
  mergeWithSchema(state2, [{ node: 'a', delta: { m: 'scalar' } }], { m: 'merge_map' })
  expect(state2.m).toEqual({ a: 1 })
})

// ---------------------------------------------------------------------------
// 节点策略：超时边界 / 取消 / 兜底
// ---------------------------------------------------------------------------

it('runNodeWithPolicy：重试间隔越过总时长时第二轮回合即超时', async () => {
  const fastFail = async (): Promise<GraphState> => { throw new Error('fast') }
  const outcome = await runNodeWithPolicy(fastFail, { maxRetries: 1, retryDelayMs: 100, timeoutMs: 20 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect((outcome as { error: Error }).error.message).toMatch(/fast/)
})

it('runNodeWithPolicy：已中止的调用方 signal 联动取消', async () => {
  const controller = new AbortController()
  controller.abort()
  const outcome = await runNodeWithPolicy(async () => ({ done: true }), undefined, {
    state: {},
    signal: controller.signal,
  })
  expect(outcome.ok).toBe(false)
  expect((outcome as { error: Error }).error.message).toMatch(/取消/)
})

it('runNodeWithPolicy：maxRetries 负数时循环不执行 → 兜底错误', async () => {
  const outcome = await runNodeWithPolicy(async () => ({ x: 1 }), { maxRetries: -1 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect((outcome as { error: Error }).error.message).toBe('节点执行失败')
})

it('runNodeWithPolicy：节点在超时后返回结果 → 判为超时而非采信', async () => {
  const late = async (): Promise<GraphState> => {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    return { late: true }
  }
  const outcome = await runNodeWithPolicy(late, { timeoutMs: 20 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect((outcome as { error: Error }).error.message).toContain('超时')
})

// ---------------------------------------------------------------------------
// 引擎：编译校验 / 取消 / 非 Error 失败 / 护栏 / 缺失节点
// ---------------------------------------------------------------------------

it('engine：setSchema 与编译校验（边指向未注册节点）', () => {
  const builder = new GraphBuilder()
  builder.addNode('a', async () => ({ v: 1 })).setSchema({ v: 'append' })
  const bad = new GraphBuilder()
  bad.addNode('a', async () => ({})).addEdge('a', 'ghost')
  expect(() => bad.compile('a')).toThrow(GraphEngineError)
})

it('engine：已中止 signal 直接取消；节点抛非 Error 降级', async () => {
  const g = new GraphBuilder().addNode('a', async () => ({ x: 1 })).addEdge('a', '__end__').compile('a')
  const controller = new AbortController()
  controller.abort()
  await expect(g.run({}, { signal: controller.signal })).rejects.toThrow(/已取消/)

  const g2 = new GraphBuilder()
    .addNode('a', async () => { throw 'boom' })
    .addEdge('a', '__end__')
    .compile('a')
  const r2 = await g2.run({}, { provider: {} })
  expect(String((r2.state.a__degradation as { message?: unknown })?.message)).toBe('boom')
})

it('engine：运行期间取消上报为取消（signal 透传路径）', async () => {
  const g = new GraphBuilder()
    .addNode('a', async () => { controller.abort(); return { x: 1 } })
    .addEdge('a', '__end__')
    .compile('a')
  const controller = new AbortController()
  await expect(g.run({}, { signal: controller.signal })).rejects.toThrow(/已取消/)
})

it('engine：LLM 调用中取消穿透 handler 与节点策略，全图拒绝而不是节点降级', async () => {
  const controller = new AbortController()
  const handlers = new StageHandlerRegistry()
  handlers.register(new KeywordsHandler())
  const manifest: WorkflowManifest = {
    id: 'cancel_llm', name: '取消穿透', caseType: 'test',
    stages: [{ id: 'kw', strategy: 'chain', description: '关键词', atom: 'keywords' }],
  }
  const provider: StageProvider = {
    callLLM: (_prompt, _opts, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      controller.abort()
    }),
  }
  const g = manifestToGraph(manifest, { handlers, provider })
  await expect(g.run({ input: '一种过滤装置' }, { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'keywords' })
})

it('engine：maxSteps 耗尽触发护栏（completed=false）', async () => {
  const g = new GraphBuilder()
    .addNode('a', async () => ({ v: 1 }))
    .setConditionalEdge('a', () => ['a'])
    .compile('a', 3)
  const r = await g.run({})
  expect(r.completed).toBe(false)
  expect(r.steps).toBe(3)
})

it('engine：resume 时 active 引用缺失节点 → 节点级降级而非崩溃', async () => {
  const g = new GraphBuilder().addNode('a', async () => ({ x: 1 })).addEdge('a', '__end__').compile('a')
  const cp: GraphCheckpoint = { id: 'c', graphId: 'g', stepIndex: 0, state: {}, activeNodes: ['ghost'], createdAt: 1 }
  const r = await g.resume(cp)
  expect(r.completed).toBe(true)
  expect(String((r.state.ghost__degradation as { message?: unknown })?.message)).toMatch(/未注册/)
})

// ---------------------------------------------------------------------------
// 适配层：runStageHandler 与 manifestToGraph
// ---------------------------------------------------------------------------

it('runStageHandler：普通错误重抛与无 provider', async () => {
  const throwing: StageHandler = {
    name: 'boom',
    category: 'extract',
    execute: async () => { throw new Error('inner') },
  }
  await expect(runStageHandler(throwing, {})).rejects.toThrow('inner')
  const ok: StageHandler = { name: 'ok', category: 'extract', execute: async () => ({ x: 1 }) }
  expect(await runStageHandler(ok, {})).toEqual({ x: 1 })
})

it('manifestToGraph：无 handler/executor 阶段降级 + executor-only', async () => {
  const manifest: WorkflowManifest = {
    id: 'm3', name: 'n', caseType: 'test',
    stages: [{ id: 's1', strategy: 'chain', description: '一' }],
  }
  const g = manifestToGraph(manifest)
  const r = await g.run({})
  expect(r.state.s1__degraded).toBe(true)
  expect(r.completed).toBe(true)

  const withExec: WorkflowManifest = {
    id: 'm4', name: 'n', caseType: 'test',
    stages: [{ id: 's1', strategy: 'chain', description: '一' }, { id: 's2', strategy: 'chain', description: '二' }],
  }
  const executor = async (stage: { id: string }): Promise<string> => `[${stage.id}] 完成`
  const g2 = manifestToGraph(withExec, { executor })
  const r2 = await g2.run({})
  expect(r2.state.s1).toBe('[s1] 完成')
  expect(r2.state.s2).toBe('[s2] 完成')
})

it('manifestToGraph：retry 缺省 maxRetries/rewindTo 并超限 fail-open', async () => {
  const manifest: WorkflowManifest = {
    id: 'm5', name: 'n', caseType: 'test',
    stages: [
      { id: 's1', strategy: 'chain', description: '一' },
      { id: 's2', strategy: 'chain', description: '二', retry: { whenOutputMatches: '重试' } },
      { id: 's3', strategy: 'chain', description: '三' },
    ],
  }
  let calls = 0
  const executor = async (stage: { id: string }): Promise<string> => {
    if (stage.id === 's2') {
      calls += 1
      return '需要重试'
    }
    return `[${stage.id}] 完成`
  }
  const g = manifestToGraph(manifest, { executor })
  const r = await g.run({})
  expect(calls).toBe(2) // 首跑 + 一次回退重跑
  expect(r.state.s2__retry_exhausted).toBe(true)
  expect(r.state.s3).toBe('[s3] 完成')
})

it('manifestToGraph：handler 主输出键字符串与非字符串', async () => {
  // merge 主输出 pfe_triples 为数组；draft-claims 主输出 claims_draft 为字符串。
  const manifest: WorkflowManifest = {
    id: 'm6', name: 'n', caseType: 'test',
    stages: [
      { id: 'm', strategy: 'chain', description: '融合', atom: 'merge' },
      { id: 'd', strategy: 'chain', description: '撰写', atom: 'draft-claims' },
    ],
  }
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify({ claims: ['1. 一种装置'], notes: 'n' }),
  }
  const strategyState = {
    claim_strategy: JSON.stringify({
      invention_name: '装置',
      tech_domain: 'general',
      essential_features: [{ id: 'F1', text: '壳体', anchor: '壳体', anchor_reason: 'exact' }],
      optional_features: [],
      dependent_tree: [],
      prior_art_ref: null,
      prior_art_text: '',
    }),
  }
  const g = manifestToGraph(manifest, { provider })
  const r = await g.run({ problems: ['P1'], features: ['F1'], effects: [], ...strategyState })
  expect(JSON.parse(String(r.state.m))).toEqual([{ id: 'T1', problem: 'P1', features: ['F1'], effects: [] }])
  expect(String(r.state.d)).toContain('1. 一种装置')

  // deps.provider 缺省 → 节点上下文 provider 兜底（deps.provider ?? provider 路径 2）
  const gNoDeps = manifestToGraph(manifest)
  const rNoDeps = await gNoDeps.run(
    { problems: ['P1'], features: ['F1'], effects: [], ...strategyState },
    { provider },
  )
  expect(String(rNoDeps.state.d)).toContain('1. 一种装置')
})

it('manifestToGraph：approval-gate 主输出键缺失 → 中断暂停', async () => {
  const manifest: WorkflowManifest = {
    id: 'm7', name: 'n', caseType: 'test',
    stages: [{ id: 'gate', strategy: 'chain', description: '审批', atom: 'approval-gate' }],
  }
  const g = manifestToGraph(manifest)
  const r = await g.run({})
  expect(r.completed).toBe(false)
  expect(r.interrupted?.node).toBe('gate')
})

it('manifestToGraph：空 outputSchema 原子的主输出键缺省路径', async () => {
  const { AtomRegistry } = await import('@deepseek-ai/dsh-patent-core')
  const atoms = new AtomRegistry()
  atoms.register({ name: 'empty-out', description: 'd', category: 'search', inputSchema: [], outputSchema: [] })
  const handlers = new StageHandlerRegistry()
  handlers.register({ name: 'empty-out', category: 'search', execute: async () => ({ marker: 'x' }) })
  const manifest: WorkflowManifest = {
    id: 'm8', name: 'n', caseType: 'test',
    stages: [{ id: 's1', strategy: 'chain', description: '一', atom: 'empty-out' }],
  }
  const g = manifestToGraph(manifest, { handlers, atoms })
  const r = await g.run({})
  expect(r.state.marker).toBe('x')
  expect(r.state.s1).toBe('') // 主输出键缺失 → 输出兜底空串
})

// ---------------------------------------------------------------------------
// 检查点：同 stepIndex 排序 / 空存储 / 透传选项
// ---------------------------------------------------------------------------

it('InMemoryCheckpointStore：同 stepIndex 按 createdAt 排序 + loadLatest 空', async () => {
  const store = new InMemoryCheckpointStore()
  const mk = (id: string, stepIndex: number, createdAt: number): GraphCheckpoint =>
    ({ id, graphId: 'g', stepIndex, state: {}, activeNodes: [], createdAt })
  await store.save(mk('c1', 1, 10))
  await store.save(mk('c2', 1, 20))
  await store.save(mk('c3', 2, 5))
  expect((await store.loadLatest('g'))?.id).toBe('c3')
  expect(await store.list('g')).toEqual(['c1', 'c2', 'c3'])
  expect(await store.loadLatest('other')).toBeUndefined()
})

it('JsonFileCheckpointStore：多检查点排序与空存储 loadLatest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sati-cp-cov-'))
  try {
    const store = new JsonFileCheckpointStore(dir)
    await store.save({ id: 'j1', graphId: 'g', stepIndex: 1, state: { a: 1 }, activeNodes: [], createdAt: 1 })
    await store.save({ id: 'j2', graphId: 'g', stepIndex: 1, state: { b: 2 }, activeNodes: [], createdAt: 2 })
    await store.save({ id: 'x1', graphId: 'other', stepIndex: 0, state: {}, activeNodes: [], createdAt: 0 })
    expect(await store.list('g')).toEqual(['j1', 'j2'])
    expect((await store.loadLatest('g'))?.id).toBe('j2')
    expect(await store.loadLatest('zzz')).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('runGraphWithCheckpoints：选项透传与无检查点路径', async () => {
  const fake = {
    run: async () => ({ completed: true, steps: 0, state: {}, degraded: [] }),
    resume: async () => ({ completed: true, steps: 0, state: {}, degraded: [] }),
  }
  const store = new InMemoryCheckpointStore()
  const r = await runGraphWithCheckpoints(fake, {}, {
    store,
    graphId: 'g',
    provider: {},
    failFast: true,
    signal: new AbortController().signal,
  })
  expect(r.result.completed).toBe(true)
  expect(r.checkpointId).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 领域子图：缺省/降级/自定义注册表
// ---------------------------------------------------------------------------

it('extractNumericRanges：空文本返回空数组', () => {
  expect(extractNumericRanges('')).toEqual([])
})

it('novelty：数值范围节点在无 LLM 时降级', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph.compile('extract').run({ text: '温度超过100度时失效' })
  expect(String(r.state.numeric_range_result)).toMatch(/需 LLM 专项判定/)
  expect(r.completed).toBe(true)
})

it('novelty：数值范围 LLM 失败（Error 与非 Error）降级', async () => {
  const throwing: StageProvider = {
    callLLM: async () => { throw new Error('timeout') },
  }
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph.compile('extract').run({ text: '温度超过100度时失效' }, { provider: throwing })
  expect(String(r.state.numeric_range_result)).toMatch(/LLM 错误/)
  expect(String((r.state.numeric_range_result__degradation as { message?: unknown })?.message)).toContain('timeout')

  const throwingStr: StageProvider = { callLLM: async () => { throw 'boom' } }
  const r2 = await graph.compile('extract').run({ text: '温度超过100度时失效' }, { provider: throwingStr })
  expect(String((r2.state.numeric_range_result__degradation as { message?: unknown })?.message)).toContain('boom')
})

it('novelty：数值范围空结果时 conclude 兜底文本', async () => {
  // 数值范围返回空串 → 空兜底分支；conclude 回显 prompt 以断言兜底文本。
  const provider: StageProvider = {
    callLLM: async (prompt: string) => (prompt.includes('专项新颖性判定') ? '' : prompt),
  }
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph.compile('extract').run({ text: '温度超过100度时失效' }, { provider })
  expect(String(r.state.novelty_report)).toContain('（无对比结果）')
  expect(String(r.state.novelty_report)).toContain('（无）')
  expect(String(r.state.novelty_report)).toContain('unknown')
})

it('novelty：缺少 extract 内置原子抛错', () => {
  expect(() => buildNoveltyGraph({ handlers: new StageHandlerRegistry() })).toThrow(/缺少内置原子 extract/)
})

it('novelty：注册表缺 keywords/search/novelty 时链路直连', async () => {
  const registry = new StageHandlerRegistry()
  const extract: StageHandler = {
    name: 'extract',
    category: 'extract',
    execute: async () => ({ features: ['F1'], extraction_result: 'x' }),
  }
  registry.register(extract)
  const graph = buildNoveltyGraph({ handlers: registry, includeApproval: false, ruleGate: false }).compile('extract')
  const r = await graph.run({ text: '温度超过100度时失效' }, {
    provider: { callLLM: async () => JSON.stringify({ a: 1 }) },
  })
  expect(r.state.numeric_ranges).toBeDefined()
  expect(r.completed).toBe(true)
})

it('novelty：ruleGate 关闭时尾链直连 END', () => {
  const graph = buildNoveltyGraph({ ruleGate: false })
  expect(graph.compile('extract').describe().nodes).not.toContain('rule_gate')
  // includeApproval=false 且 ruleGate 开启 → else 分支直连 rule_gate
  const graph2 = buildNoveltyGraph({ includeApproval: false, ruleEvaluator: stubRuleEvaluator })
  expect(graph2.compile('extract').describe().nodes).toContain('rule_gate')
})

it('novelty：注册表缺 search 但含 keywords 时链路直连', () => {
  const registry = new StageHandlerRegistry()
  registry.register({ name: 'extract', category: 'extract', execute: async () => ({}) })
  registry.register({ name: 'keywords', category: 'search', execute: async () => ({ keywords: ['k'] }) })
  const graph = buildNoveltyGraph({ handlers: registry, includeApproval: false, ruleGate: false }).compile('extract')
  expect(graph.describe().nodes).toContain('keywords')
  expect(graph.describe().nodes).not.toContain('search')
})

it('inventiveness：无 search/approval 与 extractResult 兜底', async () => {
  const registry = new StageHandlerRegistry()
  const noop: StageHandler = { name: 'search', category: 'search', execute: async () => ({}) }
  registry.register(noop)
  const builder = buildInventivenessGraph({ handlers: registry, includeApproval: false, ruleGate: false })
  const graph = builder.compile('parse')
  const provider: StageProvider = { callLLM: async () => '结果' }
  const r = await graph.run({}, { provider })
  expect(r.completed).toBe(true)
  expect(r.state.inventiveness_conclusion).toBe('结果')
  // extractInventivenessResult 解析兜底
  expect(extractInventivenessResult({})).toEqual({})
  expect(extractInventivenessResult({ inventiveness_conclusion: 'not-json' })).toEqual({})
  expect(extractInventivenessResult({ inventiveness_conclusion: '{"inventive": "yes"}' })).toEqual({})
  expect(extractInventivenessResult({
    inventiveness_conclusion: '{"inventive": true, "confidence": "high", "report": "r"}',
  })).toEqual({ inventive: true, confidence: 'high', report: 'r' })
})

it('inventiveness：空注册表直连 closest；ruleGate 关闭', () => {
  const builder = buildInventivenessGraph({ handlers: new StageHandlerRegistry(), ruleGate: false })
  const graph = builder.compile('parse')
  expect(graph.describe().nodes).not.toContain('rule_gate')
  expect(graph.describe().nodes).not.toContain('search')
  // includeApproval=false 且 ruleGate 开启 → else 分支直连 rule_gate
  const graph2 = buildInventivenessGraph({ includeApproval: false, ruleEvaluator: stubRuleEvaluator })
  expect(graph2.compile('parse').describe().nodes).toContain('rule_gate')
})

it('inventiveness：无 prior_art 且含非对象条目时 closest 兜底', async () => {
  const graph = buildInventivenessGraph({ includeApproval: false, ruleGate: false })
  const provider: StageProvider = { callLLM: async () => '结果' }
  const r = await graph.compile('parse').run({}, { provider })
  expect(r.completed).toBe(true)
  const r2 = await graph.compile('parse').run({ prior_art: ['原始条目', { title: '对象' }] }, { provider })
  expect(r2.completed).toBe(true)
})

it('enablement：includeApproval/ruleGate 关闭与 extractResult 兜底', async () => {
  const desc = buildEnablementGraph({ includeApproval: false, ruleGate: false }).compile('load').describe()
  expect(desc.nodes).not.toContain('approval')
  expect(desc.nodes).not.toContain('rule_gate')
  // approval 存在 + ruleGate 关闭 → 审批尾链直连 END
  const desc2 = buildEnablementGraph({ ruleGate: false }).compile('load').describe()
  expect(desc2.nodes).toContain('approval')
  expect(desc2.nodes).not.toContain('rule_gate')
  // includeApproval=false + ruleGate 开启 → else 分支直连 rule_gate
  const desc3 = buildEnablementGraph({ includeApproval: false, ruleEvaluator: stubRuleEvaluator }).compile('load').describe()
  expect(desc3.nodes).toContain('rule_gate')
  expect(extractEnablementResult({})).toEqual({})
  expect(extractEnablementResult({ enablement_conclusion: 'not-json' })).toEqual({})
  expect(extractEnablementResult({ enablement_conclusion: '{"sufficiently_disclosed": "yes"}' })).toEqual({})
  expect(extractEnablementResult({
    enablement_conclusion: '{"sufficiently_disclosed": true, "confidence": "high", "report": "r"}',
  })).toEqual({ sufficientlyDisclosed: true, confidence: 'high', report: 'r' })
})

it('shared：LLM 节点失败降级', async () => {
  const graph = buildEnablementGraph({ includeApproval: false, ruleGate: false })
  const throwing: StageProvider = { callLLM: async () => { throw new Error('llm-down') } }
  const r = await graph.compile('load').run({ text: '化合物制剂' }, { provider: throwing })
  expect(String((r.state.enablement_completeness__degradation as { message?: unknown })?.message)).toContain('llm-down')
})
