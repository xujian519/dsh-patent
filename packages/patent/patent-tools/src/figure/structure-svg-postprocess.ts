/**
 * 结构线稿的线宽与线型后处理：按调用参数改写 FreeCAD TechDraw 投影片段里的线宽分组，
 * 并可为隐藏线加虚线线型（`stroke-dasharray`）。
 *
 * 为什么要后处理：`TechDraw::DrawViewPart` 没有线宽/线型属性（本机实测 PropertiesList
 * 里含 line/width/style 的只有 `CenterLines`），`viewPartAsSvg` 固定按 FreeCAD 的
 * `LineGroup.csv` 出图——默认取 FC 0.70mm 档，可见线（thick）0.70 毫米、隐藏线（thin）
 * 0.35 毫米，且不输出 `stroke-dasharray`。片段的几何分组形如
 * `<g fill="none" stroke="#000000" stroke-width="0.7" …>`，故线宽只能改分组属性。
 *
 * 分组识别不依赖具体线宽数值：**线宽最大的一组是可见线，更细的组是隐藏线**。这与
 * `LineGroup.csv` 的分工一致（thick 为可见线、thin 为隐藏线），且 FreeCAD 换档
 * （0.35/1.00/…）后仍然成立。达不到这个前提时只报警告、不改写，不静默交出一张没生效的图。
 * @module @deepseek-ai/dsh-patent-tools/figure/structure-svg-postprocess
 */

import { formatMm as fmt } from './mm-primitives.ts'
import { assertSafeSvg, DEFAULT_SVG_MAX_BYTES } from './svg-annotate.ts'
import { measureInkBounds } from './render-check.ts'

/**
 * GB/T 4457.4 线宽系列（毫米），与 FreeCAD `LineGroup.csv` 的档位一致：
 * 粗线档为 0.25/0.35/0.50/0.70/1.00/1.40/2.00，细线为其一半。
 */
export const STRUCTURE_LINE_WIDTH_SERIES = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4, 2] as const

/** 隐藏线线型。 */
export type StructureHiddenLineStyle = 'solid' | 'dashed'

/** 结构线稿线宽/线型参数（已由调用方校验，缺省表示不改写）。 */
type StructureLineStyleInput = {
  /** 可见线线宽（毫米）；缺省保持 FreeCAD 输出的档位。 */
  lineWidthMm?: number
  /** 隐藏线线型；缺省 `solid` 保持 FreeCAD 输出的实线。 */
  hiddenLineStyle?: StructureHiddenLineStyle
}

/** 后处理结果。 */
type StructureLineStyleResult = {
  /** 改写后的 SVG；无可改分组时原样返回。 */
  svg: string
  /** 提示（未找到分组、线宽层级倒置等）。 */
  warnings: string[]
}

/**
 * 虚线画长与间隔相对线宽的倍数（毫米）。
 *
 * 线型随线宽等比缩放，细线与粗线的虚线节奏才一致。12/3 是本仓取值，可按校样调整：
 * FreeCAD 的 `LineGroup.csv` 只定义线宽档与各类线的用途，不给虚线的画长比例。
 */
const DASH_LENGTH_FACTOR = 12
const DASH_GAP_FACTOR = 3

/** 速度与浮点比较容差（毫米）。 */
const WIDTH_EPSILON = 1e-9

/** 几何分组的开标签（带 `stroke-width` 的 `<g>`）。 */
const GROUP_WITH_STROKE_WIDTH = /<g\b[^>]*\bstroke-width\s*=\s*"([^"]*)"[^>]*>/g

/** 改写一个开标签里的 `stroke-width`（其余属性顺序与写法原样保留）。 */
function withStrokeWidth(tag: string, widthMm: number, dash?: string): string {
  let rewritten = tag.replace(/\bstroke-width\s*=\s*"[^"]*"/, `stroke-width="${fmt(widthMm)}"`)
  if (dash !== undefined) rewritten = rewritten.replace(/>$/, ` stroke-dasharray="${dash}">`)
  return rewritten
}

/**
 * 改写结构线稿的线宽与隐藏线线型。
 *
 * 只改 `<g>` 开标签的 `stroke-width`（可选加 `stroke-dasharray`），子路径的坐标、
 * 件号引线与数字文本一字不动；改完再过一次 {@link assertSafeSvg}，并比对墨迹包围盒
 * 确认几何未走样（线宽与线型不改变顶点，前后必须逐值相同）。
 * @param svg - 单个视图的 SVG 文本。
 * @param style - 线宽与线型参数。
 * @returns 改写后的 SVG 与提示。
 * @throws SvgAnnotateError 输入或产物未通过 {@link assertSafeSvg} 时。
 */
export function applyStructureLineStyle(svg: string, style: StructureLineStyleInput): StructureLineStyleResult {
  assertSafeSvg(svg, DEFAULT_SVG_MAX_BYTES)
  const warnings: string[] = []
  if (style.lineWidthMm === undefined && (style.hiddenLineStyle ?? 'solid') === 'solid') {
    return { svg, warnings }
  }
  const widths = [...svg.matchAll(GROUP_WITH_STROKE_WIDTH)]
    .map(match => ({ tag: match[0], value: Number(match[1]) }))
  const numeric = widths.filter(group => Number.isFinite(group.value))
  if (numeric.length === 0) {
    warnings.push('未找到带可用 stroke-width 的几何分组，线宽/线型参数未生效（FreeCAD 的视图片段结构可能已变）')
    return { svg, warnings }
  }
  if (numeric.length !== widths.length) {
    warnings.push(`有 ${String(widths.length - numeric.length)} 个分组的 stroke-width 不是数，已跳过`)
  }
  const maxWidth = Math.max(...numeric.map(group => group.value))
  const invisible = numeric.filter(group => group.value < maxWidth - WIDTH_EPSILON)
  const wantsDash = (style.hiddenLineStyle ?? 'solid') === 'dashed'
  if (wantsDash && invisible.length === 0) {
    warnings.push('未发现比可见线更细的线组（show_hidden 未开启，或该视图没有隐藏线），隐藏线线型未生效')
  }
  const targetWidth = style.lineWidthMm
  if (targetWidth !== undefined && invisible.some(group => targetWidth <= group.value + WIDTH_EPSILON)) {
    warnings.push(`可见线宽 ${fmt(targetWidth)} 毫米不大于隐藏线宽 ${fmt(Math.max(...invisible.map(group => group.value)))} 毫米，线宽的粗细层级已倒置`)
  }

  const rewritten = svg.replace(GROUP_WITH_STROKE_WIDTH, (tag, raw: string) => {
    const width = Number(raw)
    if (!Number.isFinite(width)) return tag
    const visible = Math.abs(width - maxWidth) <= WIDTH_EPSILON
    if (visible && targetWidth !== undefined) return withStrokeWidth(tag, targetWidth)
    if (!visible && wantsDash) {
      return withStrokeWidth(tag, width, `${fmt(width * DASH_LENGTH_FACTOR)} ${fmt(width * DASH_GAP_FACTOR)}`)
    }
    return tag
  })
  assertSafeSvg(rewritten, DEFAULT_SVG_MAX_BYTES)
  const before = measureInkBounds(svg)
  const after = measureInkBounds(rewritten)
  /* v8 ignore next 2 -- only stroke-width/dasharray attributes change; subpath vertices and text are untouched. */
  if (before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
    warnings.push(`改写后墨迹范围从 (${fmt(before.minX)}, ${fmt(before.minY)})-(${fmt(before.maxX)}, ${fmt(before.maxY)}) 变成 (${fmt(after.minX)}, ${fmt(after.minY)})-(${fmt(after.maxX)}, ${fmt(after.maxY)})；线宽/线型不该改变几何`)
  }
  return { svg: rewritten, warnings }
}
