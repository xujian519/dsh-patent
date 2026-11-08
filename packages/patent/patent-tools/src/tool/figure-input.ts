/**
 * `generate_patent_figure` 的输入词汇与归一：工具输入与面板输入的类型、图型推断、
 * 组件与图面词语的还原、显式标号的窄化，以及 `figure_family` 跨图续号的种子解析。
 *
 * 本模块只把模型输入变成构建器可用的结构化输入，不构建 DOT、不落版。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-input
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import { PatentToolError } from '../error.ts'
import { sanitizeId } from '../figure/dot-builder.ts'
import type {
  BlockDiagramBlock,
  BlockDiagramConnection,
  DiagramTemplateName,
  DotEngine,
  DotFormat,
  DotOrientation,
  DotPageSize,
  FlowchartStep,
  HierarchyNode,
  StateNode,
  StateTransition,
} from '../figure/dot-builder.ts'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../figure/graphviz-renderer.ts'
import type { FigureIndexEntry } from '../figure/index-store.ts'
import type { ExportFigurePort, OutlineTextPort } from '../figure/inkscape-renderer.ts'
import type { TargetOffice } from '../figure/office-profile.ts'
import type { SectionSourcePorts } from '../figure/section-source.ts'
import type { SubmissionLayout } from '../figure/submission-page.ts'
import type {
  AppearanceFigureJson,
  CircuitFigureJson,
  PlotFigureJson,
  SectionFigureJson,
  SequenceFigureJson,
} from '../figure/vector-figure-build.ts'
import { FIGURE_TYPE_NAMES } from './analyze-patent-figure.ts'
import type { FigureComponent, FigureConnection, FigureType } from './analyze-patent-figure.ts'

/** 原始 DOT 输入大小上限（字节）。 */
export const RAW_DOT_MAX_BYTES = 200_000

/**
 * 结构化输入的图元素上限（节点 + 边，嵌套结构递归计入）。
 *
 * WASM 渲染是主线程上的同步调用（见 figure/render-selector 的引擎分档），故输入规模就是
 * 最坏耗时的上界；本机实测（`@viz-js/viz` 3.x）200 元素的强制导向图（`neato`）约 0.2 s、
 * `fdp` 约 0.7 s，400 元素分别为 0.9 s 与 6.4 s。200 也远超一张可读附图的元素数。
 */
export const STRUCTURAL_MAX_ITEMS = 200

/** 生成图在索引中的模型标识（确定性生成，无 LLM 参与）。 */
export const FIGURE_GENERATOR_MODEL_USED = 'graphviz-generator'

/** 输入图型。 */
export type GenerateFigureType =
  | DotFigureType
  | 'circuit'
  | 'plot'
  | 'cross_section'
  | 'sequence_diagram'
  | 'appearance_view'

/** Graphviz 节点连线图型（其余图型由 vector-figure-build 直接绘制 SVG）。 */
export type DotFigureType = 'flowchart' | 'state_diagram' | 'block_diagram' | 'component_hierarchy' | 'raw_dot' | 'template'

/** 索引条目类型（供 apply 接线复用）。 */
export type GeneratePatentFigureIndexEntry = FigureIndexEntry

/** 依赖注入。render 为 DOT 渲染；outputDir 为已解析输出目录；upsertIndex 可选持久化。 */
export type GeneratePatentFigureDeps = {
  /** DOT 渲染（graphviz-renderer 的 renderWithGraphviz 或测试注入）。 */
  render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>
  /**
   * 可选文字转路径（inkscape-renderer 的 outlineSvgText 或测试注入）：把 SVG 的
   * 图面文字换成轮廓路径，导出文件不再依赖阅读器字体。宿主仅在
   * Config.figureTextToPath 开启时注入，缺省视为不转换。
   */
  outlineText?: OutlineTextPort
  /**
   * 可选格式导出（inkscape-renderer 的 exportWithInkscape 或测试注入）。注入后，
   * 非 SVG 输出在需要落版或图型本身只有 SVG 通路时改走「SVG 全链 + Inkscape 导出」；
   * 未注入时保持渲染器直接出图（落版与渲染复核对非 SVG 不生效）。
   */
  exportFigure?: ExportFigurePort
  /** 输出目录（绝对路径），默认 <cwd>/patent/figures。 */
  outputDir?: string
  /**
   * 可选剖切几何端口（宿主注入 FreeCAD 的剖切与剖面线渲染器）：把剖视图的
   * `sections.source`（模型文件 + 剖切平面）展开成轮廓与剖面线段。未注入时给 `source`
   * 报 setup_required —— 需要 FreeCAD，不静默改用示意图。
   */
  sectionSource?: SectionSourcePorts
  /** 可选 upsert 进附图索引（写入失败静默降级）。 */
  upsertIndex?: (entry: GeneratePatentFigureIndexEntry) => Promise<void>
  /** 可选读取附图索引（figure_family 跨图续号用；声明家族而缺省时调用报错）。 */
  loadIndex?: () => Promise<GeneratePatentFigureIndexEntry[]>
  /** 工作目录（相对路径基准），默认 process.cwd()。 */
  cwd?: string
  /** 平台字体解析（含 CJK 时选平台字体），默认 Helvetica。 */
  resolveFont?: (labels: readonly string[]) => string
  /**
   * 部署级剖视要求：为 true 时每个剖视图都必须给出剖切位置符号（工具参数
   * `require_cutting_marks` 未给时取本项）。宿主按 Config 注入；缺省不要求。
   */
  requireCuttingMarks?: boolean
  /**
   * 渲染复核门禁（Config.figureFailOnRenderFindings）：为 true 时，复核发现除
   * `not-measured` 外的问题即判本次生成失败，文件保留供修正但不导出交付件；
   * 缺省只把发现折成警告。非 SVG 直绘通路没有可量测的图面，门禁不生效并给出警告。
   */
  failOnRenderFindings?: boolean
  /**
   * 版面利用率内控下限（0–1，Config.figureMinSheetFillRatio）：渲染复核按
   * 「内容包围盒 ÷ 该图自己的画布」判，低于下限只记一条提示级发现
   * （`sheet-underfill`），不阻断交付。缺省或 0 关闭该判据。
   */
  minSheetFillRatio?: number
  /**
   * 部署的图面文字字号（毫米，Config.figureFontMm）：直绘图型的图面字号与 DOT 的
   * fontsize 由它定，落版核算的字高也用它；模型显式给的字号优先。缺省时不改历史默认。
   */
  figureFontMm?: number
  /** 提交规格页面尺寸默认（Config.figurePageSize）。 */
  pageSize?: DotPageSize
  /** 提交规格方向默认（Config.figureOrientation）。 */
  orientation?: DotOrientation
  /** 提交规格 DPI 默认（Config.figureDpi）。 */
  dpi?: number
  /** 提交规格页边距默认，厘米（Config.figureMargin）。 */
  marginCm?: number
}

/** 顶层输入与多面板子图共用的字段：图型选择与结构/矢量输入（各自的 JSON schema 声明同名字段）。 */
type SharedFigureInputFields = {
  /** 图型；缺省时从唯一结构输入推断（steps→flowchart、blocks→block_diagram、tree→component_hierarchy、dot→raw_dot、template→template），多输入或无输入须显式指定。 */
  figure_type?: GenerateFigureType
  steps?: FlowchartStep[]
  states?: StateNode[]
  transitions?: StateTransition[]
  /** 电路图输入（figure_type=circuit）。 */
  circuit?: CircuitFigureJson
  /** 曲线图/坐标图输入（figure_type=plot）。 */
  plot?: PlotFigureJson
  /**
   * 剖视图输入（figure_type=cross_section）：对象，或指向含该对象的 JSON 文件的路径
   * （工作区相对或绝对路径）——大块坐标放进文件，重渲染时不必把整份 JSON 内联进调用。
   */
  sections?: SectionFigureJson | string
  /** 时序图输入（figure_type=sequence_diagram）。 */
  sequence?: SequenceFigureJson
  /** 外观设计视图排布输入（figure_type=appearance_view）。 */
  appearance_views?: AppearanceFigureJson
  blocks?: BlockDiagramBlock[]
  connections?: BlockDiagramConnection[]
  tree?: HierarchyNode[]
  template?: DiagramTemplateName
  dot?: string
}

/** 多面板子图输入（panels 模式；全部面板组件并入一次标号分配，面板后缀拼进文件名 figN<suffix>；figure_type 缺省时按本面板唯一结构输入推断）。 */
export type GeneratePatentFigurePanelInput = SharedFigureInputFields & {
  /** 面板后缀（字母/数字/下划线/连字符，如 A → fig1A.svg）。 */
  suffix: string
  /** 面板显式标号（组件 id → 标号；优先于顶层 numerals 与家族种子）。 */
  numerals?: Record<string, string>
}

/** 生成图输入（与 schema 保持一致）。 */
export type GeneratePatentFigureInput = SharedFigureInputFields & {
  /** 多面板模式（与顶层结构输入互斥）：一次生成多张共享标号系列的面板。 */
  panels?: GeneratePatentFigurePanelInput[]
  figure_number?: number
  invention_name?: string
  /** 显式标号（组件 id → 标号；跨图同件同号续接）。 */
  numerals?: Record<string, string>
  numeral_start?: number
  numeral_step?: number
  /** 发明家族标识（跨图续号）：声明后同名组件沿用既有标号、新组件续接空闲号；缺省每图独立编号。 */
  figure_family?: string
  style?: 'grayscale' | 'semantic'
  filename?: string
  format?: DotFormat
  engine?: DotEngine
  /** 提交规格页面尺寸（覆盖 Config.figurePageSize）。 */
  page_size?: DotPageSize
  /** 提交规格方向（覆盖 Config.figureOrientation）。 */
  orient?: DotOrientation
  /** 渲染分辨率（覆盖 Config.figureDpi；png 栅格生效）。 */
  dpi?: number
  /** 页边距厘米，四边同值（覆盖 Config.figureMargin）。 */
  margin?: number
  /** 引线标号（数字置于部件外侧并以引线相连，仅 SVG 生效）；默认框图/层级图开启、流程图关闭。 */
  leader_lines?: boolean
  /** 目标法域（cnipa/pct/uspto）：给定时按该法域的幅面、页边距、图号写法落版为固定幅面附图页，并核算字高等合规项。 */
  target_office?: TargetOffice
  /** 本案附图总数（≥ figure_number；默认 1）：两幅以上才需逐幅标注图号。 */
  figure_count?: number
  /** 附图页序号（默认 1）。 */
  sheet_index?: number
  /** 附图页总数（默认 1）。 */
  sheet_total?: number
  /** 图号文字覆盖（缺省按目标法域生成「图1」/「Fig. 1」/「FIG. 1」；panels 模式自动追加面板后缀）。 */
  caption?: string
  /** 本幅是否为请求书指定的摘要附图：给出时按 40×60 毫米缩放核算可辨度量。 */
  abstract_figure?: boolean
  /** 是否把图形落版到固定幅面（仅 SVG 且给定 target_office 时生效）；false 时只核算尺寸、不改写画布。 */
  fit_to_page?: boolean
  /** 图号字高（毫米，默认 4）。 */
  caption_font_mm?: number
  /** 图号与图形之间的间距（毫米，默认 3）。 */
  caption_gap_mm?: number
  /** 页码字高（毫米，默认 3）。 */
  sheet_font_mm?: number
  /** 落版时图形绕绘图区中心顺时针旋转的角度（0/90/180/270，默认 0）；90/270 交换落版后的宽高。 */
  rotate_deg?: number
  /** 剖视图（cross_section）：要求每个轮廓显式给出 hatch（不被剖切的写 `"none"`），缺省即报错。 */
  require_explicit_hatch?: boolean
  /**
   * 剖视图（cross_section）：要求给出剖切位置符号（`sections.cutting_marks`），缺省即报错。
   * 缺省（false）时只把「未给剖切符号」作提示返回，因为剖切平面与对称面重合且视图在标准位置
   * 时可以省略（GB/T 4458.6）；本部署要求一律标注时把它设为 true。
   */
  require_cutting_marks?: boolean
  persist_index?: boolean
}

/** 落版结果（target_office 给定时返回；形状与结构线稿工具共用）。 */
export type GeneratePatentFigureLayout = SubmissionLayout

/** 生成图输出（与 schema 保持一致）。 */
export type GeneratePatentFigureOutput = {
  /** 生成的图片路径（工作区相对）。 */
  path: string
  /**
   * 生成的图片**绝对路径**：输出目录取自部署配置（`figureOutputDir`），不一定在工作区
   * 之下，相对路径不足以定位文件，故随结果返回绝对路径。
   */
  absolutePath: string
  format: DotFormat
  engine: DotEngine
  figureNumber: number
  figureType: FigureType
  /** 附图说明文字（「图N是…示意图；图中：100-名称，102-名称。」），可直接落说明书「附图说明」。 */
  figureDescription: string
  /** 标号映射表（组件 → 标号 → 图号）。 */
  numeralMap: { componentId: string; label: string; numeral: string; figure: number }[]
  /** 组件列表（与 analyze_patent_figure 输出同构）。 */
  components: FigureComponent[]
  /** 连接列表（source/target 为标号）。 */
  connections: FigureConnection[]
  /** 警告（无标号组件等）。 */
  warnings: string[]
  /** 是否已写入附图索引。 */
  indexed: boolean
  /** 落版与合规核算结果（给定 target_office 时）。 */
  layout?: GeneratePatentFigureLayout
  /** 多面板摘要（panels 模式；单图省略）。 */
  panels?: GeneratePatentFigurePanelOutput[]
}

/** 多面板结果的单面板摘要。 */
export type GeneratePatentFigurePanelOutput = {
  /** 面板后缀。 */
  suffix: string
  /** 面板文件路径（工作区相对）。 */
  path: string
  /** 面板文件绝对路径（输出目录不一定在工作区之下）。 */
  absolutePath: string
  /** 面板图型。 */
  figureType: FigureType
  /** 面板落版与合规核算结果（给定 target_office 时）。 */
  layout?: GeneratePatentFigureLayout
}

/**
 * normalized 视图：结构化字段在 schema 校验 + ?? 归一后恒为数组，figure_type 恒已解析，
 * 矢量图型的文件形式（`sections` 传 JSON 文件路径）已在归一前读入并校验。
 */
export type NormalizedFigureInput = StructuralFigureInput &
  Omit<GeneratePatentFigureInput, keyof StructuralFigureInput | 'sections'> & {
    sections?: SectionFigureJson
  }

/** 单图构建输入（主路径与面板路径共用；数组字段由 normalize 保证恒为数组）。 */
export type StructuralFigureInput = {
  figure_type: GenerateFigureType
  steps: FlowchartStep[]
  states: StateNode[]
  transitions: StateTransition[]
  blocks: BlockDiagramBlock[]
  connections: BlockDiagramConnection[]
  tree: HierarchyNode[]
  template?: DiagramTemplateName | undefined
  dot?: string | undefined
  invention_name?: string | undefined
}

/**
 * 图型 → 分析侧 figureType（索引条目与 analyze 输出兼容）。
 * @param figureType - 本工具接受的图型。
 * @returns 分析侧图型名；raw_dot 无结构还原数据，返回 unknown。
 */
export function toFigureType(figureType: GenerateFigureType): FigureType {
  switch (figureType) {
    case 'flowchart':
      return 'flowchart'
    case 'state_diagram':
      return 'state_diagram'
    case 'block_diagram':
      return 'block_diagram'
    case 'component_hierarchy':
      return 'structure'
    case 'template':
      return 'schematic'
    case 'circuit':
      return 'circuit'
    case 'plot':
      return 'plot'
    case 'cross_section':
      return 'cross_section'
    case 'sequence_diagram':
      return 'sequence_diagram'
    case 'appearance_view':
      return 'appearance_view'
    case 'raw_dot':
      return 'unknown'
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new figure type here. */
    default:
      return assertNever(figureType, 'figure type')
  }
}

/**
 * 折叠 label 换行为空格（单行组件名）。
 * @param label - 原始标签，可含 `\n` 换行。
 * @returns 单行化并去除首尾空白后的标签。
 */
export function singleLine(label: string): string {
  return label.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 检测存在的结构输入（字段名 + 对应图型；connections 是 blocks 的伴随字段，不计入）。
 * @param input - 待检测的输入字段。
 * @returns 已给出的结构输入及其图型，顺序固定。
 */
export function presentStructuralFields(input: {
  steps?: FlowchartStep[]
  states?: StateNode[]
  blocks?: BlockDiagramBlock[]
  tree?: HierarchyNode[]
  dot?: string | undefined
  template?: DiagramTemplateName | undefined
}): { field: string; figureType: GenerateFigureType }[] {
  const present: { field: string; figureType: GenerateFigureType }[] = []
  if ((input.steps?.length ?? 0) > 0) present.push({ field: 'steps', figureType: 'flowchart' })
  if ((input.states?.length ?? 0) > 0) present.push({ field: 'states', figureType: 'state_diagram' })
  if ((input.blocks?.length ?? 0) > 0) present.push({ field: 'blocks', figureType: 'block_diagram' })
  if ((input.tree?.length ?? 0) > 0) present.push({ field: 'tree', figureType: 'component_hierarchy' })
  if (input.dot !== undefined && input.dot.trim() !== '') present.push({ field: 'dot', figureType: 'raw_dot' })
  if (input.template !== undefined) present.push({ field: 'template', figureType: 'template' })
  return present
}

/** 矢量图型输入字段（字段名 → 图型；与 presentStructuralFields 同形）。 */
const VECTOR_INPUT_FIELDS: readonly { field: keyof GeneratePatentFigureInput; figureType: GenerateFigureType }[] = [
  { field: 'circuit', figureType: 'circuit' },
  { field: 'plot', figureType: 'plot' },
  { field: 'sections', figureType: 'cross_section' },
  { field: 'sequence', figureType: 'sequence_diagram' },
  { field: 'appearance_views', figureType: 'appearance_view' },
]

/**
 * 矢量图型输入的存在性（用于图型推断与互斥校验）。
 * @param input - 待检测的输入字段。
 * @returns 已给出的矢量输入及其图型，顺序固定。
 */
export function presentVectorFields(input: GeneratePatentFigureInput): { field: string; figureType: GenerateFigureType }[] {
  return VECTOR_INPUT_FIELDS
    .filter(entry => input[entry.field] !== undefined)
    .map(entry => ({ field: entry.field, figureType: entry.figureType }))
}

/**
 * 图型推断：唯一结构输入决定图型；无输入或多输入报 invalid_tool_input。
 * @param input - 工具输入或面板输入。
 * @param contextLabel - 归属说明（如「面板 B」），用于错误定位。
 * @returns 推断出的图型。
 */
export function inferFigureType(input: GeneratePatentFigureInput, contextLabel?: string): GenerateFigureType {
  const present = [...presentStructuralFields(input), ...presentVectorFields(input)]
  const prefix = contextLabel === undefined ? '' : `${contextLabel}：`
  const [single] = present
  if (present.length === 1 && single !== undefined) return single.figureType
  if (present.length === 0) {
    throw new PatentToolError('invalid_tool_input', `${prefix}无法推断图型：未提供结构输入，请显式传入 figure_type 或提供 steps/blocks/tree/dot/template 之一`, { tool: 'generate_patent_figure' })
  }
  throw new PatentToolError('invalid_tool_input', `${prefix}无法推断图型：检测到多个结构输入（${present.map(p => p.field).join('、')}），请显式传入 figure_type`, { tool: 'generate_patent_figure' })
}

/**
 * 收集本图组件（清洗后 id + label，构建顺序；template/raw_dot 无结构还原数据）。
 * @param input - 已归一的单图结构化输入。
 * @returns 组件 id 与标签，顺序与图面构建一致。
 */
export function collectComponents(input: StructuralFigureInput): { id: string; label: string }[] {
  switch (input.figure_type) {
    case 'flowchart':
      return input.steps.map(step => ({ id: sanitizeId(step.id), label: step.label }))
    case 'state_diagram':
      // initial 伪状态（label 为空）只画实心小圆，不参与标号分配。
      return input.states
        .filter(state => state.label.trim() !== '')
        .map(state => ({ id: sanitizeId(state.id), label: state.label }))
    case 'block_diagram':
      return input.blocks.map(block => ({ id: sanitizeId(block.id), label: block.label }))
    case 'component_hierarchy': {
      const components: { id: string; label: string }[] = []
      const visit = (node: HierarchyNode): void => {
        components.push({ id: sanitizeId(node.id), label: node.label })
        for (const child of node.children ?? []) visit(child)
      }
      for (const root of input.tree) visit(root)
      return components
    }
    case 'template':
      return []
    case 'raw_dot':
      return []
    case 'circuit':
    case 'plot':
    case 'cross_section':
    case 'sequence_diagram':
    case 'appearance_view':
      // 矢量图型的图面词语由各模块的 labels 给出，这里没有结构化组件可还原。
      return []
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new figure type here. */
    default:
      return assertNever(input.figure_type, 'structural figure input')
  }
}

/** 从 DOT 文本提取双引号 label 属性值（`\n` 还原为换行）；HTML 形式标签不提取。 */
function dotLabels(dot: string): string[] {
  const labels: string[] = []
  const pattern = /\blabel\s*=\s*"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(dot)) !== null) {
    labels.push((match[1] as string).replace(/\\(.)/g, (_all, char: string) => (char === 'n' ? '\n' : char)))
  }
  return labels
}

/**
 * 收集本图将出现在图面上的词语（节点名 + 边标签；raw_dot 取 DOT 的 label 属性）。
 * @param input - 已归一的单图结构化输入。
 * @returns 供图面用语规则检查的词语。
 */
export function collectFigureWording(input: StructuralFigureInput): string[] {
  switch (input.figure_type) {
    case 'flowchart':
      return input.steps.flatMap(step => [
        step.label,
        ...step.next.flatMap(next => (typeof next === 'string' ? [] : [next.label])),
      ])
    case 'state_diagram':
      return [
        ...input.states.map(state => state.label),
        ...input.transitions.flatMap(transition => (transition.label === undefined ? [] : [transition.label])),
      ]
    case 'block_diagram':
      return [
        ...input.blocks.map(block => block.label),
        ...input.connections.flatMap(connection => (connection.label === undefined ? [] : [connection.label])),
      ]
    case 'component_hierarchy': {
      const labels: string[] = []
      const visit = (node: HierarchyNode): void => {
        labels.push(node.label)
        for (const child of node.children ?? []) visit(child)
      }
      for (const root of input.tree) visit(root)
      return labels
    }
    case 'template':
      return []
    case 'raw_dot':
      /* v8 ignore next -- apply() only routes raw_dot here with dot set; the guard serves standalone library callers */
      return input.dot === undefined ? [] : dotLabels(input.dot)
    case 'circuit':
    case 'plot':
    case 'cross_section':
    case 'sequence_diagram':
    case 'appearance_view':
      return []
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new figure type here. */
    default:
      return assertNever(input.figure_type, 'structural figure input')
  }
}

/**
 * 矢量图 SVG 的 `<title>`（不落图面像素）：发明名称缺省时只写图型。
 * @param inventionName - 发明名称；缺省或全空白时只写图型。
 * @param figureType - 分析侧图型名。
 * @returns SVG 标题文本。
 */
export function vectorTitle(inventionName: string | undefined, figureType: FigureType): string {
  const title = inventionName === undefined || inventionName.trim() === '' ? '' : `${inventionName.trim()}的`
  return `${title}${FIGURE_TYPE_NAMES[figureType]}`
}

/**
 * 把模型传入的 numerals 映射窄化为 dot builder 接受的字符串值映射。
 * schema 对值保持开放（模型常传数字），因此非标量值在此按字段名报错，
 * 而不是让 builder 抛出裸 `TypeError`。
 * @param raw - 工具输入里的 numerals 映射。
 * @param label - 归属说明（顶层或面板后缀），用于错误定位。
 * @returns 组件 id → 标号字符串（id 已清洗）。
 */
export function readNumerals(raw: unknown, label: string): Record<string, string> {
  const numerals: Record<string, string> = {}
  for (const [id, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PatentToolError('invalid_tool_input', `${label} numerals["${id}"] 必须是标号字符串或数字，收到 ${JSON.stringify(value)}`, {
        tool: 'generate_patent_figure',
      })
    }
    numerals[sanitizeId(id)] = String(value)
  }
  return numerals
}

/** 从既有家族条目收集 组件名 → 标号（索引按图号升序，首个出现优先）。 */
function familyNumeralsByLabel(
  entries: readonly GeneratePatentFigureIndexEntry[],
  family: string,
): Map<string, string> {
  const byLabel = new Map<string, string>()
  for (const entry of entries) {
    if (entry.analysis.figureFamily !== family) continue
    for (const component of entry.analysis.components) {
      const label = singleLine(component.name).toLowerCase()
      if (label === '' || component.refNumber.trim() === '') continue
      if (!byLabel.has(label)) byLabel.set(label, component.refNumber)
    }
  }
  return byLabel
}

/** 把家族既有标号拆成本图种子：本图出现的组件 → explicit（沿用同号），其余 → reserved（占用号段）。 */
function familySeedAssignment(
  byLabel: ReadonlyMap<string, string>,
  components: readonly { id: string; label: string }[],
): { explicit: Record<string, string>; reserved: string[] } {
  const explicit: Record<string, string> = {}
  const reserved: string[] = []
  for (const [label, numeral] of byLabel) {
    const match = components.find(c => singleLine(c.label).toLowerCase() === label)
    if (match === undefined) {
      reserved.push(numeral)
    } else {
      explicit[match.id] = numeral
    }
  }
  return { explicit, reserved }
}

/**
 * 解析跨图续号种子：未声明家族 → 空种子（零读盘）；声明家族 → 读索引并按组件名拆分沿用/占用。
 * @param figureFamily - 发明家族标识；缺省时返回空种子。
 * @param components - 本图组件（id + 标签）。
 * @param deps - 工具依赖，声明家族时需要其 `loadIndex`。
 * @returns 沿用既有标号的显式映射，与本图未出现组件的已占用标号。
 * @throws PatentToolError(`invalid_tool_input`) 声明家族但宿主未注入 `loadIndex` 时。
 * @throws PatentToolError(`tool_execution_failed`) 读取附图索引失败时。
 */
export async function resolveFamilySeeds(
  figureFamily: string | undefined,
  components: readonly { id: string; label: string }[],
  deps: GeneratePatentFigureDeps,
): Promise<{ explicit: Record<string, string>; reserved: string[] }> {
  if (figureFamily === undefined) return { explicit: {}, reserved: [] }
  if (deps.loadIndex === undefined) {
    throw new PatentToolError('invalid_tool_input', '声明 figure_family 需要宿主注入 loadIndex 依赖（附图索引读取）', { tool: 'generate_patent_figure' })
  }
  let entries: GeneratePatentFigureIndexEntry[]
  try {
    entries = await deps.loadIndex()
  } catch (error) {
    throw new PatentToolError('tool_execution_failed', `读取附图索引失败：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_patent_figure' })
  }
  return familySeedAssignment(familyNumeralsByLabel(entries, figureFamily), components)
}
