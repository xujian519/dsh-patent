/**
 * SVG 引线标号后处理（纯函数，无 IO）。
 *
 * 解析 Graphviz SVG 的节点组（结构经 Graphviz 输出采样确认：`<g
 * class="node">` + `<title>`=DOT 节点 id + `<polygon>`/`<ellipse>` 轮廓
 * + `<text>` 标签；节点组内不嵌套 `<g>`——若出现则组解析在首个 `</g>`
 * 截断，退化为内嵌标号告警，不会越界），把参考标号绘制在节点轮廓之外
 * 并用 `<line>` 引线指向节点。锚点取自节点真实轮廓：多边形保留顶点，按
 * 「中心 → 候选方向」的射线与边求交（平行四边形、梯形、菱形的包围盒角点
 * 不在轮廓上，不能直接当起点），椭圆按解析式求交。候选按右/左/上/下尝试，
 * 冲突时先按配置的毫米步长逐级外推，外推仍无空间再换方向、换斜向；候选
 * 位置要求与节点轮廓、已放置标号、图内已绘线条（`<g class="edge">` 内的
 * 边路径、箭头与边标签）都不相交，标号文本框还要与其他节点、已放标号保持
 * 配置的净距——与渲染复核同一口径——《专利审查指南》第一部分第一章 4.3
 * 要求剖面线不得妨碍附图标记线和主线条的清楚识别，故引线不与其他线条
 * 共线或压盖。无可用位置、节点缺轮廓或所在组含缩放/旋转/翻转时退化为在
 * 匹配文本尾部内嵌标号并输出警告，绝不画出压盖图面的引线。
 *
 * 坐标帧：节点组坐标按其所在组的累计平移换算到根坐标系后再放置，引线组
 * 注入根元素末尾，因此引线的位置与图面一致。放置后若标号或引线越出根元素
 * 声明的画布（viewBox/width/height），按需扩边——越界侧补足、视口起点外移，
 * 使标号完整可见：画布之外的标号在 SVG 与光栅输出中都不可见。识别纯平移
 * 帧（含 Graphviz 15 的 `scale(1 1) rotate(0) translate(4 40)` 恒等形态），
 * 其余变换下坐标不可换算，退化为内嵌标号并告警。
 *
 * 输入安全检查复用 svg-annotate 的 assertSafeSvg。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/leader-line
 */

import {
  DEFAULT_SVG_MAX_BYTES,
  assertSafeSvg,
  escapeXmlText,
  stripEmbeddedNumeral,
  stripLeaderAnnotations,
  textElementContent,
  validateSvgReferences,
} from './svg-annotate.ts'
import { boundsOfPoints, formatMm } from './mm-primitives.ts'
import { raySegmentIntersection, segmentsIntersect } from './geometry.ts'
import { resolveSvgViewport } from './svg-viewport.ts'
import type { SvgAnnotateReference } from './svg-annotate.ts'

/** 引线标号选项。 */
type LeaderLineOptions = {
  /** 输入大小上限（字节），默认 {@link DEFAULT_SVG_MAX_BYTES}。 */
  maxBytes?: number
  /** 标号与已放标号、图元的净距（毫米），默认 {@link DEFAULT_LEADER_CLEARANCE_MM}；0 关闭。 */
  clearanceMm?: number
  /** 放置冲突时每次向外推的步长（毫米），默认 {@link DEFAULT_LEADER_PUSH_STEP_MM}。 */
  pushStepMm?: number
  /** 向外推的距离上限（毫米），默认 {@link DEFAULT_LEADER_PUSH_LIMIT_MM}；0 不外推。 */
  pushLimitMm?: number
}

/** 引线标注结果：新 SVG 文本 + 警告（未命中参考、退化内嵌的节点）。 */
type LeaderLineResult = {
  svg: string
  warnings: string[]
}

/** SVG 用户单位下的矩形（min < max）。 */
type Rect = { minX: number; minY: number; maxX: number; maxY: number }

/** SVG 用户单位下的线段。 */
type Segment = { x1: number; y1: number; x2: number; y2: number }

/** SVG 用户单位下的点。 */
type Point = { x: number; y: number }

/**
 * 节点轮廓：多边形保留真实顶点（斜边形状按射线与边求交取锚点），椭圆按解析式求交。
 * `rect` 是轮廓的包围盒，用于标号排布与画布核算。
 */
type Outline =
  | { kind: 'polygon'; rect: Rect; points: readonly Point[] }
  | { kind: 'ellipse'; rect: Rect; cx: number; cy: number; rx: number; ry: number }

/** 根坐标系下的平移帧；undefined 表示该组含缩放/旋转/翻转，坐标不可换算。 */
type Frame = { tx: number; ty: number }

/** 引线候选锚点：线段两端、标号文本位置与占用区（引线细条 + 标号文本框，固定两项）。 */
type AnchorPlacement = {
  line: Segment
  text: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }
  occupied: readonly [Rect, Rect]
}

/** 解析后的节点组。 */
type ParsedNodeGroup = {
  /** 组片段在 SVG 中的起始偏移。 */
  offset: number
  /** 组片段原文。 */
  raw: string
  /** `<title>` 文本（DOT 节点 id；缺省为空串）。 */
  title: string
  /** 组内全部文本元素的可见拼接（小写，用于参考匹配）。 */
  text: string
  /** 节点轮廓（组坐标系）；组内无 polygon/ellipse 时 undefined。 */
  outline: Outline | undefined
  /** 组内首个文本元素的 font-size（无文本时 {@link FALLBACK_FONT_SIZE}）；标号几何与图面 scale 的依据。 */
  fontSize: number
  /** 组坐标系到根坐标系的平移帧。 */
  frame: Frame | undefined
  /** 命中的参考序号；未命中 -1。 */
  referenceIndex: number
}

/** 图内已绘线条在根坐标系下的占用（边路径折线、箭头多边形、边标签文本框）。 */
type Obstacles = {
  rects: Rect[]
  segments: Segment[]
}

/** 根元素声明的画布。 */
type Canvas = {
  /** 根元素开标签原文。 */
  tag: string
  minX: number
  minY: number
  width: number
  height: number
  /** 根元素声明的 width（数值/单位 + 数值到用户单位的比例）；未声明时 undefined。 */
  widthAttr: { value: number; unit: string; ratio: number } | undefined
  /** 根元素声明的 height（数值/单位 + 数值到用户单位的比例）；未声明时 undefined。 */
  heightAttr: { value: number; unit: string; ratio: number } | undefined
  /** 用户单位 → 毫米的换算（取两轴中较小的比例，净距按更保守的一侧换算）；无法解析时为 0。 */
  unitsPerMm: number
}

/** 引线长度基线（SVG 用户单位，scale=1）；实际长度随图面 scale 归一（见 {@link drawingScale}）。 */
const LEADER_GAP = 10

/**
 * 标号净距默认值（毫米）：与渲染复核对引线标号图型使用的下限一致，放置期就
 * 留出复核期要求的空白，避免工具产出被自己的复核判负。
 */
export const DEFAULT_LEADER_CLEARANCE_MM = 0.5

/** 放置冲突时每次向外推的步长默认值（毫米）。 */
export const DEFAULT_LEADER_PUSH_STEP_MM = 2

/** 向外推的距离上限默认值（毫米）：超过即认为该方向无空间，交给下一方向或内嵌。 */
export const DEFAULT_LEADER_PUSH_LIMIT_MM = 30

/** 画布扩边安全边距基线（用户单位，scale=1），保证标号与引线不贴边。 */
const CANVAS_PAD = 2

/** 标号文本行高相对 font-size 的比例（占位与碰撞判定用）。 */
const NUMERAL_TEXT_HEIGHT_RATIO = 1.2

/** 标号文本框在估算字宽之外的额外留白相对 font-size 的比例。 */
const NUMERAL_PAD_RATIO = 0.2

/** 标号基线相对锚点的微调（font-size 的分数）：左右向垂直居中、上下向让位引线端。 */
const TEXT_BASELINE_MID_RATIO = 0.35
const TEXT_GAP_RATIO = 0.3
const TEXT_BOTTOM_DROP_RATIO = 0.9

/** 图面 scale 基线 font-size：节点中位 font-size 等于它时 scale=1，几何常量按原值生效。 */
const BASELINE_FONT_SIZE = 10

/** 缺省 font-size（文本元素未声明或非法时，与 Graphviz 默认一致）。 */
const FALLBACK_FONT_SIZE = 10

/** 图面 scale 归一的上下限，避免极端 font-size 使引线几何失控。 */
const MIN_SCALE = 0.5
const MAX_SCALE = 4

/** 画布单边扩边超过此比例时告警（同一物理页面下字号会被压细）。 */
const CANVAS_EXPAND_WARN_RATIO = 0.15

/** 边路径三次贝塞尔的采样段数（折线近似，用于引线避让）。 */
const EDGE_SAMPLES = 8

/** 文本框估算：字宽相对 font-size 的比例（ASCII 与 CJK 分别取窄/满宽）。 */
const ASCII_WIDTH_RATIO = 0.55
const CJK_WIDTH_RATIO = 1

/** 文本框估算：基线到框顶/框底相对 font-size 的比例。 */
const TEXT_ASCENT_RATIO = 0.8
const TEXT_DESCENT_RATIO = 0.25

/** CJK 字符（含全角标点）判定，用于文本框估算。 */
const CJK_CHAR_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/

/** CSS 长度单位到 px 的换算（无 viewBox 时用户单位即 px）。 */
const LENGTH_UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
}

/** 坐标格式化（最多 1 位小数）：引线坐标只到十分之一毫米，比全局精度更松。 */
function fmtCoord(value: number): string {
  return formatMm(value, 1)
}

/** 两矩形是否相交（共享边界不算）。 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

/** 点是否落在矩形内（含边界）。 */
function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY
}

/** 线段是否穿过矩形（含端点落在矩形内）。 */
function segmentIntersectsRect(segment: Segment, rect: Rect): boolean {
  if (pointInRect(segment.x1, segment.y1, rect) || pointInRect(segment.x2, segment.y2, rect)) return true
  const { minX, minY, maxX, maxY } = rect
  const edges: Segment[] = [
    { x1: minX, y1: minY, x2: maxX, y2: minY },
    { x1: maxX, y1: minY, x2: maxX, y2: maxY },
    { x1: maxX, y1: maxY, x2: minX, y2: maxY },
    { x1: minX, y1: maxY, x2: minX, y2: minY },
  ]
  return edges.some(edge => segmentsIntersect(segment, edge))
}

/** 矩形按平移换算到根坐标系。 */
function translateRect(rect: Rect, frame: Frame): Rect {
  return {
    minX: rect.minX + frame.tx,
    minY: rect.minY + frame.ty,
    maxX: rect.maxX + frame.tx,
    maxY: rect.maxY + frame.ty,
  }
}

/**
 * 轮廓按平移换算到根坐标系。
 * @param outline - 组坐标系下的轮廓。
 * @param frame - 组到根坐标系的平移。
 * @returns 根坐标系下的轮廓。
 */
function translateOutline(outline: Outline, frame: Frame): Outline {
  const rect = translateRect(outline.rect, frame)
  if (outline.kind === 'polygon') {
    return { kind: 'polygon', rect, points: outline.points.map(point => ({ x: point.x + frame.tx, y: point.y + frame.ty })) }
  }
  return { kind: 'ellipse', rect, cx: outline.cx + frame.tx, cy: outline.cy + frame.ty, rx: outline.rx, ry: outline.ry }
}

/**
 * 取除当前节点外的其余节点包围盒。
 * @param rects - 与节点组一一对应的包围盒（缺轮廓/不可换算时为 undefined）。
 * @param index - 当前节点下标。
 * @returns 其余节点的包围盒。
 */
function nodeRectsExcept(rects: readonly (Rect | undefined)[], index: number): Rect[] {
  const others: Rect[] = []
  rects.forEach((rect, otherIndex) => {
    if (rect !== undefined && otherIndex !== index) others.push(rect)
  })
  return others
}

/** 取标签的数值属性；缺失或非有限值时 undefined。 */
function numberAttr(tag: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}="([^"]+)"`).exec(tag)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** 从 `<polygon>` 的 points 属性解析轮廓顶点；点对非法时 undefined。 */
function polygonPoints(pointsAttr: string): Point[] | undefined {
  const pairs = pointsAttr.trim().split(/\s+/).filter(pair => pair !== '')
  if (pairs.length === 0) return undefined
  const points: Point[] = []
  for (const pair of pairs) {
    const parts = pair.split(',')
    const x = Number(parts[0])
    const y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    points.push({ x, y })
  }
  return points
}

/** 从 `<polygon>` 的 points 属性解析轮廓 bbox；点对非法时 undefined。 */
function polygonBBox(pointsAttr: string): Rect | undefined {
  const points = polygonPoints(pointsAttr)
  return points === undefined ? undefined : boundsOfPoints(points.map(point => [point.x, point.y]))
}

/** 从 `<ellipse ...>` 标签解析轮廓 bbox；属性缺失/非法时 undefined。 */
function ellipseBBox(ellipseTag: string): Rect | undefined {
  const cx = numberAttr(ellipseTag, 'cx')
  const cy = numberAttr(ellipseTag, 'cy')
  const rx = numberAttr(ellipseTag, 'rx')
  const ry = numberAttr(ellipseTag, 'ry')
  if (cx === undefined || cy === undefined || rx === undefined || ry === undefined) return undefined
  return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry }
}

/**
 * 解析节点组轮廓：多边形保留真实顶点（斜边形状不能只用包围盒），椭圆保留中心与半径。
 * @param raw - 节点组片段。
 * @returns 轮廓；组内无 polygon/ellipse 或属性非法时 undefined。
 */
function nodeOutline(raw: string): Outline | undefined {
  const polygonMatch = /<polygon\b[^>]*\bpoints="([^"]*)"/.exec(raw)
  if (polygonMatch !== null) {
    const points = polygonPoints(polygonMatch[1] as string)
    if (points === undefined) return undefined
    return { kind: 'polygon', rect: boundsOfPoints(points.map(point => [point.x, point.y])), points }
  }
  const ellipseMatch = /<ellipse\b[^>]*>/.exec(raw)
  if (ellipseMatch === null) return undefined
  const rect = ellipseBBox(ellipseMatch[0])
  if (rect === undefined) return undefined
  const rx = (rect.maxX - rect.minX) / 2
  const ry = (rect.maxY - rect.minY) / 2
  if (rx <= 0 || ry <= 0) return undefined
  return {
    kind: 'ellipse',
    rect,
    cx: (rect.minX + rect.maxX) / 2,
    cy: (rect.minY + rect.maxY) / 2,
    rx,
    ry,
  }
}

/** 包围盒在指定方向上的边中点（轮廓求交失败时的回退）。 */
function bboxAnchor(rect: Rect, dx: number, dy: number): Point {
  const cx = (rect.minX + rect.maxX) / 2
  const cy = (rect.minY + rect.maxY) / 2
  if (dx !== 0) return { x: dx > 0 ? rect.maxX : rect.minX, y: cy }
  return { x: cx, y: dy > 0 ? rect.maxY : rect.minY }
}

/**
 * 沿「节点中心 → 候选方向」的射线与真实轮廓求交，作为引线起点。
 *
 * 斜边形状（平行四边形、梯形、菱形、六边形）的包围盒角点/边中点并不落在轮廓上，
 * 直接用作起点会让引线悬空；矩形/平行四边形的包围盒角点恰是顶点时保留角点锚点，
 * 以维持正交方向的既有落点。椭圆按解析式求交。
 * @param outline - 节点轮廓（组坐标系）。
 * @param dx - 方向 X 分量（-1/0/1）。
 * @param dy - 方向 Y 分量（-1/0/1）。
 * @returns 轮廓上的锚点（组坐标系）；轮廓退化时回退包围盒边中点。
 */
function outlineAnchor(outline: Outline, dx: number, dy: number): Point {
  const { rect } = outline
  const cx = (rect.minX + rect.maxX) / 2
  const cy = (rect.minY + rect.maxY) / 2
  if (outline.kind === 'ellipse') {
    const t = 1 / Math.hypot(dx / outline.rx, dy / outline.ry)
    return { x: outline.cx + dx * t, y: outline.cy + dy * t }
  }
  if (dx !== 0 && dy !== 0) {
    const corner = { x: dx > 0 ? rect.maxX : rect.minX, y: dy > 0 ? rect.maxY : rect.minY }
    if (outline.points.some(point => point.x === corner.x && point.y === corner.y)) return corner
  }
  let nearest: number | undefined
  for (let index = 0; index < outline.points.length; index += 1) {
    const from = outline.points[index] as Point
    const to = outline.points[(index + 1) % outline.points.length] as Point
    const t = raySegmentIntersection([cx, cy], [dx, dy], { x1: from.x, y1: from.y, x2: to.x, y2: to.y })
    if (t !== undefined && (nearest === undefined || t < nearest)) nearest = t
  }
  if (nearest === undefined) return bboxAnchor(rect, dx, dy)
  return { x: cx + dx * nearest, y: cy + dy * nearest }
}

/** 读取文本元素声明的 font-size；缺失或非法（≤ 0）时回退 {@link FALLBACK_FONT_SIZE}。 */
function readFontSize(textElement: string): number {
  const size = numberAttr(textElement, 'font-size')
  return size === undefined || size <= 0 ? FALLBACK_FONT_SIZE : size
}

/** 估算文本宽度（CJK 按满宽、其余按窄宽）。 */
function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) width += fontSize * (CJK_CHAR_PATTERN.test(char) ? CJK_WIDTH_RATIO : ASCII_WIDTH_RATIO)
  return width
}

/** 估算 `<text>` 元素在组坐标系的文本框（基线上下按 font-size 比例展开）。 */
function textBBox(textElement: string): Rect | undefined {
  const x = numberAttr(textElement, 'x')
  const y = numberAttr(textElement, 'y')
  if (x === undefined || y === undefined) return undefined
  const fontSize = readFontSize(textElement)
  const anchor = /\btext-anchor="(\w+)"/.exec(textElement)?.[1] ?? 'start'
  const width = estimateTextWidth(textElementContent(textElement), fontSize)
  const minX = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x
  return {
    minX,
    minY: y - fontSize * TEXT_ASCENT_RATIO,
    maxX: minX + width,
    maxY: y + fontSize * TEXT_DESCENT_RATIO,
  }
}

/**
 * 解析 `<g>` 的 transform：只接受恒等与平移，返回相对父组的平移；
 * 含缩放/旋转/翻转时 undefined（坐标不可换算，调用方退化为内嵌标号）。
 * @param tag - `<g ...>` 开标签原文。
 * @returns 该组自身的平移；不可换算时 undefined。
 */
function parseGroupTransform(tag: string): Frame | undefined {
  const attr = /\btransform="([^"]*)"/.exec(tag)
  if (attr === null) return { tx: 0, ty: 0 }
  let tx = 0
  let ty = 0
  const fnPattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = fnPattern.exec(attr[1] as string)) !== null) {
    const name = (match[1] as string).toLowerCase()
    const values = (match[2] as string).trim().split(/[\s,]+/).filter(value => value !== '').map(Number)
    if (values.some(value => !Number.isFinite(value))) return undefined
    if (name === 'translate') {
      tx += values[0] ?? 0
      ty += values[1] ?? 0
    } else if (name === 'scale') {
      if (values[0] !== 1 || values[1] !== 1) return undefined
    } else if (name === 'rotate') {
      if (values[0] !== 0 || values.length !== 1) return undefined
    } else if (name === 'matrix') {
      if (values.length !== 6 || values[0] !== 1 || values[1] !== 0 || values[2] !== 0 || values[3] !== 1) return undefined
      tx += values[4] as number
      ty += values[5] as number
    } else {
      return undefined
    }
  }
  return { tx, ty }
}

/** 组作用域：起止偏移与该作用域内的累计平移（根坐标系）。 */
type GroupScope = { start: number; end: number; frame: Frame | undefined }

/**
 * 扫描全部 `<g>` 作用域并累计各自到根坐标系的平移。
 * @param svgText - SVG 文本。
 * @returns 作用域列表（闭合顺序）；frame 为 undefined 表示含非平移变换。
 */
function groupScopes(svgText: string): GroupScope[] {
  const scopes: GroupScope[] = []
  const stack: { start: number; frame: Frame | undefined }[] = []
  const tagPattern = /<g\b[^>]*>|<\/g\s*>/g
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(svgText)) !== null) {
    if (match[0].startsWith('</')) {
      const open = stack.pop()
      if (open === undefined) continue
      scopes.push({ start: open.start, end: match.index, frame: open.frame })
      continue
    }
    const parent = stack.length === 0 ? { tx: 0, ty: 0 } : (stack[stack.length - 1] as { frame: Frame | undefined }).frame
    const own = parseGroupTransform(match[0])
    stack.push({
      start: match.index + match[0].length,
      frame: parent === undefined || own === undefined
        ? undefined
        : { tx: parent.tx + own.tx, ty: parent.ty + own.ty },
    })
  }
  return scopes
}

/**
 * 取偏移处最内层组的平移帧。
 * @param scopes - {@link groupScopes} 结果。
 * @param offset - 文档内偏移。
 * @returns 根坐标系平移；未嵌套在任何组内时为恒等；含非平移变换时 undefined。
 */
function frameAt(scopes: readonly GroupScope[], offset: number): Frame | undefined {
  let innermost: GroupScope | undefined
  for (const scope of scopes) {
    if (scope.start <= offset && offset < scope.end && (innermost === undefined || scope.start > innermost.start)) {
      innermost = scope
    }
  }
  return innermost === undefined ? { tx: 0, ty: 0 } : innermost.frame
}

/** 三次贝塞尔在 t 处的点。 */
function cubicPoint(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const inv = 1 - t
  const a = inv * inv * inv
  const b = 3 * inv * inv * t
  const c = 3 * inv * t * t
  const d = t * t * t
  return {
    x: a * start.x + b * control1.x + c * control2.x + d * end.x,
    y: a * start.y + b * control1.y + c * control2.y + d * end.y,
  }
}

/** 点按平移换算到根坐标系。 */
function translatePoint(point: { x: number; y: number }, frame: Frame): { x: number; y: number } {
  return { x: point.x + frame.tx, y: point.y + frame.ty }
}

/**
 * 把 SVG path 的 M/L/C 段采样成根坐标系折线；命令或数值非法时返回空列表。
 * @param d - path 的 d 属性值。
 * @param frame - 该 path 所在组的平移帧。
 * @returns 折线段列表。
 */
function samplePath(d: string, frame: Frame): Segment[] {
  const segments: Segment[] = []
  const commandPattern = /([MLC])([^MLC]*)/g
  let cursor: { x: number; y: number } | undefined
  let match: RegExpExecArray | null
  while ((match = commandPattern.exec(d)) !== null) {
    const numbers = (match[2] as string).trim().split(/[\s,]+/).filter(value => value !== '').map(Number)
    if (numbers.some(value => !Number.isFinite(value))) return []
    const command = match[1] as string
    if (command === 'M') {
      if (numbers.length < 2) return []
      cursor = { x: numbers[0] as number, y: numbers[1] as number }
      continue
    }
    if (command === 'L') {
      if (cursor === undefined || numbers.length < 2) return []
      const start = cursor
      const end = { x: numbers[0] as number, y: numbers[1] as number }
      segments.push(toSegment(start, end, frame))
      cursor = end
      continue
    }
    if (cursor === undefined) return []
    let start = cursor
    for (let offset = 0; offset + 6 <= numbers.length; offset += 6) {
      const control1 = { x: numbers[offset] as number, y: numbers[offset + 1] as number }
      const control2 = { x: numbers[offset + 2] as number, y: numbers[offset + 3] as number }
      const end = { x: numbers[offset + 4] as number, y: numbers[offset + 5] as number }
      let previous = start
      for (let step = 1; step <= EDGE_SAMPLES; step += 1) {
        const point = cubicPoint(start, control1, control2, end, step / EDGE_SAMPLES)
        segments.push(toSegment(previous, point, frame))
        previous = point
      }
      start = end
    }
    if (start === cursor) return []
    cursor = start
  }
  return segments
}

/** 两点按平移换算为根坐标系下的线段。 */
function toSegment(a: { x: number; y: number }, b: { x: number; y: number }, frame: Frame): Segment {
  const start = translatePoint(a, frame)
  const end = translatePoint(b, frame)
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
}

/**
 * 收集图内已绘线条在根坐标系下的占用：边组内的路径折线、箭头多边形与边标签。
 * 边组之外的 `<path>`/`<polygon>`（如背景矩形）不计入，避免整幅图被当成障碍。
 * @param svgText - SVG 文本。
 * @param scopes - {@link groupScopes} 结果。
 * @returns 障碍矩形与障碍线段。
 */
function edgeObstacles(svgText: string, scopes: readonly GroupScope[]): Obstacles {
  const rects: Rect[] = []
  const segments: Segment[] = []
  const edgePattern = /<g\b[^>]*\bclass="edge"[^>]*>[\s\S]*?<\/g>/g
  let match: RegExpExecArray | null
  while ((match = edgePattern.exec(svgText)) !== null) {
    const frame = frameAt(scopes, match.index)
    if (frame === undefined) continue
    const raw = match[0]
    for (const path of raw.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
      segments.push(...samplePath(path[1] as string, frame))
    }
    for (const polygon of raw.matchAll(/<polygon\b[^>]*\bpoints="([^"]*)"/g)) {
      const rect = polygonBBox(polygon[1] as string)
      if (rect !== undefined) rects.push(translateRect(rect, frame))
    }
    for (const text of raw.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/gi)) {
      const rect = textBBox(text[0])
      if (rect !== undefined) rects.push(translateRect(rect, frame))
    }
  }
  return { rects, segments }
}

/**
 * 由全部节点文本的 font-size 中位数推导图面 scale（相对 {@link BASELINE_FONT_SIZE}，
 * 限幅 [{@link MIN_SCALE}, {@link MAX_SCALE}]）。大字号/大图面下引线间隙与扩边边距
 * 同比放大，避免绝对阈值与画布尺寸脱钩（外部报告第 7 条根因）。
 * @param fontSizes - 各节点组的 font-size。
 * @returns scale 因子；无节点时 1。
 */
function drawingScale(fontSizes: readonly number[]): number {
  if (fontSizes.length === 0) return 1
  const sorted = [...fontSizes].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number)
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, median / BASELINE_FONT_SIZE))
}

/** 外推距离序列：0、step、2·step……直到 limit（step/limit 非正时只取 0）。 */
function pushOffsets(push: { step: number; limit: number }): number[] {
  const offsets = [0]
  if (!(push.step > 0) || !(push.limit > 0)) return offsets
  for (let distance = push.step; distance <= push.limit; distance += push.step) offsets.push(distance)
  return offsets
}

/**
 * 为节点轮廓生成右/左/上/下四个正交候选锚点（引线从真实轮廓边缘出发，标号在线端外侧）。
 * 每个方向按 0、step、2·step…逐级外推，先试近处再试远处：外推优先于换方向、
 * 换方向优先于内嵌，避免密集图里把本可外移的标号直接挤成内嵌。
 * 标号文本框宽/高与基线微调均由节点实读 font-size 推导（与边标签宽共用
 * {@link estimateTextWidth}），引线长度与走廊用图面 scale 归一的 gap。
 * @param outline - 节点轮廓（根坐标系）。
 * @param numeral - 标号文本。
 * @param fontSize - 节点实读 font-size（标号与之一致）。
 * @param gap - 已按图面 scale 归一的引线长度。
 * @param push - 已按毫米换算的外推步长与上限（SVG 用户单位）。
 * @returns 按尝试顺序排列的正交候选。
 */
function candidatePlacements(
  outline: Outline,
  numeral: string,
  fontSize: number,
  gap: number,
  push: { step: number; limit: number },
): AnchorPlacement[] {
  const { rect } = outline
  const width = estimateTextWidth(numeral, fontSize) + fontSize * NUMERAL_PAD_RATIO
  const cx = (rect.minX + rect.maxX) / 2
  const cy = (rect.minY + rect.maxY) / 2
  const textHeight = fontSize * NUMERAL_TEXT_HEIGHT_RATIO
  const halfH = textHeight / 2
  const midOffset = fontSize * TEXT_BASELINE_MID_RATIO
  const textGap = fontSize * TEXT_GAP_RATIO
  const bottomDrop = fontSize * TEXT_BOTTOM_DROP_RATIO
  const placements: AnchorPlacement[] = []
  for (const extra of pushOffsets(push)) {
    const distance = gap + extra
    const rightAnchor = outlineAnchor(outline, 1, 0)
    const rightEnd = rect.maxX + distance
    placements.push({
      line: { x1: rightAnchor.x, y1: rightAnchor.y, x2: rightEnd, y2: rightAnchor.y },
      text: { x: rightEnd + textGap, y: cy + midOffset, anchor: 'start' },
      occupied: [
        { minX: rightAnchor.x, minY: cy - 1, maxX: rightEnd, maxY: cy + 1 },
        { minX: rightEnd + textGap, minY: cy - halfH, maxX: rightEnd + textGap + width, maxY: cy + halfH },
      ],
    })
    const leftAnchor = outlineAnchor(outline, -1, 0)
    const leftEnd = rect.minX - distance
    placements.push({
      line: { x1: leftAnchor.x, y1: leftAnchor.y, x2: leftEnd, y2: leftAnchor.y },
      text: { x: leftEnd - textGap, y: cy + midOffset, anchor: 'end' },
      occupied: [
        { minX: leftEnd, minY: cy - 1, maxX: leftAnchor.x, maxY: cy + 1 },
        { minX: leftEnd - textGap - width, minY: cy - halfH, maxX: leftEnd - textGap, maxY: cy + halfH },
      ],
    })
    const topAnchor = outlineAnchor(outline, 0, -1)
    const topEnd = rect.minY - distance
    placements.push({
      line: { x1: topAnchor.x, y1: topAnchor.y, x2: topAnchor.x, y2: topEnd },
      text: { x: cx, y: topEnd - textGap, anchor: 'middle' },
      occupied: [
        { minX: cx - 1, minY: topEnd, maxX: cx + 1, maxY: topAnchor.y },
        { minX: cx - width / 2, minY: topEnd - textGap - textHeight, maxX: cx + width / 2, maxY: topEnd - textGap },
      ],
    })
    const bottomAnchor = outlineAnchor(outline, 0, 1)
    const bottomEnd = rect.maxY + distance
    placements.push({
      line: { x1: bottomAnchor.x, y1: bottomAnchor.y, x2: bottomAnchor.x, y2: bottomEnd },
      text: { x: cx, y: bottomEnd + bottomDrop, anchor: 'middle' },
      occupied: [
        { minX: cx - 1, minY: bottomAnchor.y, maxX: cx + 1, maxY: bottomEnd },
        { minX: cx - width / 2, minY: bottomEnd, maxX: cx + width / 2, maxY: bottomEnd + textHeight },
      ],
    })
  }
  return placements
}

/**
 * 为节点轮廓生成四个斜向候选锚点（右上/左上/右下/左下），供正交方向均无空间
 * 时的二次扫描（B4）：密集图中先占位者可能把后处理节点挤成正交内嵌，斜向锚点
 * 多一个逃逸方向。引线自真实轮廓边（不再固定是包围盒角点）沿 45° 外向，
 * 标号在线端外侧；同样按外推步长逐级远离。
 * @param outline - 节点轮廓（根坐标系）。
 * @param numeral - 标号文本。
 * @param fontSize - 节点实读 font-size。
 * @param gap - 已按图面 scale 归一的引线长度（斜向取 45° 分量）。
 * @param push - 已按毫米换算的外推步长与上限（SVG 用户单位）。
 * @returns 按尝试顺序排列的斜向候选。
 */
function diagonalPlacements(
  outline: Outline,
  numeral: string,
  fontSize: number,
  gap: number,
  push: { step: number; limit: number },
): AnchorPlacement[] {
  const width = estimateTextWidth(numeral, fontSize) + fontSize * NUMERAL_PAD_RATIO
  const midOffset = fontSize * TEXT_BASELINE_MID_RATIO
  const textGap = fontSize * TEXT_GAP_RATIO
  const component = gap * Math.SQRT1_2
  const directions: { dx: number; dy: number; anchor: 'start' | 'end' }[] = [
    { dx: 1, dy: -1, anchor: 'start' },
    { dx: -1, dy: -1, anchor: 'end' },
    { dx: 1, dy: 1, anchor: 'start' },
    { dx: -1, dy: 1, anchor: 'end' },
  ]
  const placements: AnchorPlacement[] = []
  for (const extra of pushOffsets(push)) {
    const offset = component + extra
    for (const direction of directions) {
      const anchor = outlineAnchor(outline, direction.dx, direction.dy)
      const endX = anchor.x + direction.dx * offset
      const endY = anchor.y + direction.dy * offset
      const textX = endX + direction.dx * textGap
      const textY = endY + direction.dy * textGap + midOffset
      const boxMinX = direction.anchor === 'end' ? textX - width : textX
      // 走廊取线段包围盒（不加厚）：斜向引线自轮廓边出发，加厚会使走廊回推到轮廓内。
      const corridor: Rect = {
        minX: Math.min(anchor.x, endX),
        minY: Math.min(anchor.y, endY),
        maxX: Math.max(anchor.x, endX),
        maxY: Math.max(anchor.y, endY),
      }
      const textBox: Rect = {
        minX: boxMinX,
        minY: textY - fontSize * TEXT_ASCENT_RATIO,
        maxX: boxMinX + width,
        maxY: textY + fontSize * TEXT_DESCENT_RATIO,
      }
      placements.push({
        line: { x1: anchor.x, y1: anchor.y, x2: endX, y2: endY },
        text: { x: textX, y: textY, anchor: direction.anchor },
        occupied: [corridor, textBox] as const,
      })
    }
  }
  return placements
}

/** 矩形按净距外扩（margin 为 0 时原样返回，保持既有零重叠判定）。 */
function inflateRect(rect: Rect, margin: number): Rect {
  if (margin === 0) return rect
  return { minX: rect.minX - margin, minY: rect.minY - margin, maxX: rect.maxX + margin, maxY: rect.maxY + margin }
}

/**
 * 候选是否可用：引线线段不得压盖其他节点轮廓、已放置标号或图内已绘线条；标号文本框
 * 还要与这些元素保持 `clearance` 净距（与渲染复核同一口径），避免放置期判「不重叠」、
 * 复核期却判「净距不足」。自身节点不计入阻挡：锚点取自自身真实轮廓，引线按构造向外。
 * @param candidate - 候选锚点。
 * @param otherNodeRects - 其他节点的轮廓包围盒（根坐标系，不含自身）。
 * @param placedLabels - 已放置标号的文本框。
 * @param placedCorridors - 已放置引线的走廊。
 * @param obstacles - 图内已绘线条的占用。
 * @param clearance - 标号文本框的净距（SVG 用户单位）；0 时退化为零重叠判定。
 * @returns 位置可用时 true。
 */
function isFree(
  candidate: AnchorPlacement,
  otherNodeRects: readonly Rect[],
  placedLabels: readonly Rect[],
  placedCorridors: readonly Rect[],
  obstacles: Obstacles,
  clearance: number,
): boolean {
  const corridor = candidate.occupied[0]
  const text = candidate.occupied[1]
  const blockers = [...otherNodeRects, ...placedLabels, ...placedCorridors, ...obstacles.rects]
  if (blockers.some(other => overlaps(corridor, other))) return false
  const clearText = inflateRect(text, clearance)
  if (blockers.some(other => overlaps(clearText, other))) return false
  if (obstacles.segments.some(segment => segmentsIntersect(candidate.line, segment))) return false
  return !obstacles.segments.some(segment => segmentIntersectsRect(segment, clearText))
}

/** 渲染一条引线 + 标号文本的 SVG 片段（标号 font-size 与节点实读一致）。 */
function leaderLineFragment(placement: AnchorPlacement, numeral: string, fontSize: number): string {
  const line = placement.line
  const text = placement.text
  return [
    `<line x1="${fmtCoord(line.x1)}" y1="${fmtCoord(line.y1)}" x2="${fmtCoord(line.x2)}" y2="${fmtCoord(line.y2)}" stroke="black" stroke-width="1" data-dsh-role="leader"/>`,
    `<text x="${fmtCoord(text.x)}" y="${fmtCoord(text.y)}" font-size="${fmtCoord(fontSize)}" text-anchor="${text.anchor}" stroke="none" xml:space="preserve">${escapeXmlText(numeral)}</text>`,
  ].join('\n')
}

/**
 * 引线无放置空间时的退化路径：在组内最后一个文本元素尾部内嵌 ` (numeral)`
 * （插位规则与 annotateSvg 一致：优先最后一个 `</tspan>` 前）。
 * @param groupRaw - 节点组片段原文。
 * @param numeral - 标号文本。
 * @returns 内嵌标号后的组片段。
 */
function embedNumeralInGroup(groupRaw: string, numeral: string): string {
  const escaped = ` (${escapeXmlText(numeral)})`
  const textPattern = /<text\b[^>]*>[\s\S]*?<\/text>/gi
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = textPattern.exec(groupRaw)) !== null) last = match
  /* v8 ignore start -- the caller only invokes this on a group that matched via its text elements */
  if (last === null) return groupRaw
  /* v8 ignore stop */
  const whole = last[0]
  const lastTspan = whole.lastIndexOf('</tspan>')
  const insertAt = lastTspan >= 0 ? lastTspan : whole.length - '</text>'.length
  const tail = groupRaw.slice(last.index + whole.length)
  return groupRaw.slice(0, last.index) + whole.slice(0, insertAt) + escaped + whole.slice(insertAt) + tail
}

/**
 * 移除组内最后一个文本元素尾部的既有内嵌标号（上一次内嵌模式留下的），
 * 使内嵌→引线切换时不会同时出现两处标号。
 * @param groupRaw - 节点组片段原文。
 * @returns 已清理既有标号的组片段；无 `<text>` 或无既有标号时原样返回。
 */
function stripEmbeddedNumeralsInGroup(groupRaw: string): string {
  const textPattern = /<text\b[^>]*>[\s\S]*?<\/text>/gi
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = textPattern.exec(groupRaw)) !== null) last = match
  /* v8 ignore start -- the caller only invokes this on a group that matched via its text elements */
  if (last === null) return groupRaw
  /* v8 ignore stop */
  const whole = last[0]
  const stripped = stripEmbeddedNumeral(whole)
  if (stripped === whole) return groupRaw
  return groupRaw.slice(0, last.index) + stripped + groupRaw.slice(last.index + whole.length)
}

/** 解析根元素声明的 width/height：数值 + 单位 + 单位到 px 的换算。 */
function sizeAttribute(tag: string, name: string): { value: number; unit: string; px: number } | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([0-9.]+)([a-z%]*)"`, 'i').exec(tag)
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const factor = LENGTH_UNIT_PX[unit]
  if (!Number.isFinite(value) || value <= 0 || factor === undefined) return undefined
  return { value, unit, px: value * factor }
}

/**
 * 解析根元素画布：viewBox 优先；缺省时按 width/height（长度单位换算为 px）合成等价视口。
 * 同时给出用户单位到毫米的换算，供放置期净距与外推按物理毫米设置。
 * @param svgText - SVG 文本。
 * @returns 画布信息；根元素缺失或尺寸不可知时 undefined（调用方跳过扩边）。
 */
function parseCanvas(svgText: string): Canvas | undefined {
  const tagMatch = /<svg\b[^>]*>/i.exec(svgText)
  /* v8 ignore next -- annotateSvgWithLeaderLines runs assertSafeSvg, which requires an <svg…> open tag. */
  if (tagMatch === null) return undefined
  const tag = tagMatch[0]
  const width = sizeAttribute(tag, 'width')
  const height = sizeAttribute(tag, 'height')
  const viewport = resolveSvgViewport(tag)
  const scale = Math.min(viewport.scaleX, viewport.scaleY)
  const unitsPerMm = scale > 0 ? 1 / scale : 0
  const box = /\bviewBox="([^"]*)"/i.exec(tag)
  if (box !== null) {
    const values = (box[1] as string).trim().split(/[\s,]+/).map(Number)
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return undefined
    const [, , boxWidth, boxHeight] = values as [number, number, number, number]
    if (boxWidth <= 0 || boxHeight <= 0) return undefined
    return {
      tag,
      minX: values[0] as number,
      minY: values[1] as number,
      width: boxWidth,
      height: boxHeight,
      widthAttr: width === undefined ? undefined : { value: width.value, unit: width.unit, ratio: width.value / boxWidth },
      heightAttr: height === undefined ? undefined : { value: height.value, unit: height.unit, ratio: height.value / boxHeight },
      unitsPerMm,
    }
  }
  if (width === undefined || height === undefined) return undefined
  return {
    tag,
    minX: 0,
    minY: 0,
    width: width.px,
    height: height.px,
    widthAttr: { value: width.px, unit: 'px', ratio: 1 },
    heightAttr: { value: height.px, unit: 'px', ratio: 1 },
    unitsPerMm,
  }
}

/** 改写根元素开标签的 viewBox（缺省时插入）。 */
function replaceViewBox(tag: string, minX: number, minY: number, width: number, height: number): string {
  const value = `${fmtCoord(minX)} ${fmtCoord(minY)} ${fmtCoord(width)} ${fmtCoord(height)}`
  if (/\bviewBox="/i.test(tag)) return tag.replace(/\bviewBox="[^"]*"/i, () => `viewBox="${value}"`)
  return tag.replace(/<svg\b/i, match => `${match} viewBox="${value}"`)
}

/** 改写根元素开标签的 width/height 数值（保留单位）。 */
function replaceSizeAttribute(tag: string, name: string, value: number, unit: string): string {
  return tag.replace(
    new RegExp(`((?:^|\\s)${name}=")[0-9.]+[a-z%]*(")`, 'i'),
    (_whole, head: string, tail: string) => `${head}${fmtCoord(value)}${unit}${tail}`,
  )
}

/**
 * 放置几何越出画布时扩展视口：越界侧补 pad（已按图面 scale 归一的 {@link CANVAS_PAD}）安全边距。
 * 向右下越界靠放大尺寸，向左上越界靠外移 viewBox 起点（图面本身不动）。单边扩边幅
 * 超 {@link CANVAS_EXPAND_WARN_RATIO} 时 push 告警（扩边越多同一物理页面字号越细）。
 * @param svgText - SVG 文本。
 * @param canvas - 根元素声明的画布。
 * @param geometry - 已放置的引线与标号占用区（根坐标系）。
 * @param pad - 已按 scale 归一的安全边距。
 * @param warnings - 告警收集器（扩边幅超阈时追写）。
 * @returns 扩边后的 SVG 文本；未越界时原样返回。
 */
function expandCanvas(svgText: string, canvas: Canvas, geometry: readonly Rect[], pad: number, warnings: string[]): string {
  const maxX = canvas.minX + canvas.width
  const maxY = canvas.minY + canvas.height
  let neededMinX = canvas.minX
  let neededMinY = canvas.minY
  let neededMaxX = maxX
  let neededMaxY = maxY
  for (const rect of geometry) {
    neededMinX = Math.min(neededMinX, rect.minX)
    neededMinY = Math.min(neededMinY, rect.minY)
    neededMaxX = Math.max(neededMaxX, rect.maxX)
    neededMaxY = Math.max(neededMaxY, rect.maxY)
  }
  if (neededMinX === canvas.minX && neededMinY === canvas.minY && neededMaxX === maxX && neededMaxY === maxY) {
    return svgText
  }
  const minX = neededMinX < canvas.minX ? neededMinX - pad : canvas.minX
  const minY = neededMinY < canvas.minY ? neededMinY - pad : canvas.minY
  const outMaxX = neededMaxX > maxX ? neededMaxX + pad : maxX
  const outMaxY = neededMaxY > maxY ? neededMaxY + pad : maxY
  const width = outMaxX - minX
  const height = outMaxY - minY
  const growth = Math.max((width - canvas.width) / canvas.width, (height - canvas.height) / canvas.height)
  if (growth > CANVAS_EXPAND_WARN_RATIO) {
    warnings.push(`引线标号使画布单边扩边约 ${Math.round(growth * 100)}%（超 ${Math.round(CANVAS_EXPAND_WARN_RATIO * 100)}% 阈值）：同一物理页面下字号会被压细，建议缩小 DOT margin 或节点尺寸后重渲`)
  }
  let tag = replaceViewBox(canvas.tag, minX, minY, width, height)
  if (canvas.widthAttr !== undefined) {
    tag = replaceSizeAttribute(tag, 'width', width * canvas.widthAttr.ratio, canvas.widthAttr.unit)
  }
  if (canvas.heightAttr !== undefined) {
    tag = replaceSizeAttribute(tag, 'height', height * canvas.heightAttr.ratio, canvas.heightAttr.unit)
  }
  return svgText.replace(canvas.tag, () => tag)
}

/**
 * 在 Graphviz SVG 的节点组外侧绘制引线标号。
 *
 * 匹配语义与 annotateSvg 一致：按参考传入顺序取首个文本命中，每个节点
 * 组至多命中一个参考，同一参考可命中多个组（同号多处标注）。锚点取自节点
 * 真实轮廓（斜边形状不再用包围盒角点），候选方向冲突时先按配置步长逐级外推，
 * 外推仍无空间再换方向、换斜向，最后才退化为内嵌标号并告警。标号文本框与
 * 其他节点、已放标号保持配置的净距（毫米，按根元素视口换算）。
 * 标号越出根元素声明画布时按需扩边，保证引线与标号完整可见。
 *
 * 重跑幂等：先移除上一次写入的 `<g id="leader-lines">` 组，命中组内既有
 * 的内嵌标号一并清理，因此对同一 SVG 反复标注只保留一份标号。
 * @param svgText - Graphviz 渲染的 SVG 文本（WASM 与 CLI 输出同构）。
 * @param references - 参考标号列表（label 匹配组内可见文本）。
 * @param options - 大小上限、标号净距与外推步长/上限。
 * @returns 标注后的 SVG 文本与警告。
 * @throws SvgAnnotateError 输入不安全/非 SVG/过大或参考字段为空。
 */
export function annotateSvgWithLeaderLines(
  svgText: string,
  references: readonly SvgAnnotateReference[],
  options: LeaderLineOptions = {},
): LeaderLineResult {
  const maxBytes = options.maxBytes ?? DEFAULT_SVG_MAX_BYTES
  assertSafeSvg(svgText, maxBytes)
  validateSvgReferences(references)
  if (references.length === 0) return { svg: svgText, warnings: [] }

  const source = stripLeaderAnnotations(svgText)
  const scopes = groupScopes(source)
  const groups: ParsedNodeGroup[] = []
  const groupPattern = /<g\b[^>]*\bclass="node"[^>]*>[\s\S]*?<\/g>/g
  let groupMatch: RegExpExecArray | null
  while ((groupMatch = groupPattern.exec(source)) !== null) {
    const raw = groupMatch[0]
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(raw)
    const textParts: string[] = []
    const textPattern = /<text\b[^>]*>[\s\S]*?<\/text>/gi
    let textMatch: RegExpExecArray | null
    let fontSize = FALLBACK_FONT_SIZE
    let sawText = false
    while ((textMatch = textPattern.exec(raw)) !== null) {
      textParts.push(textElementContent(textMatch[0]))
      if (!sawText) {
        fontSize = readFontSize(textMatch[0])
        sawText = true
      }
    }
    const text = textParts.join('').toLowerCase()
    const referenceIndex = references.findIndex(ref => text.includes(ref.label.trim().toLowerCase()))
    groups.push({
      offset: groupMatch.index,
      raw,
      title: titleMatch === null ? '' : titleMatch[1] as string,
      text,
      outline: nodeOutline(raw),
      fontSize,
      frame: frameAt(scopes, groupMatch.index),
      referenceIndex,
    })
  }

  const warnings: string[] = []
  const obstacles = edgeObstacles(source, scopes)
  const nodeRects = groups.map(group =>
    group.outline === undefined || group.frame === undefined ? undefined : translateRect(group.outline.rect, group.frame))
  // 图面 scale 归一：引线间隙与扩边边距按节点中位 font-size 缩放（scale=1 时取基线常量原值）。
  const scale = drawingScale(groups.map(group => group.fontSize))
  const gap = LEADER_GAP * scale
  const pad = CANVAS_PAD * scale
  // 净距与外推按物理毫米配置，经根元素视口换算成用户单位；尺寸不可知时关闭（复核也无法按毫米判定）。
  const unitsPerMm = parseCanvas(source)?.unitsPerMm ?? 0
  const clearance = (options.clearanceMm ?? DEFAULT_LEADER_CLEARANCE_MM) * unitsPerMm
  const push = {
    step: (options.pushStepMm ?? DEFAULT_LEADER_PUSH_STEP_MM) * unitsPerMm,
    limit: (options.pushLimitMm ?? DEFAULT_LEADER_PUSH_LIMIT_MM) * unitsPerMm,
  }
  const embedded = new Map<number, string>()
  const fragments: string[] = []
  const placedLabels: Rect[] = []
  const placedCorridors: Rect[] = []
  // 正交四向均无空间的节点暂缓，待首轮放置完成后二次扫描斜向锚点（B4）。
  const pending: { index: number; group: ParsedNodeGroup; outline: Outline; numeral: string }[] = []
  for (const [index, group] of groups.entries()) {
    if (group.referenceIndex < 0) continue
    const numeral = (references[group.referenceIndex] as SvgAnnotateReference).numeral.trim()
    if (group.frame === undefined) {
      embedded.set(index, embedNumeralInGroup(stripEmbeddedNumeralsInGroup(group.raw), numeral))
      warnings.push(`节点 "${group.title}" 所在组的坐标含缩放/旋转，标号 ${numeral} 已内嵌`)
      continue
    }
    if (group.outline === undefined) {
      embedded.set(index, embedNumeralInGroup(stripEmbeddedNumeralsInGroup(group.raw), numeral))
      warnings.push(`节点 "${group.title}" 缺少形状轮廓，标号 ${numeral} 已内嵌`)
      continue
    }
    const outline = translateOutline(group.outline, group.frame)
    const others = nodeRectsExcept(nodeRects, index)
    const chosen = candidatePlacements(outline, numeral, group.fontSize, gap, push).find(candidate =>
      isFree(candidate, others, placedLabels, placedCorridors, obstacles, clearance))
    if (chosen === undefined) {
      pending.push({ index, group, outline, numeral })
      continue
    }
    placedCorridors.push(chosen.occupied[0])
    placedLabels.push(chosen.occupied[1])
    fragments.push(leaderLineFragment(chosen, numeral, group.fontSize))
  }
  // 二次扫描：正交方向失败的节点改试斜向锚点，仍无空间才退化为内嵌标号。
  for (const item of pending) {
    const others = nodeRectsExcept(nodeRects, item.index)
    const chosen = diagonalPlacements(item.outline, item.numeral, item.group.fontSize, gap, push).find(candidate =>
      isFree(candidate, others, placedLabels, placedCorridors, obstacles, clearance))
    if (chosen === undefined) {
      embedded.set(item.index, embedNumeralInGroup(stripEmbeddedNumeralsInGroup(item.group.raw), item.numeral))
      warnings.push(`节点 "${item.group.title}" 周边无引线空间，标号 ${item.numeral} 已内嵌`)
      continue
    }
    placedCorridors.push(chosen.occupied[0])
    placedLabels.push(chosen.occupied[1])
    fragments.push(leaderLineFragment(chosen, item.numeral, item.group.fontSize))
  }
  references.forEach((ref, index) => {
    if (!groups.some(group => group.referenceIndex === index)) {
      warnings.push(`参考 "${ref.label.trim()}" 未命中任何节点`)
    }
  })

  let result = ''
  let cursor = 0
  for (const [index, group] of groups.entries()) {
    const end = group.offset + group.raw.length
    const base = embedded.get(index)
      ?? (group.referenceIndex >= 0 ? stripEmbeddedNumeralsInGroup(group.raw) : group.raw)
    result += source.slice(cursor, group.offset) + base
    cursor = end
  }
  result += source.slice(cursor)
  if (fragments.length === 0) return { svg: result, warnings }
  const closeIndex = result.toLowerCase().lastIndexOf('</svg>')
  const fragment = `<g id="leader-lines">\n${fragments.join('\n')}\n</g>\n`
  result = result.slice(0, closeIndex) + fragment + result.slice(closeIndex)
  const canvas = parseCanvas(result)
  if (canvas !== undefined) result = expandCanvas(result, canvas, [...placedCorridors, ...placedLabels], pad, warnings)
  return { svg: result, warnings }
}
