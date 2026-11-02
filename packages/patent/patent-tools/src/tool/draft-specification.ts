/**
 * `draft_specification` tool: deterministic patent-specification drafting
 * (technical field / background / summary / drawings / embodiments). Ported from
 * Sati's draftSpecification.ts. No LLM or dsh service dependency.
 * @module @deepseek-ai/dsh-patent-tools/tool/draft-specification
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveDomain as resolveClaimDomain } from '@deepseek-ai/dsh-patent-core'
import { createToolInputReader } from './internal/tool-input.ts'
import type { PatentType, TechDomain } from './draft-claims.ts'
import { WARNINGS_SCHEMA } from './internal/tool-output.ts'

/** Minimal figure-analysis shape the drafting layer reads (Sati figure/types.ts). */
type FigureAnalysisResult = {
  figureDescription: string
  electrical?: { components: Array<{ ref: string; name: string; value?: string }> }
}

/** Input for the draft_specification tool. */
export type DraftSpecificationInput = {
  /** Invention title (max 25 chars). */
  title: string
  /** Technical domain. */
  tech_domain?: TechDomain
  /** Patent type: invention or utility model (default invention). */
  patent_type?: PatentType
  /** Technical problem to solve (optional). */
  technical_problem?: string
  /** Technical solution description (optional). */
  technical_solution?: string
  /** Beneficial effects (optional). */
  beneficial_effects?: string
  /** Background / prior-art description (optional). */
  background?: string
  /** Drawing descriptions (optional, body only, e.g. "整体结构示意图"; no figure number prefix or terminal punctuation). */
  drawing_descriptions?: string[]
  /** Figure-analysis results (optional): auto-generate drawing descriptions when absent. */
  figure_analysis?: FigureAnalysisResult[]
  /** Embodiments (optional, may be several). */
  embodiments?: string[]
  /** Whether drawings exist (utility models require them). */
  has_drawings?: boolean
}

/** One specification section (name, content, and placeholder flag). */
export type SpecificationSection = {
  name: string
  content: string
  /** Whether this is a template guide (missing user input). */
  placeholder: boolean
}

/** Output of the draft_specification tool. */
export type DraftSpecificationOutput = {
  title: string
  tech_domain: TechDomain
  patent_type: PatentType
  /** Deterministic abstract (≤300 characters) carrying the title, problem, solution and effects. */
  abstract: string
  sections: SpecificationSection[]
  /** Whether every section carries written content rather than a drafting guide. */
  complete: boolean
  /** Sections still holding a drafting guide. */
  missing_inputs: string[]
  warnings: string[]
}

const DESCRIPTION = '根据技术交底书或技术方案撰写符合要求的专利说明书草案（技术领域/背景技术/发明内容/附图说明/具体实施方式五部分，无附图发明省略附图说明），并生成不超过 300 字、含关键词行的确定性摘要。当用户要求撰写说明书、写专利申请文件时使用，避免自行手写说明书文本。'

/**
 * Render the canonical draft into model-facing Markdown.
 *
 * The five parts are the only headings: the draft body can be carried into the
 * specification as it is, and `validate_specification`'s heading set accepts
 * it. The placeholder marker stays in the section text (each placeholder
 * section's content opens with 【撰写指引】), so the title, the domain line and
 * the warnings are emphasis, not headings.
 * @param value - the drafted sections and warnings.
 * @returns the rendered Markdown text.
 */
export function renderDraftSpecification(value: DraftSpecificationOutput): string {
  const completeness = value.complete ? '完整' : `未完成（缺少：${value.missing_inputs.join('、')}）`
  const lines = [
    `**说明书草案（${value.title}）**`,
    `技术领域: ${value.tech_domain} · 专利类型: ${value.patent_type} · 完整度: ${completeness}`,
    '',
    `摘要: ${value.abstract}`,
    '',
  ]
  for (const section of value.sections) {
    lines.push(`## ${section.name}`, '', section.content, '')
  }
  if (value.warnings.length > 0) lines.push('**警告**', ...value.warnings.map(w => `- ${w}`))
  return lines.join('\n')
}

/** Technical-domain label for the 技术领域 section (general renders empty). */
const DOMAIN_LABELS: Partial<Record<TechDomain, string>> = {
  mechanical: '机械',
  electrical: '电学',
  chemical: '化学',
  software: '软件',
}

function buildTechField(title: string, domain: TechDomain): SpecificationSection {
  const domainLabel = DOMAIN_LABELS[domain] ?? ''
  const subject = title.startsWith('一种') ? title : `一种${title}`
  const content = domainLabel.length > 0
    ? `本发明涉及${domainLabel}技术领域，尤其涉及${subject}。`
    : `本发明涉及${subject}。`
  return { name: '技术领域', content, placeholder: false }
}

function buildBackground(background?: string): SpecificationSection {
  if (background && background.trim()) return { name: '背景技术', content: background.trim(), placeholder: false }
  return { name: '背景技术', content: '【撰写指引】描述现有技术的不足：① 引证与本申请最接近的现有技术文件并注明出处；② 指出现有技术存在的问题/缺陷，引出本申请要解决的技术问题。', placeholder: true }
}

function buildContent(input: DraftSpecificationInput): SpecificationSection {
  const parts: string[] = []
  const problem = input.technical_problem?.trim()
  const solution = input.technical_solution?.trim()
  const effects = input.beneficial_effects?.trim()
  if (problem) parts.push(`本发明要解决的技术问题是：${problem}`)
  else parts.push('【撰写指引】记载要解决的技术问题（与背景技术的缺陷对应）。')
  if (solution) parts.push(`为解决上述技术问题，本发明提供如下技术方案：${solution}`)
  else parts.push('【撰写指引】记载技术方案（与权利要求的技术特征对应，问题→方案→效果逻辑链完整）。')
  if (effects) parts.push(`本发明的有益效果是：${effects}`)
  else parts.push('【撰写指引】记载有益效果（与区别技术特征对应，有对比实验或理论推导支撑）。')
  return { name: '发明内容', content: parts.join('\n'), placeholder: !(problem && solution && effects) }
}

/** 附图说明描述允许自带的图号前缀：`图1为`、`图 2是`、`附图3：`。 */
const FIGURE_PREFIX = /^\s*(?:图|附图)\s*(?:\d+|[一二三四五六七八九十百]+)\s*(?:为|是|：|:)?\s*/

/** 去掉描述自带的图号前缀；图号统一由 buildDrawings 按图序生成。 */
function stripFigurePrefix(text: string): string {
  return text.replace(FIGURE_PREFIX, '')
}

function buildDrawings(
  descriptions: string[] | undefined,
  hasDrawings: boolean | undefined,
  patentType: PatentType,
): SpecificationSection | undefined {
  if (descriptions && descriptions.length > 0) {
    const content = descriptions.map((d, i) => `图${i + 1}为${stripFigurePrefix(d.trim())}`).join('\n')
    return { name: '附图说明', content, placeholder: false }
  }
  if (hasDrawings === true || patentType === 'utility_model') {
    return { name: '附图说明', content: '【撰写指引】按图序逐图说明：图1为整体结构示意图，图2为局部放大图（按实际附图调整）。', placeholder: true }
  }
  // 指南第二部分第二章 2.3：发明专利可以没有附图，此时不输出空的附图说明章节。
  return undefined
}

function buildEmbodiments(embodiments?: string[], patentType?: PatentType): SpecificationSection {
  if (embodiments && embodiments.length > 0) {
    const content = embodiments.map((e, i) => `实施例${i + 1}：${e.trim()}`).join('\n')
    return { name: '具体实施方式', content, placeholder: false }
  }
  return { name: '具体实施方式', content: `【撰写指引】撰写至少一个实施例，使所属领域技术人员能够实现：① 实施例的操作步骤/参数/条件记载完整；② 数值范围给出端点值和至少一个中间值的实施例；③ 有益效果有定量效果数据；④ 有与最接近现有技术的对比实验数据（${patentType === 'utility_model' ? '实用新型' : '创造性'}判断的关键支撑）。`, placeholder: true }
}

/** Trim to a codepoint budget, never splitting a surrogate pair. */
function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/**
 * Compose a deterministic abstract from the same fields the draft uses.
 *
 * The abstract never cites a claim number and always ends with a keyword line;
 * the body is clipped so the whole text stays within the 300-character limit.
 * @param input - the specification-drafting request.
 * @returns the abstract text (1..300 characters).
 */
export function composeAbstract(input: DraftSpecificationInput): string {
  const title = input.title.trim()
  const subject = title.startsWith('一种') ? title : `一种${title}`
  const problem = input.technical_problem?.trim() ?? ''
  const solution = input.technical_solution?.trim() ?? ''
  const effects = input.beneficial_effects?.trim() ?? ''
  const keywordSource = subject.replace(/^一种/, '').replace(/[，。；、：:,.;\s]/g, '')
  const keywords = `关键词：${clip(keywordSource, 20)}`
  const parts = [`本发明公开了${subject}`]
  if (problem.length > 0) parts.push(`，要解决的技术问题是${problem}`)
  if (solution.length > 0) parts.push(`。技术方案：${solution}`)
  if (effects.length > 0) parts.push(`。有益效果：${effects}`)
  const body = parts.join('').replace(/[。；]+$/, '')
  const budget = 300 - Array.from(keywords).length - 1
  return `${clip(body, budget)}。${keywords}`
}

function resolveDomain(hint: TechDomain | undefined, title: string, input: DraftSpecificationInput): TechDomain {
  return resolveClaimDomain(
    hint,
    `${title} ${input.technical_solution ?? ''} ${input.background ?? ''}`,
    [],
  )
}

/** Enrich a figure description with electrical component detail (Step3), when present. */
function enrichFigureDescription(figure: FigureAnalysisResult): string {
  const base = figure.figureDescription.trim()
  const electrical = figure.electrical
  if (!electrical || electrical.components.length === 0) return base
  const hasAllRefs = electrical.components.every(component => base.includes(component.ref))
  if (hasAllRefs) return base
  const details = electrical.components.map(component => `${component.ref}-${component.name}${component.value ? `（${component.value}）` : ''}`).join('；')
  return base.length > 0 ? `${base}\n图中：${details}；` : `电路原理图；图中：${details}；`
}

/**
 * Pure entry point: assemble a five-part specification draft.
 * @param input - the specification-drafting request.
 * @returns the drafted sections and warnings.
 */
export function draftSpecification(input: DraftSpecificationInput): DraftSpecificationOutput {
  const title = input.title.trim()
  const patentType: PatentType = input.patent_type ?? 'invention'
  const domain = resolveDomain(input.tech_domain, title, input)
  const warnings: string[] = []
  if (input.patent_type === undefined) warnings.push('未声明专利类型，草案按发明专利处理')
  if (title.length > 25) warnings.push(`发明名称 ${title.length} 字，超过 25 字限制`)
  if (patentType === 'utility_model' && !input.has_drawings) warnings.push('实用新型必须有附图，请确认补充附图')
  const explicitDescriptions = input.drawing_descriptions && input.drawing_descriptions.length > 0 ? input.drawing_descriptions : undefined
  const autoDescriptions = input.figure_analysis?.map(f => enrichFigureDescription(f).trim()).filter(d => d.length > 0) ?? []
  const drawingDescriptions = explicitDescriptions ?? (autoDescriptions.length > 0 ? autoDescriptions : undefined)
  if (!explicitDescriptions && autoDescriptions.length > 0) warnings.push('附图说明由附图智能分析自动生成，请人工核对附图标记与图面一致')
  const sections = [
    buildTechField(title, domain),
    buildBackground(input.background),
    buildContent(input),
    buildDrawings(drawingDescriptions, input.has_drawings, patentType),
    buildEmbodiments(input.embodiments, patentType),
  ].filter((section): section is SpecificationSection => section !== undefined)
  const missingInputs = sections.filter(section => section.placeholder).map(section => section.name)
  return {
    title,
    tech_domain: domain,
    patent_type: patentType,
    abstract: composeAbstract(input),
    sections,
    complete: missingInputs.length === 0,
    missing_inputs: missingInputs,
    warnings,
  }
}

const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    content: { type: 'string', required: true },
    placeholder: { type: 'boolean', required: true },
  },
} as const

const input = createToolInputReader('draft_specification')
const invalidToolInput = input.invalid
const requireString = input.requireString

/**
 * Validate `figure_analysis` before drafting reads it. The tool schema types the
 * items as JSON, so a null entry or an object without `figureDescription` would
 * otherwise reach `.trim()` / `.length` as a bare TypeError.
 */
function parseFigureAnalysis(raw: unknown): FigureAnalysisResult[] {
  /* v8 ignore next -- the tool schema rejects a non-array before execute; the guard serves direct callers */
  if (!Array.isArray(raw)) throw invalidToolInput('figure_analysis 必须是数组')
  return raw.map((entry, index) => {
    const field = `figure_analysis[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidToolInput(`${field} 必须是对象`)
    }
    const record = entry as Record<string, unknown>
    const figureDescription = requireString(record.figureDescription, `${field}.figureDescription`)
    if (record.electrical === undefined) return { figureDescription }
    if (record.electrical === null || typeof record.electrical !== 'object' || Array.isArray(record.electrical)) {
      throw invalidToolInput(`${field}.electrical 必须是对象`)
    }
    const electrical = record.electrical as Record<string, unknown>
    if (!Array.isArray(electrical.components)) {
      throw invalidToolInput(`${field}.electrical.components 必须是数组`)
    }
    const components = electrical.components.map((component, componentIndex) => {
      const componentField = `${field}.electrical.components[${componentIndex}]`
      if (component === null || typeof component !== 'object' || Array.isArray(component)) {
        throw invalidToolInput(`${componentField} 必须是对象`)
      }
      const item = component as Record<string, unknown>
      const value = item.value === undefined ? undefined : requireString(item.value, `${componentField}.value`)
      return {
        ref: requireString(item.ref, `${componentField}.ref`),
        name: requireString(item.name, `${componentField}.name`),
        ...(value === undefined ? {} : { value }),
      }
    })
    return { figureDescription, electrical: { components } }
  })
}

/** Arguments before figure analysis validation; the tool schema types every other field. */
type DraftSpecificationArgs = Omit<DraftSpecificationInput, 'figure_analysis'> & { figure_analysis?: unknown }

/** Build the typed drafting input from the model's JSON arguments. */
function parseDraftSpecificationInput(args: DraftSpecificationArgs): DraftSpecificationInput {
  const { figure_analysis: rawFigureAnalysis, ...rest } = args
  const figureAnalysis = rawFigureAnalysis === undefined ? undefined : parseFigureAnalysis(rawFigureAnalysis)
  return {
    ...rest,
    ...(figureAnalysis === undefined ? {} : { figure_analysis: figureAnalysis }),
  }
}

/**
 * Build the `draft_specification` tool (pure, no dependencies).
 * @returns a registry-ready tool definition.
 */
export function createDraftSpecificationTool(): ToolDefinition {
  return defineTool({
    name: 'draft_specification',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: '发明名称（不超过 25 字）' },
      tech_domain: { type: 'string', enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'], description: '技术领域（为空时自动识别）' },
      patent_type: { type: 'string', enum: ['invention', 'utility_model'], description: '专利类型：发明或实用新型（默认 invention）' },
      technical_problem: { type: 'string', description: '要解决的技术问题（可选）' },
      technical_solution: { type: 'string', description: '技术方案描述（可选）' },
      beneficial_effects: { type: 'string', description: '有益效果（可选）' },
      background: { type: 'string', description: '背景技术/现有技术描述（可选）' },
      drawing_descriptions: { type: 'array', items: { type: 'string' }, description: '附图说明（可选，每项只写图名与描述文字，不含图号与句末标点，如 "整体结构示意图"）' },
      figure_analysis: { type: 'array', items: { type: 'json' }, description: '附图智能分析结果（可选，未提供 drawing_descriptions 时自动生成附图说明）' },
      embodiments: { type: 'array', items: { type: 'string' }, description: '具体实施方式（可选，可多个实施例）' },
      has_drawings: { type: 'boolean', description: '是否有附图（实用新型必须有附图）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          tech_domain: { type: 'string', required: true, enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'] },
          patent_type: { type: 'string', required: true, enum: ['invention', 'utility_model'] },
          abstract: { type: 'string', required: true, description: '确定性摘要（≤300 字，含关键词行，不引用权利要求编号）' },
          sections: { type: 'array', required: true, items: SECTION_SCHEMA },
          complete: { type: 'boolean', required: true },
          missing_inputs: { type: 'array', required: true, items: { type: 'string' } },
          warnings: WARNINGS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDraftSpecification(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      return draftSpecification(parseDraftSpecificationInput(args))
    },
  })
}
