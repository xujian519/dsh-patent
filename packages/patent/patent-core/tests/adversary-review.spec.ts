import { describe, expect, it } from 'vitest'
import {
  AdversaryReviewHandler,
  adversaryReviewAtom,
  reviewFinalDraft,
  detectMissedRejections,
  detectEvidenceGaps,
  identifyReviewDisputes,
  statuteForEvidenceGap,
  confidenceForEvidenceGap,
  assessArgumentStrength,
  computeReviewConfidence,
  buildReviewSummary,
  CITATION_GAP_HEURISTIC_CONFIDENCE,
  INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE,
  CLAIMS_COVERAGE_GAP_HEURISTIC_CONFIDENCE,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
} from '@deepseek-ai/dsh-patent-core'
import type {
  AdversaryReviewReport,
  AdversaryReviewInput,
  AdversaryReviewOfficeAction,
} from '@deepseek-ai/dsh-patent-core'

// 注册内置原子（幂等操作）
registerBuiltinAtoms()

describe('adversary-review atom', () => {
  it('atom 声明正确', () => {
    expect(adversaryReviewAtom.name).toBe('adversary-review')
    expect(adversaryReviewAtom.category).toBe('gate')
    expect(adversaryReviewAtom.usesModel).toBe(false)
    expect(adversaryReviewAtom.inputSchema).toEqual([
      'draft_tightened',
      'draft',
      'reference_documents',
      'claims',
      'office_action',
    ])
    expect(adversaryReviewAtom.logInputScope).toBe(true)
    expect(adversaryReviewAtom.outputSchema).toEqual([
      'adversary_review_report',
      'adversary_review_disputes',
      'adversary_review_confidence',
      'adversary_review_full_report',
      'adversary_review_passed',
    ])
  })

  it('inputSchema 不包含己方中间推理键', () => {
    expect(adversaryReviewAtom.inputSchema).not.toContain('dispute_framing_report')
    expect(adversaryReviewAtom.inputSchema).not.toContain('claim_chart')
    expect(adversaryReviewAtom.inputSchema).not.toContain('response_plan')
    expect(adversaryReviewAtom.inputSchema).not.toContain('response_plan_summary')
  })

  it('handler 名称与 atom 一致', () => {
    const handler = new AdversaryReviewHandler()
    expect(handler.name).toBe('adversary-review')
    expect(handler.category).toBe('gate')
  })

  it('atom 注册成功', () => {
    const registered = globalAtomRegistry.lookup('adversary-review')
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('adversary-review')
  })

  it('handler 注册成功', () => {
    const registered = globalStageHandlerRegistry.lookup('adversary-review')
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('adversary-review')
  })
})

describe('detectMissedRejections', () => {
  it('检测遗漏的驳回理由', () => {
    const finalDraft = '本申请具有创造性，符合专利法第22条第3款'
    const officeAction: AdversaryReviewOfficeAction = {
      rejectionTypes: ['inventiveness', 'novelty'],
      affectedClaims: [1, 2],
    }
    const missed = detectMissedRejections(finalDraft, officeAction)
    // 创造性被回应，新颖性未被回应
    expect(missed).toContain('novelty')
    expect(missed).not.toContain('inventiveness')
  })

  it('无驳回理由时返回空', () => {
    const missed = detectMissedRejections('test', { rejectionTypes: [] })
    expect(missed).toEqual([])
  })

  it('无通知书时返回空', () => {
    const missed = detectMissedRejections('test', undefined)
    expect(missed).toEqual([])
  })
})

describe('detectEvidenceGaps', () => {
  it('检测未引用对比文件', () => {
    const finalDraft = '本申请具有创造性'
    const referenceDocuments = 'CN1234567A 公开了一种方法'
    const gaps = detectEvidenceGaps(finalDraft, referenceDocuments, undefined)
    expect(gaps.length).toBeGreaterThan(0)
  })

  it('检测创造性论证缺失', () => {
    const finalDraft = '本申请符合专利法规定'
    const officeAction: AdversaryReviewOfficeAction = {
      rejectionTypes: ['inventiveness'],
    }
    const gaps = detectEvidenceGaps(finalDraft, '', officeAction)
    expect(gaps.some(g => g.includes('创造性'))).toBe(true)
  })

  it('无输入时返回空', () => {
    const gaps = detectEvidenceGaps('', '', undefined)
    expect(gaps).toEqual([])
  })
})

describe('identifyReviewDisputes 法条归因与置信度分档（#653）', () => {
  it('新颖性遗漏驳回理由归 A22.2，且关键词启发式置信度低于 0.9', () => {
    const disputes = identifyReviewDisputes(
      { rejectionTypes: ['novelty'], affectedClaims: [1] },
      ['novelty'],
      [],
    )
    expect(disputes).toHaveLength(1)
    expect(disputes[0]?.statute).toBe('A22.2')
    expect(disputes[0]?.confidence).toBeLessThan(0.9)
    expect(disputes[0]?.confidence).toBeGreaterThan(0)
  })

  it('不清楚（clarity）遗漏驳回理由归 A26.4，不标成 A22.3', () => {
    const disputes = identifyReviewDisputes(
      { rejectionTypes: ['clarity'], affectedClaims: [2] },
      ['clarity'],
      [],
    )
    expect(disputes[0]?.statute).toBe('A26.4')
    expect(disputes[0]?.statute).not.toBe('A22.3')
  })

  it('仅新颖性通知书下的对比文件缺口归 A22.2，不默认 A22.3', () => {
    const disputes = identifyReviewDisputes(
      { rejectionTypes: ['novelty'], affectedClaims: [1] },
      [],
      ['最终产物未引用对比文件内容'],
    )
    expect(disputes).toHaveLength(1)
    expect(disputes[0]?.statute).toBe('A22.2')
    expect(disputes[0]?.statute).not.toBe('A22.3')
  })

  it('权利要求覆盖缺口归 A26.4', () => {
    const disputes = identifyReviewDisputes(
      { rejectionTypes: ['claim-clarity'], affectedClaims: [1, 2] },
      [],
      ['最终产物未引用任何权利要求编号（共 2 项权项标记未覆盖）'],
    )
    expect(disputes[0]?.statute).toBe('A26.4')
  })

  it('无通知书驳回类型时，对比文件缺口不捏造 A22.3', () => {
    const disputes = identifyReviewDisputes(undefined, [], ['最终产物未引用对比文件内容'])
    expect(disputes[0]?.statute).toBe('unknown')
  })
})

describe('statuteForEvidenceGap / confidenceForEvidenceGap', () => {
  it('对比文件缺口遇到未映射驳回类型时返回 unknown', () => {
    expect(
      statuteForEvidenceGap('最终产物未引用对比文件内容', {
        rejectionTypes: ['not-a-real-ground'],
      }),
    ).toBe('unknown')
  })

  it('无法归因关键词的缺口不捏造 A22.3', () => {
    expect(statuteForEvidenceGap('论证力度不足', { rejectionTypes: ['novelty'] })).toBe('unknown')
  })

  it('按缺口文案分档置信度，未命中关键词时回落创造性档', () => {
    expect(confidenceForEvidenceGap('最终产物未引用对比文件内容')).toBe(
      CITATION_GAP_HEURISTIC_CONFIDENCE,
    )
    expect(confidenceForEvidenceGap('通知书指出创造性问题但最终产物未论证')).toBe(
      INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE,
    )
    expect(confidenceForEvidenceGap('最终产物未引用任何权利要求编号')).toBe(
      CLAIMS_COVERAGE_GAP_HEURISTIC_CONFIDENCE,
    )
    expect(confidenceForEvidenceGap('论证力度不足')).toBe(INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE)
  })
})

describe('assessArgumentStrength', () => {
  it('有遗漏驳回理由时返回 insufficient', () => {
    const strength = assessArgumentStrength(['novelty'], [], [])
    expect(strength).toBe('insufficient')
  })

  it('有多个证据缺口时返回 weak', () => {
    const strength = assessArgumentStrength([], ['gap1', 'gap2'], [])
    expect(strength).toBe('weak')
  })

  it('有高置信度争议点时返回 weak', () => {
    const disputes = [
      { statute: 'A22.3', claims: [1], point: 'test', relation: 'disagreement' as const, confidence: 0.9, tag: 'heuristic' as const },
    ]
    const strength = assessArgumentStrength([], [], disputes)
    expect(strength).toBe('weak')
  })

  it('无问题时返回 strong', () => {
    const strength = assessArgumentStrength([], [], [])
    expect(strength).toBe('strong')
  })
})

describe('computeReviewConfidence', () => {
  it('无争议点且论证充分时返回高置信度', () => {
    const confidence = computeReviewConfidence([], 'strong')
    expect(confidence).toBe(0.8)
  })

  it('无争议点但论证不足时返回低置信度', () => {
    const confidence = computeReviewConfidence([], 'insufficient')
    expect(confidence).toBe(0.5)
  })

  it('有争议点时基于加权平均计算', () => {
    const disputes = [
      { statute: 'A22.3', claims: [1], point: 'test', relation: 'disagreement' as const, confidence: 0.8, tag: 'heuristic' as const },
    ]
    const confidence = computeReviewConfidence(disputes, 'strong')
    expect(confidence).toBeGreaterThan(0)
    expect(confidence).toBeLessThanOrEqual(1)
  })
})

describe('buildReviewSummary', () => {
  it('生成可读摘要', () => {
    const summary = buildReviewSummary(['novelty'], ['gap1'], 'weak', 0.6)
    expect(summary).toContain('部分不足')
    expect(summary).toContain('遗漏')
    expect(summary).toContain('证据缺口')
    expect(summary).toContain('60.0%')
  })

  it('无问题时摘要显示充分', () => {
    const summary = buildReviewSummary([], [], 'strong', 0.8)
    expect(summary).toContain('充分')
    expect(summary).toContain('80.0%')
  })
})

describe('reviewFinalDraft', () => {
  it('完整流程：读取输入、生成报告', () => {
    const input: AdversaryReviewInput = {
      finalDraft: '本申请具有创造性，符合专利法第22条第3款',
      referenceDocuments: 'CN1234567A 公开了一种方法',
      claims: '权利要求1-2',
      officeAction: {
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1, 2],
      },
    }
    const report = reviewFinalDraft(input)
    expect(report).toBeDefined()
    expect(report.argumentStrength).toBeDefined()
    expect(report.missedRejections).toBeDefined()
    expect(report.evidenceGaps).toBeDefined()
    expect(report.overallConfidence).toBeGreaterThanOrEqual(0)
    expect(report.overallConfidence).toBeLessThanOrEqual(1)
    expect(report.summary).toBeDefined()
  })

  it('无输入时仍生成报告', () => {
    const report = reviewFinalDraft({})
    expect(report).toBeDefined()
    expect(report.missedRejections).toEqual([])
    expect(report.overallConfidence).toBeGreaterThanOrEqual(0)
  })
})

describe('handler execute', () => {
  it('完整流程：读取 draft 输入、生成报告', async () => {
    const handler = new AdversaryReviewHandler()
    const state = {
      draft: '本申请具有创造性，符合专利法第22条第3款',
      reference_documents: 'CN1234567A 公开了一种方法',
      claims: '权利要求1-2',
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1, 2],
      }),
    }
    const result = await handler.execute({ state })
    expect(result.adversary_review_report).toBeDefined()
    expect(typeof result.adversary_review_report).toBe('string')
    expect(result.adversary_review_disputes).toBeDefined()
    expect(typeof result.adversary_review_confidence).toBe('number')
  })

  it('兼容旧 final_draft 键', async () => {
    const handler = new AdversaryReviewHandler()
    const result = await handler.execute({ state: { final_draft: '本申请具有创造性' } })
    expect(result.adversary_review_report).toBeDefined()
  })

  it('无输入时仍生成报告', async () => {
    const handler = new AdversaryReviewHandler()
    const result = await handler.execute({ state: {} })
    expect(result.adversary_review_report).toBeDefined()
    expect(result.adversary_review_confidence).toBeGreaterThanOrEqual(0)
  })

  it('无通知书时，证据缺口争议点使用空权项列表且不捏造 A22.3', async () => {
    const handler = new AdversaryReviewHandler()
    const result = await handler.execute({
      state: {
        draft: '本申请具有创造性',
        claims: '权利要求1：一种结构',
        // 须含 CN 文献号，才能触发 extractReferenceKeywords 的对比文件引用检查。
        reference_documents: 'CN1234567A 公开了阀体与直管加热结构',
      },
    })
    const disputes = result.adversary_review_disputes as Array<{
      statute: string
      claims: number[]
      point: string
    }>
    const citationDispute = disputes.find(dispute => dispute.point.includes('对比文件'))
    expect(citationDispute).toBeDefined()
    expect(citationDispute?.claims).toEqual([])
    expect(citationDispute?.statute).toBe('unknown')
    expect(disputes.every(dispute => dispute.statute !== 'A22.3')).toBe(true)
  })

  it('reference_documents 为空时，从 office_action.citations 派生对比文件文本', async () => {
    const handler = new AdversaryReviewHandler()
    const withCitations = await handler.execute({
      state: {
        draft: '本申请具有创造性，符合专利法第22条第3款',
        claims: '权利要求1',
        office_action: JSON.stringify({
          rejectionTypes: ['inventiveness'],
          affectedClaims: [1],
          citations: [{ documentNumber: 'CN1234567A', claimsAffected: [1] }],
        }),
      },
    })
    const withoutCitations = await handler.execute({
      state: {
        draft: '本申请具有创造性，符合专利法第22条第3款',
        claims: '权利要求1',
        office_action: JSON.stringify({
          rejectionTypes: ['inventiveness'],
          affectedClaims: [1],
          citations: [],
        }),
      },
    })
    // 有引用文献时应跑到对比文件引用检查；无引用时不应凭空产出「未引用对比文件」缺口。
    const withGaps = (withCitations.adversary_review_full_report as { evidenceGaps: string[] }).evidenceGaps
    const withoutGaps = (withoutCitations.adversary_review_full_report as { evidenceGaps: string[] })
      .evidenceGaps
    expect(withGaps.some(gap => gap.includes('对比文件'))).toBe(true)
    expect(withoutGaps.some(gap => gap.includes('对比文件'))).toBe(false)
  })

  it('citations 派生时跳过非法条目，并接受合法 relevancy / 非数组 claimsAffected', async () => {
    const handler = new AdversaryReviewHandler()
    const result = await handler.execute({
      state: {
        draft: '本申请具有创造性，符合专利法第22条第3款',
        claims: '权利要求1',
        office_action: JSON.stringify({
          rejectionTypes: ['inventiveness'],
          affectedClaims: [1],
          citations: [
            null,
            ['not-an-object'],
            { documentNumber: '   ' },
            { documentNumber: 'CN1111111A', relevancy: 'not-a-code', claimsAffected: '1' },
            { documentNumber: 'CN1234567A', relevancy: 'X', claimsAffected: [1] },
          ],
        }),
      },
    })
    const gaps = (result.adversary_review_full_report as { evidenceGaps: string[] }).evidenceGaps
    // 合法 documentNumber 仍应派生出对比文件文本并触发缺口检查。
    expect(gaps.some(gap => gap.includes('对比文件'))).toBe(true)
  })

  it('论证严重不足时 adversary_review_passed 为 false', async () => {
    const handler = new AdversaryReviewHandler()
    const result = await handler.execute({
      state: {
        draft: '本申请符合专利法规定',
        office_action: JSON.stringify({
          rejectionTypes: ['novelty', 'inventiveness'],
          affectedClaims: [1],
        }),
      },
    })
    expect(result.adversary_review_passed).toBe(false)
  })

  it('共享 state 含上游中间产物时，审查结果与干净 state 完全相同', async () => {
    const handler = new AdversaryReviewHandler()
    const clean = {
      draft: '本申请具有创造性，符合专利法第22条第3款',
      claims: '权利要求1',
      reference_documents: 'D1 公开了阀体',
      office_action: JSON.stringify({ rejectionTypes: ['inventiveness'], affectedClaims: [1] }),
    }
    const polluted = {
      ...clean,
      dispute_framing_report: '己方推理',
      claim_chart: '己方映射',
      response_plan: '己方计划',
      final_draft: '旧稿不应被读取',
    }
    const cleanResult = await handler.execute({ state: clean })
    const pollutedResult = await handler.execute({ state: polluted })
    expect(pollutedResult).toEqual(cleanResult)
  })
})

describe('AdversaryReviewReport 类型', () => {
  it('输出结构符合类型定义', () => {
    const report: AdversaryReviewReport = {
      disputes: [],
      argumentStrength: 'strong',
      missedRejections: [],
      evidenceGaps: [],
      overallConfidence: 0.8,
      summary: '测试摘要',
    }
    expect(report.argumentStrength).toBe('strong')
    expect(Array.isArray(report.disputes)).toBe(true)
    expect(Array.isArray(report.missedRejections)).toBe(true)
    expect(Array.isArray(report.evidenceGaps)).toBe(true)
    expect(typeof report.overallConfidence).toBe('number')
    expect(typeof report.summary).toBe('string')
  })
})
