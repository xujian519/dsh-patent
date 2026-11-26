import { describe, expect, it, vi } from 'vitest'
import { APPEARANCE_VIEW_NAMES, buildAppearanceViewSheet } from '../src/figure/appearance-view-sheet.ts'
import type { AppearanceSheetInput, AppearanceSheetResult, AppearanceView, AppearanceViewName } from '../src/figure/appearance-view-sheet.ts'
import { VectorFigureError, vectorFigureSvg } from '../src/figure/vector-figure.ts'
import type { VectorFigureErrorCode } from '../src/figure/vector-figure.ts'

/**
 * 外观设计图片版面组合：位置关系（第一角/第三角、俯视图在主视图正下方等）、
 * 统一比例、视图名标注、extras 落位与全部校验分支。
 * 图面文本与变换都由模块自身生成，故测试直接解析这些元素核对落版坐标。
 */

/** 抛出的错误构造参数：本模块的校验契约是错误码，而接缝实例不保留 code，故在构造处记录。 */
const mockRaisedErrors: { code: string; message: string }[] = []

vi.mock('../src/figure/vector-figure.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/figure/vector-figure.ts')>()
  /** 记录构造参数后委托接缝实现。 */
  class RecordingVectorFigureError extends actual.VectorFigureError {
    constructor(code: VectorFigureErrorCode, message: string) {
      mockRaisedErrors.push({ code, message })
      super(code, message)
    }
  }
  return { ...actual, VectorFigureError: RecordingVectorFigureError }
})

/** 所有基本视图共用的片段（40mm × 20mm，原点在左上）。 */
const BODY = '<rect x="0" y="0" width="40" height="20"/>'

/** 图面片段的落版变换：平移原点与统一缩放比。 */
type Placement = { x: number; y: number; scale: number }

/** 图面文本元素：内容、基线坐标与字号（毫米）。 */
type Caption = { name: string; x: number; y: number; fontMm: number }

/** 构造尺寸一致的视图（40mm × 20mm 片段）。 */
function view(name: AppearanceViewName): AppearanceView {
  return { name, body: BODY, widthMm: 40, heightMm: 20 }
}

/** 构造名称非法的视图（绕过静态类型以覆盖运行期名称校验）。 */
function invalidNamedView(name: string): AppearanceView {
  return { name: name as AppearanceViewName, body: BODY, widthMm: 40, heightMm: 20 }
}

/** 抽取按落版顺序排列的图形变换。 */
function placements(body: string): Placement[] {
  const found: Placement[] = []
  for (const match of body.matchAll(/<g transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.-]+)\)">/g)) {
    found.push({ x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) })
  }
  return found
}

/** 抽取图面文本元素。 */
function captions(body: string): Caption[] {
  const found: Caption[] = []
  for (const match of body.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" font-size="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)) {
    found.push({ x: Number(match[1]), y: Number(match[2]), fontMm: Number(match[3]), name: match[4]! })
  }
  return found
}

/** 按视图名取文本元素（一个视图名只出现一次）。 */
function captionOf(body: string, name: string): Caption {
  const found = captions(body).find(caption => caption.name === name)
  if (found === undefined) throw new Error(`图面缺少文本元素：${name}`)
  return found
}

/** 全部落版单元格的缩放比一致时返回该比值。 */
function uniformScale(sheet: AppearanceSheetResult): number {
  const values = [...new Set(Object.values(sheet.scales))]
  expect(values).toHaveLength(1)
  return values[0]!
}

/** 断言调用抛出指定错误码的 VectorFigureError。 */
function expectError(input: AppearanceSheetInput, code: VectorFigureErrorCode): void {
  mockRaisedErrors.length = 0
  let thrown: unknown
  try {
    buildAppearanceViewSheet(input)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(VectorFigureError)
  expect(mockRaisedErrors).toHaveLength(1)
  expect(mockRaisedErrors[0]!.code).toBe(code)
}

describe('buildAppearanceViewSheet 六面正投影排布', () => {
  it('第一角：俯视图在主视图正下方、左视图在右侧，后视图接左视图右侧', () => {
    const sheet = buildAppearanceViewSheet({ views: APPEARANCE_VIEW_NAMES.map(name => view(name)), firstAngle: true })
    const { body } = sheet.spec
    const main = captionOf(body, '主视图')
    const top = captionOf(body, '俯视图')
    const bottom = captionOf(body, '仰视图')
    const left = captionOf(body, '左视图')
    const right = captionOf(body, '右视图')
    const rear = captionOf(body, '后视图')
    expect(top.y).toBeGreaterThan(main.y)
    expect(bottom.y).toBeLessThan(main.y)
    expect(left.x).toBeGreaterThan(main.x)
    expect(right.x).toBeLessThan(main.x)
    expect(rear.x).toBeGreaterThan(left.x)
    // 主视图在列 1 行 1：x = 留白 8 + 1 格 60；图形底边对齐格底 → y = 74.5 + 60 - 30。
    expect(placements(body)[0]).toEqual({ x: 68, y: 104.5, scale: 1.5 })
    expect(sheet.spec.widthMm).toBe(256)
    expect(sheet.spec.heightMm).toBe(215.5)
    expect(uniformScale(sheet)).toBe(1.5)
    expect(sheet.warnings).toEqual([])
  })

  it('第三角：俯视图在主视图上方、左视图在左侧，后视图接右视图右侧', () => {
    const sheet = buildAppearanceViewSheet({ views: APPEARANCE_VIEW_NAMES.map(name => view(name)), firstAngle: false })
    const { body } = sheet.spec
    const main = captionOf(body, '主视图')
    expect(captionOf(body, '俯视图').y).toBeLessThan(main.y)
    expect(captionOf(body, '仰视图').y).toBeGreaterThan(main.y)
    expect(captionOf(body, '左视图').x).toBeLessThan(main.x)
    expect(captionOf(body, '右视图').x).toBeGreaterThan(main.x)
    expect(captionOf(body, '后视图').x).toBeGreaterThan(captionOf(body, '右视图').x)
  })

  it('每个视图名标注在相应视图正下方（间距 3mm、水平居中），字高 3.5mm', () => {
    const sheet = buildAppearanceViewSheet({ views: APPEARANCE_VIEW_NAMES.map(name => view(name)) })
    const figures = placements(sheet.spec.body)
    const texts = captions(sheet.spec.body)
    expect(figures).toHaveLength(6)
    expect(texts).toHaveLength(6)
    for (const [index, caption] of texts.entries()) {
      const figure = figures[index]!
      // 文本基线落在字框底边：图形底边到视图名字框上沿的间距为 captionGapMm。
      expect(caption.y - caption.fontMm - (figure.y + 20 * figure.scale)).toBeCloseTo(3, 6)
      expect(caption.x - figure.x).toBeCloseTo(20 * figure.scale, 6)
      expect(caption.fontMm).toBe(3.5)
    }
    // 每个视图名都计入图面词语；文本自带黑色填充，图面除 #000000 外无其他颜色。
    expect(sheet.spec.labels).toEqual([...APPEARANCE_VIEW_NAMES])
    expect(sheet.spec.body).toMatch(/<text[^>]*fill="#000000" stroke="none">/)
    expect(sheet.spec.body).not.toMatch(/#(?!000000)[0-9a-fA-F]{3}/)
    expect(vectorFigureSvg(sheet.spec)).toContain('width="256mm" height="215.5mm"')
  })

  it('三视图只占实际格位：俯视图在主视图下方、左视图在右侧，画布不保留未提供的行列', () => {
    const sheet = buildAppearanceViewSheet({ views: [view('主视图'), view('左视图'), view('俯视图')] })
    const { body } = sheet.spec
    expect(captionOf(body, '俯视图').y).toBeGreaterThan(captionOf(body, '主视图').y)
    expect(captionOf(body, '左视图').x).toBeGreaterThan(captionOf(body, '主视图').x)
    expect(sheet.spec.widthMm).toBe(136)
    expect(sheet.spec.heightMm).toBe(149)
    expect(placements(body)).toHaveLength(3)
    expect(sheet.warnings).toEqual([
      '六面正投影视图不全，缺少：后视图、右视图、仰视图；如属省略视图，应当在简要说明中写明省略原因',
    ])
  })

  it('未提供的视图留空但后续视图格位不移动', () => {
    const sheet = buildAppearanceViewSheet({ views: [view('主视图'), view('后视图')] })
    const { body } = sheet.spec
    // 后视图仍在左视图那一列的右侧（中间空一格），不是紧贴主视图。
    expect(captionOf(body, '后视图').x - captionOf(body, '主视图').x).toBe(120)
    expect(sheet.spec.widthMm).toBe(196)
  })
})

describe('buildAppearanceViewSheet 统一比例与 extras', () => {
  it('extras 排在主网格右邻列并自上而下逐行落位，名称标注在正下方', () => {
    const sheet = buildAppearanceViewSheet({
      views: [view('主视图'), view('左视图'), view('俯视图')],
      extras: [
        { name: '立体图', body: BODY, widthMm: 40, heightMm: 20 },
        { name: '使用状态参考图', body: BODY, widthMm: 40, heightMm: 20 },
      ],
    })
    const { body } = sheet.spec
    const solid = captionOf(body, '立体图')
    const state = captionOf(body, '使用状态参考图')
    expect(solid.x).toBeGreaterThan(captionOf(body, '俯视图').x)
    expect(state.y).toBeGreaterThan(solid.y)
    expect(state.x).toBe(solid.x)
    expect(captionOf(body, '立体图').y).toBeLessThan(captionOf(body, '主视图').y)
    expect(sheet.spec.labels).toEqual(['主视图', '左视图', '俯视图', '立体图', '使用状态参考图'])
    expect(captions(body)).toHaveLength(5)
    expect(sheet.spec.widthMm).toBe(196)
    expect(uniformScale(sheet)).toBe(1.5)
  })

  it('extras 参与公共缩放比：畸大的立体图把全部视图同比缩小', () => {
    const sheet = buildAppearanceViewSheet({
      views: [view('主视图'), view('左视图')],
      extras: [{ name: '立体图', body: BODY, widthMm: 160, heightMm: 80 }],
    })
    expect(uniformScale(sheet)).toBeCloseTo(0.375, 9)
    expect(sheet.scales['立体图']).toBeCloseTo(0.375, 9)
    // 主视图缩放后最长边 15mm < 60/3=20mm：提示过小；立体图自身占满单元格，不提示。
    expect(sheet.warnings.filter(warning => warning.includes('可能过小'))).toEqual([
      '视图 "主视图" 统一缩放后最长边 15mm 小于单元格 60mm 的 1/3，图面可能过小，请人工核对',
      '视图 "左视图" 统一缩放后最长边 15mm 小于单元格 60mm 的 1/3，图面可能过小，请人工核对',
    ])
  })

  it('公共缩放比取全局最小值，尺寸不同的视图比例一致', () => {
    const sheet = buildAppearanceViewSheet({
      views: [
        view('主视图'),
        { name: '左视图', body: BODY, widthMm: 360, heightMm: 180 },
      ],
    })
    expect(uniformScale(sheet)).toBeCloseTo(1 / 6, 9)
    // 只提示过小的主视图（最长边 6.667mm），左视图正好占满单元格 60mm。
    expect(sheet.warnings.filter(warning => warning.includes('可能过小'))).toHaveLength(1)
    expect(sheet.warnings.some(warning => warning.includes('主视图'))).toBe(true)
    expect(placements(sheet.spec.body)[0]!.scale).toBe(0.167)
  })

  it('note 透传进 warnings 且不落图面，空白 note 不产生提示', () => {
    const sheet = buildAppearanceViewSheet({
      views: [
        { ...view('主视图'), note: '省略右视图：与左视图对称' },
        { ...view('左视图'), note: '   ' },
      ],
    })
    expect(sheet.warnings).toContain('省略右视图：与左视图对称')
    expect(sheet.warnings).toHaveLength(2)
    expect(sheet.spec.body).not.toContain('对称')
    expect(sheet.spec.labels).toEqual(['主视图', '左视图'])
  })

  it('版面参数显式给出时按给定毫米值排版', () => {
    const sheet = buildAppearanceViewSheet({
      views: [view('主视图')],
      cellMm: 50,
      captionGapMm: 2,
      captionFontMm: 4,
      paddingMm: 5,
    })
    expect(sheet.spec.widthMm).toBe(60)
    expect(sheet.spec.heightMm).toBe(66)
    expect(placements(sheet.spec.body)[0]).toEqual({ x: 5, y: 30, scale: 1.25 })
    expect(captionOf(sheet.spec.body, '主视图')).toEqual({ name: '主视图', x: 30, y: 61, fontMm: 4 })
    expect(sheet.warnings).toEqual([
      '六面正投影视图不全，缺少：后视图、左视图、右视图、俯视图、仰视图；如属省略视图，应当在简要说明中写明省略原因',
    ])
  })
})

describe('buildAppearanceViewSheet 校验', () => {
  it('无视图报 empty_input', () => {
    expectError({ views: [] }, 'empty_input')
  })

  it('视图名非法或重复报 invalid_input', () => {
    const invalid: readonly AppearanceSheetInput[] = [
      { views: [invalidNamedView('左视')] },
      { views: [invalidNamedView('front')] },
      { views: [view('主视图'), view('主视图')] },
    ]
    for (const input of invalid) expectError(input, 'invalid_input')
    expect(() => buildAppearanceViewSheet({ views: [invalidNamedView('左视')] }))
      .toThrow(/未知视图名：左视/)
    expect(() => buildAppearanceViewSheet({ views: [view('左视图'), view('左视图')] }))
      .toThrow(/视图名重复：左视图/)
  })

  it('片段为空或尺寸非正/非有限报 invalid_input', () => {
    const invalid: readonly AppearanceSheetInput[] = [
      { views: [{ name: '主视图', body: '   ', widthMm: 40, heightMm: 20 }] },
      { views: [{ name: '主视图', body: BODY, widthMm: Number.NaN, heightMm: 20 }] },
      { views: [{ name: '主视图', body: BODY, widthMm: 0, heightMm: 20 }] },
      { views: [{ name: '主视图', body: BODY, widthMm: -1, heightMm: 20 }] },
      { views: [{ name: '主视图', body: BODY, widthMm: 40, heightMm: Number.NaN }] },
      { views: [{ name: '主视图', body: BODY, widthMm: 40, heightMm: 0 }] },
      { views: [view('主视图')], extras: [{ name: '立体图', body: '', widthMm: 40, heightMm: 20 }] },
      { views: [view('主视图')], extras: [{ name: '立体图', body: BODY, widthMm: Number.NaN, heightMm: 20 }] },
      { views: [view('主视图')], extras: [{ name: '立体图', body: BODY, widthMm: 40, heightMm: -20 }] },
    ]
    for (const input of invalid) expectError(input, 'invalid_input')
    expect(() => buildAppearanceViewSheet({ views: [{ name: '主视图', body: ' ', widthMm: 40, heightMm: 20 }] }))
      .toThrow(/视图片段为空：主视图/)
    expect(() => buildAppearanceViewSheet({ views: [{ name: '主视图', body: BODY, widthMm: 40, heightMm: 0 }] }))
      .toThrow(/主视图 的片段尺寸必须为正有限数（毫米）：40×0/)
  })

  it('视图片段含脚本、事件属性或嵌入文档时报 invalid_input', () => {
    const bodies = [
      '<script>alert(1)</script>',
      '<rect onload="alert(1)"/>',
      '<a href="javascript:alert(1)"><rect/></a>',
      '<a href="&#x6a;avascript:alert(1)"><rect/></a>',
      '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>',
      '<style>rect { fill: url(javascript:alert(1)) }</style>',
      '<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>',
      '<svg:foreignObject xmlns:svg="http://www.w3.org/2000/svg"><body/></svg:foreignObject>',
      '<rect fill="a>b" onload="alert(1)"/>',
      "</script><rect onload='alert(1)'/>",
      '<!ENTITY x "y">',
      '<![CDATA[<rect/>]]>',
    ]
    for (const body of bodies) {
      expectError({ views: [{ name: '主视图', body, widthMm: 40, heightMm: 20 }] }, 'invalid_input')
    }
    expect(() => buildAppearanceViewSheet({
      views: [{ name: '主视图', body: '<script>alert(1)</script>', widthMm: 40, heightMm: 20 }],
    })).toThrow(/可执行元素/)
    expect(() => buildAppearanceViewSheet({
      views: [{ name: '主视图', body: '<rect onload="alert(1)"/>', widthMm: 40, heightMm: 20 }],
    })).toThrow(/事件处理属性/)
    expect(() => buildAppearanceViewSheet({
      views: [{ name: '主视图', body: '<image href="a.png" width="10" height="10"/>', widthMm: 40, heightMm: 20 }],
    })).toThrow(/analyze_patent_figure/)
    expect(() => buildAppearanceViewSheet({
      views: [{ name: '主视图', body: '<svg:image href="a.png"/>', widthMm: 40, heightMm: 20 }],
    })).toThrow(/analyze_patent_figure/)
  })

  it('keeps quoted ">" and on…= text inside attribute values while scanning past bare "<"', () => {
    const bodies = [
      '<rect x="1" y="1" width="2" height="2" fill="a>b"/>',
      '<rect fill="a>b" aria-label="text onload=alert(1)"/>',
      '<rect aria-label="on load=" />',
      "<rect aria-label='on load=' />",
      '<text>2 < 3</text>',
      '<rect/> ',
      '<rect',
    ]
    for (const body of bodies) {
      expect(() => buildAppearanceViewSheet({
        views: [{ name: '主视图', body, widthMm: 40, heightMm: 20 }],
      })).not.toThrow()
    }
  })

  it('十进制字符引用同样解码后再检查，超出 Unicode 范围的引用原样保留', () => {
    // &#106; 是 j：解码后仍是 javascript: URL。
    expectError({
      views: [{ name: '主视图', body: '<a href="&#106;avascript:alert(1)"><rect/></a>', widthMm: 40, heightMm: 20 }],
    }, 'invalid_input')
    // 超出 0x10ffff 的码点不转成字符，作为普通文本落版。
    const sheet = buildAppearanceViewSheet({
      views: [{ name: '主视图', body: '<rect x="0" y="0" width="40" height="20" data-note="&#x110000;"/>', widthMm: 40, heightMm: 20 }],
    })
    expect(sheet.spec.body).toContain('&#x110000;')
  })

  it('版面参数非正或非有限报 invalid_input', () => {
    const invalid: readonly AppearanceSheetInput[] = [
      { views: [view('主视图')], cellMm: 0 },
      { views: [view('主视图')], cellMm: Number.NaN },
      { views: [view('主视图')], cellMm: -1 },
      { views: [view('主视图')], captionGapMm: 0 },
      { views: [view('主视图')], captionFontMm: -3.5 },
      { views: [view('主视图')], paddingMm: Number.NaN },
    ]
    for (const input of invalid) expectError(input, 'invalid_input')
    expect(() => buildAppearanceViewSheet({ views: [view('主视图')], cellMm: 0 }))
      .toThrow(/cellMm 必须是正有限数（毫米）：0/)
    expect(() => buildAppearanceViewSheet({ views: [view('主视图')], paddingMm: Number.NaN }))
      .toThrow(/paddingMm 必须是正有限数（毫米）：NaN/)
  })

  it('extras 名称与视图或其它 extras 重名报 invalid_input', () => {
    const invalid: readonly AppearanceSheetInput[] = [
      { views: [view('主视图')], extras: [{ name: '主视图', body: BODY, widthMm: 40, heightMm: 20 }] },
      {
        views: [view('主视图')],
        extras: [
          { name: '立体图', body: BODY, widthMm: 40, heightMm: 20 },
          { name: '立体图', body: BODY, widthMm: 40, heightMm: 20 },
        ],
      },
    ]
    for (const input of invalid) expectError(input, 'invalid_input')
    expect(() => buildAppearanceViewSheet({
      views: [view('主视图')],
      extras: [{ name: '主视图', body: BODY, widthMm: 40, heightMm: 20 }],
    })).toThrow(/名称重复：主视图/)
  })
})
