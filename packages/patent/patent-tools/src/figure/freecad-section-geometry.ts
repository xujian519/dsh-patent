/**
 * 无文档 OCCT 剖切几何：把模型文件与一个剖切平面变成视图帧里的闭合轮廓环与材料区域。
 *
 * 几何由 `freecad-section-script.ts` 生成的 FreeCAD 脚本产出（`section-geometry.json`），
 * 本模块只做解析、按包含关系归并成材料区域、以及面积核对 —— 三件事都不需要 FreeCAD，
 * 故可在无 FreeCAD 的机器上单测。脚本刻意**不建 Document/Page/模板**：`Part.read` +
 * `Shape.slice` + `Part.Face` 都不需要文档（实测）。
 *
 * 视图帧：`right` 是剖切平面内指向图面右方的单位向量，`down` 指向图面下方（SVG 画布
 * 约定，`buildSectionDiagram` 的入参就是这一帧）。基向量与 TechDraw 的对应关系已实测
 * （FreeCAD 1.1.3，`TechDraw::DrawViewPart`、Scale=1）：取 `Direction = −normal`、
 * `XDirection = right` 时，`projectPoint` 的 x = p·right、y = −p·down，**比例恒为 1**，
 * 平移量恒等于投影几何包围盒中心（`freecad-structure-script.ts` 已减去该中心）；即本模块
 * 的 `down` 等于 TechDraw 视图帧的自上而下方向，两组坐标只差一个平移，不需要二次翻转。
 *
 * 面积口径：脚本对每个环另外报出 OCCT 面面积 `Part.Face(wire).Area`（精确值）。本模块把
 * 画图用的离散多边形的面积与该精确值对比，相对偏差超过 {@link SECTION_AREA_TOLERANCE}
 * 即抛错 —— 离散太粗会让图面轮廓失真，必须当场失败而不是画出一张变形的图。整块切片只有
 * 一个材料区域时，另与脚本报出的 `Part.makeFace(全部线框, 'Part::FaceMakerBullseye').Area`
 * 对比，形成第二个独立量测。
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-section-geometry
 */

import { fmtNumber, isFiniteNumber } from './freecad-artifact-numbers.ts'

/** 面积核对容差（相对值）：离散多边形面积与 OCCT 面面积的允许相对偏差。 */
const SECTION_AREA_TOLERANCE = 1e-3

/**
 * 圆弧边的采样角度步长（度）。
 *
 * 相对面积误差只取决于采样角步长、与半径无关：内接正 n 边形相对误差 ≈ (2π/n)²/6，
 * 240 点（步长 1.5°）实测 1.14e-4。故小孔与大圆共用同一相对精度。
 */
export const SECTION_ARC_STEP_DEG = 1.5

/**
 * 非圆弧曲线（椭圆、B 样条）的采样弦长步长（毫米）。
 *
 * 这类边上没有可用的角度参数，按弦长取样：半径为 r 的曲线弦长 s 的相对面积误差
 * ≈ (s/r)²/6，即半径不小于约 1.3 毫米时 s = 0.1 毫米满足 {@link SECTION_AREA_TOLERANCE}；
 * 更小的曲线由面积核对当场拦下（报出实测偏差），不会静默画出失真轮廓。
 */
export const SECTION_CHORD_STEP_MM = 0.1

/** 单条边的采样点数上限（防止 B 样条边产出超大 JSON）。 */
export const SECTION_MAX_EDGE_SAMPLES = 2000

/** 环坐标写出的小数位（0.001 微米级，远小于图面可辨量）。 */
export const SECTION_COORD_DECIMALS = 6

/** 判定基向量退化（参考方向与法向平行）的阈值。 */
const BASIS_EPSILON = 1e-9

/** 三维点/向量（毫米；法向与基向量为无量纲单位向量）。 */
export type Vec3 = readonly [number, number, number]

/** 剖切平面：平面内一点、平面法向，以及可选的图面「向右」参考方向。 */
export type SectionPlane = {
  /** 平面内一点（毫米）。 */
  origin: Vec3
  /** 平面法向（任意非零长度；内部归一化）。 */
  normal: Vec3
  /**
   * 图面「向右」的参考方向（任意非零、与法向不平行）；缺省按 +X → +Y → +Z 顺序取
   * 第一个与法向夹角不超过约 25° 的坐标轴。它决定视图绕法向的旋转，必须显式给出才能
   * 复现同一张图。
   */
  reference?: Vec3
}

/** 已解析的视图帧：平面内一点 + 三个正交单位向量（x 向右、y 向下、normal 指向观察者一侧）。 */
export type SectionFrame = {
  /** 平面内一点（毫米）：环坐标相对它量取。 */
  origin: Vec3
  /** 单位法向：观察者位于法向正侧，沿 −normal 方向看剖切面。 */
  normal: Vec3
  /** 图面「向右」单位向量（平面内）。 */
  right: Vec3
  /** 图面「向下」单位向量（平面内；= normal × right）。 */
  down: Vec3
}

/** 一个闭合轮廓环（视图帧毫米坐标）。 */
export type SectionRing = {
  /** 环上顶点（首尾不重复；按边界顺序排列）。 */
  points: readonly (readonly [number, number])[]
  /** OCCT 面面积（精确值，毫米²）。 */
  areaMm2: number
  /** 嵌套深度：0 是材料外环，1 是其内的孔，2 是孔内的材料（依此类推）。 */
  depth: number
}

/** 一个材料区域：外环 + 其直接包含的孔环。 */
type SectionRegion = {
  /** 外环在 {@link SectionGeometry.rings} 中的下标。 */
  outer: number
  /** 该外环直接包含的孔环下标（按环序）。 */
  holes: readonly number[]
  /** 净面积（外环精确面积 − 各孔精确面积，毫米²）。 */
  netAreaMm2: number
}

/** 模型信息：来源、实体数与包围盒（毫米，用于核对模型单位是否与图面毫米一致）。 */
type SectionModel = {
  /** 模型文件路径。 */
  path: string
  /** 实体数。 */
  solids: number
  /** 模型包围盒（毫米）。 */
  boundBoxMm: { min: Vec3; max: Vec3 }
}

/** 剖切几何：模型信息、视图帧、全部轮廓环与归并出的材料区域。 */
export type SectionGeometry = {
  /** 模型来源（脚本回填）。 */
  model: SectionModel
  /** 视图帧。 */
  frame: SectionFrame
  /** 剖切平面沿单位法向到世界原点的距离（毫米）。 */
  distanceMm: number
  /** 全部轮廓环（脚本输出顺序）。 */
  rings: readonly SectionRing[]
  /** 材料区域（按外环顺序）。 */
  regions: readonly SectionRegion[]
}

/** 脚本写出的 `section-geometry.json` 结构（本包自产，解析后逐项核对数值）。 */
export type SectionGeometryPayload = {
  model: { path: string; solids: number; bound_box_mm: { min: number[]; max: number[] } }
  plane: { origin: number[]; normal: number[]; right: number[]; down: number[]; distance: number }
  rings: { points_mm: number[][]; closed: boolean; area_mm2: number }[]
  slice_face_area_mm2: number | null
}

/** 剖切几何错误码：输入非法、脚本产物结构非法、面积核对不通过。 */
type SectionGeometryErrorCode = 'invalid_input' | 'invalid_payload' | 'area_mismatch'

/** 剖切几何错误（渲染器映射为 `geometry_failed`，工具层映射为 `invalid_tool_input`）。 */
export class SectionGeometryError extends Error {
  /** 错误码。 */
  readonly code: SectionGeometryErrorCode

  constructor(code: SectionGeometryErrorCode, message: string) {
    super(message)
    this.name = 'SectionGeometryError'
    this.code = code
  }
}

/**
 * 解析剖切平面为视图帧（纯函数）。
 *
 * @param plane - 平面内一点、法向与可选参考方向。
 * @returns 归一化后的三个单位向量（`down` = `normal` × `right`）。
 * @throws SectionGeometryError 输入非有限数、法向为零、或参考方向与法向平行时。
 */
export function resolveSectionFrame(plane: SectionPlane): SectionFrame {
  const normal = normalizeVec3(plane.normal, '剖切平面法向 normal')
  const reference = plane.reference === undefined
    ? defaultReference(normal)
    : normalizeVec3(plane.reference, '剖切平面参考方向 reference')
  const inPlane = subtractVec3(reference, scaleVec3(normal, dotVec3(reference, normal)))
  const length = lengthVec3(inPlane)
  if (length <= BASIS_EPSILON) {
    throw new SectionGeometryError(
      'invalid_input',
      /* v8 ignore next -- reference is defined whenever this throw is reachable: defaultReference always returns a non-parallel axis */
      `剖切平面参考方向 reference=[${plane.reference?.join(', ') ?? ''}] 与法向 normal=[${normal.join(', ')}] 平行，`
      + '图面内的「向右」无定义：请另给一个与法向不平行的参考方向',
    )
  }
  const right = scaleVec3(inPlane, 1 / length)
  return { origin: finiteVec3(plane.origin, '剖切平面原点 origin'), normal, right, down: crossVec3(normal, right) }
}

/**
 * 把脚本产物解析为剖切几何（纯函数）：核对结构、按包含关系归并材料区域、核对面积。
 *
 * @param text - `section-geometry.json` 的文本内容。
 * @returns 环与材料区域（含每个环的嵌套深度）。
 * @throws SectionGeometryError 结构非法（`invalid_payload`）或面积核对不通过（`area_mismatch`）时。
 */
export function parseSectionGeometry(text: string): SectionGeometry {
  return readSectionGeometry(JSON.parse(text) as SectionGeometryPayload)
}

/**
 * 把已解析的脚本产物核对并归并为剖切几何（纯函数）。
 *
 * @param payload - `section-geometry.json` 解析后的对象。
 * @returns 环与材料区域。
 * @throws SectionGeometryError 结构非法或面积核对不通过时。
 */
export function readSectionGeometry(payload: SectionGeometryPayload): SectionGeometry {
  const rawRings = payload.rings
  if (!Array.isArray(rawRings) || rawRings.length === 0) {
    throw new SectionGeometryError(
      'invalid_payload',
      '剖切产物不含任何轮廓环：剖切平面可能未与模型相交（FreeCAD 对平面位于实体之外只返回空列表，不报错）',
    )
  }
  const rings: SectionRing[] = rawRings.map((ring, index) => {
    if (!ring.closed) {
      throw new SectionGeometryError('invalid_payload', `轮廓环 #${index + 1} 未闭合：剖切面没有切出闭合轮廓，无法作为剖面轮廓`)
    }
    const points = ring.points_mm
    if (!Array.isArray(points) || points.length < 3) {
      throw new SectionGeometryError('invalid_payload', `轮廓环 #${index + 1} 的顶点少于 3 个：${String(points.length)}`)
    }
    const polygon = points.map((point, pointIndex) => {
      const [x, y] = point
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        throw new SectionGeometryError(
          'invalid_payload',
          `轮廓环 #${index + 1} 的第 ${pointIndex + 1} 个顶点不是有限二维坐标：[${String(x)}, ${String(y)}]`,
        )
      }
      return [x, y] as const
    })
    if (!Number.isFinite(ring.area_mm2) || ring.area_mm2 <= 0) {
      throw new SectionGeometryError(
        'invalid_payload',
        `轮廓环 #${index + 1} 的 OCCT 面面积不是正有限数：${String(ring.area_mm2)}`,
      )
    }
    const drawn = Math.abs(polygonArea(polygon))
    const drift = Math.abs(drawn - ring.area_mm2) / ring.area_mm2
    if (drift > SECTION_AREA_TOLERANCE) {
      throw new SectionGeometryError(
        'area_mismatch',
        `轮廓环 #${index + 1} 的离散面积 ${fmtNumber(drawn)} 毫米² 与 OCCT 面面积 ${fmtNumber(ring.area_mm2)} 毫米² `
        + `相对偏差 ${fmtNumber(drift * 100)}%，超过 ${fmtNumber(SECTION_AREA_TOLERANCE * 100)}%：轮廓离散过粗或剖切轮廓非平面闭合面`,
      )
    }
    return { points: polygon, areaMm2: ring.area_mm2, depth: 0 }
  })

  const measured = classifyRings(rings)
  const regions = measured.regions
  const sliceArea = payload.slice_face_area_mm2
  if (regions.length === 1 && typeof sliceArea === 'number' && Number.isFinite(sliceArea) && sliceArea > 0) {
    const net = (regions[0] as SectionRegion).netAreaMm2
    const drift = Math.abs(net - sliceArea) / sliceArea
    if (drift > SECTION_AREA_TOLERANCE) {
      throw new SectionGeometryError(
        'area_mismatch',
        `剖切净面积 ${fmtNumber(net)} 毫米² 与 FreeCAD 成面面积 ${fmtNumber(sliceArea)} 毫米² `
        + `相对偏差 ${fmtNumber(drift * 100)}%，超过 ${fmtNumber(SECTION_AREA_TOLERANCE * 100)}%`,
      )
    }
  }

  return {
    model: {
      path: payload.model.path,
      solids: payload.model.solids,
      boundBoxMm: {
        min: tuple3(payload.model.bound_box_mm.min, '模型包围盒 min'),
        max: tuple3(payload.model.bound_box_mm.max, '模型包围盒 max'),
      },
    },
    frame: {
      origin: tuple3(payload.plane.origin, '视图帧原点'),
      normal: tuple3(payload.plane.normal, '视图帧法向'),
      right: tuple3(payload.plane.right, '视图帧向右'),
      down: tuple3(payload.plane.down, '视图帧向下'),
    },
    distanceMm: payload.plane.distance,
    rings: measured.rings,
    regions,
  }
}

/** 归并结果：带嵌套深度的环与材料区域。 */
type ClassifiedRings = { rings: SectionRing[]; regions: SectionRegion[] }

/**
 * 按包含关系给环标注嵌套深度并归并出材料区域。
 *
 * 深度 = 包含该环的其他环个数；父环 = 包含它的环里深度最大的那个（同深度取较小下标，
 * 保证同一输入恒得同一结果）。偶数深度的环各是一个材料区域的外环，其直接子环即该区域的孔。
 * @param rings - 已核对的环（深度字段被忽略）。
 * @returns 带深度的环与材料区域。
 */
function classifyRings(rings: readonly SectionRing[]): ClassifiedRings {
  const depth = rings.map(() => 0)
  const parent: (number | undefined)[] = rings.map(() => undefined)
  for (let inner = 0; inner < rings.length; inner += 1) {
    for (let outer = 0; outer < rings.length; outer += 1) {
      if (inner === outer) continue
      const probe = (rings[inner] as SectionRing).points[0] as readonly [number, number]
      if (pointInPolygon(probe, (rings[outer] as SectionRing).points)) depth[inner] = (depth[inner] as number) + 1
    }
  }
  for (let inner = 0; inner < rings.length; inner += 1) {
    for (let outer = 0; outer < rings.length; outer += 1) {
      if (inner === outer || depth[outer] !== (depth[inner] as number) - 1) continue
      const probe = (rings[inner] as SectionRing).points[0] as readonly [number, number]
      if (!pointInPolygon(probe, (rings[outer] as SectionRing).points)) continue
      const known = parent[inner]
      if (known === undefined || (depth[outer] as number) > (depth[known] as number)) parent[inner] = outer
    }
  }
  const ringsWithDepth = rings.map((ring, index) => ({ ...ring, depth: depth[index] as number }))
  const regions: SectionRegion[] = []
  for (let index = 0; index < ringsWithDepth.length; index += 1) {
    if ((depth[index] as number) % 2 !== 0) continue
    const holes = ringsWithDepth
      .map((_, candidate) => candidate)
      .filter(candidate => parent[candidate] === index)
    const own = ringsWithDepth[index] as SectionRing
    const net = holes.reduce((total, hole) => total - (ringsWithDepth[hole] as SectionRing).areaMm2, own.areaMm2)
    regions.push({ outer: index, holes, netAreaMm2: net })
  }
  return { rings: ringsWithDepth, regions }
}

/**
 * 点在多边形内判定（射线穿越，even-odd）。
 * @param point - 待判定的点。
 * @param polygon - 闭合多边形（隐式闭合）。
 * @returns 点严格落在多边形内部时为 true（落在边界上的判定不确定）。
 */
export function pointInPolygon(point: readonly [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i] as readonly [number, number]
    const previous = polygon[j] as readonly [number, number]
    if ((current[1] > point[1]) === (previous[1] > point[1])) continue
    const crossingX = current[0] + ((point[1] - current[1]) / (previous[1] - current[1])) * (previous[0] - current[0])
    if (point[0] < crossingX) inside = !inside
  }
  return inside
}

/**
 * 多边形有向面积（鞋带公式；逆时针为正）。
 * @param polygon - 闭合多边形（隐式闭合）。
 * @returns 有向面积。
 */
function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i] as readonly [number, number]
    const next = polygon[(i + 1) % polygon.length] as readonly [number, number]
    sum += current[0] * next[1] - next[0] * current[1]
  }
  return sum / 2
}

/** 未给参考方向时的缺省「向右」：+X → +Y → +Z 中第一个与法向夹角不超过约 25° 的坐标轴。 */
function defaultReference(normal: Vec3): Vec3 {
  const axes: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (const axis of axes) {
    if (Math.abs(dotVec3(axis, normal)) <= 0.9) return axis
  }
  /* v8 ignore next -- 单位向量的三个分量不可能同时大于 0.9（平方和会超过 1） */
  return axes[0] as Vec3
}

/** 校验并复制三维向量：三个分量都是有限数。 */
function finiteVec3(value: Vec3, subject: string): Vec3 {
  const [x, y, z] = value
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    throw new SectionGeometryError('invalid_input', `${subject} 必须是三个有限数：[${String(x)}, ${String(y)}, ${String(z)}]`)
  }
  return [x, y, z]
}

/** 归一化三维向量；零长度即报错。 */
function normalizeVec3(value: Vec3, subject: string): Vec3 {
  const vector = finiteVec3(value, subject)
  const length = lengthVec3(vector)
  if (length <= BASIS_EPSILON) {
    throw new SectionGeometryError('invalid_input', `${subject} 的长度为零：[${vector.join(', ')}]`)
  }
  return scaleVec3(vector, 1 / length)
}

/** 长度兼容的数值三元组转向量（脚本自产产物，仅核对数值有限性）。 */
function tuple3(value: number[], subject: string): Vec3 {
  const [x, y, z] = value
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    throw new SectionGeometryError('invalid_payload', `${subject} 不是三个有限数：[${String(x)}, ${String(y)}, ${String(z)}]`)
  }
  return [x, y, z]
}

/** 点积。 */
function dotVec3(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

/** 叉积。 */
function crossVec3(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

/** 逐分量相减。 */
function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

/** 数乘。 */
function scaleVec3(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor]
}

/** 模长。 */
function lengthVec3(value: Vec3): number {
  return Math.sqrt(dotVec3(value, value))
}
