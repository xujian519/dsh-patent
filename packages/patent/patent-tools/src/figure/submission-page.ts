/**
 * 附图落版：把一张图形（Graphviz 输出或矢量图型输出）按目标法域规格放到
 * 固定幅面的附图页上，并给出可核算的物理尺寸（纯函数，无 IO）。
 *
 * 为什么需要单独一步：Graphviz 的 `page`/`size`/`margin` 属性只影响图形自身
 * 的画布（本机实测 Graphviz 15.1.1：`page` 对 svg/png/pdf 不产生幅面，`size`
 * 只在超出时按比例缩小，`margin` 只加空白），因此渲染结果不是 A4 幅面，也
 * 无法据此核算字高与线宽。《专利审查指南》第五部分第一章 4.2/4.3 要求附图
 * 用 A4 并给出四边页边距，PCT Rule 11.6(c) 与 37 CFR 1.84(g) 给出各自的最小
 * 页边距与可用绘图区——这些都要在落版阶段落实。
 *
 * 图号（中国「图1」、PCT「Fig. 1」、USPTO「FIG. 1」）由本模块画在图形正下方，
 * 依据《专利审查指南》第一部分第一章 4.3「该编号应当标注在相应附图的正下方」、
 * PCT 申请人指南 IP 5.141 与 37 CFR 1.84(u)。
 * @module @deepseek-ai/dsh-patent-tools/figure/submission-page
 */

import { formatMm as fmtMm } from './mm-primitives.ts'
import { assertSafeSvg, DEFAULT_SVG_MAX_BYTES, SvgAnnotateError } from './svg-annotate.ts'
import { resolveSvgViewport } from './svg-viewport.ts'
import { escapeXmlAttribute } from './vector-figure.ts'
import type { OfficeProfile, TargetOffice } from './office-profile.ts'

/** 落版放大的上限，避免极小的图形被放大到失真的尺寸。 */
const MAX_PAGE_SCALE = 4

/** 图号字高默认值（毫米）。 */
export const DEFAULT_CAPTION_FONT_MM = 4

/** 图号与图形之间的间距默认值（毫米）。 */
export const DEFAULT_CAPTION_GAP_MM = 3

/** 页码字高默认值（毫米）。 */
export const DEFAULT_SHEET_FONT_MM = 3

/** 落版支持的旋转角（度）；只取直角，避免斜置后墨迹越出幅面。 */
export const SUBMISSION_ROTATIONS = [0, 90, 180, 270] as const

/** 落版旋转角。 */
export type SubmissionRotation = (typeof SUBMISSION_ROTATIONS)[number]

/** 数字与字母高度相对字号的折算比（大写字母高度约为字号的 0.7）。 */
const CHAR_HEIGHT_RATIO = 0.7

/** 落版页输入的图形尺寸（毫米）与用户单位映射（按 svg-viewport 解析的视口）。 */
type SvgGeometry = {
  /** 图形所占视口宽（毫米）：根元素未声明时按 viewBox 的 96 dpi 用户单位换算。 */
  widthMm: number
  /** 图形所占视口高（毫米）：根元素未声明时按 viewBox 的 96 dpi 用户单位换算。 */
  heightMm: number
  /** 视口左上角对应的用户单位 X（viewBox 原点减对齐偏移）。 */
  viewBoxX: number
  /** 视口左上角对应的用户单位 Y（viewBox 原点减对齐偏移）。 */
  viewBoxY: number
  /** 用户单位 → 毫米的换算比（纵向；等比映射时与横向同一值）。 */
  userUnitToMmY: number
  /** 用户单位 → 毫米的换算比（横向）。 */
  userUnitToMmX: number
  /** 根元素内部内容（不含 `<svg>` 根与文档声明）。 */
  inner: string
}

/** 落版页输入。 */
type SubmissionPageInput = {
  /** 图形 SVG 文本（Graphviz 输出或 vectorFigureSvg 输出）。 */
  drawingSvg: string
  /** 目标法域规格。 */
  profile: OfficeProfile
  /** 图号文字（如「图1」）；undefined 表示本幅不标图号（单幅图）。 */
  caption?: string | undefined
  /** 附图页页码文字（如「第2页 共3页」「2/3」）；undefined 表示不标页码。 */
  sheetNumber?: string | undefined
  /** 图形正文的数字与字母字号（用户单位，如 DOT 的 fontsize=10），用于核算字高。 */
  bodyFontSize?: number | undefined
  /** 图号与图形之间的间距（毫米），默认 {@link DEFAULT_CAPTION_GAP_MM}。 */
  captionGapMm?: number
  /** 图号字高（毫米），默认 {@link DEFAULT_CAPTION_FONT_MM}。 */
  captionFontMm?: number
  /** 页码字高（毫米），默认 {@link DEFAULT_SHEET_FONT_MM}。 */
  sheetFontMm?: number
  /**
   * 图形绕绘图区中心顺时针旋转的角度，默认 0（不旋转）。
   *
   * 90/270 会交换落版后的宽高——横向图形可借它落进竖向版心，图号与页码的落点规则不变。
   */
  rotateDeg?: SubmissionRotation
}

/** 落版后的物理尺寸（可依此核算法域的最小字高等要求）。 */
export type SubmissionPageMetrics = {
  /** 图形落版缩放比（1 表示原尺寸）。 */
  pageScale: number
  /** 图形落版前的声明尺寸（毫米）；未计旋转，与 {@link SubmissionPageInput.rotateDeg} 无关。 */
  drawingWidthMm: number
  /** 图形落版前的声明尺寸（毫米）；未计旋转，与 {@link SubmissionPageInput.rotateDeg} 无关。 */
  drawingHeightMm: number
  /** 旋转并缩放后图形占用的宽（毫米）。 */
  placedWidthMm: number
  /** 旋转并缩放后图形占用的高（毫米）。 */
  placedHeightMm: number
  /** 落版后正文数字/字母的字高（毫米）；未提供 bodyFontSize 时缺省。 */
  charHeightMm?: number
  /** 图形再缩小到法域规定比例时的字高（毫米）；未提供 bodyFontSize 时缺省。 */
  reducedCharHeightMm?: number
}

/**
 * 落版摘要：工具输出 `layout` 字段的形状（各附图生成工具共用）。
 */
export type SubmissionLayout = {
  /** 目标法域。 */
  office: TargetOffice
  /** 图形落版缩放比。 */
  pageScale: number
  /** 落版后图形占用的宽（毫米）。 */
  placedWidthMm: number
  /** 落版后图形占用的高（毫米）。 */
  placedHeightMm: number
  /** 落版后图中数字与字母的字高（毫米）；未提供源字号时缺省。 */
  charHeightMm?: number
  /** 再缩小到法域规定比例（三分之二）后的字高（毫米）；未提供源字号时缺省。 */
  reducedCharHeightMm?: number
  /** 落版页上的图号；未标注时缺省。 */
  caption?: string
  /** 落版页上的页码。 */
  sheetNumber: string
}

/** 落版结果。 */
type SubmissionPageResult = {
  /** 落版后的附图页 SVG。 */
  svg: string
  /** 落版尺寸。 */
  metrics: SubmissionPageMetrics
  /** 落版提示（尺寸声明缺失、放大被截断等）。 */
  warnings: string[]
}

/**
 * 解析图形 SVG 的物理尺寸、viewBox 与内部内容。
 * @param svgText - 图形 SVG 文本。
 * @returns 尺寸与内部内容。
 * @throws SvgAnnotateError 非 SVG、含不安全结构或尺寸不可解析时。
 */
export function parseDrawingSvg(svgText: string): { geometry: SvgGeometry; warnings: string[] } {
  assertSafeSvg(svgText, DEFAULT_SVG_MAX_BYTES)
  const openTag = /<svg\b[^>]*>/i.exec(svgText)?.[0]
  const closeIndex = svgText.toLowerCase().lastIndexOf('</svg>')
  /* v8 ignore next 2 -- assertSafeSvg already requires both the <svg…> open tag and </svg>. */
  if (openTag === undefined || closeIndex < 0) {
    throw new SvgAnnotateError('invalid_svg', '非 SVG 文档：缺少 <svg> 根元素')
  }
  const viewport = resolveSvgViewport(openTag)
  const { widthMm, heightMm, viewportWidthMm, viewportHeightMm } = viewport
  if (viewportWidthMm === undefined || viewportHeightMm === undefined) {
    throw new SvgAnnotateError('invalid_svg', 'SVG 缺少可解析的 width/height 或 viewBox')
  }
  const warnings = widthMm === undefined || heightMm === undefined
    ? ['图形未同时声明 width/height，缺失的一边按 viewBox 的 96 dpi 用户单位换算']
    : []
  if (viewport.note !== undefined) warnings.push(viewport.note)
  return {
    geometry: {
      widthMm: viewportWidthMm,
      heightMm: viewportHeightMm,
      viewBoxX: viewport.originX,
      viewBoxY: viewport.originY,
      userUnitToMmX: viewport.scaleX,
      userUnitToMmY: viewport.scaleY,
      inner: svgText.slice(svgText.indexOf(openTag) + openTag.length, closeIndex),
    },
    warnings,
  }
}

/**
 * 把图形落版到目标法域的固定幅面附图页。
 *
 * 旋转绕可绘图区中心：图形无论转多少度都居中，图号仍落在旋转后图形的正下方，
 * 页码仍在版心底部。
 * @param input - 图形、法域规格、图号与页码。
 * @returns 落版页 SVG、物理尺寸与提示。
 * @throws SvgAnnotateError 图形不是可解析的 SVG 时；RangeError 尺寸/字号参数非正时。
 */
export function buildSubmissionPage(input: SubmissionPageInput): SubmissionPageResult {
  const { profile, caption, sheetNumber, bodyFontSize } = input
  const rotateDeg = input.rotateDeg ?? 0
  const captionFontMm = input.captionFontMm ?? DEFAULT_CAPTION_FONT_MM
  const captionGapMm = input.captionGapMm ?? DEFAULT_CAPTION_GAP_MM
  const sheetFontMm = input.sheetFontMm ?? DEFAULT_SHEET_FONT_MM
  for (const value of [captionFontMm, captionGapMm, sheetFontMm]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`图号/页码尺寸必须为正：${String(value)}`)
    }
  }
  const { geometry, warnings } = parseDrawingSvg(input.drawingSvg)
  if (sheetNumber === undefined || sheetNumber.trim() === '') {
    warnings.push('附图页未写页码：每一幅附图页都应当编页码，请补写页码后再交付')
  }
  if (bodyFontSize !== undefined && (!Number.isFinite(bodyFontSize) || bodyFontSize <= 0)) {
    throw new RangeError(`正文字号必须为正：${String(bodyFontSize)}`)
  }

  const areaWidthMm = profile.paper.widthMm - profile.margins.leftMm - profile.margins.rightMm
  const areaHeightMm = profile.paper.heightMm - profile.margins.topMm - profile.margins.bottomMm
  if (areaWidthMm <= 0 || areaHeightMm <= 0) {
    throw new RangeError('页边距之和超过了纸张尺寸')
  }
  const captionBlockMm = caption === undefined ? 0 : captionGapMm + captionFontMm
  const figureAreaHeightMm = areaHeightMm - captionBlockMm

  // 90/270 交换图形的占位宽高：缩放比必须按旋转**后**的占位算，否则转过来的图形
  // 会越出可绘图区。旋转绕绘图区中心（该中心与旋转角无关），故未旋转的摆放框
  // 仍以同一中心定位，旋转后自然落成居中的旋转框。
  const quarterTurn = rotateDeg === 90 || rotateDeg === 270
  const boundingWidthMm = quarterTurn ? geometry.heightMm : geometry.widthMm
  const boundingHeightMm = quarterTurn ? geometry.widthMm : geometry.heightMm

  const rawScale = Math.min(areaWidthMm / boundingWidthMm, figureAreaHeightMm / boundingHeightMm)
  const pageScale = Math.min(rawScale, MAX_PAGE_SCALE)
  if (rawScale > MAX_PAGE_SCALE) {
    warnings.push(`图形相对幅面过小，落版放大被限制在 ${MAX_PAGE_SCALE} 倍；请核对图面细节是否仍可辨`)
  }
  const scaledWidthMm = geometry.widthMm * pageScale
  const scaledHeightMm = geometry.heightMm * pageScale
  const placedWidthMm = quarterTurn ? scaledHeightMm : scaledWidthMm
  const placedHeightMm = quarterTurn ? scaledWidthMm : scaledHeightMm

  const placeX = profile.margins.leftMm + (areaWidthMm - scaledWidthMm) / 2
  const placeY = profile.margins.topMm + (figureAreaHeightMm - scaledHeightMm) / 2
  const centerX = profile.margins.leftMm + areaWidthMm / 2
  const centerY = profile.margins.topMm + figureAreaHeightMm / 2
  const scaleX = geometry.userUnitToMmX
  const scaleY = geometry.userUnitToMmY

  // 旋转组比不旋转多一层，内层缩进随之加一档；不旋转时不产生任何多余节点。
  const depth = rotateDeg === 0 ? 0 : 1
  const pad = '  '.repeat(depth + 1)
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtMm(profile.paper.widthMm)}mm" height="${fmtMm(profile.paper.heightMm)}mm" viewBox="0 0 ${fmtMm(profile.paper.widthMm)} ${fmtMm(profile.paper.heightMm)}">`,
    '  <!-- 附图落版页：幅面与页边距按目标法域规格 -->',
  ]
  if (rotateDeg !== 0) {
    lines.push(`  <g transform="translate(${fmtMm(centerX)},${fmtMm(centerY)}) rotate(${String(rotateDeg)}) translate(${fmtMm(-centerX)},${fmtMm(-centerY)})">`)
  }
  lines.push(
    `${pad}<g transform="translate(${fmtMm(placeX)},${fmtMm(placeY)}) scale(${fmtMm(pageScale)})">`,
    `${pad}  <g transform="translate(${fmtMm(-geometry.viewBoxX)},${fmtMm(-geometry.viewBoxY)}) scale(${fmtMm(scaleX)},${fmtMm(scaleY)})">`,
    indent(geometry.inner.trim(), `${pad}    `.length),
    `${pad}  </g>`,
    `${pad}</g>`,
  )
  if (rotateDeg !== 0) lines.push('  </g>')
  if (caption !== undefined) {
    const captionY = profile.margins.topMm + (figureAreaHeightMm - placedHeightMm) / 2 + placedHeightMm + captionGapMm + captionFontMm * 0.8
    lines.push(textElement(centerX, captionY, captionFontMm, caption))
  }
  if (sheetNumber !== undefined) {
    const sheetY = profile.margins.topMm + areaHeightMm - sheetFontMm * 0.3
    lines.push(textElement(centerX, sheetY, sheetFontMm, sheetNumber))
  }
  lines.push('</svg>', '')

  const metrics: SubmissionPageMetrics = {
    pageScale,
    drawingWidthMm: geometry.widthMm,
    drawingHeightMm: geometry.heightMm,
    placedWidthMm,
    placedHeightMm,
    ...(bodyFontSize === undefined
      ? {}
      : {
        charHeightMm: bodyFontSize * geometry.userUnitToMmY * CHAR_HEIGHT_RATIO * pageScale,
        reducedCharHeightMm: bodyFontSize * geometry.userUnitToMmY * CHAR_HEIGHT_RATIO * pageScale * profile.reductionRatio,
      }),
  }
  return { svg: lines.join('\n'), metrics, warnings }
}

/**
 * 片段缩进（每行前加固定个空格；空行保持空）。
 * @param body - 待缩进的片段。
 * @param spaces - 缩进空格数。
 * @returns 逐行缩进后的片段。
 */
function indent(body: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return body
    .split('\n')
    .map(line => (line.trim() === '' ? '' : `${prefix}${line.trim()}`))
    .join('\n')
}

/** 页面上的一行居中文本（图号或页码）。 */
function textElement(centerX: number, baselineY: number, fontMm: number, text: string): string {
  return `  <text x="${fmtMm(centerX)}" y="${fmtMm(baselineY)}" text-anchor="middle" font-family="sans-serif" font-size="${fmtMm(fontMm)}" fill="#000000" stroke="none">${escapeXmlAttribute(text)}</text>`
}
