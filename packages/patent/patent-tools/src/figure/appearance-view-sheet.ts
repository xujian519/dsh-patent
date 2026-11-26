/**
 * 外观设计图片排版（纯函数，无 IO）：六面正投影视图与立体图（使用状态参考图）
 * 的版面组合。
 *
 * 依据（现行条文）：
 * - 《专利审查指南》第一部分第三章 4.2.1：六面正投影视图的视图名称是主视图、
 *   后视图、左视图、右视图、俯视图、仰视图，各视图的视图名称应当标注在相应
 *   视图的正下方。
 * - 《专利审查指南》第一部分第三章 4.2.4：图片的缺陷包括「各视图比例不一致」；
 *   省略视图的，应当在简要说明中写明省略的原因。
 *
 * 本模块只做版面组合、不画图：调用方给出每个视图已有的毫米坐标矢量片段与片段
 * 自身尺寸，模块按第一角（中国）或第三角（美式）投影惯例排布格位，对所有落版
 * 单元格施加同一个公共缩放比（比例一致性），并在每个视图正下方写出视图名称。
 * 产出 {@link VectorFigureSpec}，由 vectorFigureSvg 封装为独立 SVG 文件。
 *
 * 网格列向右、行向下递增，主视图恒在列 1 行 1。第一角：仰视图在其上、俯视图
 * 在其下、右视图在其左、左视图在其右、后视图在左视图右侧；第三角：上下互换
 * （俯视图在上、仰视图在下）、左右互换（左视图在左、右视图在右），后视图在
 * 右视图右侧。未提供的视图留空但保持格位相对关系（只裁掉整行/整列的空白）。
 * extras 排在已占用主网格列的右邻列，自上而下每行一个。
 *
 * 全黑白：图面除 #000000 外不引入其他颜色；文本元素自带
 * fill="#000000" stroke="none"，否则会继承外壳的 fill="none" 而不可见。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/appearance-view-sheet
 */

import { rasterFigureMessage } from './raster-input.ts'
import { escapeXmlText } from './svg-annotate.ts'
import { VectorFigureError, fmt } from './vector-figure.ts'
import type { VectorFigureSpec } from './vector-figure.ts'

/** 可提交的六个基本视图名。 */
export const APPEARANCE_VIEW_NAMES = ['主视图', '后视图', '左视图', '右视图', '俯视图', '仰视图'] as const

/** 基本视图名。 */
export type AppearanceViewName = (typeof APPEARANCE_VIEW_NAMES)[number]

/** 一个视图：调用方已有的矢量片段及其原始尺寸。 */
export type AppearanceView = {
  name: AppearanceViewName
  /** 视图片段（毫米坐标的 SVG 片段；不含 `<svg>` 根元素）。 */
  body: string
  /** 片段自身宽（毫米）。 */
  widthMm: number
  /** 片段自身高（毫米）。 */
  heightMm: number
  /** 可选备注（写入结果 warnings，不落图面），例如「省略视图原因」。 */
  note?: string
}

/** 外观设计图片排版输入。 */
export type AppearanceSheetInput = {
  /** 至少一个视图；名称不得重复。 */
  views: readonly AppearanceView[]
  /** 额外单元格（如立体图/使用状态参考图）：名称 + 片段。 */
  extras?: readonly { name: string; body: string; widthMm: number; heightMm: number }[]
  /** 每个视图单元的最大边长（毫米），默认 60。 */
  cellMm?: number
  /** 视图名与图形之间的间距（毫米），默认 3。 */
  captionGapMm?: number
  /** 视图名文字高度（毫米），默认 3.5。 */
  captionFontMm?: number
  /** 画布留白（毫米），默认 8。 */
  paddingMm?: number
  /** 是否按第一角投影排布；默认 true（中国），false 时按第三角（美式）排布。 */
  firstAngle?: boolean
}

/** 外观设计图片排版结果。 */
export type AppearanceSheetResult = {
  /** 版面规格（交给 vectorFigureSvg 封装）。 */
  spec: VectorFigureSpec
  /** 检查提示（比例不一致、六视图不全、省略视图未说明等）。 */
  warnings: string[]
  /** 每个落版单元格的缩放比（名称 → scale；统一比例下各值一致）。 */
  scales: Record<string, number>
}

/** 默认单元格边长（毫米）。 */
const DEFAULT_CELL_MM = 60

/** 默认视图名与图形的间距（毫米）。 */
const DEFAULT_CAPTION_GAP_MM = 3

/** 默认视图名文字高度（毫米）。 */
const DEFAULT_CAPTION_FONT_MM = 3.5

/** 默认画布留白（毫米）。 */
const DEFAULT_PADDING_MM = 8

/** 缩放后最长边低于单元格边长该比例时提示「可能过小」。 */
const TINY_CELL_RATIO = 1 / 3

/**
 * 片段中会引入可执行内容或外部文档的元素。命名空间前缀（`svg:script`）
 * 在 SVG 文档中仍是同一元素，故必须一起拒绝。
 */
const UNSAFE_SVG_ELEMENT = /^<\s*\/?\s*(?:[A-Z_][\w.-]*:)?(?:script|style|foreignObject|iframe|object|embed|animate|set)\b/i

/** 嵌入的位图像素。外观视图只接受矢量片段。 */
const EMBEDDED_SVG_IMAGE = /^<\s*\/?\s*(?:[A-Z_][\w.-]*:)?image\b/i

/** 标签上的事件处理属性（onload、onclick…），只在引号外的属性名上匹配。 */
const EVENT_HANDLER_ATTRIBUTE = /\son[a-z]+\s*=/i

/** 去掉引号内的属性值，避免值里的 `on...=` 文本被当成属性名。 */
const QUOTED_ATTRIBUTE_VALUE = /"[^"]*"|'[^']*'/g

/** 解码数字字符引用，避免 `&#x6a;avascript:` 这类写法绕过关键字检查。 */
function decodeNumericReferences(text: string): string {
  return text.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex: string | undefined, decimal: string | undefined) => {
    /* v8 ignore next -- the reference pattern always captures exactly one of the hex/decimal groups. */
    const code = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16)
    return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/**
 * 按 XML 引号规则切出完整标签：引号内的 `>` 不结束标签。
 * @param source - 已解码的片段。
 * @returns 每个 `<...>` 标签的原文，按出现顺序。
 */
function svgTags(source: string): string[] {
  const tags: string[] = []
  let index = 0
  while (index < source.length) {
    const start = source.indexOf('<', index)
    if (start === -1) break
    // Text such as `2 < 3` is not a tag start; resume after it so a later tag
    // is still scanned.
    if (!/[A-Za-z_/!?]/.test(source.charAt(start + 1))) {
      index = start + 1
      continue
    }
    let quote: string | undefined
    let cursor = start + 1
    while (cursor < source.length) {
      const char = source.charAt(cursor)
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
      cursor += 1
    }
    if (cursor >= source.length) break
    tags.push(source.slice(start, cursor + 1))
    index = cursor + 1
  }
  return tags
}

/**
 * Reject a model-supplied view fragment that carries executable content.
 * The fragment is embedded verbatim into the delivered SVG, so `<script>`,
 * event handlers, `javascript:` URLs, and embedded HTML documents must not
 * reach the file.
 * @param name - the view name, used to locate the offending input.
 * @param body - the SVG fragment supplied by the model.
 * @throws VectorFigureError 片段包含可执行内容时。
 */
function assertSafeSvgFragment(name: string, body: string): void {
  // 注释不渲染，先移除，避免注释内容被误判或用来干扰标签扫描。
  const decoded = decodeNumericReferences(body).replace(/<!--[\s\S]*?-->/g, '')
  // URLs may contain tab/newline/control characters that browsers ignore.
  const compact = decoded.toLowerCase().replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
  if (compact.includes('javascript:')) {
    throw new VectorFigureError('invalid_input', `视图片段包含 javascript: URL，拒绝落版：${name}`)
  }
  if (/<!entity/.test(compact) || /<!\[cdata\[/.test(compact)) {
    throw new VectorFigureError('invalid_input', `视图片段包含 ENTITY/CDATA 等不安全结构，拒绝落版：${name}`)
  }
  for (const tag of svgTags(decoded)) {
    if (EMBEDDED_SVG_IMAGE.test(tag)) {
      throw new VectorFigureError('invalid_input', `${rasterFigureMessage('视图片段', '<image>')}（${name}）`)
    }
    if (UNSAFE_SVG_ELEMENT.test(tag)) {
      throw new VectorFigureError('invalid_input', `视图片段包含可执行元素，拒绝落版：${name}（${tag.slice(0, 40)}）`)
    }
    if (EVENT_HANDLER_ATTRIBUTE.test(tag.replace(QUOTED_ATTRIBUTE_VALUE, '""'))) {
      throw new VectorFigureError('invalid_input', `视图片段包含事件处理属性，拒绝落版：${name}`)
    }
  }
}

/** 网格格位：列号向右递增，行号向下递增。 */
type GridSlot = readonly [number, number]

/** 第一角投影格位（主视图居中，左右视图互换后后视图接在左视图右侧）。 */
const FIRST_ANGLE_SLOTS: Record<AppearanceViewName, GridSlot> = {
  主视图: [1, 1],
  仰视图: [1, 0],
  俯视图: [1, 2],
  右视图: [0, 1],
  左视图: [2, 1],
  后视图: [3, 1],
}

/** 第三角投影格位（主视图居中，俯视图在上、仰视图在下，后视图接在右视图右侧）。 */
const THIRD_ANGLE_SLOTS: Record<AppearanceViewName, GridSlot> = {
  主视图: [1, 1],
  俯视图: [1, 0],
  仰视图: [1, 2],
  左视图: [0, 1],
  右视图: [2, 1],
  后视图: [3, 1],
}

/** 待落版单元格：片段及其格位。 */
type PlacedCell = {
  name: string
  body: string
  widthMm: number
  heightMm: number
  col: number
  row: number
}

/**
 * 名称是否为可提交的基本视图名（调用方片段名称来自模型输入，需在排版前校验）。
 * @param name - 待判定名称。
 * @returns 属于 {@link APPEARANCE_VIEW_NAMES} 时为 true。
 */
function isAppearanceViewName(name: string): boolean {
  return APPEARANCE_VIEW_NAMES.some(candidate => candidate === name)
}

/**
 * 解析可选尺寸参数：缺省取默认值，给出时必须是正有限数。
 * @param value - 调用方给出的值（可能缺省）。
 * @param fallback - 缺省值（毫米）。
 * @param field - 出错信息中的字段名。
 * @returns 生效的毫米数值。
 * @throws VectorFigureError('invalid_input') 给出非正或非有限值时。
 */
function resolveMm(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new VectorFigureError('invalid_input', `${field} 必须是正有限数（毫米）：${String(value)}`)
  }
  return value
}

/**
 * 校验单元格片段：片段非空、尺寸为正有限数。
 * @param name - 单元格名称（出错信息用）。
 * @param body - 毫米坐标的 SVG 片段。
 * @param widthMm - 片段自身宽（毫米）。
 * @param heightMm - 片段自身高（毫米）。
 * @throws VectorFigureError('invalid_input') 片段为空或尺寸非正/非有限时。
 */
function assertCellGeometry(name: string, body: string, widthMm: number, heightMm: number): void {
  if (body.trim() === '') {
    throw new VectorFigureError('invalid_input', `视图片段为空：${name}`)
  }
  assertSafeSvgFragment(name, body)
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new VectorFigureError(
      'invalid_input',
      `${name} 的片段尺寸必须为正有限数（毫米）：${String(widthMm)}×${String(heightMm)}`,
    )
  }
}

/**
 * 组合外观设计图片版面：按投影惯例定位视图、统一缩放、逐视图在正下方标注视图名。
 *
 * 公共缩放比取所有落版单元格（六个基本视图与 extras）的全局最小值
 * `s = min(cellMm / max(widthMm, heightMm))`，保证每个单元格都不越出边长 cellMm，
 * 且各视图比例一致（4.2.4 的「各视图比例不一致」缺陷）。图形在单元格内水平居中、
 * 底边对齐格底，故图形底边到视图名字框上沿的间距恒为 captionGapMm，文本基线落在
 * 字框底边（图名因此落在相应视图正下方）。
 *
 * 文字元素与 extras 名称同样以 `fill="#000000" stroke="none"` 落图，名称计入
 * `spec.labels` 供图面用语检查；`note` 只进 warnings、不进图面。
 * @param input - 视图片段、extras 与版面参数。
 * @returns 版面规格、检查提示与逐单元格缩放比。
 * @throws VectorFigureError('empty_input') views 为空时。
 * @throws VectorFigureError('invalid_input') 视图名非法或重复、片段为空、尺寸非正/非有限、版面参数非正时。
 */
export function buildAppearanceViewSheet(input: AppearanceSheetInput): AppearanceSheetResult {
  if (input.views.length === 0) {
    throw new VectorFigureError('empty_input', '外观设计图片排版至少需要一个视图')
  }
  const cellMm = resolveMm(input.cellMm, DEFAULT_CELL_MM, 'cellMm')
  const captionGapMm = resolveMm(input.captionGapMm, DEFAULT_CAPTION_GAP_MM, 'captionGapMm')
  const captionFontMm = resolveMm(input.captionFontMm, DEFAULT_CAPTION_FONT_MM, 'captionFontMm')
  const paddingMm = resolveMm(input.paddingMm, DEFAULT_PADDING_MM, 'paddingMm')

  const slots = input.firstAngle === false ? THIRD_ANGLE_SLOTS : FIRST_ANGLE_SLOTS
  const providedNames = new Set<string>()
  const usedNames = new Set<string>()
  const cells: PlacedCell[] = []
  let mainMaxCol = 0
  for (const view of input.views) {
    if (!isAppearanceViewName(view.name)) {
      throw new VectorFigureError(
        'invalid_input',
        `未知视图名：${view.name}（可提交的六个基本视图名为 ${APPEARANCE_VIEW_NAMES.join('、')}）`,
      )
    }
    if (providedNames.has(view.name)) {
      throw new VectorFigureError('invalid_input', `视图名重复：${view.name}`)
    }
    assertCellGeometry(view.name, view.body, view.widthMm, view.heightMm)
    providedNames.add(view.name)
    usedNames.add(view.name)
    const [col, row] = slots[view.name]
    mainMaxCol = Math.max(mainMaxCol, col)
    cells.push({ name: view.name, body: view.body, widthMm: view.widthMm, heightMm: view.heightMm, col, row })
  }

  const extraCol = mainMaxCol + 1
  for (const [index, extra] of (input.extras ?? []).entries()) {
    if (usedNames.has(extra.name)) {
      throw new VectorFigureError('invalid_input', `名称重复：${extra.name}`)
    }
    assertCellGeometry(extra.name, extra.body, extra.widthMm, extra.heightMm)
    usedNames.add(extra.name)
    cells.push({ name: extra.name, body: extra.body, widthMm: extra.widthMm, heightMm: extra.heightMm, col: extraCol, row: index })
  }

  const scale = Math.min(...cells.map(cell => cellMm / Math.max(cell.widthMm, cell.heightMm)))
  const minCol = Math.min(...cells.map(cell => cell.col))
  const minRow = Math.min(...cells.map(cell => cell.row))
  const maxCol = Math.max(...cells.map(cell => cell.col))
  const maxRow = Math.max(...cells.map(cell => cell.row))
  const unitHeightMm = cellMm + captionGapMm + captionFontMm
  const widthMm = paddingMm * 2 + (maxCol - minCol + 1) * cellMm
  const heightMm = paddingMm * 2 + (maxRow - minRow + 1) * unitHeightMm

  const drawn: string[] = []
  const scales: Record<string, number> = {}
  for (const cell of cells) {
    scales[cell.name] = scale
    const cellLeft = paddingMm + (cell.col - minCol) * cellMm
    const cellTop = paddingMm + (cell.row - minRow) * unitHeightMm
    const drawnWidthMm = cell.widthMm * scale
    const drawnHeightMm = cell.heightMm * scale
    drawn.push(
      `<g transform="translate(${fmt(cellLeft + (cellMm - drawnWidthMm) / 2)} ${fmt(cellTop + cellMm - drawnHeightMm)}) scale(${fmt(scale)})">`,
      `  ${cell.body.trim()}`,
      '</g>',
      `<text x="${fmt(cellLeft + cellMm / 2)}" y="${fmt(cellTop + cellMm + captionGapMm + captionFontMm)}" font-size="${fmt(captionFontMm)}" font-family="sans-serif" text-anchor="middle" fill="#000000" stroke="none">${escapeXmlText(cell.name)}</text>`,
    )
  }

  const warnings: string[] = []
  const missing = APPEARANCE_VIEW_NAMES.filter(name => !providedNames.has(name))
  if (missing.length > 0) {
    warnings.push(`六面正投影视图不全，缺少：${missing.join('、')}；如属省略视图，应当在简要说明中写明省略原因`)
  }
  for (const view of input.views) {
    const note = view.note?.trim()
    if (note !== undefined && note !== '') warnings.push(note)
  }
  for (const cell of cells) {
    const longestMm = Math.max(cell.widthMm, cell.heightMm) * scale
    if (longestMm < cellMm * TINY_CELL_RATIO) {
      warnings.push(
        `视图 "${cell.name}" 统一缩放后最长边 ${fmt(longestMm)}mm 小于单元格 ${fmt(cellMm)}mm 的 1/3，图面可能过小，请人工核对`,
      )
    }
  }

  return {
    spec: { widthMm, heightMm, body: drawn.join('\n'), labels: cells.map(cell => cell.name) },
    warnings,
    scales,
  }
}
