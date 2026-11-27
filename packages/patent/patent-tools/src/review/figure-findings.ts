/**
 * 附图形式证据到统一 findings 的映射。
 *
 * 评审层不读 SVG、不跑 FreeCAD/Inkscape：它消费生成与复核工具已经产出的证据
 * （`generate_patent_figure` 的 `layout`、`verify_patent_figure` 与交付复核的
 * `findings`），把同一套合规判据投影成带图号定位的 `ReviewFinding`。判据本身
 * 仍在 `figure/compliance`；本模块只做严重度与 rule 名的映射。
 *
 * 未知的复核项不丢弃：按 `figure-unmapped-check` 记为未评估，避免新复核项在
 * 评审报告里静默消失。
 * @module @deepseek-ai/dsh-patent-tools/review/figure-findings
 */

import { drawingComplianceChecks } from '../figure/compliance.ts'
import { officeProfile } from '../figure/office-profile.ts'
import type { TargetOffice } from '../figure/office-profile.ts'
import type { ReviewFinding } from './types.ts'

/** 生成/复核工具产出的一条图面检查（`check` 与 `message` 原样透传）。 */
export type FigureCheckEvidence = {
  /** 检查类别标识（`RenderCheckKind` 或交付复核的 `check`）。 */
  check: string
  /** 面向模型的问题说明。 */
  message: string
}

/** 单幅附图的形式证据。 */
export type FigureFormEvidence = {
  /** 图号（1 起）。 */
  figureNumber: number
  /** 目标法域。 */
  office: TargetOffice
  /** 本次生成使用的色彩策略。 */
  style: 'grayscale' | 'semantic'
  /** 落版页上是否已标注图号。 */
  hasCaption: boolean
  /** 本幅是否为请求书指定的摘要附图。 */
  abstractFigure?: boolean
  /** 落版后正文数字与字母的字高（毫米）。 */
  charHeightMm?: number
  /** 落版后图形占用的宽（毫米）。 */
  placedWidthMm?: number
  /** 落版后图形占用的高（毫米）。 */
  placedHeightMm?: number
  /** `verify_patent_figure` 的 findings。 */
  renderFindings?: readonly FigureCheckEvidence[]
  /** 交付复核（`delivery_review=true`）的 findings。 */
  deliveryFindings?: readonly FigureCheckEvidence[]
}

/** 映射输入。 */
export type FigureFormFindingsInput = {
  /** 各幅附图的形式证据。 */
  figures: readonly FigureFormEvidence[]
  /** 请求/说明书声明的附图总数；缺省取证据条数。 */
  drawingCount?: number
}

/** 一条复核类别的映射：严重度与 rule。 */
type CheckRule = {
  /** 报告严重度。 */
  severity: ReviewFinding['severity']
  /** 稳定 rule 名。 */
  rule: string
  /** 该类别本身只给出量测值；true 时记为未评估。 */
  notAssessed?: boolean
}

/** 渲染复核类别的映射：严重度与 rule。 */
const RENDER_CHECK_RULES: Readonly<Record<string, CheckRule>> = {
  'text-crossed-by-line': { severity: 'warning', rule: 'figure-render-text-crossed' },
  'text-clearance': { severity: 'warning', rule: 'figure-render-text-clearance' },
  'centerline-covered': { severity: 'warning', rule: 'figure-render-centerline-covered' },
  'hatch-orientation-collision': { severity: 'warning', rule: 'figure-render-hatch-collision' },
  'element-overlap': { severity: 'warning', rule: 'figure-render-element-overlap' },
  'figure-hierarchy': { severity: 'warning', rule: 'figure-render-hierarchy' },
  'ink-outside-canvas': { severity: 'error', rule: 'figure-render-ink-outside-canvas' },
  'font-below-minimum': { severity: 'warning', rule: 'figure-render-font-below-minimum' },
  'sheet-underfill': { severity: 'info', rule: 'figure-render-sheet-underfill', notAssessed: true },
  'not-measured': { severity: 'info', rule: 'figure-render-not-measured', notAssessed: true },
}

/** 交付复核类别的映射：严重度与 rule。 */
const DELIVERY_CHECK_RULES: Readonly<Record<string, CheckRule>> = {
  'figure-photo': { severity: 'warning', rule: 'figure-delivery-photo' },
  'figure-orientation': { severity: 'warning', rule: 'figure-delivery-orientation' },
  'figure-frame': { severity: 'warning', rule: 'figure-delivery-frame' },
  'figure-wording': { severity: 'warning', rule: 'figure-delivery-wording' },
}

/**
 * 把一条复核证据映射为 finding。
 * @param figureNumber - 图号（1 起）。
 * @param evidence - 复核工具给出的检查项。
 * @param rules - 该来源的类别表。
 * @returns 统一 finding；未知类别映射为未评估项。
 */
function checkFinding(
  figureNumber: number,
  evidence: FigureCheckEvidence,
  rules: Readonly<Record<string, CheckRule>>,
): ReviewFinding {
  const mapped = rules[evidence.check]
  if (mapped === undefined) {
    return {
      source: 'figure_check',
      rule: 'figure-unmapped-check',
      severity: 'info',
      not_assessed: true,
      message: `复核项「${evidence.check}」尚无评审映射：${evidence.message}`,
      locator: { kind: 'figure', figure: figureNumber },
    }
  }
  return {
    source: 'figure_check',
    rule: mapped.rule,
    severity: mapped.severity,
    ...(mapped.notAssessed === true ? { not_assessed: true } : {}),
    message: evidence.message,
    locator: { kind: 'figure', figure: figureNumber },
  }
}

/**
 * 把各幅附图的形式证据映射为统一 findings。
 *
 * 合规判据复用 `figure/compliance`：色彩策略、图号缺失、字高低于法域下限与
 * 摘要附图缩放可辨性。渲染与交付复核的 findings 原样透传，只换 rule 与严重度。
 * @param input - 各幅证据与声明的附图总数。
 * @returns 统一 findings；证据完整且全部满足时为空数组。
 */
export function figureFormFindings(input: FigureFormFindingsInput): ReviewFinding[] {
  const figureCount = Math.max(input.drawingCount ?? 0, input.figures.length)
  const findings: ReviewFinding[] = []

  for (const figure of input.figures) {
    const profile = officeProfile(figure.office)
    for (const check of drawingComplianceChecks({
      profile,
      style: figure.style,
      figureCount,
      hasCaption: figure.hasCaption,
      ...(figure.abstractFigure === undefined ? {} : { abstractFigure: figure.abstractFigure }),
      metrics: {
        pageScale: 1,
        drawingWidthMm: figure.placedWidthMm ?? 0,
        drawingHeightMm: figure.placedHeightMm ?? 0,
        placedWidthMm: figure.placedWidthMm ?? 0,
        placedHeightMm: figure.placedHeightMm ?? 0,
        ...(figure.charHeightMm === undefined ? {} : { charHeightMm: figure.charHeightMm }),
      },
    })) {
      findings.push({
        source: 'figure_check',
        rule: `figure-${check.id}`,
        severity: check.severity,
        ...(check.notAssessed === true ? { not_assessed: true } : {}),
        message: check.message,
        locator: { kind: 'figure', figure: figure.figureNumber },
      })
    }

    for (const evidence of figure.renderFindings ?? []) {
      findings.push(checkFinding(figure.figureNumber, evidence, RENDER_CHECK_RULES))
    }
    for (const evidence of figure.deliveryFindings ?? []) {
      findings.push(checkFinding(figure.figureNumber, evidence, DELIVERY_CHECK_RULES))
    }
  }

  if (figureCount > input.figures.length) {
    findings.push({
      source: 'review',
      rule: 'review_scope',
      severity: 'info',
      not_assessed: true,
      message: `本案附图共 ${figureCount} 幅，仅提供 ${input.figures.length} 幅的形式证据：其余附图的形式未评审`,
      locator: { kind: 'document' },
    })
  }

  return findings
}
