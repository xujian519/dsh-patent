/**
 * 剖切来源（`sections.source`）：把「模型文件 + 剖切平面」展开成剖视图输入里显式的
 * 零件轮廓、孔环与剖面线段，其余画法（剖面线分组、引线标号、中心线、剖切符号、线宽、
 * 落版与复核）沿用现有 `cross_section` 通路。
 *
 * 展开分两步，各由 FreeCAD 端口完成（见 {@link SectionSourcePorts}）：
 * 1. 取轮廓：`Shape.slice` 切出闭合环，按包含关系归并成材料区域（材料外环 + 孔环）；
 * 2. 打剖面线：在**缩放后的视图帧**里按区域成面、用 `makeGeomHatch` 生成线段。
 *
 * 三条实测约束决定了本模块的写法：
 * - 剖面线只能在视图帧生成，且面必须落在 z=0 的 XY 平面（见 `freecad-hatch-geometry`）；
 * - 孔由 `makeGeomHatch` 精确裁剪，故带孔零件的 `parts[].outline` 与剖面线是同一组多边形，
 *   线段端点正好落在画出来的轮廓线上（`freecad-hatch-geometry` 的模块说明）；
 * - `SectionDiagramInput` 的逐多边形裁剪会把孔里也打上剖面线，故带孔零件必须走
 *   {@link SectionPart.hatchSegments} 入口（见 `section-diagram`）。
 *
 * 比例：先按 `source.scale` 缩放切出的坐标，再在缩放后的帧里生成剖面线，因此
 * `parts[].hatch.spacing_mm` 是**图面毫米**（GB/T 4457.5 的间距是图样上的间距）；
 * `anchor`、`labels`、`centerlines`、`cutting_marks` 也都是图面毫米坐标。
 *
 * `parts` 与材料区域按 `anchor` 逐点匹配而不是按序号：区域顺序由 OCCT 的边输出顺序决定，
 * 序号对会把标号与剖面线挂到别的区域上，而 anchor 落错区域是当场可判的。
 * @module @deepseek-ai/dsh-patent-tools/figure/section-source
 */

import { stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { SUPPORTED_MODEL_EXTENSIONS, type SectionGeometryOutcome, type SectionGeometrySpec, type SectionHatchOutcome, type SectionHatchSpec } from './freecad-renderer.ts'
import { fmtNumber } from './freecad-artifact-numbers.ts'
import { HatchGeometryError, resolveHatchPattern, type HatchDirection, type HatchRegion } from './freecad-hatch-geometry.ts'
import { SectionGeometryError, pointInPolygon, type SectionGeometry, type SectionPlane, type SectionRing, type Vec3 } from './freecad-section-geometry.ts'
import { DEFAULT_HATCH_ANGLE_DEG, DEFAULT_HATCH_SPACING_MM } from './section-diagram.ts'
import type { SectionFigureJson, SectionSourceJson } from './vector-figure-build.ts'

/** 模型包围盒与声明尺寸的允许相对偏差：尺寸核对只为挡住单位读错与比例全错。 */
export const SECTION_SOURCE_SIZE_TOLERANCE = 1e-3

/** 缺省图面比例（1:1，图面毫米即模型毫米）。 */
const DEFAULT_SECTION_SOURCE_SCALE = 1

/** 剖切来源错误码：输入非法、模型文件不存在、FreeCAD 缺失、剖切失败、剖面线失败、调用方取消。 */
export type SectionSourceErrorCode =
  | 'invalid_input'
  | 'file_not_found'
  | 'not_installed'
  | 'geometry_failed'
  | 'hatch_failed'
  | 'aborted'

/** 剖切来源错误（工具层按码翻成专利工具错误：见 `tool/internal/render-outcome`）。 */
export class SectionSourceError extends Error {
  /** 错误码。 */
  readonly code: SectionSourceErrorCode

  constructor(code: SectionSourceErrorCode, message: string) {
    super(message)
    this.name = 'SectionSourceError'
    this.code = code
  }
}

/** 剖切来源的两个 FreeCAD 端口：宿主注入真实渲染器，测试注入假实现。 */
export type SectionSourcePorts = {
  /** 取剖切平面的闭合轮廓环与材料区域（`renderSectionGeometry`）。 */
  sectionGeometry: (spec: SectionGeometrySpec) => Promise<SectionGeometryOutcome>
  /** 在视图帧里为材料区域生成剖面线（`renderSectionHatch`）。 */
  sectionHatch: (spec: SectionHatchSpec) => Promise<SectionHatchOutcome>
}

/** 展开参数。 */
export type SectionSourceOptions = {
  /** FreeCAD 端口。 */
  ports: SectionSourcePorts
  /** `model_path` 的相对路径基准。 */
  cwd: string
  /** FreeCAD 中间产物目录（脚本、几何 JSON、`.pat`）。 */
  artifactDir: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/** 展开结果：已填好轮廓与剖面线的剖视图输入，外加随结果返回的提示。 */
export type SectionSourceExpansion = {
  /** 展开后的剖视图输入；没有 `source` 时就是传入的那个对象。 */
  sections: SectionFigureJson
  /** 提示（材料区域清单等）。 */
  warnings: string[]
}

/** 一个已定位的材料区域：图面毫米坐标的外环与孔环。 */
type LocatedRegion = {
  /** 区域序号（1 起，与提示文案一致）。 */
  readonly index: number
  /** 材料外环（已缩放）。 */
  readonly outline: readonly (readonly [number, number])[]
  /** 孔环（已缩放）。 */
  readonly holes: readonly (readonly (readonly [number, number])[])[]
  /** 净面积（图面毫米²，已按比例缩放）。 */
  readonly netAreaMm2: number
}

/**
 * 展开 `sections.source`：没有 source 时原样返回输入。
 * @param sections - 剖视图输入（模型 JSON 边界之后的值）。
 * @param options - 端口、路径基准、产物目录与取消信号。
 * @returns 展开后的输入与提示。
 * @throws SectionSourceError 输入非法、模型文件缺失、FreeCAD 缺失、剖切或剖面线失败、调用方取消时。
 */
export async function expandSectionSource(
  sections: SectionFigureJson,
  options: SectionSourceOptions,
): Promise<SectionSourceExpansion> {
  const source = sections.source
  if (source === undefined) return { sections, warnings: [] }
  const scale = resolveScale(source)
  if (sections.parts.length === 0) {
    throw new SectionSourceError('invalid_input', 'sections.source 需要 parts 逐区域给出标号与剖面线参数（至少一项）')
  }
  const anchors = readAnchors(sections)
  const modelPath = await resolveModelPath(source.model_path, options.cwd)
  const geometry = await loadGeometry(options, {
    modelPath,
    plane: readPlane(source),
  })
  verifyDeclaredSize(geometry, source.part_size_mm, modelPath)
  const regions = locateRegions(geometry, scale)
  const matched = matchRegions(regions, anchors)
  const hatchByPart = await hatchRegions(options, matched, sections)
  const parts = sections.parts.map((part, index) => {
    const region = matched[index] as LocatedRegion
    const segments = hatchByPart.get(index)
    return {
      ...part,
      outline: region.outline,
      ...(region.holes.length === 0 ? {} : { holes: region.holes }),
      ...(segments === undefined ? {} : { hatch_segments: segments }),
    }
  })
  return {
    sections: { ...sections, parts },
    warnings: [regionInventory(modelPath, regions)],
  }
}

/**
 * 解析图面比例：缺省 1，必须是正有限数。
 * @param source - 剖切来源输入。
 * @returns 生效比例。
 * @throws SectionSourceError('invalid_input') 比例非正有限数时。
 */
function resolveScale(source: SectionSourceJson): number {
  const scale = source.scale ?? DEFAULT_SECTION_SOURCE_SCALE
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new SectionSourceError('invalid_input', `sections.source.scale 必须是正有限数，收到 ${String(scale)}`)
  }
  return scale
}

/**
 * 读取剖切平面：三个分量都是有限数的三维向量。
 * @param source - 剖切来源输入。
 * @returns 已校验的平面（法向与参考方向由 `resolveSectionFrame` 归一化）。
 * @throws SectionSourceError('invalid_input') 分量不是有限数或个数不足时。
 */
function readPlane(source: SectionSourceJson): SectionPlane {
  return {
    origin: readVec3(source.plane.origin, 'sections.source.plane.origin'),
    normal: readVec3(source.plane.normal, 'sections.source.plane.normal'),
    ...(source.plane.reference === undefined
      ? {}
      : { reference: readVec3(source.plane.reference, 'sections.source.plane.reference') }),
  }
}

/**
 * 读取三维向量（工具 JSON 的 number[] → 三个有限数）。
 * @param value - 输入数组。
 * @param subject - 报错用字段名。
 * @returns 三个分量。
 * @throws SectionSourceError('invalid_input') 不是三个有限数时。
 */
function readVec3(value: readonly number[], subject: string): Vec3 {
  const [x, y, z] = value
  if (value.length !== 3 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new SectionSourceError('invalid_input', `${subject} 必须是三个有限数：[${value.map(item => String(item)).join(', ')}]`)
  }
  return [x as number, y as number, z as number]
}

/**
 * 读取逐零件的区域锚点：`source` 模式下每个零件都要给 `anchor` 且不能再给 `outline`。
 * @param sections - 剖视图输入。
 * @returns 与 `parts` 同序的锚点。
 * @throws SectionSourceError('invalid_input') 缺 anchor、给了 outline 或锚点坐标非有限数时。
 */
function readAnchors(sections: SectionFigureJson): (readonly [number, number])[] {
  return sections.parts.map((part, index) => {
    const subject = `零件 #${index + 1} `
    if (part.outline !== undefined) {
      throw new SectionSourceError(
        'invalid_input',
        `${subject}同时给了 outline 与 sections.source：轮廓只能有一个来源，请删掉 outline 或去掉 source`,
      )
    }
    const anchor = part.anchor
    if (anchor === undefined || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) {
      throw new SectionSourceError(
        'invalid_input',
        `${subject}缺少 anchor：sections.source 模式下每个零件要给一个落在它所属材料区域内的图面坐标点`
        + '（[x, y] 两个有限数，已含 scale），用它把标号与剖面线参数挂到正确的区域上',
      )
    }
    return anchor
  })
}

/**
 * 解析模型文件路径：相对基准解析、必须存在且是受支持的格式。
 * @param modelPath - 输入路径。
 * @param cwd - 相对路径基准。
 * @returns 绝对路径。
 * @throws SectionSourceError('file_not_found') 文件不存在时。
 * @throws SectionSourceError('invalid_input') 不是文件或格式不受支持时。
 */
async function resolveModelPath(modelPath: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, modelPath)
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new SectionSourceError('file_not_found', `sections.source.model_path 不存在或不可读：${modelPath}`)
  }
  if (!info.isFile()) {
    throw new SectionSourceError('invalid_input', `sections.source.model_path 不是文件：${modelPath}`)
  }
  if (!SUPPORTED_MODEL_EXTENSIONS.includes(extname(absolute).toLowerCase())) {
    throw new SectionSourceError(
      'invalid_input',
      `不支持的模型格式 "${extname(absolute)}"；可选：${SUPPORTED_MODEL_EXTENSIONS.join('、')}`,
    )
  }
  return absolute
}

/**
 * 端口调用的公共参数：产物目录与取消信号在两个端口上必须一致（同一处取值，两处不各写一份）。
 * @param options - 展开参数。
 * @returns 端口参数里的 `outputDir` 与 `signal`。
 */
function portContext(options: SectionSourceOptions): { outputDir: string; signal?: AbortSignal } {
  return {
    outputDir: options.artifactDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/**
 * 两个端口共用的失败结果：取消与环境缺失在两处同码，其余归各自步骤的失败码。
 */
type PortFailureOutcome =
  | Extract<SectionGeometryOutcome, { ok: false }>
  | Extract<SectionHatchOutcome, { ok: false }>

/**
 * 端口失败的公共映射：取消与环境缺失各成一码，其余归该步的失败码。
 * @param outcome - 端口的失败结果。
 * @param stage - 该步的取消文案与失败码。
 * @returns 对应的剖切来源错误。
 */
function portFailure(
  outcome: PortFailureOutcome,
  stage: { readonly aborted: string; readonly failed: SectionSourceErrorCode },
): SectionSourceError {
  if (outcome.code === 'aborted') return new SectionSourceError('aborted', stage.aborted)
  if (outcome.code === 'not_installed') return new SectionSourceError('not_installed', outcome.error)
  return new SectionSourceError(stage.failed, outcome.error)
}

/**
 * 取剖切几何（端口失败与平面非法都按码翻成本模块的错误）。
 * @param options - 展开参数。
 * @param spec - 模型路径与剖切平面。
 * @returns 已核对的剖切几何。
 * @throws SectionSourceError 平面非法或端口失败时。
 */
async function loadGeometry(
  options: SectionSourceOptions,
  spec: { modelPath: string; plane: SectionPlane },
): Promise<SectionGeometry> {
  let outcome: SectionGeometryOutcome
  try {
    outcome = await options.ports.sectionGeometry({ modelPath: spec.modelPath, plane: spec.plane, ...portContext(options) })
  } catch (error) {
    if (error instanceof SectionGeometryError) throw new SectionSourceError('invalid_input', error.message)
    throw error
  }
  if (outcome.ok) return outcome.geometry
  throw portFailure(outcome, { aborted: '剖切几何被取消', failed: 'geometry_failed' })
}

/**
 * 核对模型包围盒与声明的零件尺寸（顺序无关）。
 *
 * STEP 只保证按文件声明的单位读入，IGES/BREP 没有单位声明 —— 声明值与模型对不上时图面
 * 比例整体是错的，故当场失败而不是画出一张比例错的图。
 * @param geometry - 剖切几何（含模型包围盒）。
 * @param declared - 声明的零件整体尺寸（毫米）；缺省时不核对。
 * @param modelPath - 模型绝对路径（报错用）。
 * @throws SectionSourceError('invalid_input') 声明值不是三个正有限数、或与包围盒不符时。
 */
function verifyDeclaredSize(geometry: SectionGeometry, declared: readonly number[] | undefined, modelPath: string): void {
  if (declared === undefined) return
  const size = readVec3(declared, 'sections.source.part_size_mm')
  if (size.some(value => value <= 0)) {
    throw new SectionSourceError('invalid_input', `sections.source.part_size_mm 必须是三个正有限数：[${size.join(', ')}]`)
  }
  const box = geometry.model.boundBoxMm
  const actual = box.max.map((value, axis) => value - (box.min[axis] as number))
  const declaredSorted = [...size].sort((left, right) => left - right)
  const actualSorted = [...actual].sort((left, right) => left - right)
  const drift = declaredSorted.map((value, axis) => Math.abs((actualSorted[axis] as number) - value) / value)
  const worst = Math.max(...drift)
  if (worst <= SECTION_SOURCE_SIZE_TOLERANCE) return
  throw new SectionSourceError(
    'invalid_input',
    `模型 ${basename(modelPath)} 的包围盒 ${actualSorted.map(fmtNumber).join('×')} 毫米与声明的零件尺寸 `
    + `${declaredSorted.map(fmtNumber).join('×')} 毫米不符（相对偏差 ${fmtNumber(worst * 100)}%）：`
    + 'STEP/IGES/BREP 的单位声明不一致时图面比例会整体错，请核对 part_size_mm 与模型单位',
  )
}

/**
 * 把材料区域取成图面毫米坐标（外环 + 孔环，按比例缩放）。
 * @param geometry - 剖切几何。
 * @param scale - 图面比例。
 * @returns 与 `geometry.regions` 同序的区域。
 */
function locateRegions(geometry: SectionGeometry, scale: number): LocatedRegion[] {
  return geometry.regions.map((region, index) => ({
    index: index + 1,
    outline: scalePolygon(ringPoints(geometry, region.outer), scale),
    holes: region.holes.map(hole => scalePolygon(ringPoints(geometry, hole), scale)),
    netAreaMm2: region.netAreaMm2 * scale * scale,
  }))
}

/**
 * 取几何里某个环的顶点（环下标由 `regions` 给出，故一定存在）。
 * @param geometry - 剖切几何。
 * @param index - 环下标。
 * @returns 环顶点（视图帧毫米）。
 */
function ringPoints(geometry: SectionGeometry, index: number): readonly (readonly [number, number])[] {
  return (geometry.rings[index] as SectionRing).points
}

/**
 * 多边形按比例缩放。
 * @param points - 顶点（毫米）。
 * @param scale - 比例。
 * @returns 缩放后的顶点。
 */
function scalePolygon(
  points: readonly (readonly [number, number])[],
  scale: number,
): (readonly [number, number])[] {
  return points.map(point => [point[0] * scale, point[1] * scale] as const)
}

/**
 * 按锚点把零件与材料区域配成一对一。
 * @param regions - 材料区域（图面毫米）。
 * @param anchors - 与 `parts` 同序的锚点。
 * @returns 与 `parts` 同序的区域。
 * @throws SectionSourceError('invalid_input') 锚点不在任何区域、落在两个区域、有区域没被认领、
 * 或零件数与区域数不等时。
 */
function matchRegions(regions: readonly LocatedRegion[], anchors: readonly (readonly [number, number])[]): LocatedRegion[] {
  if (regions.length !== anchors.length) {
    throw new SectionSourceError(
      'invalid_input',
      `sections.source 切出 ${String(regions.length)} 个材料区域，而 parts 有 ${String(anchors.length)} 个：`
      + '每个材料区域要有一个 parts 项（给 label 与 hatch）；切出的区域如下：'
      + regions.map(region => `#${String(region.index)} 净面积 ${fmtNumber(region.netAreaMm2)} 毫米²`).join('、'),
    )
  }
  const claimed = new Map<number, number>()
  const matched = anchors.map((anchor, partIndex) => {
    const found = regions.filter(region => insideRegion(anchor, region))
    if (found.length === 0) {
      throw new SectionSourceError(
        'invalid_input',
        `零件 #${String(partIndex + 1)} 的 anchor (${fmtNumber(anchor[0])}, ${fmtNumber(anchor[1])}) 不在任何材料区域内：`
        + 'anchor 用图面毫米坐标（已含 scale），要落在该零件所属材料区域的材料上（孔内不算）',
      )
    }
    if (found.length > 1) {
      throw new SectionSourceError(
        'invalid_input',
        `零件 #${String(partIndex + 1)} 的 anchor 同时落在区域 ${found.map(region => `#${String(region.index)}`).join('、')} 内：请给一个只落在本零件区域内的点`,
      )
    }
    const region = found[0] as LocatedRegion
    const other = claimed.get(region.index)
    if (other !== undefined) {
      throw new SectionSourceError(
        'invalid_input',
        `零件 #${String(other + 1)} 与零件 #${String(partIndex + 1)} 的 anchor 落在同一个材料区域 #${String(region.index)} 上：`
        + '每个材料区域只能由一个 parts 项认领（同一零件的多段轮廓由同一次剖切出一个区域）',
      )
    }
    claimed.set(region.index, partIndex)
    return region
  })
  return matched
}

/**
 * 点是否落在材料区域内（在轮廓内且不在任何孔内）。
 * @param anchor - 图面毫米坐标点。
 * @param region - 材料区域。
 * @returns 落在材料上时为 true。
 */
function insideRegion(anchor: readonly [number, number], region: LocatedRegion): boolean {
  if (!pointInPolygon(anchor, region.outline)) return false
  return !region.holes.some(hole => pointInPolygon(anchor, hole))
}

/**
 * 逐剖面线参数组生成线段，返回「零件下标 → 线段」。
 *
 * 同一组参数的多个区域合并成一次调用（`makeGeomHatch` 的线族参数逐组一份）：相邻零件要
 * 方向相反或间距不等（GB/T 4457.5），参数不同的区域天然落在不同组里。
 * @param options - 展开参数。
 * @param matched - 与 `parts` 同序的材料区域（图面毫米）。
 * @param sections - 剖视图输入（读逐零件的剖面线参数）。
 * @returns 零件下标 → 该零件的剖面线段；`hatch: 'none'` 的零件不出现在结果里。
 * @throws SectionSourceError 剖面线参数非法（`invalid_input`）或端口失败时。
 */
async function hatchRegions(
  options: SectionSourceOptions,
  matched: readonly LocatedRegion[],
  sections: SectionFigureJson,
): Promise<Map<number, { from: readonly [number, number]; to: readonly [number, number] }[]>> {
  const groups = new Map<string, { request: { angleDeg: number; spacingMm: number; direction: HatchDirection }; parts: number[] }>()
  sections.parts.forEach((part, index) => {
    const hatch = part.hatch
    if (hatch === 'none') return
    const angleDeg = hatch?.angle_deg ?? DEFAULT_HATCH_ANGLE_DEG
    const spacingMm = hatch?.spacing_mm ?? DEFAULT_HATCH_SPACING_MM
    const direction = hatch?.direction ?? 'forward'
    const key = `${String(angleDeg)}|${String(spacingMm)}|${direction}`
    const known = groups.get(key)
    if (known === undefined) groups.set(key, { request: { angleDeg, spacingMm, direction }, parts: [index] })
    else known.parts.push(index)
  })
  const segmentsByPart = new Map<number, { from: readonly [number, number]; to: readonly [number, number] }[]>()
  for (const group of groups.values()) {
    const groupRegions = group.parts.map(index => matched[index] as LocatedRegion)
    const request = groupRegions.map(region => hatchRequestRegion(region))
    let outcome: SectionHatchOutcome
    try {
      // 参数与轮廓在这里先解析一遍：非法角度/间距在启动子进程之前就报成输入错误，
      // 且与剖面线模块用的是同一套取值域（不另存一份规则）。
      resolveHatchPattern({ regions: request, ...group.request })
      outcome = await options.ports.sectionHatch({ regions: request, ...group.request, ...portContext(options) })
    } catch (error) {
      if (error instanceof HatchGeometryError) throw new SectionSourceError('invalid_input', error.message)
      throw error
    }
    if (!outcome.ok) throw portFailure(outcome, { aborted: '剖面线生成被取消', failed: 'hatch_failed' })
    let cursor = 0
    group.parts.forEach((partIndex, offset) => {
      const count = outcome.geometry.regionCounts[offset] as number
      segmentsByPart.set(
        partIndex,
        outcome.geometry.segments.slice(cursor, cursor + count).map(segment => ({ from: segment.from, to: segment.to })),
      )
      cursor += count
    })
  }
  return segmentsByPart
}

/**
 * 材料区域 → 剖面线模块的区域（外环 + 孔环）。
 * @param region - 已定位的材料区域。
 * @returns 剖面线请求用的区域。
 */
function hatchRequestRegion(region: LocatedRegion): HatchRegion {
  return {
    outline: region.outline,
    ...(region.holes.length === 0 ? {} : { holes: region.holes }),
  }
}

/**
 * 材料区域清单（模型可见提示）：区域数、逐区域净面积与图面范围。
 * @param modelPath - 模型绝对路径。
 * @param regions - 材料区域。
 * @returns 一行提示文本。
 */
function regionInventory(modelPath: string, regions: readonly LocatedRegion[]): string {
  const items = regions.map((region) => {
    const xs = region.outline.map(point => point[0])
    const ys = region.outline.map(point => point[1])
    return `#${String(region.index)} 净面积 ${fmtNumber(region.netAreaMm2)} 毫米²（图面范围 x ${fmtNumber(Math.min(...xs))}–${fmtNumber(Math.max(...xs))}、`
      + `y ${fmtNumber(Math.min(...ys))}–${fmtNumber(Math.max(...ys))}）`
  })
  return `剖切几何：模型 ${basename(modelPath)} 在剖切面上切出 ${String(regions.length)} 个材料区域 —— ${items.join('；')}。`
    + 'parts 按 anchor 逐点匹配区域，标号落点与引线起点用这些图面坐标给出'
}
