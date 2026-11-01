/**
 * `triz_contradiction_analysis` tool: 交底书侧的技术矛盾识别与参数完备性检查。
 *
 * 用途是发明人侧的两件事：由矛盾给出可替代手段方向（方案生成），以及列出
 * 交底书提到却没给取值的工程参数（补强清单）。模型只负责识别，编号合法性、
 * 矩阵落格与证据定位由 `@deepseek-ai/dsh-patent-core` 判定；证据无法在原文
 * 定位的矛盾被丢弃并计数。
 *
 * 产物不进入创造性三步法第二步的「实际解决的技术问题」表述——该问题必须相对
 * 区别特征确定且不含解决手段。
 * @module @deepseek-ai/dsh-patent-tools/tool/triz-contradiction-analysis
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  asJsonArray,
  asJsonRecord,
  buildTrizAnalysis,
  extractTrizContradictions,
  readJsonNumber,
  readJsonString,
  type PatentModelPort,
  type TrizContradictionAnalysis,
} from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'
import { loggedToolModel } from './internal/model-call-log.ts'

/** Input for the triz_contradiction_analysis tool. */
export type TrizContradictionAnalysisInput = {
  /** 技术交底书或技术方案原文。 */
  text: string
  /** 可选关注方向（收窄识别范围，如「节拍」「良率」）。 */
  focus?: string
}

/** Injected model port (the integrator wires a createLlmModelPort over ctx.llm). */
export type TrizContradictionAnalysisDeps = {
  model?: PatentModelPort
}

/** 一条矛盾的工具输出形状（JSON 值，字段与内核类型同构）。 */
type TrizContradictionJson = {
  id: string
  improving: { number: number; name: string }
  worsening: { number: number; name: string }
  statement: string
  evidence: string
  principles: Array<{ number: number; name: string }>
  matrixStatus: string
  solutionDirections: string[]
}

/** 一条参数缺口的工具输出形状。 */
type TrizParameterGapJson = {
  parameter: { number: number; name: string }
  missing: string[]
  detail: string
}

/** 一条未采纳项的工具输出形状。 */
type TrizUnmappedJson = {
  statement: string
  reason: string
}

/** Output of the triz_contradiction_analysis tool. */
type TrizContradictionAnalysisOutput = {
  contradictions: TrizContradictionJson[]
  parameter_gaps: TrizParameterGapJson[]
  unmapped: TrizUnmappedJson[]
  dropped_for_evidence: number
}

const DESCRIPTION = [
  '交底书侧的技术矛盾分析与参数完备性检查（发明人侧用途）。',
  '从技术交底书识别「改善某工程参数的同时牺牲另一工程参数」的技术矛盾，落格到 TRIZ 39x39 经典矛盾矩阵取推荐发明原理，',
  '并列出交底书提到但未给出取值的工程参数（缺现状值／目标值／单位／测量口径）。',
  '两处用途：① 方案生成——按推荐原理给出可替代的手段方向；② 交底书补强——把缺口清单交发明人补充。',
  '识别由模型完成，编号合法性（1-39）、矩阵落格与证据定位由程序判定：evidence 必须在交底书原文中逐字定位，否则该条矛盾被丢弃并计入 dropped_for_evidence。',
  '本工具不产出审查语义的技术问题表述，也不构成法律结论；',
  '创造性三步法第二步的「实际解决的技术问题」必须相对区别特征确定且不含解决手段，不得由本工具的产物代填。',
].join('')

/** 矩阵状态的模型可读标签。 */
const MATRIX_STATUS_LABELS: Record<string, string> = {
  recommended: '矩阵有推荐原理',
  physical: '物理矛盾（对角格，经典矩阵无条目）',
  gap: '矩阵转录空缺（无推荐原理）',
}

/** 缺口维度的模型可读标签。 */
const GAP_KIND_LABELS: Record<string, string> = {
  'current-value': '缺现状值',
  'target-value': '缺目标值',
  unit: '缺单位',
  'test-method': '缺测量口径',
  other: '其它缺口',
}

/** 读取字符串；非字符串按空串渲染。 */
function text(value: unknown): string {
  return readJsonString(value) ?? ''
}

/** 读取参数引用行「名称（编号）」。 */
function renderParameterRef(value: unknown): string {
  const record = asJsonRecord(value)
  if (record === undefined) return '未命名参数'
  const no = readJsonNumber(record.number)
  const name = text(record.name)
  return no === undefined ? name : `${name}（${no}）`
}

/** 渲染一条矛盾。 */
function renderContradiction(value: unknown, index: number): string[] {
  const record = asJsonRecord(value)
  if (record === undefined) return []
  const status = text(record.matrixStatus)
  const lines = [
    `- ${text(record.id) || `C${index + 1}`} 改善「${renderParameterRef(record.improving)}」↔ 恶化「${renderParameterRef(record.worsening)}」｜${MATRIX_STATUS_LABELS[status] ?? status}`,
    `  - 矛盾：${text(record.statement)}`,
    `  - 证据：${text(record.evidence)}`,
  ]
  const principles = asJsonArray(record.principles)
    .map((entry) => {
      const principle = asJsonRecord(entry)
      if (principle === undefined) return ''
      const no = readJsonNumber(principle.number)
      const name = text(principle.name)
      return no === undefined ? name : `${no} ${name}`.trim()
    })
    .filter(entry => entry.length > 0)
  lines.push(principles.length > 0 ? `  - 推荐原理：${principles.join('；')}` : '  - 推荐原理：无（矩阵无条目或转录空缺）')
  const directions = asJsonArray(record.solutionDirections).map(text).filter(entry => entry.length > 0)
  if (directions.length > 0) {
    lines.push('  - 候选方案方向：', ...directions.map(direction => `    - ${direction}`))
  }
  return lines
}

/** 渲染一条参数缺口。 */
function renderGap(value: unknown): string {
  const record = asJsonRecord(value)
  if (record === undefined) return ''
  const missing = asJsonArray(record.missing)
    .map(kind => GAP_KIND_LABELS[text(kind)] ?? text(kind))
    .filter(entry => entry.length > 0)
  const detail = text(record.detail)
  return `- ${renderParameterRef(record.parameter)}：${missing.join('、')}${detail.length > 0 ? ` —— ${detail}` : ''}`
}

/** 渲染一条未采纳项。 */
function renderUnmapped(value: unknown): string {
  const record = asJsonRecord(value)
  if (record === undefined) return ''
  const statement = text(record.statement)
  if (statement.length === 0) return ''
  return `- ${statement} —— ${text(record.reason)}`
}

/**
 * 渲染工具结果为模型可读文本（纯函数，从 canonical 值派生）。
 * @param value - the tool's canonical output value.
 * @returns the model-facing prose.
 */
export function renderTrizContradictionAnalysis(value: unknown): string {
  const record = asJsonRecord(value)
  if (record === undefined) return 'triz_contradiction_analysis: 无结果'
  const contradictions = asJsonArray(record.contradictions)
  const gaps = asJsonArray(record.parameter_gaps)
  const unmapped = asJsonArray(record.unmapped)
  const dropped = readJsonNumber(record.dropped_for_evidence) ?? 0
  const statusCounts = contradictions.map((entry) => {
    const item = asJsonRecord(entry)
    return item === undefined ? '' : text(item.matrixStatus)
  })
  const withPrinciples = statusCounts.filter(status => status === 'recommended').length
  const physical = statusCounts.filter(status => status === 'physical').length
  const gapCells = statusCounts.filter(status => status === 'gap').length

  const lines = [
    `triz_contradiction_analysis: 矛盾 ${contradictions.length} 条（有推荐原理 ${withPrinciples}、物理矛盾 ${physical}、矩阵空缺 ${gapCells}），`
    + `参数缺口 ${gaps.length} 项，未采纳 ${unmapped.length} 条（其中证据未定位丢弃 ${dropped} 条）。`,
    '',
    '## 技术矛盾（发明人侧：方案方向与交底书补强，不作三步法第二步的问题表述）',
  ]
  if (contradictions.length === 0) {
    lines.push('未识别到有原文证据支撑的技术矛盾。')
  } else {
    for (const [index, entry] of contradictions.entries()) lines.push(...renderContradiction(entry, index))
  }
  lines.push('', '## 参数完备性缺口（交底书补强清单）')
  const gapLines = gaps.map(renderGap).filter(line => line.length > 0)
  lines.push(...(gapLines.length > 0 ? gapLines : ['无缺口记录。']))
  if (unmapped.length > 0) {
    lines.push('', '## 未采纳')
    lines.push(...unmapped.map(renderUnmapped).filter(line => line.length > 0))
  }
  return lines.join('\n')
}

/** 组装工具输出：把内核的只读结构摊成可变 JSON 值。 */
function toOutput(analysis: TrizContradictionAnalysis): TrizContradictionAnalysisOutput {
  return {
    contradictions: analysis.contradictions.map(contradiction => ({
      id: contradiction.id,
      improving: { number: contradiction.improving.number, name: contradiction.improving.name },
      worsening: { number: contradiction.worsening.number, name: contradiction.worsening.name },
      statement: contradiction.statement,
      evidence: contradiction.evidence,
      principles: contradiction.principles.map(principle => ({ number: principle.number, name: principle.name })),
      matrixStatus: contradiction.matrixStatus,
      solutionDirections: [...contradiction.solutionDirections],
    })),
    parameter_gaps: analysis.parameterGaps.map(gap => ({
      parameter: { number: gap.parameter.number, name: gap.parameter.name },
      missing: [...gap.missing],
      detail: gap.detail,
    })),
    unmapped: analysis.unmapped.map(item => ({ statement: item.statement, reason: item.reason })),
    dropped_for_evidence: analysis.droppedForEvidence,
  }
}

/**
 * Build the `triz_contradiction_analysis` tool over an injectable model port.
 * @param deps - the model port driving contradiction recognition.
 * @returns a registry-ready tool definition.
 */
export function createTrizContradictionAnalysisTool(deps: TrizContradictionAnalysisDeps = {}): ToolDefinition {
  return defineTool({
    name: 'triz_contradiction_analysis',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: '技术交底书或技术方案原文（矛盾与缺口都从这段文本识别，证据需可在其中逐字定位）。' },
      focus: { type: 'string', description: '可选关注方向，收窄识别范围（如「节拍」「良率」「温差」）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contradictions: { type: 'array', required: true, items: { type: 'json' } },
          parameter_gaps: { type: 'array', required: true, items: { type: 'json' } },
          unmapped: { type: 'array', required: true, items: { type: 'json' } },
          dropped_for_evidence: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTrizContradictionAnalysis(value) }],
    },
    async execute(args, exec) {
      const sourceText = args.text
      if (sourceText.trim().length === 0) {
        throw new PatentToolError('invalid_tool_input', 'text 为空（须为技术交底书或技术方案原文）', { tool: 'triz_contradiction_analysis' })
      }
      const model = loggedToolModel(exec, deps.model, { callSite: 'triz_contradiction_analysis' })
      if (model === undefined) {
        throw new PatentToolError('setup_required', '未配置 LLM（模型客户端缺失），无法识别技术矛盾', { tool: 'triz_contradiction_analysis' })
      }
      const outcome = await extractTrizContradictions(model, sourceText, args.focus === undefined ? {} : { focus: args.focus })
      if (!outcome.ok) {
        throw new PatentToolError('tool_execution_failed', outcome.message, { tool: 'triz_contradiction_analysis' })
      }
      return toOutput(buildTrizAnalysis(outcome.extraction, sourceText))
    },
  })
}
