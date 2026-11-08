/**
 * 附图渲染复核的判据：在 {@link scanSvg} 量测出的图面事实上判定可读性缺陷。
 * 公开入口 {@link checkFigureRendering} 与 {@link measureInkBounds} 由
 * `render-check.ts` 再导出，调用方仍从该模块导入。
 * @module @deepseek-ai/dsh-patent-tools/figure/render-check-findings
 */

import { inflateQuad, quadCrossedBySegment } from './glyph-box.ts'
import type { GlyphQuad } from './glyph-box.ts'
import { DEFAULT_SVG_MAX_BYTES, assertSafeSvg } from './svg-annotate.ts'
import {
  LEADER_ROLE,
  quadCorners,
  scanSvg,
  textQuad,
} from './render-check-scan.ts'
import type { BoundsBox, DrawnSegment, Occluder, Point, Poly, Scan, ScannedText, Segment, SubPath } from './render-check-scan.ts'

/**
 * 复核发现的问题类别（稳定标识，供调用方分类）。
 *
 * `element-overlap` 与 `figure-hierarchy` 分别由本模块的包围盒判据与
 * `hierarchy-check.ts` 的声明层级判据产出，共用同一发现类型。
 */
export type RenderCheckKind =
  | 'text-crossed-by-line'
  | 'text-clearance'
  | 'centerline-covered'
  | 'hatch-orientation-collision'
  | 'element-overlap'
  | 'figure-hierarchy'
  | 'font-below-minimum'
  | 'ink-outside-canvas'
  | 'sheet-underfill'
  | 'not-measured'

/** 图面墨迹的包围盒（毫米，根坐标系）。 */
export type InkBounds = {
  /** 最小 X。 */
  readonly minX: number
  /** 最小 Y。 */
  readonly minY: number
  /** 最大 X。 */
  readonly maxX: number
  /** 最大 Y。 */
  readonly maxY: number
}

/** 一条复核发现。 */
export type RenderCheckFinding = {
  /** 问题类别。 */
  readonly check: RenderCheckKind
  /** 模型可见的一句话结论。 */
  readonly message: string
  /**
   * 提示级：报告但不当成图面缺陷阻断交付。
   *
   * 版面利用率属于这一类——阈值随图型与落版幅面变化，低于阈值只说明这张图
   * 可能「撑不满纸面」，不说明它画错了；断线、穿字、压叠才是缺陷。缺省为
   * 阻断级（undefined 即阻断）。
   */
  readonly advisory?: boolean
}

/** 复核报告：量测值 + 发现的问题。 */
export type RenderCheckReport = {
  /** 画布宽（毫米或用户单位）；根元素未声明时为 undefined。 */
  readonly widthMm?: number
  /** 画布高（毫米或用户单位）；根元素未声明时为 undefined。 */
  readonly heightMm?: number
  /** 文字元素数。 */
  readonly textCount: number
  /** 描边图形的线宽分布（毫米 → 元素数，跳过 `stroke: none` 的填充图元），升序。 */
  readonly strokeWidthMm: readonly { readonly widthMm: number; readonly count: number }[]
  /** 线段取向分布（0–180°，点划线/引线/剖面线一并统计），按线段数降序。 */
  readonly orientationDeg: readonly { readonly orientationDeg: number; readonly count: number }[]
  /** 最小字高（毫米，根坐标系下文字占位框的高；无文字时 undefined）。 */
  readonly minFontMm?: number
  /** 发现的问题（无问题为空数组）。 */
  readonly findings: readonly RenderCheckFinding[]
}

/** 相邻判定：两轮廓包围盒间隙不超过此值（毫米）视为相邻零件。 */
const ADJACENT_GAP_MM = 1
/** 相邻零件剖面线取向差下限（度）：小于它则两件难以区分。 */
const ADJACENT_ORIENTATION_LIMIT_DEG = 30
/**
 * 相邻零件剖面线间距比上限：两件的实测间距之比（大／小）不超过它即视为「间距相近」。
 * GB/T 4457.5 只说「间距不等」，未给数值；取 1.5 倍是因为低于此比例的两档疏密在缩印到
 * 三分之二后仍读作同一种密度。
 */
const ADJACENT_SPACING_RATIO_LIMIT = 1.5
/**
 * 剖面线间距量测的最小投影差（毫米）：小于它的相邻投影差是同一条线的重复片段
 * （虚线展开、共线拼接），不参与间距计算。
 */
const HATCH_SPACING_MIN_GAP_MM = 0.1
/**
 * 图元叠压判定的最小相交尺寸（毫米）：包围盒相交区在任一轴上不超过它，视为擦边接触
 * （相邻零件共边、轮廓恰好相接）而非叠压。
 */
const OVERLAP_MIN_MM = 0.2
/**
 * 标号净距默认值（毫米）：文字占位框外扩这么多之后仍与图元相交即报。
 *
 * 取 1.5 毫米的依据是实测案例：A6 案（浅土层供热管道防腐蚀阴极保护装置）自建的净距
 * 判据在同批图上抓出 3 处「标号贴图线」缺陷，而只判「线条压进字身」的判据一处未报；
 * 1.5 毫米约为 3.5 毫米字号下字身与图线之间可读空白的下限。
 */
const DEFAULT_TEXT_CLEARANCE_MM = 1.5
/**
 * 按图型分档的净距下限（毫米）。各图型按自己的合法排版间距取值：阈值只抓真正的
 * 贴靠与重叠，不把工具自己的正确输出判负。
 *
 * 实测（本机，2026-10-26，现有 fixture 与 WASM 渲染）：电路图 0.8、曲线图 1.0、
 * 时序图 0.8；Graphviz 图中，内嵌标号的流程图 4.9、状态图 2.3，而默认开引线标号的
 * 框图最小 0.6（标号本就贴在节点框外）。节点内标签 0.3–0.9、边标签与其自身的边
 * 同组，已由 {@link sameGroup} 豁免。故矢量图型取实测下界再减 0.1；内嵌标号的
 * Graphviz 图型取 1.5，引线标号/原始 DOT 取 0.5。`appearance_view` 是外部 SVG 片段，
 * 语义分组未知，本轮不判净距（穿字仍判）。
 */
export const RENDER_CLEARANCE_MM: Readonly<Record<string, number>> = {
  cross_section: 1.5,
  structure: 1.5,
  flowchart: 1.5,
  state_diagram: 1.5,
  block_diagram: 0.5,
  component_hierarchy: 0.5,
  raw_dot: 0.5,
  template: 0.5,
  circuit: 0.7,
  plot: 0.9,
  sequence_diagram: 0.7,
  appearance_view: 0,
}

/**
 * 图型对应的净距下限；未知图型返回 0（只判穿字）。
 * @param figureType - 生成或分析侧的图型名。
 * @returns 净距（毫米），0 表示不判净距。
 */
export function clearanceMmForFigure(figureType: string): number {
  return RENDER_CLEARANCE_MM[figureType] ?? 0
}
/** 判定线段同一位置时的坐标容差（毫米，遮挡切分用）。 */
const SPLIT_TOLERANCE = 1e-9
/** 点划线签名：短于此值的线段是「点」（毫米）。 */
const DOT_MAX_LENGTH_MM = 1
/** 点划线签名：长于此值的线段是「长划」（毫米）。 */
const DASH_MIN_LENGTH_MM = 3
/** 点划线签名下限：同一行至少这么多个「点」与「长划」才按点划线判定。 */
const DASH_DOT_MIN_DOTS = 3
const DASH_DOT_MIN_DASHES = 2
/** 点划线签名下限：整行跨度不得小于此值（毫米），排除零件轮廓的零碎短边。 */
const DASH_DOT_MIN_SPAN_MM = 20
/**
 * 点划线长划的长度上界（毫米）：标准中心线的长划约 8 毫米（本包 `dashDotSegments`
 * 即 8 毫米）。同一行合并后若出现更长的连续墨迹，说明该行另有压在点划线上的实线
 * ——这是「点划线被实线覆盖」的判据，而不是把点划线自己的间隔当成实线。
 */
const DASH_DOT_MAX_DASH_MM = 10
/** 行内可见间隙下限（毫米）：整行合并后无此宽度的空隙即视为「间隔不可见」。 */
const VISIBLE_GAP_MM = 1
/** 同一直线上的坐标容差（毫米）。 */
const AXIS_TOLERANCE_MM = 0.05
/** 判定两条轮廓互为镜像的顶点坐标容差（毫米）。 */
const MIRROR_TOLERANCE_MM = 0.01
/**
 * 剖面线判定的最少平行线段数：零件内至少要这么多条同取向的线才算打了剖面线。
 * 取这些线是为了把「零件内的偶发线条」（电气符号的笔画、穿过零件的走线）排除在取向
 * 比较之外——它们的取向由符号画法决定，与剖面线无关。
 */
const HATCH_MIN_LINES = 3
/** SVG 未声明 `stroke-width` 时的初值（用户单位）。 */
/** 二维点（用户单位）。 */


/** 读取标签属性（第一个匹配的 `name="…"`）。 */
function subpathSegments(subpath: SubPath): Segment[] {
  const segments: Segment[] = []
  for (let index = 0; index + 1 < subpath.points.length; index += 1) {
    const from = subpath.points[index] as Point
    const to = subpath.points[index + 1] as Point
    segments.push({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] })
  }
  if (subpath.closed) {
    const first = subpath.points[0] as Point
    const last = subpath.points[subpath.points.length - 1] as Point
    segments.push({ x1: last[0], y1: last[1], x2: first[0], y2: first[1] })
  }
  return segments
}

/** 线段长度。 */
function length(segment: Segment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
}

/** 线段取向归一化到 [0, 180)。 */
function orientation(segment: Segment): number {
  const degrees = (Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1) * 180) / Math.PI
  return ((degrees % 180) + 180) % 180
}

/** 包围盒。 */
/**
 * Axis-aligned bounding box of a point set.
 * @param points - polygon vertices in the same coordinate system.
 * @returns the bounding box.
 */
export function polyBounds(points: Poly): BoundsBox {
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/** 点是否在多边形内（even-odd 射线法）。 */
function insidePolygon(point: Point, points: Poly): boolean {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const a = points[index] as Point
    const b = points[previous] as Point
    if ((a[1] > point[1]) === (b[1] > point[1])) continue
    const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    if (point[0] < x) inside = !inside
  }
  return inside
}

/**
 * 线段与遮挡面的交点参数：`t` 落在线段内、`u` 落在遮挡边内时才计入。
 * @param segment - 线段。
 * @param from - 遮挡边起点。
 * @param to - 遮挡边终点。
 * @returns 交点参数 `t`；不相交或平行时为 undefined。
 */
function crossingParameter(segment: Segment, from: Point, to: Point): number | undefined {
  const segmentX = segment.x2 - segment.x1
  const segmentY = segment.y2 - segment.y1
  const edgeX = to[0] - from[0]
  const edgeY = to[1] - from[1]
  const determinant = segmentX * edgeY - segmentY * edgeX
  if (determinant === 0) return undefined
  const offsetX = from[0] - segment.x1
  const offsetY = from[1] - segment.y1
  const t = (offsetX * edgeY - offsetY * edgeX) / determinant
  const u = (offsetX * segmentY - offsetY * segmentX) / determinant
  if (t <= 0 || t >= 1 || u < 0 || u > 1) return undefined
  return t
}

/**
 * 线段在图面上可见的部分：被遮挡面（更晚绘制的不透明填充）盖住的段不可见，不参与文字判定。
 *
 * 沿与遮挡面各边的交点把线段切开，逐段取中点判定是否落在某个遮挡面内——直线段的
 * 「在面内／面外」只会在与边界相交处改变，故按交点切分即得精确结果（凹多边形同样成立）。
 * 没有更晚绘制的遮挡面时原样返回（本包两条绘制通路都不写填充，故缺省零开销）。
 * @param drawn - 线段及其文档序。
 * @param occluders - 遮挡面（闭合轮廓 + 文档序）。
 * @returns 可见片段（至少……切分后可能为空数组）。
 */
function visiblePieces(drawn: DrawnSegment, occluders: readonly Occluder[]): readonly Segment[] {
  const covers = occluders.filter(occluder => occluder.order > drawn.order)
  if (covers.length === 0) return [drawn.segment]
  const { segment } = drawn
  const cuts: number[] = []
  for (const occluder of covers) {
    for (let index = 0; index < occluder.points.length; index += 1) {
      const from = occluder.points[index] as Point
      const to = occluder.points[(index + 1) % occluder.points.length] as Point
      const t = crossingParameter(segment, from, to)
      if (t !== undefined && !cuts.some(value => Math.abs(value - t) <= SPLIT_TOLERANCE)) cuts.push(t)
    }
  }
  const stops = [0, ...cuts.sort((left, right) => left - right), 1]
  const pieces: Segment[] = []
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index] as number
    const to = stops[index + 1] as number
    const at = (t: number): Point => [
      segment.x1 + (segment.x2 - segment.x1) * t,
      segment.y1 + (segment.y2 - segment.y1) * t,
    ]
    const middle = at((from + to) / 2)
    if (covers.some(occluder => insidePolygon(middle, occluder.points))) continue
    const start = at(from)
    const end = at(to)
    pieces.push({ x1: start[0], y1: start[1], x2: end[0], y2: end[1] })
  }
  return pieces
}

/** 点到线段的最短距离（毫米）。 */
function pointSegmentDistance(point: Point, segment: Segment): number {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point[0] - segment.x1) * dx + (point[1] - segment.y1) * dy) / lengthSquared))
  return Math.hypot(point[0] - (segment.x1 + dx * t), point[1] - (segment.y1 + dy * t))
}

/** 点在有向直线 `from→to` 的哪一侧（叉积符号）。 */
function sideOf(from: Point, to: Point, point: Point): number {
  return (to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0])
}

/** 点是否落在线段上（共线且落在两端之间）。 */
function onSegment(point: Point, segment: Segment): boolean {
  return sideOf([segment.x1, segment.y1], [segment.x2, segment.y2], point) === 0
    && point[0] >= Math.min(segment.x1, segment.x2) && point[0] <= Math.max(segment.x1, segment.x2)
    && point[1] >= Math.min(segment.y1, segment.y2) && point[1] <= Math.max(segment.y1, segment.y2)
}

/** 两线段是否相交（含端点接触与共线重叠）。 */
function segmentsIntersect(a: Segment, b: Segment): boolean {
  const a1: Point = [a.x1, a.y1]
  const a2: Point = [a.x2, a.y2]
  const b1: Point = [b.x1, b.y1]
  const b2: Point = [b.x2, b.y2]
  const d1 = sideOf(a1, a2, b1)
  const d2 = sideOf(a1, a2, b2)
  const d3 = sideOf(b1, b2, a1)
  const d4 = sideOf(b1, b2, a2)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return onSegment(b1, a) || onSegment(b2, a) || onSegment(a1, b) || onSegment(a2, b)
}

/** 两线段的最短距离（毫米）：相交为 0，否则取四个端点到对侧线段的最短距离。 */
function segmentDistance(a: Segment, b: Segment): number {
  if (segmentsIntersect(a, b)) return 0
  return Math.min(
    pointSegmentDistance([a.x1, a.y1], b),
    pointSegmentDistance([a.x2, a.y2], b),
    pointSegmentDistance([b.x1, b.y1], a),
    pointSegmentDistance([b.x2, b.y2], a),
  )
}

/** 文字与其线段是否属于同一语义分组（同一 `<g class="node|edge">`）。 */
function sameGroup(text: ScannedText, item: DrawnSegment): boolean {
  return text.group !== undefined && item.group !== undefined && text.group.id === item.group.id
}

/** 仿射矩形到线段的最短距离（毫米）：取四条边各自到该线段的最短距离。 */
function quadSegmentDistance(quad: GlyphQuad, segment: Segment): number {
  const corners = quadCorners(quad)
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index] as Point
    const to = corners[(index + 1) % corners.length] as Point
    best = Math.min(best, segmentDistance({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] }, segment))
  }
  return best
}

/**
 * 文字与图线的净距不足：占位框外扩 `clearanceMm` 后仍与图元线段相交即报，并给出两者
 * 的实测最短距离（毫米，一位小数）。
 *
 * 不参与判定的两类线段：**引线**（绘图侧标注 {@link ROLE_ATTRIBUTE}——引线本来就止于
 * 文字外框，把它算进来等于判工具自己画的每条引线都不合格）；**被遮挡面盖住的线段**
 * （更晚绘制的不透明填充之下，图面上看不见，见 {@link visiblePieces}）。
 *
 * 已被判为 `text-crossed-by-line` 的文字不再另报净距：线条压进字身时净距必然不足，
 * 重复报同一条缺陷只会淹没真正需要处理的那条。
 * @param texts - 图面上的文字。
 * @param drawn - 图元线段及其来源。
 * @param occluders - 遮挡面。
 * @param clearanceMm - 净距（毫米）；不大于 0 时不判。
 * @param crossed - 已判为被线条贯穿的文字下标集合。
 * @returns 发现的问题。
 */
function textClearanceFindings(
  texts: readonly ScannedText[],
  drawn: readonly DrawnSegment[],
  occluders: readonly Occluder[],
  clearanceMm: number,
  crossed: ReadonlySet<number>,
): RenderCheckFinding[] {
  if (!(clearanceMm > 0)) return []
  const findings: RenderCheckFinding[] = []
  texts.forEach((text, index) => {
    if (crossed.has(index)) return
    const quad = textQuad(text)
    const inflated = inflateQuad(quad, clearanceMm)
    let nearest = Number.POSITIVE_INFINITY
    for (const item of drawn) {
      if (item.leader) continue
      // 同组文字与线段是同一语义元素的两个部分：节点标签本就排在节点框内
      // （实测距框 0.3–0.9 毫米），边标签本就贴着它自己的边。把这类排版贴靠
      // 判成净距不足会让每张 Graphviz 图都恒报。
      if (sameGroup(text, item)) continue
      for (const piece of visiblePieces(item, occluders)) {
        if (!quadCrossedBySegment(inflated, [piece.x1, piece.y1], [piece.x2, piece.y2])) continue
        nearest = Math.min(nearest, quadSegmentDistance(quad, piece))
      }
    }
    if (!Number.isFinite(nearest)) return
    findings.push({
      check: 'text-clearance',
      message: `图面文字「${text.content}」距最近的图线仅 ${String(Math.round(nearest * 10) / 10)} 毫米，不足 ${String(clearanceMm)} 毫米净距：`
        + '标号与元件名周围要留出可读的空白，不与零件轮廓、剖面线或中心线贴靠',
    })
  })
  return findings
}

/**
 * 两多边形是否为镜像（关于某条水平线或竖直线对称，且尺寸相同）：同一零件的上下或
 * 左右两半用同一剖面线取向，不应被判成「相邻零件取向过近」。
 *
 * 对称轴必须落在两个包围盒的**外边界**上（两半沿轴相接），否则会把并排的两个相同
 * 矩形误认成镜像（矩形关于自身中线也是对称的）。
 * @param a - 多边形 A 的顶点。
 * @param b - 多边形 B 的顶点。
 * @returns 互为镜像时 true。
 */
function isMirrorPair(a: Poly, b: Poly): boolean {
  if (a.length !== b.length) return false
  const key = (points: Poly): string => points
    .map(point => `${String(Math.round(point[0] * 1000))}:${String(Math.round(point[1] * 1000))}`)
    .sort()
    .join('|')
  const boxA = polyBounds(a)
  const boxB = polyBounds(b)
  const sameSize = Math.abs((boxA.maxX - boxA.minX) - (boxB.maxX - boxB.minX)) <= MIRROR_TOLERANCE_MM
    && Math.abs((boxA.maxY - boxA.minY) - (boxB.maxY - boxB.minY)) <= MIRROR_TOLERANCE_MM
  if (!sameSize) return false
  /** 对称轴是否落在两盒之外（允许贴边）：落在盒内说明是同一侧的图形。 */
  const axisOutside = (axis: number, from: number, to: number): boolean =>
    axis <= from + MIRROR_TOLERANCE_MM || axis >= to - MIRROR_TOLERANCE_MM
  const horizontalAxis = (boxA.minY + boxA.maxY + boxB.minY + boxB.maxY) / 4
  if (axisOutside(horizontalAxis, boxA.minY, boxA.maxY) && axisOutside(horizontalAxis, boxB.minY, boxB.maxY)) {
    const reflected = b.map(point => [point[0], 2 * horizontalAxis - point[1]] as const)
    if (key(reflected) === key(a)) return true
  }
  const verticalAxis = (boxA.minX + boxA.maxX + boxB.minX + boxB.maxX) / 4
  if (axisOutside(verticalAxis, boxA.minX, boxA.maxX) && axisOutside(verticalAxis, boxB.minX, boxB.maxX)) {
    const reflected = b.map(point => [2 * verticalAxis - point[0], point[1]] as const)
    if (key(reflected) === key(a)) return true
  }
  return false
}

/**
 * 一个零件内剖面线的可辨别特征：取向（0.1° 分桶里重复最多的一条）与同取向平行线的
 * 相邻间距；没有任何取向达到 {@link HATCH_MIN_LINES} 条时 undefined（该零件没有剖面线）。
 * @param segments - 归入该零件的线段。
 * @returns 剖面线取向与间距；无剖面线时 undefined。
 */
function hatchSignature(
  segments: readonly Segment[],
): { readonly orientationDeg: number; readonly spacingMm: number | undefined } | undefined {
  const counts = new Map<number, number>()
  for (const segment of segments) {
    const key = Math.round(orientation(segment) * 10) / 10
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: number | undefined
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  if (best === undefined || bestCount < HATCH_MIN_LINES) return undefined
  return { orientationDeg: best, spacingMm: hatchSpacing(segments, best) }
}

/**
 * 同取向剖面线的相邻间距（毫米）：把各线段中点投影到该取向的法线上排序，取**升序**相邻
 * 投影差的中位数（小于 {@link HATCH_SPACING_MIN_GAP_MM} 的差是同一条线的重复片段，跳过）。
 * 线段被轮廓裁短后中点仍落在自己那条线上，投影位置不受裁切影响；中位数对个别落单的线段
 * 稳健，等距剖面线上它与逐段间距同值。
 * @param segments - 归入该零件的线段。
 * @param orientationDeg - 剖面线取向（度），取自 {@link hatchSignature} 的众数分桶。
 * @returns 间距（毫米）；同取向线段不足两条或投影位置全部重合时 undefined。
 */
function hatchSpacing(segments: readonly Segment[], orientationDeg: number): number | undefined {
  const radians = (orientationDeg * Math.PI) / 180
  const normalX = -Math.sin(radians)
  const normalY = Math.cos(radians)
  const offsets = segments
    .filter(segment => Math.round(orientation(segment) * 10) / 10 === orientationDeg)
    .map(segment => ((segment.x1 + segment.x2) / 2) * normalX + ((segment.y1 + segment.y2) / 2) * normalY)
    .sort((left, right) => left - right)
  const gaps = offsets
    .slice(1)
    .map((offset, index) => offset - (offsets[index] as number))
    .filter(gap => gap >= HATCH_SPACING_MIN_GAP_MM)
    .sort((left, right) => left - right)
  if (gaps.length === 0) return undefined
  const half = Math.floor(gaps.length / 2)
  const middle = gaps.slice(gaps.length % 2 === 1 ? half : half - 1, half + 1)
  return middle.reduce((sum, gap) => sum + gap, 0) / middle.length
}

/**
 * 两件的剖面线间距是否分不清：任一侧量不出间距时无法证明可区分，按分不清处理
 * （本判据只放宽、不收紧）。
 * @param left - 左件间距（毫米）；undefined 表示量不出。
 * @param right - 右件间距（毫米）；undefined 表示量不出。
 * @returns 间距相近时为 true。
 */
function spacingIndistinguishable(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return true
  return Math.max(left, right) / Math.min(left, right) <= ADJACENT_SPACING_RATIO_LIMIT
}

/** 轴对齐分组：同一行/列的线段集合（用于点划线覆盖判定）。 */
type AxisGroup = { readonly axis: 'x' | 'y'; readonly line: number; readonly segments: readonly Segment[] }

/** 按轴分组：同一坐标（容差 {@link AXIS_TOLERANCE_MM}）上的水平或竖直线段归为一组。 */
function intervalsByAxis(segments: readonly Segment[]): AxisGroup[] {
  const groups = new Map<string, { axis: 'x' | 'y'; line: number; segments: Segment[] }>()
  for (const segment of segments) {
    const horizontal = Math.abs(segment.y2 - segment.y1) <= AXIS_TOLERANCE_MM
    const vertical = Math.abs(segment.x2 - segment.x1) <= AXIS_TOLERANCE_MM
    if (!horizontal && !vertical) continue
    const axis: 'x' | 'y' = horizontal ? 'x' : 'y'
    const line = horizontal ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2
    const key = `${axis}@${String(Math.round(line * 20) / 20)}`
    const group = groups.get(key) ?? { axis, line, segments: [] }
    group.segments.push(segment)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** 合并区间并按坐标排序。 */
function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range[0] <= last[1] + AXIS_TOLERANCE_MM) {
      last[1] = Math.max(last[1], range[1])
      continue
    }
    merged.push([range[0], range[1]])
  }
  return merged
}

/**
 * 把一个线段按虚线段长切成「画」出的片段（间隔不产出线段）。
 *
 * 相位自线段起点起算：SVG 的虚线段沿子路径连续推进、由 `stroke-dashoffset` 起相，本模块
 * 对每段各自起算作近似——片段只用于点划线签名与覆盖判定，不用于坐标断言。
 * @param segment - 线段（毫米）。
 * @param patternMm - 虚线段长（毫米，画/空交替）。
 * @returns 画出的片段。
 */
function dashSegments(segment: Segment, patternMm: readonly number[]): Segment[] {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const total = Math.hypot(dx, dy)
  if (total === 0) return []
  const unit: Point = [dx / total, dy / total]
  const at = (distance: number): Point => [segment.x1 + unit[0] * distance, segment.y1 + unit[1] * distance]
  const pieces: Segment[] = []
  let cursor = 0
  let index = 0
  while (cursor < total) {
    const end = Math.min(cursor + (patternMm[index % patternMm.length] as number), total)
    if (index % 2 === 0 && end > cursor) {
      const from = at(cursor)
      const to = at(end)
      pieces.push({ x1: from[0], y1: from[1], x2: to[0], y2: to[1] })
    }
    cursor = end
    index += 1
  }
  return pieces
}

/**
 * 点划线被实线覆盖：同一行（或列）既有点划签名（≥{@link DASH_DOT_MIN_DOTS} 个「点」与
 * ≥{@link DASH_DOT_MIN_DASHES} 个「长划」，整行跨度 ≥{@link DASH_DOT_MIN_SPAN_MM}），
 * 合并后没有 {@link VISIBLE_GAP_MM} 宽的可见空隙，且其中有一段长于
 * {@link DASH_DOT_MAX_DASH_MM} 的连续墨迹——点划线自己的长划不会那么长，故只可能来自
 * 压在同一位置的实线（上下两半剖的公共边正是如此）。
 *
 * 只按「间隔不可见」判定会把点划线自身间隔很小的图也报成实线覆盖，故必须有那段超长连续
 * 墨迹作依据；`stroke-dasharray` 画出的点划线已按虚线段展开（{@link dashSegments}），
 * 否则整条虚线只是一条长线段，签名与覆盖都看不出来。
 * @param pieces - 全部线段量测片段（虚线元素已展开成虚线段）。
 * @returns 发现的问题。
 */
function coveredCenterlines(pieces: readonly Segment[]): RenderCheckFinding[] {
  const findings: RenderCheckFinding[] = []
  for (const group of intervalsByAxis(pieces)) {
    const lengths = group.segments.map(length)
    const dots = lengths.filter(value => value <= DOT_MAX_LENGTH_MM).length
    const dashes = lengths.filter(value => value >= DASH_MIN_LENGTH_MM).length
    if (dots < DASH_DOT_MIN_DOTS || dashes < DASH_DOT_MIN_DASHES) continue
    const ranges = group.segments.map(segment => (group.axis === 'x'
      ? [Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2)] as const
      : [Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)] as const))
    const merged = mergeRanges(ranges)
    const span = (merged[merged.length - 1] as [number, number])[1] - (merged[0] as [number, number])[0]
    if (span < DASH_DOT_MIN_SPAN_MM) continue
    const gaps = merged.slice(1).map((range, index) => range[0] - (merged[index] as [number, number])[1])
    // 合并后只剩一段 = 整行没有可见空隙：点与长划被实线连成一条线。
    const largestGap = gaps.length === 0 ? 0 : Math.max(...gaps)
    if (largestGap >= VISIBLE_GAP_MM) continue
    const longestRun = Math.max(...merged.map(range => range[1] - range[0]))
    if (longestRun < DASH_DOT_MAX_DASH_MM) continue
    findings.push({
      check: 'centerline-covered',
      message: `图面 ${group.axis === 'x' ? `y=${String(group.line)}` : `x=${String(group.line)}`} 处的点划线被同位置的实线覆盖`
        + `（该行有一段 ${String(Math.round(longestRun * 10) / 10)} 毫米的连续墨迹、间隔不可见）：`
        + '该行另有压在同一位置的实线边（例如上下两半剖的公共边），请改为一条闭合轮廓并只画中心线',
    })
  }
  return findings
}

/**
 * 相邻零件剖面线难以区分：按「线段中点落在哪个多边形内」把剖面线归到零件，再对
 * 相邻（间隙 ≤ {@link ADJACENT_GAP_MM}）且非镜像对的多边形比较取向差与间距。只有两侧
 * 都真的带剖面线（{@link hatchSignature} 判定）时才比较，且**方向与间距都分不清**才报：
 * GB/T 4457.5 的判据是「方向相反或间距不等」，两项有一项可区分即不报。
 *
 * 带同一分组号（{@link HATCH_GROUP_ATTRIBUTE}）的两个轮廓是同一材料的几段，不比较：
 * 输入约定就是「同一零件的多个轮廓各给一段」，按轮廓比较必然把它们报成相邻两件。
 * @param outlines - 闭合轮廓。
 * @param segments - 线段（开放子路径：剖面线、引线、中心线；轮廓边不入内）。
 * @param groups - 与 `outlines` 一一对应的分组号；undefined 表示该轮廓自成一组。
 * @returns 发现的问题。
 */
function hatchCollisions(
  outlines: readonly Poly[],
  segments: readonly Segment[],
  groups: readonly (number | undefined)[],
): RenderCheckFinding[] {
  const byPoly = new Map<number, Segment[]>()
  segments.forEach((segment) => {
    const midpoint: Point = [(segment.x1 + segment.x2) / 2, (segment.y1 + segment.y2) / 2]
    outlines.forEach((poly, index) => {
      if (!insidePolygon(midpoint, poly)) return
      const bucket = byPoly.get(index)
      if (bucket === undefined) byPoly.set(index, [segment])
      else bucket.push(segment)
    })
  })
  const findings: RenderCheckFinding[] = []
  const spacingText = (mm: number | undefined): string =>
    mm === undefined ? '间距未测出' : `间距 ${String(Math.round(mm * 10) / 10)} 毫米`
  for (let left = 0; left < outlines.length; left += 1) {
    for (let right = left + 1; right < outlines.length; right += 1) {
      const group = groups[left]
      if (group !== undefined && group === groups[right]) continue
      const a = outlines[left] as Poly
      const b = outlines[right] as Poly
      const boxA = polyBounds(a)
      const boxB = polyBounds(b)
      const gap = Math.max(
        Math.max(boxA.minX, boxB.minX) - Math.min(boxA.maxX, boxB.maxX),
        Math.max(boxA.minY, boxB.minY) - Math.min(boxA.maxY, boxB.maxY),
      )
      if (gap > ADJACENT_GAP_MM) continue
      if (isMirrorPair(a, b)) continue
      const hatchA = hatchSignature(byPoly.get(left) ?? [])
      const hatchB = hatchSignature(byPoly.get(right) ?? [])
      if (hatchA === undefined || hatchB === undefined) continue
      const difference = Math.abs(hatchA.orientationDeg - hatchB.orientationDeg)
      const visual = Math.min(difference, 180 - difference)
      if (visual > ADJACENT_ORIENTATION_LIMIT_DEG) continue
      if (!spacingIndistinguishable(hatchA.spacingMm, hatchB.spacingMm)) continue
      findings.push({
        check: 'hatch-orientation-collision',
        message: `相邻零件 #${String(left + 1)}（${String(hatchA.orientationDeg)}°／${spacingText(hatchA.spacingMm)}）`
          + `与 #${String(right + 1)}（${String(hatchB.orientationDeg)}°／${spacingText(hatchB.spacingMm)}）的剖面线方向仅差 ${String(Math.round(visual * 10) / 10)}°、间距也相近：`
          + '相邻零件的剖面线应方向相反或间距不等（GB/T 4457.5），否则读成一个零件',
      })
    }
  }
  return findings
}

/**
 * 严格包含：`outer` 的包围盒含住 `inner` 且至少一轴真的更大。
 * 只在「有意嵌套」的排除上要求严格：两个完全重合的轮廓不是嵌套，是同一图元画了两遍。
 * @param outer - 外层包围盒。
 * @param inner - 内层包围盒。
 * @returns 是否严格包含。
 */
function strictlyContains(outer: BoundsBox, inner: BoundsBox): boolean {
  const contains = outer.minX <= inner.minX && outer.maxX >= inner.maxX
    && outer.minY <= inner.minY && outer.maxY >= inner.maxY
  if (!contains) return false
  return outer.minX < inner.minX || outer.maxX > inner.maxX || outer.minY < inner.minY || outer.maxY > inner.maxY
}

/**
 * 两个图元叠压：闭合轮廓的包围盒部分相交——相交区两轴都不小于 {@link OVERLAP_MIN_MM}，
 * 且任一方的包围盒都不严格包含另一方。
 *
 * 用包围盒而不是轮廓本身：包围盒相交是「同一块图面被两个图元占用」的最小证据，也正是人工
 * 复核时按 SVG 坐标算的判据；包围盒已相交的两个图元在图上一定互相叠压。只擦边接触（相邻
 * 零件共边）与有意嵌套（型腔内画零件、模块内画子模块）都不报，后者是包含关系。
 *
 * 带同一 {@link HATCH_GROUP_ATTRIBUTE} 分组号的轮廓是同一材料的几段（输入约定即「同一
 * 零件的多个轮廓各给一段」），不互相判叠压。
 *
 * 两侧都不是描边图元（`stroke: none` 的纯填充）时也不判：纯填充图的轮廓不是画出来的线，
 * 两个实心色块叠放是「后来的盖住先前的」——把实心标记、符号画在已有着色区域上正是这样
 * 做的；本判据针对的是两条**画出来的**轮廓线占用同一块图面。文字转路径后的字形轮廓正是
 * 纯填充路径（Inkscape `--export-text-to-path` 的产物不带 `stroke`），若不排除，同一行
 * 的数字会互相报成叠压。
 * @param outlines - 闭合轮廓（按文档序）。
 * @param groups - 与 `outlines` 一一对应的材料分组号；undefined 表示该轮廓自成一组。
 * @param stroked - 与 `outlines` 一一对应的描边标记。
 * @returns 发现的问题。
 */
function outlineOverlaps(
  outlines: readonly Poly[],
  groups: readonly (number | undefined)[],
  stroked: readonly boolean[],
): RenderCheckFinding[] {
  const boxes = outlines.map(polyBounds)
  const round = (value: number): string => String(Math.round(value * 10) / 10)
  const findings: RenderCheckFinding[] = []
  for (let left = 0; left < outlines.length; left += 1) {
    for (let right = left + 1; right < outlines.length; right += 1) {
      const group = groups[left]
      if (group !== undefined && group === groups[right]) continue
      if (stroked[left] !== true && stroked[right] !== true) continue
      const a = boxes[left] as BoundsBox
      const b = boxes[right] as BoundsBox
      const minX = Math.max(a.minX, b.minX)
      const maxX = Math.min(a.maxX, b.maxX)
      const minY = Math.max(a.minY, b.minY)
      const maxY = Math.min(a.maxY, b.maxY)
      if (maxX - minX <= OVERLAP_MIN_MM || maxY - minY <= OVERLAP_MIN_MM) continue
      if (strictlyContains(a, b) || strictlyContains(b, a)) continue
      findings.push({
        check: 'element-overlap',
        message: `图元 #${String(left + 1)} 与 #${String(right + 1)} 叠压：两个闭合轮廓的包围盒相交 ${round(maxX - minX)}×${round(maxY - minY)} 毫米`
          + `（相交区 x ${round(minX)}–${round(maxX)}／y ${round(minY)}–${round(maxY)}）：`
          + '同一块图面被两个图元占用，其中一个的位置或尺寸有误，或该处本不该有第二个图元；有意嵌套应改为包含关系',
      })
    }
  }
  return findings
}

/**
 * 字高低于下限的发现：法条只要求「缩小到三分之二时仍能清晰地分辨」（审查指南第一部分第一章
 * 4.3），下限本身是本部署的内控口径，由调用方给出毫米数。低于下限的文字逐处列出，模型据此
 * 调大字号或减少图面内容，不必靠反复出图试字号。
 * @param texts - 文字元素（按文档序）。
 * @param heightsMm - 与 `texts` 一一对应的字高（毫米）。
 * @param floorMm - 字高下限（毫米）；undefined 表示不判该判据。
 * @returns 发现的问题；无低于下限的文字时为 undefined。
 */
function fontBelowMinimum(
  texts: readonly ScannedText[],
  heightsMm: readonly number[],
  floorMm: number | undefined,
): RenderCheckFinding | undefined {
  if (floorMm === undefined) return undefined
  const offenders = texts
    .map((text, index) => ({ content: text.content, mm: heightsMm[index] as number }))
    .filter(item => item.mm < floorMm)
  if (offenders.length === 0) return undefined
  const shown = offenders.slice(0, 4).map(item => `「${item.content}」${String(item.mm)} 毫米`).join('、')
  return {
    check: 'font-below-minimum',
    message: `${String(offenders.length)} 处图面文字的字高低于 ${String(floorMm)} 毫米（最小 ${String(Math.min(...offenders.map(item => item.mm)))} 毫米）：${shown}`
      + `${offenders.length > 4 ? ' 等' : ''}。下限是本部署的内控口径（法条只要求缩小到三分之二仍能分辨）：调大字号或减少图面内容后重出`,
  }
}

/**
 * 图面墨迹的包围盒：全部子路径顶点与文字占位框四角的并集。
 * @param scan - 遍历结果。
 * @returns 墨迹包围盒；没有可量测图元时 undefined。
 */
function inkBounds(scan: Scan): InkBounds | undefined {
  const points: Point[] = [
    ...scan.shapes.flatMap(shape => shape.subpaths.flatMap(subpath => subpath.points)),
    ...scan.texts.flatMap(text => [...quadCorners(textQuad(text))]),
  ]
  return points.length === 0 ? undefined : polyBounds(points)
}

/**
 * 墨迹越出画布：全部子路径顶点与文字占位框四角中，有落在 [0, 画布] 之外的（容差
 * {@link AXIS_TOLERANCE_MM}）。根元素未声明两个尺寸时不做此判定。
 * @param scan - 遍历结果。
 * @returns 发现的问题；无法判定时 undefined。
 */
function inkOutsideCanvas(scan: Scan): RenderCheckFinding | undefined {
  const { widthMm, heightMm } = scan
  if (widthMm === undefined || heightMm === undefined) return undefined
  const ink = inkBounds(scan)
  if (ink === undefined) return undefined
  if (ink.minX >= -AXIS_TOLERANCE_MM && ink.minY >= -AXIS_TOLERANCE_MM
    && ink.maxX <= widthMm + AXIS_TOLERANCE_MM && ink.maxY <= heightMm + AXIS_TOLERANCE_MM) return undefined
  return {
    check: 'ink-outside-canvas',
    message: `图面内容越出画布 ${String(widthMm)}×${String(heightMm)}：墨迹范围 (${String(ink.minX)}, ${String(ink.minY)})-(${String(ink.maxX)}, ${String(ink.maxY)})；越界部分不会渲染出来`,
  }
}

/**
 * 量测一张 SVG 的墨迹包围盒（毫米，根坐标系）：全部子路径顶点与文字占位框的并集。
 *
 * 供「转换/改写后几何是否走样」的护栏使用（文字转轮廓路径后墨迹必须仍落在原范围内）；
 * 与 {@link checkFigureRendering} 共用同一遍历，故两处口径一致。
 * @param svg - 完整 SVG 文本。
 * @param options - 安全校验上限（字节）；缺省沿用 {@link DEFAULT_SVG_MAX_BYTES}。
 * @returns 墨迹包围盒；没有可量测图元时 undefined。
 * @throws SvgAnnotateError 输入未通过 {@link assertSafeSvg} 时。
 */
export function measureInkBounds(svg: string, options: { maxBytes?: number } = {}): InkBounds | undefined {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES)
  return inkBounds(scanSvg(svg))
}

/**
 * 阻断级发现：除 `not-measured` 与提示级（`advisory`）以外的全部 findings。
 * `not-measured` 是诚实降级（声明哪些事实没量测），提示级是随图型与幅面变化的
 * 软指标；两者都不是图面缺陷，不阻断交付。
 * @param report - 复核报告。
 * @returns 应阻断交付的发现。
 */
export function blockingFindings(report: RenderCheckReport): RenderCheckFinding[] {
  return report.findings.filter(finding => finding.check !== 'not-measured' && finding.advisory !== true)
}

/**
 * 量测一张已生成的附图并报告渲染层面才可见的问题。
 *
 * 元素按嵌套逐层继承变换与样式（见模块文档的量测范围）；凡不在范围内的结构，报告
 * `not-measured` 而不是略过。本模块只读文本、不解析实体也不执行任何内容，输入仍过
 * {@link assertSafeSvg} 的实体/CDATA、体量与根元素检查，被拒时抛出。
 *
 * 同一材料的多个轮廓靠绘图侧写的 {@link HATCH_GROUP_ATTRIBUTE} 识别：带同一分组号的
 * 轮廓不互相比较剖面线取向（见 {@link hatchCollisions}）。没有该标注时每个闭合轮廓
 * 各自成组，与标注存在前的判定一致。
 * @param svg - 完整 SVG 文本。
 * @param options - 安全校验上限（字节）；`textClearanceMm` 为标号净距（毫米，默认
 * {@link DEFAULT_TEXT_CLEARANCE_MM}，`0` 关闭该判据）；`minSheetFillRatio` 为版面
 * 利用率下限（0–1，省略或 `0` 关闭该判据，命中只报提示级发现）。
 * @returns 量测值与发现的问题。
 * @throws SvgAnnotateError 输入未通过 {@link assertSafeSvg} 时。
 */
export function checkFigureRendering(
  svg: string,
  options: {
    maxBytes?: number
    textClearanceMm?: number
    minFontMm?: number
    minSheetFillRatio?: number
  } = {},
): RenderCheckReport {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES)
  const scan = scanSvg(svg)
  const outlines: Poly[] = []
  const outlineGroups: (number | undefined)[] = []
  const outlineStroked: boolean[] = []
  const openSegments: Segment[] = []
  const drawn: DrawnSegment[] = []
  const occluders: Occluder[] = []
  // 点划线判定用的片段：虚线元素按虚线段展开，其余按整段——`stroke-dasharray` 画出的
  // 中心线不展开就只是一条长线段，点划签名与「被实线覆盖」都看不出来。
  const pieces: Segment[] = []
  for (const shape of scan.shapes) {
    for (const subpath of shape.subpaths) {
      const segments = subpathSegments(subpath)
      drawn.push(...segments.map(segment => ({
        segment,
        order: shape.order,
        leader: shape.role === LEADER_ROLE,
        ...(shape.group === undefined ? {} : { group: shape.group }),
      })))
      // 不透明填充的闭合轮廓遮挡更早绘制的图元；开放子路径的填充按闭合处理，故不列入。
      if (shape.occludes && subpath.closed) occluders.push({ points: subpath.points, order: shape.order })
      if (subpath.closed) {
        outlines.push(subpath.points)
        outlineGroups.push(shape.hatchGroup)
        outlineStroked.push(shape.stroked)
      } else openSegments.push(...segments)
      for (const segment of segments) {
        if (shape.dashPatternMm === undefined) pieces.push(segment)
        else pieces.push(...dashSegments(segment, shape.dashPatternMm))
      }
    }
  }

  const findings: RenderCheckFinding[] = []
  if (scan.unmeasured.length > 0) {
    findings.push({
      check: 'not-measured',
      message: `以下事实未量测或只作近似：${scan.unmeasured.join('；')}。这些范围内的缺陷不会出现在本报告里，近似项为估计值`,
    })
  }
  const crossed = new Set<number>()
  scan.texts.forEach((text, index) => {
    const quad = textQuad(text)
    // 边标签与它自己的边同组：Graphviz 把边标签放在边旁，二者共用一段文字框，
    // 这不是「标签压到别的线」的缺陷。跨组仍判——那才是真正的压线。
    const hit = drawn.some(item => !(sameGroup(text, item) && item.group?.kind === 'edge')
      && visiblePieces(item, occluders)
        .some(piece => quadCrossedBySegment(quad, [piece.x1, piece.y1], [piece.x2, piece.y2])))
    if (!hit) return
    crossed.add(index)
    findings.push({
      check: 'text-crossed-by-line',
      message: `图面文字「${text.content}」被线条贯穿：引线或轮廓线穿过了文字外框；文字应落在零件轮廓或元件符号之外，引线应止于文字外框之外`,
    })
  })
  findings.push(...textClearanceFindings(
    scan.texts,
    drawn,
    occluders,
    options.textClearanceMm ?? DEFAULT_TEXT_CLEARANCE_MM,
    crossed,
  ))
  findings.push(...coveredCenterlines(pieces))
  const ink = inkOutsideCanvas(scan)
  if (ink !== undefined) findings.push(ink)
  findings.push(...hatchCollisions(outlines, openSegments, outlineGroups))
  findings.push(...outlineOverlaps(outlines, outlineGroups, outlineStroked))
  // 字高按文字占位框的高（`O→O+e2` 的模）量：它已经是字号换算到根坐标系的结果，
  // 与「文字被贯穿」「标号净距」同一口径。
  const fontHeightsMm = scan.texts.map((text) => {
    const corners = quadCorners(textQuad(text))
    const up = corners[3]
    const origin = corners[0]
    return Math.round(Math.hypot(up[0] - origin[0], up[1] - origin[1]) * 100) / 100
  })
  const smallestFont = fontBelowMinimum(scan.texts, fontHeightsMm, options.minFontMm)
  if (smallestFont !== undefined) findings.push(smallestFont)

  const strokeCounts = new Map<number, number>()
  for (const shape of scan.shapes) {
    if (!shape.stroked) continue
    const width = Math.round(shape.strokeWidthMm * 1000) / 1000
    strokeCounts.set(width, (strokeCounts.get(width) ?? 0) + 1)
  }
  const orientationCounts = new Map<number, number>()
  for (const item of drawn) {
    const key = Math.round(orientation(item.segment) * 10) / 10
    orientationCounts.set(key, (orientationCounts.get(key) ?? 0) + 1)
  }

  // 版面利用率：只在调用方给了下限、且画布尺寸可换算成毫米时才判。分母是**这张图
  // 自己的画布**，不是与金样或标准图对比——两边的画布来源不同（生成图是落版纸面、
  // 标准图是从附图页裁过的），跨图比它没有意义。
  const minSheetFillRatio = options.minSheetFillRatio
  if (minSheetFillRatio !== undefined && minSheetFillRatio > 0
    && scan.widthMm !== undefined && scan.heightMm !== undefined) {
    const bounds = inkBounds(scan)
    if (bounds !== undefined) {
      const canvasArea = scan.widthMm * scan.heightMm
      const contentArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
      const ratio = canvasArea > 0 ? contentArea / canvasArea : 0
      if (ratio < minSheetFillRatio) {
        findings.push({
          check: 'sheet-underfill',
          advisory: true,
          message: `图面内容只占画布的 ${(ratio * 100).toFixed(1)}%（下限 ${(minSheetFillRatio * 100).toFixed(0)}%）：图形可能撑不满纸面，缩小复制后细节更难辨认；调整投影比例或改用更紧凑的视图`,
        })
      }
    }
  }

  return {
    ...(scan.widthMm === undefined ? {} : { widthMm: scan.widthMm }),
    ...(scan.heightMm === undefined ? {} : { heightMm: scan.heightMm }),
    textCount: scan.texts.length,
    ...(fontHeightsMm.length === 0 ? {} : { minFontMm: Math.min(...fontHeightsMm) }),
    strokeWidthMm: [...strokeCounts]
      .map(([stroke, count]) => ({ widthMm: stroke, count }))
      .sort((left, right) => left.widthMm - right.widthMm),
    orientationDeg: [...orientationCounts]
      .map(([value, count]) => ({ orientationDeg: value, count }))
      .sort((left, right) => right.count - left.count),
    findings,
  }
}
