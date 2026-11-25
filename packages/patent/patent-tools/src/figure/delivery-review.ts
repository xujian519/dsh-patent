/**
 * Delivery review for a finished drawing: findings that only make sense on the
 * artefact about to be filed, not on the drawing's input description.
 *
 * A sheet caption (`data-dsh-role="caption"`) leaves the wording check only when its
 * baseline sits strictly below the ink of everything that is not a caption or a sheet
 * number. A sheet number (`data-dsh-role="sheet-number"`) always leaves that check.
 * The role is read from the `<text>` element itself. `figureWordingWarnings` stays a
 * string check so input labels without coordinates are not exempted. The role is
 * declared in the SVG, so an SVG handed to `verify_patent_figure` can declare it too;
 * the finding is advisory, so this is not a trust boundary.
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
import { quadCorners, scanSvg, textQuad } from './render-check-scan.ts'
import type { Point, Scan, ScannedText } from './render-check-scan.ts'
import { figureWordingWarnings } from './wording-rules.ts'

/** 落版页图号。只有基线在图形墨迹底边之下时才移出用语检查。 */
const CAPTION_ROLE = 'caption'

/** 落版页页码。整段移出用语检查，不要求它写成「图N」。 */
const SHEET_NUMBER_ROLE = 'sheet-number'

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

  const labels = wordingTexts(scan).map(text => text.content)
  const numerals = labels.filter(label => /^\d{1,4}$/.test(label.trim()))
  for (const warning of figureWordingWarnings(labels, numerals)) {
    findings.push({ check: 'figure-wording', message: warning })
  }

  return findings
}

/**
 * 参与图面用语检查的文字。
 *
 * 页码整段退出。图号仅在 `data-dsh-role="caption"` 且基线严格低于不含图号和页码的墨迹底边时退出。
 * 没有可量测墨迹时不豁免图号：没有参照底边就不能声称它在图形正下方。
 * 角色只认该 `<text>` 自身，比较不加容差；角色由 SVG 声明，外部 SVG 同样可以自报，该检查只是提示级发现。
 * @param scan - 已遍历的 SVG。
 * @returns 仍要送进用词规则的文字。
 */
function wordingTexts(scan: Scan): ScannedText[] {
  const inkBottom = inkBottomExcludingChrome(scan)
  return scan.texts.filter((text) => {
    if (text.role === SHEET_NUMBER_ROLE) return false
    return !(text.role === CAPTION_ROLE && inkBottom !== undefined && text.baseline[1] > inkBottom)
  })
}

/**
 * 不含落版图号和页码的墨迹底边（根坐标最大 y）。
 * @param scan - 已遍历的 SVG。
 * @returns 底边；没有顶点也没有其余文字时 undefined。
 */
function inkBottomExcludingChrome(scan: Scan): number | undefined {
  const points: Point[] = [
    ...scan.shapes.flatMap(shape => shape.subpaths.flatMap(subpath => subpath.points)),
    ...scan.texts
      .filter(text => text.role !== CAPTION_ROLE && text.role !== SHEET_NUMBER_ROLE)
      .flatMap(text => [...quadCorners(textQuad(text))]),
  ]
  return points.length === 0 ? undefined : polyBounds(points).maxY
}
