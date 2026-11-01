import { describe, expect, it } from 'vitest'
import {
  patentDisclosureManifest,
  patentOaResponseManifest,
  runWorkflow,
  validateWorkflowManifest,
  type WorkflowManifest,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-workflow'
import {
  AtomRegistry,
  digestText,
  globalAtomRegistry,
  registerBuiltinAtoms,
  StageHandlerRegistry,
} from '@deepseek-ai/dsh-patent-core'

describe('workflow retry validation', () => {
  it('validate: empty or invalid retry.whenOutputMatches is rejected', () => {
    expect(() => {
      validateWorkflowManifest({
        id: 't', name: 't', caseType: 't',
        stages: [{ id: 'a', strategy: 'chain', description: 'a', retry: { whenOutputMatches: '  ' } }],
      }) },
    ).toThrow(/whenOutputMatches 不能为空/)
    expect(() => {
      validateWorkflowManifest({
        id: 't', name: 't', caseType: 't',
        stages: [{ id: 'a', strategy: 'chain', description: 'a', retry: { whenOutputMatches: '(' } }],
      }) },
    ).toThrow(/非法正则/)
  })

  it('validate: rewindTo pointing to missing or self stages is rejected', () => {
    expect(() => {
      validateWorkflowManifest({
        id: 't', name: 't', caseType: 't',
        stages: [
          { id: 'a', strategy: 'chain', description: 'a' },
          { id: 'b', strategy: 'chain', description: 'b', retry: { whenOutputMatches: 'x', rewindTo: 'nope' } },
        ],
      }) },
    ).toThrow(/rewindTo 指向不存在的阶段/)
    expect(() => {
      validateWorkflowManifest({
        id: 't', name: 't', caseType: 't',
        stages: [{ id: 'a', strategy: 'chain', description: 'a', retry: { whenOutputMatches: 'x', rewindTo: 'a' } }],
      }) },
    ).toThrow(/不能指向自身/)
  })

  it('runWorkflow: consistency signal rewinds and re-executes (including intermediate stages)', async () => {
    const manifest: WorkflowManifest = {
      id: 'disclosure_test',
      name: '披露测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征' },
        { id: 'merge', strategy: 'chain', description: '融合' },
        {
          id: 'consistency',
          strategy: 'chain',
          description: '一致性检查',
          retry: { whenOutputMatches: '不一致|矛盾', rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    const calls: string[] = []
    const executor = async (stage: WorkflowStage) => {
      calls.push(stage.id)
      if (stage.id === 'extract') return '特征A、特征B'
      if (stage.id === 'merge') return 'PFE 融合完成'
      const extractCalls = calls.filter(c => c === 'extract').length
      return extractCalls < 2 ? '检查发现：特征与效果不一致' : '检查通过：特征-效果因果链闭合'
    }

    const result = await runWorkflow(manifest, { input: '交底书' }, executor)
    expect(result.completed).toBe(true)
    expect(calls.filter(c => c === 'extract')).toHaveLength(2)
    expect(result.stages).toHaveLength(3)
    const consistency = result.stages.find(s => s.stageId === 'consistency')!
    expect(consistency.output).toMatch(/检查通过/)
    expect(consistency.degraded).toBe(false)
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('runWorkflow: exceeding max rewinds keeps the inconsistent output and marks degraded', async () => {
    const manifest: WorkflowManifest = {
      id: 'disclosure_exhaust',
      name: '披露耗尽测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征' },
        {
          id: 'consistency',
          strategy: 'chain',
          description: '一致性检查',
          retry: { whenOutputMatches: '不一致', rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    let extractCalls = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'extract') { extractCalls += 1; return '特征A' }
      return '检查发现：特征与效果不一致'
    }

    const result = await runWorkflow(manifest, { input: '交底书' }, executor)
    expect(extractCalls).toBe(2)
    const consistency = result.stages.find(s => s.stageId === 'consistency')!
    expect(consistency.degraded).toBe(true)
    expect(consistency.output).toMatch(/\[WORKFLOW_RETRY_EXHAUSTED\]/)
    expect(result.degradedSteps).toContain('consistency')
    expect(result.completed).toBe(false)
  })

  it('runWorkflow: output without a signal advances without rewinding', async () => {
    const manifest: WorkflowManifest = {
      id: 'no_retry',
      name: '无回退测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'a', strategy: 'chain', description: 'a' },
        { id: 'b', strategy: 'chain', description: 'b', retry: { whenOutputMatches: '不一致', rewindTo: 'a' } },
      ],
    }
    let aCalls = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'a') { aCalls += 1; return '特征' }
      return '检查通过'
    }
    const result = await runWorkflow(manifest, { input: 'x' }, executor)
    expect(aCalls).toBe(1)
    expect(result.stages).toHaveLength(2)
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('runWorkflow: negated phrasing does not rewind (未发现不一致)', async () => {
    const manifest: WorkflowManifest = {
      id: 'negated_signal',
      name: '否定信号测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征' },
        {
          id: 'consistency',
          strategy: 'chain',
          description: '一致性检查',
          retry: { whenOutputMatches: '不一致|矛盾|缺少|孤立', rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    let extractCalls = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'extract') { extractCalls += 1; return '特征A' }
      return '检查通过：未发现不一致、矛盾或缺少内容，各要素相互印证'
    }
    const result = await runWorkflow(manifest, { input: '交底书' }, executor)
    expect(extractCalls).toBe(1)
    expect(result.completed).toBe(true)
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('runWorkflow: rewind rolls back stage state (no stale output reused)', async () => {
    const manifest: WorkflowManifest = {
      id: 'state_rollback',
      name: '状态回滚测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征', atom: 'rollback_probe' },
        {
          id: 'consistency',
          strategy: 'chain',
          description: '一致性检查',
          retry: { whenOutputMatches: '不一致', rewindTo: 'extract', maxRetries: 1 },
        },
      ],
    }
    // 探针 atom 声明两个输出键：out_primary 是主输出，out_extra 不是 stage-id 键。
    // 回退只删 stage-id 键时，out_extra 会残留上一代值被重跑阶段读到。
    const atoms = new AtomRegistry()
    atoms.register({
      name: 'rollback_probe',
      description: '回滚探针',
      category: 'extract',
      inputSchema: [],
      outputSchema: ['out_primary', 'out_extra'],
    })
    const handlers = new StageHandlerRegistry()
    const rounds = { n: 0 }
    const seenExtra: unknown[] = []
    handlers.register({
      name: 'rollback_probe',
      category: 'extract',
      execute: async ({ state }) => {
        rounds.n += 1
        seenExtra.push(state.out_extra)
        return rounds.n === 1
          ? { out_primary: '旧特征', out_extra: '陈旧一代（非 stage-id 键）' }
          : { out_primary: '新特征' }
      },
    })
    const executor = async (stage: WorkflowStage) =>
      stage.id === 'consistency' ? (rounds.n === 1 ? '不一致' : '一致') : ''

    const result = await runWorkflow(manifest, { input: 'x' }, executor, { atoms, handlers })

    // 重跑阶段不得读到上一代的非 stage-id 键。
    expect(seenExtra).toEqual([undefined, undefined])
    const extract = result.stages.find(s => s.stageId === 'extract')!
    expect(extract.output).toBe('新特征')
    const consistency = result.stages.find(s => s.stageId === 'consistency')!
    expect(consistency.output).toBe('一致')
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('runWorkflow: structured revision signal rewinds and records before/after digests', async () => {
    const manifest: WorkflowManifest = {
      id: 'structured_retry',
      name: '结构化回退测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征', atom: 'revision_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '缺口检查',
          atom: 'revision_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'revision_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['probe_out'] })
    atoms.register({ name: 'revision_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    let extractRounds = 0
    let checkRounds = 0
    handlers.register({
      name: 'revision_extract',
      category: 'extract',
      execute: async () => {
        extractRounds += 1
        return { probe_out: `特征${extractRounds}` }
      },
    })
    handlers.register({
      name: 'revision_check',
      category: 'gate',
      execute: async () => {
        checkRounds += 1
        return checkRounds === 1
          ? { check_out: '检查发现缺口', _revision_signals: [{ gapId: 'gap-1', rationale: '缺少对应事实' }] }
          : { check_out: '检查通过' }
      },
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(extractRounds).toBe(2)
    expect(checkRounds).toBe(2)
    expect(result.completed).toBe(true)
    expect(result.revisions).toHaveLength(1)
    const revision = result.revisions![0]!
    expect(revision).toMatchObject({
      gapId: 'gap-1',
      rewindTo: 'extract',
      requestedBy: 'check',
      round: 1,
      rationale: '缺少对应事实',
      outcome: 'applied',
    })
    // 两个摘要描述同一个阶段（回退目标）：第 1 轮特征 vs 第 2 轮特征。
    expect(revision.before).toBe(digestText('特征1'))
    expect(revision.after).toBe(digestText('特征2'))
    // 未注入时钟时不写时间，持久化结果保持确定性。
    expect(revision.at).toBeUndefined()
  })

  it('validate: retry 跨过审批门被拒绝（回退会重做已确认产出）', () => {
    expect(() => {
      validateWorkflowManifest({
        id: 'approval_rewind', name: 't', caseType: 't',
        stages: [
          { id: 'prep', strategy: 'chain', description: 'a' },
          { id: 'gate', strategy: 'chain', description: 'b', atom: 'approval-gate' },
          { id: 'check', strategy: 'chain', description: 'c', retry: { whenRevisionRequested: true, rewindTo: 'prep' } },
        ],
      })
    }).toThrow(/跨过审批门 gate/)
  })

  it('runWorkflow: 结构化缺口信号可以在空输出时触发回退', async () => {
    const manifest: WorkflowManifest = {
      id: 'structured_empty',
      name: '空输出结构化回退',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取', atom: 'empty_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '检查',
          atom: 'empty_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'empty_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['out'] })
    atoms.register({ name: 'empty_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    let extractRounds = 0
    let checkRounds = 0
    handlers.register({
      name: 'empty_extract',
      category: 'extract',
      execute: async () => {
        extractRounds += 1
        return { out: `第${extractRounds}轮` }
      },
    })
    handlers.register({
      name: 'empty_check',
      category: 'gate',
      execute: async () => {
        checkRounds += 1
        return checkRounds === 1
          ? { _revision_signals: [{ gapId: 'g', rationale: '空输出也要回退' }] }
          : { check_out: '通过' }
      },
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(extractRounds).toBe(2)
    expect(result.revisions?.map(record => record.outcome)).toEqual(['applied'])
    expect(result.completed).toBe(true)
  })

  it('runWorkflow: 未声明 rewindTo 时回退当前阶段，前后摘要仍可比较', async () => {
    const manifest: WorkflowManifest = {
      id: 'self_rewind',
      name: '自回退测试',
      caseType: 'disclosure_analysis',
      stages: [
        {
          id: 'check',
          strategy: 'chain',
          description: '检查',
          atom: 'self_check',
          retry: { whenRevisionRequested: true, maxRetries: 1 },
        },
      ],
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'self_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    let rounds = 0
    handlers.register({
      name: 'self_check',
      category: 'gate',
      execute: async () => {
        rounds += 1
        return rounds === 1
          ? { check_out: '第一版', _revision_signals: [{ gapId: 'g', rationale: 'r' }] }
          : { check_out: '第二版' }
      },
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(rounds).toBe(2)
    expect(result.revisions?.[0]).toMatchObject({
      rewindTo: 'check',
      before: digestText('第一版'),
      after: digestText('第二版'),
    })
    expect(result.stages.find(stage => stage.stageId === 'check')?.output).toBe('第二版')
  })

  it('runWorkflow: 回退留痕达到上限后标记截断', async () => {
    const manifest: WorkflowManifest = {
      id: 'revision_cap',
      name: '留痕上限测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取', atom: 'cap_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '检查',
          atom: 'cap_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract', maxRetries: 70 },
        },
      ],
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'cap_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['out'] })
    atoms.register({ name: 'cap_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    handlers.register({ name: 'cap_extract', category: 'extract', execute: async () => ({ out: '特征' }) })
    handlers.register({
      name: 'cap_check',
      category: 'gate',
      execute: async () => ({ _revision_signals: [{ gapId: 'g', rationale: '持续缺口' }] }),
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(result.revisions).toHaveLength(64)
    expect(result.revisionsTruncated).toBe(true)
  })

  it('runWorkflow: 没有证据来源时不写空台账', async () => {
    const result = await runWorkflow(
      { id: 'no_evidence', name: 'n', caseType: 't', stages: [{ id: 'a', strategy: 'chain', description: 'a' }] },
      {},
      async () => '完成',
    )
    expect(result.evidenceLedger).toBeUndefined()
  })

  it('runWorkflow: 注入时钟后 RevisionRecord 写入 at', async () => {
    const manifest: WorkflowManifest = {
      id: 'structured_clock',
      name: '时钟测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取', atom: 'clock_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '检查',
          atom: 'clock_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract' },
        },
      ],
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'clock_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['out'] })
    atoms.register({ name: 'clock_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    handlers.register({ name: 'clock_extract', category: 'extract', execute: async () => ({ out: '特征' }) })
    let rounds = 0
    handlers.register({
      name: 'clock_check',
      category: 'gate',
      execute: async () => {
        rounds += 1
        return rounds === 1 ? { _revision_signals: [{ gapId: 'g', rationale: 'r' }] } : { check_out: '通过' }
      },
    })
    const result = await runWorkflow(manifest, { input: 'x' }, undefined, {
      atoms,
      handlers,
      now: () => '2026-10-22T00:00:00.000Z',
    })
    expect(result.revisions?.[0]?.at).toBe('2026-10-22T00:00:00.000Z')
  })

  it('runWorkflow: structured retry exhaustion keeps the stage output and records the stop', async () => {
    const manifest: WorkflowManifest = {
      id: 'structured_exhaust',
      name: '结构化回退耗尽测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征', atom: 'revision_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '缺口检查',
          atom: 'revision_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract', maxRetries: 1 },
        },
      ],
      validation: { requireAllSteps: true },
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'revision_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['probe_out'] })
    atoms.register({ name: 'revision_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'revision_extract',
      category: 'extract',
      execute: async () => ({ probe_out: '特征' }),
    })
    handlers.register({
      name: 'revision_check',
      category: 'gate',
      execute: async () => ({
        check_out: '仍有缺口',
        _revision_signals: [{ gapId: 'gap-2', rationale: '证据仍缺失', evidence: 'state.evidence' }],
      }),
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(result.completed).toBe(true)
    expect(result.degradedSteps).toHaveLength(0)
    expect(result.revisions?.map(record => record.outcome)).toEqual(['applied', 'exhausted'])
    expect(result.revisions?.[1]).toMatchObject({ gapId: 'gap-2', evidence: 'state.evidence' })
    expect(result.revisions?.[1]?.after).toBeUndefined()
    expect(result.stages.find(stage => stage.stageId === 'check')?.degraded).toBe(false)
  })

  it('runWorkflow: structured retry without a signal advances without rewinding', async () => {
    const manifest: WorkflowManifest = {
      id: 'structured_quiet',
      name: '结构化无信号测试',
      caseType: 'disclosure_analysis',
      stages: [
        { id: 'extract', strategy: 'chain', description: '提取特征', atom: 'revision_extract' },
        {
          id: 'check',
          strategy: 'chain',
          description: '缺口检查',
          atom: 'revision_check',
          retry: { whenRevisionRequested: true, rewindTo: 'extract' },
        },
      ],
    }
    const atoms = new AtomRegistry()
    atoms.register({ name: 'revision_extract', description: 'e', category: 'extract', inputSchema: [], outputSchema: ['probe_out'] })
    atoms.register({ name: 'revision_check', description: 'c', category: 'gate', inputSchema: [], outputSchema: ['check_out'] })
    const handlers = new StageHandlerRegistry()
    let extractRounds = 0
    handlers.register({
      name: 'revision_extract',
      category: 'extract',
      execute: async () => {
        extractRounds += 1
        return { probe_out: '特征' }
      },
    })
    handlers.register({
      name: 'revision_check',
      category: 'gate',
      execute: async () => ({ check_out: '检查通过' }),
    })

    const result = await runWorkflow(manifest, { input: 'x' }, undefined, { atoms, handlers })
    expect(extractRounds).toBe(1)
    expect(result.revisions).toBeUndefined()
    expect(result.completed).toBe(true)
  })

  it('parseRetrySignals: malformed entries are dropped and long text is bounded', async () => {
    const { parseRetrySignals } = await import('@deepseek-ai/dsh-patent-core')
    const signals = parseRetrySignals([
      { gapId: 'g1', rationale: 'r'.repeat(500), evidence: 'e'.repeat(500) },
      { gapId: '', rationale: 'empty id' },
      { gapId: 42, rationale: 'non-string id' },
      { gapId: 'g2' },
      'not-an-object',
    ])
    expect(signals).toHaveLength(1)
    expect(signals[0]!.gapId).toBe('g1')
    expect(signals[0]!.rationale).toHaveLength(240)
    expect(signals[0]!.evidence).toHaveLength(200)
    // 单次返回值最多接受 32 条信号：一次回退写一条记录，信号数必须有界。
    const many = parseRetrySignals(
      Array.from({ length: 40 }, (_, index) => ({ gapId: `g${index}`, rationale: 'r' })),
    )
    expect(many).toHaveLength(32)
  })

  it('validate: rewindTo pointing to a later stage is rejected', () => {
    expect(() => {
      validateWorkflowManifest({
        id: 't', name: 't', caseType: 't',
        stages: [
          { id: 'a', strategy: 'chain', description: 'a' },
          { id: 'b', strategy: 'chain', description: 'b', retry: { whenOutputMatches: 'x', rewindTo: 'c' } },
          { id: 'c', strategy: 'chain', description: 'c' },
        ],
      }) },
    ).toThrow(/rewindTo 指向不存在的阶段/)
  })

  it('patentDisclosureManifest: structure and retry declarations are valid', () => {
    expect(() => { validateWorkflowManifest(patentDisclosureManifest) }).not.toThrow()
    expect(patentDisclosureManifest.id).toBe('patent_disclosure_v1')
    expect(patentDisclosureManifest.stages).toHaveLength(25)
    const consistency = patentDisclosureManifest.stages.find(s => s.id === 'consistency')!
    expect(consistency.retry?.rewindTo).toBe('extract_problem')
    expect(consistency.retry!.whenOutputMatches).toMatch(/不一致\|矛盾\|缺少\|孤立/)
    // PFIE 一致性是确定性原子：结构与"问题是否绑定解决手段"都由 pfe-consistency 判定，
    // 不再交给 executor 用自由文本自查。
    expect(consistency.atom).toBe('pfe-consistency')
    const atoms = patentDisclosureManifest.stages.filter(s => s.atom !== undefined).map(s => s.atom)
    expect([...new Set(atoms)].sort()).toEqual([
      'approval-gate', 'citation-check', 'claim-breadth', 'draft-claims', 'draft-specification', 'eligibility', 'enablement-report', 'extract', 'figure-analysis', 'groundedness', 'keywords',
      'legal-gaps', 'merge', 'novelty', 'pfe-consistency', 'prior-art-filter', 'search', 'slop-gate',
      'spec-check', 'time-baseline',
    ])
    const extractStages = patentDisclosureManifest.stages.filter(s => s.id.startsWith('extract_'))
    expect(extractStages).toHaveLength(3)
    expect(extractStages.map(s => s.params?.output_key).filter(Boolean).sort()).toEqual(['effects', 'features'])
    // 问题与发明认知由同一次调用产出：merge 按条目配对，不再依赖跨数组下标。
    expect(extractStages[0]?.params).toMatchObject({ output_mode: 'problem_insight' })
    expect(extractStages[0]?.params?.output_key).toBeUndefined()
    const ids = patentDisclosureManifest.stages.map(s => s.id)
    expect(ids.indexOf('extract_problem') < ids.indexOf('extract_effects')).toBe(true)
    expect(ids.indexOf('extract_effects') < ids.indexOf('merge')).toBe(true)
    expect(ids.indexOf('merge') < ids.indexOf('consistency')).toBe(true)
    expect(ids.indexOf('report') < ids.indexOf('draft_claims')).toBe(true)
    // 审批门在 legal-gaps 反哺回路之后：回退不会跨过人工确认。
    expect(ids.indexOf('legal_gaps') < ids.indexOf('review_gate')).toBe(true)
    expect(ids.at(-1)).toBe('review_gate')
    expect(patentDisclosureManifest.stages.find(s => s.id === 'review_gate')?.atom).toBe('approval-gate')
    expect(patentDisclosureManifest.stages.find(s => s.id === 'draft_claims')?.atom).toBe('draft-claims')
    // 实体判定都在形式检查之后、反套话门之前：形式检查先跑，失败可被 slop_clean 回退覆盖。
    expect(ids.indexOf('draft_claims') < ids.indexOf('spec_check')).toBe(true)
    expect(ids.indexOf('spec_check') < ids.indexOf('enablement_report')).toBe(true)
    expect(ids.indexOf('enablement_report') < ids.indexOf('claim_breadth')).toBe(true)
    expect(ids.indexOf('claim_breadth') < ids.indexOf('slop_clean')).toBe(true)
    expect(patentDisclosureManifest.stages.find(s => s.id === 'claim_breadth')?.atom).toBe('claim-breadth')
    expect(ids.indexOf('generate_keywords') < ids.indexOf('search')).toBe(true)
    // 时间基准在检索前确定；公开日过滤紧跟检索，新颖性读过滤后的 prior_art。
    expect(ids.indexOf('generate_keywords') < ids.indexOf('time_baseline')).toBe(true)
    expect(ids.indexOf('time_baseline') < ids.indexOf('search')).toBe(true)
    expect(patentDisclosureManifest.stages.find(s => s.id === 'time_baseline')?.atom).toBe('time-baseline')
    expect(ids.indexOf('search') < ids.indexOf('prior_art_filter')).toBe(true)
    expect(ids.indexOf('prior_art_filter') < ids.indexOf('novelty')).toBe(true)
    expect(patentDisclosureManifest.stages.find(s => s.id === 'prior_art_filter')?.atom).toBe('prior-art-filter')
    expect(ids.indexOf('search') < ids.indexOf('novelty')).toBe(true)
    expect(ids.indexOf('novelty') < ids.indexOf('report')).toBe(true)
    // 引用校验夹在新颖性结论与报告之间：报告消费校验产出，引用不接地的结论随报告暴露。
    const citationCheck = patentDisclosureManifest.stages.find(s => s.id === 'citation_check')!
    expect(citationCheck.atom).toBe('citation-check')
    expect(citationCheck.params).toBeUndefined()
    expect(ids.indexOf('novelty') < ids.indexOf('citation_check')).toBe(true)
    expect(ids.indexOf('citation_check') < ids.indexOf('report')).toBe(true)
    expect(patentDisclosureManifest.stages.find(s => s.id === 'report')?.consumes).toContain('citation_check')
    // slop_clean gates the draft and rewinds to draft_claims on a fail signal.
    const slopClean = patentDisclosureManifest.stages.find(s => s.id === 'slop_clean')!
    expect(slopClean.atom).toBe('slop-gate')
    expect(slopClean.retry?.rewindTo).toBe('draft_claims')
    expect(slopClean.retry!.whenOutputMatches).toBe('需修订')
    expect(slopClean.retry!.maxRetries).toBe(1)
    expect(ids.indexOf('draft_claims') < ids.indexOf('slop_clean')).toBe(true)
    // 说明书草案接在权项草稿之后；spec_check 以草案为说明书文本、权项草稿为权利要求文本。
    const draftSpecification = patentDisclosureManifest.stages.find(s => s.id === 'draft_specification')!
    expect(draftSpecification.atom).toBe('draft-specification')
    expect(ids.indexOf('draft_claims') < ids.indexOf('draft_specification')).toBe(true)
    const specCheck = patentDisclosureManifest.stages.find(s => s.id === 'spec_check')!
    expect(specCheck.atom).toBe('spec-check')
    expect(specCheck.params).toEqual({ mode: 'spec', text_key: 'specification', claims_key: 'claims_draft' })
    expect(ids.indexOf('draft_specification') < ids.indexOf('spec_check')).toBe(true)
    expect(ids.indexOf('spec_check') < ids.indexOf('slop_clean')).toBe(true)
    // 法条缺口汇总以全部确定性检查为输入，放在整链末尾。
    const legalGaps = patentDisclosureManifest.stages.find(s => s.id === 'legal_gaps')!
    expect(legalGaps.atom).toBe('legal-gaps')
    expect(legalGaps.params).toEqual({ profile: 'disclosure' })
    expect(ids.indexOf('slop_clean') < ids.indexOf('legal_gaps')).toBe(true)
    expect(ids.at(-1)).toBe('review_gate')
  })

  it('patentDisclosureManifest: declared atoms exist after builtin registration', () => {
    registerBuiltinAtoms()
    // slop-gate、spec-check 与 eligibility 的真实注册在 patent-tools apply()；此处注册
    // 同名契约 stub 使 manifest 校验通过，真实运行路径由 patent-tools 覆盖。
    globalAtomRegistry.register({
      name: 'slop-gate',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['slop_report'],
    })
    globalAtomRegistry.register({
      name: 'draft-specification',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['specification'],
    })
    globalAtomRegistry.register({
      name: 'figure-analysis',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['figure_analysis'],
    })
    globalAtomRegistry.register({
      name: 'spec-check',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['spec_check_report'],
    })
    globalAtomRegistry.register({
      name: 'eligibility',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['eligibility_report'],
    })
    globalAtomRegistry.register({
      name: 'legal-gaps',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['legal_gaps_report'],
    })
    expect(() => {
      validateWorkflowManifest(patentDisclosureManifest, {
        atomNames: new Set(globalAtomRegistry.list().map(a => a.name)),
      }) },
    ).not.toThrow()
  })

  it('patentDisclosureManifest: slop_clean fail signal rewinds to draft_claims and re-runs it', async () => {
    registerBuiltinAtoms()
    globalAtomRegistry.register({
      name: 'slop-gate',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['slop_report'],
    })
    globalAtomRegistry.register({
      name: 'draft-specification',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['specification'],
    })
    globalAtomRegistry.register({
      name: 'figure-analysis',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['figure_analysis'],
    })
    globalAtomRegistry.register({
      name: 'spec-check',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['spec_check_report'],
    })
    globalAtomRegistry.register({
      name: 'eligibility',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['eligibility_report'],
    })
    globalAtomRegistry.register({
      name: 'legal-gaps',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['legal_gaps_report'],
    })
    // 空 handler 注册表覆盖全局：本测试只驱动 runWorkflow 的 retry 机制，
    // 不触发内置 handler（其真实执行路径由 patent-tools 覆盖）。
    let draftRound = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'draft_claims') {
        draftRound += 1
        return draftRound === 1 ? '深入分析，全面论述，综上所述，保护范围合理。' : '一种结构，包括壳体与连接部。'
      }
      if (stage.id === 'slop_clean') {
        return draftRound === 1 ? '反套话评分门: ⚠️ 需修订（总分 18，通过线 35）' : '反套话评分门: ✅ 通过（总分 39，通过线 35）'
      }
      return `${stage.id} 完成`
    }

    const result = await runWorkflow(patentDisclosureManifest, { input: '交底书' }, executor, {
      handlers: new StageHandlerRegistry(),
    })
    expect(draftRound).toBe(2) // 初次撰写 + 信号回退后重跑
    const slopClean = result.stages.find(s => s.stageId === 'slop_clean')!
    expect(slopClean.output).toContain('✅ 通过')
    expect(slopClean.degraded).toBe(false)
    const draftClaims = result.stages.filter(s => s.stageId === 'draft_claims')
    expect(draftClaims).toHaveLength(1) // 回退 splice 掉首轮结果，只保留最终轮
    expect(draftClaims[0]!.output).toContain('一种结构')
    expect(result.completed).toBe(true)
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('patentDisclosureManifest: persistent slop_clean failure exhausts the retry and marks degraded', async () => {
    registerBuiltinAtoms()
    globalAtomRegistry.register({
      name: 'slop-gate',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['slop_report'],
    })
    globalAtomRegistry.register({
      name: 'draft-specification',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['specification'],
    })
    globalAtomRegistry.register({
      name: 'figure-analysis',
      category: 'extract',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['figure_analysis'],
    })
    globalAtomRegistry.register({
      name: 'spec-check',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['spec_check_report'],
    })
    globalAtomRegistry.register({
      name: 'eligibility',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['eligibility_report'],
    })
    globalAtomRegistry.register({
      name: 'legal-gaps',
      category: 'gate',
      description: 'test stub — 真实注册在 patent-tools apply()',
      inputSchema: [],
      outputSchema: ['legal_gaps_report'],
    })
    let draftRound = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'draft_claims') { draftRound += 1; return '套话草稿' }
      if (stage.id === 'slop_clean') return '反套话评分门: ⚠️ 需修订（总分 18，通过线 35）'
      return `${stage.id} 完成`
    }

    const result = await runWorkflow(patentDisclosureManifest, { input: '交底书' }, executor, {
      handlers: new StageHandlerRegistry(),
    })
    expect(draftRound).toBe(2) // 初次 + 一次回退（maxRetries=1），此后耗尽
    const slopClean = result.stages.find(s => s.stageId === 'slop_clean')!
    expect(slopClean.output).toMatch(/\[WORKFLOW_RETRY_EXHAUSTED\]/)
    expect(slopClean.degraded).toBe(true)
    expect(result.degradedSteps).toContain('slop_clean')
  })
})

describe('patentOaResponseManifest 的反套话回路', () => {
  /** 注册答复 manifest 声明的跨包原子契约（真实实现由 patent-tools 覆盖）。 */
  const registerResponseAtomStubs = (): void => {
    registerBuiltinAtoms()
    for (const [name, outputSchema] of [
      ['slop-gate', ['slop_report']],
      // 删减阶段的产出键：门的 text_keys 与新正文键在 manifest 里成对出现，缺一个就接线断。
      ['tighten', ['draft_tightened', 'tighten_report', 'tighten_violations']],
      ['response-check', ['response_check_report']],
      ['legal-gaps', ['legal_gaps_report']],
    ] as const) {
      globalAtomRegistry.register({
        name,
        category: 'gate',
        description: 'test stub — 真实注册在 patent-tools apply()',
        inputSchema: [],
        outputSchema: [...outputSchema],
      })
    }
  }

  it('draft 的套话稿触发回退：第二次通过后保留新产出，不留降级', async () => {
    registerResponseAtomStubs()
    let draftRound = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'draft') {
        draftRound += 1
        return draftRound === 1 ? '申请人恳请审查员重新考虑审查意见。' : '审查意见对权利要求 1 的创造性异议不能成立。'
      }
      if (stage.id === 'slop_gate') {
        return draftRound === 1 ? '反套话评分门: ⚠️ 需修订（总分 28，通过线 35）' : '反套话评分门: ✅ 通过（总分 41，通过线 35）'
      }
      if (stage.id === 'approval') return 'APPROVED'
      return `${stage.id} 完成`
    }

    const result = await runWorkflow(patentOaResponseManifest, { input: '通知书' }, executor, {
      handlers: new StageHandlerRegistry(),
    })
    expect(draftRound).toBe(2)
    const gate = result.stages.find(s => s.stageId === 'slop_gate')!
    expect(gate.output).toContain('✅ 通过')
    expect(gate.degraded).toBe(false)
    // 回退 splice 掉首轮结果：只留重跑后的产出，成品不会拿到那版套话稿。
    const draft = result.stages.filter(s => s.stageId === 'draft')
    expect(draft).toHaveLength(1)
    expect(draft[0]!.output).toContain('不能成立')
    expect(result.degradedSteps).toHaveLength(0)
  })

  it('持续不通过时只回退一次，随后记降级而不是死循环', async () => {
    registerResponseAtomStubs()
    let draftRound = 0
    const executor = async (stage: WorkflowStage) => {
      if (stage.id === 'draft') { draftRound += 1; return '申请人恳请审查员重新考虑审查意见。' }
      if (stage.id === 'slop_gate') return '反套话评分门: ⚠️ 需修订（总分 28，通过线 35）'
      if (stage.id === 'approval') return 'APPROVED'
      return `${stage.id} 完成`
    }

    const result = await runWorkflow(patentOaResponseManifest, { input: '通知书' }, executor, {
      handlers: new StageHandlerRegistry(),
    })
    expect(draftRound).toBe(2) // 初次 + 一次回退（maxRetries=1），此后耗尽
    const gate = result.stages.find(s => s.stageId === 'slop_gate')!
    expect(gate.output).toMatch(/\[WORKFLOW_RETRY_EXHAUSTED\]/)
    expect(result.degradedSteps).toContain('slop_gate')
  })
})
