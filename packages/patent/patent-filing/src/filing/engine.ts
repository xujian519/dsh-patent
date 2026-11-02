/**
 * 引擎调用：经 `ctx.subprocess` 运行随包 Python 脚本，并把标准输出解析成报告。
 *
 * 退出码与结果分开判读：引擎在断言不通过时以非零码结束，同时仍打印完整 JSON ——
 * 那是**成功的领域结果**（成品不合格），不是基础设施失败。只有标准输出无法解析成
 * JSON 时才抛错，并在消息里带上退出码与 stderr 尾巴。
 * @module @deepseek-ai/dsh-patent-filing/filing/engine
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { assertSafeId, caseOutputsDir, isJsonRecord, resolveConfinedPath } from '@deepseek-ai/dsh-patent-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PatentFilingError } from '../types.ts'
import type { FilingBuildResult, FilingContent, FilingVerifyResult, SectionTally, SubprocessSpawner, TemplateStyle } from '../types.ts'
import { getEngineDir } from './assets.ts'
import { requirePython } from './python.ts'
import { validateContent } from './content.ts'

/** 默认输出目录（相对进程工作目录）；与专利域既有约定一致。 */
export const DEFAULT_OUTPUT_DIR = '.dsh/documents'

/** 默认引擎超时（毫秒）。成文含 Chrome 栅格化，故与 patent-document 的打印超时同量级。 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 120_000

/** SIGTERM → SIGKILL 升级宽限。 */
const GRACE_MS = 3_000

/** 单流内存输出上限（引擎诊断尾 + JSON 报告）。 */
const MAX_OUTPUT_BYTES = 4_000_000

/** 附图扩展名 → 是否需先栅格化。 */
const SVG_EXTENSIONS = new Set(['.svg'])
const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

/** 每次引擎调用都需要的东西。 */
export interface EngineInvocation {
  /** 注入的 subprocess 能力（ctx.subprocess 的 spawn）。 */
  subprocess: SubprocessSpawner
  /**
   * Python 解释器绝对路径；缺省在调用时按 {@link requirePython} 探测。
   * 调用时解析是为了让本机缺解释器只挡住这一次调用，而不是挡住建有本插件的整份组合。
   */
  pythonPath?: string
  /** 单次引擎调用超时（毫秒）。 */
  timeoutMs: number
}

/** 成文需要的引擎设置。 */
export interface BuildEngineOptions extends EngineInvocation {
  /** spec 路径（结构与断言）。 */
  specPath: string
  /** 模板路径（体例真相源）。 */
  templatePath: string
  /** 缺省输出目录（相对 cwd）。 */
  defaultOutputDir: string
  /** 附图栅格化倍率。 */
  figureScale: number
  /** Chrome 可执行文件覆盖（`.svg` 附图栅格化用）。 */
  chromePath?: string
}

/** 验收需要的引擎设置。 */
export interface VerifyEngineOptions extends EngineInvocation {
  /** spec 路径（结构与断言）。 */
  specPath: string
  /** 模板路径（体例漂移核对的基准）。 */
  templatePath: string
}

/** 一次成文请求。 */
export interface BuildFilingInput {
  /** 结构化内容模型。 */
  content: FilingContent
  /** 输出文件名主干（不含扩展名）。 */
  outputName: string
  /** 可选案卷号；给出后落在 `data/cases/<案卷号>/outputs/`。 */
  caseId?: string
  /** 可选显式输出目录（优先于案卷号与缺省目录）。 */
  outputDir?: string
}

/** 一次验收请求。 */
export interface VerifyFilingInput {
  /** 待验收的 .docx 路径。 */
  docxPath: string
}

/**
 * 校验输出文件名主干可直接拼入路径。
 *
 * 与参数 schema 的分工：schema 只保证它是字符串；这里拒绝路径分隔符、`..`、控制字符与
 * 首尾空白，长度上限 120。中文与圈码（①–⑳）是案卷常用前缀，按原样接受。
 * @param name - 待校验的文件名主干。
 * @returns 通过校验的名字。
 */
export function assertSafeOutputName(name: string): string {
  const bad = name.trim() !== name || name === ''
    || name.length > 120
    || name.includes('..')
    || /[/\\]/.test(name)
    || /[\u0000-\u001f\u007f]/.test(name)
  if (bad) {
    throw new PatentFilingError(
      `输出文件名 ${JSON.stringify(name)} 不可用：不得含路径分隔符、\`..\`、控制字符或首尾空白，长度 1–120`,
    )
  }
  return name
}

/**
 * 解析输出目录。
 *
 * 显式 outputDir 的真实位置必须留在 cwd 内：模型控制的工具参数若允许绝对路径
 * 或 `../` 串联，会把文件写到 cwd 之外进程有权限的任意位置（数据污染/安全风险）。
 * cwd 内的绝对路径照常接受；caseId 已走 assertSafeId 校验，不会带出 `..` 段；
 * defaultOutputDir 是本包固定常量。
 * @param input - 成文请求的目录相关字段。
 * @param cwd - 进程工作目录。
 * @param defaultOutputDir - 既无 outputDir 也无 caseId 时的缺省目录。
 * @returns 输出目录绝对路径。
 * @throws PatentFilingError 当 outputDir 解析后的真实路径落在 cwd 之外。
 */
export function resolveOutputDir(
  input: Pick<BuildFilingInput, 'outputDir' | 'caseId'>,
  cwd: string,
  defaultOutputDir: string,
): string {
  if (input.outputDir !== undefined) {
    return resolveConfinedPath(input.outputDir, cwd, '输出目录', message => new PatentFilingError(message))
  }
  if (input.caseId !== undefined) {
    assertSafeId(input.caseId, '案卷号')
    return resolve(cwd, caseOutputsDir(input.caseId))
  }
  return resolve(cwd, defaultOutputDir)
}

/**
 * 计算文件 sha256。
 * @param path - 目标文件路径。
 * @returns 小写十六进制 sha256。
 */
export async function fileFingerprint(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * 解释器缺引擎依赖时的补充提示。
 *
 * 引擎的 stderr 带着 Python 的导入错误，但它不点明处置：换一个自带 python-docx 的
 * 解释器。存在性检查看不出这一点（解释器存在、依赖缺失），所以在这里把它说清楚。
 * @param stderr - 引擎的标准错误输出。
 * @param pythonPath - 本次使用的解释器。
 * @returns 导入失败时追加的一句提示，否则空串。
 */
function missingModuleHint(stderr: string, pythonPath: string): string {
  return /\b(?:ModuleNotFoundError|ImportError)\b/.test(stderr)
    ? `；解释器 ${pythonPath} 无法加载引擎依赖，请指向一个自带 python-docx 的解释器（或让随包运行时可用）`
    : ''
}

/**
 * 运行一个引擎脚本并解析其标准输出。
 * @param options - 引擎依赖与覆盖。
 * @param script - 引擎脚本绝对路径（也是诊断里的脚本名）。
 * @param args - 传给脚本的参数。
 * @param signal - 调用方取消信号。
 * @returns 解析后的 JSON 值（无论退出码）。
 * @throws PatentFilingError 本机没有可用解释器，或标准输出不是 JSON 时。
 */
async function runEngine(
  options: EngineInvocation,
  script: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  // 已取消的调用不起进程：provider 对已中止的信号会同步抛错，那条错误既不是本包的领域
  // 错误、也不说明是哪次调用，先在这里挡住（也不再去解析解释器）。
  if (signal.aborted) {
    throw new PatentFilingError(`${script} 未启动：调用方在起进程前已取消`)
  }
  const pythonPath = options.pythonPath ?? requirePython()
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
  timer.unref()
  const onAbort = (): void => { controller.abort() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const handle = options.subprocess.spawn({
      argv: [pythonPath, script, ...args],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: GRACE_MS,
      signal: controller.signal,
    })
    const outcome = await handle.done
    const stdout = (handle.collected.stdout?.readFrom(0).text ?? '').trim()
    const stderr = (handle.collected.stderr?.readFrom(0).text ?? '').trim()
    try {
      return JSON.parse(stdout) as JsonValue
    } catch (cause) {
      const why = outcome.exitCode === null
        ? `被信号 ${outcome.signal ?? '未知'} 终止`
        : `退出码 ${outcome.exitCode}`
      throw new PatentFilingError(
        `${script} 未输出可解析的 JSON（${why}）：${stderr || stdout || '无输出'}`
        + missingModuleHint(stderr, pythonPath),
        { cause },
      )
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** 从 JSON 对象里按字段名取出字符串。 */
function str(source: Record<string, JsonValue>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string') {
    throw new PatentFilingError(`${where} 缺少字符串字段 ${key}`)
  }
  return value
}

/** 从 JSON 对象里按字段名取出数字。 */
function num(source: Record<string, JsonValue>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number') {
    throw new PatentFilingError(`${where} 缺少数字字段 ${key}`)
  }
  return value
}

/** 断言 JSON 值是对象；判定复用 patent-core 的守卫，抛错类型留在这里。 */
function obj(value: JsonValue, where: string): Record<string, JsonValue> {
  if (!isJsonRecord(value)) {
    throw new PatentFilingError(`${where} 不是 JSON 对象`)
  }
  return value
}

/** 解析 build.py 报告里的语法体例字段。 */
function parseTemplateStyle(value: JsonValue): TemplateStyle {
  const source = obj(value, 'template_style')
  const numbers = (key: string): number[] => {
    const raw = source[key]
    if (!Array.isArray(raw)) throw new PatentFilingError(`template_style.${key} 不是数组`)
    return raw.map((entry) => {
      if (typeof entry !== 'number') throw new PatentFilingError(`template_style.${key} 含非数字项`)
      return entry
    })
  }
  return {
    sectionCount: num(source, 'section_count', 'template_style'),
    eastAsia: str(source, 'eastAsia', 'template_style'),
    ascii: str(source, 'ascii', 'template_style'),
    cs: str(source, 'cs', 'template_style'),
    sizePt: num(source, 'size_pt', 'template_style'),
    lineSpacing: num(source, 'line_spacing', 'template_style'),
    firstLineIndent: num(source, 'first_line_indent', 'template_style'),
    sizesPt: numbers('sizes_pt'),
    lineSpacings: numbers('line_spacings'),
  }
}

/** 解析 build.py 报告里的各节承载量。 */
function parseSections(value: JsonValue): SectionTally[] {
  if (!Array.isArray(value)) throw new PatentFilingError('sections 不是数组')
  return value.map((entry) => {
    const source = obj(entry, 'sections 项')
    return {
      key: str(source, 'key', 'sections 项'),
      paragraphs: num(source, 'paragraphs', 'sections 项'),
      figures: num(source, 'figures', 'sections 项'),
    }
  })
}

/** 解析 verify.py 报告。 */
function parseVerifyInfo(value: JsonValue): FilingVerifyResult['info'] {
  const source = obj(value, 'info')
  const strings = (key: string): string[] => {
    const raw = source[key]
    if (!Array.isArray(raw)) throw new PatentFilingError(`info.${key} 不是数组`)
    return raw.map((entry) => {
      if (typeof entry !== 'string') throw new PatentFilingError(`info.${key} 含非字符串项`)
      return entry
    })
  }
  const numbers = (value: JsonValue, where: string): number[] => {
    if (!Array.isArray(value)) throw new PatentFilingError(`${where} 不是数组`)
    return value.map((entry) => {
      if (typeof entry !== 'number') throw new PatentFilingError(`${where} 含非数字项`)
      return entry
    })
  }
  // 引擎把各节归属报成 map；canonical 值用数组，键序即 spec 的节序。
  const layoutSource = obj(source.layout ?? null, 'info.layout')
  const layout = Object.entries(layoutSource).map(([key, entry]) => {
    const node = obj(entry, `info.layout.${key}`)
    return {
      key,
      paragraphs: num(node, 'paragraphs', `info.layout.${key}`),
      figures: num(node, 'figures', `info.layout.${key}`),
    }
  })
  const base = {
    sections: num(source, 'sections', 'info'),
    headers: strings('headers'),
    paragraphs: num(source, 'paragraphs', 'info'),
    claims: num(source, 'claims', 'info'),
    numbering: str(source, 'numbering', 'info'),
    tables: num(source, 'tables', 'info'),
    figures: num(source, 'figures', 'info'),
    layout,
  }
  const template = source.template
  if (template === null || template === undefined) return base
  const node = obj(template, 'info.template')
  return {
    ...base,
    template: {
      sections: num(node, 'sections', 'info.template'),
      sizes_pt: numbers(node.sizes_pt ?? null, 'info.template.sizes_pt'),
      line_spacings: numbers(node.line_spacings ?? null, 'info.template.line_spacings'),
    },
  }
}

/**
 * 把内容模型成文为申请文件 .docx。
 * @param input - 成文请求。
 * @param options - 引擎依赖与覆盖。
 * @param cwd - 进程工作目录（解析相对输出目录用）。
 * @param signal - 调用方取消信号。
 * @returns 成文结果（含各节承载量、编号总数与模板指纹）。
 */
export async function buildFiling(
  input: BuildFilingInput,
  options: BuildEngineOptions,
  cwd: string,
  signal: AbortSignal,
): Promise<FilingBuildResult> {
  const content = validateContent(input.content)
  assertSafeOutputName(input.outputName)
  const outputDir = resolveOutputDir(input, cwd, options.defaultOutputDir)
  await mkdir(outputDir, { recursive: true })
  const docxPath = join(outputDir, `${input.outputName}.docx`)

  const work = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-'))
  try {
    const specimens = await prepareFigures(content.figures, work, options, signal)
    const contentPath = join(work, 'content.json')
    await writeFile(contentPath, JSON.stringify({ ...content, figures: specimens }, null, 2), 'utf8')
    const report = obj(await runEngine(options, join(getEngineDir(), 'build.py'), [
      '--spec', options.specPath,
      '--content', contentPath,
      '--template', options.templatePath,
      '--out', docxPath,
    ], signal), 'build 报告')
    return {
      docxPath,
      figures: specimens,
      sections: parseSections(report.sections ?? null),
      numberingTotal: num(report, 'numbering_total', 'build 报告'),
      upstreamNumberingSeen: num(report, 'upstream_numbering_seen', 'build 报告'),
      templateStyle: parseTemplateStyle(report.template_style ?? null),
      templateFingerprint: await fileFingerprint(options.templatePath),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * 把附图源件准备成可入文的位图：`.svg` 先栅格化，其余按原位图使用。
 * @param figures - 内容模型里的附图路径，按图序。
 * @param work - 本次调用的临时目录。
 * @param options - 引擎依赖与覆盖。
 * @param signal - 调用方取消信号。
 * @returns 入文用的位图路径，顺序与输入一致。
 */
async function prepareFigures(
  figures: readonly string[],
  work: string,
  options: BuildEngineOptions,
  signal: AbortSignal,
): Promise<string[]> {
  const missing = figures.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new PatentFilingError(`附图源件不存在：${missing.join('、')}`)
  }
  const rasters = figures.map(path => resolve(path))
  const svgs = rasters.filter(path => SVG_EXTENSIONS.has(extname(path).toLowerCase()))
  const unknown = rasters.filter((path) => {
    const ext = extname(path).toLowerCase()
    return !SVG_EXTENSIONS.has(ext) && !RASTER_EXTENSIONS.has(ext)
  })
  if (unknown.length > 0) {
    throw new PatentFilingError(
      `附图只接受 .svg 源件或 .png/.jpg/.jpeg 位图；无法处理：${unknown.join('、')}`,
    )
  }
  if (svgs.length === 0) return rasters

  const outDir = join(work, 'figures')
  const argv: string[] = []
  for (const svg of svgs) argv.push('--svg-file', svg)
  argv.push('--out-dir', outDir, '--scale', String(options.figureScale))
  if (options.chromePath !== undefined) argv.push('--chrome', options.chromePath)
  const report = obj(
    await runEngine(options, join(getEngineDir(), 'render_figures.py'), argv, signal),
    'render_figures 报告',
  )
  const written = report.figures
  if (!Array.isArray(written)) throw new PatentFilingError('render_figures 报告缺少 figures')
  // 栅格化按 .svg 的出现顺序出件；把结果按原图序插回，非 .svg 的原样保留。
  let next = 0
  return rasters.map((path) => {
    if (!SVG_EXTENSIONS.has(extname(path).toLowerCase())) return path
    const replacement = written[next]
    next += 1
    if (typeof replacement !== 'string') {
      throw new PatentFilingError('render_figures 报告的 figures 少于输入的 .svg 张数')
    }
    return replacement
  })
}

/**
 * 对成品 .docx 跑体例与内容断言。
 * @param input - 验收请求。
 * @param options - 引擎依赖与覆盖。
 * @param signal - 调用方取消信号。
 * @returns 验收结果：`passed` 为假时 `errors` 逐条列出未通过的断言。
 */
export async function verifyFiling(
  input: VerifyFilingInput,
  options: VerifyEngineOptions,
  signal: AbortSignal,
): Promise<FilingVerifyResult> {
  if (!existsSync(input.docxPath)) {
    throw new PatentFilingError(`待验收文件不存在：${input.docxPath}`)
  }
  const report = obj(await runEngine(options, join(getEngineDir(), 'verify.py'), [
    '--spec', options.specPath,
    '--docx', input.docxPath,
    '--template', options.templatePath,
  ], signal), 'verify 报告')
  const errors = report.errors
  if (!Array.isArray(errors) || errors.some(entry => typeof entry !== 'string')) {
    throw new PatentFilingError('verify 报告的 errors 不是字符串数组')
  }
  return {
    passed: report.passed === true,
    errors: errors as string[],
    docxPath: input.docxPath,
    templateFingerprint: await fileFingerprint(options.templatePath),
    info: parseVerifyInfo(report.info ?? null),
  }
}
