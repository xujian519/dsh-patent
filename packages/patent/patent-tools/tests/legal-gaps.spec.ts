import { describe, expect, it } from 'vitest'
import type { PipelineState } from '@deepseek-ai/dsh-patent-core'
import {
  LEGAL_GAP_CHECKS,
  LEGAL_GAP_PROFILES,
  LegalGapsHandler,
  legalGapsAtom,
  type LegalGapItem,
} from '../src/atoms/legal-gaps.ts'

/**
 * 运行 legal-gaps 并取出汇总项。
 * @param state - 阶段执行态。
 * @returns `legal_gaps_items`（非数组时为空）。
 */
async function itemsOf(state: PipelineState): Promise<LegalGapItem[]> {
  const out = await new LegalGapsHandler().execute({ state })
  const items = out['legal_gaps_items']
  return Array.isArray(items) ? (items as LegalGapItem[]) : []
}

describe('legal-gaps 原子', () => {
  it('声明 profile 输入与四项输出，并覆盖全部案件类型', () => {
    expect(legalGapsAtom.name).toBe('legal-gaps')
    expect(legalGapsAtom.inputSchema).toContain('profile')
    expect(legalGapsAtom.inputSchema).toEqual(expect.arrayContaining([
      'evidence_check_report',
      'novelty',
      'inventiveness',
      'prior_art_defense_report',
    ]))
    expect(legalGapsAtom.outputSchema).toEqual([
      'legal_gaps_report',
      'legal_gaps_passed',
      'legal_gaps_items',
      'legal_gaps_unassessed',
    ])
    expect(Object.keys(LEGAL_GAP_CHECKS).sort()).toEqual([...LEGAL_GAP_PROFILES].sort())
    for (const checks of Object.values(LEGAL_GAP_CHECKS)) {
      for (const check of checks) {
        expect(check.provision.trim().length).toBeGreaterThan(0)
        expect(check.label.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('inputSchema 派生自检查清单：收录每条检查的评估、失败、待核与范围键', () => {
    const declared = new Set(legalGapsAtom.inputSchema)
    expect(declared.size).toBe(legalGapsAtom.inputSchema.length)
    for (const checks of Object.values(LEGAL_GAP_CHECKS)) {
      for (const check of checks) {
        const keys = [
          ...check.assessKeys,
          ...(check.failureKey === undefined ? [] : [check.failureKey]),
          ...(check.pendingKey === undefined ? [] : [check.pendingKey]),
          ...(check.scopeKey === undefined ? [] : [check.scopeKey]),
        ]
        for (const key of keys) {
          expect(declared.has(key), `${check.id} 的 ${key}`).toBe(true)
        }
      }
    }
    // 声明 notApplicable 判据的检查必须给出范围键，否则派生会漏掉它读取的状态。
    for (const checks of Object.values(LEGAL_GAP_CHECKS)) {
      for (const check of checks) {
        if (check.notApplicable !== undefined) expect(check.scopeKey).toBeDefined()
      }
    }
    expect(legalGapsAtom.inputSchema).toContain('amendment_basis_scope')
  })

  it('答复清单：检查均通过时判定通过，并给出法条依据', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：通过',
        response_check_passed: true,
        response_check_unevaluated: [],
        response_concision_report: '答复表达质量检查：通过',
        response_concision_passed: true,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
        amendment_basis_scope: '原始权利要求书、原说明书',
        adversary_review_report: '论证强度：充分；整体置信度：80.0%',
        adversary_review_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual([])
    const report = String(out['legal_gaps_report'])
    expect(report).toContain('无阻断项')
    expect(report).toContain('专利法第26条第3款')
    expect(report).toContain('专利法第33条')
    expect(report).toContain('换位审查')
    expect(report).toContain('不替代审查意见')
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.every(item => item.status === 'passed')).toBe(true)
  })

  it('答复清单：换位审查未通过记为 warn 项，不翻转 legal_gaps_passed（#653）', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：通过',
        response_check_passed: true,
        response_concision_report: '答复表达质量检查：通过',
        response_concision_passed: true,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
        adversary_review_report: '论证强度：严重不足；遗漏 1 项驳回理由',
        adversary_review_passed: false,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'adversary-review')).toMatchObject({
      status: 'failed',
      severity: 'warn',
      evidence: 'state.adversary_review_passed = false',
    })
  })

  it('答复清单：答复检查失败时形成阻断项（G-13 反例）', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：未通过（1 条违规）',
        response_check_passed: false,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(false)
    const report = String(out['legal_gaps_report'])
    expect(report).toContain('未通过')
    expect(report).toContain('1 项阻断')
    expect(report).toContain('response_check_passed = false')
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'response-compliance')).toMatchObject({
      status: 'failed',
      severity: 'block',
    })
  })

  it('答复清单：待核项记为未评估，但不形成阻断', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：通过（1 项未评估）',
        response_check_passed: true,
        response_check_unevaluated: [{ rule: 'PR-OA-008', reason: '缺少通知书' }],
        response_concision_report: '答复表达质量检查：通过',
        response_concision_passed: true,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
        adversary_review_report: '论证强度：充分',
        adversary_review_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual(['response-compliance'])
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'response-compliance')?.evidence).toContain('1 项待核')
  })

  it('答复清单：表达质量未通过记为 warn 项，不翻转 legal_gaps_passed', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：通过',
        response_check_passed: true,
        response_concision_report: '答复表达质量检查：未通过（2 条违规）',
        response_concision_passed: false,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
        adversary_review_report: '论证强度：充分',
        adversary_review_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'response-concision')).toMatchObject({
      status: 'failed',
      severity: 'warn',
      evidence: 'state.response_concision_passed = false',
    })
    const report = String(out['legal_gaps_report'])
    expect(report).toContain('无阻断项（1 项未通过')
    expect(report).toContain('答复撰写规范：篇幅与论证密度')
  })

  it('答复清单：未检测到修改后权利要求时 A33 记不适用', async () => {
    const items = await itemsOf({
      profile: 'oa-response',
      response_check_report: '答复规范检查：通过',
      response_check_passed: true,
      amendment_basis_report: '修改依据检查：通过（A33 不适用）',
      amendment_basis_passed: true,
      amendment_basis_scope: '未检测到修改后权利要求',
      adversary_review_report: '论证强度：充分',
      adversary_review_passed: true,
    })
    expect(items.find(item => item.id === 'amendment-basis')?.status).toBe('not-applicable')
  })

  it('没有任何检查产出时列出全部法条为未评估，不空转（G-13 反例）', async () => {
    const out = await new LegalGapsHandler().execute({ state: { profile: 'oa-response' } })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual([
      'response-compliance',
      'response-concision',
      'amendment-basis',
      'adversary-review',
    ])
    const report = String(out['legal_gaps_report'])
    expect(report).toContain('4 项未评估')
    expect(report).toContain('专利法第26条第3款')
    expect(report).toContain('专利法第33条')
    expect(report).toContain('换位审查')
    expect(report).toContain('未被任何确定性阶段覆盖')
  })

  it('反哺覆盖为空或非数组时不声称补提过事实', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'novelty',
        revision_coverage: { 'time-baseline': [], 'grace-period': 'not-an-array' },
      },
    })
    expect(String(out['legal_gaps_report'])).not.toContain('反哺轮次补提')
  })

  it('新颖性清单：时间基准缺失时 A22.5 记未评估', async () => {
    const items = await itemsOf({
      profile: 'novelty',
      novelty_conclusion: '权利要求 1 具备新颖性',
    })
    expect(items.find(item => item.id === 'time-baseline')).toMatchObject({
      status: 'not-assessed',
      provision: '专利法第22条第5款',
    })
    expect(items.find(item => item.id === 'novelty')?.status).toBe('passed')
  })

  it('披露清单：eligibility 失败形成阻断项', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'disclosure',
        eligibility_report: '可专利客体筛查：未通过',
        eligibility_passed: false,
        eligibility_pending: [],
      },
    })
    expect(out['legal_gaps_passed']).toBe(false)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'eligibility')).toMatchObject({
      status: 'failed',
      severity: 'block',
      provision: '专利法第2条第2款、第5条、第25条',
    })
  })

  it('无效清单：证据审查失败形成阻断项，新颖性与创造性理由按阶段产出判定', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'invalidation',
        evidence_check_report: '证据审查（无效/复审）：未通过（1 条阻断）',
        evidence_check_passed: false,
        evidence_check_pending: [],
        novelty: '权利要求 1 不具备新颖性（D1 单独公开全部特征）',
        inventiveness: '权利要求 1 不具备创造性',
      },
    })
    expect(out['legal_gaps_passed']).toBe(false)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'evidence')).toMatchObject({
      status: 'failed',
      severity: 'block',
      provision: '审查指南第四部分第三章4.3.2',
    })
    expect(items.find(item => item.id === 'novelty')?.status).toBe('passed')
    expect(items.find(item => item.id === 'inventiveness')?.status).toBe('passed')
    expect(out['legal_gaps_unassessed']).toEqual([])
  })

  it('无效清单：证据审查未执行时记为未评估，不把缺证据当成证据合格', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'invalidation',
        evidence_check_report: '证据审查（无效/复审）：未执行（未提供证据清单）',
        evidence_check_passed: true,
        evidence_check_pending: [],
        novelty: '权利要求 1 具备新颖性',
        inventiveness: '权利要求 1 具备创造性',
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual(['evidence'])
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'evidence')?.evidence).toContain('本次未执行')
  })

  it('无效清单：降级输出不算已评估', async () => {
    const items = await itemsOf({
      profile: 'invalidation',
      evidence_check_report: '证据审查（无效/复审）：未执行（未提供证据清单）',
      evidence_check_passed: true,
      novelty: '[WORKFLOW_DEGRADED] novelty: 模型调用失败',
      inventiveness: '[WORKFLOW_DEGRADED] inventiveness: 模型调用失败',
    })
    expect(items.find(item => item.id === 'novelty')?.status).toBe('not-assessed')
    expect(items.find(item => item.id === 'inventiveness')?.status).toBe('not-assessed')
  })

  it('侵权清单：保护范围按要素网格与覆盖结论判定，现有技术抗辩尚无确定性产出', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'infringement',
        claim_chart_doc: '{"claims":[{"id":"1"}],"targets":[]}',
        coverage_report: '{"verdict":"no-literal-infringement"}',
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual(['prior-art-defense'])
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'protection-scope')).toMatchObject({
      status: 'passed',
      provision: '专利法第59条',
    })
    expect(items.find(item => item.id === 'prior-art-defense')).toMatchObject({
      status: 'not-assessed',
      provision: '专利法第62条',
    })
  })

  it('披露清单：检索过滤、权项支持与说明书检查分别覆盖宽限期、A26.4 与 A26.3', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'disclosure',
        eligibility_report: '可专利客体筛查：通过',
        eligibility_passed: true,
        eligibility_pending: [],
        reference_date: '2024-06-01',
        prior_art_filter_report: '现有技术过滤：排除 1 篇晚于截止日的文献',
        novelty_result: '逐特征新颖性初判：具备新颖性',
        spec_form_check_report: '说明书形式检查：通过',
        spec_form_check_passed: true,
        spec_claims_check_report: '权利要求支持与单一性检查：通过',
        spec_claims_check_passed: true,
        enablement_report: '充分公开：通过',
        enablement_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual(['claim-support-breadth'])
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'grace-period')?.status).toBe('passed')
    expect(items.find(item => item.id === 'spec-form')?.status).toBe('passed')
    expect(items.find(item => item.id === 'claim-support')?.status).toBe('passed')
    expect(items.find(item => item.id === 'enablement')).toMatchObject({
      status: 'passed',
      provision: '专利法第26条第3款',
    })
  })

  it('披露清单：形式检查失败形成阻断项，充分公开没有实体报告时记未评估', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'disclosure',
        spec_form_check_report: '说明书形式检查：未通过（缺少必要章节）',
        spec_form_check_passed: false,
      },
    })
    expect(out['legal_gaps_passed']).toBe(false)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'spec-form')).toMatchObject({
      status: 'failed',
      severity: 'block',
    })
    // 形式检查不能证明“能够实现”；只有 enablement_report 才能判通过。
    expect(items.find(item => item.id === 'enablement')).toMatchObject({
      status: 'not-assessed',
      severity: 'warn',
    })
  })

  it('披露清单：充分公开报告存在但判定缺失时记未评估，不静默判通过', async () => {
    const items = await itemsOf({
      profile: 'disclosure',
      enablement_report: '充分公开实体判定（A26.3）：通过',
    })
    expect(items.find(item => item.id === 'enablement')).toMatchObject({
      status: 'not-assessed',
      severity: 'warn',
    })
    expect(items.find(item => item.id === 'enablement')?.evidence).toContain(
      '缺少 state.enablement_passed 的布尔判定',
    )
  })

  it('披露清单：充分公开实体判定为 false 时形成警告项', async () => {
    const items = await itemsOf({
      profile: 'disclosure',
      enablement_report: '充分公开实体判定（A26.3）：未通过',
      enablement_passed: false,
    })
    expect(items.find(item => item.id === 'enablement')).toMatchObject({
      status: 'failed',
      severity: 'warn',
      provision: '专利法第26条第3款',
    })
    expect(items.find(item => item.id === 'enablement')?.evidence).toBe('state.enablement_passed = false')
  })

  it('披露清单：降级报告不构成充分公开判定', async () => {
    const items = await itemsOf({
      profile: 'disclosure',
      enablement_report: '[WORKFLOW_DEGRADED] 未配置模型客户端',
      enablement_passed: true,
    })
    expect(items.find(item => item.id === 'enablement')).toMatchObject({
      status: 'not-assessed',
      severity: 'warn',
    })
  })

  it('创造性清单：技术问题校验失败形成阻断项，结论阶段产出覆盖 A22.3', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'inventiveness',
        problem_check_report: '技术问题校验：未通过（问题包含解决手段）',
        problem_check_passed: false,
        conclude: '创造性结论：不具备创造性',
      },
    })
    expect(out['legal_gaps_passed']).toBe(false)
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'problem')).toMatchObject({
      status: 'failed',
      severity: 'block',
      provision: '专利法第22条第3款',
    })
    expect(items.find(item => item.id === 'inventiveness')?.status).toBe('passed')
    expect(out['legal_gaps_unassessed']).toEqual(['time-baseline', 'grace-period'])
  })

  it('可专利性清单：客体、权项支持与充分公开通过，缺时间基准与宽限期产出时记未评估', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'patentability',
        eligibility_report: '可专利客体筛查：通过',
        eligibility_passed: true,
        eligibility_pending: [],
        spec_form_check_report: '说明书形式检查：通过',
        spec_form_check_passed: true,
        spec_claims_check_report: '权利要求支持与单一性检查：通过',
        spec_claims_check_passed: true,
        enablement_report: '充分公开：通过',
        enablement_passed: true,
      },
    })
    expect(out['legal_gaps_passed']).toBe(true)
    expect(out['legal_gaps_unassessed']).toEqual(['time-baseline', 'grace-period', 'claim-support-breadth'])
    const items = out['legal_gaps_items'] as LegalGapItem[]
    expect(items.find(item => item.id === 'eligibility')?.status).toBe('passed')
    expect(items.find(item => item.id === 'claim-support')?.status).toBe('passed')
    expect(items.find(item => item.id === 'enablement')?.status).toBe('passed')
    // 概括范围始终需要实体判断，不因其他检查通过而变成 passed。
    expect(items.find(item => item.id === 'claim-support-breadth')?.status).toBe('not-assessed')
  })

  it('profile 缺失或未知时降级，不猜测案件类型', async () => {
    const missing = await new LegalGapsHandler().execute({ state: {} })
    expect(String(missing['_error'])).toContain('params.profile')
    const unknown = await new LegalGapsHandler().execute({ state: { profile: 'unknown' } })
    expect(String(unknown['_error'])).toContain('params.profile')
  })

  it('数组形式的评估产出算已评估', async () => {
    const items = await itemsOf({
      profile: 'novelty',
      compare: [{ citationId: 'D1' }],
    })
    expect(items.find(item => item.id === 'novelty')).toMatchObject({
      status: 'passed',
      evidence: '已由 state.compare 评估',
    })
  })

  it('显式 null 的评估键不算已评估', async () => {
    const items = await itemsOf({
      profile: 'novelty',
      reference_date: null,
    })
    expect(items.find(item => item.id === 'time-baseline')?.status).toBe('not-assessed')
  })

  it('未评估项产出反哺清单与结构化回退信号，数量受上限约束', async () => {
    const out = await new LegalGapsHandler().execute({ state: { profile: 'patentability' } })
    expect(out['revision_targets']).toEqual([
      { checkId: 'eligibility', provision: '专利法第2条第2款、第5条、第25条', label: '可专利客体' },
      { checkId: 'time-baseline', provision: '专利法第22条第5款', label: '现有技术时间基准' },
      { checkId: 'grace-period', provision: '专利法第24条', label: '宽限期公开' },
      { checkId: 'spec-form', provision: '专利法实施细则第20条、第21条；审查指南第二部分第二章2.2.2–2.2.7', label: '说明书形式要求' },
      { checkId: 'claim-support', provision: '专利法第26条第4款、第31条第1款', label: '权利要求特征覆盖与单一性' },
      { checkId: 'enablement', provision: '专利法第26条第3款', label: '充分公开' },
    ])
    const signals = out['_revision_signals'] as Array<{ gapId: string; rationale: string }>
    expect(signals.map(signal => signal.gapId)).toEqual([
      'eligibility',
      'time-baseline',
      'grace-period',
      'spec-form',
      'claim-support',
      'enablement',
    ])
    expect(signals[0]!.rationale).toContain('专利法第2条第2款')
    // revision_targets 不列入 outputSchema：回退清理不能删除它，否则采集阶段读不到。
    expect(legalGapsAtom.outputSchema).not.toContain('revision_targets')
  })

  it('没有未评估项时清空反哺清单且不产生信号', async () => {
    const out = await new LegalGapsHandler().execute({
      state: {
        profile: 'oa-response',
        response_check_report: '答复规范检查：通过',
        response_check_passed: true,
        response_concision_report: '答复表达质量检查：通过',
        response_concision_passed: true,
        amendment_basis_report: '修改依据检查：通过',
        amendment_basis_passed: true,
        adversary_review_report: '论证强度：充分',
        adversary_review_passed: true,
      },
    })
    expect(out['revision_targets']).toEqual([])
    expect(out['_revision_signals']).toBeUndefined()
  })
})
