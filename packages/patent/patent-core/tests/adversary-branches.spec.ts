/** Remaining branches of the adversary review, report, parse, prompt, and risk ranking. */
import { describe, expect, it } from 'vitest'
import {
  AdversaryModelHandler,
  assessEvidenceIndependent,
  buildAdversaryPrompt,
  buildAdversaryReport,
  buildReviewSummary,
  computeReviewConfidence,
  detectClaimsCoverage,
  detectEvidenceGaps,
  detectMissedRejections,
  identifyReviewDisputes,
  locateDisputesIndependent,
  parseAdversaryOutput,
  renderAdversaryReport,
  reviewFinalDraft,
  type AdversaryDispute,
  type AdversaryOfficeAction,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'

const officeAction = (value: unknown): AdversaryOfficeAction => value as AdversaryOfficeAction

describe('assessEvidenceIndependent branches', () => {
  it('treats absent structured fields as empty', () => {
    const disputes = assessEvidenceIndependent({}, [{ ground: 'inventiveness', strategy: 'amend', claims: [1] }])
    expect(disputes).toEqual([])
  })

  it('skips non-string and unmapped grounds and keeps empty claim lists', () => {
    const disputes = assessEvidenceIndependent(
      officeAction({ rejectionTypes: [42, 'unknown-ground'], affectedClaims: [] }),
      [{ ground: 'inventiveness', strategy: 'amend' }],
    )
    expect(disputes).toEqual([])
  })

  it('reports a missing ground with no affected claims', () => {
    const disputes = assessEvidenceIndependent(
      { rejectionTypes: ['inventiveness'], affectedClaims: [] },
      [{ ground: 'novelty', strategy: 'amend', claims: [1] }],
    )
    expect(disputes.find(dispute => dispute.statute === 'A22.3')?.claims).toEqual([])
  })

  it('skips a misaligned strategy whose ground has no statute', () => {
    const disputes = assessEvidenceIndependent(
      { rejectionTypes: [], affectedClaims: [1] },
      [{ ground: 'unknown-ground', strategy: 'amend', claims: [2] }],
    )
    expect(disputes).toEqual([])
  })

  it('reports a strategy without claims as neither missing coverage nor misaligned', () => {
    const disputes = assessEvidenceIndependent(
      { rejectionTypes: [], affectedClaims: [1] },
      [{ ground: 'unknown-ground', strategy: 'amend' }],
    )
    expect(disputes).toEqual([])
  })
})

describe('locateDisputesIndependent branches', () => {
  it('falls back to scanned claim numbers when the text carries no claims', () => {
    const disputes = locateDisputesIndependent(undefined, '不符合专利法第22条第3款')
    expect(disputes[0]).toMatchObject({ statute: 'A22.3', claims: [] })
  })

  it('supplements a structured action from the text and skips unknown grounds', () => {
    const disputes = locateDisputesIndependent(
      officeAction({ rejectionTypes: [42, 'unknown-ground', 'inventiveness'] }),
      '权利要求1不符合专利法第22条第3款和第22条第2款',
    )
    expect(disputes.map(dispute => dispute.statute)).toContain('A22.3')
    expect(disputes.map(dispute => dispute.statute)).toContain('A22.2')
    expect(disputes.find(dispute => dispute.statute === 'A22.2')?.claims).toEqual([1])
  })

  it('reads a structured action without rejection types', () => {
    const disputes = locateDisputesIndependent(officeAction({ affectedClaims: [1] }), '专利法第22条第2款')
    expect(disputes[0]).toMatchObject({ statute: 'A22.2', claims: [1] })
  })

  it('uses affected claims for a text-only statute', () => {
    const disputes = locateDisputesIndependent(
      { rejectionTypes: [], affectedClaims: [2] },
      '权利要求2不符合专利法第22条第3款',
    )
    expect(disputes[0]).toMatchObject({ statute: 'A22.3', claims: [2] })
  })
})

describe('report branches', () => {
  const disputes: AdversaryDispute[] = [
    {
      statute: 'A22.3', claims: [], point: '分歧点', relation: 'disagreement',
      confidence: 0.7, tag: 'heuristic',
    },
    {
      statute: 'A22.2', claims: [], point: '遗漏点', relation: 'missed_by_baseline',
      confidence: 0.8, tag: 'heuristic',
    },
    {
      statute: 'A33', claims: [], point: '一致点', relation: 'agreement',
      confidence: 0.9, tag: 'heuristic',
    },
    {
      statute: 'A26.4', claims: [], point: '未验证', relation: 'missed_by_baseline',
      confidence: 0.3, tag: 'unverified',
    },
  ]

  it('renders every section without a summary or divergence reason', () => {
    const text = renderAdversaryReport(buildAdversaryReport(disputes, ''))
    expect(text).toContain('分歧项')
    expect(text).toContain('（权项 未指定）')
    expect(text).toContain('基线未覆盖项')
    expect(text).toContain('一致项')
    expect(text).toContain('未验证项')
    expect(text).not.toContain('摘要：')
  })
})

describe('parse branches', () => {
  it('defaults non-string assessment fields and out-of-range confidence', () => {
    const parsed = parseAdversaryOutput(JSON.stringify({
      disputes: [{ statute: 'A22.3', point: 42, weakness: '', confidence: 2 }],
      overall_assessment: 42,
      divergence_reason: null,
    }))
    expect(parsed).not.toBeNull()
    expect(parsed?.overallAssessment).toBe('')
    expect(parsed?.divergenceReason).toBe('')
    expect(parsed?.disputes[0]).toMatchObject({ point: '', confidence: 0.5 })
    expect(parsed?.disputes[0]).not.toHaveProperty('divergenceReason')
  })
})

describe('prompt branches', () => {
  it('names an empty office action', () => {
    expect(buildAdversaryPrompt({}, '', undefined, undefined)).toContain('(审查意见结构化字段为空)')
  })
})

describe('review branches', () => {
  it('skips the evidence gap when the reference text has no keywords', () => {
    expect(detectEvidenceGaps('论证正文', '对比文件没有编号', {})).toEqual([])
  })

  it('reports claims coverage only when markers exist and are not cited', () => {
    expect(detectClaimsCoverage('最终产物', '权利要求书')).toEqual([])
    expect(detectClaimsCoverage('最终产物未提及编号', '权利要求1、权利要求2')).toHaveLength(1)
    expect(detectClaimsCoverage('最终产物引用权利要求1', '权利要求1')).toEqual([])
  })

  it('labels an unmapped missed rejection and keeps the affected claims', () => {
    const missed = detectMissedRejections('最终产物', { rejectionTypes: ['mystery-ground'] })
    expect(missed).toEqual(['mystery-ground'])
    const disputes = identifyReviewDisputes({ affectedClaims: [1] }, missed, [])
    expect(disputes[0]).toMatchObject({ statute: 'unknown', claims: [1], relation: 'missed_by_baseline' })
    expect(identifyReviewDisputes(undefined, missed, [])[0]?.claims).toEqual([])
  })

  it('computes zero confidence for zero-weight disputes', () => {
    expect(computeReviewConfidence([
      { statute: 'A22.3', claims: [], point: '', relation: 'disagreement', confidence: 0, tag: 'heuristic' },
    ], 'weak')).toBe(0)
  })

  it('applies every strength factor and summary label', () => {
    const dispute: AdversaryDispute = {
      statute: 'A22.3', claims: [1], point: '', relation: 'disagreement', confidence: 0.9, tag: 'heuristic',
    }
    expect(computeReviewConfidence([dispute], 'strong')).toBeCloseTo(0.9)
    expect(computeReviewConfidence([dispute], 'weak')).toBeCloseTo(0.63)
    expect(computeReviewConfidence([dispute], 'insufficient')).toBeCloseTo(0.36)
    expect(buildReviewSummary([], ['缺口'], 'weak', 0.5)).toContain('部分不足')
    expect(buildReviewSummary(['遗漏'], ['缺口'], 'insufficient', 0.5)).toContain('严重不足')
    expect(buildReviewSummary([], [], 'strong', 0.5)).toContain('充分')
  })

  it('reports a missed rejection through the full review', () => {
    const report = reviewFinalDraft({
      finalDraft: '最终意见陈述书',
      claims: '权利要求1',
      officeAction: { rejectionTypes: ['inventiveness'], affectedClaims: [1] },
    })
    expect(report.argumentStrength).toBe('insufficient')
    expect(report.missedRejections).toEqual(['inventiveness'])
  })
})

describe('adversary-model handler branches', () => {
  it('degrades on an invalid tunable', async () => {
    const result = await new AdversaryModelHandler().execute({ state: { temperature: 9 } })
    expect(String(result._error)).toContain('temperature')
  })

  it('merges same-statute disputes with equal confidence', async () => {
    const result = await new AdversaryModelHandler().execute({
      state: {
        office_action: JSON.stringify({
          rejectionTypes: ['novelty', 'novelty', 'inventiveness'], affectedClaims: [1, 2],
        }),
        response_plan: JSON.stringify([
          { ground: 'inventiveness', strategy: 'amend', claims: [3] },
        ]),
      },
    })
    expect(result.adversary_report).toBeDefined()
  })

  it('keeps the heuristic dispute when the model reports lower confidence', async () => {
    const provider: StageProvider = {
      callLLM: async () => JSON.stringify({
        disputes: [{ statute: 'A22.3', claims: [1], point: '低置信', confidence: 0.5 }],
        overall_assessment: '仍然需要关注创造性。',
      }),
    }
    const result = await new AdversaryModelHandler().execute({
      state: {
        office_action: JSON.stringify({ rejectionTypes: ['inventiveness'], affectedClaims: [1] }),
        claims: '权利要求1',
      },
      provider,
    })
    expect(result.adversary_report).toBeDefined()
  })

  it('falls back to a degraded summary when the model omits its assessment', async () => {
    const provider: StageProvider = {
      callLLM: async () => JSON.stringify({
        disputes: [{ statute: 'A22.3', claims: [1], point: '要点', confidence: 0.8 }],
        overall_assessment: '',
      }),
    }
    const result = await new AdversaryModelHandler().execute({
      state: {
        office_action: JSON.stringify({ rejectionTypes: ['inventiveness'], affectedClaims: [1] }),
        claims: '权利要求1',
      },
      provider,
    })
    expect(result.adversary_report).toContain('模型不可用')
  })
})
