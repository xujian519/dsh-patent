/**
 * 结构线稿的输入归一与模型文件 I/O：件号锚点/放大窗口校验、模型或目录展开、
 * 渲染 manifest 读取与视图 SVG 校验。
 * @module @deepseek-ai/dsh-patent-tools/tool/structure-model
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { PatentToolError } from '../error.ts'
import { SUPPORTED_MODEL_EXTENSIONS } from '../figure/freecad-renderer.ts'
import { STRUCTURE_VIEWS } from '../figure/freecad-structure-script.ts'
import { DEFAULT_SVG_MAX_BYTES, assertSafeSvg } from '../figure/svg-annotate.ts'
import { DEFAULT_DETAIL_SCALE } from './structure-types.ts'
import type {
  GenerateStructureFigureInput,
  StructureCalloutInput,
  StructureDetailInput,
  StructureManifest,
  StructureManifestView,
  StructureViewName,
} from './structure-types.ts'
import type { StructureDetail } from '../figure/freecad-structure-script.ts'

/**
 * 校验并归一件号锚定：point3d 必须是恰好三个有限数。
 * @param callouts - 模型给出的件号锚定点，可省略。
 * @returns 原样返回的已校验锚点。
 */
export function normalizeCallouts(callouts: readonly StructureCalloutInput[] | undefined): StructureCalloutInput[] {
  return (callouts ?? []).map((callout, index) => {
    const point = callout.point3d
    // 省略 point3d 表示由渲染脚本在该零件上自动选锚点，没有可校验的坐标。
    if (point === undefined) return callout
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- 声明类型是三元组，但模型实参只经 schema 校验为 number[]，长度必须运行时复核
    if (point.length !== 3 || point.some(n => !Number.isFinite(n))) {
      throw new PatentToolError('invalid_tool_input', `callouts[${index}].point3d 必须是恰好三个有限数 [x,y,z]`, { tool: 'generate_structure_figure' })
    }
    return callout
  })
}

/**
 * 校验并归一局部放大视图。schema 只约束 JSON 形状，模型实参在这里复核：
 * 基视图必须是本次渲染的视图（否则窗口无处落）、圆心必须恰好三个有限数、
 * 半径与倍数必须正有限。
 * @param details - the model-supplied detail entries.
 * @param views - the resolved view list the details must point into.
 * @returns normalized details handed to the projection script.
 * @throws PatentToolError when a value is out of range or the base view is not rendered.
 */
export function normalizeDetails(
  details: readonly StructureDetailInput[] | undefined,
  views: readonly StructureViewName[],
): StructureDetail[] {
  return (details ?? []).map((detail, index) => {
    const base = views.find(view => view === detail.base)
    if (base === undefined) {
      throw new PatentToolError('invalid_tool_input', `details[${index}].base 必须是本次渲染的视图之一（${views.join('、')}），收到 "${detail.base}"`, { tool: 'generate_structure_figure' })
    }
    const center = detail.center
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- 声明类型是三元组，但模型实参只经 schema 校验为 number[]，长度必须运行时复核
    if (center.length !== 3 || center.some(n => !Number.isFinite(n))) {
      throw new PatentToolError('invalid_tool_input', `details[${index}].center 必须是恰好三个有限数 [x,y,z]`, { tool: 'generate_structure_figure' })
    }
    // 半径与倍数是模型 JSON 或部署缺省：schema 只约束为 number，正有限性必须在此 fail-loud。
    if (!Number.isFinite(detail.radius_mm) || detail.radius_mm <= 0) {
      throw new PatentToolError('invalid_tool_input', `details[${index}].radius_mm 必须是正有限数，收到 ${String(detail.radius_mm)}`, { tool: 'generate_structure_figure' })
    }
    const scale = detail.scale ?? DEFAULT_DETAIL_SCALE
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new PatentToolError('invalid_tool_input', `details[${index}].scale 必须是正有限数，收到 ${String(detail.scale)}`, { tool: 'generate_structure_figure' })
    }
    return { base, center, radiusMm: detail.radius_mm, scale, reference: detail.reference ?? String(index + 1) }
  })
}

/**
 * 校验并归一视图列表（非空、全部属于 STRUCTURE_VIEWS，去重保序）。
 * @param views - 请求的视图；缺省或空列表取 fallback。
 * @param fallback - 部署缺省视图。
 * @returns 去重后的视图列表。
 */
export function normalizeViews(views: readonly string[] | undefined, fallback: readonly StructureViewName[]): StructureViewName[] {
  const requested = views === undefined || views.length === 0 ? fallback : views
  const seen = new Set<StructureViewName>()
  for (const view of requested) {
    /* v8 ignore start -- the tool schema's enum rejects unknown views before execute; this guard serves standalone callers */
    if (!(STRUCTURE_VIEWS as readonly string[]).includes(view)) {
      throw new PatentToolError('invalid_tool_input', `不支持的视图 "${view}"；可选：${STRUCTURE_VIEWS.join('、')}`, { tool: 'generate_structure_figure' })
    }
    /* v8 ignore stop */
    seen.add(view as StructureViewName)
  }
  if (seen.size === 0) {
    throw new PatentToolError('invalid_tool_input', '视图列表不能为空', { tool: 'generate_structure_figure' })
  }
  return [...seen]
}

/**
 * 解析一个模型文件路径：复核它存在、是文件、扩展名受支持，返回绝对路径。
 *
 * `model_path` 的单文件与 `model_paths` 的每个文件共用这一段——两处各写一遍必然
 * 在报错文本和收口的格式上漂移。`field` 是报错里回给模型的下标化字段名。
 * @param modelPath - the model-supplied path.
 * @param cwd - the working directory for relative paths.
 * @param field - 字段名（`model_path`，或 `model_paths[0]` 这样带下标的写法）。
 * @returns 模型文件的绝对路径。
 * @throws PatentToolError when the path is missing (file_not_found) or is not a supported file.
 */
async function resolveModelFile(modelPath: string, cwd: string, field: string): Promise<string> {
  const absolute = resolve(cwd, modelPath)
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined) {
    throw new PatentToolError('file_not_found', `${field} 不存在：${modelPath}`, { tool: 'generate_structure_figure' })
  }
  if (!info.isFile()) {
    throw new PatentToolError('invalid_tool_input', `${field} 不是文件：${modelPath}`, { tool: 'generate_structure_figure' })
  }
  if (!SUPPORTED_MODEL_EXTENSIONS.includes(extname(absolute).toLowerCase())) {
    throw new PatentToolError('invalid_tool_input', `${field} 的格式不受支持 "${extname(absolute)}"；可选：${SUPPORTED_MODEL_EXTENSIONS.join('、')}`, { tool: 'generate_structure_figure' })
  }
  return absolute
}

/** 解析 model_path：文件（单模型）或目录（批量），返回受支持模型的绝对路径列表（升序）。 */
async function resolveModelPaths(modelPath: string, cwd: string): Promise<string[]> {
  const absolute = resolve(cwd, modelPath)
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined) {
    throw new PatentToolError('file_not_found', `模型路径不存在：${modelPath}`, { tool: 'generate_structure_figure' })
  }
  if (info.isFile()) return [await resolveModelFile(modelPath, cwd, 'model_path')]
  if (!info.isDirectory()) {
    throw new PatentToolError('invalid_tool_input', `model_path 既不是文件也不是目录：${modelPath}`, { tool: 'generate_structure_figure' })
  }
  const entries = await readdir(absolute)
  const models = entries
    .filter(name => SUPPORTED_MODEL_EXTENSIONS.includes(extname(name).toLowerCase()))
    .sort()
    .map(name => join(absolute, name))
  if (models.length === 0) {
    throw new PatentToolError('invalid_tool_input', `目录内未找到受支持模型（${SUPPORTED_MODEL_EXTENSIONS.join('、')}）：${modelPath}`, { tool: 'generate_structure_figure' })
  }
  return models
}

/**
 * 解析装配体输入（`model_paths`）：逐个文件复核存在、受支持且不重复，返回绝对路径。
 *
 * 保持给定顺序：`callouts[].model` 的下标口径就是这个顺序，重排会让件号指错零件。
 * 不接受目录——目录语义已经是「逐模型出多张图」（见 {@link resolveModelPaths}），
 * 两种语义共用一个入参只会让调用方猜。
 * @param paths - the model-supplied file paths.
 * @param cwd - the working directory for relative paths.
 * @returns 绝对路径列表（与入参同序）。
 * @throws PatentToolError when the list is empty, a path is missing/not a file/unsupported, or repeats.
 */
async function resolveAssemblyPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  if (paths.length === 0) {
    throw new PatentToolError('invalid_tool_input', 'model_paths 不能为空：装配体至少要有一个模型文件', { tool: 'generate_structure_figure' })
  }
  const resolved: string[] = []
  for (const [index, modelPath] of paths.entries()) {
    const absolute = await resolveModelFile(modelPath, cwd, `model_paths[${index}]`)
    if (resolved.includes(absolute)) {
      throw new PatentToolError('invalid_tool_input', `model_paths[${index}] 与前面的模型重复：${modelPath}`, { tool: 'generate_structure_figure' })
    }
    resolved.push(absolute)
  }
  return resolved
}

/**
 * 解析模型输入：`model_path`（单文件或目录批量）与 `model_paths`（装配体）二选一。
 * @param input - the model-supplied arguments.
 * @param cwd - the working directory for relative paths.
 * @returns 绝对路径列表与「是否装配体（多文件投影成一张图）」。
 * @throws PatentToolError when neither or both are given, or a path is missing/unsupported/duplicated.
 */
export async function resolveStructureModels(
  input: GenerateStructureFigureInput,
  cwd: string,
): Promise<{ modelPaths: string[]; assembly: boolean }> {
  if (input.model_path !== undefined && input.model_paths !== undefined) {
    throw new PatentToolError('invalid_tool_input', 'model_path 与 model_paths 二选一：model_path 是单模型或目录批量，model_paths 是装配体（多文件投影成一张图）', { tool: 'generate_structure_figure' })
  }
  if (input.model_paths !== undefined) {
    return { modelPaths: await resolveAssemblyPaths(input.model_paths, cwd), assembly: true }
  }
  if (input.model_path === undefined) {
    throw new PatentToolError('invalid_tool_input', '必须给 model_path（单模型/目录批量）或 model_paths（装配体）', { tool: 'generate_structure_figure' })
  }
  return { modelPaths: await resolveModelPaths(input.model_path, cwd), assembly: false }
}

/**
 * 解析并轻校验 manifest.json（渲染产物契约；非法 JSON 同样归入 tool_execution_failed）。
 * @param manifestPath - 渲染器返回的 manifest 绝对路径。
 * @returns 至少包含一个视图的 manifest。
 */
export async function readManifest(manifestPath: string): Promise<StructureManifest> {
  let parsed: StructureManifest
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as StructureManifest
  } catch (error) {
    /* v8 ignore next -- readFile and JSON.parse only reject with Error values */
    throw new PatentToolError('tool_execution_failed', `读取 manifest 失败：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_structure_figure' })
  }
  if (!Array.isArray(parsed.views) || parsed.views.length === 0) {
    throw new PatentToolError('tool_execution_failed', 'manifest 未包含任何视图（渲染可能未产生投影几何）', { tool: 'generate_structure_figure' })
  }
  for (const view of parsed.views) assertManifestParts(view, parsed.modelPaths)
  for (const view of parsed.views) {
    if (view.warnings === undefined) continue
    if (!Array.isArray(view.warnings) || !view.warnings.every(note => typeof note === 'string')) {
      throw new PatentToolError('tool_execution_failed', `manifest 视图 ${view.name} 的 warnings 必须是字符串数组`, { tool: 'generate_structure_figure' })
    }
  }
  return parsed
}

/** 有限数判断（manifest 是脚本产物，数值合法性只在读回时核对一次）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 核对一个视图的逐零件几何事实。
 *
 * `parts` 是渲染脚本写出、随 FreeCAD 版本与模型变化的产物，索引越界或数值非法
 * 都会让下游引线布局算错位置，故在读回这一处 fail-loud。旧版 manifest 没有
 * `parts` 字段，缺失即跳过（调用方据 `assembly` 是否给出决定可用性）。
 * @param view - 待核对视图。
 * @param modelPaths - 本次渲染的模型文件列表（`index` 的合法上界）。
 */
function assertManifestParts(view: StructureManifestView, modelPaths: readonly string[]): void {
  if (view.parts === undefined) return
  const where = `manifest 视图 ${view.name} 的 parts`
  if (!Array.isArray(view.parts)) {
    throw new PatentToolError('tool_execution_failed', `${where} 不是数组`, { tool: 'generate_structure_figure' })
  }
  for (const part of view.parts) {
    if (!Number.isInteger(part.index) || part.index < 0 || part.index >= modelPaths.length) {
      throw new PatentToolError('tool_execution_failed', `${where} 含非法零件下标 ${String(part.index)}（模型共 ${String(modelPaths.length)} 个）`, { tool: 'generate_structure_figure' })
    }
    if (!Array.isArray(part.bbox3d) || part.bbox3d.length !== 6 || !part.bbox3d.every(isFiniteNumber)) {
      throw new PatentToolError('tool_execution_failed', `${where} 的零件 ${String(part.index)} bbox3d 必须是六个有限数`, { tool: 'generate_structure_figure' })
    }
    if (!isFiniteNumber(part.volume)) {
      throw new PatentToolError('tool_execution_failed', `${where} 的零件 ${String(part.index)} volume 不是有限数`, { tool: 'generate_structure_figure' })
    }
    if (part.bounds !== null && (!Array.isArray(part.bounds) || part.bounds.length !== 4 || !part.bounds.every(isFiniteNumber))) {
      throw new PatentToolError('tool_execution_failed', `${where} 的零件 ${String(part.index)} bounds 必须是 null 或四个有限数`, { tool: 'generate_structure_figure' })
    }
  }
}

/**
 * 逐视图读回 SVG 并过安全校验（拒绝 ENTITY/CDATA、大小上限、根元素）。
 * @param manifest - 已解析的渲染 manifest。
 */
export async function assertViewSvgs(manifest: StructureManifest): Promise<void> {
  for (const view of manifest.views) {
    let text: string
    try {
      text = await readFile(view.path, 'utf8')
    } catch (error) {
      /* v8 ignore next -- readFile only rejects with Error values */
      throw new PatentToolError('tool_execution_failed', `读取视图 ${view.name} SVG 失败：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_structure_figure' })
    }
    try {
      assertSafeSvg(text, DEFAULT_SVG_MAX_BYTES)
    } catch (error) {
      /* v8 ignore next -- assertSafeSvg only throws SvgAnnotateError values */
      throw new PatentToolError('tool_execution_failed', `视图 ${view.name} SVG 校验失败：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_structure_figure' })
    }
  }
}
