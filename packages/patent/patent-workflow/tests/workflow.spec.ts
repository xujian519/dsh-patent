import { describe, expect, it } from 'vitest'
import { AtomRegistry, InterruptStageError, StageHandlerRegistry, WorkflowError, type PipelineState, type StageHandler } from '@deepseek-ai/dsh-patent-core'
import { runWorkflow, runStageOnce, type WorkflowManifest, type WorkflowStage } from '@deepseek-ai/dsh-patent-workflow'

function stage(id: string, overrides: Partial<WorkflowStage> = {}): WorkflowStage {
  return { id, strategy: 'chain', description: id, ...overrides }
}

function manifest(id: string, stages: WorkflowStage[]): WorkflowManifest {
  return { id, name: id, caseType: 'test', stages }
}

function atomRegistry(names: string[]): AtomRegistry {
  const atoms = new AtomRegistry()
  for (const name of names) {
    atoms.register({ name, description: name, category: 'extract', inputSchema: [], outputSchema: ['out'] })
  }
  return atoms
}

const okExecutor = async (s: WorkflowStage): Promise<string> => `[${s.id}] 完成`

describe('runWorkflow — fail-fast and cancellation', () => {
  it('rejects when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runWorkflow(manifest('abort', [stage('a')]), { input: 'x' }, okExecutor, { signal: controller.signal }),
    ).rejects.toThrow(/工作流执行已取消/)
  })

  it('forwards the expected guideline revision to manifest validation', async () => {
    const declared = { ...manifest('guideline', [stage('a')]), guidelineRevision: '2026' }
    const result = await runWorkflow(declared, { input: 'x' }, okExecutor, { guidelineRevision: '2026' })
    expect(result.completed).toBe(true)
    await expect(
      runWorkflow(declared, { input: 'x' }, okExecutor, { guidelineRevision: '2025' }),
    ).rejects.toThrow(/与当前指南版本（2025）不一致/)
  })

  it('rejects a manifest declaring an unknown atom before executing anything', async () => {
    await expect(
      runWorkflow(manifest('unknown-atom', [stage('a', { atom: 'no-such-atom' })]), { input: 'x' }, okExecutor),
    ).rejects.toThrow(WorkflowError)
    await expect(
      runWorkflow(manifest('unknown-atom', [stage('a', { atom: 'no-such-atom' })]), { input: 'x' }, okExecutor),
    ).rejects.toThrow(/未知 atom/)
    await expect(
      runWorkflow(manifest('unknown-atom', [stage('a', { atom: 'no-such-atom' })]), { input: 'x' }, okExecutor),
    ).rejects.toThrow(/请确认已加载提供该原子的插件/)
  })
})

describe('runWorkflow — sparse stages defensive guards', () => {
  it('stops cleanly on sparse stages (current/candidate/stage undefined)', async () => {
    // 构造一个"遍历合法、索引稀疏"的阶段数组：validateWorkflowManifest 经自定义迭代器
    // 看到 [A, B]，而执行循环按索引读取时在第 2 位遇到空洞、在第 1 位三次读取后消失，
    // 覆盖 current/candidate/stage 三条 noUncheckedIndexedAccess 防御分支。
    const stageA = stage('a', { atom: 'extract' })
    const stageB = stage('b', { atom: 'merge' })
    const sparse = new Array<WorkflowStage>(3)
    sparse[0] = stageA
    sparse[1] = stageB
    const readsA = { n: 0 }
    const readsB = { n: 0 }
    const proxy = new Proxy(sparse, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          return function* (): Generator<WorkflowStage> {
            yield stageA
            yield stageB
          }
        }
        if (prop === 'map') {
          // 跳过空洞（否则 new Map 会因迭代到 undefined 崩溃）。
          return (cb: (s: WorkflowStage, i: number) => unknown): unknown[] => {
            const out: unknown[] = []
            for (let i = 0; i < target.length; i += 1) {
              if (target[i] !== undefined) out.push(cb(target[i]!, i))
            }
            return out
          }
        }
        if (prop === '0') {
          readsA.n += 1
          return readsA.n <= 2 ? stageA : undefined
        }
        if (prop === '1') {
          readsB.n += 1
          return readsB.n <= 2 ? stageB : undefined
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const called: string[] = []
    const result = await runWorkflow(manifest('sparse', proxy), { input: 'x' }, async (s) => {
      called.push(s.id)
      return `${s.id} 完成`
    }, { atoms: atomRegistry(['extract', 'merge']) })
    // 第 0 位正常执行；第 1 位的 current 读两次后消失 → stage 防御分支提前收尾；
    // 再入循环时 current 为 undefined → 第三条防御分支收尾。
    expect(called).toEqual(['a'])
    expect(result.stages.map(s => s.stageId)).toEqual(['a'])
    expect(result.completed).toBe(true)
  })

  it('a hole after a parallel group stops the run at the next current lookup', async () => {
    // 并行窗口执行后 index 越过空洞位，下一次 current 读取为 undefined → 134 防御分支。
    const stageA = stage('a', { atom: 'extract' })
    const stageB = stage('b', { atom: 'extract' })
    const sparse = new Array<WorkflowStage>(3)
    sparse[0] = stageA
    sparse[1] = stageB
    const proxy = new Proxy(sparse, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          return function* (): Generator<WorkflowStage> {
            yield stageA
            yield stageB
          }
        }
        if (prop === 'map') {
          // 跳过空洞（否则 new Map 会因迭代到 undefined 崩溃）。
          return (cb: (s: WorkflowStage, i: number) => unknown): unknown[] => {
            const out: unknown[] = []
            for (let i = 0; i < target.length; i += 1) {
              if (target[i] !== undefined) out.push(cb(target[i]!, i))
            }
            return out
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const result = await runWorkflow(
      manifest('parallel-hole-current', proxy),
      { input: 'x' },
      okExecutor,
      { atoms: atomRegistry(['extract']) },
    )
    expect(result.stages.map(s => s.stageId)).toEqual(['a', 'b'])
    expect(result.completed).toBe(true)
  })
})

describe('runWorkflow — parallel windows', () => {
  it('executes same-atom consecutive stages as a parallel group', async () => {
    const atoms = atomRegistry(['extract'])
    const called: string[] = []
    const result = await runWorkflow(
      manifest('parallel', [stage('a', { atom: 'extract' }), stage('b', { atom: 'extract' })]),
      { input: 'x' },
      async (s) => {
        called.push(s.id)
        return `${s.id} 完成`
      },
      { atoms },
    )
    expect(called.sort()).toEqual(['a', 'b'])
    expect(result.stages).toHaveLength(2)
    expect(result.completed).toBe(true)
  })

  it('a parallel group interrupted by one stage pauses the whole run', async () => {
    const handlers = new StageHandlerRegistry()
    // 审批门已排除在并行窗口外；这里用普通同 atom 阶段验证「组内任一中止即暂停」。
    const stageHandler: StageHandler = {
      name: 'extract',
      category: 'extract',
      execute: async ({ state }) => {
        if (String(state['tag']) === 'b') throw new InterruptStageError('extract', '等待人工确认', { stageId: 'b' })
        return { out: 'ok' }
      },
    }
    handlers.register(stageHandler)
    const atoms = atomRegistry(['extract'])
    const result = await runWorkflow(
      manifest('parallel-interrupt', [
        stage('a', { atom: 'extract', params: { tag: 'a' } }),
        stage('b', { atom: 'extract', params: { tag: 'b' } }),
      ]),
      { input: 'x' },
      okExecutor,
      { handlers, atoms },
    )
    expect(result.interrupted).toBeDefined()
    expect(result.interrupted!.stageId).toBe('b')
    expect(result.stages.map(entry => entry.stageId)).toEqual(['a'])
    expect(result.completed).toBe(false)
    expect(result.summary).toContain('暂停等待人工确认')
  })

  it('an outcome hole inside a parallel group short-circuits without crashing', async () => {
    const stageA = stage('a', { atom: 'extract' })
    const stageB = stage('b', { atom: 'extract' })
    const target = [stageA, stageB]
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        // slice 返回带空洞的组：[a, <hole>] → group.map 跳过空洞 → outcomes[1] 为 undefined。
        if (prop === 'slice') {
          return (): WorkflowStage[] => {
            const group = new Array<WorkflowStage>(2)
            group[0] = stageA
            return group
          }
        }
        return Reflect.get(t, prop, receiver) as unknown
      },
    })
    const result = await runWorkflow(
      manifest('parallel-hole', proxy),
      { input: 'x' },
      okExecutor,
      { atoms: atomRegistry(['extract']) },
    )
    expect(result.stages).toHaveLength(1)
    expect(result.stages[0]!.stageId).toBe('a')
  })

  it('a group whose stage slot vanishes between run and review breaks without crashing', async () => {
    const stageA = stage('a', { atom: 'extract' })
    const stageB = stage('b', { atom: 'extract' })
    const target = [stageA, stageB]
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'slice') {
          return (): WorkflowStage[] => {
            // 组内第 2 个槽位为显式 undefined，但 map 被改写为只对真实阶段调用：
            // outcomes 变稠密而 group 槽位仍缺失 → groupStage === undefined 分支。
            const group = [stageA, undefined as unknown as WorkflowStage]
            Object.defineProperty(group, 'map', {
              value: (cb: (s: WorkflowStage) => unknown): unknown[] => [
                cb(stageA),
                Promise.resolve({ output: 'x', retries: 0 }),
              ],
            })
            return group
          }
        }
        return Reflect.get(t, prop, receiver) as unknown
      },
    })
    const result = await runWorkflow(
      manifest('parallel-ghost-slot', proxy),
      { input: 'x' },
      okExecutor,
      { atoms: atomRegistry(['extract']) },
    )
    expect(result.stages).toHaveLength(1)
    expect(result.stages[0]!.stageId).toBe('a')
  })
})

describe('runWorkflow — stage chaining', () => {
  it('writes an executor stage output into state[stageId] for its declared consumers', async () => {
    const seen: PipelineState[] = []
    const result = await runWorkflow(
      manifest('chain', [stage('first'), stage('second', { consumes: ['first'] })]),
      { input: 'x' },
      async (s, _ctx, state) => {
        seen.push({ ...state })
        return `${s.id} 产出`
      },
    )
    // 第一阶段执行时上游还没有产出；第二阶段能读到第一阶段写入 state 的输出。
    expect(seen[0]).toEqual({ input: 'x' })
    expect(seen[1]).toEqual({ input: 'x', first: 'first 产出' })
    expect(result.completed).toBe(true)
  })

  it('keeps a stage declaring consumes out of a parallel window', async () => {
    let live = 0
    let maxLive = 0
    await runWorkflow(
      manifest('parallel-consumes', [
        stage('a', { atom: 'extract' }),
        stage('b', { atom: 'extract' }),
        stage('c', { atom: 'extract', consumes: ['a'] }),
      ]),
      { input: 'x' },
      async (s) => {
        live += 1
        maxLive = Math.max(maxLive, live)
        await Promise.resolve()
        live -= 1
        return `${s.id} 完成`
      },
      { atoms: atomRegistry(['extract']) },
    )
    // a、b 并发（2 个在跑），c 声明了 consumes 而单跑；并入窗口会看到 3。
    expect(maxLive).toBe(2)
  })
  it('keeps the shared atom main key out of state for a parallel group', async () => {
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'extract',
      category: 'extract',
      execute: async ({ state }) => {
        const tag = String(state.tag)
        return { out: tag, [String(state.key)]: tag }
      },
    })
    const seen: PipelineState[] = []
    await runWorkflow(
      manifest('parallel-main-key', [
        stage('a', { atom: 'extract', params: { tag: 'a', key: 'a' } }),
        stage('b', { atom: 'extract', params: { tag: 'b', key: 'b' } }),
        stage('read'),
      ]),
      { input: 'x' },
      async (_s, _ctx, state) => {
        seen.push({ ...state })
        return '读到了'
      },
      { handlers, atoms: atomRegistry(['extract']) },
    )
    expect(seen).toHaveLength(1)
    // 主键 `out` 在并行组内被跳过；各阶段的唯一键与 stage.id 命名空间都保留。
    expect(seen[0]!.out).toBeUndefined()
    expect(seen[0]!.a).toBe('a')
    expect(seen[0]!.b).toBe('b')
  })

  it('does not parallelize a stage that declares retry', async () => {
    let live = 0
    let maxLive = 0
    await runWorkflow(
      manifest('parallel-retry', [
        stage('a', { atom: 'extract', retry: { whenOutputMatches: '不一致' } }),
        stage('b', { atom: 'extract' }),
      ]),
      { input: 'x' },
      async (s) => {
        live += 1
        maxLive = Math.max(maxLive, live)
        await Promise.resolve()
        live -= 1
        return `${s.id} 完成`
      },
      { atoms: atomRegistry(['extract']) },
    )
    // 带 retry 的阶段单跑，回退语义不会被 Promise.all 静默跳过。
    expect(maxLive).toBe(1)
  })
})

describe('runWorkflow — retry rewinding edge cases', () => {
  it('a retry without rewindTo rewinds to itself and exhausts, keeping the degraded output', async () => {
    const manifestWorkflow: WorkflowManifest = {
      id: 'self_rewind',
      name: '自回退',
      caseType: 'test',
      validation: { requireAllSteps: false },
      stages: [
        {
          id: 'consistency',
          strategy: 'chain',
          description: '一致性',
          atom: 'extract',
          retry: { whenOutputMatches: '不一致' },
        },
      ],
    }
    const result = await runWorkflow(manifestWorkflow, { input: 'x' }, async () => '检查发现：不一致', {
      atoms: atomRegistry(['extract']),
    })
    expect(result.stages).toHaveLength(1)
    const exhausted = result.stages[0]!
    expect(exhausted.degraded).toBe(true)
    expect(exhausted.output).toContain('[WORKFLOW_RETRY_EXHAUSTED]')
    expect(exhausted.atom).toBe('extract')
    // requireAllSteps=false：容忍降级，运行仍视为完成。
    expect(result.completed).toBe(true)
    expect(result.degradedSteps).toEqual(['consistency'])
  })

  it('a rewindTo ghost stage (invisible to index access) stops the run without crashing', async () => {
    // 数组第 2 位是空洞；迭代器先看到幽灵阶段 b（校验时 rewindTo 存在性通过），
    // 但 stageIds 按索引建图，索引不到 b。
    const stageA = stage('a')
    const stageC = stage('c', { retry: { whenOutputMatches: '不一致', rewindTo: 'b' } })
    const ghostB: WorkflowStage = { id: 'b', strategy: 'chain', description: 'b' }
    const sparse = new Array<WorkflowStage>(3)
    sparse[0] = stageA
    sparse[1] = stageC
    const proxy = new Proxy(sparse, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          return function* (): Generator<WorkflowStage> {
            yield stageA
            yield ghostB
            yield stageC
          }
        }
        if (prop === 'map') {
          // 跳过空洞（否则 new Map 会因迭代到 undefined 崩溃）。
          return (cb: (s: WorkflowStage, i: number) => unknown): unknown[] => {
            const out: unknown[] = []
            for (let i = 0; i < target.length; i += 1) {
              if (target[i] !== undefined) out.push(cb(target[i]!, i))
            }
            return out
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const result = await runWorkflow(
      manifest('ghost-rewind', proxy),
      { input: 'x' },
      async s => (s.id === 'a' ? 'ok' : '检查发现：不一致'),
    )
    // rewindTo 幽灵阶段 → stageIds 索引不到 → 执行在 c 之后中止，c 的结果不入列。
    expect(result.stages.map(s => s.stageId)).toEqual(['a'])
    expect(result.completed).toBe(true)
  })
})

describe('runWorkflow — persistence failures', () => {
  it('records a persistWarning without failing the run (Error and non-Error throw)', async () => {
    const errorRun = await runWorkflow(manifest('persist-1', [stage('a')]), { input: 'x' }, okExecutor, {
      persist: {
        saveRun: async () => { throw new Error('磁盘写入失败') },
        loadRun: async () => undefined,
        listRuns: async () => [],
      },
    })
    expect(errorRun.persistWarning).toContain('磁盘写入失败')

    const rawRun = await runWorkflow(manifest('persist-2', [stage('a')]), { input: 'x' }, okExecutor, {
      persist: {
        saveRun: async () => { throw '磁盘炸了' },
        loadRun: async () => undefined,
        listRuns: async () => [],
      },
    })
    expect(rawRun.persistWarning).toContain('磁盘炸了')
  })

  it('a successful persist leaves no warning', async () => {
    const saved: unknown[] = []
    const result = await runWorkflow(manifest('persist-3', [stage('a')]), { input: 'x' }, okExecutor, {
      persist: {
        saveRun: async (r, runId) => { saved.push({ manifestId: r.manifestId, runId }) },
        loadRun: async () => undefined,
        listRuns: async () => [],
      },
      runId: 'run-1',
    })
    expect(result.persistWarning).toBeUndefined()
    expect(saved).toEqual([{ manifestId: 'persist-3', runId: 'run-1' }])
  })
})

describe('runWorkflow — degraded and interrupted summaries', () => {
  it('summarizes an interrupted run with the paused stage', async () => {
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'approval-gate',
      category: 'gate',
      execute: async () => { throw new InterruptStageError('gate', '等待人工确认', {}) },
    })
    const result = await runWorkflow(
      manifest('interrupt-summary', [stage('pre'), stage('gate', { atom: 'approval-gate' })]),
      { input: 'x' },
      okExecutor,
      { handlers, atoms: atomRegistry(['approval-gate']) },
    )
    expect(result.summary).toContain('在 "gate" 暂停等待人工确认')
    expect(result.interrupted!.stageId).toBe('gate')
  })

  it('marks degraded steps in the summary when they exist', async () => {
    const result = await runWorkflow(
      manifest('degraded-summary', [stage('a'), stage('b')]),
      { input: 'x' },
      async () => '',
    )
    expect(result.degradedSteps).toEqual(['a', 'b'])
    expect(result.completed).toBe(false)
    expect(result.summary).toContain('降级阶段: a、b')
    expect(result.summary).toContain('0/2 阶段完成')
  })

  it('runStageOnce is re-exported and drives a single stage directly', async () => {
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'extract',
      category: 'extract',
      execute: async () => ({ out: '直接执行' }),
    })
    const outcome = await runStageOnce(stage('s1', { atom: 'extract' }), {}, {
      handlers,
      atoms: atomRegistry(['extract']),
      maxRetries: 2,
      ctx: {},
    })
    expect(outcome.output).toBe('直接执行')
  })
})

describe('runWorkflow — 阶段通知', () => {
  it('每个阶段开始前通知阶段 id、序号与总数', async () => {
    const seen: Array<[string, number, number]> = []
    const result = await runWorkflow(
      manifest('notify', [stage('a'), stage('b')]),
      { input: 'x' },
      okExecutor,
      { onStage: (stageId, index, total) => { seen.push([stageId, index, total]) } },
    )
    expect(seen).toEqual([['a', 0, 2], ['b', 1, 2]])
    expect(result.completed).toBe(true)
  })

  it('并行窗口内的阶段同样各自通知一次', async () => {
    const seen: string[] = []
    const handlers = new StageHandlerRegistry()
    handlers.register({ name: 'extract', category: 'extract', execute: async () => ({ out: 'ok' }) })
    const result = await runWorkflow(
      manifest('windowed', [stage('a', { atom: 'extract' }), stage('b', { atom: 'extract' })]),
      { input: 'x' },
      undefined,
      { atoms: atomRegistry(['extract']), handlers, maxParallelStages: 2, onStage: (stageId) => { seen.push(stageId) } },
    )
    expect(seen).toEqual(['a', 'b'])
    expect(result.completed).toBe(true)
  })
})

describe('runWorkflow — 证据台账', () => {
  it('把材料、现有技术、证据与抵触申请写入运行结果的台账', async () => {
    const result = await runWorkflow(
      manifest('ledger', [stage('only')]),
      {
        input: '交底书正文',
        claims: '1. 一种装置',
        prior_art: [{ dLabel: 'D1', title: '对比文件', url: 'https://example.test/D1' }],
        prior_art_excluded: [{ label: 'D2', title: '公开过早', reason: 'not-prior-art' }],
        evidence: [{ title: '证据 1', sourceUri: 'file:///e1.pdf' }],
        conflicting_applications: [{ title: '抵触申请', publicationDate: '2024-07-01' }],
      },
      okExecutor,
      { runId: 'run-ledger' },
    )
    const ledger = result.evidenceLedger!
    expect(ledger.receipts.map(receipt => receipt.citationId)).toEqual([
      'MATERIAL', 'CLAIMS', 'D1', 'D2', 'EV-1', 'CA-1',
    ])
    expect(ledger.receipts.every(receipt => receipt.toolCallId.startsWith('run-ledger:'))).toBe(true)
    expect(ledger.receipts[2]!.args['sourceUri']).toBe('https://example.test/D1')
    expect(ledger.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ledger.receipts.every(receipt => receipt.contentHash?.startsWith('sha256:'))).toBe(true)
  })

  it('中断的运行同样保留已经消费的证据台账', async () => {
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'gate',
      category: 'gate',
      execute: async () => {
        throw new InterruptStageError('gate', '等待确认', {})
      },
    })
    const result = await runWorkflow(
      manifest('ledger-interrupt', [stage('gate', { atom: 'gate' })]),
      { input: '交底书', prior_art: [{ title: 'D1 文献' }] },
      undefined,
      { atoms: atomRegistry(['gate']), handlers, runId: 'run-int' },
    )
    expect(result.interrupted?.stageId).toBe('gate')
    expect(result.evidenceLedger!.receipts.map(receipt => receipt.citationId)).toEqual(['MATERIAL', 'D1'])
  })
})

describe('runWorkflow — 阶段输入范围留痕', () => {
  function scopeRegistry(logInputScope: boolean): { atoms: AtomRegistry; handlers: StageHandlerRegistry } {
    const atoms = new AtomRegistry()
    atoms.register({
      name: 'guarded',
      description: '隔离型阶段',
      category: 'gate',
      inputSchema: ['draft', 'reference_documents', 'claims', 'office_action'],
      outputSchema: ['out'],
      ...(logInputScope ? { logInputScope: true } : {}),
    })
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'guarded',
      category: 'gate',
      execute: async () => ({ out: 'ok' }),
    })
    return { atoms, handlers }
  }

  it('原子声明 logInputScope 时把声明的输入键写入阶段结果', async () => {
    const { atoms, handlers } = scopeRegistry(true)
    const result = await runWorkflow(
      manifest('scope', [stage('review', { atom: 'guarded' })]),
      {},
      undefined,
      { atoms, handlers },
    )
    expect(result.stages[0]?.inputScope).toEqual([
      'draft',
      'reference_documents',
      'claims',
      'office_action',
    ])
  })


  it('记录重试耗尽阶段的输入范围', async () => {
    const atoms = new AtomRegistry()
    atoms.register({
      name: 'guarded',
      description: '隔离型阶段',
      category: 'gate',
      inputSchema: ['draft'],
      outputSchema: ['out'],
      logInputScope: true,
    })
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'guarded',
      category: 'gate',
      execute: async () => ({ out: '不一致' }),
    })
    const result = await runWorkflow(
      manifest('scope-retry', [stage('review', {
        atom: 'guarded',
        retry: { whenOutputMatches: '不一致', maxRetries: 1 },
      })]),
      {},
      undefined,
      { atoms, handlers },
    )
    expect(result.stages[0]?.output).toContain('WORKFLOW_RETRY_EXHAUSTED')
    expect(result.stages[0]?.inputScope).toEqual(['draft'])
  })

  it('原子未声明时不写输入范围', async () => {
    const { atoms, handlers } = scopeRegistry(false)
    const result = await runWorkflow(
      manifest('scope', [stage('review', { atom: 'guarded' })]),
      {},
      undefined,
      { atoms, handlers },
    )
    expect(result.stages[0]?.inputScope).toBeUndefined()
  })
})
