/**
 * 剖面线几何：在视图帧里把材料区域变成剖面线段，由 FreeCAD 的 `TechDraw.makeGeomHatch` 生成。
 *
 * **为什么必须在视图帧生成**：画布坐标是「x 向右、y 向下」（`section-diagram.ts` 的入参），
 * 而 `.pat` 的角是在**喂进去的下标平面**上量的。实测（FreeCAD 1.1.3）：把视图帧的二维点
 * 直接当作 z=0 的 XY 坐标建面，`.pat` 写 α 时量到的线段方向角就是 α（30/45/60/90/135
 * 逐值 0.0° 误差）；若在模型帧生成再逆变换回视图帧，角会随镜像翻转（`.pat` 写 45° 在图面
 * 表现为 135°），故本模块只接受视图帧输入，不做任何三维变换。
 *
 * 三条硬约束（实测，改这里之前先看）：
 * 1. **面必须落在 z=0 的 XY 平面**：面平移 +5、−30 或绕 x 倾斜 10° 时返回**空 Compound**
 *    （0 条边；既不是 None 也不抛异常）；绕 z 旋转仍在这一平面内，正常出线。本模块把二维
 *    网格点写成 z=0，约束由构造满足。
 * 2. **必须在视图帧生成剖面线**（见上）。
 * 3. **必须显式传 `patFile`**：`makeGeomHatch(face, scale)` 或 `(face, scale, name)` 在本机
 *    **段错误**（SIGSEGV，退出码 139，stdout 块缓冲全丢）。
 *
 * 另有两条静默失败路径，脚本一律报错而不是交出一张「有轮廓、没剖面线」的图：图案名不在
 * `.pat` 里返回 **None**（不抛异常）；`patFile` 不可读也返回 **None**（只打印一行提示）。
 *
 * **间距映射**：本模块生成的 `.pat` 用 `delta = 1`，实测 `patScale` 因而逐值等于毫米间距
 * （0.25/0.5/1/2/3.5/10 毫米实测间距与 `patScale` 相同；把 `.pat` 的 delta 改成 10，同一个
 * `patScale` 给出 10 倍间距），故 `patScale = spacingMm`，不需要对照表。
 *
 * **孔由 `makeGeomHatch` 自己裁剪**（实测：最大入孔深度 3.3e-10 毫米，穿孔的线被圆切成两段）
 * —— 这正是 `section-diagram.ts` 的 `hatchSegments` 做不到的（它按单个多边形裁剪交点）。
 *
 * `makeGeomHatch` 只接受 `Part.Face`：传 `Compound`/`Shape` 抛 `TypeError`，故脚本逐区域成面。
 *
 * 本模块不接触 FreeCAD：图案解析、取向核对、间距核对与「中点必须落在材料内」的核对都是纯函数，
 * 可在无 FreeCAD 的机器上单测。
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-hatch-geometry
 */

import { fmtNumber, isFiniteNumber } from './freecad-artifact-numbers.ts'
import { SECTION_COORD_DECIMALS, pointInPolygon } from './freecad-section-geometry.ts'

/** `.pat` 内的图案名（由本模块生成，脚本与产物回填共用）。 */
export const HATCH_PATTERN_NAME = 'DSH'

/** 本模块生成的 `.pat` 的线族 delta：取 1 使 `patScale` 直接等于毫米间距（实测）。 */
const HATCH_PAT_DELTA = 1

/** 取向核对容差（度）：验收要求与请求角的偏差小于 0.5°。 */
export const HATCH_ANGLE_TOLERANCE_DEG = 0.5

/** 间距核对容差（毫米）：实测 patScale 与间距逐值相等，这里只留浮点噪声的余量。 */
const HATCH_SPACING_TOLERANCE_MM = 1e-4

/**
 * 线段中点核对的长度下限（毫米）。
 *
 * 中点核对用的是离散轮廓多边形（内接于真实曲线，故比真实材料略小）：紧贴边界、长度不足
 * 千分之几毫米的线段，其中点可能落在多边形之外而仍在材料内。低于此长度的线段图面上不可辨，
 * 跳过核对；更长的线段必须整体落在材料区域内。
 */
export const HATCH_MIDPOINT_CHECK_MM = 0.01

/** 剖面线坐标写出的小数位（与剖切产物同精度：0.001 微米级）。 */
export const HATCH_COORD_DECIMALS = SECTION_COORD_DECIMALS

/** 剖面线方向：'forward' 为左上→右下、'backward' 为左下→右上（与 `HatchSpec` 同口径）。 */
export type HatchDirection = 'forward' | 'backward'

/** 合法方向（校验用；与 `section-diagram.ts` 同形，避免「字面量比较恒真」的判据）。 */
const HATCH_DIRECTIONS: readonly HatchDirection[] = ['forward', 'backward']

/** 一个材料区域（视图帧毫米）：外环 + 其直接包含的孔环。 */
export type HatchRegion = {
  /** 材料外环顶点（≥3 个，隐式闭合）。 */
  outline: readonly (readonly [number, number])[]
  /** 该区域内的孔（0 个或多个）：剖面线必须避开它们。 */
  holes?: readonly (readonly (readonly [number, number])[])[]
}

/** 剖面线请求：材料区域、图面角度、间距与方向。 */
export type SectionHatchRequest = {
  /** 要打剖面线的材料区域（至少一个；区域序即产物序）。 */
  regions: readonly HatchRegion[]
  /** 与图面水平线的夹角（度，画布坐标 y 向下）；取值域 (0, 90]。 */
  angleDeg: number
  /** 相邻剖面线的垂直间距（毫米，正有限数）。 */
  spacingMm: number
  /** 方向；缺省 'forward'。 */
  direction?: HatchDirection
}

/** 已解析的剖面线请求：`.pat` 角、图案名与文件内容、patScale。 */
export type HatchPattern = {
  /** 视图帧请求角（度）。 */
  angleDeg: number
  /** 方向。 */
  direction: HatchDirection
  /** 间距（毫米）。 */
  spacingMm: number
  /** 写进 `.pat` 的角（度，0–180）：backward 取 180 − angleDeg。 */
  patAngleDeg: number
  /** 传给 `makeGeomHatch` 的 patScale（= spacingMm，见模块说明）。 */
  patScale: number
  /** `.pat` 内的图案名。 */
  patName: string
  /** `.pat` 文件内容（ASCII）。 */
  patText: string
}

/** 剖面线段（视图帧毫米）。 */
type HatchSegment = {
  /** 起点。 */
  from: readonly [number, number]
  /** 终点。 */
  to: readonly [number, number]
}

/** 剖面线几何：全部线段、逐区域线段数与脚本回填的图案参数。 */
export type HatchGeometry = {
  /** 全部剖面线段（按区域序、区域内的输出序）。 */
  segments: readonly HatchSegment[]
  /** 逐区域的线段数（区域序即请求序）。 */
  regionCounts: readonly number[]
  /** 脚本回填的 `.pat` 角（度）。 */
  patAngleDeg: number
  /** 脚本回填的 patScale。 */
  patScale: number
}

/** 脚本写出的 `section-hatch.json` 结构（本包自产，逐项核对后再用）。 */
export type HatchGeometryPayload = {
  pattern: { angle_deg: number; pat_scale: number; pat_name: string }
  regions: { segments_mm: number[][][] }[]
}

/** 剖面线几何错误码：请求非法、产物结构非法、空剖面线、取向/间距不符、线段不在材料内。 */
type HatchGeometryErrorCode =
  | 'invalid_input'
  | 'invalid_payload'
  | 'empty_hatch'
  | 'angle_mismatch'
  | 'spacing_mismatch'
  | 'region_mismatch'

/** 剖面线几何错误（渲染器映射为 `hatch_failed`，工具层映射为 `invalid_tool_input`）。 */
export class HatchGeometryError extends Error {
  /** 错误码。 */
  readonly code: HatchGeometryErrorCode

  constructor(code: HatchGeometryErrorCode, message: string) {
    super(message)
    this.name = 'HatchGeometryError'
    this.code = code
  }
}

/**
 * 解析并校验剖面线请求（纯函数）。
 *
 * @param request - 材料区域、角度、间距与方向。
 * @returns 缺省值已填入的图案参数（含 `.pat` 文件内容）。
 * @throws HatchGeometryError('invalid_input') 区域为空、轮廓顶点不足、坐标非有限数、
 * 角度不在 (0, 90]、间距非正有限数或方向非法时。
 */
export function resolveHatchPattern(request: SectionHatchRequest): HatchPattern {
  if (request.regions.length === 0) {
    throw new HatchGeometryError('invalid_input', '剖面线至少需要一个材料区域：regions 为空')
  }
  request.regions.forEach((region, index) => {
    const holes: readonly (readonly (readonly [number, number])[])[] = region.holes ?? []
    checkPolygon(region.outline, `区域 #${index + 1} 的材料外环`)
    holes.forEach((hole, holeIndex) => {
      checkPolygon(hole, `区域 #${index + 1} 的孔 #${holeIndex + 1}`)
    })
  })
  const direction = request.direction ?? 'forward'
  if (!HATCH_DIRECTIONS.includes(direction)) {
    throw new HatchGeometryError('invalid_input', `剖面线方向只能是 forward 或 backward：${direction}`)
  }
  const angleDeg = request.angleDeg
  if (!isFiniteNumber(angleDeg) || angleDeg <= 0 || angleDeg > 90) {
    throw new HatchGeometryError('invalid_input', `剖面线角度必须在 (0, 90] 度内：${String(angleDeg)}`)
  }
  const spacingMm = request.spacingMm
  if (!isFiniteNumber(spacingMm) || spacingMm <= 0) {
    throw new HatchGeometryError('invalid_input', `剖面线间距必须是正有限数：${String(spacingMm)}`)
  }
  // backward 的线向是 (cos, −sin)，量到的方向角即 180 − angleDeg（实测 .pat 角与量到的角一致）。
  const patAngleDeg = direction === 'forward' ? angleDeg : 180 - angleDeg
  return {
    angleDeg,
    direction,
    spacingMm,
    patAngleDeg,
    patScale: spacingMm,
    patName: HATCH_PATTERN_NAME,
    patText: `*${HATCH_PATTERN_NAME}, ${patNumber(patAngleDeg)} deg\n${patNumber(patAngleDeg)}, 0,0, 0,${patNumber(HATCH_PAT_DELTA)}\n`,
  }
}

/**
 * 把脚本产物解析为剖面线几何（纯函数）。
 * @param text - `section-hatch.json` 的文本内容。
 * @param request - 本次请求（作为核对的期望值）。
 * @returns 已核对的剖面线几何。
 * @throws HatchGeometryError 产物结构非法、空剖面线，或取向/间距/落点与请求不符时。
 */
export function parseHatchGeometry(text: string, request: SectionHatchRequest): HatchGeometry {
  return readHatchGeometry(JSON.parse(text) as HatchGeometryPayload, request)
}

/**
 * 把已解析的脚本产物核对为剖面线几何（纯函数）：结构 → 取向 → 间距 → 落点。
 *
 * 每步都是独立量测：取向按线段方向角核对（容差 {@link HATCH_ANGLE_TOLERANCE_DEG}）；间距把
 * 线段中点投影到线族法向，要求相邻族参数之差是请求间距的整数倍（单区域要求正好一倍）；
 * 落点要求线段中点落在材料区域内（避开该区域全部孔）。这三步能把「角度镜像」「间距差十倍」
 * 「剖面线没被孔裁掉」这三类错图当场拦下。
 * @param payload - `section-hatch.json` 解析后的对象。
 * @param request - 本次请求（作为核对的期望值）。
 * @returns 已核对的剖面线几何。
 * @throws HatchGeometryError 结构非法（`invalid_payload`）、无线段（`empty_hatch`）、
 * 取向不符（`angle_mismatch`）、间距不符（`spacing_mismatch`）、中点不在材料内
 * （`region_mismatch`）时。
 */
export function readHatchGeometry(payload: HatchGeometryPayload, request: SectionHatchRequest): HatchGeometry {
  const pattern = resolveHatchPattern(request)
  const expectedRegions = request.regions
  const rawRegions = payload.regions
  if (!Array.isArray(rawRegions) || rawRegions.length !== expectedRegions.length) {
    throw new HatchGeometryError(
      'invalid_payload',
      `剖面线产物覆盖 ${String(rawRegions.length)} 个材料区域，与请求的 ${String(expectedRegions.length)} 个不符`,
    )
  }
  checkReportedPattern(payload.pattern, pattern)

  const grouped = rawRegions.map((rawRegion, index) => {
    const raw = rawRegion.segments_mm
    if (!Array.isArray(raw)) {
      throw new HatchGeometryError('invalid_payload', `剖面线产物缺少区域 #${index + 1} 的线段数组`)
    }
    return raw.map((pair, segmentIndex) => readSegment(pair, index, segmentIndex))
  })

  const segments = grouped.flat()
  if (segments.length === 0) {
    throw new HatchGeometryError(
      'empty_hatch',
      `剖面线为 0 条：面不在 z=0 的 XY 平面（实测返回空 Compound），或图案名 ${pattern.patName} 不在 .pat 里（实测返回 None）`,
    )
  }
  checkAngles(segments, pattern)
  checkSpacing(grouped, pattern)
  checkRegionMembership(grouped, expectedRegions)

  return {
    segments,
    regionCounts: grouped.map(group => group.length),
    patAngleDeg: payload.pattern.angle_deg,
    patScale: payload.pattern.pat_scale,
  }
}

/** 核对脚本回填的图案参数与请求一致（否则脚本读到的不是本次请求）。 */
function checkReportedPattern(
  reported: HatchGeometryPayload['pattern'],
  pattern: HatchPattern,
): void {
  if (!isFiniteNumber(reported.angle_deg) || Math.abs(reported.angle_deg - pattern.patAngleDeg) > 1e-9) {
    throw new HatchGeometryError(
      'invalid_payload',
      `剖面线产物回填的 .pat 角 ${String(reported.angle_deg)} 与请求的 ${fmtNumber(pattern.patAngleDeg)} 度不符`,
    )
  }
  if (!isFiniteNumber(reported.pat_scale) || Math.abs(reported.pat_scale - pattern.patScale) > 1e-9) {
    throw new HatchGeometryError(
      'invalid_payload',
      `剖面线产物回填的 patScale ${String(reported.pat_scale)} 与请求的 ${fmtNumber(pattern.patScale)} 不符`,
    )
  }
  if (reported.pat_name !== pattern.patName) {
    throw new HatchGeometryError(
      'invalid_payload',
      `剖面线产物回填的图案名 ${reported.pat_name} 与请求的 ${pattern.patName} 不符`,
    )
  }
}

/**
 * 读出一条线段并核对结构（两个端点、有限坐标、非零长度）。
 * @param pair - 产物里的线段记录。
 * @param regionIndex - 所属区域下标（报错用）。
 * @param segmentIndex - 区域内的线段下标（报错用）。
 * @returns 已核对的线段。
 */
function readSegment(pair: number[][], regionIndex: number, segmentIndex: number): HatchSegment {
  const subject = `区域 #${regionIndex + 1} 的第 ${segmentIndex + 1} 条剖面线段`
  if (!Array.isArray(pair) || pair.length !== 2) {
    throw new HatchGeometryError('invalid_payload', `${subject}不是两个端点：[${String(pair.length)} 个元素]`)
  }
  const from = readPoint(pair[0], `${subject}的起点`)
  const to = readPoint(pair[1], `${subject}的终点`)
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) === 0) {
    throw new HatchGeometryError('invalid_payload', `${subject}是零长线段：[${String(from[0])}, ${String(from[1])}]`)
  }
  return { from, to }
}

/**
 * 读出一个二维点（有限坐标）。
 * @param value - 产物里的顶点记录。
 * @param subject - 报错用主体名。
 * @returns 已核对的二维点。
 */
function readPoint(value: number[] | undefined, subject: string): readonly [number, number] {
  const [x, y] = Array.isArray(value) ? value : []
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw new HatchGeometryError(
      'invalid_payload',
      `${subject}不是有限二维坐标：[${String(x)}, ${String(y)}]`,
    )
  }
  return [x, y]
}

/**
 * 核对线段方向角与请求角一致（按无向直线比较，容差 {@link HATCH_ANGLE_TOLERANCE_DEG}）。
 * @param segments - 全部剖面线段。
 * @param pattern - 已解析的请求。
 */
function checkAngles(segments: readonly HatchSegment[], pattern: HatchPattern): void {
  // backward 的线向是 (cos, −sin)，在图面（y 向下）里的方向角是 180 − angleDeg。
  const expected = pattern.direction === 'forward' ? pattern.angleDeg : 180 - pattern.angleDeg
  for (const segment of segments) {
    const measured = (Math.atan2(segment.to[1] - segment.from[1], segment.to[0] - segment.from[0]) * 180) / Math.PI
    const wrapped = Math.abs(measured - expected) % 180
    const delta = Math.min(wrapped, 180 - wrapped)
    if (delta > HATCH_ANGLE_TOLERANCE_DEG) {
      throw new HatchGeometryError(
        'angle_mismatch',
        `剖面线取向 ${fmtNumber(wrapped)} 度（请求 ${fmtNumber(pattern.angleDeg)} 度、方向 ${pattern.direction}）`
        + `与请求相差 ${fmtNumber(delta)} 度，超过 ${fmtNumber(HATCH_ANGLE_TOLERANCE_DEG)} 度：`
        + '剖面线必须在视图帧生成（在模型帧生成再逆变换会镜像翻转）',
      )
    }
  }
}

/**
 * 核对相邻剖面线的间距是请求间距的整数倍（单区域要求正好一倍）。
 *
 * 族参数 = 线段中点在单位法向上的投影；同一张图上所有区域共用同一 `.pat` 原点，故族参数落在
 * 同一组间距为 `spacingMm` 的格点上。多区域时某条格线可能与所有区域都不相交（两区域恰好错开），
 * 故允许整数倍；单区域的凸/凹轮廓每个格点都有线段，故要求相邻族参数之差正好是一个间距。
 * @param grouped - 逐区域的线段。
 * @param pattern - 已解析的请求。
 */
function checkSpacing(grouped: readonly (readonly HatchSegment[])[], pattern: HatchPattern): void {
  const radians = (pattern.angleDeg * Math.PI) / 180
  const sign = pattern.direction === 'forward' ? 1 : -1
  const normal: readonly [number, number] = [-sign * Math.sin(radians), Math.cos(radians)]
  const offsets = new Set<number>()
  for (const group of grouped) {
    for (const segment of group) {
      const midX = (segment.from[0] + segment.to[0]) / 2
      const midY = (segment.from[1] + segment.to[1]) / 2
      offsets.add(roundCoord(midX * normal[0] + midY * normal[1]))
    }
  }
  const sorted = [...offsets].sort((left, right) => left - right)
  const singleRegion = grouped.length === 1
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index] as number) - (sorted[index - 1] as number)
    const steps = Math.round(gap / pattern.spacingMm)
    if (steps < 1 || Math.abs(gap - steps * pattern.spacingMm) > HATCH_SPACING_TOLERANCE_MM) {
      throw new HatchGeometryError(
        'spacing_mismatch',
        `相邻剖面线的间距 ${fmtNumber(gap)} 毫米不是请求间距 ${fmtNumber(pattern.spacingMm)} 毫米的整数倍：`
        + 'patScale 必须等于毫米间距（本模块生成的 .pat 用 delta = 1）',
      )
    }
    if (singleRegion && steps !== 1) {
      throw new HatchGeometryError(
        'spacing_mismatch',
        `单个材料区域内相邻剖面线的间距 ${fmtNumber(gap)} 毫米是请求间距 ${fmtNumber(pattern.spacingMm)} 毫米的 ${String(steps)} 倍：中间缺线`,
      )
    }
  }
}

/**
 * 核对线段中点落在材料区域内（在该区域外环之内、且不在其任何孔内）。
 * @param grouped - 逐区域的线段。
 * @param regions - 请求里的材料区域。
 */
function checkRegionMembership(
  grouped: readonly (readonly HatchSegment[])[],
  regions: readonly HatchRegion[],
): void {
  grouped.forEach((group, index) => {
    const region = regions[index] as HatchRegion
    const holes = region.holes ?? []
    for (const segment of group) {
      if (Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]) < HATCH_MIDPOINT_CHECK_MM) continue
      const mid: readonly [number, number] = [
        (segment.from[0] + segment.to[0]) / 2,
        (segment.from[1] + segment.to[1]) / 2,
      ]
      if (!pointInPolygon(mid, region.outline)) {
        throw new HatchGeometryError(
          'region_mismatch',
          `区域 #${index + 1} 的剖面线中点 [${fmtNumber(mid[0])}, ${fmtNumber(mid[1])}] 落在材料外轮廓之外：`
          + '剖面线没有按材料区域裁剪',
        )
      }
      holes.forEach((hole, holeIndex) => {
        if (!pointInPolygon(mid, hole)) return
        throw new HatchGeometryError(
          'region_mismatch',
          `区域 #${index + 1} 的剖面线中点 [${fmtNumber(mid[0])}, ${fmtNumber(mid[1])}] 落在孔 #${holeIndex + 1} 内：`
          + '剖面线没有避开孔（成面时孔环必须一并交给 Part::FaceMakerBullseye）',
        )
      })
    }
  })
}

/**
 * 校验一个闭合轮廓（至少 3 个有限二维坐标）。
 * @param polygon - 待校验的轮廓顶点。
 * @param subject - 报错用主体名。
 */
function checkPolygon(polygon: readonly (readonly [number, number])[], subject: string): void {
  if (polygon.length < 3) {
    throw new HatchGeometryError(
      'invalid_input',
      `${subject}的顶点少于 3 个：${String(polygon.length)}（剖面线区域必须是闭合轮廓）`,
    )
  }
  polygon.forEach((point, index) => {
    const [x, y] = point
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      throw new HatchGeometryError(
        'invalid_input',
        `${subject}的第 ${index + 1} 个顶点不是有限二维坐标：[${String(x)}, ${String(y)}]`,
      )
    }
  })
}

/** 按 {@link HATCH_COORD_DECIMALS} 取整（族参数与坐标的比对基准）。 */
function roundCoord(value: number): number {
  const factor = 10 ** HATCH_COORD_DECIMALS
  return Math.round(value * factor) / factor
}

/**
 * `.pat` 里的数值文本。
 *
 * 角与 delta 只落在 1–180，按 6 位小数取整后 `String` 不会给出科学计数法（`.pat` 解析器不认）。
 * @param value - 待格式化的数值。
 * @returns 十进制文本。
 */
function patNumber(value: number): string {
  const factor = 10 ** HATCH_COORD_DECIMALS
  return String(Math.round(value * factor) / factor)
}
