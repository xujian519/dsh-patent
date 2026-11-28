import { describe, expect, it } from 'vitest'
import {
  HATCH_ANGLE_TOLERANCE_DEG,
  HATCH_COORD_DECIMALS,
  HATCH_MIDPOINT_CHECK_MM,
  HATCH_PATTERN_NAME,
  HatchGeometryError,
  parseHatchGeometry,
  readHatchGeometry,
  resolveHatchPattern,
  type HatchDirection,
  type HatchGeometryPayload,
  type SectionHatchRequest,
} from '../src/figure/freecad-hatch-geometry.ts'
import { HATCH_GEOMETRY_FILENAME, buildHatchScript } from '../src/figure/freecad-hatch-script.ts'

/**
 * 剖面线几何的纯逻辑测试：图案解析、取向/间距/落点核对、脚本构建。
 * 全部不依赖 FreeCAD（真实剖面线见 figure-freecad-real-render.spec.ts）。
 */

/** 矩形顶点（隐式闭合）。 */
function rect(width: number, height: number, centerX = 0, centerY = 0): (readonly [number, number])[] {
  const x0 = centerX - width / 2
  const x1 = centerX + width / 2
  const y0 = centerY - height / 2
  const y1 = centerY + height / 2
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/** 正多边形（近似圆孔）。 */
function polygon(sides: number, radius: number, centerX = 0, centerY = 0): (readonly [number, number])[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = (2 * Math.PI * index) / sides
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
  })
}

/**
 * 按请求口径造一条剖面线段：中点落在族参数 `offset` 上，长度沿线向展开。
 * 这是独立实现（不复用被测代码），用于构造产物与故意造错的产物。
 */
function familySegment(angleDeg: number, direction: HatchDirection, offset: number, length = 10): number[][] {
  const radians = (angleDeg * Math.PI) / 180
  const sign = direction === 'forward' ? 1 : -1
  const along: [number, number] = [Math.cos(radians), sign * Math.sin(radians)]
  const normal: [number, number] = [-sign * Math.sin(radians), Math.cos(radians)]
  const mid: [number, number] = [normal[0] * offset, normal[1] * offset]
  const half = length / 2
  return [
    [mid[0] - along[0] * half, mid[1] - along[1] * half],
    [mid[0] + along[0] * half, mid[1] + along[1] * half],
  ]
}

/** 组装脚本产物：回填本次请求的图案参数，线段由调用方给（用于造错）。 */
function payloadOf(request: SectionHatchRequest, grouped: number[][][][]): HatchGeometryPayload {
  const pattern = resolveHatchPattern(request)
  return {
    pattern: { angle_deg: pattern.patAngleDeg, pat_scale: pattern.patScale, pat_name: pattern.patName },
    regions: grouped.map(segments => ({ segments_mm: segments })),
  }
}

/** 取同步抛出的 HatchGeometryError（断言错误码与文案用）。 */
function captureError(run: () => unknown): HatchGeometryError {
  try {
    run()
  } catch (error) {
    if (error instanceof HatchGeometryError) return error
    throw error
  }
  throw new Error('预期抛出 HatchGeometryError，但调用正常返回')
}

describe('resolveHatchPattern', () => {
  it('forward 的 .pat 角就是请求角，patScale 等于毫米间距（.pat delta 取 1）', () => {
    const pattern = resolveHatchPattern({ regions: [{ outline: rect(40, 20) }], angleDeg: 45, spacingMm: 3 })
    expect(pattern).toMatchObject({
      angleDeg: 45,
      direction: 'forward',
      spacingMm: 3,
      patAngleDeg: 45,
      patScale: 3,
      patName: HATCH_PATTERN_NAME,
    })
    expect(pattern.patText).toBe(`*${HATCH_PATTERN_NAME}, 45 deg\n45, 0,0, 0,1\n`)
  })

  it('backward 取 180 − 请求角（实测 .pat 角与量到的线向角一致）', () => {
    const pattern = resolveHatchPattern({
      regions: [{ outline: rect(40, 20) }],
      angleDeg: 45,
      spacingMm: 2,
      direction: 'backward',
    })
    expect(pattern.patAngleDeg).toBe(135)
    expect(pattern.patText).toContain('135, 0,0, 0,1')
  })

  it('方向缺省为 forward', () => {
    const withDefault = resolveHatchPattern({ regions: [{ outline: rect(40, 20) }], angleDeg: 30, spacingMm: 2 })
    expect(withDefault.direction).toBe('forward')
    expect(withDefault.patAngleDeg).toBe(30)
  })

  it('角度必须在 (0, 90] 度内', () => {
    for (const angleDeg of [0, -1, 90.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureError(() => resolveHatchPattern({
        regions: [{ outline: rect(40, 20) }],
        angleDeg,
        spacingMm: 2,
      }))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('(0, 90]')
    }
  })

  it('间距必须是正有限数', () => {
    for (const spacingMm of [0, -3, Number.NaN]) {
      const error = captureError(() => resolveHatchPattern({
        regions: [{ outline: rect(40, 20) }],
        angleDeg: 45,
        spacingMm,
      }))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('正有限数')
    }
  })

  it('方向非法当场报错', () => {
    const error = captureError(() => resolveHatchPattern({
      regions: [{ outline: rect(40, 20) }],
      angleDeg: 45,
      spacingMm: 2,
      direction: 'sideways' as HatchDirection,
    }))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('forward 或 backward')
  })

  it('至少需要一个材料区域', () => {
    const error = captureError(() => resolveHatchPattern({ regions: [], angleDeg: 45, spacingMm: 2 }))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('至少需要一个材料区域')
  })

  it('轮廓顶点少于 3 个或坐标非有限数都当场报错（外环与孔分别报）', () => {
    const tooFew = captureError(() => resolveHatchPattern({
      regions: [{ outline: [[0, 0], [1, 1]] }],
      angleDeg: 45,
      spacingMm: 2,
    }))
    expect(tooFew.code).toBe('invalid_input')
    expect(tooFew.message).toContain('材料外环的顶点少于 3 个')

    const badHole = captureError(() => resolveHatchPattern({
      regions: [{ outline: rect(40, 20), holes: [[[0, 0], [1, 1]]] }],
      angleDeg: 45,
      spacingMm: 2,
    }))
    expect(badHole.message).toContain('孔 #1')

    const notFinite = captureError(() => resolveHatchPattern({
      regions: [{ outline: rect(40, 20), holes: [[[0, 0], [1, 0], [Number.NaN, 2]]] }],
      angleDeg: 45,
      spacingMm: 2,
    }))
    expect(notFinite.message).toContain('不是有限二维坐标')
  })
})

describe('readHatchGeometry 取向、间距与落点核对', () => {
  const request: SectionHatchRequest = { regions: [{ outline: rect(40, 20) }], angleDeg: 45, spacingMm: 3 }

  it('相邻线正好一个间距的线段通过核对，并按区域分组报数', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 0), familySegment(45, 'forward', 3), familySegment(45, 'forward', 6)]])
    const geometry = readHatchGeometry(payload, request)
    expect(geometry.segments).toHaveLength(3)
    expect(geometry.regionCounts).toEqual([3])
    expect(geometry.patAngleDeg).toBe(45)
    expect(geometry.patScale).toBe(3)
  })

  it('产物覆盖的区域数与请求不符即报错', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 0)]])
    payload.regions = []
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('invalid_payload')
    expect(error.message).toContain('材料区域')
  })

  it('0 条剖面线判 empty_hatch（两条静默失败路径都写在文案里）', () => {
    const payload = payloadOf(request, [[]])
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('empty_hatch')
    expect(error.message).toContain('z=0 的 XY 平面')
    expect(error.message).toContain('None')
  })

  it('取向按无向直线核对：请求 45° 而产物是 30° 即报错', () => {
    const payload = payloadOf(request, [[familySegment(30, 'forward', 0), familySegment(45, 'forward', 3)]])
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('angle_mismatch')
    expect(error.message).toContain(`超过 ${String(HATCH_ANGLE_TOLERANCE_DEG)} 度`)
    expect(error.message).toContain('视图帧')
  })

  it('镜像翻转（45° 变成 135°）被取向核对拦下', () => {
    const payload = payloadOf(request, [[familySegment(135, 'forward', 0), familySegment(135, 'forward', 3)]])
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('angle_mismatch')
  })

  it('backward 的期望取向是 180 − 请求角', () => {
    const backward: SectionHatchRequest = { ...request, direction: 'backward' }
    // 线向是 (cos, −sin)：请求 45° 的 backward 线在图面里的方向角是 135°。
    const payload = payloadOf(backward, [[familySegment(45, 'backward', 0), familySegment(45, 'backward', 3)]])
    expect(readHatchGeometry(payload, backward).regionCounts).toEqual([2])
  })

  it('间距必须是请求间距的整数倍', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 0), familySegment(45, 'forward', 4)]])
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('spacing_mismatch')
    expect(error.message).toContain('整数倍')
  })

  it('单个区域内缺线（差 2 倍）也报错，多区域则允许整数倍', () => {
    const missing = payloadOf(request, [[familySegment(45, 'forward', 0), familySegment(45, 'forward', 6)]])
    const error = captureError(() => readHatchGeometry(missing, request))
    expect(error.code).toBe('spacing_mismatch')
    expect(error.message).toContain('中间缺线')

    // 两个区域各自成段：族参数 0/3 与 12/15 之差分别是 3 与 9（都是间距的整数倍），允许。
    const twoRegions: SectionHatchRequest = {
      regions: [{ outline: rect(60, 60) }, { outline: rect(60, 60) }],
      angleDeg: 45,
      spacingMm: 3,
    }
    const payload = payloadOf(twoRegions, [
      [familySegment(45, 'forward', 0), familySegment(45, 'forward', 3)],
      [familySegment(45, 'forward', -12), familySegment(45, 'forward', -15)],
    ])
    expect(readHatchGeometry(payload, twoRegions).regionCounts).toEqual([2, 2])
  })

  it('线段中点落在孔内即报错（孔环漏给成面时的错图）', () => {
    const withHole: SectionHatchRequest = {
      regions: [{ outline: rect(40, 20), holes: [polygon(64, 3)] }],
      angleDeg: 45,
      spacingMm: 3,
    }
    const payload = payloadOf(withHole, [[familySegment(45, 'forward', 0), familySegment(45, 'forward', 3)]])
    const error = captureError(() => readHatchGeometry(payload, withHole))
    expect(error.code).toBe('region_mismatch')
    expect(error.message).toContain('孔 #1 内')
  })

  it('中点不在孔内时放行（孔环只排除孔内的线段）', () => {
    const withHole: SectionHatchRequest = {
      regions: [{ outline: rect(40, 20), holes: [polygon(64, 3)] }],
      angleDeg: 45,
      spacingMm: 3,
    }
    const payload = payloadOf(withHole, [[familySegment(45, 'forward', 6)]])
    expect(readHatchGeometry(payload, withHole).segments).toHaveLength(1)
  })

  it('线段中点落在材料外轮廓之外即报错', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 200)]])
    const error = captureError(() => readHatchGeometry(payload, request))
    expect(error.code).toBe('region_mismatch')
    expect(error.message).toContain('外轮廓之外')
  })

  it('短于核对下限的线段跳过中点核对（内接多边形边界上的噪声）', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 200, HATCH_MIDPOINT_CHECK_MM / 2)]])
    expect(readHatchGeometry(payload, request).segments).toHaveLength(1)
  })

  it('产物结构非法时报 invalid_payload', () => {
    const notTwoEndpoints = payloadOf(request, [[[[0, 0], [1, 1], [2, 2]]]])
    expect(captureError(() => readHatchGeometry(notTwoEndpoints, request)).message).toContain('不是两个端点')

    const notFinite = payloadOf(request, [[[[0, 0], [Number.NaN, 1]]]])
    expect(captureError(() => readHatchGeometry(notFinite, request)).message).toContain('不是有限二维坐标')

    const zeroLength = payloadOf(request, [[[[1, 1], [1, 1]]]])
    expect(captureError(() => readHatchGeometry(zeroLength, request)).message).toContain('零长线段')

    // 端点不是数组（子进程产物可能给标量）：按 JSON 文本构造，与真实产物同形。
    const reportedPattern = payloadOf(request, [[]]).pattern
    const scalarEndpoint = JSON.parse(
      `{"pattern": ${JSON.stringify(reportedPattern)}, "regions": [{"segments_mm": [[[0, 0], 5]]}]}`,
    ) as HatchGeometryPayload
    expect(captureError(() => readHatchGeometry(scalarEndpoint, request)).message).toContain('不是有限二维坐标')

    // 产物少了线段数组：按 JSON 文本构造（结构出错正是产物来自子进程时的真实可能）。
    const reported = payloadOf(request, [[]]).pattern
    const missingSegments = JSON.parse(
      `{"pattern": ${JSON.stringify(reported)}, "regions": [{}]}`,
    ) as HatchGeometryPayload
    expect(captureError(() => readHatchGeometry(missingSegments, request)).message).toContain('线段数组')
  })

  it('脚本回填的图案参数与请求不符即报错（脚本读到的不是本次请求）', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 0)]])
    expect(captureError(() => readHatchGeometry({
      ...payload,
      pattern: { ...payload.pattern, angle_deg: 44 },
    }, request)).message).toContain('.pat 角')

    expect(captureError(() => readHatchGeometry({
      ...payload,
      pattern: { ...payload.pattern, pat_scale: 4 },
    }, request)).message).toContain('patScale')

    expect(captureError(() => readHatchGeometry({
      ...payload,
      pattern: { ...payload.pattern, pat_name: 'OTHER' },
    }, request)).message).toContain('图案名')
  })

  it('parseHatchGeometry 从 JSON 文本读出同一结果', () => {
    const payload = payloadOf(request, [[familySegment(45, 'forward', 0), familySegment(45, 'forward', 3)]])
    const geometry = parseHatchGeometry(JSON.stringify(payload), request)
    expect(geometry.segments).toHaveLength(2)
    expect(geometry.segments[0]?.from).toHaveLength(2)
  })
})

describe('buildHatchScript', () => {
  const regions = [{ outline: rect(40, 20), holes: [polygon(16, 3)] }]
  const pattern = resolveHatchPattern({ regions, angleDeg: 30, spacingMm: 2.5 })

  it('同一入参恒返回同一段 Python 文本', () => {
    const first = buildHatchScript({ pattern, regions, outputDir: '/tmp/out' })
    const second = buildHatchScript({ pattern, regions, outputDir: '/tmp/out' })
    expect(first).toBe(second)
  })

  it('把图案、区域与输出文件名内嵌进 payload（孔缺省为空数组）', () => {
    const script = buildHatchScript({
      pattern,
      regions: [{ outline: rect(40, 20) }, regions[0] as typeof regions[number]],
      outputDir: '/tmp/输出 a',
    })
    const match = /^PARAMS = json\.loads\((.*)\)$/m.exec(script)
    expect(match).not.toBeNull()
    const embedded = JSON.parse(JSON.parse(match?.[1] as string) as string) as Record<string, unknown>
    expect(embedded).toMatchObject({
      outputDir: '/tmp/输出 a',
      geometryFilename: HATCH_GEOMETRY_FILENAME,
      patName: HATCH_PATTERN_NAME,
      patAngleDeg: 30,
      patScale: 2.5,
      patText: pattern.patText,
      coordDecimals: HATCH_COORD_DECIMALS,
    })
    const embeddedRegions = embedded.regions as { outline: number[][]; holes: number[][][] }[]
    expect(embeddedRegions).toHaveLength(2)
    expect(embeddedRegions[0]?.holes).toEqual([])
    expect(embeddedRegions[1]?.holes).toHaveLength(1)
  })

  it('outputDir 含 $ 替换模式时原样内嵌', () => {
    const outputDir = "/tmp/out $& $' $`"
    const script = buildHatchScript({ pattern, regions, outputDir })
    const match = /^PARAMS = json\.loads\((.*)\)$/m.exec(script)
    expect(match).not.toBeNull()
    const embedded = JSON.parse(JSON.parse(match?.[1] as string) as string) as Record<string, unknown>
    expect(embedded.outputDir).toBe(outputDir)
  })

  it('三条硬约束与两条静默失败路径都落在源码里', () => {
    const script = buildHatchScript({ pattern, regions, outputDir: '/tmp/out' })
    // 硬约束 3：必须显式传 patFile（少传即 SIGSEGV 139，实测）——第四个位置参数就是 pat_path。
    expect(script).toContain('TechDraw.makeGeomHatch(face, PAT_SCALE, PAT_NAME, PAT_PATH)')
    // 硬约束 1：网格点写成 z=0 的 XY 平面坐标。
    expect(script).toContain('Vector(float(x), float(y), 0.0)')
    expect(script).toContain('Part::FaceMakerBullseye')
    // 两条静默失败路径：None 与空 Compound 都显式报错。
    expect(script).toContain('if compound is None:')
    expect(script).toContain('if len(edges) == 0:')
    // .pat 由本模块的文本写出（图案名与 delta 由 TS 侧决定）。
    expect(script).toContain('handle.write(PAT_TEXT)')
  })

  it('不建 Document/Page/模板（G3 的无文档约束；TechDraw 只用来取几何函数）', () => {
    const script = buildHatchScript({ pattern, regions, outputDir: '/tmp/out' })
    for (const forbidden of ['newDocument', 'addObject', 'TransientDir', 'DrawPage', 'DrawSVGTemplate', 'viewPartAsSvg']) {
      expect(script).not.toContain(forbidden)
    }
    expect(script).toContain('import Part')
    expect(script).toContain('import TechDraw')
  })

  it('打印成功标记并以非零退出码报告失败', () => {
    const script = buildHatchScript({ pattern, regions, outputDir: '/tmp/out' })
    expect(script).toContain('HATCH_OK')
    expect(script).toContain('sys.exit(1)')
    expect(script).toContain('except BaseException:')
  })
})
