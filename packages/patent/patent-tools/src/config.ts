/**
 * Model-facing patent tool configuration: LLM routes, workflow budgets, knowledge
 * locations, and the figure-rendering deployment knobs.
 * @module @deepseek-ai/dsh-patent-tools/config
 */

import z from '@deepseek-ai/schemastery'
import { SHIPPED_GUIDELINE_REVISION } from '@deepseek-ai/dsh-patent-workflow'
import { STRUCTURE_VIEWS, type StructureViewName } from './figure/freecad-structure-script.ts'
import { DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS } from './figure/graphviz-renderer.ts'
import { DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS } from './figure/inkscape-renderer.ts'
import { DEFAULT_FREECAD_RENDER_TIMEOUT_MS } from './figure/freecad-renderer.ts'
import type { FigureRendererMode } from './figure/render-selector.ts'

/** Model-facing patent plugin configuration: LLM routes, workflow budgets, knowledge locations, and figure knobs. */
export interface Config {
  /** LLM provider route for the LLM-consuming tools (claim_chart_build / workflow run / figure analysis). */
  provider?: string
  /** LLM model id for the LLM-consuming tools. */
  model?: string
  /** Dedicated figure/image model route whose input modalities gate analyze_patent_figure. */
  imageModel?: ImageModelConfig
  /** 知识笔记落盘目录（相对或绝对路径）；默认 <cwd>/99-知识库。 */
  noteDir?: string
  /** Max output tokens for the LLM-consuming tools. */
  maxTokens?: number
  /**
   * 《专利审查指南》version the built-in manifests must target. Defaults to the
   * revision shipped with this repository; a deployment running a different
   * patent-law asset sets this to that asset's `revision`, and a manifest still
   * written against another revision fails plugin load.
   */
  guidelineRevision?: string
  /**
   * Maximum stages a single built-in workflow manifest may declare. Plugin load
   * fails when a manifest exceeds it, so stage-list growth cannot silently
   * increase run cost. Defaults to `DEFAULT_WORKFLOW_STAGE_BUDGET`.
   */
  workflowStageBudget?: number
  /**
   * Maximum model-calling stages a single built-in workflow manifest may
   * declare. Stages without an atom (run by the LLM-backed stage executor) and
   * atoms whose contract declares `usesModel` count. Defaults to
   * `DEFAULT_WORKFLOW_LLM_STAGE_BUDGET`.
   */
  workflowLlmStageBudget?: number
  /** 附图索引文件路径（相对或绝对路径）；默认 <cwd>/.sati/figures-index.json。 */
  figureIndexFile?: string
  /** 化学结构索引文件路径（相对或绝对路径）；默认 <cwd>/.sati/chemistry-index.json。 */
  chemistryIndexFile?: string
  /** Graphviz dot 可执行路径覆盖；默认自动探测（候选路径 + PATH）。 */
  graphvizExecutable?: string
  /** dot CLI 单次渲染超时（毫秒）；默认 60000（慢机/大图可上调）。 */
  graphvizRenderTimeoutMs?: number
  /** 附图渲染引擎：wasm=内置 @viz-js/viz（默认，SVG 零系统依赖）；cli=系统 dot 子进程。png/pdf 在 wasm 模式下自动回退 CLI。 */
  figureRenderer?: FigureRendererMode
  /** 附图分析模式：single=单步（默认，一次模型调用）；two-step=结构抽取+说明生成两次模型调用（成本翻倍，准确率可能更高）。 */
  figureAnalysisMode?: 'single' | 'two-step'
  /** 附图页面尺寸（提交规格）；缺省不输出页面属性。 */
  figurePageSize?: 'a4' | 'letter'
  /** 附图页面方向；缺省 portrait。 */
  figureOrientation?: 'portrait' | 'landscape'
  /** 附图渲染 DPI（png 栅格生效）；缺省不输出 dpi 属性。 */
  figureDpi?: number
  /** 附图页边距（厘米，四边同值）；与 figurePageSize 同给时收缩绘图区 size。 */
  figureMargin?: number
  /** 附图输出目录（相对或绝对路径）；默认 <cwd>/patent/figures/。 */
  figureOutputDir?: string
  /** 附图导出时把图面文字转成轮廓路径；默认 false。开启后 SVG 不再依赖阅读器字体（需要 Inkscape，两个附图生成工具、仅 SVG 生效）。 */
  figureTextToPath?: boolean
  /**
   * 剖视图是否必须给出剖切位置符号（`sections.cutting_marks`）；默认 false。
   * 为 true 时模型未给该参数也按「必须给」处理，缺省即报错（GB/T 4458.6 只在剖切平面
   * 与对称面重合且视图在标准位置时允许省略；本所要求一律标注时设 true）。
   */
  figureRequireCuttingMarks?: boolean
  /**
   * 渲染复核门禁：为 true 时，两个附图生成工具在复核发现除 `not-measured` 外的问题时
   * 判本次生成失败（文件保留供修正，不导出交付件）；默认 false，只把发现折成警告。
   * 非 SVG 直绘通路没有可量测的图面，门禁不生效并给出警告。
   */
  figureFailOnRenderFindings?: boolean
  /**
   * 图面文字字号的部署默认（毫米）：直绘图型的图面字号、DOT 图型的 fontsize 与落版核算
   * 的字高都由它定（小四 = 4.23 毫米、四号 = 4.94 毫米）；模型显式给的字号优先。
   * 必须为正数：0 会让图面文字失去字高，故在加载时由 schema 拒绝。
   */
  figureFontMm?: number
  /**
   * 图面字高内控下限（毫米）；缺省不判。法条只要求「缩小到三分之二时仍能清晰地分辨」
   * （审查指南第一部分第一章 4.3），毫米数由本所按缩印可读性定；给出后
   * verify_patent_figure 在模型未传 min_font_mm 时按它判定。必须为正数：非正值会让
   * 每次判定都失败，故在加载时由 schema 拒绝。
   */
  figureMinFontMm?: number
  /** Inkscape 可执行路径覆盖；默认自动探测（候选路径 + PATH）。仅 figureTextToPath 使用（两个附图生成工具共用同一端口）。 */
  inkscapeExecutable?: string
  /** Inkscape 单次文字转路径超时（毫秒）；默认 30000。仅 figureTextToPath 使用。 */
  inkscapeRenderTimeoutMs?: number
  /** 个人工作台 API 基址覆盖；缺省在 web 组合内自动取本进程 webServer 端口。 */
  workbenchBaseUrl?: string
  /** 案件根目录（相对或绝对路径，其下每案一个 <案号>/ 目录）；默认 <cwd>/patent-workspace。 */
  workbenchCaseRoot?: string
  /** DOT 字体名覆盖；默认 Helvetica，含 CJK 文本时按平台候选（PingFang SC / Microsoft YaHei / Noto Sans CJK SC）。 */
  dotFont?: string
  /** FreeCAD freecadcmd 可执行路径覆盖；默认自动探测（候选路径 + PATH）。generate_structure_figure 与剖视图的 sections.source 共用。 */
  freecadExecutable?: string
  /** freecadcmd 单次渲染超时（毫秒）；默认 120000（FreeCAD 冷启动比 dot 慢）。generate_structure_figure 与剖视图的 sections.source 共用。 */
  freecadRenderTimeoutMs?: number
  /** 结构线稿门禁（generate_structure_figure）；默认 false（CAD 隔离、默认关闭，未开启即 fail-loud）。 */
  structureFigureEnabled?: boolean
  /** 结构线稿 TechDraw 投影比例默认；缺省 1。 */
  structureFigureScale?: number
  /** 结构线稿缺省视图集；缺省 iso/front/top/right。元素受限为受支持视图名（非法值在加载时被 schema 拒绝）。 */
  structureFigureViews?: StructureViewName[]
}
/** Default cap on stages per built-in workflow manifest. */
export const DEFAULT_WORKFLOW_STAGE_BUDGET = 25

/** Default cap on model-calling stages per built-in workflow manifest. */
export const DEFAULT_WORKFLOW_LLM_STAGE_BUDGET = 12
/** Figure/image model route used by the figure-analysis tool. */
export interface ImageModelConfig {
  /** LLM provider route for figure/image analysis. */
  provider?: string
  /** LLM model id for figure/image analysis. */
  model?: string
}
/** Schemastery configuration: optional LLM route/model for the LLM-consuming tools. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  imageModel: z.object({ provider: z.string(), model: z.string() }),
  maxTokens: z.number(),
  guidelineRevision: z.string().default(SHIPPED_GUIDELINE_REVISION),
  workflowStageBudget: z.number().step(1).min(1).default(DEFAULT_WORKFLOW_STAGE_BUDGET),
  workflowLlmStageBudget: z.number().step(1).min(1).default(DEFAULT_WORKFLOW_LLM_STAGE_BUDGET),
  noteDir: z.string(),
  figureIndexFile: z.string(),
  chemistryIndexFile: z.string(),
  graphvizExecutable: z.string(),
  graphvizRenderTimeoutMs: z.number().step(1).min(1).default(DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS),
  figureRenderer: z.union(['wasm', 'cli']),
  figureAnalysisMode: z.union(['single', 'two-step']),
  figurePageSize: z.union(['a4', 'letter']),
  figureOrientation: z.union(['portrait', 'landscape']),
  figureDpi: z.number(),
  figureMargin: z.number(),
  figureOutputDir: z.string(),
  figureTextToPath: z.boolean(),
  figureRequireCuttingMarks: z.boolean(),
  figureFailOnRenderFindings: z.boolean(),
  figureFontMm: z.number().min(Number.MIN_VALUE),
  figureMinFontMm: z.number().min(Number.MIN_VALUE),
  inkscapeExecutable: z.string(),
  inkscapeRenderTimeoutMs: z.number().step(1).min(1).default(DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS),
  workbenchBaseUrl: z.string(),
  workbenchCaseRoot: z.string(),
  dotFont: z.string(),
  freecadExecutable: z.string(),
  freecadRenderTimeoutMs: z.number().step(1).min(1).default(DEFAULT_FREECAD_RENDER_TIMEOUT_MS),
  structureFigureEnabled: z.boolean(),
  structureFigureScale: z.number(),
  structureFigureViews: z.array(z.union(STRUCTURE_VIEWS)),
})
