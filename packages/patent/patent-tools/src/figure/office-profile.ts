/**
 * 目标法域的附图提交规格档案（纯数据，无 IO）。
 *
 * 附图的形式要求按受理局/指定局不同：幅面、页边距、图号写法、色彩策略、
 * 图中字高下限、附图页码写法都不同。本模块把已核实的条文数值固化为档案，
 * 供 submission-page（落版）与 compliance（核算）共用，避免各处散落常数。
 *
 * 数值出处（逐条已核实）：
 * - 中国：《专利审查指南》第一部分第一章 4.3（附图编号"图1、图2"标注在附图
 *   正下方；两幅以上才编号）、第一部分第二章 7.3、第五部分第一章 4.2/4.3
 *   （A4 297×210 毫米；页边距顶 25、左 25、右 15、底 15 毫米）、4.3 与 7.3(5)
 *   （缩小到三分之二仍能分辨细节）。
 * - PCT：Rule 11.5（A4）、11.6(c)（附图可用面不超过 26.2 厘米×17.0 厘米；
 *   最小页边距上 2.5、左 2.5、右 1.5、下 1.0 厘米）、11.13(h)（数字与字母高度
 *   不小于 0.32 厘米）、11.13(c)（线性缩小到三分之二仍可辨）、11.13(k) 与
 *   申请人指南 IP 5.141（图号冠 "Fig."；仅一幅时不编号也不出现 "Fig."）、
 *   11.13(a)（附图不得着色）、行政规程 Section 207(b)(iii)（附图页码形如 1/3）。
 * - USPTO：37 CFR 1.84(f)(g)（A4 或 8½×11 英寸；页边距上/左 ≥2.5、右 ≥1.5、
 *   下 ≥1.0 厘米；A4 可用面 ≤17.0×26.2 厘米）、1.84(p)(3)（数字、字母与标记
 *   高度 ≥0.32 厘米）、1.84(k)（缩至三分之二复制仍不拥挤；不得标注实际尺寸或
 *   比例）、1.84(u)（视图号冠 "FIG."；仅一个视图时不编号）、1.84(a)(2)
 *   （实用申请彩色附图须经呈请）、1.84(t)（页码形如 1/3）。
 *
 * EPO 未列入：EPC Rule 46/47 与 EPO 审查指南的一手文本在本次核实时无法取得
 * （epo.org 返回 403），因此不为 EPO 固化任何数值。
 * @module @deepseek-ai/dsh-patent-tools/figure/office-profile
 */

/** 支持的目标受理局/指定局。 */
export const TARGET_OFFICES = ['cnipa', 'pct', 'uspto'] as const

/** 目标受理局/指定局标识。 */
export type TargetOffice = (typeof TARGET_OFFICES)[number]

/** 幅面尺寸（毫米，宽×高）。 */
type PaperSizeMm = {
  /** 宽（毫米）。 */
  widthMm: number
  /** 高（毫米）。 */
  heightMm: number
}

/** 页边距（毫米，四边分别给出）。 */
type PageMarginsMm = {
  /** 上边距（毫米）。 */
  topMm: number
  /** 左边距（毫米）。 */
  leftMm: number
  /** 右边距（毫米）。 */
  rightMm: number
  /** 下边距（毫米）。 */
  bottomMm: number
}

/** 图号写法：中国「图1」、PCT「Fig. 1」、USPTO「FIG. 1」。 */
type CaptionStyle = 'figure-number' | 'fig' | 'fig-upper'

/** 色彩策略：monochrome=不得着色（PCT/USPTO 实用申请）；color-if-necessary=必要时可提交彩色（中国 2023 版起）。 */
type ColorPolicy = 'monochrome' | 'color-if-necessary'

/**
 * 附图页码写法：figure-pages=中国「附图应当用阿拉伯数字顺序编写页码」，写作「第2页 共5页」（单页「第2页」）；
 * sheet-of=PCT/USPTO 的「1/3」。
 */
type SheetNumbering = 'figure-pages' | 'sheet-of'

/** 一个法域的附图提交规格（只读：调用方不得就地修改档案常数）。 */
export type OfficeProfile = {
  readonly office: TargetOffice
  /** 附图用纸幅面。 */
  readonly paper: PaperSizeMm
  /** 附图页页边距。 */
  readonly margins: PageMarginsMm
  /** 图中数字与字母的最小字高（毫米）；中国无具体数值（只有缩小 2/3 的可辨要求）。 */
  readonly minCharHeightMm?: number
  /** 图号写法。 */
  readonly captionStyle: CaptionStyle
  /** 是否仅在附图两幅以上时标注图号（中国 4.3 的文义：总数在两幅以上的才编号）。 */
  readonly captionOnlyWhenMultiple: boolean
  /** 色彩策略。 */
  readonly color: ColorPolicy
  /** 附图页码写法。 */
  readonly sheetNumbering: SheetNumbering
  /** 附图缩小到该比例时仍须清晰可辨（三分之二）。 */
  readonly reductionRatio: number
}

/** 图号文字格式（每法域一种写法）。 */
const CAPTION_FORMATS: Record<CaptionStyle, (figureNumber: number) => string> = {
  'figure-number': figureNumber => `图${figureNumber}`,
  fig: figureNumber => `Fig. ${figureNumber}`,
  'fig-upper': figureNumber => `FIG. ${figureNumber}`,
}

/** A4（毫米）：中国指南第五部分第一章 4.2、PCT Rule 11.5、37 CFR 1.84(f)(1)。 */
const A4_MM: PaperSizeMm = { widthMm: 210, heightMm: 297 }

/** 目标法域档案表。 */
const PROFILES: Record<TargetOffice, OfficeProfile> = {
  cnipa: {
    office: 'cnipa',
    paper: A4_MM,
    // 指南第五部分第一章 4.3：顶 25、左 25、右 15、底 15 毫米。
    margins: { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 15 },
    captionStyle: 'figure-number',
    captionOnlyWhenMultiple: true,
    color: 'color-if-necessary',
    sheetNumbering: 'figure-pages',
    reductionRatio: 2 / 3,
  },
  pct: {
    office: 'pct',
    paper: A4_MM,
    // Rule 11.6(c)：上 2.5、左 2.5、右 1.5、下 1.0 厘米。
    margins: { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 10 },
    minCharHeightMm: 3.2,
    captionStyle: 'fig',
    // Rule 11.13(k) + 申请人指南 IP 5.141：仅一幅图时不编号、不出现 "Fig."。
    captionOnlyWhenMultiple: true,
    color: 'monochrome',
    sheetNumbering: 'sheet-of',
    reductionRatio: 2 / 3,
  },
  uspto: {
    office: 'uspto',
    paper: A4_MM,
    // 37 CFR 1.84(g)：上/左 1 英寸、右 5/8 英寸、下 3/8 英寸。
    margins: { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 10 },
    minCharHeightMm: 3.2,
    captionStyle: 'fig-upper',
    // 1.84(u)(1)：仅一个视图时不得编号、不得出现 "FIG."。
    captionOnlyWhenMultiple: true,
    color: 'monochrome',
    sheetNumbering: 'sheet-of',
    reductionRatio: 2 / 3,
  },
}

/**
 * 取目标法域的附图提交规格。
 * @param office - 目标受理局/指定局标识。
 * @returns 该法域的规格档案。
 */
export function officeProfile(office: TargetOffice): OfficeProfile {
  return PROFILES[office]
}

/**
 * 生成图号文字；本案附图不足两幅且该法域要求"两幅以上才编号"时返回 undefined。
 * @param profile - 目标法域规格。
 * @param figureNumber - 本幅图号（1 起）。
 * @param figureCount - 本案附图总数（≥ figureNumber）。
 * @returns 图号文字（如「图1」「Fig. 1」「FIG. 1」）；不需标注时 undefined。
 * @throws RangeError figureNumber 或 figureCount 不是满足 1 ≤ figureNumber ≤ figureCount 的整数时。
 */
export function figureCaption(profile: OfficeProfile, figureNumber: number, figureCount: number): string | undefined {
  if (!Number.isInteger(figureNumber) || figureNumber < 1) {
    throw new RangeError(`图号必须是正整数：${String(figureNumber)}`)
  }
  if (!Number.isInteger(figureCount) || figureCount < figureNumber) {
    throw new RangeError(`附图总数必须是不小于图号的整数：${String(figureCount)}`)
  }
  if (profile.captionOnlyWhenMultiple && figureCount < 2) return undefined
  return CAPTION_FORMATS[profile.captionStyle](figureNumber)
}

/**
 * 调用方自定义图号是否与目标法域的写法一致。
 *
 * 自定义 caption 仍须遵守该法域的图号格式（中国「图1」、PCT「Fig. 1」、
 * USPTO「FIG. 1」）；该法域要求单幅图不编号时，给出任何图号都不合规。
 * @param profile - 目标法域规格。
 * @param caption - 调用方给出的图号文字；undefined 表示不标图号。
 * @param figureNumber - 本幅图号（1 起）。
 * @param figureCount - 本案附图总数（≥ figureNumber）。
 * @returns 图号文字符合该法域写法时 true。
 * @throws RangeError figureNumber 或 figureCount 超出允许范围时。
 */
export function captionMatches(profile: OfficeProfile, caption: string | undefined, figureNumber: number, figureCount: number): boolean {
  const expected = figureCaption(profile, figureNumber, figureCount)
  if (expected === undefined) return caption === undefined || caption === ''
  return caption === expected
}

/**
 * 生成附图页页码文字。
 * @param profile - 目标法域规格。
 * @param sheetIndex - 当前附图页序号（1 起）。
 * @param sheetTotal - 附图页总数（≥ sheetIndex）。
 * @returns 页码文字（中国为「第2页 共5页」，单页时为「第2页」；PCT/USPTO 为「2/5」）。
 * @throws RangeError 序号不是满足 1 ≤ sheetIndex ≤ sheetTotal 的整数时。
 */
export function sheetNumberText(profile: OfficeProfile, sheetIndex: number, sheetTotal: number): string {
  if (!Number.isInteger(sheetIndex) || sheetIndex < 1) {
    throw new RangeError(`附图页序号必须是正整数：${String(sheetIndex)}`)
  }
  if (!Number.isInteger(sheetTotal) || sheetTotal < sheetIndex) {
    throw new RangeError(`附图页总数必须是不小于序号的整数：${String(sheetTotal)}`)
  }
  if (profile.sheetNumbering === 'sheet-of') return `${sheetIndex}/${sheetTotal}`
  // 页码与附图标记同为纯数字时，视觉判读会把页脚「2」当成一个无对应图形的标号。
  return sheetTotal > 1 ? `第${sheetIndex}页 共${sheetTotal}页` : `第${sheetIndex}页`
}
