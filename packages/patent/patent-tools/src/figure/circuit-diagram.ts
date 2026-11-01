/**
 * 电路图（专利附图）直绘接缝：把网格上的电气元件与正交连线渲染为
 * {@link VectorFigureSpec} 的黑白 SVG 片段。
 *
 * 风格依据《专利审查指南》第一部分第一章 4.3：附图一般使用黑色墨水绘制，
 * 线条应当均匀清晰、不得着色，附图标记应当使用阿拉伯数字编号。本模块因此只
 * 输出 `#000000` 的实线轮廓与文字（连线为 0.25mm 细实线），元件名与连线说明
 * 由调用方给出简短词，图面用语另由 figureWordingWarnings 把关。
 *
 * 与 dot-builder 的分工：Graphviz 的「节点 + 边」模型画不出电气符号，电路图走
 * {@link VectorFigureSpec} 的直绘通路。坐标为毫米，元件画在网格单元中心，符号
 * 尺寸随单元格缩放；元件 id 只用于连线寻址，不落图面。
 *
 * 元件名与连线说明的落位（{@link placeLabel}）逐条试候选位置、取第一个不压走线、
 * 符号与已落文字的：这两种文字都是调用方给的词，长度不受控，固定落位必然在某个
 * 走向上被走线穿过。
 * @module @deepseek-ai/dsh-patent-tools/figure/circuit-diagram
 */

import { GLYPH_ASCENT_RATIO, GLYPH_DESCENT_RATIO, boxCrossedBySegment, glyphBox } from './glyph-box.ts'
import type { GlyphBox, GlyphTextAnchor } from './glyph-box.ts'
import { VectorFigureError, fmt } from './vector-figure.ts'
import type { VectorFigureSpec } from './vector-figure.ts'

/** 电路符号种类白名单。 */
export const CIRCUIT_SYMBOL_KINDS = [
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'battery',
  'ground',
  'switch',
  'lamp',
  'npn_transistor',
  'voltage_source',
] as const

/** 电路符号种类。 */
export type CircuitSymbolKind = (typeof CIRCUIT_SYMBOL_KINDS)[number]

/** 网格上的电路元件。 */
export type CircuitComponent = {
  /** 元件标识：仅用于连线寻址与重复检查，不写入图面。 */
  id: string
  /** 符号种类。 */
  kind: CircuitSymbolKind
  /** 简短中文或全大写缩写名（写入图面，供用语检查）。 */
  label?: string
  /** 网格列（0 起，非负整数）。 */
  col: number
  /** 网格行（0 起，非负整数）。 */
  row: number
}

/** 元件间连线：正交走线，端口取在元件符号边界。 */
type CircuitConnection = {
  /** 起点元件 id。 */
  from: string
  /** 终点元件 id。 */
  to: string
  /** 可选连线说明（简短词），沿走线择空落位（先主干、后各段，四向取空处）。 */
  label?: string
}

/** 电路图输入。 */
export type CircuitDiagramInput = {
  /** 元件列表（不得为空；id 不得重复；行列必须是 0 至 200 的整数）。 */
  components: readonly CircuitComponent[]
  /** 连线列表（两端必须是已声明的元件 id）。 */
  connections: readonly CircuitConnection[]
  /** 单元格宽（毫米），默认 18。 */
  cellWidthMm?: number
  /** 单元格高（毫米），默认 14。 */
  cellHeightMm?: number
}

/** 白名单集合（模型输入是 JSON，kind 需在运行时校验）。 */
const SYMBOL_KINDS: ReadonlySet<string> = new Set<string>(CIRCUIT_SYMBOL_KINDS)

/** 符号宽占单元格宽的比例。 */
const SYMBOL_WIDTH_RATIO = 0.5

/** 符号高占单元格高的比例。 */
const SYMBOL_HEIGHT_RATIO = 0.5

/** 画布四周留白（毫米），容纳元件名与连线说明。 */
const CANVAS_MARGIN_MM = 6

/** 网格行列索引上限：超限拒绝，避免画布与走线数量爆炸。 */
const MAX_GRID_INDEX = 200

/** 默认单元格宽（毫米）。 */
const DEFAULT_CELL_WIDTH_MM = 18

/** 默认单元格高（毫米）。 */
const DEFAULT_CELL_HEIGHT_MM = 14

/** 连线线宽（毫米）：细实线，压在 0.35mm 的符号轮廓之下。 */
const WIRE_STROKE_WIDTH_MM = 0.25

/** T 形结点连接点半径（毫米）。 */
const JUNCTION_RADIUS_MM = 0.5

/** 图面文字字号（毫米）。 */
const LABEL_FONT_SIZE_MM = 3

/** 图面文字与符号方框、走线的最小间距（毫米）。 */
const LABEL_GAP_MM = 1.2

/** 走线线段（两端点，毫米）：文字落位时的障碍。 */
type WireSegment = readonly [readonly [number, number], readonly [number, number]]

/** 文字候选落位：基线锚点与水平对齐。 */
type LabelSlot = { readonly at: Point; readonly anchor: GlyphTextAnchor }

/** 元件端口所在边。 */
type PinSide = 'left' | 'right' | 'top' | 'bottom'

/** 两端口元件的长边轴向（纵向符号由横向画法旋转得到）。 */
type SymbolOrientation = 'horizontal' | 'vertical'

/** 毫米坐标点。 */
type Point = { x: number; y: number }

/** 元件端口：所在边与坐标。 */
type Pin = { side: PinSide; x: number; y: number }

/** 元件在画布上的几何。 */
type ComponentGeometry = {
  /** 符号中心 x（毫米）。 */
  cx: number
  /** 符号中心 y（毫米）。 */
  cy: number
  /** 符号半宽（毫米）。 */
  hw: number
  /** 符号半高（毫米）。 */
  hh: number
  /** 长边轴向。 */
  orientation: SymbolOrientation
}

/** 符号的外接半尺寸（毫米）：绘制范围可能超出半宽与半高。 */
type SymbolExtent = { readonly halfX: number; readonly halfY: number }

/** 已放置元件：输入元件、几何、端口与图面文字。 */
type PlacedComponent = {
  /** 对应的输入元件。 */
  component: CircuitComponent
  /** 画布几何。 */
  geometry: ComponentGeometry
  /** 符号的外接半尺寸（文字落位与避让按它计算）。 */
  extent: SymbolExtent
  /** 端口（至少一个，供路由选取）。 */
  pins: readonly [Pin, ...Pin[]]
  /** 图面文字（label 为空时不下笔）。 */
  label: string | undefined
}

/** 连线端点计数：T 形结点判定用。 */
type EndpointCount = { point: Point; count: number }

/** 文本节点转义（元件名与连线说明可含 & < >）。 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 输出一条线段（继承外壳的黑色描边；线条不设 fill）。 */
function line(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"/>`
}

/** 输出一个矩形。 */
function rect(x: number, y: number, width: number, height: number): string {
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"/>`
}

/** 输出一条走线：一次成段（避免分段落笔的接头缺口），线宽取细实线。 */
function polyline(points: readonly Point[]): string {
  const coordinates = points.map(point => `${fmt(point.x)},${fmt(point.y)}`).join(' ')
  return `<polyline points="${coordinates}" stroke-width="${WIRE_STROKE_WIDTH_MM}"/>`
}

/**
 * 输出图面文字；文本必须自带黑色填充并取消描边，否则继承外壳的
 * `fill="none"` 而在图面上不可见。
 */
function textElement(x: number, y: number, content: string, anchor: GlyphTextAnchor): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${LABEL_FONT_SIZE_MM}" text-anchor="${anchor}" fill="#000000" stroke="none">${escapeText(content)}</text>`
}

/** 实心箭头（NPN 发射极）：从 from 指向 tip，size 为箭头长度。 */
function arrowHead(fromX: number, fromY: number, tipX: number, tipY: number, size: number): string {
  const length = Math.hypot(tipX - fromX, tipY - fromY)
  const ux = (tipX - fromX) / length
  const uy = (tipY - fromY) / length
  const baseX = tipX - ux * size
  const baseY = tipY - uy * size
  const halfWidth = size * 0.4
  const points = [
    `${fmt(tipX)},${fmt(tipY)}`,
    `${fmt(baseX - uy * halfWidth)},${fmt(baseY + ux * halfWidth)}`,
    `${fmt(baseX + uy * halfWidth)},${fmt(baseY - ux * halfWidth)}`,
  ].join(' ')
  return `<polygon points="${points}" fill="#000000" stroke="none"/>`
}

/** 两端口符号的引出线：左右端口连到符号本体（随组旋转为纵向）。 */
function leads(cx: number, cy: number, hw: number, bodyHalfWidth: number): string {
  return line(cx - hw, cy, cx - bodyHalfWidth, cy) + line(cx + bodyHalfWidth, cy, cx + hw, cy)
}

/**
 * 纵向符号的旋转外壳：横向画法绕中心旋转 90°，得到长边竖直的同形符号。
 * @param orientation - 符号轴向。
 * @param cx - 中心 x（毫米）。
 * @param cy - 中心 y（毫米）。
 * @param elements - 横向画法的元素片段。
 * @returns 纵向时为旋转组，横向时为原片段。
 */
function oriented(orientation: SymbolOrientation, cx: number, cy: number, elements: string): string {
  return orientation === 'vertical' ? `<g transform="rotate(90 ${fmt(cx)} ${fmt(cy)})">${elements}</g>` : elements
}

/** 电阻：矩形，长边随接线轴向。 */
function drawResistor({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const thickness = hh * 0.6
  return oriented(orientation, cx, cy, rect(cx - hw, cy - thickness / 2, hw * 2, thickness))
}

/** 电容：两条平行短线（垂直于接线轴向），两端带引出线。 */
function drawCapacitor({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const plate = hh * 0.9
  const gap = hw * 0.25
  const plates = line(cx - gap, cy - plate, cx - gap, cy + plate) + line(cx + gap, cy - plate, cx + gap, cy + plate)
  return oriented(orientation, cx, cy, leads(cx, cy, hw, gap) + plates)
}

/** 电感：沿接线轴向的连续半圆弧（四段弧占满符号宽）。 */
function drawInductor({ cx, cy, hw, orientation }: ComponentGeometry): string {
  const radius = hw / 4
  const bump = ` a ${fmt(radius)} ${fmt(radius)} 0 0 1 ${fmt(radius * 2)} 0`
  return oriented(orientation, cx, cy, `<path d="M ${fmt(cx - hw)} ${fmt(cy)}${bump.repeat(4)}"/>`)
}

/** 二极管：三角加阴极竖线（三角占满符号宽，不再画引出线）。 */
function drawDiode({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const triangle = `<polygon points="${fmt(cx - hw)},${fmt(cy - hh)} ${fmt(cx - hw)},${fmt(cy + hh)} ${fmt(cx + hw)},${fmt(cy)}"/>`
  const cathode = line(cx + hw, cy - hh, cx + hw, cy + hh)
  return oriented(orientation, cx, cy, triangle + cathode)
}

/** 电池：两组长短线对（双电芯），带引出线。 */
function drawBattery({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const offsets = [-hw * 0.65, -hw * 0.25, hw * 0.25, hw * 0.65]
  const plates = offsets
    .map((offset, index) => {
      const half = index % 2 === 0 ? hh : hh * 0.55
      return line(cx + offset, cy - half, cx + offset, cy + half)
    })
    .join('')
  return oriented(orientation, cx, cy, leads(cx, cy, hw, hw * 0.65) + plates)
}

/** 电压源：一组长短线对（单电芯），带引出线。 */
function drawVoltageSource({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const offset = hw * 0.2
  const plates = line(cx - offset, cy - hh, cx - offset, cy + hh) + line(cx + offset, cy - hh * 0.55, cx + offset, cy + hh * 0.55)
  return oriented(orientation, cx, cy, leads(cx, cy, hw, offset) + plates)
}

/** 接地：上端口引下线接三级递减横线（端口恒在上边，故不随轴向旋转）。 */
function drawGround({ cx, cy, hw, hh }: ComponentGeometry): string {
  const step = hh * 0.35
  return line(cx, cy - hh, cx, cy)
    + line(cx - hw, cy, cx + hw, cy)
    + line(cx - hw * 0.6, cy + step, cx + hw * 0.6, cy + step)
    + line(cx - hw * 0.25, cy + step * 2, cx + hw * 0.25, cy + step * 2)
}

/** 开关：斜线刀闸断开一个触点连线。 */
function drawSwitch({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const contact = hw * 0.4
  const blade = line(cx - contact, cy, cx + contact, cy - hh * 0.9)
  return oriented(orientation, cx, cy, line(cx - hw, cy, cx - contact, cy) + blade + line(cx + contact, cy, cx + hw, cy))
}

/** 灯泡：圆内叉，带引出线。 */
function drawLamp({ cx, cy, hw, hh, orientation }: ComponentGeometry): string {
  const radius = Math.min(hw, hh) * 0.9
  const arm = radius * Math.SQRT1_2
  const circle = `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}"/>`
  const cross = line(cx - arm, cy - arm, cx + arm, cy + arm) + line(cx - arm, cy + arm, cx + arm, cy - arm)
  return oriented(orientation, cx, cy, leads(cx, cy, hw, radius) + circle + cross)
}

/** NPN 晶体管几何：基极竖线、集电极与发射极引出线的横向位置（画法与端口共用）。 */
function npnGeometry({ cx, hw, hh }: ComponentGeometry): { radius: number; baseX: number; leadX: number } {
  const radius = Math.min(hw, hh) * 0.95
  return { radius, baseX: cx - radius * 0.45, leadX: cx + radius * 0.45 }
}

/** NPN 晶体管：圆 + 基极竖线 + 两条斜线 + 发射极实心箭头；端口固定为基极、集电极、发射极，故不随轴向旋转。 */
function drawNpnTransistor(geometry: ComponentGeometry): string {
  const { cx, cy, hw, hh } = geometry
  const { radius, baseX, leadX } = npnGeometry(geometry)
  const collectorY = cy - radius * 0.75
  const emitterY = cy + radius * 0.75
  return [
    `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}"/>`,
    line(cx - hw, cy, baseX, cy),
    line(baseX, cy - radius * 0.6, baseX, cy + radius * 0.6),
    line(baseX, cy - radius * 0.35, leadX, collectorY) + line(leadX, collectorY, leadX, cy - hh),
    line(baseX, cy + radius * 0.35, leadX, emitterY) + line(leadX, emitterY, leadX, cy + hh),
    arrowHead(baseX, cy + radius * 0.35, leadX, emitterY, radius * 0.5),
  ].join('')
}

/** 每种符号的绘制函数。 */
const SYMBOL_DRAWERS: Record<CircuitSymbolKind, (geometry: ComponentGeometry) => string> = {
  resistor: drawResistor,
  capacitor: drawCapacitor,
  inductor: drawInductor,
  diode: drawDiode,
  battery: drawBattery,
  ground: drawGround,
  switch: drawSwitch,
  lamp: drawLamp,
  npn_transistor: drawNpnTransistor,
  voltage_source: drawVoltageSource,
}

/** 两端口元件的端口：随轴向取左右边或上下边。 */
function twoPinPins({ cx, cy, hw, hh, orientation }: ComponentGeometry): readonly [Pin, Pin] {
  return orientation === 'horizontal'
    ? [{ side: 'left', x: cx - hw, y: cy }, { side: 'right', x: cx + hw, y: cy }]
    : [{ side: 'top', x: cx, y: cy - hh }, { side: 'bottom', x: cx, y: cy + hh }]
}

/** 接地只有一个端口：符号上边的引出线起点。 */
function groundPin({ cx, cy, hh }: ComponentGeometry): readonly [Pin] {
  return [{ side: 'top', x: cx, y: cy - hh }]
}

/** NPN 晶体管端口：基极在左边，集电极在上边，发射极在下边。 */
function npnPins(geometry: ComponentGeometry): readonly [Pin, Pin, Pin] {
  const { cx, cy, hw, hh } = geometry
  const { leadX } = npnGeometry(geometry)
  return [
    { side: 'left', x: cx - hw, y: cy },
    { side: 'top', x: leadX, y: cy - hh },
    { side: 'bottom', x: leadX, y: cy + hh },
  ]
}

/** 每种符号的端口。 */
const SYMBOL_PINS: Record<CircuitSymbolKind, (geometry: ComponentGeometry) => readonly [Pin, ...Pin[]]> = {
  resistor: twoPinPins,
  capacitor: twoPinPins,
  inductor: twoPinPins,
  diode: twoPinPins,
  battery: twoPinPins,
  ground: groundPin,
  switch: twoPinPins,
  lamp: twoPinPins,
  npn_transistor: npnPins,
  voltage_source: twoPinPins,
}

/** 累计元件的行列跨度，用于判定符号长边轴向。 */
function accumulateSpan(spans: Map<string, { cols: number; rows: number }>, id: string, cols: number, rows: number): void {
  const span = spans.get(id)
  if (span === undefined) {
    spans.set(id, { cols, rows })
    return
  }
  span.cols += cols
  span.rows += rows
}

/** 取已放置元件；缺失意味着连线端点在元件列表中不存在（校验在放置之后统一报错）。 */
function requirePlaced(placed: Map<string, PlacedComponent>, id: string): PlacedComponent {
  const entry = placed.get(id)
  if (entry === undefined) {
    throw new VectorFigureError('invalid_input', `连线端点是未声明的元件：${id}`)
  }
  return entry
}

/** 选取朝向对方中心的端口（端口离对方中心最近者）。 */
function pickPin(pins: readonly [Pin, ...Pin[]], targetX: number, targetY: number): Pin {
  let best = pins[0]
  let bestDistance = Math.hypot(best.x - targetX, best.y - targetY)
  for (const pin of pins.slice(1)) {
    const distance = Math.hypot(pin.x - targetX, pin.y - targetY)
    if (distance < bestDistance) {
      best = pin
      bestDistance = distance
    }
  }
  return best
}

/** 端口外法线方向（单位向量）。 */
function outDirection(side: PinSide): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
  }
}

/**
 * 正交走线：两端先沿端口外法线引出 stub，再在 stub 之间折一次，最后沿目标端口
 * 的外法线入线。引出段把走线推到符号本体之外，使折线不压在元件图形上。
 * @param from - 起点端口。
 * @param to - 终点端口。
 * @param stub - 引出段长度（毫米）。
 * @returns 折线点（含起止端口，已去除重合点）。
 */
function routePoints(from: Pin, to: Pin, stub: number): Point[] {
  const fromOut = outDirection(from.side)
  const toOut = outDirection(to.side)
  const fromStub = { x: from.x + fromOut.x * stub, y: from.y + fromOut.y * stub }
  const toStub = { x: to.x + toOut.x * stub, y: to.y + toOut.y * stub }
  const elbow = fromOut.x === 0 ? { x: toStub.x, y: fromStub.y } : { x: fromStub.x, y: toStub.y }
  return compactPoints([from, fromStub, elbow, toStub, to])
}

/** 去掉重合点：同轴端口的中线折线退化为直线时不留零长线段。 */
function compactPoints(points: readonly Point[]): Point[] {
  const compact: Point[] = []
  for (const point of points) {
    const last = compact.at(-1)
    if (last === undefined || last.x !== point.x || last.y !== point.y) compact.push(point)
  }
  return compact
}

/** 走线的一段：两端点与长度（连线说明按段长排队落位）。 */
type WireLine = { readonly from: Point; readonly to: Point; readonly span: number }

/** 折线的各段，按长度降序（并列保持折线顺序）：连线说明首选落在走线主干上。 */
function wireLines(points: readonly Point[]): WireLine[] {
  const lines: WireLine[] = []
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index] as Point
    const to = points[index + 1] as Point
    lines.push({ from, to, span: Math.hypot(to.x - from.x, to.y - from.y) })
  }
  return lines.sort((left, right) => right.span - left.span)
}

/** 走线段转成障碍判定用的端点对。 */
function wireSegment(line: WireLine): WireSegment {
  return [[line.from.x, line.from.y], [line.to.x, line.to.y]]
}

/** 两个文字占位框是否相交（贴边不算）。 */
function boxesOverlap(a: GlyphBox, b: GlyphBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
}

/** 画法不随轴向旋转的符号：接地与晶体管的端口固定，图形也照固定方向绘制。 */
const AXIS_FIXED_SYMBOLS: ReadonlySet<CircuitSymbolKind> = new Set<CircuitSymbolKind>(['ground', 'npn_transistor'])

/**
 * 符号的外接半尺寸（毫米）：纵向元件是横向画法整体绕中心旋转 90° 的结果，长边因此落到
 * y（比端口所在的半高高出半宽减半高），横向与固定朝向的符号为半宽 × 半高。
 * @param kind - 符号种类。
 * @param orientation - 符号轴向。
 * @param hw - 符号半宽（毫米）。
 * @param hh - 符号半高（毫米）。
 * @returns 外接半尺寸。
 */
function symbolExtent(kind: CircuitSymbolKind, orientation: SymbolOrientation, hw: number, hh: number): SymbolExtent {
  return orientation === 'vertical' && !AXIS_FIXED_SYMBOLS.has(kind) ? { halfX: hh, halfY: hw } : { halfX: hw, halfY: hh }
}

/** 符号外接框：文字落位时首选避开的对象（符号框按外接矩形算，四角通常是空的）。 */
function symbolBox(geometry: ComponentGeometry, extent: SymbolExtent): GlyphBox {
  return {
    minX: geometry.cx - extent.halfX,
    minY: geometry.cy - extent.halfY,
    maxX: geometry.cx + extent.halfX,
    maxY: geometry.cy + extent.halfY,
  }
}

/**
 * 一段走线四向的候选落位：竖直段先取左右、水平段先取上下。
 *
 * 竖直段的说明写在右侧（写在正上／正下会被同向的走线穿过），水平段的说明写在线的
 * 上方或下方（写在左右两侧会被走线的拐角穿过）。
 * @param line - 走线段。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 四个候选落位。
 */
function lineSlots(line: WireLine, fontSizeMm: number): readonly [LabelSlot, LabelSlot, LabelSlot, LabelSlot] {
  const at = { x: (line.from.x + line.to.x) / 2, y: (line.from.y + line.to.y) / 2 }
  const ascent = fontSizeMm * GLYPH_ASCENT_RATIO
  const middleY = at.y + (ascent - fontSizeMm * GLYPH_DESCENT_RATIO) / 2
  const right: LabelSlot = { at: { x: at.x + LABEL_GAP_MM, y: middleY }, anchor: 'start' }
  const left: LabelSlot = { at: { x: at.x - LABEL_GAP_MM, y: middleY }, anchor: 'end' }
  const above: LabelSlot = { at: { x: at.x, y: at.y - LABEL_GAP_MM }, anchor: 'middle' }
  const below: LabelSlot = { at: { x: at.x, y: at.y + LABEL_GAP_MM + ascent }, anchor: 'middle' }
  return Math.abs(line.to.y - line.from.y) > Math.abs(line.to.x - line.from.x)
    ? [right, left, above, below]
    : [above, below, right, left]
}

/**
 * 连线说明的候选落位：沿走线各段的中点取四个方向的落点，长段在前。
 *
 * 只取一段会把文字逼进 U 形走线的内圈 —— 四向落点都被同一段走线穿过；沿走线换一段
 * 落位即可让开。
 * @param lines - 走线各段（长段在前）。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 候选落位。
 */
function connectionSlots(lines: readonly WireLine[], fontSizeMm: number): readonly [LabelSlot, ...LabelSlot[]] {
  const slots: LabelSlot[] = []
  for (const line of lines) slots.push(...lineSlots(line, fontSizeMm))
  // 端口的引出段长于零，折线至少有两点，故段列表非空。
  return slots as [LabelSlot, ...LabelSlot[]]
}

/**
 * 元件名四周的八个候选落位：元件名原先是符号正上方居中，那里正是上端口走线（竖向
 * 引出段）经过的地方，名字因此被走线贯穿；上左／上右／右中／左中／下方各留一个候选
 * 供让位。
 * @param geometry - 元件几何。
 * @param extent - 符号外接半尺寸（毫米）。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 候选落位（上中、上左、上右、右中、左中、下中、下左、下右）。
 */
function componentSlots(
  geometry: ComponentGeometry,
  extent: SymbolExtent,
  fontSizeMm: number,
): readonly [LabelSlot, ...LabelSlot[]] {
  const { cx, cy } = geometry
  const { halfX, halfY } = extent
  const rowX = halfX + LABEL_GAP_MM
  const rowY = halfY + LABEL_GAP_MM
  const ascent = fontSizeMm * GLYPH_ASCENT_RATIO
  const middleY = cy + (ascent - fontSizeMm * GLYPH_DESCENT_RATIO) / 2
  return [
    { at: { x: cx, y: cy - rowY }, anchor: 'middle' },
    { at: { x: cx - halfX, y: cy - rowY }, anchor: 'start' },
    { at: { x: cx + halfX, y: cy - rowY }, anchor: 'end' },
    { at: { x: cx + rowX, y: middleY }, anchor: 'start' },
    { at: { x: cx - rowX, y: middleY }, anchor: 'end' },
    { at: { x: cx, y: cy + rowY + ascent }, anchor: 'middle' },
    { at: { x: cx - halfX, y: cy + rowY + ascent }, anchor: 'start' },
    { at: { x: cx + halfX, y: cy + rowY + ascent }, anchor: 'end' },
  ]
}

/**
 * 文字落位：逐条试候选位置，取第一个满足硬约束者 —— 不被走线穿过、不与已落位文字外框
 * 相交、完全落在画布内。元件符号外接框是软约束：首选同时避开符号的候选，一个也没有时
 * 退让给首个只满足硬约束的候选（符号框按外接矩形算，四角通常是空的，压框不等于压图）。
 * 连软约束都无法满足时退回首选候选，此时文字与图面的关系由渲染复核报出。
 * @param content - 文字内容（决定占位框宽度）。
 * @param slots - 候选落位（首选在前）。
 * @param obstacles - 走线线段、元件符号外框与已落位文字外框。
 * @param canvas - 画布尺寸（毫米）。
 * @returns 落位锚点与水平对齐。
 */
function placeLabel(
  content: string,
  slots: readonly [LabelSlot, ...LabelSlot[]],
  obstacles: {
    readonly wires: readonly WireSegment[]
    readonly squares: readonly GlyphBox[]
    readonly boxes: readonly GlyphBox[]
  },
  canvas: { readonly widthMm: number; readonly heightMm: number },
): LabelSlot {
  let clearOfLines: LabelSlot | undefined
  for (const slot of slots) {
    const box = glyphBox(content, [slot.at.x, slot.at.y], LABEL_FONT_SIZE_MM, slot.anchor)
    if (box.minX < 0 || box.minY < 0 || box.maxX > canvas.widthMm || box.maxY > canvas.heightMm) continue
    if (obstacles.wires.some(segment => boxCrossedBySegment(box, segment[0], segment[1]))) continue
    if (obstacles.boxes.some(other => boxesOverlap(box, other))) continue
    if (!obstacles.squares.some(square => boxesOverlap(box, square))) return slot
    clearOfLines ??= slot
  }
  return clearOfLines ?? slots[0]
}

/** 记录一个接线端点，用于 T 形结点计数。 */
function countEndpoint(endpoints: Map<string, EndpointCount>, point: Point): void {
  const key = `${fmt(point.x)},${fmt(point.y)}`
  const entry = endpoints.get(key)
  if (entry === undefined) {
    endpoints.set(key, { point, count: 1 })
    return
  }
  entry.count += 1
}

/** T 形结点连接点：实心圆（≥3 条连线共用一点时图面必须有结点）。 */
function junctionDot(point: Point): string {
  return `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${JUNCTION_RADIUS_MM}" fill="#000000" stroke="none"/>`
}

/**
 * 构建电路图矢量片段：校验输入、按网格放置元件、正交连线并收集图面词语。
 *
 * 画布尺寸由最大行列推出（每边留 6mm 空白），所有坐标经
 * fmt 格式化后写入片段；元件符号压在连线上层，T 形结点最后落笔。
 * @param input - 元件、连线与单元格尺寸。
 * @returns 毫米画布尺寸、黑色 SVG 片段与图面词语（连线说明在前、元件名在后，按绘制顺序）。
 * @throws VectorFigureError 元件为空（'empty_input'）或校验不通过（'invalid_input'）时。
 */
export function buildCircuitDiagram(input: CircuitDiagramInput): VectorFigureSpec {
  const { components, connections } = input
  if (components.length === 0) {
    throw new VectorFigureError('empty_input', '电路图至少需要一个元件')
  }
  const cellWidthMm = input.cellWidthMm ?? DEFAULT_CELL_WIDTH_MM
  const cellHeightMm = input.cellHeightMm ?? DEFAULT_CELL_HEIGHT_MM
  if (!(cellWidthMm > 0)) {
    throw new VectorFigureError('invalid_input', `单元格宽必须是正有限数（毫米）：${String(cellWidthMm)}`)
  }
  if (!(cellHeightMm > 0)) {
    throw new VectorFigureError('invalid_input', `单元格高必须是正有限数（毫米）：${String(cellHeightMm)}`)
  }

  const byId = new Map<string, CircuitComponent>()
  let maxCol = 0
  let maxRow = 0
  for (const component of components) {
    if (!Number.isInteger(component.col) || component.col < 0 || component.col > MAX_GRID_INDEX) {
      throw new VectorFigureError('invalid_input', `元件 ${component.id} 的列号必须是 0 至 ${MAX_GRID_INDEX} 的整数：${String(component.col)}`)
    }
    if (!Number.isInteger(component.row) || component.row < 0 || component.row > MAX_GRID_INDEX) {
      throw new VectorFigureError('invalid_input', `元件 ${component.id} 的行号必须是 0 至 ${MAX_GRID_INDEX} 的整数：${String(component.row)}`)
    }
    if (!SYMBOL_KINDS.has(component.kind)) {
      throw new VectorFigureError('invalid_input', `未知电路符号：${component.kind}`)
    }
    if (byId.has(component.id)) {
      throw new VectorFigureError('invalid_input', `元件 id 重复：${component.id}`)
    }
    byId.set(component.id, component)
    maxCol = Math.max(maxCol, component.col)
    maxRow = Math.max(maxRow, component.row)
  }

  // 元件长边轴向由相关连线的行列跨度决定；未知端点在这趟跳过，由路由趟统一报错。
  const spans = new Map<string, { cols: number; rows: number }>()
  for (const connection of connections) {
    const from = byId.get(connection.from)
    const to = byId.get(connection.to)
    if (from === undefined || to === undefined) continue
    const cols = Math.abs(to.col - from.col)
    const rows = Math.abs(to.row - from.row)
    accumulateSpan(spans, from.id, cols, rows)
    accumulateSpan(spans, to.id, cols, rows)
  }

  const hw = (cellWidthMm * SYMBOL_WIDTH_RATIO) / 2
  const hh = (cellHeightMm * SYMBOL_HEIGHT_RATIO) / 2
  const placed = new Map<string, PlacedComponent>()
  for (const component of components) {
    const span = spans.get(component.id)
    const orientation: SymbolOrientation = span !== undefined && span.rows > span.cols ? 'vertical' : 'horizontal'
    const geometry: ComponentGeometry = {
      cx: CANVAS_MARGIN_MM + (component.col + 0.5) * cellWidthMm,
      cy: CANVAS_MARGIN_MM + (component.row + 0.5) * cellHeightMm,
      hw,
      hh,
      orientation,
    }
    placed.set(component.id, {
      component,
      geometry,
      extent: symbolExtent(component.kind, orientation, hw, hh),
      pins: SYMBOL_PINS[component.kind](geometry),
      label: component.label,
    })
  }

  const canvas = {
    widthMm: (maxCol + 1) * cellWidthMm + CANVAS_MARGIN_MM * 2,
    heightMm: (maxRow + 1) * cellHeightMm + CANVAS_MARGIN_MM * 2,
  }
  const body: string[] = []
  const labels: string[] = []
  const endpoints = new Map<string, EndpointCount>()
  const wires: WireSegment[] = []
  const textBoxes: GlyphBox[] = []
  const routes: { readonly label: string | undefined; readonly lines: readonly WireLine[] }[] = []
  for (const connection of connections) {
    const from = requirePlaced(placed, connection.from)
    const to = requirePlaced(placed, connection.to)
    const start = pickPin(from.pins, to.geometry.cx, to.geometry.cy)
    const end = pickPin(to.pins, from.geometry.cx, from.geometry.cy)
    const points = routePoints(start, end, Math.min(hw, hh))
    const lines = wireLines(points)
    countEndpoint(endpoints, start)
    countEndpoint(endpoints, end)
    body.push(polyline(points))
    wires.push(...lines.map(wireSegment))
    routes.push({ label: connection.label, lines })
  }

  const obstacles = {
    wires,
    squares: [...placed.values()].map(entry => symbolBox(entry.geometry, entry.extent)),
    boxes: textBoxes,
  }
  // 全部走线落笔后再放文字：走线不避让文字，故文字的候选位置要对全部走线成立。
  for (const route of routes) {
    if (route.label === undefined || route.label === '') continue
    const slot = placeLabel(route.label, connectionSlots(route.lines, LABEL_FONT_SIZE_MM), obstacles, canvas)
    body.push(textElement(slot.at.x, slot.at.y, route.label, slot.anchor))
    textBoxes.push(glyphBox(route.label, [slot.at.x, slot.at.y], LABEL_FONT_SIZE_MM, slot.anchor))
    labels.push(route.label)
  }

  for (const { component, geometry, extent, label } of placed.values()) {
    body.push(SYMBOL_DRAWERS[component.kind](geometry))
    if (label !== undefined && label !== '') {
      const slot = placeLabel(label, componentSlots(geometry, extent, LABEL_FONT_SIZE_MM), obstacles, canvas)
      body.push(textElement(slot.at.x, slot.at.y, label, slot.anchor))
      textBoxes.push(glyphBox(label, [slot.at.x, slot.at.y], LABEL_FONT_SIZE_MM, slot.anchor))
      labels.push(label)
    }
  }

  for (const { point, count } of endpoints.values()) {
    if (count >= 2) body.push(junctionDot(point))
  }

  return {
    ...canvas,
    body: body.join('\n'),
    labels,
  }
}
