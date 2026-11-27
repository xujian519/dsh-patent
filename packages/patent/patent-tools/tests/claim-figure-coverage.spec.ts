import { describe, expect, it } from 'vitest'
import { checkClaimFigureCoverage } from '../src/figure/claim-figure-coverage.ts'
import type { ClaimFeatureBinding, FigureMarkEntry } from '../src/figure/claim-figure-coverage.ts'

const figures: FigureMarkEntry[] = [
  { figureNumber: 1, components: [{ refNumber: '10', name: '壳体' }, { refNumber: '20', name: '盖板' }] },
  { figureNumber: 2, components: [{ refNumber: '10', name: '壳体' }] },
]

describe('checkClaimFigureCoverage', () => {
  it('全部特征都指向图面存在的标号时通过', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_1', feature: '壳体', refNumbers: ['10'] },
      { claimId: 'claim_1', feature: '盖板', refNumbers: ['20'] },
    ], figures)

    expect(report.covered).toBe(true)
    expect(report.boundFeatureCount).toBe(2)
    expect(report.unboundFeatureCount).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.summary).toContain('权项要素图面覆盖检查通过')
  })

  it('特征文本为空时报告 feature-empty 且不进入标号判定', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_1', feature: '   ', refNumbers: ['10'] },
    ], figures)

    expect(report.covered).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({ check: 'feature-empty', claimId: 'claim_1', feature: '' }),
    ])
    expect(report.summary).toContain('特征文本为空 1 条')
  })

  it('未指定任何标号时报告 feature-unbound', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_2', feature: '弹簧', refNumbers: [] },
    ], figures)

    expect(report.covered).toBe(false)
    expect(report.findings[0]).toMatchObject({ check: 'feature-unbound', feature: '弹簧' })
    expect(report.summary).toContain('未指定附图标记 1 条')
  })

  it('标号列表全是空白串时同样视为未指定', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_2', feature: '弹簧', refNumbers: ['  ', '\t'] },
    ], figures)

    expect(report.findings[0]).toMatchObject({ check: 'feature-unbound' })
  })

  it('标号不在任何图中时逐条报告 ref-not-on-figure', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_3', feature: '底座', refNumbers: ['99'] },
    ], figures)

    expect(report.covered).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({ check: 'ref-not-on-figure', ref: '99' }),
    ])
    expect(report.summary).toContain('指向的标号不在图面 1 处')
  })

  it('一个特征的多个标号部分缺失时只报缺失的那些', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_3', feature: '装配体', refNumbers: ['10', '99', '20'] },
    ], figures)

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ check: 'ref-not-on-figure', ref: '99' })
    expect(report.boundFeatureCount).toBe(0)
  })

  it('图面为空时所有标号都判为不在图中', () => {
    const report = checkClaimFigureCoverage([
      { claimId: 'claim_1', feature: '壳体', refNumbers: ['10'] },
    ], [])

    expect(report.findings[0]).toMatchObject({ check: 'ref-not-on-figure', ref: '10' })
  })

  it('图面组件标号为空串时不进已知标号集合', () => {
    const report = checkClaimFigureCoverage(
      [{ claimId: 'claim_1', feature: '壳体', refNumbers: [''] }],
      [{ figureNumber: 1, components: [{ refNumber: '  ', name: '空标号' }] }],
    )

    // 空标号在 binding 侧先被过滤，落成「未指定」而不是「不在图面」
    expect(report.findings[0]).toMatchObject({ check: 'feature-unbound' })
  })

  it('U1 这类非数字占位标号按原样核对', () => {
    const report = checkClaimFigureCoverage(
      [{ claimId: 'claim_1', feature: '未编号部件', refNumbers: ['U1'] }],
      [{ figureNumber: 1, components: [{ refNumber: 'U1', name: '阀体' }] }],
    )

    expect(report.covered).toBe(true)
  })

  it('绑定为空时报告覆盖通过且特征数为零', () => {
    const report = checkClaimFigureCoverage([], figures)

    expect(report.covered).toBe(true)
    expect(report.boundFeatureCount).toBe(0)
    expect(report.unboundFeatureCount).toBe(0)
    expect(report.summary).toBe('共 0 条权利要求技术特征。权项要素图面覆盖检查通过。')
  })

  it('多条发现时摘要逐类计数', () => {
    const bindings: ClaimFeatureBinding[] = [
      { claimId: 'claim_1', feature: '', refNumbers: ['10'] },
      { claimId: 'claim_2', feature: '弹簧', refNumbers: [] },
      { claimId: 'claim_3', feature: '底座', refNumbers: ['99'] },
      { claimId: 'claim_4', feature: '壳体', refNumbers: ['10'] },
    ]
    const report = checkClaimFigureCoverage(bindings, figures)

    expect(report.boundFeatureCount).toBe(1)
    expect(report.unboundFeatureCount).toBe(3)
    expect(report.summary).toContain('特征文本为空 1 条')
    expect(report.summary).toContain('未指定附图标记 1 条')
    expect(report.summary).toContain('指向的标号不在图面 1 处')
  })
})
