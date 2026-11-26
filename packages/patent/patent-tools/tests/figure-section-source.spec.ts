import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  SectionSourceError,
  SECTION_SOURCE_SIZE_TOLERANCE,
  expandSectionSource,
  type SectionSourcePorts,
} from '../src/figure/section-source.ts'
import {
  RENDER_REUSE_VERSION,
  SECTION_REUSE_WARNING,
  hashModelFile,
  renderKeyPath,
  renderReuseKey,
} from '../src/figure/render-reuse.ts'
import { readSectionGeometry, SectionGeometryError, type SectionGeometryPayload } from '../src/figure/freecad-section-geometry.ts'
import type { SectionGeometryOutcome, SectionGeometrySpec, SectionHatchOutcome, SectionHatchSpec } from '../src/figure/freecad-renderer.ts'
import type { SectionFigureJson } from '../src/figure/vector-figure-build.ts'

/**
 * 剖切来源展开的纯逻辑测试：模型 JSON 校验、单位核对、锚点匹配、剖面线分组的请求形状与
 * 失败码映射。全部用假端口（真机链路见 figure-freecad-real-render.spec.ts）。
 */

const workDir = mkdtempSync(join(tmpdir(), 'dsh-sectionsource-'))
afterAll(() => { rmSync(workDir, { recursive: true, force: true }) })

/** 写一个模型文件（只用于路径与扩展名校验，内容不解析）。 */
const modelPath = join(workDir, 'plate.step')
writeFileSync(modelPath, 'ISO-10303-21;\n', 'utf8')

/** 剖切 fixture 的解析几何：60×30 外环 + 两个 r5 通孔（x = ±15）。 */
function geometryPayload(): SectionGeometryPayload {
  const circle = (centerX: number): number[][] => Array.from({ length: 240 }, (_, index) => {
    const angle = (2 * Math.PI * index) / 240
    return [centerX + 5 * Math.cos(angle), 5 * Math.sin(angle)]
  })
  return {
    model: { path: modelPath, solids: 1, bound_box_mm: { min: [-30, -15, 0], max: [30, 15, 8] } },
    plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
    rings: [
      { points_mm: [[-30, -15], [30, -15], [30, 15], [-30, 15]], closed: true, area_mm2: 1800 },
      { points_mm: circle(-15), closed: true, area_mm2: Math.PI * 25 },
      { points_mm: circle(15), closed: true, area_mm2: Math.PI * 25 },
    ],
    slice_face_area_mm2: null,
  }
}

/** 记录调用参数的假端口。 */
function fakePorts(overrides: {
  geometry?: Partial<SectionGeometryOutcome>
  hatch?: Partial<SectionHatchOutcome>
  hatchSegments?: readonly { from: readonly [number, number]; to: readonly [number, number] }[]
  regionCounts?: readonly number[]
} = {}): {
  ports: SectionSourcePorts
  geometrySpecs: SectionGeometrySpec[]
  hatchSpecs: SectionHatchSpec[]
} {
  const geometrySpecs: SectionGeometrySpec[] = []
  const hatchSpecs: SectionHatchSpec[] = []
  const ports: SectionSourcePorts = {
    sectionGeometry: async (spec) => {
      geometrySpecs.push(spec)
      if (overrides.geometry !== undefined && 'ok' in overrides.geometry) return overrides.geometry as SectionGeometryOutcome
      return { ok: true, geometry: readSectionGeometry(geometryPayload()) }
    },
    sectionHatch: async (spec) => {
      hatchSpecs.push(spec)
      if (overrides.hatch !== undefined && 'ok' in overrides.hatch) return overrides.hatch as SectionHatchOutcome
      const counts = overrides.regionCounts ?? spec.regions.map(() => 1)
      const segments = overrides.hatchSegments ?? counts.map(() => ({ from: [0, 0] as const, to: [1, 0] as const }))
      return {
        ok: true,
        geometry: {
          segments,
          regionCounts: counts,
          patAngleDeg: spec.angleDeg,
          patScale: spec.spacingMm,
        },
      }
    },
  }
  return { ports, geometrySpecs, hatchSpecs }
}

/** 剖视图输入：source 模式（parts 只给 anchor 与展示字段）。 */
function sourceSections(overrides: Partial<SectionFigureJson> = {}): SectionFigureJson {
  return {
    source: { model_path: 'plate.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } },
    parts: [{ label: '底板', anchor: [0, 0], hatch: { angle_deg: 45, spacing_mm: 3 } }],
    ...overrides,
  }
}

/** 展开（用假端口与临时工作目录）。 */
async function expand(
  sections: SectionFigureJson,
  ports: SectionSourcePorts,
  scale?: number,
): Promise<Awaited<ReturnType<typeof expandSectionSource>>> {
  const scaled: SectionFigureJson = scale === undefined || sections.source === undefined
    ? sections
    : { ...sections, source: { ...sections.source, scale } }
  return expandSectionSource(scaled, { ports, cwd: workDir, artifactDir: join(workDir, 'artifacts'), reuse: false })
}

/** 展开并取回抛出的 SectionSourceError（断言失败也在这里报出实际值）。 */
async function expandError(sections: SectionFigureJson, ports: SectionSourcePorts, scale?: number): Promise<SectionSourceError> {
  const failure = await expand(sections, ports, scale).catch((error: unknown) => error)
  if (!(failure instanceof SectionSourceError)) {
    throw new Error(`期望抛出 SectionSourceError，实际：${String(failure)}`)
  }
  return failure
}

/** 期待抛出的错误码与信息片段。 */
async function expectFailure(
  sections: SectionFigureJson,
  ports: SectionSourcePorts,
  code: SectionSourceError['code'],
  fragment: string,
  scale?: number,
): Promise<void> {
  const error = await expandError(sections, ports, scale)
  expect(error.code).toBe(code)
  expect(error.message).toContain(fragment)
}

describe('expandSectionSource 输入校验', () => {
  it('没有 source 时原样返回同一个输入对象、无提示', async () => {
    const sections: SectionFigureJson = { parts: [{ outline: [[0, 0], [1, 0], [1, 1]] }] }
    const { ports, geometrySpecs } = fakePorts()
    const result = await expand(sections, ports)
    expect(result.sections).toBe(sections)
    expect(result.warnings).toEqual([])
    expect(geometrySpecs).toHaveLength(0)
  })

  it('source 模式下缺 anchor、给 outline、parts 为空都报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(
      sourceSections({ parts: [{ hatch: 'none' }] }),
      ports,
      'invalid_input',
      '缺少 anchor',
    )
    await expectFailure(sourceSections({ parts: [{ anchor: [1] }] }), ports, 'invalid_input', '缺少 anchor')
    await expectFailure(
      sourceSections({ parts: [{ anchor: [Number.NaN, 0] }] }),
      ports,
      'invalid_input',
      '缺少 anchor',
    )
    await expectFailure(
      sourceSections({ parts: [{ anchor: [0, 0], outline: [[0, 0], [1, 0], [1, 1]] }] }),
      ports,
      'invalid_input',
      '轮廓只能有一个来源',
    )
    await expectFailure(sourceSections({ parts: [] }), ports, 'invalid_input', '至少一项')
  })

  it('plane.reference 给出时透传到几何端口', async () => {
    const { ports, geometrySpecs } = fakePorts()
    await expand(sourceSections({
      source: {
        model_path: 'plate.step',
        plane: { origin: [0, 0, 4], normal: [0, 0, 1], reference: [1, 0, 0] },
      },
    }), ports)
    expect(geometrySpecs[0]?.plane.reference).toEqual([1, 0, 0])
  })

  it('scale 非正、plane 分量不是三个有限数都报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(sourceSections(), ports, 'invalid_input', 'scale', 0)
    const badPlane: SectionFigureJson = {
      source: { model_path: 'plate.step', plane: { origin: [0, 0], normal: [0, 0, 1] } },
      parts: [{ anchor: [0, 0] }],
    }
    await expectFailure(badPlane, ports, 'invalid_input', 'plane.origin')
  })

  it('模型文件缺失报 file_not_found，扩展名不受支持报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(
      sourceSections({ source: { model_path: 'missing.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } } }),
      ports,
      'file_not_found',
      'missing.step',
    )
    writeFileSync(join(workDir, 'plate.txt'), 'x', 'utf8')
    await expectFailure(
      sourceSections({ source: { model_path: 'plate.txt', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } } }),
      ports,
      'invalid_input',
      '不支持的模型格式',
    )
  })

  it('位图路径在读盘前拒绝，且不调用几何端口', async () => {
    const { ports, geometrySpecs } = fakePorts()
    await expectFailure(
      sourceSections({ source: { model_path: 'photo.PNG', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } } }),
      ports,
      'invalid_input',
      'analyze_patent_figure',
    )
    expect(geometrySpecs).toHaveLength(0)
  })

  it('模型路径指向目录报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(
      sourceSections({ source: { model_path: '.', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } } }),
      ports,
      'invalid_input',
      '不是文件',
    )
  })
})

describe('expandSectionSource 单位核对', () => {
  it('part_size_mm 与模型包围盒不符即报错，并在文案里给出两组尺寸', async () => {
    const { ports } = fakePorts()
    const failure = await expandError(
      sourceSections({
        source: {
          model_path: 'plate.step',
          plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
          part_size_mm: [600, 300, 80],
        },
      }),
      ports,
    )
    expect(failure.code).toBe('invalid_input')
    // 文案里的两组尺寸都按大小排序（剖切基向量可能把 xyz 重排，逐轴比对无意义）。
    expect(failure.message).toContain('80×300×600')
    expect(failure.message).toContain('8×30×60')
  })

  it('声明尺寸顺序无关，容差内通过', async () => {
    const { ports } = fakePorts()
    const result = await expand(
      sourceSections({
        source: {
          model_path: 'plate.step',
          plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
          part_size_mm: [8, 60, 30],
        },
      }),
      ports,
    )
    expect(result.sections.parts).toHaveLength(1)
  })

  it('容差边界：恰在容差内的偏差通过，超出即失败', async () => {
    const { ports } = fakePorts()
    const within = 60 * (1 + SECTION_SOURCE_SIZE_TOLERANCE / 2)
    const beyond = 60 * (1 + SECTION_SOURCE_SIZE_TOLERANCE * 2)
    const withSize = (width: number): SectionFigureJson => sourceSections({
      source: {
        model_path: 'plate.step',
        plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
        part_size_mm: [width, 30, 8],
      },
    })
    await expect(expand(withSize(within), ports)).resolves.toBeDefined()
    await expectFailure(withSize(beyond), ports, 'invalid_input', '不符')
  })

  it('part_size_mm 不是三个正数报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(
      sourceSections({
        source: { model_path: 'plate.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] }, part_size_mm: [60, 30] },
      }),
      ports,
      'invalid_input',
      'part_size_mm',
    )
    await expectFailure(
      sourceSections({
        source: { model_path: 'plate.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] }, part_size_mm: [60, 30, 0] },
      }),
      ports,
      'invalid_input',
      '正有限数',
    )
  })
})

describe('expandSectionSource 区域匹配', () => {
  it('区域数与 parts 数不等时列出切出的区域', async () => {
    const { ports } = fakePorts()
    await expectFailure(
      sourceSections({
        parts: [{ anchor: [0, 0] }, { anchor: [1, 0] }],
      }),
      ports,
      'invalid_input',
      '切出 1 个材料区域',
    )
  })

  it('anchor 落空、落在孔里、两个零件落同一区域都报 invalid_input', async () => {
    const { ports } = fakePorts()
    await expectFailure(sourceSections({ parts: [{ anchor: [100, 100] }] }), ports, 'invalid_input', '不在任何材料区域内')
    // 孔内不是材料：两个 r5 通孔位于 x = ±15。
    await expectFailure(sourceSections({ parts: [{ anchor: [15, 0] }] }), ports, 'invalid_input', '不在任何材料区域内')
  })

  it('anchor 同时落在两个区域、两个零件认领同一区域都报 invalid_input', async () => {
    // 两个部分重叠的方块：两个外环的探针点都不在对方内，故各成一个材料区域。
    const overlapping: SectionGeometryPayload = {
      model: { path: modelPath, solids: 1, bound_box_mm: { min: [-10, -10, 0], max: [25, 25, 8] } },
      plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
      rings: [
        { points_mm: [[-10, -10], [10, -10], [10, 10], [-10, 10]], closed: true, area_mm2: 400 },
        { points_mm: [[5, 25], [25, 25], [25, 5], [5, 5]], closed: true, area_mm2: 400 },
      ],
      slice_face_area_mm2: null,
    }
    const overlapPorts = fakePorts({ geometry: { ok: true, geometry: readSectionGeometry(overlapping) } }).ports
    await expectFailure(
      sourceSections({ parts: [{ anchor: [7, 7] }, { anchor: [-5, -5] }] }),
      overlapPorts,
      'invalid_input',
      '同时落在区域',
    )

    // 两个分离的区域，但两个 anchor 都落在左件上：第二个 anchor 无区域可认领。
    const separated: SectionGeometryPayload = {
      model: { path: modelPath, solids: 1, bound_box_mm: { min: [-60, -10, 0], max: [60, 10, 8] } },
      plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
      rings: [
        { points_mm: [[-50, -5], [-30, -5], [-30, 5], [-50, 5]], closed: true, area_mm2: 200 },
        { points_mm: [[30, -5], [50, -5], [50, 5], [30, 5]], closed: true, area_mm2: 200 },
      ],
      slice_face_area_mm2: null,
    }
    const separatedPorts = fakePorts({ geometry: { ok: true, geometry: readSectionGeometry(separated) } }).ports
    await expectFailure(
      sourceSections({ parts: [{ anchor: [-40, 0] }, { anchor: [-35, 0] }] }),
      separatedPorts,
      'invalid_input',
      '同一个材料区域',
    )
  })

  it('展开：outline 是材料外环、holes 是孔环、剖面线段按 regionCounts 切分', async () => {
    const segments = [
      { from: [-30, -10] as const, to: [30, -10] as const },
      { from: [-30, -5] as const, to: [30, -5] as const },
    ]
    const { ports } = fakePorts({ hatchSegments: segments, regionCounts: [2] })
    const result = await expand(sourceSections(), ports)
    const [part] = result.sections.parts
    expect(part?.outline).toHaveLength(4)
    expect(part?.holes).toHaveLength(2)
    // 孔环是内接于 r5 圆的正 240 边形：顶点到圆心距离逐值相符。
    const hole = part?.holes?.[0] as readonly (readonly [number, number])[]
    for (const point of hole) expect(Math.hypot(point[0] + 15, point[1])).toBeCloseTo(5, 4)
    expect(part?.hatch_segments).toEqual(segments)
  })

  it('区域顺序与 parts 顺序解耦：anchor 决定谁配谁', async () => {
    // 切出两个区域（两个分离的方块），parts 按相反顺序给出。
    const payload: SectionGeometryPayload = {
      model: { path: modelPath, solids: 1, bound_box_mm: { min: [-60, -10, 0], max: [60, 10, 8] } },
      plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
      rings: [
        { points_mm: [[-50, -5], [-30, -5], [-30, 5], [-50, 5]], closed: true, area_mm2: 200 },
        { points_mm: [[30, -5], [50, -5], [50, 5], [30, 5]], closed: true, area_mm2: 200 },
      ],
      slice_face_area_mm2: null,
    }
    const { ports, hatchSpecs } = fakePorts({ geometry: { ok: true, geometry: readSectionGeometry(payload) } })
    const result = await expand(sourceSections({
      parts: [
        { label: '右', anchor: [40, 0], hatch: { angle_deg: 45 } },
        { label: '左', anchor: [-40, 0], hatch: { angle_deg: 45, direction: 'backward' } },
      ],
    }), ports)
    const [right, left] = result.sections.parts
    expect(right?.outline?.[0]).toEqual([30, -5])
    expect(left?.outline?.[0]).toEqual([-50, -5])
    // 两个不同参数各成一组：请求里的区域顺序即 parts 顺序。
    expect(hatchSpecs.map(spec => spec.regions[0]?.outline?.[0])).toEqual([[30, -5], [-50, -5]])
  })
})

describe('expandSectionSource 剖面线', () => {
  it('缺省 hatch 按 45°/3 毫米/forward 请求，' +
    '同参数的区域合并成一次调用', async () => {
    const payload: SectionGeometryPayload = {
      model: { path: modelPath, solids: 1, bound_box_mm: { min: [-60, -10, 0], max: [60, 10, 8] } },
      plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
      rings: [
        { points_mm: [[-50, -5], [-30, -5], [-30, 5], [-50, 5]], closed: true, area_mm2: 200 },
        { points_mm: [[30, -5], [50, -5], [50, 5], [30, 5]], closed: true, area_mm2: 200 },
      ],
      slice_face_area_mm2: null,
    }
    const { ports, hatchSpecs } = fakePorts({ geometry: { ok: true, geometry: readSectionGeometry(payload) } })
    const result = await expand(sourceSections({
      source: { model_path: 'plate.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } },
      parts: [{ anchor: [-40, 0] }, { anchor: [40, 0] }],
    }), ports)
    expect(hatchSpecs).toHaveLength(1)
    expect(hatchSpecs[0]?.angleDeg).toBe(45)
    expect(hatchSpecs[0]?.spacingMm).toBe(3)
    expect(hatchSpecs[0]?.direction).toBe('forward')
    expect(hatchSpecs[0]?.regions).toHaveLength(2)
    expect(result.sections.parts.map(part => part.hatch_segments?.length)).toEqual([1, 1])
  })

  it("hatch: 'none' 不调剖面线端口、也不给 hatch_segments", async () => {
    const { ports, hatchSpecs } = fakePorts()
    const result = await expand(sourceSections({ parts: [{ anchor: [0, 0], hatch: 'none' }] }), ports)
    expect(hatchSpecs).toHaveLength(0)
    expect(result.sections.parts[0]?.hatch_segments).toBeUndefined()
  })

  it('scale 缩放轮廓与孔环，间距按图面毫米原样请求', async () => {
    const { ports, hatchSpecs } = fakePorts()
    const result = await expand(sourceSections({
      parts: [{ anchor: [0, 0], hatch: { angle_deg: 30, spacing_mm: 2 } }],
    }), ports, 2)
    const [part] = result.sections.parts
    expect(part?.outline?.[0]).toEqual([-60, -30])
    // 缩放后 anchor（图面毫米）仍落在缩放后的区域内。
    expect(hatchSpecs[0]?.regions[0]?.outline?.[0]).toEqual([-60, -30])
    expect(hatchSpecs[0]?.spacingMm).toBe(2)
    expect(hatchSpecs[0]?.angleDeg).toBe(30)
  })

  it('非法角度与间距在启动端口之前就报 invalid_input', async () => {
    const { ports, hatchSpecs } = fakePorts()
    await expectFailure(
      sourceSections({ parts: [{ anchor: [0, 0], hatch: { angle_deg: 0 } }] }),
      ports,
      'invalid_input',
      '剖面线角度必须在 (0, 90] 度内',
    )
    await expectFailure(
      sourceSections({ parts: [{ anchor: [0, 0], hatch: { spacing_mm: -1 } }] }),
      ports,
      'invalid_input',
      '剖面线间距必须是正有限数',
    )
    expect(hatchSpecs).toHaveLength(0)
  })
})

describe('expandSectionSource 失败映射与提示', () => {
  it('几何端口的三类失败各按码抛出，错误文本透传', async () => {
    await expectFailure(
      sourceSections(),
      fakePorts({ geometry: { ok: false, code: 'not_installed', error: '未找到 FreeCAD' } }).ports,
      'not_installed',
      '未找到 FreeCAD',
    )
    await expectFailure(
      sourceSections(),
      fakePorts({ geometry: { ok: false, code: 'geometry_failed', error: '剖切几何失败' } }).ports,
      'geometry_failed',
      '剖切几何失败',
    )
    await expectFailure(
      sourceSections(),
      fakePorts({ geometry: { ok: false, code: 'aborted', error: 'x' } }).ports,
      'aborted',
      '取消',
    )
  })

  it('几何端口抛 SectionGeometryError 时翻成 invalid_input 并保留原文', async () => {
    const failure = await expandError(sourceSections(), {
      sectionGeometry: async () => { throw new SectionGeometryError('invalid_payload', '轮廓环未闭合') },
      sectionHatch: vi.fn(),
    })
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toBe('轮廓环未闭合')
  })

  it('剖面线端口抛出的非本模块错误同样原样冒泡', async () => {
    const { ports } = fakePorts()
    const failure = await expand(sourceSections(), {
      ...ports,
      sectionHatch: async () => { throw new Error('剖面线端口炸了') },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('剖面线端口炸了')
  })

  it('剖面线端口的两类失败各按码抛出', async () => {
    await expectFailure(
      sourceSections(),
      fakePorts({ hatch: { ok: false, code: 'not_installed', error: '未找到 FreeCAD' } }).ports,
      'not_installed',
      '未找到 FreeCAD',
    )
    await expectFailure(
      sourceSections(),
      fakePorts({ hatch: { ok: false, code: 'hatch_failed', error: '剖面线为 0 条' } }).ports,
      'hatch_failed',
      '剖面线为 0 条',
    )
  })

  it('端口抛出的非本模块错误原样冒泡（不吞成 invalid_input）', async () => {
    const ports: SectionSourcePorts = {
      sectionGeometry: async () => { throw new Error('端口内部炸了') },
      sectionHatch: vi.fn(),
    }
    const failure = await expand(sourceSections(), ports).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('端口内部炸了')
  })

  it('提示里给出区域数、逐区域净面积与图面范围', async () => {
    const { ports } = fakePorts()
    const result = await expand(sourceSections(), ports)
    expect(result.warnings).toHaveLength(1)
    const [line] = result.warnings
    expect(line).toContain('切出 1 个材料区域')
    expect(line).toContain('#1 净面积 1642.920')
    expect(line).toContain('x -30–30')
    expect(line).toContain('y -15–15')
  })
})

describe('expandSectionSource 复用', () => {
  function prepare(name: string): { artifactDir: string; modelAbs: string; sections: (scale?: number) => SectionFigureJson } {
    const artifactDir = join(workDir, name)
    const modelRel = `${name}/plate.step`
    const modelAbs = join(workDir, modelRel)
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(modelAbs, `ISO-10303-21;\n${name}\n`)
    const sections = (scale?: number): SectionFigureJson => sourceSections({
      source: {
        model_path: modelRel,
        plane: { origin: [0, 0, 4], normal: [0, 0, 1] },
        ...(scale === undefined ? {} : { scale }),
      },
    })
    return { artifactDir, modelAbs, sections }
  }

  it('相同模型字节与剖切参数第二次不调用端口，并提示复用', async () => {
    const { artifactDir, sections } = prepare('reuse-hit')
    const { ports, geometrySpecs } = fakePorts()
    const input = sections()
    const first = await expandSectionSource(input, { ports, cwd: workDir, artifactDir })
    const second = await expandSectionSource(input, { ports, cwd: workDir, artifactDir })
    expect(geometrySpecs).toHaveLength(1)
    expect(second.sections.parts[0]?.outline).toEqual(first.sections.parts[0]?.outline)
    expect(second.warnings).toContain(SECTION_REUSE_WARNING)
    expect(first.warnings).not.toContain(SECTION_REUSE_WARNING)
    expect(existsSync(renderKeyPath(join(artifactDir, 'section-reuse.json')))).toBe(true)
  })

  it('改模型一个字节、改比例、或把收据改到键文件之后，都会重新剖切', async () => {
    const { artifactDir, modelAbs, sections } = prepare('reuse-miss')
    const { ports, geometrySpecs } = fakePorts()
    const input = sections()
    await expandSectionSource(input, { ports, cwd: workDir, artifactDir })
    writeFileSync(modelAbs, 'ISO-10303-21;\nreuse-byte\n')
    await expandSectionSource(input, { ports, cwd: workDir, artifactDir })
    expect(geometrySpecs).toHaveLength(2)
    await expandSectionSource(sections(2), { ports, cwd: workDir, artifactDir })
    expect(geometrySpecs).toHaveLength(3)
    const receipt = join(artifactDir, 'section-reuse.json')
    await utimes(receipt, new Date('2099-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'))
    await expandSectionSource(sections(2), { ports, cwd: workDir, artifactDir })
    expect(geometrySpecs).toHaveLength(4)
  })

  it('把取消信号交给轮廓端口和剖面线端口', async () => {
    const { artifactDir, sections } = prepare('reuse-signal')
    const { ports, geometrySpecs, hatchSpecs } = fakePorts()
    const signal = new AbortController().signal
    await expandSectionSource(sections(), { ports, cwd: workDir, artifactDir, signal, reuse: false })
    expect(geometrySpecs[0]?.signal).toBe(signal)
    expect(hatchSpecs[0]?.signal).toBe(signal)
  })

  it('reuse false 即使已有收据也重新剖切', async () => {
    const { artifactDir, sections } = prepare('reuse-off')
    const { ports, geometrySpecs } = fakePorts()
    const input = sections()
    await expandSectionSource(input, { ports, cwd: workDir, artifactDir })
    await expandSectionSource(input, { ports, cwd: workDir, artifactDir, reuse: false })
    expect(geometrySpecs).toHaveLength(2)
  })

  it('端口失败不写键；损坏收据和抬高版本的键都不命中', async () => {
    const failed = prepare('reuse-fail')
    const ports: SectionSourcePorts = {
      sectionGeometry: async () => { throw new Error('剖切进程退出') },
      sectionHatch: async () => { throw new Error('不应调用剖面线') },
    }
    await expect(expandSectionSource(failed.sections(), { ports, cwd: workDir, artifactDir: failed.artifactDir }))
      .rejects.toThrow('剖切进程退出')
    expect(existsSync(renderKeyPath(join(failed.artifactDir, 'section-reuse.json')))).toBe(false)

    const { artifactDir, modelAbs, sections } = prepare('reuse-plant')
    const input = sections(2)
    const key = await renderReuseKey({
      tool: 'section-source',
      request: input,
      modelHashes: [await hashModelFile(modelAbs)],
    })
    const bumped = await renderReuseKey({
      tool: 'section-source',
      request: input,
      modelHashes: [await hashModelFile(modelAbs)],
      version: RENDER_REUSE_VERSION + 1,
    })
    const receipt = join(artifactDir, 'section-reuse.json')
    const planted = [
      '{',
      JSON.stringify({ key: 'other', expansion: { warnings: ['x'], sections: { parts: [] } } }),
      JSON.stringify({ key, expansion: { warnings: [1], sections: { parts: [] } } }),
      JSON.stringify({ key, expansion: { warnings: ['x'], sections: { parts: 'no' } } }),
      JSON.stringify({ key, expansion: { warnings: ['x'], sections: null } }),
      JSON.stringify({ key: bumped, expansion: { warnings: ['x'], sections: { parts: [] } } }),
      JSON.stringify({ key, expansion: { sections: { parts: [] } } }),
      JSON.stringify({ key, expansion: { warnings: ['x'], sections: {} } }),
    ]
    const { ports: okPorts, geometrySpecs } = fakePorts()
    for (const body of planted) {
      writeFileSync(receipt, body)
      writeFileSync(renderKeyPath(receipt), key)
      const past = new Date('2019-01-01T00:00:00Z')
      await utimes(receipt, past, past)
      await utimes(renderKeyPath(receipt), past, past)
      const before = geometrySpecs.length
      await expandSectionSource(input, { ports: okPorts, cwd: workDir, artifactDir })
      expect(geometrySpecs.length).toBe(before + 1)
    }
  })
})
