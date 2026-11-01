/**
 * 剖视图与剖面线（纯函数，无 IO）：把被剖切零件的闭合轮廓与剖面线参数生成为
 * 毫米画布上的黑色描边片段与图面词语。
 *
 * 依据（现行条文与标准）：
 * - 《专利审查指南》第一部分第一章 4.3：「剖面图中的剖面线不得妨碍附图标记线
 *   和主线条的清楚识别。」——剖面线一律用细实线，轮廓与剖切位置线用粗实线，
 *   线宽相差一倍；文字元素在全部线条之后绘制。
 * - GB/T 4457.5《机械制图 剖面区域的表示法》：剖面线为与水平线成 45° 的细实线，
 *   同一零件间距相等、方向一致；相邻零件的剖面线方向相反或间距不等，以免把
 *   相邻零件读成一个整体。
 * - 引线标号：数字落在零件轮廓之外，引线自零件上的指称点引出并止于数字外框，
 *   故数字不被线条贯穿；一个零件由多个轮廓拼成时也只标一处（见 {@link SectionLabel}）。
 * - 中心线：轴类零件的轴线用细点划线，随图形一起缩放（见 {@link SectionCenterline}）。
 *
 * 剖面线裁剪按 even-odd 求交：取平行线族的法向距离 c，对多边形的每条边按「两端
 * 点是否落在 c 的同一侧」（严格小于判定的异或）判交；交点沿线向排序后两两配对，
 * 只绘制落在多边形内部的线段。恰落在采样线上的顶点按「线上方」计，与相邻边不
 * 重复计数。
 *
 * 这套裁剪对**带孔的零件轮廓不适用**：它把每个多边形当独立闭合区域求交，孔环因此
 * 会被当成又一块材料。带孔的零件要由调用方按区域（材料外环 + 孔环）算好剖面线，
 * 用 {@link SectionPart.hatchSegments} 给出；本模块只画出它们，并把孔环当轮廓一并
 * 落图（见 {@link SectionPart.holes}）。
 * @module @deepseek-ai/dsh-patent-tools/figure/section-diagram
 */

import { glyphBox, leaderEnd } from './glyph-box.ts'
import { boundsOfPoints, formatMm as fmt, type MmPoint } from './mm-primitives.ts'
import { escapeXmlAttribute, VectorFigureError, type VectorFigureSpec } from './vector-figure.ts'

/** 剖面线参数：45° 细实线；相邻零件方向相反或间距不等以区分（GB/T 4457.5 实践）。 */
type HatchSpec = {
  /** 与水平线夹角（度），默认 45。 */
  angleDeg?: number
  /** 剖面线间距（毫米），默认 3。 */
  spacingMm?: number
  /** 方向：'forward'（左上→右下）或 'backward'（左下→右上），默认 forward。 */
  direction?: 'forward' | 'backward'
}

/** 线段（毫米，视图帧坐标：x 向右、y 向下）。 */
type SectionSegment = {
  /** 起点。 */
  readonly from: readonly [number, number]
  /** 终点。 */
  readonly to: readonly [number, number]
}

/** 被剖切的零件：闭合轮廓 + 剖面线；`hatch: 'none'` 表示该轮廓不打剖面线。 */
type SectionPart = {
  /**
   * 零件名（写入图面，简短）：数字落在该轮廓包围盒右上角之外，自轮廓重心引一条细实线
   * 到数字外框 —— 剖面线与沿中线的中心线因此都不穿过数字（《专利审查指南》第一部分
   * 第一章 4.3）。多轮廓零件用 {@link SectionLabel} 指定唯一标号落点。
   */
  label?: string
  /** 闭合多边形顶点（毫米，至少 3 个，自动闭合）。 */
  outline: readonly (readonly [number, number])[]
  /**
   * 该零件轮廓内的孔（毫米，各至少 3 个顶点，隐式闭合）：孔环与 {@link SectionPart.outline}
   * 同属一个零件，用同一线宽画出并落在同一剖面线分组内，但孔里不打剖面线。
   *
   * 给了孔就必须同时用 {@link SectionPart.hatchSegments} 给出剖面线段：本模块的裁剪按单个
   * 多边形求交，对带孔区域会把孔里也打上剖面线，故不带孔区域那条老路会显式报错而非画出错图。
   */
  holes?: readonly (readonly (readonly [number, number])[])[]
  /**
   * 已算好的剖面线段（毫米，视图帧）：给出时直接落图，不再按 {@link SectionPart.outline} 裁剪。
   * 必须与 {@link SectionPart.hatch} 同时给出且不是 `'none'` —— 剖面线分组与渲染复核都按
   * `hatch` 的参数把同一零件的多个轮廓归并成一件，只给线段会让它们各自成组。
   */
  hatchSegments?: readonly SectionSegment[]
  /**
   * 剖面线参数；`'none'` 表示该轮廓不是被剖切的实体（引线、轴线、非剖切件），只画轮廓。
   * 缺省时按 45°/3 毫米打剖面线 —— 调用方若只想画轮廓必须显式写 `'none'`。
   */
  hatch?: HatchSpec | 'none'
  /**
   * 该零件轮廓的粗实线线宽（毫米）；缺省用 {@link SectionDiagramInput.strokeWidthMm}。
   * 同一张图里薄壁件加粗、或让某一零件轮廓更醒目时用它。
   */
  strokeWidthMm?: number
}

/**
 * 附图标记（引线标号）：数字落在零件轮廓之外，引线自零件上的指称点引出。
 *
 * 引线只画到数字外框边，因此数字不会被线条贯穿；落点由调用方给出，故一个零件由
 * 多个轮廓拼成时也只画一处标号（零件本体轮廓的 `label` 会画在每个轮廓的重心上）。
 */
type SectionLabel = {
  /** 标号文本（写入图面的阿拉伯数字）。 */
  text: string
  /** 数字视觉中心落点（毫米）。 */
  at: readonly [number, number]
  /** 引线起点：零件上的指称点（毫米）；给出时自该点画一条细实线到数字外框边。 */
  from?: readonly [number, number]
}

/** 中心线（细点划线）：轴类零件的轴线，不是被剖切的实体。 */
type SectionCenterline = {
  /** 中心线起点（毫米）。 */
  from: readonly [number, number]
  /** 中心线终点（毫米）。 */
  to: readonly [number, number]
}

/**
 * 断裂线（折断线）：长零件省略中段时，在被断开的两端各画一条细实线。
 *
 * 本模块只画断口标记，不切断零件轮廓——调用方把零件拆成两段轮廓分别给出，断口之间
 * 留出省略区。
 */
export type SectionBreakLine = {
  /** 断口起点（毫米）。 */
  from: readonly [number, number]
  /** 断口终点（毫米）：与起点不同，方向即断口横跨方向。 */
  to: readonly [number, number]
  /** 线型：锯齿（默认）或波浪。 */
  style?: 'zigzag' | 'wavy' | undefined
  /** 齿高/波幅（毫米），默认 {@link DEFAULT_BREAK_AMPLITUDE_MM}；须为正数。 */
  amplitudeMm?: number | undefined
  /** 锯齿数/波数，默认按断口长度每 {@link BREAK_TOOTH_SPACING_MM} 毫米一个（至少 2）。 */
  teeth?: number | undefined
}

/** 断裂线齿高/波幅默认值（毫米）。 */
const DEFAULT_BREAK_AMPLITUDE_MM = 1.5

/** 断裂线默认齿距（毫米）：断口长度除以它取整得到默认齿数。 */
const BREAK_TOOTH_SPACING_MM = 3

/** 剖切位置符号（剖切位置线 + 投射方向箭头 + 字母）。 */
export type CuttingMark = {
  /** 剖切标记字母（如 'A'）。 */
  id: string
  /** 剖切位置线起点/终点（毫米）。 */
  from: readonly [number, number]
  to: readonly [number, number]
  /** 箭头（投射方向）指向：屏幕坐标的绝对方向（x 向右、y 向下，'up' 即 -y）。 */
  arrow: 'left' | 'right' | 'up' | 'down'
}

/** 剖视图输入。 */
type SectionDiagramInput = {
  /** 外轮廓（毫米，自动闭合）；缺省或空数组表示只画零件。 */
  outline?: readonly (readonly [number, number])[]
  /** 被剖切零件（至少一个）。 */
  parts: readonly SectionPart[]
  /** 引线标号（0 个或多个）：数字在零件轮廓之外，引线自零件引出。 */
  labels?: readonly SectionLabel[]
  /** 中心线（0 条或多条）：细点划线，画在零件之前、不参与剖面线。 */
  centerlines?: readonly SectionCenterline[]
  /** 剖切位置符号（0 个或多个）。 */
  cuttingMarks?: readonly CuttingMark[]
  /** 断裂线（0 条或多条）：细实线，标记长零件省略段的两端。 */
  breakLines?: readonly SectionBreakLine[]
  /** 图面字号（毫米），默认 3.5（附图标记与剖切字母同用）。 */
  labelFontSizeMm?: number
  /** 轮廓与剖切位置线的粗实线线宽（毫米），默认 0.5；零件自己的 `strokeWidthMm` 优先。 */
  strokeWidthMm?: number
  /** 剖面线、中心线与引线的细实线线宽（毫米），默认 0.25。 */
  thinStrokeWidthMm?: number
  /** 画布留白（毫米），默认 4。 */
  paddingMm?: number
}

/** 二维点（毫米）。 */
type Point = MmPoint

/** 文本锚点水平对齐方式。 */
type TextAnchor = 'start' | 'middle' | 'end'

/** 已解析的剖面线参数（缺省值已填入）。 */
type ResolvedHatch = {
  readonly angleDeg: number
  readonly spacingMm: number
  readonly direction: 'forward' | 'backward'
}

/** 平行线族的单位法向与单位线向。 */
type HatchAxes = { readonly normal: Point; readonly along: Point }

/** 剖切位置符号的几何（原始坐标）。 */
type CuttingMarkGeometry = {
  /** 剖切位置线（两端各外延 {@link MARK_EXTEND_MM} 后落箭头）。 */
  readonly positionLine: SectionSegment
  /** 两端箭头折线（尖端指向投射方向）。 */
  readonly arrowHeads: readonly (readonly Point[])[]
  /** 两端字母锚点。 */
  readonly labelAnchors: readonly Point[]
  /** 字母水平对齐。 */
  readonly labelAnchor: TextAnchor
}

/** 一个待绘制的轮廓：顶点、线宽与（同一材料轮廓共用的）分组号。 */
type PolygonDraw = {
  readonly points: readonly Point[]
  /** 该轮廓的线宽（毫米）。 */
  readonly strokeMm: number
  /** 同一材料的轮廓分组号；undefined 时该轮廓自成一组。 */
  readonly hatchGroup: number | undefined
}

/** 待绘制文字（基线锚点、对齐方式与字号）。 */
type DiagramText = { readonly text: string; readonly at: Point; readonly anchor: TextAnchor; readonly fontSizeMm: number }

/** 包围盒（原始坐标，毫米）。 */

/** 轮廓与剖切位置线的粗实线线宽（毫米，GB/T 4457.4 线宽系列）。 */
const THICK_STROKE_MM = 0.5
/** 剖面线的细实线线宽（毫米）。 */
const THIN_STROKE_MM = 0.25
/**
 * 可指定的线宽下限（毫米）：GB/T 4457.4 要求「应避免采用 0.18 mm 以下的图线宽度」
 * （图样复制后不可辨）。调用方给的线宽低于此值即报错，而不是画出一张印不出来的图。
 */
const MIN_STROKE_MM = 0.18
/** 默认剖面线角度（度）：未给 `hatch` 的轮廓按它打剖面线（另一处使用见 `figure/section-source`）。 */
export const DEFAULT_HATCH_ANGLE_DEG = 45
/** 默认剖面线间距（毫米）：与 {@link DEFAULT_HATCH_ANGLE_DEG} 同源，两处不得各写一份。 */
export const DEFAULT_HATCH_SPACING_MM = 3
/** 默认画布留白（毫米）。 */
const DEFAULT_PADDING_MM = 4
/** 剖切位置线两端外延长度（毫米）：箭头落在外延段上，不压零件轮廓。 */
const MARK_EXTEND_MM = 3
/** 箭头长度（毫米）。 */
const ARROW_LENGTH_MM = 2.5
/** 箭头半宽（毫米）。 */
const ARROW_HALF_WIDTH_MM = 1
/** 字母到箭头尖端的间隙（毫米）。 */
const MARK_LABEL_GAP_MM = 1.5
/** 默认图面字号（毫米）；附图标记与剖切字母同用，可由 {@link SectionDiagramInput.labelFontSizeMm} 覆盖。 */
const DEFAULT_LABEL_FONT_SIZE_MM = 3.5
/**
 * 零件名外置时的间隙（字号倍数）：自轮廓包围盒的右上角向上、向右各取两倍字号，
 * 文字占位框（半宽按内容宽度的一半、基线以上 0.75 字号）因此整体落在轮廓之外，剖面线与
 * 沿中线的中心线都不压字。
 */
const LABEL_OUTSIDE_GAP_FACTOR = 2
/**
 * 默认字号下的文本基线相对锚点的下沉量（毫米，约 0.35 字号，使文字视觉垂直居中）；
 * 其他字号按比例缩放，故默认字号下的图面坐标不随本参数引入而变化。
 */
const TEXT_BASELINE_DROP_MM = 1.2
/** 细点划线的长划、间隔与点长（毫米）；中心线的线型固定，随图形一起缩放。 */
const DASH_DOT_DASH_MM = 8
const DASH_DOT_GAP_MM = 2
const DASH_DOT_DOT_MM = 0.4
/** 退化线段阈值（毫米）：两交点距离不超过它时不画。 */
const MIN_SEGMENT_MM = 1e-9

/** 允许的剖面线方向。 */
const HATCH_DIRECTIONS: readonly ('forward' | 'backward')[] = ['forward', 'backward']

/** 投射方向箭头的单位向量（屏幕坐标）。 */
const ARROW_VECTORS: Record<CuttingMark['arrow'], Point> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
}

/** 投射方向对应的字母水平对齐（左右向让位给箭头，上下向居中）。 */
const ARROW_LABEL_ANCHORS: Record<CuttingMark['arrow'], TextAnchor> = {
  left: 'end',
  right: 'start',
  up: 'middle',
  down: 'middle',
}

/**
 * 校验坐标有限。
 * @param point - 待校验点。
 * @param subject - 报错用主体名（如「零件 #1 轮廓」）。
 * @throws VectorFigureError('invalid_input') 任一坐标非有限数时。
 */
function assertFinitePoint(point: Point, subject: string): void {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new VectorFigureError('invalid_input', `${subject}坐标必须是有限数：(${String(point[0])}, ${String(point[1])})`)
  }
}

/**
 * 校验闭合多边形顶点：不少于 3 个且坐标有限。
 * @param points - 多边形顶点（隐式闭合）。
 * @param subject - 报错用主体名。
 * @throws VectorFigureError('invalid_input') 顶点不足或坐标非有限数时。
 */
function assertPolygon(points: readonly Point[], subject: string): void {
  if (points.length < 3) {
    throw new VectorFigureError('invalid_input', `${subject}至少需要 3 个顶点，实际 ${points.length} 个`)
  }
  for (const point of points) assertFinitePoint(point, subject)
}

/**
 * 校验剖切位置符号：字母非空、两端点坐标有限且不重合。
 * @param mark - 待校验符号。
 * @throws VectorFigureError('invalid_input') 校验不通过时。
 */
function assertCuttingMark(mark: CuttingMark): void {
  if (mark.id.trim() === '') {
    throw new VectorFigureError('invalid_input', '剖切标记字母不能为空')
  }
  assertFinitePoint(mark.from, '剖切位置线起点')
  assertFinitePoint(mark.to, '剖切位置线终点')
  if (mark.from[0] === mark.to[0] && mark.from[1] === mark.to[1]) {
    throw new VectorFigureError('invalid_input', `剖切位置线两端点不能重合：(${String(mark.from[0])}, ${String(mark.from[1])})`)
  }
}

/**
 * 校验中心线：两端点坐标有限且不重合。
 * @param centerline - 待校验中心线。
 * @throws VectorFigureError('invalid_input') 校验不通过时。
 */
function assertCenterline(centerline: SectionCenterline): void {
  assertFinitePoint(centerline.from, '中心线起点')
  assertFinitePoint(centerline.to, '中心线终点')
  if (centerline.from[0] === centerline.to[0] && centerline.from[1] === centerline.to[1]) {
    throw new VectorFigureError('invalid_input', `中心线两端点不能重合：(${String(centerline.from[0])}, ${String(centerline.from[1])})`)
  }
}

/**
 * 生成断裂线的折线顶点：锯齿按齿数交替偏到两侧，波浪按正弦取样。
 *
 * 两端点不做偏移，使断口线起止于零件被断开的位置；幅度与齿数都校验为正，
 * 零长度断口直接报错，避免画出一条不可见的标记。
 * @param line - 断裂线参数。
 * @param index - 在输入数组中的序号（用于错误信息）。
 * @returns 折线顶点（毫米）。
 * @throws VectorFigureError('invalid_input') 端点重合、幅度非正或齿数小于 2 时。
 */
function breakLinePoints(line: SectionBreakLine, index: number): Point[] {
  const subject = `断裂线 #${index + 1} `
  assertFinitePoint(line.from, `${subject}起点`)
  assertFinitePoint(line.to, `${subject}终点`)
  const dx = line.to[0] - line.from[0]
  const dy = line.to[1] - line.from[1]
  const length = Math.hypot(dx, dy)
  if (length === 0) throw new VectorFigureError('invalid_input', `${subject}两端点不能重合`)
  const amplitude = line.amplitudeMm ?? DEFAULT_BREAK_AMPLITUDE_MM
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    throw new VectorFigureError('invalid_input', `${subject}齿高必须为正数：${String(amplitude)}`)
  }
  const teeth = line.teeth ?? Math.max(2, Math.round(length / BREAK_TOOTH_SPACING_MM))
  if (!Number.isInteger(teeth) || teeth < 2) {
    throw new VectorFigureError('invalid_input', `${subject}齿数必须是不小于 2 的整数：${String(teeth)}`)
  }
  // 单位轴与左法向：偏移沿法向取正负。
  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  const zigzag = (line.style ?? 'zigzag') === 'zigzag'
  // 锯齿：每齿两段、交替偏向两侧；波浪：正弦取样，两端点 sin(0)=sin(2π·teeth)=0 自然落在断口线上。
  const steps = zigzag ? teeth * 2 : Math.max(32, teeth * 8)
  const points: Point[] = []
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const sign = zigzag
      ? (step === 0 || step === steps ? 0 : (step % 2 === 0 ? -1 : 1))
      : Math.sin(2 * Math.PI * teeth * t)
    points.push([line.from[0] + dx * t + nx * amplitude * sign, line.from[1] + dy * t + ny * amplitude * sign])
  }
  return points
}

/**
 * 解析图面字号（毫米）：缺省 3.5，必须为正有限数。
 * @param fontSizeMm - 传入的字号；缺省取默认值。
 * @returns 生效字号（毫米）。
 * @throws VectorFigureError('invalid_input') 字号非正有限数时。
 */
function resolveLabelFontSize(fontSizeMm: number | undefined): number {
  const size = fontSizeMm ?? DEFAULT_LABEL_FONT_SIZE_MM
  if (!Number.isFinite(size) || size <= 0) {
    throw new VectorFigureError('invalid_input', `图面字号必须是正有限数：${String(size)}`)
  }
  return size
}

/**
 * 解析线宽：缺省取图级默认值，否则校验为有限数且不低于 {@link MIN_STROKE_MM}。
 * @param strokeMm - 传入的线宽（毫米）；undefined 时取 `fallbackMm`。
 * @param fallbackMm - 图级默认线宽（毫米）。
 * @param subject - 报错用主体名前缀。
 * @returns 线宽（毫米）。
 * @throws VectorFigureError('invalid_input') 线宽非正有限数或低于下限时。
 */
function resolveStrokeWidth(strokeMm: number | undefined, fallbackMm: number, subject: string): number {
  if (strokeMm === undefined) return fallbackMm
  if (!Number.isFinite(strokeMm) || strokeMm < MIN_STROKE_MM) {
    throw new VectorFigureError(
      'invalid_input',
      `${subject}必须是不小于 ${String(MIN_STROKE_MM)} 毫米的有限数（GB/T 4457.4 要求避免采用 0.18 毫米以下的图线宽度）：${String(strokeMm)}`,
    )
  }
  return strokeMm
}

/**
 * 解析剖面线参数并校验取值域（缺省 45°、3 毫米、forward）。
 * @param hatch - 传入的剖面线参数；`'none'` 表示该轮廓不打剖面线。
 * @param subject - 报错用主体名前缀。
 * @returns 缺省值已填入的参数；`'none'` 时为 undefined。
 * @throws VectorFigureError('invalid_input') 角度、间距或方向非法时。
 */
function resolveHatch(hatch: HatchSpec | 'none' | undefined, subject: string): ResolvedHatch | undefined {
  if (hatch === 'none') return undefined
  const angleDeg = hatch?.angleDeg ?? DEFAULT_HATCH_ANGLE_DEG
  const spacingMm = hatch?.spacingMm ?? DEFAULT_HATCH_SPACING_MM
  const direction = hatch?.direction ?? 'forward'
  if (!Number.isFinite(angleDeg) || angleDeg <= 0 || angleDeg > 90) {
    throw new VectorFigureError('invalid_input', `${subject}剖面线角度必须在 (0, 90] 度内：${String(angleDeg)}`)
  }
  if (!Number.isFinite(spacingMm) || spacingMm <= 0) {
    throw new VectorFigureError('invalid_input', `${subject}剖面线间距必须为正有限数：${String(spacingMm)}`)
  }
  if (!HATCH_DIRECTIONS.includes(direction)) {
    throw new VectorFigureError('invalid_input', `${subject}剖面线方向只能是 forward 或 backward：${direction}`)
  }
  return { angleDeg, spacingMm, direction }
}

/**
 * 点在给定方向向量上的投影（法向投影即平行线族的参数 c）。
 * @param point - 待投影点。
 * @param axis - 方向向量。
 * @returns 投影长度（毫米）。
 */
function project(point: Point, axis: Point): number {
  return point[0] * axis[0] + point[1] * axis[1]
}

/**
 * 平行线族的单位法向与单位线向。
 * @param hatch - 已解析的剖面线参数。
 * @returns forward 为左上→右下、backward 为左下→右上的一组正交单位向量。
 */
function hatchAxes(hatch: ResolvedHatch): HatchAxes {
  const radians = (hatch.angleDeg * Math.PI) / 180
  const sign = hatch.direction === 'forward' ? 1 : -1
  const along: Point = [Math.cos(radians), sign * Math.sin(radians)]
  const normal: Point = [-sign * Math.sin(radians), Math.cos(radians)]
  return { normal, along }
}

/**
 * 由族参数 c 与线向投影 u 还原线上的点。
 * @param c - 法向距离。
 * @param u - 线向投影。
 * @param axes - 平行线族的两组单位向量。
 * @returns 线段端点坐标。
 */
function linePoint(c: number, u: number, axes: HatchAxes): Point {
  return [c * axes.normal[0] + u * axes.along[0], c * axes.normal[1] + u * axes.along[1]]
}

/**
 * 计算多边形的剖面线线段（even-odd 求交后配对，只保留多边形内部的线段）。
 * @param points - 闭合多边形顶点（隐式闭合）。
 * @param hatch - 已解析的剖面线参数。
 * @returns 剖面线线段，按族参数 c 递增排列。
 */
function clipHatchSegments(points: readonly Point[], hatch: ResolvedHatch): SectionSegment[] {
  const axes = hatchAxes(hatch)
  let cMin = Infinity
  let cMax = -Infinity
  for (const point of points) {
    const c = project(point, axes.normal)
    if (c < cMin) cMin = c
    if (c > cMax) cMax = c
  }

  const segments: SectionSegment[] = []
  for (let index = Math.ceil(cMin / hatch.spacingMm); index * hatch.spacingMm <= cMax; index += 1) {
    const c = index * hatch.spacingMm
    const crossings: number[] = []
    for (let i = 0; i < points.length; i += 1) {
      const from = points[i] as Point
      const to = points[(i + 1) % points.length] as Point
      const cFrom = project(from, axes.normal)
      const cTo = project(to, axes.normal)
      // 半开区间判交：恰落在线上的顶点记作「线上方」，与相邻边不重复计数。
      if ((cFrom < c) === (cTo < c)) continue
      const t = (c - cFrom) / (cTo - cFrom)
      const hit: Point = [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])]
      crossings.push(project(hit, axes.along))
    }
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const uFrom = crossings[i] as number
      const uTo = crossings[i + 1] as number
      // 线与多边形相切于顶点时两端点重合：零长线段不属于多边形内部。
      if (uTo - uFrom <= MIN_SEGMENT_MM) continue
      segments.push({ from: linePoint(c, uFrom, axes), to: linePoint(c, uTo, axes) })
    }
  }
  return segments
}

/**
 * 读取零件给的预生成剖面线段：必须与 `hatch` 同时给出，且 `hatch` 不是 `'none'`。
 *
 * 这里看的是**原始字段**而不是解析后的参数：缺省 `hatch` 会被解析成 45°/3 毫米，与显式给出
 * 同值无法区分 —— 而线段是按某组参数裁出来的，参数不同却并进一个分组会让渲染复核的
 * 「相邻零件剖面线是否可区分」判据把真缺陷当成同件。
 * @param part - 被剖切零件。
 * @param subject - 报错用主体名前缀。
 * @returns 已校验端点有限性的线段；未给出时为 undefined。
 * @throws VectorFigureError('invalid_input') 只给线段没给 `hatch`、`hatch` 为 `'none'`、
 * 或端点坐标非有限数时。
 */
function readProvidedHatchSegments(part: SectionPart, subject: string): SectionSegment[] | undefined {
  const provided = part.hatchSegments
  if (provided === undefined) return undefined
  if (part.hatch === undefined || part.hatch === 'none') {
    throw new VectorFigureError(
      'invalid_input',
      `${subject}给了 hatchSegments 就必须同时给出 hatch（说明这些线段按哪组参数裁出；不能是 "none"）：`
      + '剖面线分组与渲染复核按 hatch 参数把同一零件的多个轮廓归并成一件',
    )
  }
  provided.forEach((segment, index) => {
    assertFinitePoint(segment.from, `${subject}剖面线段 #${index + 1} 起点`)
    assertFinitePoint(segment.to, `${subject}剖面线段 #${index + 1} 终点`)
  })
  return [...provided]
}

/**
 * 多边形面积重心（零件名的落点）。
 * @param points - 闭合多边形顶点。
 * @returns 重心；顶点共线（零面积）时退化为顶点平均位置。
 */
function polygonCentroid(points: readonly Point[]): Point {
  let twiceArea = 0
  let xSum = 0
  let ySum = 0
  for (let i = 0; i < points.length; i += 1) {
    const from = points[i] as Point
    const to = points[(i + 1) % points.length] as Point
    const cross = from[0] * to[1] - to[0] * from[1]
    twiceArea += cross
    xSum += (from[0] + to[0]) * cross
    ySum += (from[1] + to[1]) * cross
  }
  if (twiceArea === 0) return averagePoint(points)
  return [xSum / (3 * twiceArea), ySum / (3 * twiceArea)]
}

/**
 * 顶点平均位置（零面积多边形的重心退化值）。
 * @param points - 多边形顶点。
 * @returns 顶点坐标的平均值。
 */
function averagePoint(points: readonly Point[]): Point {
  let xSum = 0
  let ySum = 0
  for (const point of points) {
    xSum += point[0]
    ySum += point[1]
  }
  return [xSum / points.length, ySum / points.length]
}

/** 文本基线相对数字视觉中心的距离（毫米）：默认字号下 {@link TEXT_BASELINE_DROP_MM}，按字号比例缩放。 */
function baselineDrop(fontSizeMm: number): number {
  return TEXT_BASELINE_DROP_MM * (fontSizeMm / DEFAULT_LABEL_FONT_SIZE_MM)
}

/**
 * 文字的占位框（画布包围盒用）：与引线止点、渲染复核共用 {@link glyphBox} 的同一
 * 模型——按内容宽度与基线定位。按字号正方形估算会把多字标号算窄，标号右半落在画布
 * 之外、被裁掉。
 * @param text - 文字内容。
 * @param at - 文字视觉中心落点。
 * @param anchor - 水平对齐方式。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 占位框的两个对角顶点。
 */
function textExtent(text: string, at: Point, anchor: TextAnchor, fontSizeMm: number): Point[] {
  const baseline: Point = [at[0], at[1] + baselineDrop(fontSizeMm)]
  const box = glyphBox(text, baseline, fontSizeMm, anchor)
  return [[box.minX, box.minY], [box.maxX, box.maxY]]
}

/**
 * 零件名在轮廓之外的落点：包围盒右上角外侧，向右向上各 {@link LABEL_OUTSIDE_GAP_FACTOR}
 * 倍字号。取斜上方位而非正右方，是为了让数字避开沿零件中线的中心线——轴线图的中心线
 * 正从轮廓中高向两侧外延，数字落在同一高度就会被它贯穿。
 * @param points - 零件轮廓顶点。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 数字视觉中心落点。
 */
function outsideLabelAt(points: readonly Point[], fontSizeMm: number): Point {
  const bounds = boundsOfPoints(points)
  const gap = LABEL_OUTSIDE_GAP_FACTOR * fontSizeMm
  return [bounds.maxX + gap, bounds.minY - gap]
}

/**
 * 引线线段：自零件上的指称点画到文字占位框边，线段不进入占位框 —— 文字因此
 * 不会被引线贯穿。占位框模型与复核侧共用（{@link glyphBox}）。
 * @param content - 文字内容（决定占位框宽度）。
 * @param from - 引线起点（零件上的指称点）。
 * @param at - 文字视觉中心落点。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 引线线段；起点与落点重合、或落点在起点之内（后退量不小于全长）时为 undefined。
 */
function labelLeader(content: string, from: Point, at: Point, fontSizeMm: number): SectionSegment | undefined {
  const baseline: Point = [at[0], at[1] + baselineDrop(fontSizeMm)]
  const end = leaderEnd(content, baseline, fontSizeMm, 'middle', from)
  return end === undefined ? undefined : { from, to: end }
}

/**
 * 细点划线分段：长划—间隔—点—间隔循环，末段按剩余长度截断。
 * @param from - 中心线起点。
 * @param to - 中心线终点。
 * @returns 沿线的线段序列（不含间隙）。
 */
function dashDotSegments(from: Point, to: Point): SectionSegment[] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const total = Math.hypot(dx, dy)
  /* v8 ignore next -- assertCenterline 已拒绝两端点完全重合；这里挡住「仅相差浮点噪声」的端点，避免单位向量发散 */
  if (total <= MIN_SEGMENT_MM) return []
  const unit: Point = [dx / total, dy / total]
  const at = (distance: number): Point => [from[0] + unit[0] * distance, from[1] + unit[1] * distance]
  const pattern: readonly number[] = [
    DASH_DOT_DASH_MM, DASH_DOT_GAP_MM, DASH_DOT_DOT_MM, DASH_DOT_GAP_MM,
  ]
  const segments: SectionSegment[] = []
  let cursor = 0
  for (let index = 0; cursor < total; index += 1) {
    const length = pattern[index % pattern.length] as number
    const end = Math.min(cursor + length, total)
    // 长划与点都画细实线；间隔不画。下标 0、2 是画线位。
    if (index % 2 === 0 && end - cursor > MIN_SEGMENT_MM) segments.push({ from: at(cursor), to: at(end) })
    cursor = end
  }
  return segments
}

/**
 * 剖切位置符号的几何：位置线两端外延后落箭头，字母写在箭头尖端外侧。
 * @param mark - 已校验的剖切位置符号。
 * @returns 位置线、两支箭头折线、两端字母锚点与字母对齐方式。
 */
function cuttingMarkGeometry(mark: CuttingMark): CuttingMarkGeometry {
  const dx = mark.to[0] - mark.from[0]
  const dy = mark.to[1] - mark.from[1]
  const length = Math.hypot(dx, dy)
  const axis: Point = [dx / length, dy / length]
  const ends: Point[] = [
    [mark.from[0] - axis[0] * MARK_EXTEND_MM, mark.from[1] - axis[1] * MARK_EXTEND_MM],
    [mark.to[0] + axis[0] * MARK_EXTEND_MM, mark.to[1] + axis[1] * MARK_EXTEND_MM],
  ]
  const arrow = ARROW_VECTORS[mark.arrow]
  const side: Point = [-arrow[1], arrow[0]]
  const arrowHeads: Point[][] = []
  const labelAnchors: Point[] = []
  for (const end of ends) {
    const tip: Point = [end[0] + arrow[0] * ARROW_LENGTH_MM, end[1] + arrow[1] * ARROW_LENGTH_MM]
    arrowHeads.push([
      [end[0] + side[0] * ARROW_HALF_WIDTH_MM, end[1] + side[1] * ARROW_HALF_WIDTH_MM],
      tip,
      [end[0] - side[0] * ARROW_HALF_WIDTH_MM, end[1] - side[1] * ARROW_HALF_WIDTH_MM],
    ])
    labelAnchors.push([tip[0] + arrow[0] * MARK_LABEL_GAP_MM, tip[1] + arrow[1] * MARK_LABEL_GAP_MM])
  }
  return {
    positionLine: { from: ends[0] as Point, to: ends[1] as Point },
    arrowHeads,
    labelAnchors,
    labelAnchor: ARROW_LABEL_ANCHORS[mark.arrow],
  }
}


/**
 * SVG 坐标点文本（平移后）。
 * @param point - 原始坐标点。
 * @param offset - 画布平移量。
 * @returns `x,y` 文本。
 */
function coordPair(point: Point, offset: Point): string {
  return `${fmt(point[0] + offset[0])},${fmt(point[1] + offset[1])}`
}

/**
 * 多边形元素（粗实线）。
 * @param points - 多边形顶点。
 * @param offset - 画布平移量。
 * @param strokeMm - 线宽（毫米）。
 * @param hatchGroup - 同一材料的轮廓分组号；undefined 时不写分组标记。
 * @returns `<polygon>` 元素文本。
 */
function polygonElement(points: readonly Point[], offset: Point, strokeMm: number, hatchGroup?: number): string {
  const list = points.map(point => coordPair(point, offset)).join(' ')
  const group = hatchGroup === undefined ? '' : ` data-dsh-hatch-group="${String(hatchGroup)}"`
  return `<polygon points="${list}" stroke-width="${fmt(strokeMm)}"${group}/>`
}

/**
 * 折线元素（粗实线，箭头用）。
 * @param points - 折线顶点。
 * @param offset - 画布平移量。
 * @param strokeMm - 线宽（毫米）。
 * @returns `<polyline>` 元素文本。
 */
function polylineElement(points: readonly Point[], offset: Point, strokeMm: number): string {
  const list = points.map(point => coordPair(point, offset)).join(' ')
  return `<polyline points="${list}" stroke-width="${fmt(strokeMm)}"/>`
}

/**
 * 线段元素。
 * @param segment - 线段。
 * @param offset - 画布平移量。
 * @param strokeMm - 线宽（毫米）。
 * @param role - 该线段的图面角色（绘图侧显式标记，供复核区分引线与图元）；undefined 时不写标记。
 * @returns `<line>` 元素文本。
 */
function segmentElement(segment: SectionSegment, offset: Point, strokeMm: number, role?: 'leader'): string {
  const x1 = fmt(segment.from[0] + offset[0])
  const y1 = fmt(segment.from[1] + offset[1])
  const x2 = fmt(segment.to[0] + offset[0])
  const y2 = fmt(segment.to[1] + offset[1])
  const mark = role === undefined ? '' : ` data-dsh-role="${role}"`
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${fmt(strokeMm)}"${mark}/>`
}

/**
 * 文本元素（自带 fill/stroke，避免继承外壳的 `fill="none"`）。
 * @param item - 文字、锚点与对齐方式。
 * @param offset - 画布平移量。
 * @returns `<text>` 元素文本。
 */
function textElement(item: DiagramText, offset: Point): string {
  const x = fmt(item.at[0] + offset[0])
  const drop = baselineDrop(item.fontSizeMm)
  const y = fmt(item.at[1] + offset[1] + drop)
  const size = fmt(item.fontSizeMm)
  return `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${item.anchor}" fill="#000000" stroke="none">${escapeXmlAttribute(item.text)}</text>`
}

/**
 * 构建剖面图：外轮廓与零件轮廓用粗实线、剖面线用细实线裁剪到零件内部、中心线与
 * 引线用细实线、剖切位置符号用粗实线箭头加字母。
 *
 * 图面元素各有一等表达，调用方不必用几何伪造：引线标号用 `labels`（数字落点 +
 * 引线起点）、轴线用 `centerlines`（细点划线）、非剖切轮廓用 `hatch: 'none'`
 * （只画轮廓）、字面大小用 `labelFontSizeMm`。
 *
 * 带孔零件（例如从 CAD 模型切出的剖面）用 `part.holes` 给孔环、`part.hatchSegments`
 * 给按区域裁好的剖面线段：孔环当轮廓画出，剖面线直接落图。
 *
 * 画布为轮廓、零件、中心线、引线、标号、剖切符号与留白的包围盒；输出坐标已整体
 * 平移，恒为非负。
 * @param input - 剖视图输入（外轮廓、被剖切零件、引线标号、中心线、剖切位置符号、字号、粗/细线宽、画布留白）。
 * @returns 毫米画布规格与黑色描边片段。
 * @throws VectorFigureError('empty_input') `parts` 为空时。
 * @throws VectorFigureError('invalid_input') 顶点不足、坐标非有限数、剖面线参数、
 * 标号文本为空、中心线两端点重合、字号非正、线宽低于 {@link MIN_STROKE_MM}、画布留白非法、
 * 带孔零件未给 `hatchSegments`、或给了 `hatchSegments` 却没给 `hatch` 时。
 */
export function buildSectionDiagram(input: SectionDiagramInput): VectorFigureSpec {
  const paddingMm = input.paddingMm ?? DEFAULT_PADDING_MM
  if (!Number.isFinite(paddingMm) || paddingMm < 0) {
    throw new VectorFigureError('invalid_input', `画布留白必须是非负有限数：${String(paddingMm)}`)
  }
  if (input.parts.length === 0) {
    throw new VectorFigureError('empty_input', '剖视图至少需要一个被剖切零件')
  }

  const polygons: PolygonDraw[] = []
  const hatches: SectionSegment[] = []
  const centerlines: SectionSegment[] = []
  const breakLines: (readonly Point[])[] = []
  const leaders: SectionSegment[] = []
  const positionLines: SectionSegment[] = []
  const arrowHeads: (readonly Point[])[] = []
  const texts: DiagramText[] = []
  const labels: string[] = []
  const extents: Point[] = []
  const fontSizeMm = resolveLabelFontSize(input.labelFontSizeMm)
  const thickMm = resolveStrokeWidth(input.strokeWidthMm, THICK_STROKE_MM, '轮廓线宽')
  const thinMm = resolveStrokeWidth(input.thinStrokeWidthMm, THIN_STROKE_MM, '细实线线宽')
  // 同一材料的多个轮廓（同一零件被剖成的几段）用同一组剖面线参数；分组号按参数取值标注，
  // 供渲染复核把它们当一件比较，而不是两条相邻轮廓。未给 hatch 的轮廓不并入任何分组：
  // 缺省值可能只是漏写，合并会掩盖「相邻两件都落到同一个缺省剖面线」这一真缺陷。
  const hatchGroupBySpec = new Map<string, number>()
  const hatchGroupOf = (hatch: HatchSpec | 'none' | undefined): number | undefined => {
    if (hatch === undefined || hatch === 'none') return undefined
    const key = `${String(hatch.angleDeg ?? DEFAULT_HATCH_ANGLE_DEG)}|${String(hatch.spacingMm ?? DEFAULT_HATCH_SPACING_MM)}|${hatch.direction ?? 'forward'}`
    const known = hatchGroupBySpec.get(key)
    if (known !== undefined) return known
    const assigned = hatchGroupBySpec.size
    hatchGroupBySpec.set(key, assigned)
    return assigned
  }

  const outline = input.outline !== undefined && input.outline.length > 0 ? input.outline : undefined
  if (outline !== undefined) {
    assertPolygon(outline, '外轮廓')
    polygons.push({ points: outline, strokeMm: thickMm, hatchGroup: undefined })
    extents.push(...outline)
  }

  input.parts.forEach((part, index) => {
    const subject = `零件 #${index + 1} `
    assertPolygon(part.outline, `${subject}轮廓`)
    const hatch = resolveHatch(part.hatch, subject)
    const holes = part.holes ?? []
    holes.forEach((hole, holeIndex) => { assertPolygon(hole, `${subject}孔 #${holeIndex + 1} `) })
    const provided = readProvidedHatchSegments(part, subject)
    const strokeMm = resolveStrokeWidth(part.strokeWidthMm, thickMm, `${subject}线宽`)
    const hatchGroup = hatchGroupOf(part.hatch)
    polygons.push({ points: part.outline, strokeMm, hatchGroup })
    // 孔环与轮廓同一线宽、同一剖面线分组：它们是同一个零件的边界，不是另一个件。
    for (const hole of holes) polygons.push({ points: hole, strokeMm, hatchGroup })
    extents.push(...part.outline, ...holes.flat())
    if (provided !== undefined) hatches.push(...provided)
    else if (hatch !== undefined) {
      if (holes.length > 0) {
        throw new VectorFigureError(
          'invalid_input',
          `${subject}给了孔就必须给出 hatchSegments：本模块的剖面线裁剪按单个多边形求交，会把孔里也打上剖面线`,
        )
      }
      hatches.push(...clipHatchSegments(part.outline, hatch))
    }
    const labelText = part.label === undefined ? '' : part.label.trim()
    if (labelText !== '') {
      // 数字落在轮廓之外、自重心引出：落在轮廓内会被剖面线或轮廓边贯穿。
      const at = outsideLabelAt(part.outline, fontSizeMm)
      const leader = labelLeader(labelText, polygonCentroid(part.outline), at, fontSizeMm)
      /* v8 ignore next -- outsideLabelAt places the label above the outline, so the centroid is never inside its box. */
      if (leader !== undefined) leaders.push(leader)
      texts.push({ text: labelText, at, anchor: 'middle', fontSizeMm })
      extents.push(...textExtent(labelText, at, 'middle', fontSizeMm))
      labels.push(labelText)
    }
  })

  for (const centerline of input.centerlines ?? []) {
    assertCenterline(centerline)
    const segments = dashDotSegments(centerline.from, centerline.to)
    centerlines.push(...segments)
    extents.push(centerline.from, centerline.to)
  }

  for (const [index, line] of (input.breakLines ?? []).entries()) {
    const points = breakLinePoints(line, index)
    breakLines.push(points)
    extents.push(...points)
  }

  for (const [index, label] of (input.labels ?? []).entries()) {
    const subject = `标号 #${index + 1} `
    assertFinitePoint(label.at, `${subject}落点`)
    const text = label.text.trim()
    if (text === '') throw new VectorFigureError('invalid_input', `${subject}文本不能为空`)
    if (label.from !== undefined) {
      assertFinitePoint(label.from, `${subject}引线起点`)
      const leader = labelLeader(text, label.from, label.at, fontSizeMm)
      if (leader !== undefined) {
        leaders.push(leader)
        extents.push(label.from, leader.to)
      }
    }
    texts.push({ text, at: label.at, anchor: 'middle', fontSizeMm })
    extents.push(...textExtent(text, label.at, 'middle', fontSizeMm))
    labels.push(text)
  }

  for (const mark of input.cuttingMarks ?? []) {
    assertCuttingMark(mark)
    const geometry = cuttingMarkGeometry(mark)
    positionLines.push(geometry.positionLine)
    arrowHeads.push(...geometry.arrowHeads)
    extents.push(geometry.positionLine.from, geometry.positionLine.to, ...geometry.arrowHeads.flat())
    for (const at of geometry.labelAnchors) {
      texts.push({ text: mark.id.trim(), at, anchor: geometry.labelAnchor, fontSizeMm })
      extents.push(...textExtent(mark.id.trim(), at, geometry.labelAnchor, fontSizeMm))
    }
    labels.push(mark.id.trim())
  }

  const bounds = boundsOfPoints(extents)
  const offset: Point = [paddingMm - bounds.minX, paddingMm - bounds.minY]
  // 文字在全部线条之后绘制：剖面线不得妨碍附图标记线和主线条的识别。
  // 引线带 `data-dsh-role="leader"`：复核的「标号净距」判据只针对非引线图元，
  // 引线自己止于文字外框（见 glyph-box 的 leaderEnd），不该被判成贴线。
  const body = [
    ...polygons.map(draw => polygonElement(draw.points, offset, draw.strokeMm, draw.hatchGroup)),
    ...hatches.map(segment => segmentElement(segment, offset, thinMm)),
    ...centerlines.map(segment => segmentElement(segment, offset, thinMm)),
    ...breakLines.map(points => polylineElement(points, offset, thinMm)),
    ...leaders.map(segment => segmentElement(segment, offset, thinMm, 'leader')),
    ...positionLines.map(segment => segmentElement(segment, offset, thickMm)),
    ...arrowHeads.map(points => polylineElement(points, offset, thickMm)),
    ...texts.map(item => textElement(item, offset)),
  ].join('\n')

  return {
    widthMm: bounds.maxX - bounds.minX + paddingMm * 2,
    heightMm: bounds.maxY - bounds.minY + paddingMm * 2,
    body,
    labels,
  }
}
