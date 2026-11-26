/**
 * 多面板附图路径：FIG.1A/1B 共享一条连续标号系列，逐面板渲染后合并附图
 * 说明、标号表与附图索引。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-panels
 */

import { mkdir } from 'node:fs/promises'
import { PatentToolError } from '../error.ts'
import { DotBuildError, resolvePageBundle } from '../figure/dot-builder.ts'
import type { DotPageBundle, NumeralAssignment } from '../figure/dot-builder.ts'
import { figureSentence } from '../figure/figure-description.ts'
import { figureWordingWarnings } from '../figure/wording-rules.ts'
import { collectComponents, collectFigureWording, dotDocumentTitle, figureViewName, inferFigureType, presentStructuralFields, presentVectorFields, readNumerals, resolveFamilySeeds, toFigureType } from './figure-input.ts'
import type { DotFigureType, GeneratePatentFigureInput, GeneratePatentFigureOutput, GeneratePatentFigurePanelInput, StructuralFigureInput } from './figure-input.ts'
import { buildOutput, indexAnalysis, upsertFigureIndex } from './figure-output.ts'
import { annotateRenderedSvg, buildFigureDot } from './figure-render-plan.ts'
import { assertRendered } from './internal/render-outcome.ts'
import { finishDirectRender, finishSvgChain, needsSvgChain, stampDotDocumentTitle } from './figure-delivery.ts'
import { resolveFigureWriteDir } from './figure-write-dir.ts'
import { assignFigureNumerals, resolveFontPt } from './figure-run.ts'
import type { FigureContext } from './figure-run.ts'

/** 面板的结构输入：面板 schema 已把图型限制为 DOT 图型，此处按该约束收窄。 */
type PanelStructural = StructuralFigureInput & { figure_type: DotFigureType }

/** 一个面板的构建计划：文件后缀、收窄后的图型、引线开关与结构输入。 */
type PanelPlan = {
  suffix: string
  figureType: DotFigureType
  leaderLines: boolean
  structural: PanelStructural
}

/** 多面板一次调用中逐面板复用的数据：标号分配结果、字体与落版参数。 */
type PanelRun = {
  input: GeneratePatentFigureInput
  context: FigureContext
  figureNumber: number
  outputDir: string
  fontName: string
  fontPt: number | undefined
  pageBundle: DotPageBundle | undefined
  assignments: readonly NumeralAssignment[]
}

/**
 * panels 模式：全部面板组件并入一次 assignNumerals（FIG.1A/1B 共享连续系列），
 * 逐面板构建/渲染/标注后合并输出。
 * @param input - the model-supplied input.
 * @param context - the resolved run parameters.
 * @returns the merged output for every panel.
 */
export async function generatePanels(
  input: GeneratePatentFigureInput,
  context: FigureContext,
): Promise<GeneratePatentFigureOutput> {
  const { deps, cwd } = context
  /* v8 ignore next -- execute() only dispatches here with panels present; ?? guards standalone library callers */
  const panels = input.panels ?? []
  assertPanelInput(input, panels)
  const figureNumber = input.figure_number ?? 1
  const panelStructurals = toPanelStructurals(panels, input)
  const allComponents = panelStructurals.flatMap(ps => collectComponents(ps.structural))
  const fontName = (deps.resolveFont ?? ((): string => 'Helvetica'))(allComponents.map(c => c.label))
  const familySeeds = await resolveFamilySeeds(input.figure_family, allComponents, deps)
  // 显式标号优先级：面板 numerals > 顶层 numerals > 家族种子。
  const panelNumerals: Record<string, string> = {}
  for (const panel of panels) {
    for (const [id, numeral] of Object.entries(readNumerals(panel.numerals, `面板 ${panel.suffix}`))) {
      panelNumerals[id] = numeral
    }
  }
  const explicit: Record<string, string> = {
    ...familySeeds.explicit,
    ...readNumerals(input.numerals, '顶层'),
    ...panelNumerals,
  }
  const assignments = assignFigureNumerals({
    ids: allComponents.map(c => c.id),
    figureNumber,
    explicit,
    numeralStart: input.numeral_start,
    numeralStep: input.numeral_step,
    reserved: familySeeds.reserved,
  })
  const pageBundle = resolvePageBundle({
    pageSize: input.page_size ?? deps.pageSize,
    orientation: input.orient ?? deps.orientation,
    dpi: input.dpi ?? deps.dpi,
    marginCm: input.margin ?? deps.marginCm,
  })
  const outputDir = resolveFigureWriteDir(deps, cwd, input.case_id, 'generate_patent_figure')
  await mkdir(outputDir, { recursive: true })
  const run: PanelRun = {
    input, context, figureNumber, outputDir, fontName,
    fontPt: resolveFontPt(deps.figureFontMm), pageBundle, assignments,
  }
  const panelOutputs: { suffix: string; output: GeneratePatentFigureOutput }[] = []
  for (const ps of panelStructurals) {
    panelOutputs.push(await renderPanel(ps, run))
  }
  return mergePanelOutputs({ panelOutputs, panelStructurals, input, context })
}

/**
 * panels 模式的输入约束：与顶层结构输入互斥、列表非空、不接受 filename、后缀限字母数字下划线连字符。
 * @param input - the model-supplied input.
 * @param panels - the supplied panels.
 * @throws PatentToolError for each violated constraint.
 */
function assertPanelInput(input: GeneratePatentFigureInput, panels: readonly GeneratePatentFigurePanelInput[]): void {
  // Vector inputs are not panel fields, and sending one alongside `panels` would
  // otherwise be parsed, validated, and then silently dropped.
  const topLevelFields = [...presentStructuralFields(input), ...presentVectorFields(input)].map(p => p.field)
  if (topLevelFields.length > 0) {
    throw new PatentToolError('invalid_tool_input', `panels 不能与顶层结构输入（${topLevelFields.join('、')}）同时提供`, { tool: 'generate_patent_figure' })
  }
  if (panels.length === 0) {
    throw new PatentToolError('invalid_tool_input', 'panels 不能为空列表', { tool: 'generate_patent_figure' })
  }
  if (input.filename !== undefined) {
    throw new PatentToolError('invalid_tool_input', 'panels 模式按 figN<suffix> 命名输出文件，不接受 filename', { tool: 'generate_patent_figure' })
  }
  const suffixes = new Set<string>()
  for (const panel of panels) {
    if (!/^[A-Za-z0-9_-]+$/.test(panel.suffix)) {
      throw new PatentToolError('invalid_tool_input', `面板后缀只能包含字母/数字/下划线/连字符：${panel.suffix}`, { tool: 'generate_patent_figure' })
    }
    // Compare case-insensitively: fig1A.svg and fig1a.svg are one file on
    // case-insensitive filesystems, so the second panel would overwrite the first.
    const normalized = panel.suffix.toLowerCase()
    if (suffixes.has(normalized)) {
      throw new PatentToolError('invalid_tool_input', `面板后缀重复：${panel.suffix}（每个面板必须使用不同后缀，否则会覆盖同一输出文件）`, { tool: 'generate_patent_figure' })
    }
    suffixes.add(normalized)
  }
}

/**
 * 逐面板解析图型（缺省推断）并构造结构化输入；引线标号按面板图型取默认。
 * @param panels - the supplied panels.
 * @param input - the top-level input the panel fields inherit from.
 * @returns one plan per panel, in supplied order.
 */
function toPanelStructurals(
  panels: readonly GeneratePatentFigurePanelInput[],
  input: GeneratePatentFigureInput,
): PanelPlan[] {
  return panels.map((panel) => {
    // schema 层已把面板图型限制为 DOT 图型（矢量图型字段不在面板 schema 内），此处按该约束收窄。
    const figureType = (panel.figure_type ?? inferFigureType(panel, `面板 ${panel.suffix}`)) as DotFigureType
    return {
      suffix: panel.suffix,
      figureType,
      // 顶层 leader_lines 强制全部面板；缺省按面板图型取默认（框图/层级图开）。
      leaderLines: input.leader_lines ?? (figureType === 'block_diagram' || figureType === 'component_hierarchy'),
      structural: {
        figure_type: figureType,
        steps: panel.steps ?? [],
        states: panel.states ?? [],
        transitions: panel.transitions ?? [],
        blocks: panel.blocks ?? [],
        connections: panel.connections ?? [],
        tree: panel.tree ?? [],
        template: panel.template,
        dot: panel.dot,
        invention_name: input.invention_name,
      } satisfies PanelStructural,
    }
  })
}

/**
 * 面板渲染：按该面板的组件子集取标号，构建并渲染，再标注引线、落版。
 * @param panel - the panel plan.
 * @param run - the data shared by every panel of this call.
 * @returns the panel suffix with its output record.
 */
async function renderPanel(
  panel: PanelPlan,
  run: PanelRun,
): Promise<{ suffix: string; output: GeneratePatentFigureOutput }> {
  const { deps, format } = run.context
  const panelIds = new Set(collectComponents(panel.structural).map(c => c.id))
  const panelAssignments = run.assignments.filter(a => panelIds.has(a.id))
  const numeralsForBuilder = Object.fromEntries(panelAssignments.map(a => [a.id, a.numeral]))
  const numeralBy = new Map(panelAssignments.map(a => [a.id, a.numeral]))
  const chain = needsSvgChain({
    figureType: panel.figureType,
    format,
    targetOffice: run.input.target_office,
    exportAvailable: deps.exportFigure !== undefined,
  })
  const leaderLinesActive = panel.leaderLines && (format === 'svg' || chain)
  let dot: string
  try {
    dot = buildFigureDot(panel.structural, {
      figureNumber: run.figureNumber,
      numeralsForBuilder,
      numeralStep: run.input.numeral_step,
      style: run.context.style,
      fontName: run.fontName,
      fontPt: run.fontPt,
      pageBundle: run.pageBundle,
      leaderLinesActive,
    })
  } catch (error) {
    /* v8 ignore start -- builders only throw DotBuildError; keep the rethrow loud for invariant drift */
    if (error instanceof DotBuildError) {
      throw new PatentToolError('invalid_tool_input', `附图内容校验失败（面板 ${panel.suffix}）：${error.message}`, { tool: 'generate_patent_figure' })
    }
    throw error
    /* v8 ignore stop */
  }
  const outcome = await deps.render({
    dot,
    filename: `fig${run.figureNumber}${panel.suffix}`,
    format: chain ? 'svg' : format,
    engine: run.context.engine,
    outputDir: run.outputDir,
    signal: run.context.signal,
  })
  assertRendered(outcome, 'generate_patent_figure')
  const output = buildOutput(panel.structural, {
    cwd: run.context.cwd,
    outcomePath: chain ? outcome.path.replace(/\.svg$/, `.${format}`) : outcome.path,
    figureNumber: run.figureNumber,
    format,
    engine: run.context.engine,
    figureType: toFigureType(panel.figureType),
    numeralBy,
    suffix: panel.suffix,
    ...(run.input.view_name === undefined ? {} : { viewName: run.input.view_name }),
  })
  if (leaderLinesActive) {
    await annotateRenderedSvg(outcome.path, output.numeralMap, output.warnings)
  }
  const documentTitle = dotDocumentTitle(run.input.invention_name, toFigureType(panel.figureType), run.input.view_name)
  await stampDotDocumentTitle(outcome.path, chain ? 'svg' : format, documentTitle)
  // 全链成功后不再走直绘收尾；失败则按请求的格式重渲染一次，交付物与不带
  // target_office 时逐字节相同（`finishSvgChain` 已把未生效的原因写进警告）。
  let directPath = outcome.path
  const chained = chain && await finishSvgChain({
    deps,
    svgPath: outcome.path,
    outcomePath: output.absolutePath,
    input: run.input,
    suffix: panel.suffix,
    format,
    figureType: panel.figureType,
    dpi: run.input.dpi ?? deps.dpi,
    style: run.context.style,
    signal: run.context.signal,
    output,
    hasDirectRender: true,
    exportDxf: run.input.export_dxf === true,
  }) === 'done'
  if (!chained) {
    if (chain) {
      const direct = await deps.render({
        dot,
        filename: `fig${run.figureNumber}${panel.suffix}`,
        format,
        engine: run.context.engine,
        outputDir: run.outputDir,
        signal: run.context.signal,
      })
      assertRendered(direct, 'generate_patent_figure')
      directPath = direct.path
      await stampDotDocumentTitle(direct.path, format, documentTitle)
    }
    await finishDirectRender({
      deps,
      outcomePath: directPath,
      input: run.input,
      suffix: panel.suffix,
      format,
      check: false,
      figureType: panel.figureType,
      style: run.context.style,
      signal: run.context.signal,
      output,
      exportDxf: run.input.export_dxf === true,
    })
  }
  return { suffix: panel.suffix, output }
}

/**
 * 合并各面板输出：面板句各一句 + 全部面板共用一条「图中」标号表，并写附图索引。
 * @param args - the panel outputs and plans, the top-level input, and the run parameters.
 * @returns the merged tool output.
 */
async function mergePanelOutputs(args: {
  panelOutputs: readonly { suffix: string; output: GeneratePatentFigureOutput }[]
  panelStructurals: readonly PanelPlan[]
  input: GeneratePatentFigureInput
  context: FigureContext
}): Promise<GeneratePatentFigureOutput> {
  const { panelOutputs, panelStructurals, input, context } = args
  const { deps, format, engine, style } = context
  const figureNumber = input.figure_number ?? 1
  const mergedNumerals = panelOutputs.flatMap(po => po.output.numeralMap)
  const sentences = panelOutputs.map(po => figureSentence(
    figureNumber,
    figureViewName(po.output.figureType, input.view_name),
    input.invention_name,
    po.suffix,
  ))
  const sharedNumerals = mergedNumerals.map(m => `${m.numeral}-${m.label}`).join('，')
  const figureDescription = sharedNumerals === ''
    ? `${sentences.join('；')}。`
    : `${sentences.join('；')}；图中：${sharedNumerals}。`
  const warnings = panelOutputs.flatMap(po => po.output.warnings)
  const dxfPaths = panelOutputs.flatMap(po => po.output.dxfPaths ?? [])
  if (panelStructurals.some(ps => ps.leaderLines) && format !== 'svg') {
    warnings.push(`引线标号仅支持 SVG 矢量输出；本次 ${format} 保持内嵌标号`)
  }
  warnings.push(...figureWordingWarnings(
    panelStructurals.flatMap(ps => collectFigureWording(ps.structural)),
    mergedNumerals.map(entry => entry.numeral),
  ))
  let indexed = false
  if ((input.persist_index ?? true) && deps.upsertIndex !== undefined) {
    indexed = true
    for (const po of panelOutputs) {
      // 任一面板写入失败即整体未索引；失败原因由 upsertFigureIndex 记进 warnings。
      if (!await upsertFigureIndex({
        upsertIndex: deps.upsertIndex,
        imagePath: po.output.path,
        analysis: indexAnalysis(po.output, style, input.figure_family),
        warnings,
        label: `面板 ${po.suffix} `,
      })) {
        indexed = false
      }
    }
  }
  /* v8 ignore start -- panels is validated non-empty above, so the first panel always exists */
  return {
    path: panelOutputs[0]?.output.path ?? '',
    absolutePath: panelOutputs[0]?.output.absolutePath ?? '',
    format,
    engine,
    figureNumber,
    figureType: panelOutputs[0]?.output.figureType ?? 'unknown',
    figureDescription,
    numeralMap: mergedNumerals,
    components: panelOutputs.flatMap(po => po.output.components),
    connections: panelOutputs.flatMap(po => po.output.connections),
    warnings,
    indexed,
    ...(dxfPaths.length === 0 ? {} : { dxfPaths }),
    panels: panelOutputs.map(po => ({
      suffix: po.suffix,
      path: po.output.path,
      absolutePath: po.output.absolutePath,
      figureType: po.output.figureType,
      ...(po.output.layout === undefined ? {} : { layout: po.output.layout }),
    })),
  }
  /* v8 ignore stop */
}
