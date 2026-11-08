/**
 * 附图交付链：落版、渲染复核、文字转路径与格式导出。
 *
 * 非 SVG 交付先出 SVG，再在这张中间图上依次落版、复核、转路径，最后由宿主
 * 注入的导出端口交给 Inkscape；导出失败时调用方决定退回直绘还是报错。每一步
 * 只改写传入的输出对象或中间文件，模块自身不持有跨调用状态。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-delivery
 */

import { PatentToolError } from '../error.ts'
import { clearanceMmForFigure } from '../figure/render-check.ts'
import { gateRenderedSvg } from '../figure/render-check-gate.ts'
import { isVectorFigureType } from '../figure/vector-figure-build.ts'
import { assertRendered } from './internal/render-outcome.ts'
import { applySubmissionPage, buildLayout, resolveSubmission } from './figure-submission.ts'
import type { SubmissionPlanInput } from './figure-submission.ts'
import { resolveFontPt } from './figure-run.ts'
import type { DotFormat } from '../figure/dot-builder.ts'
import type { GenerateFigureType, GeneratePatentFigureDeps, GeneratePatentFigureOutput } from './figure-input.ts'
import type { TargetOffice } from '../figure/office-profile.ts'

/**
 * 是否需要「SVG 全链」交付非 SVG：先出 SVG、落版、复核、文字转路径，再交 Inkscape 导出。
 *
 * 两种情况需要它——落版/复核/文字转路径只作用于 SVG，而矢量图型本来就只有 SVG 一条
 * 绘图通路（渲染器无法直接出 png/pdf）。没有注入导出端口时不走全链：渲染器直接出图，
 * 落版与复核的缺席由各自的警告说明。
 * @param args - the figure type, the requested format, the target office, and whether the export port is wired.
 * @returns 本次调用是否走全链。
 */
export function needsSvgChain(args: {
  figureType: GenerateFigureType
  format: DotFormat
  targetOffice: TargetOffice | undefined
  exportAvailable: boolean
}): boolean {
  if (args.format === 'svg' || !args.exportAvailable) return false
  return isVectorFigureType(args.figureType) || args.targetOffice !== undefined
}

/**
 * 复核一张已交付的 SVG：净距按图型分档，strict 按部署开关，面板编号进报告前缀。
 * @param args - the deps carrying the strict switch, the delivered path, the warning sink, the figure type, and the panel suffix.
 */
async function checkDeliveredSvg(args: {
  deps: GeneratePatentFigureDeps
  path: string
  warnings: string[]
  figureType: GenerateFigureType
  suffix: string
}): Promise<void> {
  await gateRenderedSvg({
    path: args.path,
    warnings: args.warnings,
    clearanceMm: clearanceMmForFigure(args.figureType),
    failOnFindings: args.deps.failOnRenderFindings === true,
    ...(args.deps.minSheetFillRatio === undefined ? {} : { minSheetFillRatio: args.deps.minSheetFillRatio }),
    tool: 'generate_patent_figure',
    ...(args.suffix === '' ? {} : { label: `面板 ${args.suffix} ` }),
  })
}

/**
 * SVG 全链的收尾：在中间 SVG 上落版、复核、转路径，再导出请求的格式。
 *
 * 三步的警告先攒在暂存输出里，导出成功才并入：导出失败时它们描述的交付物并不存在，
 * 逐条抛出去会误导用户。
 * @param args - the deps, the intermediate SVG and final paths, the layout input, the format, dpi, signal, and the output to extend.
 * @returns 'done' 表示导出成功；'fallback' 表示导出失败但调用方还有直绘通路可退回。
 * @throws PatentToolError 导出失败且该图型没有 SVG 直绘以外的通路时（`setup_required` / `tool_execution_failed`）。
 */
export async function finishSvgChain(args: {
  deps: GeneratePatentFigureDeps
  svgPath: string
  outcomePath: string
  input: SubmissionPlanInput
  suffix: string
  format: DotFormat
  dpi: number | undefined
  style: 'grayscale' | 'semantic'
  signal: AbortSignal
  output: GeneratePatentFigureOutput
  figureType: GenerateFigureType
  /** 渲染器直接出图的通路是否存在（矢量图型为 false：导出失败即无产物可交）。 */
  hasDirectRender: boolean
}): Promise<'done' | 'fallback'> {
  const staged: GeneratePatentFigureOutput = { ...args.output, warnings: [] }
  await layoutSubmissionPage({
    input: args.input,
    suffix: args.suffix,
    outcomePath: args.svgPath,
    format: 'svg',
    style: args.style,
    output: staged,
    ...styleBodyFont(args.deps, args.figureType),
  })
  await checkDeliveredSvg({
    deps: args.deps,
    path: args.svgPath,
    warnings: staged.warnings,
    figureType: args.figureType,
    suffix: args.suffix,
  })
  await outlineFigureText({ deps: args.deps, path: args.svgPath, format: 'svg', signal: args.signal, warnings: staged.warnings })
  const exported = await args.deps.exportFigure?.({
    path: args.svgPath,
    outcomePath: args.outcomePath,
    format: toExportFormat(args.format),
    ...(args.dpi === undefined ? {} : { dpi: args.dpi }),
    signal: args.signal,
  })
  if (exported !== undefined && exported.ok) {
    args.output.warnings.push(...staged.warnings)
    if (staged.layout !== undefined) args.output.layout = staged.layout
    return 'done'
  }
  /* v8 ignore next -- chain implies the export port is wired, so the call always returns an outcome */
  const reason = exported === undefined ? '宿主未注入格式导出端口' : exported.error
  if (!args.hasDirectRender) {
    throw new PatentToolError(exported?.code === 'not_installed' ? 'setup_required' : 'tool_execution_failed', `导出 ${args.format} 失败：${reason}`, { tool: 'generate_patent_figure' })
  }
  args.output.warnings.push(`未能导出 ${args.format}：${reason}；落版、渲染复核与文字转路径未生效（它们只作用于 SVG），改由渲染器直接出图`)
  return 'fallback'
}

/**
 * 渲染器直绘路径的收尾：落版、按需复核、文字转路径。全链回退时也走这里——那时
 * 交付物是渲染器的原始产物，这三步应按各自对非 SVG 的既有规则给出警告。
 * @param args - the deps, the delivered path and format, whether to run the render check, the signal, and the warning sink.
 */
export async function finishDirectRender(args: {
  deps: GeneratePatentFigureDeps
  outcomePath: string
  input: SubmissionPlanInput
  suffix: string
  format: DotFormat
  check: boolean
  style: 'grayscale' | 'semantic'
  signal: AbortSignal
  output: GeneratePatentFigureOutput
  figureType: GenerateFigureType
}): Promise<void> {
  await layoutSubmissionPage({
    input: args.input,
    suffix: args.suffix,
    outcomePath: args.outcomePath,
    format: args.format,
    style: args.style,
    output: args.output,
    ...styleBodyFont(args.deps, args.figureType),
  })
  if (args.check) {
    await checkDeliveredSvg({
      deps: args.deps,
      path: args.outcomePath,
      warnings: args.output.warnings,
      figureType: args.figureType,
      suffix: args.suffix,
    })
  } else if (args.deps.failOnRenderFindings === true) {
    args.output.warnings.push('渲染复核未执行（该格式走渲染器直绘、没有 SVG 可量测）：figureFailOnRenderFindings 对本次输出不生效')
  }
  await outlineFigureText({
    deps: args.deps,
    path: args.outcomePath,
    format: args.format,
    signal: args.signal,
    warnings: args.output.warnings,
  })
}

/** 导出格式窄化（全链只在非 SVG 时启用）。 */
function toExportFormat(format: DotFormat): 'png' | 'pdf' {
  /* v8 ignore next -- 全链由 needsSvgChain 保证只在 png/pdf 时启用 */
  if (format !== 'png' && format !== 'pdf') throw new PatentToolError('invalid_tool_input', `不支持的导出格式：${format}`, { tool: 'generate_patent_figure' })
  return format
}

/**
 * 落版核算用的正文字号（用户单位）：直绘图型的用户单位是毫米，DOT 图是 pt；
 * 未配置图面字号（Config.figureFontMm）时 undefined，落版核算沿用历史默认 10pt。
 * @param deps - the tool dependencies (carrying the deployment figure font size).
 * @param figureType - the figure type of this render.
 * @returns the body font size in the artifact's user units; undefined when unconfigured.
 */
function bodyFontFor(deps: GeneratePatentFigureDeps, figureType: GenerateFigureType): number | undefined {
  const mm = deps.figureFontMm
  if (mm === undefined) return undefined
  return isVectorFigureType(figureType) ? mm : resolveFontPt(mm)
}

/**
 * 落版参数里的正文字号字段：未配置图面字号时不带该字段（exactOptionalPropertyTypes）。
 * @param deps - the tool dependencies (carrying the deployment figure font size).
 * @param figureType - the figure type of this render.
 * @returns the field to spread into the layout call.
 */
function styleBodyFont(deps: GeneratePatentFigureDeps, figureType: GenerateFigureType): { bodyFontSize?: number } {
  const size = bodyFontFor(deps, figureType)
  return size === undefined ? {} : { bodyFontSize: size }
}

/**
 * 落版与合规核算：给定 target_office 时把图形落到该法域幅面，并把结果挂到输出上。
 * @param args - the input, the panel suffix (`''` for the single path), the rendered path, the format, the style, and the output to extend.
 */
async function layoutSubmissionPage(args: {
  input: SubmissionPlanInput
  suffix: string
  outcomePath: string
  format: DotFormat
  style: 'grayscale' | 'semantic'
  output: GeneratePatentFigureOutput
  /** 图面字号（用户单位）：DOT 图为 pt、直绘图型为毫米；未配置时 undefined。 */
  bodyFontSize?: number
}): Promise<void> {
  const plan = resolveSubmission(args.input, args.suffix, args.bodyFontSize)
  if (plan === undefined) return
  const applied = await applySubmissionPage(args.outcomePath, plan, args.format, args.output.warnings)
  if (applied !== undefined) {
    args.output.layout = buildLayout(plan, applied, args.style, args.input.figure_count ?? 1, args.output.warnings)
  }
}

/**
 * 文字转路径：把已落版文件里的 `<text>` 换成轮廓路径（Config.figureTextToPath）。
 *
 * 放在落版之后：落版会改写坐标与画布，先转的路径还得再被改写一次；转完不再有
 * 步骤解析文件（索引只记路径）。只对 SVG 生效——png/pdf 由渲染器按 Config.dotFont
 * 出字，那时给出「本参数不生效」的警告而不是静默忽略。
 * @param args - the deps, the finished path, the output format, the caller's cancel signal, and the warning sink.
 */
async function outlineFigureText(args: {
  deps: GeneratePatentFigureDeps
  path: string
  format: DotFormat
  signal: AbortSignal
  warnings: string[]
}): Promise<void> {
  const outline = args.deps.outlineText
  if (outline === undefined) return
  if (args.format !== 'svg') {
    args.warnings.push(`文字转路径（Config.figureTextToPath）仅对 SVG 输出生效；本次 ${args.format} 仍由渲染器按 Config.dotFont 出字`)
    return
  }
  const outcome = await outline({ path: args.path, signal: args.signal })
  assertRendered(outcome, 'generate_patent_figure')
}
