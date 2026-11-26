import { describe, expect, it } from 'vitest'
import {
  aggregateReviewFindings,
  reviewFindingFromClaimLint,
  reviewFindingFromSpecViolation,
} from '../src/review/aggregate.ts'
import { buildReviewReport, compareReviewFindings } from '../src/review/report.ts'
import type { ReviewFinding } from '../src/review/types.ts'

/** 五部分齐备、与权要共用“壳体/盖体/铰链”的说明书。 */
const SPEC = [
  '## 技术领域',
  '本发明涉及一种检测装置。',
  '## 背景技术',
  '现有检测装置存在精度不足的问题。',
  '## 发明内容',
  '本发明提供一种检测装置，包括壳体、盖体和铰链。',
  '## 附图说明',
  '图1是本发明实施例的结构示意图。',
  '## 具体实施方式',
  '实施例1：如图1所示，本实施例提供一种检测装置，包括壳体、盖体和铰链。',
].join('\n')

const PRODUCT_CLAIMS = '1. 一种检测装置，其特征在于，包括壳体、盖体和铰链。'

/** 含 7 个“所述”特征，其中 4 个不在 SPEC 中，触发 claim_coverage。 */
const MISSING_CLAIMS =
  '1. 一种检测装置，其特征在于，包括所述壳体、所述盖体、所述铰链、所述传感器、所述控制器、所述电源和所述显示屏。'

const TWO_CLAIMS = [
  PRODUCT_CLAIMS,
  '2. 根据权利要求1所述的检测装置，其特征在于，所述壳体为矩形。',
].join('\n')

const METHOD_CLAIMS = '1. 一种检测装置的制造方法，其特征在于，包括步骤：下料、折弯。'

const ABSTRACT = '本发明公开一种检测装置，包括壳体、盖体和铰链。'

/** 构造一条用于比较器/报告测试的 finding。 */
function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    source: 'claim_lint',
    rule: 'numbering',
    severity: 'error',
    message: 'm',
    locator: { kind: 'claim', claim: 1 },
    ...overrides,
  }
}

describe('aggregateReviewFindings: 输入分支', () => {
  it('两者都给时合并两引擎，且 claim coverage 只出现一次', () => {
    const result = aggregateReviewFindings({
      claims: MISSING_CLAIMS,
      specification: SPEC,
      abstract: ABSTRACT,
      title: '一种检测装置',
      patentType: 'invention',
      hasDrawings: true,
      techDomain: 'mechanical',
      drawingCount: 1,
      abstractFigureNumber: 1,
      figureAnalysis: [],
      maxClaims: 10,
    })
    expect(result.reviewed_scope).toEqual({ claims: true, specification: true })
    expect(result.evaluated.map(entry => entry.field).sort()).toEqual(
      ['abstract', 'claims', 'specification', 'title'].sort(),
    )
    expect(result.evaluated.every(entry => entry.digest.startsWith('sha256:'))).toBe(true)
    expect(result.findings.some(entry => entry.source === 'claim_lint')).toBe(true)
    expect(result.findings.some(entry => entry.source === 'spec_check')).toBe(true)
    expect(result.findings.filter(entry => entry.rule === 'claim_coverage')).toHaveLength(1)
    expect(result.findings.some(
      entry => entry.not_assessed === true && entry.rule === 'title-name-place',
    )).toBe(true)
  })

  it('只给权项时走 claim_check，不伪造缺少章节', () => {
    const result = aggregateReviewFindings({ claims: METHOD_CLAIMS, patentType: 'utility_model' })
    expect(result.reviewed_scope).toEqual({ claims: true, specification: false })
    expect(result.findings.some(
      entry => entry.source === 'claim_check' && entry.rule === 'utility_model_method_claim',
    )).toBe(true)
    expect(result.findings.some(entry => entry.message.includes('说明书未提供'))).toBe(true)
    expect(result.findings.every(entry => entry.rule !== 'sections')).toBe(true)
  })

  it('只给说明书时不产生 claim_lint 记录，并声明权项未评审', () => {
    const result = aggregateReviewFindings({ specification: SPEC, title: '一种检测装置' })
    expect(result.reviewed_scope).toEqual({ claims: false, specification: true })
    expect(result.findings.every(entry => entry.source !== 'claim_lint')).toBe(true)
    expect(result.findings.some(entry => entry.message.includes('权利要求未提供'))).toBe(true)
    expect(result.findings.some(
      entry => entry.not_assessed === true && entry.rule === 'title-name-place',
    )).toBe(true)
  })

  it('两者都缺失时返回两条范围说明，而不是空报告', () => {
    const result = aggregateReviewFindings({})
    expect(result.reviewed_scope).toEqual({ claims: false, specification: false })
    expect(result.evaluated).toEqual([])
    expect(result.findings).toHaveLength(2)
    expect(result.findings.every(entry => entry.source === 'review' && entry.not_assessed === true)).toBe(true)
  })

  it('空白文本按缺失处理', () => {
    const result = aggregateReviewFindings({ claims: '   ', specification: '' })
    expect(result.reviewed_scope).toEqual({ claims: false, specification: false })
    expect(result.evaluated).toEqual([])
  })

  it('maxClaims 透传到 claim_lint', () => {
    const result = aggregateReviewFindings({ claims: TWO_CLAIMS, maxClaims: 1 })
    expect(result.findings.some(
      entry => entry.source === 'claim_lint' && entry.rule === 'claim-count',
    )).toBe(true)
  })
})

describe('finding 映射', () => {
  it('claim_lint 的权项号与全文定位各映射一种 locator', () => {
    const claim = reviewFindingFromClaimLint({
      rule: 'numbering',
      claim: 3,
      severity: 'error',
      message: 'm',
      evidence: 'e',
      basis: 'b',
    })
    expect(claim.locator).toEqual({ kind: 'claim', claim: 3 })
    expect(claim.evidence).toBe('e')
    expect(claim.basis).toBe('b')

    const whole = reviewFindingFromClaimLint({
      rule: 'non-claim-content',
      claim: null,
      severity: 'warning',
      message: 'm',
      evidence: 'e',
      basis: 'b',
    })
    expect(whole.locator).toEqual({ kind: 'document' })
  })

  it('spec 的法定章节映射为 section，非章节值落到全篇', () => {
    const section = reviewFindingFromSpecViolation({
      rule: 'clarity',
      family: 'description',
      severity: 'warning',
      section: '背景技术',
      message: 'm',
      suggestion: 's',
      matchedSentence: 'e',
      line: 7,
    }, 'spec_check')
    expect(section.locator).toEqual({ kind: 'section', section: '背景技术' })
    expect(section.suggestion).toBe('s')
    expect(section.evidence).toBe('e')
    expect(section.line).toBe(7)

    const claimsSection = reviewFindingFromSpecViolation({
      rule: 'claim_unity',
      family: 'claims',
      severity: 'error',
      section: '权利要求书',
      message: 'm',
    }, 'claim_check')
    expect(claimsSection.locator).toEqual({ kind: 'document' })
    expect('suggestion' in claimsSection).toBe(false)
    expect('evidence' in claimsSection).toBe(false)
    expect('line' in claimsSection).toBe(false)
  })

  it('无 section 的 spec 违规也落到全篇', () => {
    const mapped = reviewFindingFromSpecViolation({
      rule: 'sections',
      family: 'structure',
      severity: 'error',
      message: 'm',
    }, 'spec_check')
    expect(mapped.locator).toEqual({ kind: 'document' })
  })
})

describe('buildReviewReport: 排序与判定', () => {
  it('按总序编号并只把 error 计入不通过', () => {
    const report = buildReviewReport([
      finding({ severity: 'warning', rule: 'warning-rule' }),
      finding({ severity: 'info', rule: 'unassessed', not_assessed: true, locator: { kind: 'document' } }),
      finding({ severity: 'info', rule: 'info-only' }),
      finding({ severity: 'error', rule: 'error-rule' }),
    ], { claims: true, specification: false }, [])
    expect(report.findings.map(entry => entry.id)).toEqual(['F1', 'F2', 'F3', 'F4'])
    expect(report.findings[0]?.rule).toBe('error-rule')
    expect(report.counts).toEqual({ error: 1, warning: 1, not_assessed: 2 })
    expect(report.passed).toBe(false)
    expect(report.reviewed_scope).toEqual({ claims: true, specification: false })
  })

  it('只有 warning 时通过', () => {
    const report = buildReviewReport([finding({ severity: 'warning' })], { claims: true, specification: false }, [])
    expect(report.passed).toBe(true)
    expect(report.counts).toEqual({ error: 0, warning: 1, not_assessed: 0 })
  })

  it('同一规则与定位的两条 finding 获得不同编号', () => {
    const report = buildReviewReport(
      [finding({ rule: 'same' }), finding({ rule: 'same' })],
      { claims: true, specification: false },
      [],
    )
    expect(report.findings.map(entry => entry.id)).toEqual(['F1', 'F2'])
  })

  it('未评审任何输入时不通过', () => {
    const report = buildReviewReport([], { claims: false, specification: false }, [])
    expect(report.passed).toBe(false)
    expect(report.findings).toEqual([])
  })

  it('比较器是全序，且每一级 tie-breaker 都生效', () => {
    const pairs: Array<[ReviewFinding, ReviewFinding]> = [
      [finding({ severity: 'error' }), finding({ severity: 'warning' })],
      [finding({ source: 'claim_lint' }), finding({ source: 'spec_check' })],
      [finding({ locator: { kind: 'claim', claim: 1 } }), finding({ locator: { kind: 'section', section: 'A' } })],
      [finding({ locator: { kind: 'claim', claim: 1 } }), finding({ locator: { kind: 'claim', claim: 2 } })],
      [finding({ locator: { kind: 'section', section: 'A' } }), finding({ locator: { kind: 'section', section: 'B' } })],
      [finding({ rule: 'a' }), finding({ rule: 'b' })],
      [finding({ message: 'a' }), finding({ message: 'b' })],
      [finding(), finding({ line: 1 })],
    ]
    for (const [left, right] of pairs) expect(compareReviewFindings(left, right)).toBeLessThan(0)
    expect(compareReviewFindings(finding(), finding())).toBe(0)
  })
})
