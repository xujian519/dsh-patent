/**
 * FreeCAD `freecadcmd` headless 渲染器（子进程通道，CAD 隔离）。
 *
 * 以 `ctx.subprocess.spawn` 调用本机 FreeCAD 的 console 可执行文件，运行
 * {@link buildStructureScript} 生成的 Python 脚本，把 STEP/IGES/BREP 模型投影
 * 为多视图黑白结构线稿 SVG + manifest.json。与 graphviz-renderer 同构：argv
 * 直传（不经 shell）、候选路径解析（Config.freecadExecutable 覆盖 →
 * DSH_FREECAD_CMD env → 各平台常见安装路径 → PATH 分段）、版本探测（probe）与
 * 渲染共享同一解析、SIGTERM→SIGKILL graceMs 一致。
 *
 * 判定只依赖「退出码 0 + manifest.json 存在」：freecadcmd 对
 * `~/Library/Preferences`、`~/Library/Caches` 的写失败仅告警、非致命（本机实测
 * STEP 载入/投影/导出均成功），故 stderr 文本不作为失败依据。子进程 HOME/临时
 * 目录 best-effort 指向 outputDir 内子目录以隔离副作用（Linux 生效；macOS 下
 * FreeCAD 缓存路径不随 HOME 迁移，属已知无害局限）。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-renderer
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  HatchGeometryError,
  parseHatchGeometry,
  resolveHatchPattern,
  type HatchDirection,
  type HatchGeometry,
  type HatchRegion,
  type SectionHatchRequest,
} from './freecad-hatch-geometry.ts'
import { HATCH_GEOMETRY_FILENAME, buildHatchScript } from './freecad-hatch-script.ts'
import {
  SectionGeometryError,
  parseSectionGeometry,
  resolveSectionFrame,
  type SectionGeometry,
  type SectionPlane,
} from './freecad-section-geometry.ts'
import { SECTION_GEOMETRY_FILENAME, buildSectionScript } from './freecad-section-script.ts'
import {
  STRUCTURE_MANIFEST_FILENAME,
  buildStructureScript,
  type StructureScriptParams,
} from './freecad-structure-script.ts'
import {
  describeRenderFailure,
  describeRenderThrow,
  findExecutable,
  quietStdio,
  renderStderr,
  spawnRenderProcess,
  spawnVersionProbe,
  startRenderDeadline,
} from './subprocess-render.ts'

/**
 * FreeCAD `Part.read` 可读的三维模型格式（两个工具共用：结构线稿投影与剖切几何）。
 *
 * 三者的单位语义不同：STEP 在文件头声明单位，IGES/BREP 没有单位声明、按模型自身数值
 * 读入，故 `sections.source` 另用声明尺寸核对图面比例（见 `figure/section-source`）。
 */
export const SUPPORTED_MODEL_EXTENSIONS: readonly string[] = ['.step', '.stp', '.iges', '.igs', '.brep']

/** 各平台常见 FreeCAD console 可执行文件安装路径。 */
export const FREECAD_CMD_CANDIDATES: readonly string[] = [
  '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',
  '/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd',
  '/usr/bin/freecadcmd',
  '/usr/local/bin/freecadcmd',
  '/opt/homebrew/bin/freecadcmd',
  '/snap/bin/freecadcmd',
  'C:\\Program Files\\FreeCAD 1.1\\bin\\FreeCADCmd.exe',
  'C:\\Program Files\\FreeCAD\\bin\\FreeCADCmd.exe',
]

/** 默认单次渲染超时（毫秒；FreeCAD 冷启动比 dot 慢，放宽头寸）；Config.freecadRenderTimeoutMs 的默认值。 */
export const DEFAULT_FREECAD_RENDER_TIMEOUT_MS = 120_000

/**
 * 默认版本探测超时（毫秒；freecadcmd --version 需加载运行时，较 dot -V 慢）；
 * {@link probeFreeCad} 的调用方默认值。宿主插件不探测 freecadcmd，因此该值不是
 * Config 字段。
 */
export const DEFAULT_FREECAD_PROBE_TIMEOUT_MS = 20_000

/** FreeCAD CLI 渲染的部署级选项（宿主 Config → 渲染器）。 */
export type FreeCadRenderOptions = {
  /** freecadcmd 可执行路径覆盖（与 Config.freecadExecutable 同源）；缺省走 {@link findFreeCadCmd} 自动探测。 */
  executable?: string
  /** 单次渲染超时（毫秒）；由宿主 Config.freecadRenderTimeoutMs 解析后注入。 */
  renderTimeoutMs: number
}

/** freecadcmd 版本探测的部署级选项。 */
export type FreeCadProbeOptions = {
  /** freecadcmd 可执行路径覆盖；缺省走 {@link findFreeCadCmd} 自动探测。 */
  executable?: string
  /** 探测超时（毫秒）；宿主插件不探测 freecadcmd，故无对应 Config 字段。 */
  probeTimeoutMs: number
}

/** 渲染脚本临时文件名（写入 outputDir，与 SVG/manifest 同目录）。 */
const STRUCTURE_RENDER_SCRIPT_FILENAME = '.freecad-structure-render.py'

/** 剖切几何脚本临时文件名（写入 outputDir）。 */
const SECTION_RENDER_SCRIPT_FILENAME = '.freecad-section-render.py'

/** 剖面线脚本临时文件名（写入 outputDir）。 */
const HATCH_RENDER_SCRIPT_FILENAME = '.freecad-hatch-render.py'

/** 子进程 HOME/临时目录名（写入 outputDir 内，隔离 FreeCAD 副作用；两条链路共用）。 */
const FREECAD_HOME_DIRNAME = '.freecad-home'

/**
 * 生成 FreeCAD 缺失/路径失效时的安装引导文案。
 * @param executable - 解析到的路径（未找到时为 undefined）。
 * @returns 面向用户的安装与配置引导文本。
 */
export function freecadInstallMessage(executable: string | undefined): string {
  const hint = executable === undefined
    ? '未找到 FreeCAD freecadcmd 可执行文件。'
    : `已配置路径 ${executable} 不存在或不可执行。`
  return [
    hint,
    '结构线稿需要本机安装 FreeCAD 1.1+（macOS：brew install --cask freecad 或官网下载；Ubuntu/Debian：sudo apt install freecad；Windows：官网安装包），',
    '或通过 Config.freecadExecutable / DSH_FREECAD_CMD 指定 freecadcmd 路径。',
  ].join('')
}

/**
 * 解析 freecadcmd 可执行文件路径。
 * @param override - 显式覆盖路径（Config.freecadExecutable）；提供时不存在则视为未找到，不回落自动探测。
 * @returns freecadcmd 可执行文件绝对路径，或 undefined。
 */
export function findFreeCadCmd(override?: string): string | undefined {
  return findExecutable({
    ...(override === undefined ? {} : { override }),
    envVar: 'DSH_FREECAD_CMD',
    candidates: FREECAD_CMD_CANDIDATES,
    names: ['freecadcmd', 'FreeCADCmd', 'freecadcmd.exe', 'FreeCADCmd.exe'],
  })
}

/** 探测结果。 */
export type FreeCadProbeResult = {
  /** FreeCAD 可用（executable 找到且 `freecadcmd --version` 成功）。 */
  ready: boolean
  /** 解析到的可执行路径（未找到时缺省）。 */
  executable?: string
  /** --version 输出的版本号（如 1.1.3）。 */
  version?: string
  /** 未就绪时的安装/配置引导。 */
  message?: string
}

/**
 * 探测 FreeCAD 可用性（执行 `freecadcmd --version`）。
 * @param subprocess - 注入的 subprocess 服务。
 * @param options - freecadcmd 路径覆盖与探测超时。
 * @returns 就绪状态与版本/引导信息。
 */
export async function probeFreeCad(
  subprocess: SubprocessRuntime,
  options: FreeCadProbeOptions,
): Promise<FreeCadProbeResult> {
  const executable = findFreeCadCmd(options.executable)
  if (executable === undefined) {
    return { ready: false, message: freecadInstallMessage(executable) }
  }
  const controller = new AbortController()
  /* v8 ignore start -- probe timer is cleared before its callback can run on a healthy host */
  const timer = setTimeout(() => { controller.abort() }, options.probeTimeoutMs)
  timer.unref()
  /* v8 ignore stop */
  try {
    const { outcome, text } = await spawnVersionProbe(subprocess, executable, '--version', controller.signal)
    if (outcome.exitCode !== 0) {
      return { ready: false, executable, message: `freecadcmd --version 失败（退出码 ${outcome.exitCode ?? '未知'}）：${text.trim()}` }
    }
    const version = text.match(/(\d+\.\d+\.\d+)/)?.[1]
    return { ready: true, executable, ...(version === undefined ? {} : { version }) }
  } catch (error) {
    return { ready: false, executable, message: `freecadcmd --version 调用失败：${errorText(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取可读的错误文本（非 Error 抛出也给出文本）。
 * @param error - 捕获到的值。
 * @returns 错误消息或该值的字符串形式。
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** freecadcmd 解析结果：就绪时的绝对路径，或未安装时的诊断文案。 */
type FreeCadCommandResolution = { ok: true; executable: string } | { ok: false; error: string }

/**
 * 解析 freecadcmd 并给出未安装时的诊断文案（结构投影与剖切几何共用同一探测与文案）。
 * @param options - Config.freecadExecutable 对应的路径覆盖。
 * @returns 就绪时的可执行路径，或未安装的错误文案。
 */
function resolveFreeCadCommand(options: FreeCadRenderOptions): FreeCadCommandResolution {
  const executable = findFreeCadCmd(options.executable)
  if (executable === undefined) return { ok: false, error: freecadInstallMessage(undefined) }
  return { ok: true, executable }
}

/** FreeCAD 脚本执行阶段的错误码（可执行文件已解析之后的失败）。 */
type FreeCadScriptErrorCode = 'render_failed' | 'aborted'

/** 一次 FreeCAD 脚本执行请求（结构投影与剖切几何共用同一段执行逻辑）。 */
type FreeCadScriptRequest = {
  /** 链路名，出现在诊断消息里（如 `FreeCAD 结构投影`）。 */
  tool: string
  /** 输出目录绝对路径（渲染器负责创建）。 */
  outputDir: string
  /** 脚本文件名（写入输出目录）。 */
  scriptFilename: string
  /** 脚本执行成功时应存在的产物文件名。 */
  artifactFilename: string
  /** 产物说明（缺产物时的诊断消息用，如 `manifest`）。 */
  artifactLabel: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/**
 * 把一段 FreeCAD Python 脚本交给 freecadcmd 执行，按「退出码 0 + 产物存在」判定成功。
 *
 * 结构投影与剖切几何共用这一段：创建隔离目录 → 写脚本 → spawn `freecadcmd <script.py>`
 * （cwd = 输出目录，HOME/临时/缓存指向输出目录内的隔离目录）→ 按退出码与产物存在判定。
 * 隔离目录必须包含可写的临时目录：实测（FreeCAD 1.1.3）`TMPDIR` 指向不存在的路径时，
 * freecadcmd 会先于脚本 SIGSEGV，stdout/stderr 全空、退出码为 null，故这里先建目录再 spawn。
 *
 * stderr 的配置/转码告警非致命（实测），不参与判定；失败分类沿用
 * {@link describeRenderFailure} 与 {@link describeRenderThrow}。
 * @param subprocess - 注入的 subprocess 服务。
 * @param executable - 已解析的 freecadcmd 绝对路径。
 * @param request - 链路名、输出目录、脚本与产物文件名、调用方取消信号。
 * @param script - 要执行的 Python 源码。
 * @param options - 渲染超时。
 * @returns 成功（产物已生成）或分类错误。
 */
async function runFreeCadScript(
  subprocess: SubprocessRuntime,
  executable: string,
  request: FreeCadScriptRequest,
  script: string,
  options: FreeCadRenderOptions,
): Promise<{ ok: true } | { ok: false; code: FreeCadScriptErrorCode; error: string }> {
  const homeDir = join(request.outputDir, FREECAD_HOME_DIRNAME)
  const scriptPath = join(request.outputDir, request.scriptFilename)
  const artifactPath = join(request.outputDir, request.artifactFilename)
  try {
    mkdirSync(request.outputDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    // 同步写入脚本（体积小）：使 spawn 前的准备全部同步完成，超时计时器与
    // 子进程启动之间无 await，保证 abort 能命中已启动的子进程。
    writeFileSync(scriptPath, script, 'utf8')
  } catch (error) {
    return { ok: false, code: 'render_failed', error: `准备 FreeCAD 脚本失败：${errorText(error)}` }
  }
  const deadline = startRenderDeadline(options.renderTimeoutMs, request.signal)
  try {
    const { handle, outcome } = await spawnRenderProcess(subprocess, deadline, {
      argv: [executable, scriptPath],
      cwd: request.outputDir,
      stdio: quietStdio(),
      // 隔离 FreeCAD 副作用：HOME/临时/缓存指向 outputDir 内子目录（best-effort）。
      env: {
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, '.config'),
        XDG_CACHE_HOME: join(homeDir, '.cache'),
        XDG_DATA_HOME: join(homeDir, '.local'),
        TEMP: homeDir,
        TMP: homeDir,
        TMPDIR: homeDir,
      },
    })
    if (outcome.exitCode !== 0) {
      const cause = describeRenderFailure(outcome, deadline.timedOut(), request.signal)
      return {
        ok: false,
        code: request.signal?.aborted === true ? 'aborted' : 'render_failed',
        error: `${request.tool}失败（${cause}）：${renderStderr(handle) || '无 stderr 输出'}`,
      }
    }
    if (!existsSync(artifactPath)) {
      return { ok: false, code: 'render_failed', error: `${request.tool}未生成 ${request.artifactLabel}：${artifactPath}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, ...describeRenderThrow(request.tool, error, request.signal) }
  } finally {
    deadline.dispose()
  }
}

/** 渲染错误码（与 graphviz-renderer 同形）。 */
export type StructureRenderErrorCode = 'not_installed' | 'render_failed' | 'aborted'

/** 渲染结果：成功 manifest 路径或分类错误（与 GraphvizRenderOutcome 同形）。 */
export type StructureRenderOutcome =
  | { ok: true; manifestPath: string }
  | { ok: false; code: StructureRenderErrorCode; error: string }

/**
 * 结构线稿渲染请求：{@link StructureScriptParams} 的全部字段加上调用方取消信号。
 *
 * 渲染器把这个请求原样交给 `buildStructureScript`，故两者共用同一份字段定义——
 * 多一份复制品只会让「脚本读什么」与「渲染器收什么」各自漂移。
 */
export type StructureRenderSpec = StructureScriptParams & {
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/**
 * 用 FreeCAD headless 把一个或多个模型投影为多视图结构线稿 SVG + manifest.json。
 *
 * 流程：解析可执行文件 → 构建脚本 → {@link runFreeCadScript} 执行（退出码 + manifest
 * 存在判定成功）。stderr 的 cfg/transcoder 告警非致命（实测），不参与判定。
 * @param subprocess - 注入的 subprocess 服务。
 * @param spec - 渲染请求。
 * @param options - freecadcmd 路径覆盖与渲染超时。
 * @returns 成功 manifest 路径或分类错误（not_installed / render_failed / aborted）。
 */
export async function renderStructureViews(
  subprocess: SubprocessRuntime,
  spec: StructureRenderSpec,
  options: FreeCadRenderOptions,
): Promise<StructureRenderOutcome> {
  const command = resolveFreeCadCommand(options)
  if (!command.ok) return { ok: false, code: 'not_installed', error: command.error }
  const script = buildStructureScript(spec)
  const result = await runFreeCadScript(subprocess, command.executable, {
    tool: 'FreeCAD 结构投影',
    outputDir: spec.outputDir,
    scriptFilename: STRUCTURE_RENDER_SCRIPT_FILENAME,
    artifactFilename: STRUCTURE_MANIFEST_FILENAME,
    artifactLabel: 'manifest',
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
  }, script, options)
  if (!result.ok) return result
  return { ok: true, manifestPath: join(spec.outputDir, STRUCTURE_MANIFEST_FILENAME) }
}

/** 剖切几何请求。 */
export type SectionGeometrySpec = {
  /** 模型文件绝对路径（STEP/IGES/BREP）。 */
  modelPath: string
  /** 剖切平面（平面内一点、法向、可选的图面「向右」参考方向）。 */
  plane: SectionPlane
  /** 输出目录绝对路径（渲染器负责创建）。 */
  outputDir: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/** 剖切几何错误码（与结构投影同形，产物不同故 `render_failed` 记作 `geometry_failed`）。 */
type SectionRenderErrorCode = 'not_installed' | 'geometry_failed' | 'aborted'

/** 剖切几何结果：成功时的几何或分类错误。 */
export type SectionGeometryOutcome =
  | { ok: true; geometry: SectionGeometry }
  | { ok: false; code: SectionRenderErrorCode; error: string }

/**
 * 用 FreeCAD headless 取出剖切平面的闭合轮廓（不需要 Document/Page/模板）。
 *
 * 流程与 {@link renderStructureViews} 同构：解析可执行文件 → 解析视图帧并构建脚本
 * （平面参数非法时不启动子进程）→ {@link runFreeCadScript} 执行 → 解析产物并按面积核对。
 * 面积核对不通过同样归入 `geometry_failed`，不交出几何。
 * @param subprocess - 注入的 subprocess 服务。
 * @param spec - 剖切请求。
 * @param options - freecadcmd 路径覆盖与渲染超时。
 * @returns 成功时的几何或分类错误。
 */
export async function renderSectionGeometry(
  subprocess: SubprocessRuntime,
  spec: SectionGeometrySpec,
  options: FreeCadRenderOptions,
): Promise<SectionGeometryOutcome> {
  const command = resolveFreeCadCommand(options)
  if (!command.ok) return { ok: false, code: 'not_installed', error: command.error }
  const geometryPath = join(spec.outputDir, SECTION_GEOMETRY_FILENAME)
  let script: string
  try {
    // 视图帧在这里解析：平面参数非法时不启动子进程。
    script = buildSectionScript({
      modelPath: spec.modelPath,
      frame: resolveSectionFrame(spec.plane),
      outputDir: spec.outputDir,
    })
  } catch (error) {
    return { ok: false, code: 'geometry_failed', error: errorText(error) }
  }
  const result = await runFreeCadScript(subprocess, command.executable, {
    tool: 'FreeCAD 剖切几何',
    outputDir: spec.outputDir,
    scriptFilename: SECTION_RENDER_SCRIPT_FILENAME,
    artifactFilename: SECTION_GEOMETRY_FILENAME,
    artifactLabel: '剖切几何',
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
  }, script, options)
  if (!result.ok) {
    return { ok: false, code: result.code === 'aborted' ? 'aborted' : 'geometry_failed', error: result.error }
  }
  try {
    return { ok: true, geometry: parseSectionGeometry(readFileSync(geometryPath, 'utf8')) }
  } catch (error) {
    if (error instanceof SectionGeometryError) return { ok: false, code: 'geometry_failed', error: error.message }
    return { ok: false, code: 'geometry_failed', error: `剖切几何产物不可用（${geometryPath}）：${errorText(error)}` }
  }
}

/** 剖面线请求。 */
export type SectionHatchSpec = {
  /** 要打剖面线的材料区域（视图帧毫米；外环 + 其孔环）。 */
  regions: readonly HatchRegion[]
  /** 与图面水平线的夹角（度）；取值域 (0, 90]（与 `HatchSpec` 同口径）。 */
  angleDeg: number
  /** 相邻剖面线的垂直间距（毫米）。 */
  spacingMm: number
  /** 方向；缺省 'forward'。 */
  direction?: HatchDirection
  /** 输出目录绝对路径（渲染器负责创建）。 */
  outputDir: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/** 剖面线错误码（与剖切几何同形，产物不同故 `render_failed` 记作 `hatch_failed`）。 */
type SectionHatchErrorCode = 'not_installed' | 'hatch_failed' | 'aborted'

/** 剖面线结果：成功时的线段或分类错误。 */
export type SectionHatchOutcome =
  | { ok: true; geometry: HatchGeometry }
  | { ok: false; code: SectionHatchErrorCode; error: string }

/**
 * 用 FreeCAD headless 在视图帧里为材料区域生成剖面线（不需要 Document/Page/模板）。
 *
 * 流程与 {@link renderSectionGeometry} 同构：解析可执行文件 → 解析请求并构建脚本（角度、间距、
 * 区域非法时不启动子进程）→ {@link runFreeCadScript} 执行 → 解析产物并核对取向、间距与落点。
 * 任一核对不通过都归入 `hatch_failed`，不交出线段。
 *
 * 面由传入的区域网格点重建，故线段端点落在画出来的轮廓线上；孔环一并成面，孔里不会被打上剖面线。
 * @param subprocess - 注入的 subprocess 服务。
 * @param spec - 剖面线请求。
 * @param options - freecadcmd 路径覆盖与渲染超时。
 * @returns 成功时的剖面线段或分类错误。
 */
export async function renderSectionHatch(
  subprocess: SubprocessRuntime,
  spec: SectionHatchSpec,
  options: FreeCadRenderOptions,
): Promise<SectionHatchOutcome> {
  const command = resolveFreeCadCommand(options)
  if (!command.ok) return { ok: false, code: 'not_installed', error: command.error }
  const request: SectionHatchRequest = {
    regions: spec.regions,
    angleDeg: spec.angleDeg,
    spacingMm: spec.spacingMm,
    ...(spec.direction === undefined ? {} : { direction: spec.direction }),
  }
  const hatchPath = join(spec.outputDir, HATCH_GEOMETRY_FILENAME)
  let script: string
  try {
    // 请求在这里解析：参数非法时不启动子进程。
    script = buildHatchScript({
      pattern: resolveHatchPattern(request),
      regions: request.regions,
      outputDir: spec.outputDir,
    })
  } catch (error) {
    return { ok: false, code: 'hatch_failed', error: errorText(error) }
  }
  const result = await runFreeCadScript(subprocess, command.executable, {
    tool: 'FreeCAD 剖面线',
    outputDir: spec.outputDir,
    scriptFilename: HATCH_RENDER_SCRIPT_FILENAME,
    artifactFilename: HATCH_GEOMETRY_FILENAME,
    artifactLabel: '剖面线几何',
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
  }, script, options)
  if (!result.ok) {
    return { ok: false, code: result.code === 'aborted' ? 'aborted' : 'hatch_failed', error: result.error }
  }
  try {
    return { ok: true, geometry: parseHatchGeometry(readFileSync(hatchPath, 'utf8'), request) }
  } catch (error) {
    if (error instanceof HatchGeometryError) return { ok: false, code: 'hatch_failed', error: error.message }
    return { ok: false, code: 'hatch_failed', error: `剖面线产物不可用（${hatchPath}）：${errorText(error)}` }
  }
}
