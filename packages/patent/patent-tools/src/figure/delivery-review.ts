/**
 * Delivery review for a finished drawing: findings that only make sense on the
 * artefact about to be filed, not on the drawing's input description.
 *
 * The checks are deterministic and read the SVG source. They cover four items
 * the input-side checks do not see: raster/photo content (`<image>`), a frame
 * drawn around the whole sheet, landscape orientation, and non-essential words
 * already measured by {@link figureWordingWarnings}.
 *
 * Legal basis: 《专利审查指南》第一部分第一章 4.3 (drawings are vertical,
 * photographs only in special cases, no annotations beyond necessary words).
 * @module @deepseek-ai/dsh-patent-tools/figure/delivery-review
 */

import { polyBounds } from './render-check-findings.ts'
import { scanSvg } from './render-check-scan.ts'
import { figureWordingWarnings } from './wording-rules.ts'

/** One delivery finding; `check` is a stable identifier. */
type DeliveryFinding = {
  /** Stable identifier, e.g. `figure-photo`. */
  check: string
  /** Model-facing one-sentence conclusion. */
  message: string
}

/** A closed shape covering at least this share of both canvas axes is a sheet frame. */
const FULL_SHEET_RATIO = 0.9

/** Landscape tolerance: a square or nearly square drawing is not landscape. */
const LANDSCAPE_RATIO = 1.05

/**
 * Review a finished SVG drawing at the delivery gate.
 * @param svg - complete SVG text (already validated by the caller's render check).
 * @returns findings in report order; empty when none of the four checks hits.
 */
export function checkFigureDelivery(svg: string): DeliveryFinding[] {
  const findings: DeliveryFinding[] = []
  const scan = scanSvg(svg)

  if (/<image\b/i.test(svg)) {
    findings.push({
      check: 'figure-photo',
      message: '图面含位图或照片（<image>）：《专利审查指南》第一部分第一章 4.3 只在特殊情况下允许照片，请确认属于允许情形，否则改用线条图',
    })
  }

  const { widthMm, heightMm } = scan
  if (widthMm !== undefined && heightMm !== undefined && widthMm > heightMm * LANDSCAPE_RATIO) {
    findings.push({
      check: 'figure-orientation',
      message: `图为横向（${String(Math.round(widthMm * 10) / 10)}×${String(Math.round(heightMm * 10) / 10)} 毫米）：指南第一部分第一章 4.3 要求附图竖向绘制，请旋转为纵向`,
    })
  }

  if (widthMm !== undefined && heightMm !== undefined) {
    const frame = scan.shapes
      .flatMap(shape => shape.subpaths.filter(subPath => subPath.closed))
      .map(subPath => polyBounds(subPath.points))
      .find(bounds =>
        bounds.maxX - bounds.minX >= widthMm * FULL_SHEET_RATIO
        && bounds.maxY - bounds.minY >= heightMm * FULL_SHEET_RATIO,
      )
    if (frame !== undefined) {
      findings.push({
        check: 'figure-frame',
        message: '图面画有覆盖整幅图纸的边框：附图不应加整幅框线，请删除外框，保留视图自身的轮廓',
      })
    }
  }

  const labels = scan.texts.map(text => text.content)
  const numerals = labels.filter(label => /^\d{1,4}$/.test(label.trim()))
  for (const warning of figureWordingWarnings(labels, numerals)) {
    findings.push({ check: 'figure-wording', message: warning })
  }

  return findings
}
