import { describe, expect, it } from 'vitest'
import {
  SECTION_ARC_STEP_DEG,
  SECTION_CHORD_STEP_MM,
  SECTION_COORD_DECIMALS,
  SECTION_MAX_EDGE_SAMPLES,
  SectionGeometryError,
  parseSectionGeometry,
  pointInPolygon,
  readSectionGeometry,
  resolveSectionFrame,
  type SectionGeometryPayload,
} from '../src/figure/freecad-section-geometry.ts'
import { SECTION_GEOMETRY_FILENAME, buildSectionScript } from '../src/figure/freecad-section-script.ts'

/**
 * 无文档剖切几何的纯逻辑测试：视图帧解析、环归并与面积核对、脚本构建。
 * 全部不依赖 FreeCAD（真实剖切见 figure-freecad-real-render.spec.ts）。
 */

/** 矩形顶点（逆时针，隐式闭合）。 */
function rect(width: number, height: number, centerX = 0, centerY = 0): (readonly [number, number])[] {
  const x0 = centerX - width / 2
  const x1 = centerX + width / 2
  const y0 = centerY - height / 2
  const y1 = centerY + height / 2
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/** 多边形绝对面积（测试用独立实现，不复用被测代码）。 */
function area(points: readonly (readonly [number, number])[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] as readonly [number, number]
    const next = points[(index + 1) % points.length] as readonly [number, number]
    sum += current[0] * next[1] - next[0] * current[1]
  }
  return Math.abs(sum / 2)
}

/** 顶点转成产物 JSON 的 `number[][]` 形状（JSON 边界给的是可写数组，不是元组）。 */
function pointsOf(points: readonly (readonly [number, number])[]): number[][] {
  return points.map(point => [...point])
}

/** 一个环的产物记录（`area_mm2` 缺省取多边形自身面积，即离散与精确一致）。 */
function ring(points: readonly (readonly [number, number])[], declaredArea?: number): SectionGeometryPayload['rings'][number] {
  return { points_mm: pointsOf(points), closed: true, area_mm2: declaredArea ?? area(points) }
}

/** 组装脚本产物。 */
function payload(
  rings: SectionGeometryPayload['rings'],
  sliceFaceArea: number | null = null,
): SectionGeometryPayload {
  return {
    model: { path: '/tmp/model.step', solids: 1, bound_box_mm: { min: [-30, -15, 0], max: [30, 15, 8] } },
    plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
    rings,
    slice_face_area_mm2: sliceFaceArea,
  }
}

/** 正多边形（近似圆孔）。 */
function polygon(sides: number, radius: number, centerX = 0, centerY = 0): (readonly [number, number])[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = (2 * Math.PI * index) / sides
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
  })
}

describe('resolveSectionFrame', () => {
  it('缺省参考方向按 +X → +Y → +Z 取第一个与法向不平行的坐标轴', () => {
    expect(resolveSectionFrame({ origin: [0, 0, 4], normal: [0, 0, 2] })).toEqual({
      origin: [0, 0, 4],
      normal: [0, 0, 1],
      right: [1, 0, 0],
      down: [0, 1, 0],
    })
    expect(resolveSectionFrame({ origin: [1, 0, 0], normal: [1, 0, 0] }).right).toEqual([0, 1, 0])
    expect(resolveSectionFrame({ origin: [0, 1, 0], normal: [0, 1, 0] }).down).toEqual([0, 0, -1])
  })

  it('法向反向时 down 随之翻转，right 不变', () => {
    expect(resolveSectionFrame({ origin: [0, 0, 4], normal: [0, 0, -1] }).down).toEqual([0, -1, 0])
    expect(resolveSectionFrame({ origin: [0, 0, 4], normal: [0, 0, -1] }).right).toEqual([1, 0, 0])
  })

  it('显式参考方向被正交化到平面内', () => {
    const frame = resolveSectionFrame({ origin: [0, 0, 0], normal: [0, 0, 1], reference: [1, 1, 5] })
    expect(frame.right[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(frame.right[1]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(frame.right[2]).toBeCloseTo(0, 12)
    expect(frame.down[0]).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(frame.down[1]).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('三个基向量恒为单位且两两正交', () => {
    const normals: [number, number, number][] = [
      [0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 1, 1], [-2, 3, -5], [0.4, -0.2, 0.9],
    ]
    for (const normal of normals) {
      const frame = resolveSectionFrame({ origin: [0, 0, 0], normal })
      const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
      expect(dot(frame.right, frame.right)).toBeCloseTo(1, 12)
      expect(dot(frame.down, frame.down)).toBeCloseTo(1, 12)
      expect(dot(frame.normal, frame.right)).toBeCloseTo(0, 12)
      expect(dot(frame.normal, frame.down)).toBeCloseTo(0, 12)
      expect(dot(frame.right, frame.down)).toBeCloseTo(0, 12)
    }
  })

  it('法向为零、分量非有限、参考方向与法向平行都报错并指明字段', () => {
    const zero = captureError(() => resolveSectionFrame({ origin: [0, 0, 0], normal: [0, 0, 0] }))
    expect(zero.code).toBe('invalid_input')
    expect(zero.message).toContain('剖切平面法向 normal')
    const infinite = captureError(() => resolveSectionFrame({ origin: [Number.NaN, 0, 0], normal: [0, 0, 1] }))
    expect(infinite.message).toContain('剖切平面原点 origin')
    const parallel = captureError(() => resolveSectionFrame({ origin: [0, 0, 0], normal: [0, 0, 1], reference: [0, 0, 5] }))
    expect(parallel.message).toContain('平行')
    expect(parallel.message).toContain('剖切平面参考方向 reference')
  })
})

describe('readSectionGeometry 环归并', () => {
  it('外环加一个孔：深度 0/1，净面积为差', () => {
    const geometry = readSectionGeometry(payload([ring(rect(40, 20)), ring(rect(4, 4))]))
    expect(geometry.rings.map(item => item.depth)).toEqual([0, 1])
    expect(geometry.regions).toEqual([{ outer: 0, holes: [1], netAreaMm2: 800 - 16 }])
    expect(geometry.model.boundBoxMm.max).toEqual([30, 15, 8])
    expect(geometry.frame.down).toEqual([0, 1, 0])
  })

  it('孔内的岛：深度 2 自成区域，孔归属最近的外环', () => {
    const geometry = readSectionGeometry(payload([ring(rect(40, 20)), ring(rect(10, 10)), ring(rect(2, 2))]))
    expect(geometry.rings.map(item => item.depth)).toEqual([0, 1, 2])
    expect(geometry.regions).toEqual([
      { outer: 0, holes: [1], netAreaMm2: 800 - 100 },
      { outer: 2, holes: [], netAreaMm2: 4 },
    ])
  })

  it('两个互不相交的零件各自成区域', () => {
    const geometry = readSectionGeometry(payload([ring(rect(10, 10, -20, 0)), ring(rect(6, 6, 20, 0))]))
    expect(geometry.rings.map(item => item.depth)).toEqual([0, 0])
    expect(geometry.regions).toEqual([
      { outer: 0, holes: [], netAreaMm2: 100 },
      { outer: 1, holes: [], netAreaMm2: 36 },
    ])
  })

  it('多处孔按环序归属', () => {
    const geometry = readSectionGeometry(payload([
      ring(rect(60, 30)),
      ring(rect(4, 4, -20, 0)),
      ring(rect(6, 6, 20, 0)),
    ]))
    expect(geometry.regions).toEqual([{ outer: 0, holes: [1, 2], netAreaMm2: 1800 - 16 - 36 }])
  })

  it('同深度父环按包含关系筛选：不包含的候选跳过，相等深度取先出现的', () => {
    // A 是外轮廓；P1/P2 的探针都落在 A 内、但都伸出 A 之外；C 同时落在 P1 与 P2 内、
    // 却在 A 外 —— 于是 C 的深度为 2，两个深度 1 的候选都包含它，父环取环序在前者。
    const geometry = readSectionGeometry(payload([
      ring([[10, 10], [-10, 10], [-10, -10], [10, -10]]),
      ring([[2, 2], [-20, 2], [-20, -20], [2, -20]]),
      ring([[1, 6], [-21, 6], [-21, -18], [1, -18]]),
      ring(rect(4, 4, -15, 0)),
      ring(rect(2, 2, 30, 30)),
    ]))
    expect(geometry.rings.map(item => item.depth)).toEqual([0, 1, 1, 2, 0])
    expect(geometry.regions[0]).toEqual({ outer: 0, holes: [1, 2], netAreaMm2: 400 - 484 - 528 })
    expect(geometry.regions[1]).toEqual({ outer: 3, holes: [], netAreaMm2: 16 })
  })
})

describe('readSectionGeometry 面积核对', () => {
  it('离散粗到超过 0.1% 即报错，并给出环号与偏差百分比', () => {
    const error = captureError(() => readSectionGeometry(payload([
      ring(rect(40, 20)),
      ring(polygon(6, 5), Math.PI * 25),
    ])))
    expect(error.code).toBe('area_mismatch')
    expect(error.message).toContain('轮廓环 #2')
    expect(error.message).toContain('超过 0.1%')
    expect(error.message).toMatch(/相对偏差 \d+(\.\d+)?%/)
  })

  it('240 边形与精确圆面积在容差内（真实剖切的离散档位）', () => {
    const geometry = readSectionGeometry(payload([ring(rect(40, 20)), ring(polygon(240, 5), Math.PI * 25)]))
    expect(geometry.regions[0]?.netAreaMm2).toBeCloseTo(800 - Math.PI * 25, 6)
  })

  it('整块切片只有一个区域时另与成面面积对比', () => {
    const rings = [ring(rect(40, 20)), ring(polygon(240, 5), Math.PI * 25)]
    expect(readSectionGeometry(payload(rings, 800 - Math.PI * 25)).regions).toHaveLength(1)
    const error = captureError(() => readSectionGeometry(payload(rings, 900)))
    expect(error.code).toBe('area_mismatch')
    expect(error.message).toContain('剖切净面积')
  })

  it('多个区域时不比成面面积（Bullseye 只对单一区域成立）', () => {
    const geometry = readSectionGeometry(payload([
      ring(rect(10, 10, -20, 0)),
      ring(rect(6, 6, 20, 0)),
    ], 36))
    expect(geometry.regions).toHaveLength(2)
  })
})

describe('readSectionGeometry 产物结构核对', () => {
  it('解析 JSON 文本', () => {
    const geometry = parseSectionGeometry(JSON.stringify(payload([ring(rect(40, 20))], 800)))
    expect(geometry.rings[0]?.points).toHaveLength(4)
  })

  it('环列表为空即报错（平面位于实体之外时脚本之前不会产出几何）', () => {
    const error = captureError(() => readSectionGeometry(payload([])))
    expect(error.code).toBe('invalid_payload')
    expect(error.message).toContain('未与模型相交')
  })

  it('环列表不是数组、环未闭合、顶点不足、坐标非有限、面积非正都报错', () => {
    const notArray = captureError(() => readSectionGeometry(JSON.parse('{"rings":null}') as SectionGeometryPayload))
    expect(notArray.code).toBe('invalid_payload')
    const open = captureError(() => readSectionGeometry(payload([{ points_mm: pointsOf(rect(4, 4)), closed: false, area_mm2: 16 }])))
    expect(open.message).toContain('未闭合')
    const few = captureError(() => readSectionGeometry(payload([{ points_mm: [[0, 0], [1, 1]], closed: true, area_mm2: 1 }])))
    expect(few.message).toContain('顶点少于 3')
    const badPoint: SectionGeometryPayload['rings'][number] = {
      points_mm: [[0, 0], [1, 1], [Number.NaN, 2]],
      closed: true,
      area_mm2: 1,
    }
    const notFinite = captureError(() => readSectionGeometry(payload([badPoint])))
    expect(notFinite.message).toContain('有限二维坐标')
    expect(notFinite.message).toContain('第 3 个顶点')
    const noArea = captureError(() => readSectionGeometry(payload([{ points_mm: pointsOf(rect(4, 4)), closed: true, area_mm2: 0 }])))
    expect(noArea.message).toContain('OCCT 面面积')
    const frameBroken = captureError(() => readSectionGeometry({
      ...payload([ring(rect(4, 4))]),
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], right: [1, 0, 0], down: [0, Number.NaN, 1], distance: 0 },
    }))
    expect(frameBroken.message).toContain('视图帧向下')
  })
})

describe('section geometry leaf fields', () => {
  it('模型路径、实体数与剖切距离不是合法值时都报错', () => {
    const badPath = captureError(() => readSectionGeometry({
      ...payload([ring(rect(4, 4))]),
      model: { path: '  ', solids: 1, bound_box_mm: { min: [-1, -1, 0], max: [1, 1, 1] } },
    }))
    expect(badPath.message).toContain('模型路径')

    const badSolids = captureError(() => readSectionGeometry({
      ...payload([ring(rect(4, 4))]),
      model: { path: '/tmp/m.step', solids: 1.5, bound_box_mm: { min: [-1, -1, 0], max: [1, 1, 1] } },
    }))
    expect(badSolids.message).toContain('实体数')

    const badDistance = captureError(() => readSectionGeometry({
      ...payload([ring(rect(4, 4))]),
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: Number.POSITIVE_INFINITY },
    }))
    expect(badDistance.message).toContain('距离')
  })
})

describe('pointInPolygon', () => {
  it('内外判定与凹多边形', () => {
    const square = rect(10, 10)
    expect(pointInPolygon([0, 0], square)).toBe(true)
    expect(pointInPolygon([6, 0], square)).toBe(false)
    // L 形凹多边形：左上角被挖掉（x < 5 且 y > 5 不在图形内）
    const concave: (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [5, 10], [5, 5], [0, 5]]
    expect(pointInPolygon([7, 7], concave)).toBe(true)
    expect(pointInPolygon([2, 2], concave)).toBe(true)
    expect(pointInPolygon([2, 7], concave)).toBe(false)
  })
})

describe('buildSectionScript', () => {
  const frame = resolveSectionFrame({ origin: [0, 0, 4], normal: [0, 0, 1] })

  it('同一入参恒返回同一段 Python 文本', () => {
    const first = buildSectionScript({ modelPath: '/tmp/a.step', frame, outputDir: '/tmp/out' })
    const second = buildSectionScript({ modelPath: '/tmp/a.step', frame, outputDir: '/tmp/out' })
    expect(first).toBe(second)
  })

  it('把视图帧、采样档位与输出文件名内嵌进 payload', () => {
    const script = buildSectionScript({ modelPath: '/tmp/模型 a.step', frame, outputDir: '/tmp/out' })
    const match = /^PARAMS = json\.loads\((.*)\)$/m.exec(script)
    expect(match).not.toBeNull()
    const embedded = JSON.parse(JSON.parse(match?.[1] as string) as string) as Record<string, unknown>
    expect(embedded).toMatchObject({
      modelPath: '/tmp/模型 a.step',
      outputDir: '/tmp/out',
      geometryFilename: SECTION_GEOMETRY_FILENAME,
      origin: [0, 0, 4],
      normal: [0, 0, 1],
      right: [1, 0, 0],
      down: [0, 1, 0],
      arcStepDeg: SECTION_ARC_STEP_DEG,
      chordStepMm: SECTION_CHORD_STEP_MM,
      maxEdgeSamples: SECTION_MAX_EDGE_SAMPLES,
      coordDecimals: SECTION_COORD_DECIMALS,
    })
  })

  it('modelPath 含 $ 替换模式时原样内嵌', () => {
    const modelPath = "/tmp/a$& $' $`.step"
    const script = buildSectionScript({ modelPath, frame, outputDir: '/tmp/out' })
    const match = /^PARAMS = json\.loads\((.*)\)$/m.exec(script)
    expect(match).not.toBeNull()
    const embedded = JSON.parse(JSON.parse(match?.[1] as string) as string) as Record<string, unknown>
    expect(embedded.modelPath).toBe(modelPath)
  })

  it('不建 Document/Page/模板，也不加载 TechDraw（G3 的无文档约束）', () => {
    const script = buildSectionScript({ modelPath: '/tmp/a.step', frame, outputDir: '/tmp/out' })
    for (const forbidden of ['newDocument', 'addObject', 'TransientDir', 'TechDraw', 'DrawPage', 'DrawSVGTemplate']) {
      expect(script).not.toContain(forbidden)
    }
    expect(script).toContain('import Part')
    expect(script).toContain('shape.slice(')
  })

  it('打印成功标记并以非零退出码报告失败', () => {
    const script = buildSectionScript({ modelPath: '/tmp/a.step', frame, outputDir: '/tmp/out' })
    expect(script).toContain('SECTION_OK')
    expect(script).toContain('sys.exit(1)')
    // freecadcmd 吞异常并以退出码 0 结束，故最外层必须捕获 BaseException（FreeCAD 异常不是 Exception）
    expect(script).toContain('except BaseException:')
  })
})

/** 取同步抛出的 SectionGeometryError（断言错误码与文案用）。 */
function captureError(run: () => unknown): SectionGeometryError {
  try {
    run()
  } catch (error) {
    if (error instanceof SectionGeometryError) return error
    throw error
  }
  throw new Error('预期抛出 SectionGeometryError，但调用正常返回')
}
