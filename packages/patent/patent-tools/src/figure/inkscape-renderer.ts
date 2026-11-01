/**
 * Inkscape `inkscape` CLI 的两项子进程能力：SVG 的文字转路径（可选加固），以及把
 * 已完成的 SVG 按页面导出为 png/pdf（固定幅面交付用）。
 *
 * 为什么需要文字转路径：本包的两条绘图通路（自绘 SVG 片段与 Graphviz DOT）都不声明
 * `font-family`，图形里的 `<text>` 由阅读器挑字体渲染——换一台没有中文字体的机器
 * （或印厂、审查端）就可能出豆腐块、字宽错位。开启后文字成为路径，字与画一起
 * 走矢量，任何渲染器都一样。
 *
 * 为什么需要格式导出：落版、渲染复核与文字转路径都只作用于 SVG，而交付常用 png/pdf。
 * 让 png/pdf 也经过 SVG，这三步才对非 SVG 生效。
 *
 * 调用形状：argv 直传（不经 shell），输入按路径读（Inkscape 不改写输入文件）、
 * 输出写临时目录；文字转路径的产物按三个门槛放行后才替换原文件——过 {@link assertSafeSvg}、
 * 已无 `<text>`、且墨迹仍落在原图范围内（{@link geometryRegression}）——失败时原文件
 * 一字不改。写回用 {@link writeFileAtomic}（同目录临时文件 + rename），故读取方看到
 * 的要么是原图、要么是完整的转换产物。期限、取消与失败归类与 graphviz-renderer 共用
 * subprocess-render。
 *
 * 导出始终按**页面**范围（`--export-area-page`）：落版后的附图页就是幅面本身，
 * 按图形范围裁切会丢掉页边距。
 * @module @deepseek-ai/dsh-patent-tools/figure/inkscape-renderer
 */

import { existsSync } from 'node:fs'
import { formatMm as fmtMm } from './mm-primitives.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { measureInkBounds } from './render-check.ts'
import type { InkBounds } from './render-check.ts'
import {
  describeRenderFailure,
  describeRenderThrow,
  findExecutable,
  quietStdio,
  renderStderr,
  spawnRenderProcess,
  startRenderDeadline,
} from './subprocess-render.ts'
import type { RenderDeadline, SubprocessSpawner } from './subprocess-render.ts'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DEFAULT_SVG_MAX_BYTES, SvgAnnotateError, assertSafeSvg } from './svg-annotate.ts'

/** 各平台常见 Inkscape 可执行路径。 */
export const INKSCAPE_CANDIDATES: readonly string[] = [
  '/opt/homebrew/bin/inkscape',
  '/usr/local/bin/inkscape',
  '/usr/bin/inkscape',
  '/snap/bin/inkscape',
  '/Applications/Inkscape.app/Contents/MacOS/inkscape',
  'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
  'C:\\Program Files (x86)\\Inkscape\\bin\\inkscape.exe',
]

/** 默认单次转换超时（毫秒）；Config.inkscapeRenderTimeoutMs 的默认值。 */
export const DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS = 30_000

/**
 * 文字元素开标签：转换后的产物里出现它，说明文字没有转成路径。带命名空间前缀的
 * `<svg:text>` 与 `<textPath>` 同样算残留；注释里的示例文本不算。
 */
const TEXT_ELEMENT_PATTERN = /<(?:[\w.-]+:)?(?:text|textPath)[\s/>]/i

/**
 * 几何护栏的容差（毫米）：轮廓路径的墨迹允许比原图多出这么多——字形轮廓与占位框
 * 估算的差异（全角字上缘约 0.5 毫米）在这个量级内，而漏掉图层、坐标整体错位的差异
 * 远大于此。
 */
const OUTLINE_GEOMETRY_SLACK_MM = 1

/**
 * 几何护栏的容差相对墨迹跨度的比例：占位框的估算误差随字形实际尺寸等比放大，落版页
 * 会把图形放大数倍（本机实测：A4 附图页上的中文轮廓比占位框外扩 1.1 毫米），固定毫米
 * 容差在小图上够用、在落版页上会误报。整体错位是数十毫米量级，比例项不会削弱它。
 */
const OUTLINE_GEOMETRY_SLACK_RATIO = 0.01

/** Inkscape 转换的部署级选项（宿主 Config → 渲染器）。 */
type InkscapeOutlineOptions = {
  /** Inkscape 可执行路径覆盖（与 Config.inkscapeExecutable 同源）；缺省走 {@link findInkscape} 自动探测。 */
  executable?: string
  /** 单次转换超时（毫秒）；由宿主 Config.inkscapeRenderTimeoutMs 解析后注入。 */
  renderTimeoutMs: number
}

/** 转换请求：就地改写这个 SVG 文件。 */
export type InkscapeOutlineSpec = {
  /** 待转换的 SVG 绝对路径（转换成功后原地替换）。 */
  path: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/** 转换错误码（与两个渲染器同形，工具层按同一张表映射）。 */
type InkscapeOutlineErrorCode = 'not_installed' | 'render_failed' | 'aborted'

/** 转换结果：成功，或按码分类的失败。 */
export type InkscapeOutlineOutcome =
  | { ok: true }
  | { ok: false; code: InkscapeOutlineErrorCode; error: string }

/**
 * 文字转路径端口：宿主按 Config.figureTextToPath 注入（不开启时不接线），
 * 附图生成工具只依赖这个签名，不直接依赖 Inkscape。
 */
export type OutlineTextPort = (spec: InkscapeOutlineSpec) => Promise<InkscapeOutlineOutcome>

/** 导出目标格式（Inkscape `--export-type` 的取值）。 */
export type InkscapeExportFormat = 'png' | 'pdf'

/** 导出请求：把一个已完成的附图 SVG 转成位图或 PDF。 */
export type InkscapeExportSpec = {
  /** 源 SVG 绝对路径（导出不改写它）。 */
  path: string
  /** 目标文件绝对路径；其扩展名须与 {@link format} 一致。 */
  outcomePath: string
  /** 目标格式。 */
  format: InkscapeExportFormat
  /** 栅格分辨率（png 生效）；缺省用 Inkscape 的默认分辨率。 */
  dpi?: number
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/**
 * 格式导出端口：宿主注入（没有 Inkscape 时返回 `not_installed`），附图生成工具只依赖
 * 这个签名。与 {@link OutlineTextPort} 分开是因为触发条件不同——文字转路径是可选加固，
 * 格式导出是非 SVG 交付的必经一步。
 */
export type ExportFigurePort = (spec: InkscapeExportSpec) => Promise<InkscapeOutlineOutcome>

/**
 * 生成 Inkscape 缺失/路径失效时的安装引导文案。
 * @param executable - 解析到的路径（未找到时为 undefined）。
 * @returns 面向用户的安装与配置引导文本。
 */
export function inkscapeInstallMessage(executable: string | undefined): string {
  const hint = executable === undefined
    ? '未找到 Inkscape 可执行文件。'
    : `已配置路径 ${executable} 不存在或不可执行。`
  return [
    hint,
    '文字转路径需要 Inkscape（macOS：brew install --cask inkscape；Ubuntu/Debian：sudo apt install inkscape；Windows：winget install Inkscape.Inkscape），',
    '或通过 Config.inkscapeExecutable / DSH_INKSCAPE 指定可执行文件路径；不需要字体无关的 SVG 时把 Config.figureTextToPath 关掉即可。',
  ].join('')
}

/**
 * 解析 Inkscape 可执行文件路径。
 * @param override - 显式覆盖路径（Config.inkscapeExecutable）；提供时不存在则视为未找到，不回落自动探测。
 * @returns 可执行文件绝对路径，或 undefined。
 */
export function findInkscape(override?: string): string | undefined {
  return findExecutable({
    ...(override === undefined ? {} : { override }),
    envVar: 'DSH_INKSCAPE',
    candidates: INKSCAPE_CANDIDATES,
    names: ['inkscape', 'inkscape.exe'],
  })
}

/**
 * 转换产物的几何护栏：逐边比较转换前后的墨迹包围盒。
 *
 * 转路径只该把 `<text>` 换成字形轮廓，图面范围不应变化；Inkscape 版本差异（整层丢失、
 * 坐标错位、画布被改写）会在这里暴露，宁可失败也不交出一张走样的附图。只判「向外越界」：
 * 文字占位框本就是上界，字形轮廓比它略小是正常的，故向内收缩不作为拒收依据。
 * @param before - 转换前的 SVG 文本。
 * @param outlined - 转换产物文本。
 * @returns 违规说明；几何一致时 undefined。
 */
function geometryRegression(before: string, outlined: string): string | undefined {
  const original = measureInkBounds(before)
  const converted = measureInkBounds(outlined)
  if (converted === undefined) {
    return original === undefined ? undefined : '转换产物里没有可量测的图形'
  }
  if (original === undefined) return undefined
  const slack = OUTLINE_GEOMETRY_SLACK_MM
    + OUTLINE_GEOMETRY_SLACK_RATIO * Math.max(original.maxX - original.minX, original.maxY - original.minY)
  const outside = (['minX', 'minY'] as const).some(
    side => converted[side] < original[side] - slack,
  ) || (['maxX', 'maxY'] as const).some(
    side => converted[side] > original[side] + slack,
  )
  if (!outside) return undefined
  const range = (box: InkBounds): string =>
    `(${fmtMm(box.minX)}, ${fmtMm(box.minY)})-(${fmtMm(box.maxX)}, ${fmtMm(box.maxY)})`
  return `转换产物的墨迹范围 ${range(converted)} 超出原图 ${range(original)}`
}

/**
 * 解析 Inkscape 可执行文件。
 * @param options - 路径覆盖与超时（只用其中的路径覆盖）。
 * @returns 可执行路径，或 `not_installed` 的分类失败。
 */
function resolveInkscape(options: InkscapeOutlineOptions): { ok: true; executable: string } | { ok: false; code: 'not_installed'; error: string } {
  const executable = findInkscape(options.executable)
  return executable === undefined
    ? { ok: false, code: 'not_installed', error: inkscapeInstallMessage(undefined) }
    : { ok: true, executable }
}

/**
 * 子进程退出码非零时的失败归类。
 * @param args - the finished spawn plus the deadline, signal, captured handle, and label that classify it.
 * @returns 分类失败；退出码为 0 时 undefined。
 */
function inkscapeExitFailure(args: {
  outcome: SubprocessOutcome
  deadline: RenderDeadline
  signal: AbortSignal | undefined
  handle: SubprocessHandle
  label: string
}): { ok: false; code: InkscapeOutlineErrorCode; error: string } | undefined {
  if (args.outcome.exitCode === 0) return undefined
  const cause = describeRenderFailure(args.outcome, args.deadline.timedOut(), args.signal)
  return {
    ok: false,
    code: args.signal?.aborted === true ? 'aborted' : 'render_failed',
    error: `${args.label}失败（${cause}）：${renderStderr(args.handle) || '无 stderr 输出'}`,
  }
}

/**
 * 用 Inkscape 把 SVG 里的文字转成轮廓路径（就地改写文件）。
 *
 * 转换命令固定为 `--export-type=svg --export-plain-svg --export-text-to-path`：
 * 纯 SVG 导出去掉 Inkscape 专有属性，文字转路径去掉字体依赖；画布尺寸、坐标与
 * 线宽原样保留（本机 Inkscape 1.4.4 实测：66×40mm 画布与 `stroke-width="0.25"`
 * 的输出与输入逐值一致）。
 * @param subprocess - 注入的 subprocess 服务（本模块只用 spawn）。
 * @param spec - 待转换的 SVG 路径与取消信号。
 * @param options - Inkscape 路径覆盖与转换超时。
 * @returns 成功，或分类错误（not_installed / render_failed / aborted）。
 */
export async function outlineSvgText(
  subprocess: SubprocessSpawner,
  spec: InkscapeOutlineSpec,
  options: InkscapeOutlineOptions,
): Promise<InkscapeOutlineOutcome> {
  const resolved = resolveInkscape(options)
  if (!resolved.ok) return resolved
  let original: string
  try {
    original = await readFile(spec.path, 'utf8')
  } catch (error) {
    return { ok: false, code: 'render_failed', error: `读取待转换的 SVG 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let workDir: string | undefined
  let deadline: RenderDeadline | undefined
  try {
    // 期限自子进程启动前开始计，不含建临时目录的时间（与 freecad-renderer 同序）：
    // 预算极小时报的应是「渲染超时」，而不是建目录失败式的「调用失败」。
    workDir = await mkdtemp(join(tmpdir(), 'dsh-outline-'))
    const started = startRenderDeadline(options.renderTimeoutMs, spec.signal)
    deadline = started
    const outputPath = join(workDir, 'outlined.svg')
    const { handle, outcome } = await spawnRenderProcess(subprocess, started, {
      argv: [
        resolved.executable,
        '--export-type=svg',
        '--export-plain-svg',
        '--export-text-to-path',
        `--export-filename=${outputPath}`,
        spec.path,
      ],
      cwd: workDir,
      stdio: quietStdio(),
    })
    const failed = inkscapeExitFailure({ outcome, deadline: started, signal: spec.signal, handle, label: 'Inkscape 文字转路径' })
    if (failed !== undefined) return failed
    if (!existsSync(outputPath)) {
      return { ok: false, code: 'render_failed', error: `Inkscape 未生成输出文件：${outputPath}` }
    }
    const outlined = await readFile(outputPath, 'utf8')
    try {
      assertSafeSvg(outlined, DEFAULT_SVG_MAX_BYTES)
    } catch (error) {
      const reason = error instanceof SvgAnnotateError ? error.message : String(error)
      return { ok: false, code: 'render_failed', error: `Inkscape 转换产物 SVG 校验失败：${reason}` }
    }
    // 导出开关失效时（版本差异）Inkscape 可能原样返回带文字的文件；那时「不依赖
    // 字体」这个承诺不成立，必须报错而不是静默交出一个仍有字体依赖的图。
    // 注释里的 `<text>` 示例不算残留：先整段去掉注释再判。
    if (TEXT_ELEMENT_PATTERN.test(outlined.replace(/<!--[\s\S]*?-->/g, ''))) {
      return { ok: false, code: 'render_failed', error: 'Inkscape 转换产物仍含 `<text>` 元素，文字未转成路径' }
    }
    const regression = geometryRegression(original, outlined)
    if (regression !== undefined) {
      return { ok: false, code: 'render_failed', error: `Inkscape 转换产物几何走样：${regression}` }
    }
    // 子进程退出与写回之间仍可能被调用方取消：先查一次，再原子替换（同目录临时文件 +
    // rename），读取方看到的要么是原图、要么是完整产物。
    spec.signal?.throwIfAborted()
    await writeFileAtomic(spec.path, outlined, { mode: 0o644 })
    return { ok: true }
  } catch (error) {
    return { ok: false, ...describeRenderThrow('Inkscape 文字转路径', error, spec.signal) }
  } finally {
    deadline?.dispose()
    // 临时目录清理失败只会留下系统临时区里的残留目录，不能把已经分类的转换结果顶掉。
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 用 Inkscape 把附图 SVG 导出为 png/pdf。
 *
 * 命令固定为 `--export-type=<format> --export-area-page --export-filename=<目标>`；
 * 给了 `dpi` 才追加 `--export-dpi=`，缺省沿用 Inkscape 的默认分辨率（与 dot 缺省
 * 出图的语义一致：不配置就不指定）。导出直接落到目标路径，不经临时目录——目标在
 * 附图输出目录内，工具层本来就会覆盖同名产物。
 * @param subprocess - 注入的 subprocess 服务（本模块只用 spawn）。
 * @param spec - 源 SVG、目标路径、格式、分辨率与取消信号。
 * @param options - Inkscape 路径覆盖与导出超时。
 * @returns 成功，或分类错误（not_installed / render_failed / aborted）。
 */
export async function exportWithInkscape(
  subprocess: SubprocessSpawner,
  spec: InkscapeExportSpec,
  options: InkscapeOutlineOptions,
): Promise<InkscapeOutlineOutcome> {
  const resolved = resolveInkscape(options)
  if (!resolved.ok) return resolved
  let deadline: RenderDeadline | undefined
  try {
    const started = startRenderDeadline(options.renderTimeoutMs, spec.signal)
    deadline = started
    const { handle, outcome } = await spawnRenderProcess(subprocess, started, {
      argv: [
        resolved.executable,
        `--export-type=${spec.format}`,
        '--export-area-page',
        ...(spec.dpi === undefined ? [] : [`--export-dpi=${String(spec.dpi)}`]),
        `--export-filename=${spec.outcomePath}`,
        spec.path,
      ],
      cwd: dirname(spec.outcomePath),
      stdio: quietStdio(),
    })
    const failed = inkscapeExitFailure({ outcome, deadline: started, signal: spec.signal, handle, label: `Inkscape 导出 ${spec.format}` })
    if (failed !== undefined) return failed
    // Inkscape 版本差异下可能只写了空文件而不报错；空产物不该当成成功交付。
    const written = await readFile(spec.outcomePath).catch(() => undefined)
    if (written === undefined || written.length === 0) {
      return { ok: false, code: 'render_failed', error: `Inkscape 未生成有效的 ${spec.format} 产物：${spec.outcomePath}` }
    }
    const incomplete = spec.format === 'pdf' ? !isCompletePdf(written) : !isCompletePng(written)
    if (incomplete) {
      return {
        ok: false,
        code: 'render_failed',
        error: `Inkscape 的 ${spec.format} 产物不完整（${spec.outcomePath}，${String(written.length)} 字节）：退出码为 0 也会中途停止写入。图面文字未转路径时，个别字形的字体子集化会触发这一行为，可开启 Config.figureTextToPath 后重试`,
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, ...describeRenderThrow(`Inkscape 导出 ${spec.format}`, error, spec.signal) }
  } finally {
    deadline?.dispose()
  }
}

/** PNG 文件签名。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 结尾的 IEND 块（长度 0 + 类型 + CRC）。 */
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/**
 * PDF 完整性：有交叉引用表指针，且以 `%%EOF` 收尾。
 *
 * Inkscape 1.4.4 本机实测：图面含未转路径的某些中文字形（如「源」）时，导出的 PDF
 * 在字体对象后被截断、退出码仍为 0——只看退出码和文件非空会把这种半成品当成交付物。
 * @param buffer - 导出产物内容。
 * @returns 结构完整时为 true。
 */
function isCompletePdf(buffer: Buffer): boolean {
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1')
  return tail.includes('startxref') && tail.trimEnd().endsWith('%%EOF')
}

/**
 * PNG 完整性：以签名开头、以 IEND 块结尾。
 * @param buffer - 导出产物内容。
 * @returns 结构完整时为 true。
 */
function isCompletePng(buffer: Buffer): boolean {
  return buffer.length > PNG_SIGNATURE.length + PNG_IEND.length
    && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && buffer.subarray(buffer.length - PNG_IEND.length).equals(PNG_IEND)
}
