import { describe, expect, it, vi } from 'vitest'
import { buildPlotDiagram } from '../src/figure/plot-diagram.ts'
import type { PlotDiagramInput } from '../src/figure/plot-diagram.ts'
import { VectorFigureError, fmt } from '../src/figure/vector-figure.ts'
import type { VectorFigureErrorCode } from '../src/figure/vector-figure.ts'

/**
 * 曲线图几何：坐标轴与刻度、自动/显式范围、标记形状、图例折行与黑白约束。
 * 默认布局常量（模块内）：画布 120×80、左边距 22、右边距 8、上边距 6、
 * 横轴下方 13（每行图例再加 5）；绘图区因此为 x∈[22,112]、y∈[6,67]。
 */

/** 错误构造参数：本模块的校验约定是错误码，而接缝实例不保留 code，故在构造处记录。 */
const raisedErrors: { code: string; message: string }[] = []

vi.mock('../src/figure/vector-figure.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/figure/vector-figure.ts')>()
  /** 记录构造参数后委托接缝实现。 */
  class RecordingVectorFigureError extends actual.VectorFigureError {
    constructor(code: VectorFigureErrorCode, message: string) {
      raisedErrors.push({ code, message })
      super(code, message)
    }
  }
  return { ...actual, VectorFigureError: RecordingVectorFigureError }
})

/** 与默认布局一致的绘图区（几何断言据此推导，不用魔数）。 */
const PLOT = { left: 22, right: 112, top: 6, bottom: 67, width: 90, height: 61 }

/** 取图例文本的 y 坐标（图例文本用 start 锚点，轴上的文本用 middle/end）。 */
function legendTextYs(body: string): string[] {
  return [...body.matchAll(/<text x="[\d.-]+" y="([\d.-]+)" font-size="[\d.]+" text-anchor="start"/g)]
    .map(match => match[1] ?? '')
}

/** 构建并返回本次抛出的错误构造参数；未抛错或抛错类型不符时失败。 */
function raisedError(input: PlotDiagramInput): { code: string; message: string } {
  raisedErrors.length = 0
  let thrown: unknown
  try {
    buildPlotDiagram(input)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(VectorFigureError)
  const recorded = raisedErrors[0]
  if (recorded === undefined) throw new Error('未记录到错误构造参数')
  return recorded
}

describe('buildPlotDiagram 坐标范围与刻度', () => {
  it('缺省范围按数据 min/max 外扩 5%，刻度数量默认 5（含端点）', () => {
    const spec = buildPlotDiagram({
      series: [{ points: [[0, 0], [10, 20]] }],
      xLabel: '温度',
      yLabel: '时间',
      xUnit: '℃',
      yUnit: 's',
    })
    // x: [0,10] → [-0.5, 10.5]，步长 2.75；y: [0,20] → [-1, 21]，步长 5.5。
    expect(spec.labels).toEqual([
      '温度(℃)', '时间(s)',
      '-0.5', '2.25', '5', '7.75', '10.5',
      '-1', '4.5', '10', '15.5', '21',
    ])
    expect(spec.widthMm).toBe(120)
    expect(spec.heightMm).toBe(80)
  })

  it('min == max 且值非零时对称外扩 5%（单点序列）', () => {
    const spec = buildPlotDiagram({ series: [{ points: [[5, 5]] }], xLabel: '温度', yLabel: '时间' })
    // 跨度 0 → 半宽 |5|×5% = 0.25 → [4.75, 5.25]，步长 0.125；两轴范围相同，数值去重。
    expect(spec.labels).toEqual(['温度', '时间', '4.75', '4.875', '5', '5.125', '5.25'])
  })

  it('min == max == 0 时按 1 对称外扩', () => {
    const spec = buildPlotDiagram({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间' })
    expect(spec.labels).toEqual(['温度', '时间', '-1', '-0.5', '0', '0.5', '1'])
  })

  it('显式 xRange/yRange 覆盖自动范围，坐标按比例映射到绘图区', () => {
    const spec = buildPlotDiagram({
      series: [{ name: '升温', points: [[50, 5]] }],
      xLabel: '温度',
      yLabel: '时间',
      xRange: [0, 100],
      yRange: [-10, 10],
      tickCount: 3,
    })
    expect(spec.labels).toEqual(['温度', '时间', '0', '50', '100', '-10', '10', '升温'])
    // x=50 落在绘图区半宽处，y=5 落在 3/4 高度处。
    const x = PLOT.left + 0.5 * PLOT.width
    const y = PLOT.bottom - 0.75 * PLOT.height
    expect(spec.body).toContain(`points="${fmt(x)},${fmt(y)}"`)
    expect(spec.body).toContain(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="0.9"`)
  })

  it('tickCount 可覆盖：2 只取端点，11 为上限', () => {
    const two = buildPlotDiagram({ series: [{ points: [[0, 0], [10, 10]] }], xLabel: '温度', yLabel: '时间', tickCount: 2 })
    expect(two.labels).toEqual(['温度', '时间', '-0.5', '10.5'])
    const eleven = buildPlotDiagram({ series: [{ points: [[0, 0], [10, 100]] }], xLabel: '温度', yLabel: '时间', tickCount: 11 })
    // 每轴 11 个刻度值（两轴取值不重合）+ 两个轴标目。
    expect(eleven.labels).toHaveLength(24)
    expect(eleven.labels).toContain('1.7')
    expect(eleven.labels).toContain('105')
  })

  it('刻度短线朝外，刻度数值写在轴外侧，轴标目（含单位）写在轴中部且纵轴旋转 90°', () => {
    const spec = buildPlotDiagram({
      series: [{ points: [[0, 0], [1, 1]] }],
      xLabel: '温度',
      yLabel: '时间',
      xUnit: '℃',
      yUnit: 's',
    })
    // x 范围下限（-0.05）映射到绘图区左边界，刻度短线自 y=67 向下。
    expect(spec.body).toContain(`<line x1="${fmt(PLOT.left)}" y1="${fmt(PLOT.bottom)}" x2="${fmt(PLOT.left)}" y2="${fmt(PLOT.bottom + 1.5)}" stroke="#000000" stroke-width="0.25"/>`)
    // y 范围上限（1.05）映射到绘图区上边界，刻度短线自 x=22 向左。
    expect(spec.body).toContain(`<line x1="${fmt(PLOT.left)}" y1="${fmt(PLOT.top)}" x2="${fmt(PLOT.left - 1.5)}" y2="${fmt(PLOT.top)}" stroke="#000000" stroke-width="0.25"/>`)
    // 轴端开口箭头（横轴右端）在右下方收拢。
    expect(spec.body).toContain(`<line x1="${fmt(PLOT.right)}" y1="${fmt(PLOT.bottom)}" x2="${fmt(PLOT.right - 2.2)}" y2="${fmt(PLOT.bottom - 0.7)}"`)
    // 横轴标目在轴中部、刻度数值下方；纵轴标目旋转 90° 后锚点同样在轴中部。
    expect(spec.body).toContain('<text x="67" y="77.9" font-size="3.2" text-anchor="middle" fill="#000000" stroke="none">温度(℃)</text>')
    expect(spec.body).toContain('transform="rotate(-90 14.3 36.5)"')
    expect(spec.body).toContain('>时间(s)</text>')
  })

  it('showGrid 默认关闭；开启后每轴各 tickCount 条细实线网格', () => {
    const data = { series: [{ points: [[0, 0], [10, 10]] }], xLabel: '温度', yLabel: '时间' } as const
    expect(buildPlotDiagram({ ...data }).body).not.toContain('stroke-width="0.15"')
    expect(buildPlotDiagram({ ...data, showGrid: true }).body.match(/stroke-width="0.15"/g)).toHaveLength(10)
  })

  it('画布尺寸可覆盖，绘图区随之伸缩', () => {
    const spec = buildPlotDiagram({
      series: [{ points: [[0, 0], [10, 10]] }],
      xLabel: '温度',
      yLabel: '时间',
      widthMm: 60,
      heightMm: 40,
    })
    expect(spec.widthMm).toBe(60)
    expect(spec.heightMm).toBe(40)
    // 横轴右端箭头随画布右边界（60 − 8 = 52）与横轴（40 − 13 = 27）移动。
    expect(spec.body).toContain('x1="52" y1="27"')
  })
})

describe('buildPlotDiagram 数据序列', () => {
  it('marker 四种取值：默认 circle、square、triangle 与 none（只连线）', () => {
    const body = (marker?: 'none' | 'circle' | 'square' | 'triangle'): string => buildPlotDiagram({
      series: [{ points: [[0, 0], [1, 1]], ...(marker === undefined ? {} : { marker }) }],
      xLabel: '温度',
      yLabel: '时间',
      xRange: [0, 1],
      yRange: [0, 1],
    }).body
    expect(body()).toContain('<circle ')
    expect(body('circle')).toContain('<circle ')
    expect(body('square')).toContain('<rect ')
    expect(body('triangle')).toContain('<polygon ')
    const none = body('none')
    expect(none).toContain('<polyline ')
    expect(none).not.toContain('<circle ')
    expect(none).not.toContain('<rect ')
    expect(none).not.toContain('<polygon ')
  })

  it('折线用 0.25 实线，标记为黑色空心，图面只用 #000000 且无比例说明', () => {
    const spec = buildPlotDiagram({
      series: [{ points: [[0, 0], [1, 1]] }, { points: [[0, 1], [1, 0]], marker: 'triangle' }],
      xLabel: '温度',
      yLabel: '时间',
      xRange: [0, 1],
      yRange: [0, 1],
    })
    expect(spec.body.match(/<polyline points="[^"]*" fill="none" stroke="#000000" stroke-width="0.25"\/>/g)).toHaveLength(2)
    expect(spec.body).toContain(`<circle cx="${fmt(PLOT.left)}" cy="${fmt(PLOT.bottom)}" r="0.9" fill="none" stroke="#000000" stroke-width="0.25"/>`)
    const colors = spec.body.match(/#[0-9a-fA-F]{3,6}/g) ?? []
    expect(colors.length).toBeGreaterThan(0)
    expect(colors.every(color => color === '#000000')).toBe(true)
    expect(spec.body).not.toMatch(/比例|actual size|scale|1:2|尺寸线/i)
  })

  it('单序列不画图例，序列名仍进图面词语', () => {
    const spec = buildPlotDiagram({
      series: [{ name: '甲曲线', points: [[0, 0], [1, 1]] }],
      xLabel: '温度',
      yLabel: '时间',
    })
    expect(legendTextYs(spec.body)).toEqual([])
    expect(spec.labels).toContain('甲曲线')
  })

  it('多序列在横轴下方列出一行图例，序列名进图面词语', () => {
    const spec = buildPlotDiagram({
      series: [
        { name: '甲曲线', points: [[0, 0], [1, 1]] },
        { name: '乙曲线', points: [[0, 1], [1, 0]], marker: 'none' },
      ],
      xLabel: '温度',
      yLabel: '时间',
    })
    const ys = legendTextYs(spec.body)
    expect(ys).toHaveLength(2)
    expect(new Set(ys).size).toBe(1)
    expect(spec.body).toContain('>甲曲线</text>')
    expect(spec.body).toContain('>乙曲线</text>')
    // 圆圈：甲曲线两个数据点 + 甲的图例示例；乙曲线只连线，图例用短线段。
    expect(spec.body.match(/<circle /g)).toHaveLength(3)
    expect(spec.labels).toContain('甲曲线')
    expect(spec.labels).toContain('乙曲线')
  })

  it('图例条目超出可用宽度时折行', () => {
    const spec = buildPlotDiagram({
      series: Array.from({ length: 4 }, (_, index) => ({ name: `第一条曲线名称甲${index + 1}`, points: [[index, index]] })),
      xLabel: '温度',
      yLabel: '时间',
    })
    const ys = legendTextYs(spec.body)
    expect(ys).toHaveLength(4)
    // 每条目 4 + 8×3.2 = 29.6 毫米，90 毫米宽只放得下两条 → 两行。
    expect(ys[0]).toBe(ys[1])
    expect(ys[2]).toBe(ys[3])
    expect(ys[0]).not.toBe(ys[2])
  })

  it('无名、空白序列名不写图例也不进图面词语；名字两端空白被裁掉', () => {
    const spec = buildPlotDiagram({
      series: [
        { points: [[0, 0], [1, 1]] },
        { name: '   ', points: [[0, 1], [1, 0]] },
        { name: ' 丙曲线 ', points: [[0, 0.5], [1, 0.5]] },
      ],
      xLabel: '温度',
      yLabel: '时间',
    })
    expect(legendTextYs(spec.body)).toHaveLength(1)
    expect(spec.body).toContain('>丙曲线</text>')
    expect(spec.labels).toContain('丙曲线')
    expect(spec.labels).not.toContain('')
    expect(spec.labels).not.toContain('   ')
  })

  it('序列名按 XML 文本转义后写入图面', () => {
    const spec = buildPlotDiagram({
      series: [{ name: 'a<b&c', points: [[0, 0]] }, { name: '第二', points: [[1, 1]] }],
      xLabel: '温度',
      yLabel: '时间',
    })
    expect(spec.body).toContain('>a&lt;b&amp;c</text>')
    expect(spec.labels).toContain('a<b&c')
  })
})

describe('buildPlotDiagram 轴标目与单位', () => {
  it('单位写入标目后的括号内，格式为「温度(℃)」', () => {
    const spec = buildPlotDiagram({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', xUnit: '℃', yUnit: 's' })
    expect(spec.labels[0]).toBe('温度(℃)')
    expect(spec.labels[1]).toBe('时间(s)')
  })

  it('单位缺省、空串或全空白都不加括号，两侧空白被裁掉', () => {
    const xTitle = (xUnit?: string): string => buildPlotDiagram({
      series: [{ points: [[0, 0]] }],
      xLabel: '温度',
      yLabel: '时间',
      ...(xUnit === undefined ? {} : { xUnit }),
    }).labels[0] ?? ''
    expect(xTitle(' s ')).toBe('温度(s)')
    expect(xTitle()).toBe('温度')
    expect(xTitle('')).toBe('温度')
    expect(xTitle('   ')).toBe('温度')
  })
})

describe('buildPlotDiagram 校验', () => {
  it('未给出数据序列时抛 empty_input', () => {
    expect(raisedError({ series: [], xLabel: '温度', yLabel: '时间' }).code).toBe('empty_input')
  })

  it('序列无数据点时抛 invalid_input（报文带序列名，无名时留空）', () => {
    const error = raisedError({ series: [{ name: '甲', points: [] }], xLabel: '温度', yLabel: '时间' })
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('甲')
    const unnamed = raisedError({ series: [{ points: [] }], xLabel: '温度', yLabel: '时间' })
    expect(unnamed.code).toBe('invalid_input')
    expect(unnamed.message).toContain('数据序列「」没有数据点')
  })

  it('坐标非有限数时抛 invalid_input', () => {
    const points: [number, number][] = [[Number.NaN, 0], [0, Number.NaN], [Number.POSITIVE_INFINITY, 0], [0, Number.NEGATIVE_INFINITY]]
    for (const point of points) {
      const error = raisedError({ series: [{ points: [point] }], xLabel: '温度', yLabel: '时间' })
      expect(error.code, String(point)).toBe('invalid_input')
      expect(error.message).toContain('有限数')
    }
  })

  it('xRange 非递增或含非有限数时抛 invalid_input', () => {
    const ranges: [number, number][] = [[5, 5], [10, 0], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]
    for (const range of ranges) {
      const error = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', xRange: range })
      expect(error.code, String(range)).toBe('invalid_input')
      expect(error.message).toContain('xRange')
    }
  })

  it('yRange 非递增或含非有限数时抛 invalid_input', () => {
    for (const range of [[1, 1], [0, Number.NaN]] as [number, number][]) {
      const error = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', yRange: range })
      expect(error.code, String(range)).toBe('invalid_input')
      expect(error.message).toContain('yRange')
    }
  })

  it('刻度数量越界或非整数时抛 invalid_input', () => {
    for (const tickCount of [1, 12, 2.5, Number.NaN]) {
      const error = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', tickCount })
      expect(error.code, String(tickCount)).toBe('invalid_input')
      expect(error.message).toContain('刻度数量')
    }
  })

  it('画布尺寸非正或非有限数时抛 invalid_input', () => {
    const sizes: [number, number][] = [[0, 80], [-1, 80], [Number.NaN, 80], [120, 0], [120, -1], [120, Number.NaN]]
    for (const [widthMm, heightMm] of sizes) {
      const error = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', widthMm, heightMm })
      expect(error.code, `${String(widthMm)}×${String(heightMm)}`).toBe('invalid_input')
      expect(error.message).toContain('画布尺寸')
    }
  })

  it('画布扣除边距、轴带与图例后没有绘图区时抛 invalid_input', () => {
    const tooNarrow = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', widthMm: 20, heightMm: 80 })
    expect(tooNarrow.code).toBe('invalid_input')
    expect(tooNarrow.message).toContain('画布宽度')

    const tooShort = raisedError({ series: [{ points: [[0, 0]] }], xLabel: '温度', yLabel: '时间', widthMm: 120, heightMm: 18 })
    expect(tooShort.code).toBe('invalid_input')
    expect(tooShort.message).toContain('画布高度')

    const legendEatsHeight = raisedError({
      series: [
        { name: '序列一', points: [[0, 0]] },
        { name: '序列二', points: [[1, 1]] },
      ],
      xLabel: '温度',
      yLabel: '时间',
      widthMm: 120,
      heightMm: 20,
    })
    expect(legendEatsHeight.code).toBe('invalid_input')
    expect(legendEatsHeight.message).toContain('图例')
  })
})

describe('fmt 分支（vector-figure 接缝）', () => {
  it('保留至多 3 位小数并去掉尾随零', () => {
    expect(fmt(0.1 + 0.2)).toBe('0.3')
    expect(fmt(1 / 3)).toBe('0.333')
    expect(fmt(-1.5)).toBe('-1.5')
  })

  it('非有限数抛错（接缝自身抛原始 VectorFigureError，故断言报文）', () => {
    expect(() => fmt(Number.NaN)).toThrow('坐标必须是有限数')
  })
})
