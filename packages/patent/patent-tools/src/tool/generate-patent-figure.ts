/**
 * `generate_patent_figure` tool: 从结构化描述生成专利风格附图。
 *
 * 组合链：dot-builder（DOT 构建，默认黑白线条、semantic 可选彩色）→
 * graphviz-renderer（dot CLI 子进程渲染）→ 返回标号映射表与「图N是…；
 * 图中：…」附图说明文字，并按 persist_index 写入既有附图索引
 * （figureIndexStore），使生成图可被 search_patent_figure 检索、被
 * analyze_patent_figure 回读核验。矢量图型（电路/曲线/剖视/时序/外观）不经
 * Graphviz，由 vector-figure-build 直接绘制 SVG。
 *
 * 移植自 Claude-Patent-Creator 的 diagram_generator / add_references
 * 思路（MIT，见包 README 归属）。风格依据《专利审查指南》第一部分第一章
 * 4.3（2023 修订）：「附图一般使用黑色墨水绘制，必要时可以提交彩色附图」。
 *
 * 输入词汇与归一在 `figure-input.ts`，DOT 构建与标注在 `figure-render-plan.ts`，
 * 落版在 `figure-submission.ts`，结果组装在 `figure-output.ts`，输入 schema 在
 * `figure-tool-schemas.ts`，多面板路径在 `figure-panels.ts`，交付链在
 * `figure-delivery.ts`，共享运行参数在 `figure-run.ts`；本模块持有 schema 门面与
 * 单图执行路径。
 * @module @deepseek-ai/dsh-patent-tools/tool/generate-patent-figure
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { DIAGRAM_TEMPLATE_NAMES, DOT_ENGINES, DOT_FORMATS, DotBuildError, resolvePageBundle } from '../figure/dot-builder.ts'
import type { DotFormat, HierarchyNode } from '../figure/dot-builder.ts'
import { recordList, recordString } from './internal/json-read.ts'
import { sanitizeDotFilename } from '../figure/graphviz-renderer.ts'
import { TARGET_OFFICES } from '../figure/office-profile.ts'
import { buildVectorFigure, isVectorFigureType } from '../figure/vector-figure-build.ts'
import { VectorFigureError, vectorFigureSvg } from '../figure/vector-figure.ts'
import { SectionSourceError, expandSectionSource } from '../figure/section-source.ts'
import type { SectionSourceExpansion } from '../figure/section-source.ts'
import { figureWordingWarnings } from '../figure/wording-rules.ts'
import { FIGURE_TYPES } from './analyze-patent-figure.ts'
import { assertViewName, collectComponents, collectFigureWording, dotDocumentTitle, inferFigureType, readNumerals, resolveFamilySeeds, toFigureType, vectorTitle } from './figure-input.ts'
import type { DotFigureType, GeneratePatentFigureDeps, GeneratePatentFigureInput, GeneratePatentFigureOutput, NormalizedFigureInput, StructuralFigureInput } from './figure-input.ts'
import type { SectionFigureJson } from '../figure/vector-figure-build.ts'
import { buildOutput, indexAnalysis, renderGenerateFigureResult, upsertFigureIndex } from './figure-output.ts'
import { annotateRenderedSvg, buildFigureDot } from './figure-render-plan.ts'
import {
  APPEARANCE_INPUT_SCHEMA,
  BLOCK_SCHEMA,
  CIRCUIT_INPUT_SCHEMA,
  CONNECTION_SCHEMA,
  LAYOUT_SCHEMA,
  PANEL_SCHEMA,
  PLOT_INPUT_SCHEMA,
  SECTION_INPUT_SCHEMA,
  SEQUENCE_INPUT_SCHEMA,
  STATE_SCHEMA,
  STEP_SCHEMA,
  TRANSITION_SCHEMA,
  TREE_SCHEMA,
} from './figure-tool-schemas.ts'
import { COMPONENT_SCHEMA, NUMERAL_MAP_SCHEMA } from './internal/figure-schemas.ts'
import { assertRendered, sectionSourceError } from './internal/render-outcome.ts'
import { WARNINGS_SCHEMA } from './internal/tool-output.ts'
import { assignFigureNumerals, resolveFontPt } from './figure-run.ts'
import type { FigureContext } from './figure-run.ts'
import { generatePanels } from './figure-panels.ts'
import { finishDirectRender, finishSvgChain, needsSvgChain, stampDotDocumentTitle } from './figure-delivery.ts'
import { resolveFigureWriteDir } from './figure-write-dir.ts'

const DESCRIPTION = [
  '生成专利风格附图：流程图（方法步骤）、状态图（状态+转移条件）、系统框图（组件+连接）、组件层级图，以及直接绘制 SVG 的电路图、曲线图/坐标图、剖视图（含剖面线与剖切符号）、时序图、外观设计六面视图排布；另有内置模板与原始 DOT。未配置 figureOutputDir 时，输出 SVG/PNG/PDF 到案卷目录的 04-撰写/；显式 figureOutputDir 按其路径写出。返回参考标号映射表与「图N是…；图中：…」格式的附图说明文字。撰写权利要求/说明书需要配图时使用。',
  '',
  '标号体系：每图独立 100 系列（FIG.1=100-199、FIG.2=200-299，默认步进 2，可调）；同一组件跨图出现时用 numerals 显式传入沿用同号，或声明 figure_family 自动续号（同名组件沿用既有标号、新组件取空闲号；缺省每图独立编号）。',
  '',
  '图型推断：figure_type 缺省时从唯一结构输入推断（steps→流程图、states→状态图、blocks→框图、tree→层级图、dot→原始 DOT、template→模板）；同时提供多个结构输入或全空时须显式指定 figure_type。',
  '',
  '视图名：可选 view_name 只替换 SVG 文档标题和附图说明句里的图型名。省略或空白时字符串不变（剖视图仍是「剖视图」）。传入时不改 figure_type、不改几何，也不改 Graphviz 节点里的标题。不能含换行，去掉首尾空白后不超过 200 个字符。',
  '',
  '多面板：panels 一次生成 FIG.1A/1B 等多张面板（每面板独立文件 figN+后缀，如 A → fig1A.svg），全部面板组件共享一条连续标号系列，附图说明合并输出。',
  '',
  '色彩策略：默认 grayscale（黑白线条，符合《专利审查指南》第一部分第一章 4.3「附图一般使用黑色墨水绘制」）；semantic 模式允许按块类型填充颜色，仅当色彩承载技术内容时使用；target_office="pct" 时 semantic 被拒绝（PCT 实施细则 11.13(a) 规定附图不得着色）。',
  '',
  '输出格式：默认 svg。png/pdf 在需要落版（给了 target_office）时走「先出 SVG → 落版 → 渲染复核 → 文字转路径 → 用本机 Inkscape 导出」的全链，故落版、复核与引线标号对它们同样生效；本机没有 Inkscape 时退回渲染器直接出图，并给出「落版与复核未生效」的警告。直绘图型（电路/曲线/剖视/时序/外观）只有 SVG 一条绘图通路，导出 png/pdf 同样需要 Inkscape。含中文的图导出 pdf 时要先开启文字转路径（Config.figureTextToPath）——Inkscape 对个别未转路径的中文字形会写出缺 xref 的不完整 PDF，工具检出后按导出失败处理，不交出半成品。',
  '',
  '落版：给定 target_office（cnipa/pct/uspto）时，按该法域的 A4 幅面与页边距把图形落版为固定幅面附图页——图号按法域写法（图1 / Fig. 1 / FIG. 1）画在图形正下方（附图两幅以上才编号，单幅不编号），页码按法域写法（中国「第2页 共3页」，单页「第2页」；PCT/USPTO「2/3」）画在版心底部；同时返回落版缩放比、落版尺寸与字高（含缩小至三分之二后的字高）并核算合规项。fit_to_page=false 时只核算尺寸、不改写画布。sheet_number 默认 true；false 时不画页码、不警告。未给 target_office 时该开关无效果，也不报错。',
  '',
  '引线标号：框图/层级图 SVG 默认以「数字+引线指向部件」标注（leader_lines 可关闭），流程图默认保留步骤内嵌 NNN. 前缀；png/pdf 走导出全链时引线随中间 SVG 一起进最终产物，否则不支持并返回警告、保持内嵌标号；直绘图型（电路/曲线/剖视/时序/外观）的标号由输入决定，对它们传 leader_lines 会返回「不生效」警告——剖视图用 sections.labels 给出标号落点与引线起点。引线与标号随图面一起落在画布内，并避开图内已绘的边线与箭头；无引线空间时退化为内嵌标号。',
  '',
  '剖视图要素：sections 直接给出零件轮廓与剖面线，并可给 labels（数字在轮廓外、引线自零件引出且止于数字外框）、centerlines（细点划线，不要用细长多边形伪造）、break_lines（断裂线：长零件省略中段时在被断开的两端各画一条细实线，零件拆成两段轮廓给出）、label_font_size_mm（图面字号）与 hatch: "none"（该轮廓不是被剖切实体，只画轮廓）。线宽按 GB/T 4457.4 指定：stroke_width_mm 与 thin_stroke_width_mm 给出图级的粗实线（轮廓、剖切位置线，默认 0.5）与细实线（剖面线、中心线、引线，默认 0.25），零件自己的 parts[].stroke_width_mm 覆盖图级粗线宽（薄壁件加粗时用）；取值不得低于 0.18 毫米。sections 也可传 JSON 文件路径。生成后按渲染复核量测图面（标号是否被线条贯穿或与图线净距不足、点划线是否被实线覆盖、相邻零件剖面线是否可区分、内容是否越出画布）；标号净距只对剖视图开启（1.5 毫米），电路图、曲线图这类「文字贴着符号放」的图型不套用。',
  '',
  'CAD 剖视（sections.source）：复杂件不必手算轮廓——给 model_path（STEP/IGES/BREP）与剖切平面 plane（origin 平面内一点、normal 法向、可选 reference 图面「向右」基准）即由本机 FreeCAD 切出闭合轮廓与剖面线；返回的提示里给出切出的材料区域清单（净面积与图面范围），parts 仍按区域逐个给 label、hatch 与 stroke_width_mm，并用 anchor（落在该区域内的一个图面坐标点）把它与区域对上——区域顺序由 OCCT 决定，不能用序号对。剖面线由模型按区域（含孔）精确裁出，孔里不会被打上；source.scale 缩放图面（默认 1），labels/centerlines/cutting_marks 请给同一比例下的图面坐标。给 part_size_mm 会与模型包围盒比对，不符即报错（挡住模型单位读错导致的整体比例错误）。需要本机安装 FreeCAD 1.1+。',
  '',
  '图面用语检查：生成后按《专利法实施细则》第二十一条与《专利审查指南》第一部分第一章 4.3 检查图面词语与标号——非必需注释（注释前缀/正文引用/尺寸标注/句末标点）、非中文词语（缩写与数字符号除外）、非阿拉伯数字标号各出一条警告；只提示，不改写输入。',
  '',
  '本机未安装 Graphviz 时返回 setup_required 与安装引导。',
].join('\n')

/** 单图一次渲染的参数：渲染器、文件命名、标号与引线。 */
type SingleFigureRun = {
  context: FigureContext
  figureNumber: number
  outputDir: string
  fontName: string
  fontPt: number | undefined
  numeralsForBuilder: Record<string, string>
  leaderLinesActive: boolean
}

/** 文件形式已解析的单图输入：`sections` 恒为对象（字符串形式在归一前读入）。 */
type ResolvedFigureInput = Omit<GeneratePatentFigureInput, 'sections'> & { sections?: SectionFigureJson }

/**
 * 校验 `sections` 的 JSON 值形状（文件形式的边界校验）：必须是 JSON 对象。
 * @param value - 解析后的 JSON 值。
 * @param source - 报错用的文件路径。
 * @throws PatentToolError 值不是 JSON 对象时。
 */
function assertSectionsValue(value: unknown, source: string): asserts value is SectionFigureJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PatentToolError('invalid_tool_input', `sections 文件内容不是 JSON 对象：${source}`, { tool: 'generate_patent_figure' })
  }
}

/**
 * 解析 `sections` 的文件形式：字符串时按 cwd 读 JSON 文件，并用与内联对象同一套
 * 参数校验（`validateArgs` + 同一 schema）核一遍 —— 两条路径的接受范围与报错一致。
 * @param input - the model-supplied input.
 * @param cwd - 相对路径基准。
 * @returns 输入本身，或 `sections` 已换成文件内容的那份输入。
 * @throws PatentToolError 文件缺失（file_not_found）、非 JSON 或不符合剖视图输入时。
 */
function readHierarchy(value: unknown): HierarchyNode {
  const id = recordString(value, 'id')
  const label = recordString(value, 'label')
  /* v8 ignore next -- the parameter schema requires id and label on every node before execute. */
  if (id === undefined || label === undefined) {
    throw new PatentToolError('invalid_tool_input', '层级节点必须包含 id 和 label', { tool: 'generate_patent_figure' })
  }
  const children = recordList(value, 'children')
  return { id, label, ...(children.length > 0 ? { children: children.map(readHierarchy) } : {}) }
}

async function resolveSectionsFile(
  input: GeneratePatentFigureInput,
  cwd: string,
): Promise<ResolvedFigureInput> {
  const { sections, ...rest } = input
  if (typeof sections !== 'string') return sections === undefined ? rest : { ...rest, sections }
  let raw: string
  try {
    raw = await readFile(resolve(cwd, sections), 'utf8')
  } catch {
    throw new PatentToolError('file_not_found', `sections 文件不存在或不可读：${sections}`, { tool: 'generate_patent_figure' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PatentToolError(
      'invalid_tool_input',
      /* v8 ignore next -- JSON.parse only rejects with Error values */
      `sections 文件不是合法 JSON：${sections}（${error instanceof Error ? error.message : String(error)}）`,
      { tool: 'generate_patent_figure' },
    )
  }
  assertSectionsValue(parsed, sections)
  const violations = validateArgs({ sections: SECTION_INPUT_SCHEMA }, { sections: parsed })
  if (violations.length > 0) {
    throw new PatentToolError(
      'invalid_tool_input',
      `sections 文件内容不符合剖视图输入：${violations.slice(0, 3).join('；')}`,
      { tool: 'generate_patent_figure' },
    )
  }
  return { ...rest, sections: parsed }
}

/**
 * 单图路径：归一化输入、分配标号、渲染、组装结果并写索引。
 * @param input - the model-supplied input.
 * @param context - the resolved run parameters.
 * @returns the single-figure output.
 */
async function generateSingleFigure(
  input: ResolvedFigureInput,
  context: FigureContext,
): Promise<GeneratePatentFigureOutput> {
  const { deps, cwd, format } = context
  const outputDir = resolveFigureWriteDir(deps, cwd, input.case_id, 'generate_patent_figure')
  const figureNumber = input.figure_number ?? 1
  const expanded = await withSectionSource(normalizeSingleFigure(input), {
    deps,
    cwd,
    outputDir,
    figureNumber,
    signal: context.signal,
  })
  const normalized = expanded.input
  const vector = isVectorFigureType(normalized.figure_type)
  // 非 SVG 交付走 SVG 全链：中间产物是 SVG，落版/复核/转路径在其上生效，最后导出。
  const chain = needsSvgChain({
    figureType: normalized.figure_type,
    format,
    targetOffice: normalized.target_office,
    exportAvailable: deps.exportFigure !== undefined,
  })
  const svgCapable = format === 'svg' || chain
  // 引线标号默认按图型：框图/层级图开、流程图关；落在 SVG 上，全链时随中间 SVG 一起进最终产物。
  const leaderLines = normalized.leader_lines ?? (normalized.figure_type === 'block_diagram' || normalized.figure_type === 'component_hierarchy')
  const leaderLinesActive = leaderLines && svgCapable && !vector
  const components = collectComponents(normalized)
  const fontName = (deps.resolveFont ?? ((): string => 'Helvetica'))(components.map(c => c.label))

  // 跨图续号种子 + 一次分配、双处使用：分配结果同时作为 builder 的显式标号（图面一致）与输出标号表。
  const familySeeds = await resolveFamilySeeds(normalized.figure_family, components, deps)
  const explicit = {
    ...familySeeds.explicit,
    ...readNumerals(normalized.numerals, '顶层'),
  }
  const assignments = assignFigureNumerals({
    ids: components.map(c => c.id),
    figureNumber,
    explicit,
    numeralStart: normalized.numeral_start,
    numeralStep: normalized.numeral_step,
    reserved: familySeeds.reserved,
  })
  const numeralsForBuilder = Object.fromEntries(assignments.map(a => [a.id, a.numeral]))
  const numeralBy = new Map(assignments.map(a => [a.id, a.numeral]))

  /* v8 ignore next -- apply() always injects outputDir; the cwd-relative default stays for standalone library callers */
  await mkdir(outputDir, { recursive: true })
  const rendered = await renderSingleFigure(normalized, {
    context,
    figureNumber,
    outputDir,
    fontName,
    fontPt: resolveFontPt(deps.figureFontMm),
    numeralsForBuilder,
    leaderLinesActive,
  }, chain ? 'svg' : format)

  // 全链时渲染器写出的是中间 SVG，交付路径是同一基名的目标格式。
  const outcomePath = chain ? rendered.path.replace(/\.svg$/, `.${format}`) : rendered.path
  const result = buildOutput(normalized, {
    cwd,
    outcomePath,
    figureNumber,
    format,
    engine: context.engine,
    figureType: toFigureType(normalized.figure_type),
    numeralBy,
    ...(normalized.view_name === undefined ? {} : { viewName: normalized.view_name }),
  })
  if (leaderLines && !leaderLinesActive) {
    result.warnings.push(vector
      ? `引线标号（leader_lines）对直绘图型（${normalized.figure_type}）不生效：本图型的标号由输入决定——剖视图用 sections.labels 给出标号落点与引线起点`
      : `引线标号仅支持 SVG 矢量输出；本次 ${format} 保持内嵌标号`)
  } else if (leaderLinesActive) {
    await annotateRenderedSvg(rendered.path, result.numeralMap, result.warnings)
  }
  result.warnings.push(...expanded.warnings)
  result.warnings.push(...rendered.vectorWarnings)
  result.warnings.push(...figureWordingWarnings(
    rendered.vectorLabels ?? collectFigureWording(normalized),
    result.numeralMap.map(entry => entry.numeral),
  ))
  const documentTitle = vector
    ? undefined
    : dotDocumentTitle(normalized.invention_name, toFigureType(normalized.figure_type), normalized.view_name)
  await stampDotDocumentTitle(rendered.path, chain ? 'svg' : format, documentTitle)
  if (chain) {
    const outcome = await finishSvgChain({
      deps,
      svgPath: rendered.path,
      outcomePath: result.absolutePath,
      input: normalized,
      suffix: '',
      format,
      figureType: normalized.figure_type,
      dpi: normalized.dpi ?? deps.dpi,
      style: context.style,
      signal: context.signal,
      output: result,
      hasDirectRender: !vector,
    })
    if (outcome === 'fallback') {
      // 直绘通路：按请求的格式重新渲染一次，交付物与不带 target_office 时逐字节相同。
      const direct = await renderSingleFigure(normalized, {
        context,
        figureNumber,
        outputDir,
        fontName,
        fontPt: resolveFontPt(deps.figureFontMm),
        numeralsForBuilder,
        leaderLinesActive: leaderLines && !vector,
      }, format)
      await stampDotDocumentTitle(direct.path, format, documentTitle)
      await finishDirectRender({
        deps,
        outcomePath: direct.path,
        input: normalized,
        suffix: '',
        format,
        check: false,
        figureType: normalized.figure_type,
        style: context.style,
        signal: context.signal,
        output: result,
      })
    }
  } else {
    await finishDirectRender({
      deps,
      outcomePath: rendered.path,
      input: normalized,
      suffix: '',
      format,
      // SVG 交付物总能复核；png/pdf 直绘没有可量测的图面。
      check: vector || format === 'svg',
      figureType: normalized.figure_type,
      style: context.style,
      signal: context.signal,
      output: result,
    })
  }
  let indexed = false
  if ((normalized.persist_index ?? true) && deps.upsertIndex !== undefined) {
    indexed = await upsertFigureIndex({
      upsertIndex: deps.upsertIndex,
      imagePath: result.path,
      analysis: indexAnalysis(result, context.style, normalized.figure_family),
      warnings: result.warnings,
      label: '',
    })
  }
  return { ...result, indexed }
}

/**
 * 补全单图输入的缺省字段：树/嵌套结构在 schema 层只做了形状约束，此处窄化为领域类型后统一下传；
 * 图型显式优先，缺省从唯一结构输入推断（歧义/为空报 invalid_tool_input，由 inferFigureType 抛出）。
 * @param input - the model-supplied input.
 * @returns the input with every structural field present.
 */
function normalizeSingleFigure(input: ResolvedFigureInput): NormalizedFigureInput {
  const { sections, ...rest } = input
  return {
    ...rest,
    ...(sections === undefined ? {} : { sections }),
    figure_type: input.figure_type ?? inferFigureType(input),
    steps: input.steps ?? [],
    states: input.states ?? [],
    transitions: input.transitions ?? [],
    blocks: input.blocks ?? [],
    connections: input.connections ?? [],
    tree: input.tree ?? [],
  }
}

/**
 * 剖切来源展开：`sections.source` 给出时调 FreeCAD 切出轮廓与剖面线并填回输入。
 *
 * 中间产物（脚本、几何 JSON、`.pat`）落进输出目录下按图号区分的子目录：文件名固定，
 * 同一次调用内多次生成不会互相覆盖，不同图号也不冲突。
 * @param normalized - 已归一的单图输入。
 * @param options - 运行参数（依赖、工作目录、输出目录、图号与取消信号）。
 * @returns 展开后的输入与随结果返回的提示；没有 `source` 时原样返回。
 * @throws PatentToolError 宿主未注入剖切端口（setup_required）、或展开失败（按码映射）时。
 */
async function withSectionSource(
  normalized: NormalizedFigureInput,
  options: {
    deps: GeneratePatentFigureDeps
    cwd: string
    outputDir: string
    figureNumber: number
    signal: AbortSignal
  },
): Promise<{ input: NormalizedFigureInput; warnings: string[] }> {
  const sections = normalized.sections
  if (sections?.source === undefined) return { input: normalized, warnings: [] }
  const ports = options.deps.sectionSource
  if (ports === undefined) {
    throw new PatentToolError(
      'setup_required',
      '剖视图的 sections.source 需要本机 FreeCAD（宿主未挂载 @deepseek-ai/dsh-subprocess，或未找到 freecadcmd）：'
      + '请安装 FreeCAD 1.1+ 后重试，或改用显式 outline 给出轮廓。',
      { tool: 'generate_patent_figure' },
    )
  }
  let expansion: SectionSourceExpansion
  try {
    expansion = await expandSectionSource(sections, {
      ports,
      cwd: options.cwd,
      artifactDir: join(options.outputDir, `.fig${String(options.figureNumber)}-section`),
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof SectionSourceError) throw sectionSourceError(error, 'generate_patent_figure')
    throw error
  }
  return { input: { ...normalized, sections: expansion.sections }, warnings: expansion.warnings }
}

/**
 * 单图渲染：矢量图型直接绘制 SVG（无 Graphviz 依赖），其余图型构建 DOT 交渲染器。
 * @param normalized - the normalized single-figure input.
 * @param run - the render parameters resolved for this call.
 * @param renderFormat - the format to render (the SVG chain renders SVG and exports afterwards).
 * @returns the rendered path with the vector path's labels and warnings.
 */
async function renderSingleFigure(
  normalized: NormalizedFigureInput,
  run: SingleFigureRun,
  renderFormat: DotFormat,
): Promise<{ path: string; vectorLabels: readonly string[] | undefined; vectorWarnings: readonly string[] }> {
  const { deps, engine, style, signal } = run.context
  const filename = normalized.filename ?? `fig${run.figureNumber}`
  // 两条通路：矢量图型直接绘制 SVG（无 Graphviz 依赖）；其余图型构建 DOT 交渲染器。
  if (isVectorFigureType(normalized.figure_type)) {
    if (renderFormat !== 'svg') {
      throw new PatentToolError('invalid_tool_input', `${normalized.figure_type} 是 SVG 直绘图型，仅支持 format="svg"`, { tool: 'generate_patent_figure' })
    }
    let build
    try {
      // 部署级剖视要求（Config.figureRequireCuttingMarks）在模型未给工具参数时生效：
      // 本所要求剖视图一律标注剖切平面位置与投射方向，模型不必逐次记住该参数。
      const requiresCuttingMarks = normalized.require_cutting_marks ?? deps.requireCuttingMarks
      build = buildVectorFigure(normalized.figure_type, {
        ...normalized,
        ...(requiresCuttingMarks === undefined ? {} : { require_cutting_marks: requiresCuttingMarks }),
        ...(deps.figureFontMm === undefined ? {} : { defaultFontMm: deps.figureFontMm }),
      })
    } catch (error) {
      /* v8 ignore start -- buildVectorFigure only throws VectorFigureError; keep the rethrow loud for invariant drift */
      if (error instanceof VectorFigureError) {
        throw new PatentToolError('invalid_tool_input', `${normalized.figure_type} 输入校验失败：${error.message}`, { tool: 'generate_patent_figure' })
      }
      throw error
      /* v8 ignore stop */
    }
    const path = join(run.outputDir, `${sanitizeDotFilename(filename)}.svg`)
    const svg = vectorFigureSvg(
      build.spec,
      vectorTitle(normalized.invention_name, toFigureType(normalized.figure_type), normalized.view_name),
    )
    await writeFile(path, svg, 'utf8')
    return { path, vectorLabels: build.spec.labels, vectorWarnings: [...build.warnings] }
  }
  const dotInput: StructuralFigureInput & { figure_type: DotFigureType } = { ...normalized, figure_type: normalized.figure_type }
  let dot: string
  try {
    // per-call 覆盖部署默认；四项全缺省时不输出任何布局属性（零回归）。
    const pageBundle = resolvePageBundle({
      pageSize: normalized.page_size ?? deps.pageSize,
      orientation: normalized.orient ?? deps.orientation,
      dpi: normalized.dpi ?? deps.dpi,
      marginCm: normalized.margin ?? deps.marginCm,
    })
    dot = buildFigureDot(dotInput, {
      figureNumber: run.figureNumber,
      numeralsForBuilder: run.numeralsForBuilder,
      numeralStep: normalized.numeral_step,
      style,
      fontName: run.fontName,
      fontPt: run.fontPt,
      pageBundle,
      leaderLinesActive: run.leaderLinesActive,
    })
  } catch (error) {
    /* v8 ignore start -- builders only throw DotBuildError; keep the rethrow loud for invariant drift */
    if (error instanceof DotBuildError) {
      throw new PatentToolError('invalid_tool_input', `附图内容校验失败：${error.message}`, { tool: 'generate_patent_figure' })
    }
    throw error
    /* v8 ignore stop */
  }
  const outcome = await deps.render({
    dot,
    filename,
    format: renderFormat,
    engine,
    outputDir: run.outputDir,
    signal,
  })
  assertRendered(outcome, 'generate_patent_figure')
  return { path: outcome.path, vectorLabels: undefined, vectorWarnings: [] }
}

/**
 * Build the `generate_patent_figure` tool over injected renderer.
 * @param deps - renderer + optional output dir / index upsert / cwd / font resolver.
 * @returns a registry-ready tool definition.
 */
export function createGeneratePatentFigureTool(deps: GeneratePatentFigureDeps): ToolDefinition {
  return defineTool({
    name: 'generate_patent_figure',
    description: DESCRIPTION,
    parameters: {
      figure_type: {
        type: 'string',
        enum: ['flowchart', 'state_diagram', 'block_diagram', 'component_hierarchy', 'circuit', 'plot', 'cross_section', 'sequence_diagram', 'appearance_view', 'raw_dot', 'template'],
        description: '图型；缺省时从唯一结构输入推断（steps→flowchart、states→state_diagram、blocks→block_diagram、tree→component_hierarchy、circuit/plot/sections/sequence/appearance_views→同名图型、dot→raw_dot、template→template），多输入或无输入须显式指定',
      },
      steps: { type: 'array', items: STEP_SCHEMA, description: '流程图步骤（figure_type=flowchart 时必填）' },
      states: { type: 'array', items: STATE_SCHEMA, description: '状态图状态（figure_type=state_diagram 时必填）' },
      transitions: { type: 'array', items: TRANSITION_SCHEMA, description: '状态转移（state_diagram；端点必须存在于 states）' },
      circuit: { ...CIRCUIT_INPUT_SCHEMA, description: '电路图输入（figure_type=circuit 时必填）：元件按网格行列放置，连线正交走线，T 形结点画实心连接点' },
      plot: { ...PLOT_INPUT_SCHEMA, description: '曲线图/坐标图输入（figure_type=plot 时必填）：坐标轴 + 刻度 + 单位 + 多条序列（用标记形状区分，不用颜色）' },
      sections: {
        oneOf: [SECTION_INPUT_SCHEMA, { type: 'string' }],
        description: '剖视图输入（figure_type=cross_section 时必填）：零件轮廓 + 45° 剖面线（相邻件方向相反或间距不等）+ 引线标号 + 中心线 + 剖切位置符号；也可传指向含该对象的 JSON 文件的路径（工作区相对或绝对），大块坐标放文件里就不必每次重渲染都内联。复杂件用 sections.source 从 CAD 模型（STEP/IGES/BREP）切出轮廓与剖面线，parts 只给 label/hatch/anchor',
      },
      sequence: { ...SEQUENCE_INPUT_SCHEMA, description: '时序图输入（figure_type=sequence_diagram 时必填）：参与者生命线 + 消息箭线' },
      appearance_views: { ...APPEARANCE_INPUT_SCHEMA, description: '外观设计视图排布输入（figure_type=appearance_view 时必填）：把调用方提供的六面视图片段按第一角投影排布并统一比例、逐视图标注视图名称' },
      blocks: { type: 'array', items: BLOCK_SCHEMA, description: '框图块（figure_type=block_diagram 时必填）' },
      connections: {
        type: 'array',
        items: CONNECTION_SCHEMA,
        description: '框图连接（block_diagram）',
      },
      tree: {
        type: 'array',
        items: TREE_SCHEMA,
        description: '组件层级树（component_hierarchy，任意深度）',
      },
      template: {
        type: 'string',
        enum: DIAGRAM_TEMPLATE_NAMES,
        description: '内置模板（figure_type=template 时必填）：simple_flowchart/system_block/method_steps/component_hierarchy',
      },
      dot: { type: 'string', description: '原始 Graphviz DOT（figure_type=raw_dot）；须自包含：不接受 image/shapefile/fontpath 等文件引用属性' },
      panels: { type: 'array', items: PANEL_SCHEMA, description: '多面板模式：一次生成多张共享标号系列的面板（fig1A/fig1B…）；与顶层结构输入互斥，列表不可为空' },
      case_id: {
        type: 'string',
        description: '案号。未设置 figureOutputDir 时与 workbenchCaseRoot 一起选定案卷目录，附图写入该目录的 04-撰写/。',
      },
      figure_number: { type: 'integer', description: '图号，默认 1（决定标号系列起点）' },
      invention_name: { type: 'string', description: '发明名称（附图说明模板句）' },
      view_name: {
        type: 'string',
        description: '视图名（可选）。省略或空白时标题与附图说明仍用图型名（剖视图仍是「剖视图」）；传入时只替换该视图名，不改图型与几何。不能含换行，去掉首尾空白后不超过 200 个字符',
      },
      numerals: { type: 'object', additionalProperties: true, description: '显式标号（组件 id → 标号；标号可为字符串或数字，其他类型会被拒绝；跨图同件同号续接）' },
      numeral_start: { type: 'integer', description: '自动标号系列起点覆盖' },
      numeral_step: { type: 'integer', description: '标号步进，默认 2' },
      figure_family: { type: 'string', description: '发明家族标识（跨图续号）：声明后同名组件沿用既有标号、新组件续接空闲号；缺省每图独立编号' },
      style: { type: 'string', enum: ['grayscale', 'semantic'], description: '色彩策略，默认 grayscale' },
      filename: { type: 'string', description: '输出文件名（不含扩展名）' },
      format: { type: 'string', enum: DOT_FORMATS, description: '输出格式，默认 svg；png/pdf 在给定 target_office（或图型只有 SVG 通路）时经本机 Inkscape 从 SVG 全链导出，缺 Inkscape 时退回渲染器直接出图' },
      engine: { type: 'string', enum: DOT_ENGINES, description: '布局引擎，默认 dot' },
      page_size: { type: 'string', enum: ['a4', 'letter'], description: '页面尺寸（提交规格）；默认取部署配置' },
      orient: { type: 'string', enum: ['portrait', 'landscape'], description: '页面方向；默认 portrait，取部署配置' },
      dpi: { type: 'integer', description: '渲染分辨率（png 栅格生效）；默认取部署配置' },
      margin: { type: 'number', description: '页边距（厘米，四边同值）；默认取部署配置' },
      leader_lines: { type: 'boolean', description: '引线标号（数字置于部件外侧并以引线相连，仅 SVG 生效）；默认框图/层级图开启、流程图关闭' },
      target_office: {
        type: 'string',
        enum: TARGET_OFFICES,
        description: '目标法域：给定时按该法域的 A4 幅面、页边距、图号写法（图1/Fig. 1/FIG. 1）把图形落版为固定幅面附图页，并核算落版字高与色彩合规；png/pdf 需经 Inkscape 全链导出才会落版',
      },
      figure_count: { type: 'integer', description: '本案附图总数（默认 1）：两幅以上才逐幅标注图号（中国指南 4.3、PCT 11.13(k)、37 CFR 1.84(u)）' },
      sheet_index: { type: 'integer', description: '附图页序号，默认 1' },
      sheet_total: { type: 'integer', description: '附图页总数，默认 1（PCT/USPTO 页码写作「序号/总数」）' },
      sheet_number: { type: 'boolean', description: '是否编页码，默认 true。false 时不画页码、不警告；未给 target_office 时无效果，也不报错' },
      caption: { type: 'string', description: '图号文字覆盖（缺省按目标法域生成；panels 模式自动追加面板后缀，如 图1A / Fig. 1A）' },
      abstract_figure: { type: 'boolean', description: '本幅是否为请求书指定的摘要附图（默认 false）：true 时按缩小到 40×60 毫米核算可辨度量并给出 warning' },
      fit_to_page: { type: 'boolean', description: '默认 true：把图形落版到目标法域幅面（SVG，或经 Inkscape 全链导出的 png/pdf）；false 时只核算尺寸、不改写画布' },
      caption_font_mm: { type: 'number', description: '图号字高（毫米，默认 4）；目标法域对图面文字有最小字高要求时用它调大，须为正数' },
      caption_gap_mm: { type: 'number', description: '图号与图形之间的间距（毫米，默认 3），须为正数' },
      sheet_font_mm: { type: 'number', description: '附图页页码字高（毫米，默认 3），须为正数' },
      rotate_deg: { type: 'integer', enum: [0, 90, 180, 270], description: '落版时把图形绕绘图区中心顺时针旋转的角度（默认 0）：横长的图形配竖向版心时用 90，落版宽高随之互换；图号仍落在图形正下方' },
      require_explicit_hatch: { type: 'boolean', description: '剖视图（cross_section）专用，默认 false：true 时每个轮廓都必须显式给出 hatch（不被剖切的写 "none"），否则报错；缺省时未给的轮廓套用默认 45°/3 毫米并返回提示' },
      require_cutting_marks: { type: 'boolean', description: '剖视图（cross_section）专用，默认 false：true 时必须有剖切位置符号（sections.cutting_marks：剖切标记字母 + 剖切位置线 + 投射方向），否则报错；缺省时未给只作提示返回（剖切平面与对称面重合且视图在标准位置时可省略，GB/T 4458.6）' },
      persist_index: { type: 'boolean', description: '默认 true：写入附图索引（供 search_patent_figure 检索）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          absolutePath: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: DOT_FORMATS },
          engine: { type: 'string', required: true, enum: DOT_ENGINES },
          figureNumber: { type: 'integer', required: true },
          figureType: { type: 'string', required: true, enum: FIGURE_TYPES },
          figureDescription: { type: 'string', required: true },
          numeralMap: { type: 'array', required: true, items: NUMERAL_MAP_SCHEMA },
          components: { type: 'array', required: true, items: COMPONENT_SCHEMA },
          connections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                target: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['electrical', 'mechanical', 'data_flow', 'unknown'] },
                description: { type: 'string', required: true },
              },
            },
          },
          warnings: WARNINGS_SCHEMA,
          indexed: { type: 'boolean', required: true },
          layout: { ...LAYOUT_SCHEMA, description: '落版与合规核算结果（给定 target_office 时）' },
          panels: {
            type: 'array',
            description: '多面板摘要（panels 模式）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                suffix: { type: 'string', required: true },
                path: { type: 'string', required: true },
                absolutePath: { type: 'string', required: true },
                figureType: { type: 'string', required: true, enum: FIGURE_TYPES },
                layout: { ...LAYOUT_SCHEMA, description: '面板落版与合规核算结果（给定 target_office 时）' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderGenerateFigureResult(value),
    },
    async execute(args, exec) {
      // schema 校验后的模型 JSON 边界；深层结构（层次树递归）由 build 函数校验。
      const { tree, panels, ...figureArgs } = args
      const cwd = deps.cwd ?? process.cwd()
      const input = await resolveSectionsFile({
        ...figureArgs,
        ...(tree === undefined ? {} : { tree: tree.map(readHierarchy) }),
        ...(panels === undefined ? {} : {
          panels: panels.map((panel) => {
            const { tree: panelTree, ...rest } = panel
            return { ...rest, ...(panelTree === undefined ? {} : { tree: panelTree.map(readHierarchy) }) }
          }),
        }),
      }, cwd)
      assertViewName(input.view_name)
      const format = input.format ?? 'svg'
      const engine = input.engine ?? 'dot'
      const style = input.style === 'semantic' ? 'semantic' : 'grayscale'
      if (input.target_office === 'pct' && style === 'semantic') {
        throw new PatentToolError('invalid_tool_input', 'PCT 附图不得着色（PCT 实施细则 11.13(a)）：target_office="pct" 时请使用 style="grayscale"', { tool: 'generate_patent_figure' })
      }
      const context: FigureContext = { deps, cwd, format, engine, style, signal: exec.signal }
      if (input.panels !== undefined) {
        return generatePanels(input, context)
      }
      return generateSingleFigure(input, context)
    },
  })
}
