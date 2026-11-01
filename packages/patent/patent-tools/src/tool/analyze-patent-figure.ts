/**
 * `analyze_patent_figure` tool: analyze one patent drawing image into a
 * structured figure description (figure type, components, connections,
 * reference numbers, and a patent-format figure description). Ported from
 * Sati's analyzePatentFigure.ts.
 *
 * The Sati figure ENGINE (src/patent/figure/*: two-step PatentVision/PatentLMM
 * analysis, multi-figure consistency, electrical netlist) was not ported into
 * any dsh package. This tool ports the wrapper (input/output schema,
 * description, render) and drives a single-step analysis on the figure-model
 * route with the image attached.
 *
 * The image-modal capability gate (P3.3) preflights the resolved figure-model
 * route's declared input modalities before any file IO: a route without
 * 'image' input is denied (PatentToolError code model_cannot_accept_image).
 * The image bytes are admitted through the harness attachment store and the
 * request carries the durable ref, so the session-log reconstruction rule
 * (model-visible ⟺ logged) holds: the tool arguments log the image path and
 * the analysis result, the bytes live in the durable store.
 * @module @deepseek-ai/dsh-patent-tools/tool/analyze-patent-figure
 */

import { access, readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { collectPortText, dataBlock, tryParseJson } from '@deepseek-ai/dsh-patent-core'
import type { PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { checkImageCapability } from '../figure/image-capability.ts'
import type { FigureAnalysisEngine } from '../figure/analysis-engine.ts'
import { PatentToolError } from '../error.ts'
import { loggedToolModel } from './internal/model-call-log.ts'
import type { FigureIndexEntry } from '../figure/index-store.ts'
import { COMPONENT_SCHEMA, FIGURE_COMPONENT_KINDS } from './internal/figure-schemas.ts'
import type { FigureComponentKind } from './internal/figure-schemas.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'

/** 附图类型（PatentVision 分类 + 专利实务常见图型）。 */
export const FIGURE_TYPES = [
  'structure',
  'flowchart',
  'state_diagram',
  'sequence_diagram',
  'circuit',
  'block_diagram',
  'schematic',
  'exploded_view',
  'cross_section',
  'plot',
  'appearance_view',
  'unknown',
] as const

/** Figure type (structure / flowchart / circuit / block diagram / ... / unknown). */
export type FigureType = (typeof FIGURE_TYPES)[number]

/** 附图类型中文名（附图说明模板用）。 */
export const FIGURE_TYPE_NAMES: Record<FigureType, string> = {
  structure: '结构示意图',
  flowchart: '流程图',
  state_diagram: '状态图',
  sequence_diagram: '时序图',
  circuit: '电路图',
  block_diagram: '方框图',
  schematic: '原理示意图',
  exploded_view: '分解示意图',
  cross_section: '剖视图',
  plot: '曲线图',
  appearance_view: '外观设计视图',
  unknown: '示意图',
}

/** 组件类型（PatentVision ComponentType 对齐）。 */
export { FIGURE_COMPONENT_KINDS }

/** Component kind (mechanical / electrical / software / ... / unknown). */
export type { FigureComponentKind }

/** 组件连接关系类型。 */
const FIGURE_CONNECTION_KINDS = ['electrical', 'mechanical', 'data_flow', 'unknown'] as const

/** Connection kind (electrical / mechanical / data_flow / unknown). */
type FigureConnectionKind = (typeof FIGURE_CONNECTION_KINDS)[number]

/** 附图中的技术组件（对应附图标记号）。 */
export type FigureComponent = {
  /** 附图标记号（与图面阿拉伯数字一致；无标号部件以 U1/U2… 表示）。 */
  refNumber: string
  /** 组件名称。 */
  name: string
  /** 组件类型。 */
  kind: FigureComponentKind
  /** 组件功能描述。 */
  description: string
}

/** 组件间连接关系。 */
export type FigureConnection = {
  /** 源组件标号。 */
  source: string
  /** 目标组件标号。 */
  target: string
  /** 连接类型。 */
  kind: FigureConnectionKind
  /** 连接关系描述。 */
  description: string
}

/**
 * 附图分析结果。
 *
 * `figureDescription` 为可直接落入说明书「附图说明」章节的文字（专利格式）；
 * `usable` 表示组件提取是否成功（组件数 > 0）。
 */
export type FigureAnalysisResult = {
  /** 分析图片路径（工作区相对路径，即输入的 image_path）。 */
  imagePath: string
  /** 附图编号。 */
  figureNumber: number
  /** 附图类型。 */
  figureType: FigureType
  /** 附图整体描述。 */
  overallDescription: string
  /** 识别出的组件列表。 */
  components: FigureComponent[]
  /** 组件间连接关系。 */
  connections: FigureConnection[]
  /** 附图说明文字（专利格式）。 */
  figureDescription: string
  /** 分类置信度 0-1。 */
  confidence: number
  /** 警告（标号不连续、降级原因等）。 */
  warnings: string[]
  /** 是否可直接用于撰写/校验（组件数 > 0）。 */
  usable: boolean
  /** 实际使用的模型标识。 */
  modelUsed: string
  /** 发明家族标识（generate_patent_figure 声明 figure_family 时记录，跨图续号的检索键；旧条目可缺省）。 */
  figureFamily?: string
}

/** Input for the analyze_patent_figure tool. */
export type AnalyzePatentFigureInput = {
  /** 附图图片路径（工作区相对或绝对路径，支持 jpg/png/gif/webp）。 */
  image_path: string
  /** 附图编号（默认 1，用于附图说明「图N」）。 */
  figure_number?: number
  /** 权利要求/技术方案上下文（图文对齐，提高识别准确率，可选）。 */
  claim_context?: string
  /** 发明名称（附图说明模板用，可选）。 */
  invention_name?: string
}

/**
 * Injected figure-analysis dependencies. The figure route and its port come
 * from the composition site (Config.imageModel override, else the main
 * route); both are optional so an unconfigured deployment fails loud at
 * execute with setup guidance instead of at load.
 */
export type AnalyzePatentFigureDeps = {
  /**
   * Figure-model port built on the gated figure route; the analysis request
   * (prompt + image ref) is sent through it.
   */
  imageModel?: PatentModelPort
  /** Admit one image into the harness attachment store (ctx 'attachments'). */
  saveImage?: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>
  /** Working directory used to resolve a relative image_path. */
  cwd?: string
  /** Label reported in the result's modelUsed field (default "provider/model" of the gated route). */
  modelUsed?: string
  /**
   * The Config figure-model route the image is gated and sent on
   * (imageModel override, else the main provider/model route).
   */
  gateModel?: { provider: string; model: string }
  /**
   * Resolve one provider/model route's declared input modalities for the image
   * gate. Absent means the gate is not wired and the tool runs un-gated.
   */
  resolveImageInputModalities?: (provider: string, model: string) => Promise<readonly ModelModality[] | undefined>
  /**
   * Persist the analysis into the figure index (figureIndexStore.upsert).
   * Optional enhancement: a throwing upsert is swallowed so the analysis result
   * still returns.
   */
  upsertIndex?: (entry: FigureIndexEntry) => Promise<void>
  /**
   * Analysis engine implementing the FigureAnalysisEngine seam (figure mode
   * selection lives at the composition site). Absent → the default single-step
   * engine wraps the existing single-pass logic unchanged.
   */
  analysisEngine?: FigureAnalysisEngine
}

/** 附图扩展名 → 附件媒体类型（入库时按字节校验，声明不符即拒绝）。 */
const FIGURE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Resolve the attachment media type from the image extension.
 * @param imagePath - the user-supplied image path.
 * @returns the attachment media type.
 */
function figureMediaType(imagePath: string): ImageMediaType {
  const extension = extname(imagePath).toLowerCase()
  const mediaType = FIGURE_MEDIA_TYPES[extension]
  if (mediaType === undefined) {
    throw new PatentToolError(
      'invalid_tool_input',
      `不支持的附图格式：${extension === '' ? '（无扩展名）' : extension}；仅支持 jpg/png/gif/webp。`,
      { tool: 'analyze_patent_figure' },
    )
  }
  return mediaType
}

/**
 * Resolve the model route the image gate checks. A caller-supplied route wins
 * when both provider and model are set; otherwise the given fallback is used.
 * An empty active route is not treated as an authoritative route.
 * The analyze_patent_figure tool wires this with only the Config figure-model
 * route (deps.gateModel), so its gate verdict and send path always follow that
 * route; the caller-supplied branch stays available for a future caller that
 * names an active model.
 * @param agentModel - a caller's provider/model (both may be absent).
 * @param fallback - the figure-model route when no active route is provided.
 * @returns the route to gate, or undefined when neither source names one.
 */
export function resolveGateRoute(
  agentModel: { provider?: string; model?: string } | undefined,
  fallback: { provider: string; model: string } | undefined,
): { provider: string; model: string } | undefined {
  if (agentModel !== undefined && agentModel.provider !== undefined && agentModel.provider !== ''
    && agentModel.model !== undefined && agentModel.model !== '') {
    return { provider: agentModel.provider, model: agentModel.model }
  }
  return fallback
}

/** 专利附图规范要点（静态注入，与 Sati FIGURE_SPEC_GUIDE 一致）。 */
export const FIGURE_SPEC_GUIDE = [
  '专利附图是黑白线图，不要求也不允许彩色；虚线表示不可见/隐藏结构，剖面线表示剖切面。',
  '阿拉伯数字为附图标记（引用符号），指向对应部件；说明书正文引用必须与标号一一对应。',
  '箭头表示连接方向、运动方向或流程走向。',
  '同一部件在不同附图中共用同一标号；同一图内标号按固定步进递增（如 100、102、104），不得重复。',
  "附图说明句式：'图N是本发明实施例提供的{发明名称}的{附图类型}；图中：1-{部件}；2-{部件}；…'",
  '标号识别必须严格依据图面；图面可见但标号模糊、被遮挡或无法确认的部件，不得臆造编号，应注明"无法确认"；仅当部件确实无标号时，才使用 U1/U2… 占位符并注明。',
  '组件描述应包含图面可见的物理形态、空间相对位置与连接关系；图面未显示的信息（材料、参数等）不得补充。',
].join('\n')

/** 枚举值校验工厂：非合法值返回 fallback。 */
function makeNormalizer<T extends string>(values: readonly T[], fallback: T): (value: unknown) => T {
  return (value: unknown): T =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 附图类型枚举值校验：非合法值返回 "unknown"。 */
const normalizeFigureType = makeNormalizer(FIGURE_TYPES, 'unknown')

/** 组件类型枚举值校验：非合法值返回 "unknown"。 */
const normalizeComponentKind = makeNormalizer(FIGURE_COMPONENT_KINDS, 'unknown')

/** 连接类型枚举值校验：非合法值返回 "unknown"。 */
const normalizeConnectionKind = makeNormalizer(FIGURE_CONNECTION_KINDS, 'unknown')

function buildFigureDescription(
  figureNumber: number,
  figureType: FigureType,
  inventionName: string | undefined,
  components: FigureComponent[],
): string {
  const typeName = FIGURE_TYPE_NAMES[figureType]
  const title = (inventionName ?? '装置').trim() || '装置'
  if (components.length === 0) {
    return `图${figureNumber}是本发明实施例提供的${title}的${typeName}。`
  }
  const lines = [`图${figureNumber}是本发明实施例提供的${title}的${typeName}；`, '图中：']
  for (const c of components) {
    lines.push(`${c.refNumber}-${c.name}；`)
  }
  return lines.join('\n')
}

/**
 * 标号递增检查：图内标号按**固定步进**递增即可——100、102、104 是常见写法
 * （偶数步进为插号留出位置），因此只有步进发生变化时才提示。
 * @param components - 图面识别出的组件（标号去重后进入判定）。
 * @returns 警告文本列表；步进一致时为空数组。
 */
function checkReferenceNumbers(components: FigureComponent[]): string[] {
  const warnings: string[] = []
  const numbers = components
    .map(c => c.refNumber)
    .filter(n => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b)
  if (numbers.length < 2) return warnings
  const step = (numbers[1] as number) - (numbers[0] as number)
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1] as number
    const current = numbers[index] as number
    if (current - previous !== step) {
      warnings.push(`附图标记步进不一致：${previous} 后为 ${current}（图内前序步进 ${step}），请核对是否漏标或重号`)
      break
    }
  }
  return warnings
}

/** 单步/两步分析共用的附图字段 JSON Schema（不含 figure_description 与 warnings）。 */
export const FIGURE_SCHEMA_CORE = {
  figure_type: { type: 'string', enum: FIGURE_TYPES, description: '附图类型' },
  overall_description: { type: 'string', description: '附图整体内容的一句话描述' },
  confidence: { type: 'number', description: '分类置信度 0-1' },
  components: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref_number: { type: 'string', description: '附图标记号' },
        name: { type: 'string', description: '组件名称' },
        kind: { type: 'string', enum: FIGURE_COMPONENT_KINDS, description: '组件类型' },
        description: { type: 'string', description: '组件功能描述' },
      },
    },
  },
  connections: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '源组件标号' },
        target: { type: 'string', description: '目标组件标号' },
        kind: { type: 'string', enum: FIGURE_CONNECTION_KINDS, description: '连接类型' },
        description: { type: 'string', description: '连接关系描述' },
      },
    },
  },
} as const

/** 单步分析输出 JSON Schema（合并 Sati 的 Step1+Step2）。 */
const COMBINED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FIGURE_SCHEMA_CORE,
    figure_description: { type: 'string', description: '附图说明文字（专利格式）' },
    warnings: { type: 'array', items: { type: 'string' }, description: '无法识别或标号异常的区域' },
  },
} as const

/**
 * Format the claim-context block shared by the single- and two-step prompts.
 * @param claimContext - the user-supplied claim/solution text (may be absent).
 * @returns the formatted prompt block (absent → an explicit "not provided" placeholder).
 */
export function formatContext(claimContext: string | undefined): string {
  return claimContext && claimContext.trim().length > 0
    ? `\n【权利要求/技术方案上下文】\n${dataBlock(claimContext.trim().slice(0, 4000))}`
    : '\n【权利要求/技术方案上下文】\n（未提供）'
}

/** Build the single-step figure-analysis prompt (the image travels with the request). */
function buildFigureAnalysisPrompt(
  figureNumber: number,
  claimContext: string | undefined,
  inventionName: string | undefined,
  imagePath: string,
): string {
  return [
    `你是一位资深专利代理师与专利审查专家。请分析这张专利说明书附图（图${figureNumber}），图片已随本请求提供。`,
    '',
    `附图文件：${imagePath}`,
    `发明名称：${inventionName?.trim() || '（未提供）'}`,
    '',
    '请严格依据图面可见内容识别：附图类型、组件及其附图标记、组件间连接关系。权利要求/技术方案上下文仅用于图文对齐与术语校正，不得用于补充图面不存在的信息；图面与上下文冲突时以图面为准并在 warnings 中注明。',
    '',
    '【专利附图规范要点】',
    FIGURE_SPEC_GUIDE,
    formatContext(claimContext),
    '',
    '【输出要求】',
    '- 组件标号与图面阿拉伯数字一致；无标号部件用 U1/U2… 编号并在 warnings 注明"未标注"；',
    '- 图面可见但标号模糊、被遮挡或无法确认的部件，不得臆造编号，在 warnings 注明"无法确认"；',
    '- 附图说明使用专利格式：图N是本发明实施例提供的{发明名称}的{附图类型}；图中：1-…；2-…；',
    '- 发明名称未知时用「装置」代替。',
    '',
    '严格输出 JSON：只输出一个 JSON 对象；不要用 markdown 代码围栏；不要输出 JSON 以外的任何文字；所有键与字符串使用双引号。',
    JSON.stringify(COMBINED_SCHEMA, null, 2),
  ].join('\n')
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 规范化组件（枚举校验、空标号过滤、按标号去重）。 */
function normalizeComponents(raw: unknown): FigureComponent[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const components: FigureComponent[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const refNumber = typeof c.ref_number === 'string' ? c.ref_number.trim() : ''
    if (!refNumber || seen.has(refNumber)) continue
    seen.add(refNumber)
    components.push({
      refNumber,
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : '未命名部件',
      kind: normalizeComponentKind(c.kind),
      description: typeof c.description === 'string' ? c.description.trim() : '',
    })
  }
  return components
}

/** 规范化连接（过滤空端点与未知组件引用）。 */
function normalizeConnections(raw: unknown, refNumbers: Set<string>): FigureConnection[] {
  if (!Array.isArray(raw)) return []
  const connections: FigureConnection[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const source = typeof c.source === 'string' ? c.source.trim() : ''
    const target = typeof c.target === 'string' ? c.target.trim() : ''
    if (!source || !target || !refNumbers.has(source) || !refNumbers.has(target)) continue
    connections.push({
      source,
      target,
      kind: normalizeConnectionKind(c.kind),
      description: typeof c.description === 'string' ? c.description.trim() : '',
    })
  }
  return connections
}

/**
 * Parse + normalize the model's raw text into a FigureAnalysisResult (degraded path never throws).
 * @param raw - the model's raw text output for one analysis pass.
 * @param opts - image path / figure number / invention name / model label for the result.
 * @returns the normalized result; unparseable output degrades to unknown type + empty components + a warning.
 */
export function normalizeFigureAnalysis(
  raw: string,
  opts: { imagePath: string; figureNumber: number; inventionName: string | undefined; modelUsed: string },
): FigureAnalysisResult {
  const parsed = tryParseJson(raw)
  const warnings: string[] = []

  // Extract raw fields once so subsequent narrowing operates on locals, not
  // on a possibly-undefined record's property chain.
  const figureTypeRaw = parsed?.figure_type
  const overallRaw = parsed?.overall_description
  const confidenceRaw = parsed?.confidence
  const componentsRaw = parsed?.components
  const connectionsRaw = parsed?.connections
  const descriptionRaw = parsed?.figure_description
  const warningsRaw = parsed?.warnings

  if (parsed === undefined) {
    warnings.push('模型输出无法解析为 JSON，附图类型按 unknown、组件为空处理')
  }

  const figureType = normalizeFigureType(figureTypeRaw)
  const overallDescription = typeof overallRaw === 'string' ? overallRaw : ''
  const confidence = clamp01(typeof confidenceRaw === 'number' ? confidenceRaw : 0)
  const components = normalizeComponents(componentsRaw)
  const refNumbers = new Set(components.map(c => c.refNumber))
  const connections = normalizeConnections(connectionsRaw, refNumbers)
  const parsedDescription = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : ''
  const figureDescription =
    parsedDescription.length > 0
      ? parsedDescription
      : buildFigureDescription(opts.figureNumber, figureType, opts.inventionName, components)
  if (Array.isArray(warningsRaw)) {
    for (const w of warningsRaw) {
      if (typeof w === 'string' && w.trim()) warnings.push(w)
    }
  }
  warnings.push(...checkReferenceNumbers(components))
  return {
    imagePath: opts.imagePath,
    figureNumber: opts.figureNumber,
    figureType,
    overallDescription,
    components,
    connections,
    figureDescription,
    confidence,
    warnings: [...new Set(warnings)],
    usable: components.length > 0,
    modelUsed: opts.modelUsed,
  }
}

/** 默认单步分析引擎：包装既有单步逻辑（一次模型调用），未注入引擎时零行为变化。 */
function singleStepAnalysisEngine(): FigureAnalysisEngine {
  return {
    kind: 'single-step',
    async analyze(request, signal, model) {
      const prompt = buildFigureAnalysisPrompt(request.figureNumber, request.claimContext, request.inventionName, request.imagePath)
      const raw = await collectPortText(model, prompt, signal, { images: [request.image] })
      return normalizeFigureAnalysis(raw, {
        imagePath: request.imagePath,
        figureNumber: request.figureNumber,
        inventionName: request.inventionName,
        modelUsed: request.modelUsed,
      })
    },
  }
}

/**
 * Render the canonical figure analysis into model-facing Markdown.
 * @param value - the figure analysis result to render.
 * @returns the rendered Markdown.
 */
export function renderFigureAnalysis(value: FigureAnalysisResult): string {
  const lines = [
    `附图分析（图${value.figureNumber} · ${FIGURE_TYPE_NAMES[value.figureType]} · 置信度 ${value.confidence.toFixed(2)}${value.usable ? '' : ' · 需人工确认'}）`,
    '',
    value.overallDescription || '（无整体描述）',
    '',
    value.figureDescription || '（无附图说明）',
  ]
  if (value.components.length > 0) {
    lines.push('', '## 组件', ...value.components.map(c => `- ${c.refNumber} ${c.name}（${c.kind}）：${c.description}`))
  }
  if (value.connections.length > 0) {
    lines.push('', '## 连接关系', ...value.connections.map(c => `- ${c.source} → ${c.target}（${c.kind}）：${c.description}`))
  }
  lines.push(...warningSection(value.warnings))
  return lines.join('\n')
}

const DESCRIPTION = [
  '分析专利说明书附图（多模态）：把图片随请求发送给配置的附图模型（imageModel，须声明图片输入），识别附图类型（结构图/流程图/电路图/方框图/示意图/分解图/剖视图）、提取组件与连接关系、核对附图标记并生成专利格式的附图说明文字。当用户提供附图图片并要求撰写附图说明、理解附图内容、核对附图标记一致性时使用。可传入权利要求或技术方案文本作为上下文，提升图文对齐准确率。',
].join('\n')

const CONNECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    target: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: FIGURE_CONNECTION_KINDS },
    description: { type: 'string', required: true },
  },
} as const

/**
 * Build the `analyze_patent_figure` tool over the injected figure route, its
 * port, and the attachment-admission seam.
 * @param deps - the figure-model route/port, the store admission seam, and optional working directory.
 * @returns a registry-ready tool definition.
 */
export function createAnalyzePatentFigureTool(deps: AnalyzePatentFigureDeps): ToolDefinition {
  return defineTool({
    name: 'analyze_patent_figure',
    description: DESCRIPTION,
    parameters: {
      image_path: { type: 'string', required: true, description: '附图图片路径（工作区相对或绝对路径，支持 jpg/png/gif/webp）' },
      figure_number: { type: 'number', description: '附图编号（默认 1，用于附图说明「图N」）' },
      claim_context: { type: 'string', description: '权利要求或技术方案文本（图文对齐，可显著提高组件识别准确率）' },
      invention_name: { type: 'string', description: '发明名称（用于附图说明模板，如「一种供热管道电位采集装置」）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string', required: true },
          figureNumber: { type: 'integer', required: true },
          figureType: { type: 'string', required: true, enum: FIGURE_TYPES },
          overallDescription: { type: 'string', required: true },
          components: { type: 'array', required: true, items: COMPONENT_SCHEMA },
          connections: { type: 'array', required: true, items: CONNECTION_SCHEMA },
          figureDescription: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          warnings: WARNINGS_SCHEMA,
          usable: { type: 'boolean', required: true },
          modelUsed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFigureAnalysis(value) }],
    },
    async execute(args, exec) {
      // The route the image is gated and sent on: the composition site's
      // figure route (Config.imageModel override, else the main route). The
      // tool wires no active-agent model, so the gate verdict and the send path
      // always share this Config source; the port and the store admission seam
      // ride on the same sources, so one missing piece is a deployment
      // misconfiguration, not a per-call error source — fail loud with setup
      // guidance.
      const route = resolveGateRoute(undefined, deps.gateModel)
      const figureModel = loggedToolModel(exec, deps.imageModel, { callSite: 'analyze_patent_figure' })
      if (route === undefined || figureModel === undefined) {
        throw new PatentToolError(
          'setup_required',
          '未配置附图分析模型路由：请在 cordis.yml 为专利工具配置 imageModel（声明图片输入的模型，如 deepseek-official 的 vision 模型），'
          + '或配置可用的 provider/model。',
          { tool: 'analyze_patent_figure' },
        )
      }
      if (deps.resolveImageInputModalities !== undefined) {
        const modalities = await deps.resolveImageInputModalities(route.provider, route.model)
        const decision = checkImageCapability(modalities, `${route.provider}/${route.model}`)
        if (!decision.allowed) {
          throw new PatentToolError('model_cannot_accept_image', decision.reason, {
            tool: 'analyze_patent_figure',
            route: `${route.provider}/${route.model}`,
          })
        }
      }
      if (deps.saveImage === undefined) {
        throw new PatentToolError(
          'setup_required',
          '附件服务不可用（未挂载 dsh-attachment），无法把附图图片送入模型。',
          { tool: 'analyze_patent_figure' },
        )
      }

      const cwd = deps.cwd ?? process.cwd()
      const mediaType = figureMediaType(args.image_path)
      const absPath = resolve(cwd, args.image_path)
      try {
        await access(absPath)
      } catch {
        throw new PatentToolError('file_not_found', `附图图片不存在：${args.image_path}`, { tool: 'analyze_patent_figure' })
      }
      let ref: ImageAttachmentRef
      try {
        ref = await deps.saveImage({ data: await readFile(absPath), mediaType, name: basename(absPath) })
      } catch (error) {
        if (error instanceof PatentToolError) throw error
        throw new PatentToolError(
          'invalid_tool_input',
          `附图图片无法写入附件服务：${error instanceof Error ? error.message : String(error)}`,
          { tool: 'analyze_patent_figure' },
        )
      }

      const figureNumber = args.figure_number ?? 1
      // 分析引擎按部署模式在组合点注入（figureAnalysisMode）；缺省为包装既有
      // 单步逻辑的默认引擎。门控与附件入库在引擎之前完成，与模式无关；模型端口按调用
      // 传入（会话绑定后的记录端口），故注入引擎也不会绕开 `patent/model-call`。
      const engine = deps.analysisEngine ?? singleStepAnalysisEngine()
      let result: FigureAnalysisResult
      try {
        result = await engine.analyze(
          {
            image: ref,
            figureNumber,
            imagePath: args.image_path,
            ...(args.claim_context === undefined ? {} : { claimContext: args.claim_context }),
            inventionName: args.invention_name,
            modelUsed: deps.modelUsed ?? `${route.provider}/${route.model}`,
          },
          exec.signal,
          figureModel,
        )
      } catch (error) {
        if (exec.signal.aborted) {
          throw new PatentToolError('tool_aborted', 'analyze_patent_figure aborted', { tool: 'analyze_patent_figure' })
        }
        throw new PatentToolError(
          'tool_execution_failed',
          `附图分析失败：${error instanceof Error ? error.message : String(error)}`,
          { tool: 'analyze_patent_figure' },
        )
      }
      if (deps.upsertIndex !== undefined) {
        try {
          await deps.upsertIndex({
            imagePath: result.imagePath,
            analyzedAt: new Date().toISOString(),
            analysis: result,
          })
        } catch {
          // 索引写入是可选增强：写入失败静默降级，不阻断分析结果返回。
        }
      }
      return result
    },
  })
}
