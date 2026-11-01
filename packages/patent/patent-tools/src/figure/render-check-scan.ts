/**
 * SVG 图面扫描：把矢量源按文档序遍历成根坐标系下的描边图形与文字。
 *
 * 这是 `render-check` 的量测前端；复核判据在 `render-check.ts`。输入安全检查仍由
 * 调用方在扫描前执行（{@link scanSvg} 本身只读文本）。
 * @module @deepseek-ai/dsh-patent-tools/figure/render-check-scan
 */

import { glyphBox } from './glyph-box.ts'
import type { GlyphBox, GlyphQuad, GlyphTextAnchor } from './glyph-box.ts'
import { MM_PER_USER_UNIT, parseLengthMm, resolveSvgViewport } from './svg-viewport.ts'

/**
 * 绘图侧标注同一材料轮廓分组的属性名（见 `section-diagram.ts` 的 `polygonElement`）。
 * 同一零件的多个轮廓各给一段是输入约定；没有这个标注时复核只能把每段各自当成一件。
 */
const HATCH_GROUP_ATTRIBUTE = 'data-dsh-hatch-group'
/**
 * 绘图侧标注线段角色的属性名（见 `section-diagram.ts` 的 `segmentElement`）：值为
 * {@link LEADER_ROLE} 的线段是引线。引线止于文字占位框外框，参与「贯穿」判定才有的
 * 可读性；「净距」判据必须排除它，否则工具自己画的每条引线都会被报成贴线。
 */
const ROLE_ATTRIBUTE = 'data-dsh-role'
/** 引线的角色取值。 */
export const LEADER_ROLE = 'leader'
const DEFAULT_STROKE_WIDTH = 1
/**
 * SVG 未声明 `font-size` 时的初值（用户单位，即 CSS 的 `medium` = 16 px）。
 * 本机 Inkscape 1.4.4 对缺省字号实测约 12 用户单位，取 16（规范初值）偏保守：
 * 估出的占位框更大，漏报少、误报多，而漏报的代价是交付了读不出的图。
 */
const DEFAULT_FONT_SIZE_USER = 16
/** 圆与椭圆的折线近似边数：内接多边形的最大径向误差约 0.9%，足以量测描边与包围盒。 */
const CIRCLE_GON_SEGMENTS = 24
/** 定义容器：其子元素只被引用而不直接渲染，整段跳过（`<use>` 引用单独报未量测）。 */
const DEFINITION_CONTAINERS = new Set([
  'defs', 'clippath', 'mask', 'marker', 'pattern', 'symbol', 'filter', 'lineargradient', 'radialgradient',
])

/** 二维点（用户单位）。 */
export type Point = readonly [number, number]
/** 线段（用户单位）。 */
export type Segment = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
/** 顶点表（用户单位）。 */
export type Poly = readonly Point[]
/** 子路径：顶点序列与是否闭合（闭合子路径隐含最后一点回到首点）。 */
export type SubPath = { readonly points: Poly; readonly closed: boolean }
/** 仿射矩阵 `[a b c d e f]`：`x' = a·x + c·y + e`、`y' = b·x + d·y + f`（SVG `matrix()` 同序）。 */
type Matrix = readonly [number, number, number, number, number, number]
/** 文字占位框经变换后的像：`O`、`O+e1`、`O+e1+e2`、`O+e2`。 */
type Quad = readonly [Point, Point, Point, Point]

/**
 * 语义分组：Graphviz 把节点与边各自包在 `<g class="node|edge">` 内，节点标签与
 * 节点轮廓、边标签与边路径因此同组。复核据此区分「同一语义元素内部的排版贴靠」
 * 与「跨元素的真实压线」。
 */
type ScanGroup = { readonly id: number; readonly kind: 'node' | 'edge' }

/** 一个描边图形（元素可能含多条子路径）。 */
type Shape = {
  readonly subpaths: readonly SubPath[]
  /** 线宽（毫米，已按元素的累计缩放换算）。 */
  readonly strokeWidthMm: number
  /** 是否描边：`stroke: none` 的填充图元不计入线宽分布，但其几何仍参与贯穿与越界判定。 */
  readonly stroked: boolean
  /** `stroke-dasharray` 的虚线段长（毫米，已按累计缩放换算）；实线元素为 undefined。 */
  readonly dashPatternMm?: readonly number[]
  /** `data-dsh-hatch-group`：同一材料的轮廓共用此值（绘图侧标注）；未标注时为 undefined。 */
  readonly hatchGroup?: number
  /** `data-dsh-role`：绘图侧标注的线段角色；{@link LEADER_ROLE} 表示引线。 */
  readonly role?: string
  /** 该元素的不透明填充是否遮挡其下已绘制的图元（白填充）。 */
  readonly occludes: boolean
  /** 元素在文档序中的位置（0 起）：遮挡只作用于序号更小的图元。 */
  readonly order: number
  /** 所属语义分组（最近一层 `<g class="node|edge">`）；无分组时为 undefined。 */
  readonly group?: ScanGroup
}

/** 一个文字元素：内容与经该元素变换后的文字占位框。 */
export type ScannedText = {
  readonly content: string
  /** 占位框（该元素自身坐标系，用户单位）。 */
  readonly box: GlyphBox
  /** 该元素的累计变换（占位框经它映射到根坐标系）。 */
  readonly matrix: Matrix
  /** 所属语义分组（{@link ScanGroup}）；无分组时为 undefined。 */
  readonly group?: ScanGroup
}

/** 一条落在图面上的线段及其来源。 */
export type DrawnSegment = {
  readonly segment: Segment
  /** 所属图形的文档序（{@link Shape.order}）。 */
  readonly order: number
  /** 所属图形被标注为引线（{@link ROLE_ATTRIBUTE}）。 */
  readonly leader: boolean
  /** 所属语义分组（{@link ScanGroup}）；无分组时为 undefined。 */
  readonly group?: ScanGroup
}

/** 遮挡面：不透明填充的闭合轮廓及其文档序。 */
export type Occluder = { readonly points: Poly; readonly order: number }

/** 轴对齐包围盒（毫米/用户单位，随调用处的坐标系）。 */
export type BoundsBox = {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** 元素按文档序应用后的帧：变换与继承来的样式取值。 */
type Frame = {
  readonly matrix: Matrix
  readonly strokeWidthMm: number
  readonly stroked: boolean
  /** 该元素的不透明填充被视为遮挡面（白填充）；自祖先继承，`fill: none` 起算为假。 */
  readonly occludes: boolean
  /** 字号（用户单位；绘制时按帧矩阵换算到毫米）。 */
  readonly fontSizeUser: number
  /** `text-anchor`（自祖先继承，取值经白名单校验）。 */
  readonly textAnchor: GlyphTextAnchor
  /** 位于不直接渲染的定义容器内、或 `display: none`：子树整体跳过。 */
  readonly skip: boolean
  /** 所属语义分组：`<g class="node|edge">` 建立，后代继承；无分组时为 undefined。 */
  readonly group?: ScanGroup
}

/** 一张 SVG 的图面事实。 */
export type Scan = {
  readonly widthMm: number | undefined
  readonly heightMm: number | undefined
  readonly shapes: readonly Shape[]
  readonly texts: readonly ScannedText[]
  /** 未量测原因（去重，按首次出现顺序）。 */
  readonly unmeasured: readonly string[]
}

/** 图元的几何：认识的图形给出子路径，其余元素无几何。 */
type ElementGeometry =
  | { readonly kind: 'paths'; readonly subpaths: readonly SubPath[] }
  | { readonly kind: 'none' }

/** 无几何的图元（自闭合标记与解析失败共用）。 */
const NO_GEOMETRY: ElementGeometry = { kind: 'none' }
/** 单位矩阵。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
/** 匹配任意元素起止标签：组 1 = `/` 关闭标记，组 2 = 元素名，组 3 = 属性原文，组 4 = `/` 自闭合。 */
const TAG_PATTERN = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>])*?)(\/?)>/g

/** 端头标记（`marker-start/mid/end`）：端头画出的箭头墨迹不在量测范围。 */
const MARKER_PATTERN = /\bmarker-(?:start|mid|end)\s*=/

/** `<tspan>` 的位置或位移（`x`/`y`/`dx`/`dy`）：逐行偏移不在量测范围。 */
const TSPAN_OFFSET_PATTERN = /\b(?:x|y|dx|dy)\s*=/

/** 文字基线属性：基线位置不在量测范围。 */
const BASELINE_PATTERN = /\b(?:dominant|alignment)-baseline\s*=/

/** 相对视口的百分比长度：矢量源上无法解析成绝对长度。 */
const PERCENT_LENGTH_PATTERN = /\b(?:x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|stroke-width|stroke-dasharray|font-size)\s*=\s*"[^"]*%/

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return match?.[1]
}

/**
 * 读取行内 `style` 里的声明值（`style="fill:none;stroke-width:0.5"`）。
 * 行内样式优先于表现属性（CSS 层叠），故取值一律经本函数再回落属性。
 * @param tag - 标签原文。
 * @param property - CSS 属性名（不区分大小写）。
 * @returns 声明值；未声明时 undefined。
 */
function styleValue(tag: string, property: string): string | undefined {
  const style = attr(tag, 'style')
  if (style === undefined) return undefined
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim().toLowerCase() === property) return declaration.slice(colon + 1).trim()
  }
  return undefined
}

/** 读取表现属性或行内 `style` 声明（样式优先）。 */
function styled(tag: string, name: string): string | undefined {
  return styleValue(tag, name) ?? attr(tag, name)
}

/** 解析长度（或数值）属性值：百分比与非法文本返回 undefined。 */
function numValue(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.includes('%')) return undefined
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 读取数值属性（行内 `style` 优先）。 */
function num(tag: string, name: string): number | undefined {
  return numValue(styled(tag, name))
}

/**
 * 读取绘图侧标注的轮廓分组号（{@link HATCH_GROUP_ATTRIBUTE}）。
 * @param raw - 属性原文。
 * @returns 非负整数分组号；缺失或非法时 undefined，该轮廓自成一组。
 */
function hatchGroupValue(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * `font-size` 取值 → 用户单位长度。
 *
 * 无单位与 `px` 即用户单位（SVG 1.1 起 1 px = 1 用户单位）；`em` 与 `%` 相对父级字号；
 * `mm`/`cm`/`in`/`pt`/`pc` 按 CSS 的 96 dpi 折算成用户单位（本机 Inkscape 1.4.4 实测：
 * 1:1 毫米文档里 `font-size="3.5mm"` 与 `font-size="13.23px"` 量出同一字高，两者都是
 * 13.23 用户单位）；`ex`/`ch`/`rem` 与视口单位需要字体度量或视口尺寸，无法在矢量源上解析。
 * @param raw - `font-size` 属性原文。
 * @param parentUser - 父级字号（用户单位），供 `em`/`%` 解析。
 * @returns 字号（用户单位）；无法解析时 undefined（调用方按父级字号估算并记未量测）。
 */
function fontSizeUser(raw: string, parentUser: number): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)\s*$/i.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  /* v8 ignore next -- the unit group always participates. */
  switch ((match[2] ?? '').toLowerCase()) {
    case '':
    case 'px':
      return value
    case 'em':
      return value * parentUser
    case '%':
      return (value / 100) * parentUser
    default: {
      const mm = parseLengthMm(raw)
      return mm === undefined ? undefined : mm / MM_PER_USER_UNIT
    }
  }
}

/** `text-anchor` 取值 → 对齐方式；白名单之外的取值按未声明处理（沿用父级）。 */
function textAnchorValue(raw: string | undefined): GlyphTextAnchor | undefined {
  switch (raw) {
    case 'start':
    case 'middle':
    case 'end':
      return raw
    default:
      return undefined
  }
}

/**
 * `fill` 取值是否是遮挡面：不透明且为白的填充。
 *
 * 只认白：附图是单色线图，白填充是唯一的「遮住下面已画的东西」用法；彩色填充在
 * 本包的两条绘制通路里都不出现，把它也算作遮挡面会在别的用途上误删真缺陷。
 * @param raw - `fill` 属性原文（行内 `style` 优先，调用方已取值）。
 * @returns 遮挡时 true；`none`/`transparent`、彩色、渐变引用与未声明时为 false。
 */
function occludingFill(raw: string | undefined): boolean {
  /* v8 ignore next -- childFrame calls this only when a fill value is declared. */
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase().replace(/\s+/g, '')
  return value === 'white' || value === '#fff' || value === '#ffffff'
    || value === 'rgb(255,255,255)' || value === 'rgb(100%,100%,100%)'
}

/**
 * `stroke-dasharray` 取值 → 虚线段长（用户单位）。
 * @param raw - 属性原文。
 * @returns 段长序列；未声明、`none`、取值非法或全为 0（等于实线）时 undefined。
 */
function dashPatternUser(raw: string | undefined): readonly number[] | undefined {
  if (raw === undefined || raw.trim().toLowerCase() === 'none') return undefined
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  /* v8 ignore next -- split always yields at least one element, so the empty guard is unreachable. */
  if (parts.length === 0 || parts.some(value => !Number.isFinite(value) || value < 0)) return undefined
  if (parts.every(value => value === 0)) return undefined
  // 奇数个取值按 SVG 规则重复一遍：8 2 0.4 等价于 8 2 0.4 8 2 0.4。
  return parts.length % 2 === 1 ? [...parts, ...parts] : parts
}

/** 矩阵复合：先 `inner` 后 `outer`。 */
function multiply(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ]
}

/** 点经矩阵变换到根坐标系。 */
function mapPoint(matrix: Matrix, point: Point): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ]
}

/** 矩阵的平均缩放 `√|det|`：长度（线宽）按它换算到根坐标系。 */
function scaleOf(matrix: Matrix): number {
  return Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]))
}

/**
 * 单个变换函数的矩阵；函数名未知或参数个数非法时 undefined。
 * @param name - 函数名（区分大小写，SVG 变换函数恒为大写敏感的字面名）。
 * @param args - 已解析的数值参数。
 * @returns 该函数的矩阵；不可识别时 undefined。
 */
function transformStep(name: string, args: readonly number[]): Matrix | undefined {
  const value = (index: number): number => args[index] as number
  switch (name) {
    case 'translate':
      if (args.length !== 1 && args.length !== 2) return undefined
      return [1, 0, 0, 1, value(0), args[1] ?? 0]
    case 'scale':
      if (args.length !== 1 && args.length !== 2) return undefined
      return [value(0), 0, 0, args[1] ?? value(0), 0, 0]
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return undefined
      const radians = (value(0) * Math.PI) / 180
      const rotation: Matrix = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]
      if (args.length === 1) return rotation
      const centre: Matrix = [1, 0, 0, 1, value(1), value(2)]
      const back: Matrix = [1, 0, 0, 1, -value(1), -value(2)]
      return multiply(multiply(centre, rotation), back)
    }
    case 'matrix':
      if (args.length !== 6) return undefined
      return [value(0), value(1), value(2), value(3), value(4), value(5)]
    default:
      return undefined
  }
}

/**
 * 解析 `transform` 属性：`translate`/`scale`/`rotate`/`matrix` 的函数序列复合。
 * @param text - 属性原文；未声明时为 undefined。
 * @returns 矩阵；含未知函数、参数个数或数值非法时为 undefined（该元素未量测）。
 */
function parseTransform(text: string | undefined): Matrix | undefined {
  if (text === undefined) return IDENTITY
  let matrix = IDENTITY
  for (const match of text.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    /* v8 ignore next -- the transform pattern always captures the argument group. */
    const args = (match[2] ?? '').split(/[\s,]+/).filter(part => part !== '').map(Number)
    if (args.some(value => !Number.isFinite(value))) return undefined
    const step = transformStep(match[1] as string, args)
    if (step === undefined) return undefined
    matrix = multiply(matrix, step)
  }
  return matrix
}

/** 路径命令与其参数（`d` 中显式写出的命令各成一组）。 */
type PathGroup = { readonly name: string; readonly args: readonly number[] }

/** 各路径命令的参数个数（小写名）。 */
const PATH_ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

/** 路径解析结果：子路径与是否含曲线（曲线按端点弦近似）。 */
type PathData = { readonly subpaths: readonly SubPath[]; readonly approximate: boolean }

/**
 * 把 `d` 切成命令组：每个命令字母带其后的数值，命令前出现裸数值或参数非数值时 undefined。
 * @param source - 已去首尾空白的 `d` 原文。
 * @returns 命令组；无法切分时 undefined。
 */
function pathGroups(source: string): PathGroup[] | undefined {
  const groups: PathGroup[] = []
  let consumed = 0
  for (const match of source.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
    if (match.index !== consumed) return undefined
    consumed = match.index + match[0].length
    /* v8 ignore next -- the path-group pattern always captures group 2. */
    const raw = (match[2] ?? '').trim()
    const args = raw === '' ? [] : raw.split(/[\s,]+/).map(Number)
    if (args.some(value => !Number.isFinite(value))) return undefined
    groups.push({ name: match[1] as string, args })
  }
  return groups
}

/**
 * 解析 `<path>` 的 `d`：支持 M/L/H/V/Z（含相对形式与隐式重复）；曲线命令 C/S/Q/T/A 一律取其
 * 末点连弦并置 `approximate`；未知命令返回 undefined。
 * @param d - `d` 属性原文。
 * @returns 子路径与近似标记；无法解析时 undefined。
 */
function parsePathData(d: string): PathData | undefined {
  const groups = pathGroups(d.trim())
  if (groups === undefined) return undefined
  const subpaths: SubPath[] = []
  let points: Point[] = []
  let start: Point = [0, 0]
  let current: Point = [0, 0]
  let approximate = false

  /** 收束当前子路径（顶点不足两个时丢弃）。 */
  const flush = (closed: boolean): void => {
    if (points.length >= 2) subpaths.push({ points, closed })
    points = []
  }
  /** 数值参数取绝对或相对坐标下的目标点（`x`/`y` 为该命令的坐标分量）。 */
  const target = (relative: boolean, x: number, y: number): Point =>
    relative ? [current[0] + x, current[1] + y] : [x, y]
  const value = (group: PathGroup, index: number): number => group.args[index] as number

  for (const group of groups) {
    const lower = group.name.toLowerCase()
    const arity = PATH_ARITY[lower]
    if (arity === undefined) return undefined
    // 命令字母小写 = 相对坐标；同时也决定 M 的后续坐标对按 L 处理。
    const relative = group.name === lower
    if (arity === 0) {
      if (group.args.length !== 0) return undefined
      flush(true)
      current = start
      continue
    }
    if (group.args.length === 0 || group.args.length % arity !== 0) return undefined
    for (let offset = 0; offset < group.args.length; offset += arity) {
      // M 的后续坐标对按 L 处理（SVG 的隐式重复规则）。
      const command = lower === 'm' && offset > 0 ? 'l' : lower
      const chunk = { name: group.name, args: group.args.slice(offset, offset + arity) }
      if (command === 'm') {
        flush(false)
        start = target(relative, value(chunk, 0), value(chunk, 1))
        current = start
        points = [start]
        continue
      }
      if (points.length === 0) points = [current]
      if (command === 'l') current = target(relative, value(chunk, 0), value(chunk, 1))
      // H/V 只给一个坐标，另一个分量必须保持不动——走 target 会在绝对形式下把
      // 另一个分量当成 0，之后的相对命令全部从错误的位置累加（Inkscape 的文字
      // 轮廓路径里就混着单个绝对 H/V，量出来的墨迹框会跑到画布外）。
      else if (command === 'h') current = [relative ? current[0] + value(chunk, 0) : value(chunk, 0), current[1]]
      else if (command === 'v') current = [current[0], relative ? current[1] + value(chunk, 0) : value(chunk, 0)]
      else {
        // 曲线命令：只取末点（最后两个参数），曲率本身不量测。
        approximate = true
        const last = arity - 1
        current = target(relative, value(chunk, last - 1), value(chunk, last))
      }
      points.push(current)
    }
  }
  flush(false)
  return { subpaths, approximate }
}

/** 解析 `points` 属性：坐标为成对数值且不少于 `minimum` 个顶点。 */
function parsePoints(raw: string | undefined, minimum: number): Poly | undefined {
  if (raw === undefined) return undefined
  const numbers = raw.trim().split(/[\s,]+/).filter(part => part !== '').map(Number)
  if (numbers.length % 2 !== 0) return undefined
  const points: Point[] = []
  for (let index = 0; index < numbers.length; index += 2) {
    points.push([numbers[index] as number, numbers[index + 1] as number])
  }
  if (points.length < minimum) return undefined
  return points.every(point => Number.isFinite(point[0]) && Number.isFinite(point[1])) ? points : undefined
}

/**
 * 圆/椭圆的折线近似（{@link CIRCLE_GON_SEGMENTS} 个顶点，首顶点在 +x 轴上）。
 * @param cx - 圆心 x。
 * @param cy - 圆心 y。
 * @param rx - 横向半径。
 * @param ry - 纵向半径。
 * @returns 顶点表。
 */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const points: Point[] = []
  for (let index = 0; index < CIRCLE_GON_SEGMENTS; index += 1) {
    const radians = (index * 2 * Math.PI) / CIRCLE_GON_SEGMENTS
    points.push([cx + rx * Math.cos(radians), cy + ry * Math.sin(radians)])
  }
  return points
}

/**
 * 元素的几何：认识的图形元素给出子路径（坐标原始，未变换）。
 * @param name - 元素名（小写）。
 * @param tag - 标签原文。
 * @param note - 记录未量测原因的收集器。
 * @returns 子路径或「无几何」。
 */
function geometryOf(name: string, tag: string, note: (reason: string) => void): ElementGeometry {
  switch (name) {
    case 'line': {
      const x1 = num(tag, 'x1')
      const y1 = num(tag, 'y1')
      const x2 = num(tag, 'x2')
      const y2 = num(tag, 'y2')
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return NO_GEOMETRY
      return { kind: 'paths', subpaths: [{ points: [[x1, y1], [x2, y2]], closed: false }] }
    }
    case 'polyline':
    case 'polygon': {
      const points = parsePoints(attr(tag, 'points'), name === 'polygon' ? 3 : 2)
      if (points === undefined) return NO_GEOMETRY
      return { kind: 'paths', subpaths: [{ points, closed: name === 'polygon' }] }
    }
    case 'rect': {
      const width = num(tag, 'width')
      const height = num(tag, 'height')
      if (width === undefined || height === undefined || width <= 0 || height <= 0) return NO_GEOMETRY
      const x = num(tag, 'x') ?? 0
      const y = num(tag, 'y') ?? 0
      return { kind: 'paths', subpaths: [{ points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true }] }
    }
    case 'circle': {
      const radius = num(tag, 'r')
      if (radius === undefined || radius <= 0) return NO_GEOMETRY
      const points = ellipsePoints(num(tag, 'cx') ?? 0, num(tag, 'cy') ?? 0, radius, radius)
      return { kind: 'paths', subpaths: [{ points, closed: true }] }
    }
    case 'ellipse': {
      const rx = num(tag, 'rx')
      const ry = num(tag, 'ry')
      if (rx === undefined || ry === undefined || rx <= 0 || ry <= 0) return NO_GEOMETRY
      const points = ellipsePoints(num(tag, 'cx') ?? 0, num(tag, 'cy') ?? 0, rx, ry)
      return { kind: 'paths', subpaths: [{ points, closed: true }] }
    }
    case 'path': {
      const d = attr(tag, 'd')
      if (d === undefined) return NO_GEOMETRY
      const parsed = parsePathData(d)
      if (parsed === undefined) {
        note('路径 `d` 含无法解析的命令，该路径的几何未量测')
        return NO_GEOMETRY
      }
      if (parsed.approximate) note('路径含曲线命令（C/S/Q/T/A），曲线段按端点弦近似量测')
      return parsed.subpaths.length === 0 ? NO_GEOMETRY : { kind: 'paths', subpaths: parsed.subpaths }
    }
    default:
      return NO_GEOMETRY
  }
}

/**
 * 子元素的帧：变换与继承来的样式属性覆盖父帧（行内 `style` 优先于表现属性）；
 * 不可识别的 `transform` 返回 undefined（该子树整体未量测）。
 * @param parent - 父元素的帧。
 * @param name - 元素名（小写）。
 * @param tag - 标签原文。
 * @param note - 记录未量测原因的收集器。
 * @returns 该元素的帧；变换不可识别时 undefined。
 */
function childFrame(
  parent: Frame,
  name: string,
  tag: string,
  note: (reason: string) => void,
  nextGroupId: () => number,
): Frame | undefined {
  const transform = parseTransform(styled(tag, 'transform'))
  if (transform === undefined) return undefined
  const groupKind = name === 'g' ? groupKindOf(attr(tag, 'class')) : undefined
  const group = groupKind === undefined ? parent.group : { id: nextGroupId(), kind: groupKind }
  const stroke = styled(tag, 'stroke')
  const fill = styled(tag, 'fill')
  const rawFontSize = styled(tag, 'font-size')
  let fontSize = parent.fontSizeUser
  if (rawFontSize !== undefined) {
    const resolved = fontSizeUser(rawFontSize, parent.fontSizeUser)
    if (resolved === undefined) {
      note('`font-size` 用了需要字体度量或视口的单位（ex/ch/rem/视口单位等），该文字按父级字号估算')
    } else {
      fontSize = resolved
    }
  }
  return {
    matrix: multiply(parent.matrix, transform),
    strokeWidthMm: numValue(styled(tag, 'stroke-width')) ?? parent.strokeWidthMm,
    stroked: stroke === undefined ? parent.stroked : stroke !== 'none',
    occludes: fill === undefined ? parent.occludes : occludingFill(fill),
    fontSizeUser: fontSize,
    textAnchor: textAnchorValue(styled(tag, 'text-anchor')) ?? parent.textAnchor,
    // `display: none` 的子树不渲染：既不算墨迹，也不再逐元素记为未量测。
    skip: parent.skip || styled(tag, 'display') === 'none' || DEFINITION_CONTAINERS.has(name),
    ...(group === undefined ? {} : { group }),
  }
}

/** 从 `class` 属性识别 Graphviz 的语义分组；其他 `<g>` 不建立分组。 */
function groupKindOf(className: string | undefined): 'node' | 'edge' | undefined {
  if (className === undefined) return undefined
  const tokens = className.trim().split(/\s+/)
  if (tokens.includes('node')) return 'node'
  if (tokens.includes('edge')) return 'edge'
  return undefined
}

/**
 * 文字元素记录：内容、占位框与该元素的累计变换。
 * @param content - 文本节点内容（已去标签与首尾空白）。
 * @param tag - `<text>` 标签原文。
 * @param frame - 该元素的帧。
 * @returns 文字记录。
 */
function textEntry(content: string, tag: string, frame: Frame): ScannedText {
  return {
    content,
    box: glyphBox(
      content,
      [num(tag, 'x') ?? 0, num(tag, 'y') ?? 0],
      frame.fontSizeUser,
      frame.textAnchor,
    ),
    matrix: frame.matrix,
    ...(frame.group === undefined ? {} : { group: frame.group }),
  }
}

/**
 * 文字占位框在图面上的像：原点取框左上角的像，两条边向量取框的两条边经同一变换后的像。
 * @param text - 文字记录。
 * @returns 仿射矩形（根坐标系，毫米）。
 */
export function textQuad(text: ScannedText): GlyphQuad {
  const origin = mapPoint(text.matrix, [text.box.minX, text.box.minY])
  const across = mapPoint(text.matrix, [text.box.maxX, text.box.minY])
  const down = mapPoint(text.matrix, [text.box.minX, text.box.maxY])
  return {
    origin,
    edgeWidth: [across[0] - origin[0], across[1] - origin[1]],
    edgeHeight: [down[0] - origin[0], down[1] - origin[1]],
  }
}

/**
 * 仿射矩形的四角（左上、右上、右下、左下）。
 * @param quad - 仿射矩形。
 * @returns 四角坐标。
 */
export function quadCorners(quad: GlyphQuad): Quad {
  const [originX, originY] = quad.origin
  const [widthX, widthY] = quad.edgeWidth
  const [heightX, heightY] = quad.edgeHeight
  return [
    [originX, originY],
    [originX + widthX, originY + widthY],
    [originX + widthX + heightX, originY + widthY + heightY],
    [originX + heightX, originY + heightY],
  ]
}

/**
 * 遍历 SVG：按文档序把每个元素变换到根坐标系，收集描边图形与文字，并记录未量测的原因。
 *
 * 根元素的视口（画布尺寸、viewBox、preserveAspectRatio）由 svg-viewport 解析后作为根帧
 * 的矩阵，故此后所有坐标与长度都是毫米：落版页、拼版页、px 级用户单位的导出文件都换算
 * 到同一口径。
 * @param svg - 完整 SVG 文本。
 * @returns 画布尺寸、图形、文字与未量测原因。
 */
export function scanSvg(svg: string): Scan {
  // 注释里的 `<line …>` 不是图元：先整段去掉，避免把注释当成元素量测。
  const source = svg.replace(/<!--[\s\S]*?-->/g, '')
  const viewport = resolveSvgViewport(/<svg\b[^>]*>/i.exec(source)?.[0] ?? '')
  const root: Frame = {
    matrix: [
      viewport.scaleX,
      0,
      0,
      viewport.scaleY,
      -viewport.originX * viewport.scaleX,
      -viewport.originY * viewport.scaleY,
    ],
    strokeWidthMm: DEFAULT_STROKE_WIDTH,
    stroked: false,
    occludes: false,
    fontSizeUser: DEFAULT_FONT_SIZE_USER,
    textAnchor: 'start',
    skip: false,
  }
  const stack: Frame[] = [root]
  const shapes: Shape[] = []
  const texts: ScannedText[] = []
  const unmeasured: string[] = []
  const note = (reason: string): void => {
    if (!unmeasured.includes(reason)) unmeasured.push(reason)
  }
  if (viewport.note !== undefined) note(viewport.note)
  let rootSvgSeen = false
  let orderCount = 0
  let groupCount = 0
  const nextGroupId = (): number => {
    groupCount += 1
    return groupCount
  }
  let pending: { readonly contentStart: number; readonly tag: string; readonly frame: Frame } | undefined

  for (const match of source.matchAll(TAG_PATTERN)) {
    /* v8 ignore next -- the tag pattern always captures the element name. */
    const name = (match[2] ?? '').toLowerCase()
    const tag = match[0]
    /* v8 ignore next -- the tag pattern always captures the optional closing slash. */
    if ((match[1] ?? '') === '/') {
      if (name === 'text' && pending !== undefined) {
        const content = source.slice(pending.contentStart, match.index).replace(/<[^>]*>/g, '').trim()
        if (content !== '') texts.push(textEntry(content, pending.tag, pending.frame))
        pending = undefined
      }
      if (stack.length > 1) stack.pop()
      continue
    }
    const parent = stack[stack.length - 1] as Frame
    /* v8 ignore next -- the tag pattern always captures the optional self-closing slash. */
    const selfClosing = (match[4] ?? '') === '/'
    const own = childFrame(parent, name, tag, note, nextGroupId)
    if (own === undefined) {
      note('含 `translate`/`scale`/`rotate`/`matrix` 之外的变换（或参数非法），相关图元的几何未量测')
      if (!selfClosing) stack.push({ ...parent, skip: true })
      continue
    }
    // 嵌套 `<svg>` 另有内层视口、viewBox 与裁剪，本模块按未量测处理并跳过其子树：
    // 把内层元素按外层画布量测会得出错的越界结论。
    const nestedViewport = name === 'svg' && rootSvgSeen
    if (nestedViewport) note('文档含嵌套 `<svg>`（内层视口与裁剪），其子元素未量测')
    const frame = nestedViewport ? { ...own, skip: true } : own
    if (!selfClosing) stack.push(frame)
    if (name === 'style') {
      note('文档含 `<style>` 样式表，CSS 类规则决定的外观（线宽、描边、字号）未量测')
      continue
    }
    if (frame.skip) continue
    if (name === 'svg') {
      rootSvgSeen = true
      continue
    }
    // 不在量测范围的结构逐类记账：报告里没有 not-measured 才等于逐类量测过。
    if (MARKER_PATTERN.test(tag)) note('`marker-start/mid/end` 端头（箭头）的墨迹未量测')
    if (name === 'tspan' && TSPAN_OFFSET_PATTERN.test(tag)) note('`<tspan>` 的 x/y/dx/dy 偏移未量测，多行文字的实际位置可能与占位框不同')
    if (BASELINE_PATTERN.test(tag)) note('`dominant-baseline`/`alignment-baseline` 未量测，文字基线可能与占位框不同')
    if (PERCENT_LENGTH_PATTERN.test(tag)) note('长度属性用了相对视口的百分比（如 width="50%"），未量测')
    if (name === 'text') {
      if (!selfClosing) pending = { contentStart: match.index + tag.length, tag, frame }
      continue
    }
    if (name === 'g') continue
    if (name === 'use' || name === 'image') {
      note(`\`<${name}>\` 引用的内容未展开，其几何未量测`)
      continue
    }
    const geometry = geometryOf(name, tag, note)
    if (geometry.kind === 'none') continue
    const scale = scaleOf(frame.matrix)
    const dashPattern = dashPatternUser(styled(tag, 'stroke-dasharray'))
    const hatchGroup = hatchGroupValue(attr(tag, HATCH_GROUP_ATTRIBUTE))
    const role = attr(tag, ROLE_ATTRIBUTE)
    shapes.push({
      subpaths: geometry.subpaths.map(subpath => ({
        points: subpath.points.map(point => mapPoint(frame.matrix, point)),
        closed: subpath.closed,
      })),
      strokeWidthMm: frame.strokeWidthMm * scale,
      stroked: frame.stroked,
      ...(dashPattern === undefined ? {} : { dashPatternMm: dashPattern.map(value => value * scale) }),
      ...(hatchGroup === undefined ? {} : { hatchGroup }),
      ...(role === undefined ? {} : { role }),
      occludes: frame.occludes,
      order: orderCount,
      ...(frame.group === undefined ? {} : { group: frame.group }),
    })
    orderCount += 1
  }
  return {
    widthMm: viewport.widthMm,
    heightMm: viewport.heightMm,
    shapes,
    texts,
    unmeasured,
  }
}

/** 子路径的线段：相邻顶点各一段，闭合子路径另加收口边。 */
