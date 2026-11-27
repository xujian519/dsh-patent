import { describe, expect, it } from 'vitest'
import { figureFormFindings } from '../src/review/figure-findings.ts'
import type { FigureFormEvidence } from '../src/review/figure-findings.ts'
import { aggregateReviewFindings } from '../src/review/aggregate.ts'
import { buildReviewReport } from '../src/review/report.ts'

/** 单幅 grayscale 附图证据。 */
function figure(overrides: Partial<FigureFormEvidence> = {}): FigureFormEvidence {
  return {
    figureNumber: 1,
    office: 'cnipa',
    style: 'grayscale',
    hasCaption: true,
    ...overrides,
  }
}

describe('figureFormFindings: 法域合规', () => {
  it('PCT 彩色是 error，美国与中国是 warning', () => {
    const pct = figureFormFindings({ figures: [figure({ office: 'pct', style: 'semantic' })] })
    expect(pct).toHaveLength(1)
    expect(pct[0]).toMatchObject({
      source: 'figure_check',
      rule: 'figure-color-policy',
      severity: 'error',
      locator: { kind: 'figure', figure: 1 },
    })
    expect(pct[0]?.message).toContain('11.13(a)')

    const uspto = figureFormFindings({ figures: [figure({ office: 'uspto', style: 'semantic' })] })
    expect(uspto[0]).toMatchObject({ rule: 'figure-color-policy', severity: 'warning' })

    const cnipa = figureFormFindings({ figures: [figure({ style: 'semantic' })] })
    expect(cnipa[0]).toMatchObject({ rule: 'figure-color-policy', severity: 'warning' })
    expect(cnipa[0]?.message).toContain('4.3')
  })

  it('多幅未标图号报 warning，单幅不报', () => {
    const many = figureFormFindings({ figures: [figure({ hasCaption: false })], drawingCount: 3 })
    expect(many.some(entry => entry.rule === 'figure-caption-missing' && entry.severity === 'warning')).toBe(true)

    const single = figureFormFindings({ figures: [figure({ hasCaption: false })], drawingCount: 1 })
    expect(single.some(entry => entry.rule === 'figure-caption-missing')).toBe(false)
  })

  it('字高低于法域下限时报 warning 并带实测值', () => {
    const findings = figureFormFindings({
      figures: [figure({ office: 'uspto', charHeightMm: 3.0 })],
    })
    expect(findings[0]).toMatchObject({ rule: 'figure-char-height', severity: 'warning' })
    expect(findings[0]?.message).toContain('3 毫米')
    expect(findings[0]?.message).toContain('37 CFR 1.84(p)(3)')
  })

  it('摘要附图只报缩放后的量测值，标为未评估', () => {
    const findings = figureFormFindings({
      figures: [figure({
        abstractFigure: true,
        charHeightMm: 4,
        placedWidthMm: 80,
        placedHeightMm: 100,
      })],
    })
    expect(findings[0]).toMatchObject({
      rule: 'figure-abstract-figure-legibility',
      severity: 'info',
      not_assessed: true,
    })
    expect(findings[0]?.message).toContain('2 毫米')
  })
})

describe('figureFormFindings: 渲染与交付复核映射', () => {
  it('越出画布是 error，其余复核项是 warning', () => {
    const findings = figureFormFindings({
      figures: [figure({
        renderFindings: [
          { check: 'ink-outside-canvas', message: '内容越出画布' },
          { check: 'text-crossed-by-line', message: '标号被线条贯穿' },
          { check: 'hatch-orientation-collision', message: '相邻零件剖面线不可区分' },
        ],
      })],
    })
    expect(findings.map(entry => [entry.rule, entry.severity])).toEqual([
      ['figure-render-ink-outside-canvas', 'error'],
      ['figure-render-text-crossed', 'warning'],
      ['figure-render-hatch-collision', 'warning'],
    ])
    expect(findings.every(entry => entry.locator.kind === 'figure')).toBe(true)
  })

  it('未量测与欠填充标为未评估', () => {
    const findings = figureFormFindings({
      figures: [figure({
        renderFindings: [
          { check: 'not-measured', message: 'CSS 类样式不在量测范围' },
          { check: 'sheet-underfill', message: '内容只占画布 12%' },
        ],
      })],
    })
    expect(findings.every(entry => entry.not_assessed === true && entry.severity === 'info')).toBe(true)
  })

  it('未知复核项不丢弃，记为未评估', () => {
    const findings = figureFormFindings({
      figures: [figure({ renderFindings: [{ check: 'future-check', message: '新复核项' }] })],
    })
    expect(findings[0]).toMatchObject({
      rule: 'figure-unmapped-check',
      severity: 'info',
      not_assessed: true,
    })
    expect(findings[0]?.message).toContain('future-check')
  })

  it('交付复核项按类别映射', () => {
    const findings = figureFormFindings({
      figures: [figure({
        deliveryFindings: [
          { check: 'figure-photo', message: '图内含位图/照片' },
          { check: 'figure-wording', message: '图面含非必需注释' },
        ],
      })],
    })
    expect(findings.map(entry => entry.rule)).toEqual([
      'figure-delivery-photo',
      'figure-delivery-wording',
    ])
    expect(findings.every(entry => entry.severity === 'warning')).toBe(true)
  })

  it('证据少于声明幅数时声明其余未评审', () => {
    const findings = figureFormFindings({ figures: [figure()], drawingCount: 3 })
    const partial = findings.find(entry => entry.message.includes('仅提供 1 幅'))
    expect(partial).toMatchObject({ source: 'review', severity: 'info', not_assessed: true })
  })
})

describe('figureFormFindings: 汇入评审报告', () => {
  it('提供证据时以 figure 定位排序并可改变 passed', () => {
    const aggregated = aggregateReviewFindings({
      claims: '1. 一种检测装置，其特征在于，包括壳体。',
      hasDrawings: true,
      drawingCount: 2,
      figures: [
        figure({ figureNumber: 2, hasCaption: false }),
        figure({ figureNumber: 1, office: 'pct', style: 'semantic' }),
      ],
    })
    expect(aggregated.reviewed_scope.figures).toBe(true)
    const report = buildReviewReport(aggregated.findings, aggregated.reviewed_scope, aggregated.evaluated)
    expect(report.passed).toBe(false)
    const figureFindings = report.findings.filter(entry => entry.source === 'figure_check')
    expect(figureFindings[0]?.locator).toEqual({ kind: 'figure', figure: 1 })
    expect(figureFindings[1]?.locator).toEqual({ kind: 'figure', figure: 2 })
  })

  it('声明有附图但不给证据时只声明未评审', () => {
    const aggregated = aggregateReviewFindings({
      claims: '1. 一种检测装置，其特征在于，包括壳体。',
      hasDrawings: true,
    })
    expect(aggregated.reviewed_scope.figures).toBe(false)
    expect(aggregated.findings.some(entry => entry.message.includes('附图形式未评审'))).toBe(true)
  })

  it('不声明有附图时不产生附图未评审项', () => {
    const aggregated = aggregateReviewFindings({
      claims: '1. 一种检测装置，其特征在于，包括壳体。',
    })
    expect(aggregated.reviewed_scope.figures).toBe(false)
    expect(aggregated.findings.some(entry => entry.source === 'figure_check')).toBe(false)
  })
})
