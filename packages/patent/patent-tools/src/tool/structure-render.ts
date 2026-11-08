/**
 * 结构线稿的渲染与收尾：逐图投影、线宽/线型后处理、标号与附图说明、落版与文字转路径。
 * @module @deepseek-ai/dsh-patent-tools/tool/structure-render
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { PatentToolError } from '../error.ts'
import { figureSentence } from '../figure/figure-description.ts'
import { DEFAULT_STRUCTURE_VIEWS } from '../figure/freecad-structure-script.ts'
import { officeProfile, sheetNumberText } from '../figure/office-profile.ts'
import { applyStructureLineStyle } from '../figure/structure-svg-postprocess.ts'
import { buildSubmissionPage } from '../figure/submission-page.ts'
import { FIGURE_TYPE_NAMES } from './analyze-patent-figure.ts'
import type { FigureComponent } from './analyze-patent-figure.ts'
import { assertRendered } from './internal/render-outcome.ts'
import { assertViewSvgs, normalizeCallouts, normalizeDetails, normalizeViews, readManifest, resolveStructureModels } from './structure-model.ts'
import { DEFAULT_STRUCTURE_SCALE } from './structure-types.ts'
import type {
  GenerateStructureFigureDeps,
  GenerateStructureFigureInput,
  GenerateStructureFigureOutput,
  StructureAssembly,
  StructureCalloutInput,
  StructureFigureView,
} from './structure-types.ts'
import type { StructureDetail, StructureViewName } from '../figure/freecad-structure-script.ts'
import type { StructureHiddenLineStyle } from '../figure/structure-svg-postprocess.ts'
import type { SubmissionLayout } from '../figure/submission-page.ts'

/** 一次结构线稿调用的归一化参数：依赖、工作目录、视图、比例、显示与件号锚定。 */
type StructureRun = {
  deps: GenerateStructureFigureDeps
  input: GenerateStructureFigureInput
  cwd: string
  outputDir: string
  views: StructureViewName[]
  scale: number
  showHidden: boolean
  /** 可见线线宽（毫米）；缺省不改写。 */
  lineWidthMm?: number
  /** 隐藏线线型。 */
  hiddenLineStyle: StructureHiddenLineStyle
  baseFigure: number
  callouts: StructureCalloutInput[]
  /** 局部放大视图（已归一：base 落在 views 内、半径/倍数为正有限）。 */
  details: StructureDetail[]
  modelPaths: string[]
  /** 是否装配体（`model_paths`）：所有模型投影成一张图，否则逐模型一图。 */
  assembly: boolean
  /** 分解图：逐件投影并沿装配轴排布（仅装配体有效）。 */
  exploded: boolean
}

/**
 * 归一化并校验调用参数。schema 只约束 JSON 形状，模型实参与部署默认值在这里复核：
 * 比例必须正有限、图号必须正整数、目录批量不得带件号锚点。
 * @param args - the model-supplied arguments.
 * @param deps - the injected renderer, gate, defaults, and index writer.
 * @returns the resolved run parameters.
 * @throws PatentToolError when a value is out of range or batch mode meets callouts.
 */
export async function resolveStructureRun(args: unknown, deps: GenerateStructureFigureDeps): Promise<StructureRun> {
  // schema 校验后的模型 JSON 边界：调用方传来的实参在这里窄化为领域类型。
  const input = args as GenerateStructureFigureInput
  const cwd = deps.cwd ?? process.cwd()
  /* v8 ignore next -- apply() always injects outputDir; the cwd-relative default stays for standalone library callers */
  const outputDir = deps.outputDir ?? resolve(cwd, 'patent/figures')
  const views = normalizeViews(input.views, deps.defaultViews ?? DEFAULT_STRUCTURE_VIEWS)
  const scale = input.scale ?? deps.defaultScale ?? DEFAULT_STRUCTURE_SCALE
  // scale 来自模型 JSON 或 Config：schema 只约束为 number，正有限性须运行时复核
  // （与 normalizeCallouts 同一理由：模型实参/部署值必须在此 fail-loud）。
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new PatentToolError('invalid_tool_input', `scale 必须是正有限数，收到 ${String(scale)}`, { tool: 'generate_structure_figure' })
  }
  const showHidden = input.show_hidden ?? false
  const lineWidthMm = input.line_width_mm
  const hiddenLineStyle = input.hidden_line_style ?? 'solid'
  const baseFigure = input.figure_number ?? 1
  if (!Number.isInteger(baseFigure) || baseFigure < 1) {
    throw new PatentToolError('invalid_tool_input', `figure_number 必须是正整数，收到 ${String(input.figure_number)}`, { tool: 'generate_structure_figure' })
  }
  const callouts = normalizeCallouts(input.callouts).map(callout => ({
    numeral: callout.numeral,
    ...(callout.point3d === undefined ? {} : { point3d: callout.point3d }),
    ...(callout.label === undefined ? {} : { label: callout.label }),
    ...(callout.model === undefined ? {} : { model: callout.model }),
  }))
  const details = normalizeDetails(input.details, views)
  const { modelPaths, assembly } = await resolveStructureModels(input, cwd)
  for (const [index, callout] of callouts.entries()) {
    // 装配体的判据是「件号锚点落在所声明的零件上」，归属不明就无从核对；而目录批量
    // 是「一个模型一张图」，件号必然属于该图唯一的模型，故只对装配体收口。
    if (assembly && callout.model === undefined) {
      throw new PatentToolError('invalid_tool_input', `callouts[${index}].model 必填：装配体（model_paths）下每个件号都要写明所属零件在 model_paths 中的下标`, { tool: 'generate_structure_figure' })
    }
    if (callout.model === undefined) continue
    // schema 只把 model 约束为 integer；模型实参的取值域必须在这里复核（同 scale 的理由）。
    if (!Number.isInteger(callout.model) || callout.model < 0 || callout.model >= modelPaths.length) {
      throw new PatentToolError('invalid_tool_input', `callouts[${index}].model 必须是 0 到 ${String(modelPaths.length - 1)} 之间的整数（对应第几个输入模型），收到 ${String(callout.model)}`, { tool: 'generate_structure_figure' })
    }
  }
  // 目录批量逐模型出图，但 callouts 的 point3d 是某个模型的专属坐标：把同一组
  // 3D 锚点套到目录内其余模型会落到错误位置，故 fail-loud 拒绝而非静默误标。
  if (!assembly && modelPaths.length > 1 && callouts.length > 0) {
    throw new PatentToolError('invalid_tool_input', '批量（model_path 为目录）不支持 callouts：件号 3D 锚点仅对单个模型有效，请对单个模型生成结构线稿，或用 model_paths 把多个零件投影成一张装配图', { tool: 'generate_structure_figure' })
  }
  // 放大窗口同样是模型专属坐标（圆心 + 半径），套到目录内其余模型会框错地方。
  if (!assembly && modelPaths.length > 1 && details.length > 0) {
    throw new PatentToolError('invalid_tool_input', '批量（model_path 为目录）不支持 details：放大窗口的模型坐标仅对单个模型有效，请对单个模型生成结构线稿，或用 model_paths 把多个零件投影成一张装配图', { tool: 'generate_structure_figure' })
  }
  const exploded = input.exploded === true
  // 分解图的前提是「零件之间有装配关系」：单模型没有可分解的对象，目录批量是
  // 一模型一图、同样没有；只有 model_paths 的装配体成立。
  if (exploded && (!assembly || modelPaths.length < 2)) {
    throw new PatentToolError('invalid_tool_input', 'exploded 需要 model_paths 传至少两个零件文件：分解图沿装配轴把零件拉开，单模型没有可分解的装配关系', { tool: 'generate_structure_figure' })
  }
  if (exploded && details.length > 0) {
    throw new PatentToolError('invalid_tool_input', 'exploded 与 details 不能同时使用：放大窗口按模型坐标落在某个基视图上，而分解图每个零件各有一个视图，没有统一的基视图', { tool: 'generate_structure_figure' })
  }
  return {
    deps,
    input,
    cwd,
    outputDir,
    views,
    scale,
    showHidden,
    ...(lineWidthMm === undefined ? {} : { lineWidthMm }),
    hiddenLineStyle,
    baseFigure,
    callouts,
    details,
    modelPaths,
    assembly,
    exploded,
  }
}

/**
 * 逐图投影渲染并读回 manifest。
 *
 * 装配体把所有模型投到同一张图（TechDraw 一次 HLR 处理全部零件）；目录批量逐模型
 * 出图。两种情况都按「图号 = base + 序号」编号，故整案附图顺序与输入顺序一致。
 * @param run - the resolved run parameters.
 * @param signal - the tool call's cancellation signal.
 * @returns one view record per figure, in model-path order.
 */
export async function renderStructureFigures(run: StructureRun, signal: AbortSignal): Promise<StructureFigureView[]> {
  const batches = run.assembly ? [run.modelPaths] : run.modelPaths.map(modelPath => [modelPath])
  const figures: StructureFigureView[] = []
  for (const [index, modelPaths] of batches.entries()) {
    const figureNumber = run.baseFigure + index
    // 每图独立子目录：manifest.json/临时脚本/模板/隔离子目录名固定，避免批量互相覆盖。
    const renderDir = join(run.outputDir, `fig${figureNumber}`)
    const outcome = await run.deps.render({
      modelPaths,
      views: run.views,
      scale: run.scale,
      showHidden: run.showHidden,
      callouts: run.callouts,
      details: run.details,
      exploded: run.exploded,
      figureNumber,
      outputDir: renderDir,
      signal,
    })
    assertRendered(outcome, 'generate_structure_figure')
    const manifest = await readManifest(outcome.manifestPath)
    await assertViewSvgs(manifest)
    figures.push({
      figureNumber,
      modelPaths,
      paths: manifest.views.map(view => relative(run.cwd, view.path)),
      manifest,
    })
  }
  return figures
}

/**
 * 线宽与线型后处理：逐视图改写 TechDraw 投影片段的线宽分组，并可把隐藏线改成虚线。
 *
 * 放在渲染之后、落版之前：落版只加外层变换组，不改线宽属性；越晚改写，越少步骤
 * 再动同一份文本。缺省参数时该步骤不改写文件（输出与不传参数逐字节一致）。
 * @param args - the run parameters, the rendered figures, and the warning sink.
 */
export async function applyViewLineStyles(args: {
  run: StructureRun
  figures: readonly StructureFigureView[]
  warnings: string[]
}): Promise<void> {
  const { lineWidthMm, hiddenLineStyle, cwd } = args.run
  if (lineWidthMm === undefined && hiddenLineStyle === 'solid') return
  for (const figure of args.figures) {
    for (const viewPath of figure.paths) {
      const path = resolve(cwd, viewPath)
      const styled = applyStructureLineStyle(await readFile(path, 'utf8'), { ...(lineWidthMm === undefined ? {} : { lineWidthMm }), hiddenLineStyle })
      args.warnings.push(...styled.warnings.map(w => `线宽/线型：${viewPath} ${w}`))
      await writeFile(path, styled.svg, 'utf8')
    }
  }
}

/**
 * 装配体几何事实摘要：模型路径、每零件 3D 尺寸与每视图投影占位。
 *
 * 3D 事实（包围盒、体积）与视图无关，取任一普通视图的 `parts` 即可；投影占位按
 * 视图分开收集，因为同一个零件在不同朝向下的占位不同。旧版 manifest 没有
 * `parts` 字段时返回 undefined，调用方据此判断摘要是否可用。
 * @param figures - 本次渲染出的图（装配体只有一条）。
 * @returns 摘要；多图或没有逐零件几何事实时 undefined。
 */
export function structureAssembly(figures: readonly StructureFigureView[]): StructureAssembly | undefined {
  const [first] = figures
  if (first === undefined) return undefined
  // 目录批量逐模型出图时 figures 有多条，摘要只描述其中一条——给了会让调用方
  // 误以为它覆盖全部图，故这种形态不给摘要。
  if (figures.length > 1) return undefined
  const source = first.manifest.views.find(view => view.kind === 'view' && view.parts !== undefined)
  if (source?.parts === undefined) return undefined
  const viewBounds: Record<string, (number[] | null)[]> = {}
  for (const view of first.manifest.views) {
    if (view.kind !== 'view' || view.parts === undefined) continue
    viewBounds[view.name] = view.parts.map(part => part.bounds)
  }
  return {
    modelPaths: [...first.modelPaths],
    parts: source.parts.map(part => ({
      index: part.index,
      /* v8 ignore next -- readManifest rejects an index outside modelPaths */
      path: first.modelPaths[part.index] ?? '',
      bbox3d: part.bbox3d,
      volume: part.volume,
    })),
    viewBounds,
  }
}

/**
 * 由 callouts 还原组件列表（件号 → 名称）；无 callouts 则为纯几何线稿。
 * @param callouts - 已校验的件号锚点。
 * @returns 与 analyze_patent_figure 同构的组件列表。
 */
export function structureComponents(callouts: readonly StructureCalloutInput[]): FigureComponent[] {
  return callouts.map((callout): FigureComponent => ({
    refNumber: callout.numeral,
    name: callout.label ?? '',
    kind: 'mechanical',
    description: callout.label ?? '',
  }))
}

/**
 * 标号表逐图展开：同一标号在每张图各占一行。
 * @param figures - 已渲染的图。
 * @param callouts - 已校验的件号锚点。
 * @returns 逐图展开的标号映射表。
 */
export function structureNumeralMap(
  figures: readonly StructureFigureView[],
  callouts: readonly StructureCalloutInput[],
): GenerateStructureFigureOutput['numeralMap'] {
  return figures.flatMap(figure =>
    callouts.map(callout => ({
      componentId: callout.numeral,
      label: callout.label ?? '',
      numeral: callout.numeral,
      figure: figure.figureNumber,
    })),
  )
}

/**
 * 组装附图说明（「图N是…；图中：…」）与去重后的标号文本。
 * @param args - the rendered figures, their numeral map, and the invention name.
 * @returns the description sentence and the numeral text the index analysis reuses.
 */
export function describeStructureFigures(args: {
  figures: readonly StructureFigureView[]
  numeralMap: GenerateStructureFigureOutput['numeralMap']
  inventionName: string | undefined
}): { figureDescription: string; numeralText: string } {
  const sentences = args.figures.map(figure => figureSentence(figure.figureNumber, FIGURE_TYPE_NAMES.structure, args.inventionName))
  const numeralText = [...new Map(args.numeralMap.filter(m => m.label !== '').map(m => [m.numeral, `${m.numeral}-${m.label}`])).values()].join('，')
  const figureDescription = numeralText === ''
    ? `${sentences.join('；')}。`
    : `${sentences.join('；')}；图中：${numeralText}。`
  return { figureDescription, numeralText }
}

/**
 * 落版：给定目标法域时把每个视图 SVG 落到该法域幅面，并按 fit_to_page 决定是否改写画布。
 * @param args - the resolved run parameters, the rendered figures, and the warning sink.
 * @returns the layout of the last placed view; undefined without target_office.
 * @throws PatentToolError when the sheet numbering is outside what the office writes.
 */
export async function applyStructureLayout(args: {
  run: StructureRun
  figures: readonly StructureFigureView[]
  warnings: string[]
}): Promise<SubmissionLayout | undefined> {
  const { input, cwd } = args.run
  if (input.target_office === undefined) return undefined
  const profile = officeProfile(input.target_office)
  let sheetNumber: string
  try {
    sheetNumber = sheetNumberText(profile, input.sheet_index ?? 1, input.sheet_total ?? 1)
  } catch (error) {
    /* v8 ignore next -- sheetNumberText only throws RangeError */
    throw new PatentToolError('invalid_tool_input', `落版参数非法：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_structure_figure' })
  }
  let layout: SubmissionLayout | undefined
  for (const figure of args.figures) {
    for (const viewPath of figure.paths) {
      const page = buildSubmissionPage({
        drawingSvg: await readFile(resolve(cwd, viewPath), 'utf8'),
        profile,
        caption: input.caption,
        sheetNumber,
      })
      args.warnings.push(...page.warnings.map(w => `落版：${w}`))
      if (input.fit_to_page ?? true) await writeFile(resolve(cwd, viewPath), page.svg, 'utf8')
      layout = {
        office: profile.office,
        pageScale: page.metrics.pageScale,
        placedWidthMm: page.metrics.placedWidthMm,
        placedHeightMm: page.metrics.placedHeightMm,
        /* v8 ignore start -- this layout never passes a body font size, so both character heights are absent */
        ...(page.metrics.charHeightMm === undefined ? {} : { charHeightMm: page.metrics.charHeightMm }),
        ...(page.metrics.reducedCharHeightMm === undefined ? {} : { reducedCharHeightMm: page.metrics.reducedCharHeightMm }),
        /* v8 ignore stop */
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        sheetNumber,
      }
    }
  }
  return layout
}


/**
 * 文字转路径：把每个视图 SVG 里的 `<text>` 换成轮廓路径（Config.figureTextToPath）。
 *
 * 放在落版之后：落版会改写坐标与画布，先转的路径还得再被改写一次；转完不再有步骤解析
 * 文件（索引只记路径）。结构线稿只有 SVG 产物，故不需要按格式分支——图面文字的字体依赖
 * 与 `generate_patent_figure` 的两条绘图通路同理。
 * @param args - the run parameters, the rendered views, and the caller's cancel signal.
 * @throws PatentToolError 转换失败时（not_installed → setup_required，其余 → tool_execution_failed）。
 */
export async function outlineStructureViews(args: {
  run: StructureRun
  figures: readonly StructureFigureView[]
  signal: AbortSignal
}): Promise<void> {
  const outline = args.run.deps.outlineText
  if (outline === undefined) return
  for (const figure of args.figures) {
    for (const viewPath of figure.paths) {
      assertRendered(await outline({ path: resolve(args.run.cwd, viewPath), signal: args.signal }), 'generate_structure_figure')
    }
  }
}
