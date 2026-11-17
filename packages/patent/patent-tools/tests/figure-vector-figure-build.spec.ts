import { describe, expect, it } from 'vitest'
import { VectorFigureError } from '../src/figure/vector-figure.ts'
import { buildVectorFigure } from '../src/figure/vector-figure-build.ts'
import type { VectorFigureJsonInput, VectorFigureType } from '../src/figure/vector-figure-build.ts'

/**
 * 矢量图型输入映射：五种图型的 snake_case JSON → 图型模块输入，以及可选字段的
 * 透传与校验错误。图型几何本身由各图型模块的 spec 覆盖。
 */

/** 10×10 正方形零件。 */
const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]]

/** 40×20 外轮廓。 */
const OUTLINE: readonly (readonly [number, number])[] = [[0, 0], [40, 0], [40, 20], [0, 20]]

/** 图面片段（外观设计视图）。 */
const BODY = '<rect x="0" y="0" width="40" height="20"/>'

/** 运行并返回 VectorFigureError（接缝错误类型）。 */
function captureError(run: () => unknown): VectorFigureError {
  try {
    run()
  } catch (error) {
    if (error instanceof VectorFigureError) return error
    throw error
  }
  throw new Error('预期抛出 VectorFigureError，但调用正常返回')
}

describe('buildVectorFigure 电路图', () => {
  it('缺省单元尺寸不覆盖图型默认值', () => {
    const build = buildVectorFigure('circuit', {
      circuit: { components: [{ id: 'r1', kind: 'resistor', col: 0, row: 0 }], connections: [] },
    })
    expect(build.warnings).toEqual([])
    expect(build.spec.body).toContain('<rect')
  })

  it('cell_width_mm / cell_height_mm 透传为 cellWidthMm / cellHeightMm', () => {
    const build = buildVectorFigure('circuit', {
      circuit: {
        components: [{ id: 'r1', kind: 'resistor', col: 0, row: 0 }],
        connections: [],
        cell_width_mm: 20,
        cell_height_mm: 15,
      },
    })
    // 画布 = 单元格 + 两侧各 6 毫米留白（默认 18×14 时为 30×26）。
    expect(build.spec.widthMm).toBe(32)
    expect(build.spec.heightMm).toBe(27)
  })
})

describe('buildVectorFigure 曲线图', () => {
  it('只给必填字段时用图型默认值', () => {
    const build = buildVectorFigure('plot', {
      plot: { series: [{ points: [[0, 0], [1, 1]] }], x_label: '温度', y_label: '时间' },
    })
    expect(build.spec.widthMm).toBe(120)
    expect(build.spec.heightMm).toBe(80)
    expect(build.warnings.join('')).toContain('不得作为实用新型的唯一附图')
  })

  it('全部可选字段透传', () => {
    const build = buildVectorFigure('plot', {
      plot: {
        series: [{ name: 'A', points: [[0, 0], [1, 1]] }],
        x_label: '温度',
        y_label: '时间',
        x_unit: '℃',
        y_unit: 's',
        x_range: [0, 2],
        y_range: [0, 2],
        tick_count: 3,
        show_grid: true,
        width_mm: 100,
        height_mm: 60,
      },
    })
    expect(build.spec.labels).toContain('温度(℃)')
    expect(build.spec.labels).toContain('时间(s)')
    expect(build.spec.widthMm).toBe(100)
    expect(build.spec.heightMm).toBe(60)
  })

  it('rejects a point that is not two finite numbers', () => {
    const plot = { x_label: '温度', y_label: '时间' }
    for (const points of [[[]], [[1]], [[Number.NaN, 1]], [[1, Number.POSITIVE_INFINITY]]] as const) {
      expect(() => buildVectorFigure('plot', { plot: { ...plot, series: [{ points }] } })).toThrow(/数据点必须是两个有限数/)
    }
    expect(() => buildVectorFigure('plot', {
      plot: { ...plot, series: [{ points: [[0, 1]] }], x_range: [Number.NaN] },
    })).toThrow(/x_range必须是两个有限数/)
  })
})

describe('buildVectorFigure 剖视图', () => {
  it('只给零件轮廓时套用默认剖面线并提示', () => {
    const build = buildVectorFigure('cross_section', { sections: { parts: [{ outline: SQUARE }] } })
    expect(build.spec.body).toContain('<polygon')
    expect(build.warnings.join('')).toContain('未指定剖面线')
  })

  it('全部可选字段透传（轮廓/标号/中心线/剖切标记/线宽/留白）', () => {
    const build = buildVectorFigure('cross_section', {
      sections: {
        outline: OUTLINE,
        parts: [
          {
            label: '1',
            outline: SQUARE,
            holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]],
            hatch_segments: [{ from: [1, 1], to: [3, 3] }],
            hatch: { angle_deg: 30, spacing_mm: 2, direction: 'backward' },
            stroke_width_mm: 0.6,
          },
          { outline: SQUARE, hatch: 'none' },
          { outline: SQUARE, hatch: {} },
        ],
        labels: [{ text: '1', at: [5, 5], from: [0, 0] }],
        centerlines: [{ from: [0, 0], to: [10, 10] }],
        cutting_marks: [{ id: 'A', from: [0, 0], to: [10, 10], arrow: 'right' }],
        label_font_size_mm: 3.5,
        stroke_width_mm: 0.5,
        thin_stroke_width_mm: 0.25,
        padding_mm: 4,
      },
    })
    expect(build.spec.body).toContain('stroke-width="0.6"')
    expect(build.warnings.join('')).not.toContain('未指定剖面线')
  })

  it('标号省略引线起点时只画文字，不画引线', () => {
    const sections = { parts: [{ outline: SQUARE, hatch: 'none' as const }] }
    const withLeader = buildVectorFigure('cross_section', {
      sections: { ...sections, labels: [{ text: '1', at: [5, 5], from: [0, 0] }] },
    })
    const withoutLeader = buildVectorFigure('cross_section', {
      sections: { ...sections, labels: [{ text: '1', at: [5, 5] }] },
    })
    expect(withoutLeader.spec.labels).toContain('1')
    expect(withoutLeader.spec.body).not.toBe(withLeader.spec.body)
    expect(withoutLeader.spec.body).not.toContain('<line')
  })

  it('defaultFontMm 作为 label_font_size_mm 的缺省', () => {
    const build = buildVectorFigure('cross_section', {
      sections: { parts: [{ outline: SQUARE, hatch: 'none' }] },
      defaultFontMm: 4.23,
    })
    expect(build.spec.body.length).toBeGreaterThan(0)
  })

  it('require_explicit_hatch 开启时缺 hatch 即报错', () => {
    const error = captureError(() => buildVectorFigure('cross_section', {
      sections: { parts: [{ outline: SQUARE }] },
      require_explicit_hatch: true,
    }))
    expect(error.message).toContain('require_explicit_hatch')
  })

  it('require_cutting_marks 开启时缺剖切位置符号即报错', () => {
    const error = captureError(() => buildVectorFigure('cross_section', {
      sections: { parts: [{ outline: SQUARE, hatch: 'none' }] },
      require_cutting_marks: true,
    }))
    expect(error.message).toContain('require_cutting_marks')
  })

  it('零件缺 outline 时报出零件序号', () => {
    const error = captureError(() => buildVectorFigure('cross_section', {
      sections: { parts: [{ outline: SQUARE, hatch: 'none' }, { hatch: 'none' }] },
    }))
    expect(error.message).toContain('零件 #2 缺少 outline')
  })

  it('同一零件名出现在多个轮廓上时提示改用 labels 指定落点', () => {
    const build = buildVectorFigure('cross_section', {
      sections: {
        parts: [
          { label: '壳体', outline: SQUARE, hatch: 'none' },
          { label: '壳体', outline: SQUARE, hatch: 'none' },
          { label: '盖板', outline: SQUARE, hatch: 'none' },
        ],
      },
    })
    expect(build.warnings.join('\n')).toContain('零件名「壳体」出现在 2 个轮廓上')
  })
})

describe('buildVectorFigure 时序图', () => {
  it('只给参与者与消息时用图型默认值', () => {
    const build = buildVectorFigure('sequence_diagram', {
      sequence: {
        participants: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
        messages: [{ from: 'a', to: 'b', label: '请求' }],
      },
    })
    expect(build.spec.widthMm).toBeGreaterThan(0)
    expect(build.warnings).toEqual([])
  })

  it('盒宽/消息间距/留白透传', () => {
    const build = buildVectorFigure('sequence_diagram', {
      sequence: {
        participants: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
        messages: [{ from: 'a', to: 'b', label: '请求' }],
        box_width_mm: 40,
        message_spacing_mm: 12,
        padding_mm: 6,
      },
    })
    expect(build.spec.body).toContain('width="40"')
  })
})

describe('buildVectorFigure 外观设计视图', () => {
  it('只给视图时用版面默认值', () => {
    const build = buildVectorFigure('appearance_view', {
      appearance_views: {
        views: [{ name: '主视图', body: BODY, width_mm: 40, height_mm: 20 }],
      },
    })
    expect(build.spec.body).toContain('主视图')
  })

  it('note/extras 与版面参数全部透传', () => {
    const build = buildVectorFigure('appearance_view', {
      appearance_views: {
        views: [{ name: '主视图', body: BODY, width_mm: 40, height_mm: 20, note: '主视' }],
        extras: [{ name: '立体图', body: BODY, width_mm: 40, height_mm: 20 }],
        cell_mm: 50,
        caption_gap_mm: 4,
        caption_font_mm: 3,
        padding_mm: 6,
        first_angle: false,
      },
    })
    expect(build.spec.body).toContain('立体图')
  })
})

describe('buildVectorFigure 输入校验', () => {
  it('缺少对应图型输入时按 empty_input 报错', () => {
    const cases: [VectorFigureType, VectorFigureJsonInput][] = [
      ['circuit', {}],
      ['plot', {}],
      ['cross_section', {}],
      ['sequence_diagram', {}],
      ['appearance_view', {}],
    ]
    for (const [figureType, input] of cases) {
      const error = captureError(() => buildVectorFigure(figureType, input))
      expect(error.message).toContain(figureType)
      expect(error.message).toContain('需要')
    }
  })

  it('未知图型走到闭合联合兜底', () => {
    const unknownType: VectorFigureType = 'unknown_type' as VectorFigureType
    const error = captureError(() => buildVectorFigure(unknownType, {}))
    expect(error.message).toContain('未知矢量图型')
  })
})
