/**
 * `patent_eval` tool: deterministic patent-work-product quality evaluation
 * (report / retrieval / workflow / citations / comprehensive). Ported from Sati's
 * patentEval.ts; the slop-engine "表达质量" dimension is ported into
 * internal/slop-engine.ts.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-eval
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { recordEntries, recordFlag, recordNumberOr, recordString } from './internal/json-read.ts'
import { toJsonValue } from './internal/json-value.ts'
import type { SearchStrategy } from '@deepseek-ai/dsh-patent-core'
import { analyzeSlop } from '../internal/slop-engine.ts'

/** Evaluation mode for the patent_eval tool. */
export type PatentEvalMode = 'report' | 'retrieval' | 'workflow' | 'citations' | 'comprehensive'

/** Input for the patent_eval tool. */
export type PatentEvalInput = {
  /** Evaluation mode: report / retrieval / workflow / citations / comprehensive. */
  mode: PatentEvalMode
  /** Content to evaluate (report body / keyword list / workflow steps / citation list). */
  content?: string
  /** Statute citations that must be present (e.g. ["第二十二条第二款", "第二十二条第三款"]). */
  required_citations?: string[]
}

/** One scored evaluation dimension. */
export type PatentEvalDimension = {
  score: number
  passed: boolean
  details?: string
}

/** Output of the patent_eval tool. */
export type PatentEvalOutput = {
  mode: PatentEvalMode
  score: number
  passed: boolean
  details: Record<string, PatentEvalDimension>
  summary: string
  /** 标准化检索策略记录（retrieval/comprehensive 模式产出）。 */
  searchStrategy?: SearchStrategy
}

/** Report structure section patterns (aligns Mady reportSectionPatterns). */
const REPORT_SECTIONS: Array<{ name: string; pattern: RegExp }> = [
  { name: '技术领域', pattern: /^#{1,3}\s*技术领域/m },
  { name: '背景技术', pattern: /^#{1,3}\s*背景技术/m },
  { name: '发明内容', pattern: /^#{1,3}\s*发明内容/m },
  { name: '技术方案', pattern: /^#{1,3}\s*技术方案/m },
  { name: '有益效果', pattern: /^#{1,3}\s*有益效果/m },
  { name: '附图说明', pattern: /^#{1,3}\s*附图说明/m },
  { name: '具体实施方式', pattern: /^#{1,3}\s*具体实施方式/m },
  { name: '法律依据', pattern: /^#{1,3}\s*法律依据/m },
  { name: '分析结论', pattern: /^#{1,3}\s*(分析结论|结论)/m },
  { name: '权利要求', pattern: /^#{1,3}\s*权利要求/m },
]

const PASS_LINE = 0.7

/**
 * Absolute phrasings the slop penalty counts. These are the terms `PAT-ABS-001`
 * flags in the rule gate, so `patent-eval`'s score and the gate agree; a test
 * reads the shipped rule asset and fails when the two lists drift.
 */
export const ABSOLUTE_PHRASES: readonly string[] = [
  '绝对可以',
  '绝对可行',
  '绝对能',
  '绝对是',
  '绝对优于',
  '绝对领先',
  '一定能够',
  '一定会',
  '一定是',
  '一定属于',
  '一定具有',
  '百分百',
  '毫无疑问',
  '必然导致',
  '必然会',
  '必然能够',
]

const DESCRIPTION = '评估专利相关产出的质量（报告/检索/流程/引用/综合）。返回结构化评分和通过/失败判定。支持 5 种评估模式（report/retrieval/workflow/citations/comprehensive），在提交人工复核前使用可提前发现质量问题。'

/** Render the canonical evaluation value into model-facing prose. */
function renderEval(value: { summary: string; details: unknown }): string {
  const parts = [value.summary]
  for (const [key, dim] of recordEntries(value.details)) {
    const extra = recordString(dim, 'details')
    parts.push(`  ${recordFlag(dim, 'passed') ? '✅' : '❌'} ${key}: ${recordNumberOr(dim, 'score', 0).toFixed(2)}${extra ? `（${extra}）` : ''}`)
  }
  return parts.join('\n')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function averageScores(dims: PatentEvalDimension[]): number {
  if (dims.length === 0) return 0
  return dims.reduce((sum, d) => sum + d.score, 0) / dims.length
}

/** Non-comprehensive mode → summary-line label. */
const MODE_LABELS: Record<Exclude<PatentEvalMode, 'comprehensive'>, string> = {
  report: '报告质量',
  retrieval: '检索式形态',
  workflow: '流程完整性',
  citations: '引用合规性',
}

function summarize(mode: Exclude<PatentEvalMode, 'comprehensive'>, score: number): string {
  const label = MODE_LABELS[mode]
  return `${label}评分: ${score.toFixed(2)}/1.0 (${score >= PASS_LINE ? '通过' : '需修订'})`
}

function scoreSectionCoverage(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  let found = 0
  for (const sp of REPORT_SECTIONS) {
    if (sp.pattern.test(trimmed)) found += 1
  }
  return found / REPORT_SECTIONS.length
}

function sectionCoverageDetail(text: string): string {
  const present: string[] = []
  const missing: string[] = []
  for (const sp of REPORT_SECTIONS) {
    if (sp.pattern.test(text)) present.push(sp.name)
    else missing.push(sp.name)
  }
  const parts = [`已覆盖 ${present.length}/${REPORT_SECTIONS.length} 个章节。`]
  if (missing.length > 0) parts.push(`缺失: ${missing.join('、')}`)
  return parts.join('')
}

function countAbsolutePhrases(text: string): number {
  return ABSOLUTE_PHRASES.filter(p => text.includes(p)).length
}

function scoreFromSlopAnalysis(analysis: ReturnType<typeof analyzeSlop>, text: string): number {
  const base = analysis.score.total / 43
  const penalty = Math.min(0.25, analysis.issues.length * 0.05) + Math.min(0.25, countAbsolutePhrases(text) * 0.05)
  return Math.max(0, Math.min(1, base - penalty))
}

function scoreContentSufficiency(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const chars = Array.from(trimmed).length
  if (chars < 50) return 0.1
  if (chars < 200) return 0.3
  if (chars < 500) return 0.5
  if (chars < 1000) return 0.7
  const paras = trimmed.split(/\n\s*\n/).length
  if (paras < 3) return 0.6
  return 1.0
}

function evaluateReport(text: string): Record<string, PatentEvalDimension> {
  const dims: Record<string, PatentEvalDimension> = {}
  const sectionScore = scoreSectionCoverage(text)
  dims['结构完整性'] = { score: round2(sectionScore), passed: sectionScore >= 0.6, details: sectionCoverageDetail(text) }
  const slopAnalysis = analyzeSlop(text)
  const slopScore = scoreFromSlopAnalysis(slopAnalysis, text)
  dims['表达质量'] = {
    score: round2(slopScore),
    passed: slopScore >= 0.6,
    details: `${slopAnalysis.changes.length} 处短语套话、${slopAnalysis.issues.length} 处结构缺陷、${countAbsolutePhrases(text)} 处绝对化表述（43 分制 ${slopAnalysis.score.total}/43）`,
  }
  const sufficient = scoreContentSufficiency(text)
  dims['内容充分性'] = { score: round2(sufficient), passed: sufficient >= 0.5 }
  return dims
}

/**
 * retrieval 模式只判检索式的形态：词条数（≥3 记满分、≥1 记半分），不看结果里相关
 * 文献排在第几条。它因此不是检索质量度量——检索质量由 `eval/ir-metrics.ts` 的指标
 * （rank of first relevant 等）度量，两者的分数不可互推。
 */
function evaluateRetrieval(text: string): Record<string, PatentEvalDimension> {
  const trimmed = text.trim()
  const keywords = trimmed.split(/\s+/).filter(Boolean)
  let keywordScore = 0
  if (keywords.length >= 3) keywordScore = 1.0
  else if (keywords.length >= 1) keywordScore = 0.5
  return {
    关键词条数: {
      score: keywordScore,
      passed: keywordScore >= 0.5,
      details: `检索式含 ${keywords.length} 个关键词/分类号（只判检索式形态，不判检索结果质量）`,
    },
  }
}

/**
 * 行首的步骤标记：可带 markdown 标题（`##`）或无序列表项（`-`）前缀，后接步骤词，
 * 或中文序数写法（`第一步` / `第二阶段`）。只认行首，正文里的行内提及
 * （"如该步骤中……"）不计入。数字编号的行首由 {@link ORDERED_STEP_RE} 独立命中。
 */
const STEP_MARKER_RE =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?(?:步骤|阶段|step|phase|第\s*[一二三四五六七八九十百零两\d]+\s*(?:步骤|步|阶段|环节))/i

/**
 * 有序列表项本身即一步：工作流文档惯以编号枚举阶段，不重复写"步骤"二字。
 * 代价是任何编号列表都会被计为步骤（权利要求清单、文献清单亦然）。该计数既决定
 * `workflow` 模式的通过判定，也以 0.15 权重进入 `comprehensive` 的综合分，因此编号
 * 列表会把「流程完整性」抬高：读这一维的分数时先确认它是不是被列表撑起来的。
 */
const ORDERED_STEP_RE = /^[ \t]*\d+[.、)][ \t]*\S/

function evaluateWorkflow(text: string): Record<string, PatentEvalDimension> {
  const steps = text.split(/\r?\n/).filter(line => STEP_MARKER_RE.test(line) || ORDERED_STEP_RE.test(line))
  let stepScore = 0
  if (steps.length >= 5) stepScore = 1.0
  else if (steps.length >= 3) stepScore = 0.6
  else if (steps.length >= 1) stepScore = 0.3
  return { 流程完整性: { score: stepScore, passed: stepScore >= 0.6, details: `检出 ${steps.length} 个工作流步骤` } }
}

function evaluateCitations(text: string, required: string[]): Record<string, PatentEvalDimension> {
  const dims: Record<string, PatentEvalDimension> = {}
  let citationScore = 0
  if (required.length > 0) {
    const covered = required.filter(r => text.includes(r)).length
    citationScore = covered / required.length
  } else {
    citationScore = text.includes('第') && /第[零一二三四五六七八九十百千\d]+条/.test(text) ? 1.0 : 0.3
  }
  // 没给要求清单时无法核对覆盖度：details 必须说清这是抽查，不能报「要求 0 条、覆盖度 100%」。
  const basis = required.length > 0
    ? `要求 ${required.length} 条引用，覆盖度 ${Math.round(citationScore * 100)}%`
    : '未提供 required_citations：按正文是否引用法条抽查，未核对覆盖度'
  dims['引用合规性'] = { score: round2(citationScore), passed: citationScore >= 0.7, details: basis }
  const formatPattern = /第[零一二三四五六七八九十百千\d]+条/g
  const formatMatches = text.match(formatPattern) ?? []
  const formatScore = formatMatches.length > 0 ? 1.0 : 0.3
  dims['引用格式'] = { score: formatScore, passed: formatScore >= 0.5, details: `检出 ${formatMatches.length} 处法条引用格式` }
  return dims
}

function runComprehensiveEval(text: string, required: string[]): PatentEvalOutput {
  const allDims: Record<string, PatentEvalDimension> = {
    ...evaluateReport(text),
    ...evaluateRetrieval(text),
    ...evaluateWorkflow(text),
    ...evaluateCitations(text, required),
  }
  const weights: Record<string, number> = {
    结构完整性: 0.15, 表达质量: 0.1, 内容充分性: 0.15, 关键词条数: 0.2,
    流程完整性: 0.15, 引用合规性: 0.15, 引用格式: 0.1,
  }
  let weightedSum = 0
  let totalWeight = 0
  for (const [key, dim] of Object.entries(allDims)) {
    /* v8 ignore next -- every dim produced by the four sub-evaluations has a weight entry. */
    const w = weights[key] ?? 0.1
    weightedSum += dim.score * w
    totalWeight += w
  }
  /* v8 ignore next -- the four sub-evaluations always produce at least one weighted dim. */
  const composite = totalWeight > 0 ? weightedSum / totalWeight : 0
  const parts = [`综合质量评分: ${composite.toFixed(2)}/1.0`]
  for (const [key, dim] of Object.entries(allDims)) {
    parts.push(`  ${dim.passed ? '✅' : '❌'} ${key}: ${dim.score.toFixed(2)}`)
  }
  return { mode: 'comprehensive', score: round2(composite), passed: composite >= PASS_LINE, details: allDims, summary: parts.join('\n') }
}

function evaluateMode(mode: PatentEvalMode, text: string, required: string[]): Record<string, PatentEvalDimension> {
  switch (mode) {
    case 'report': return evaluateReport(text)
    case 'retrieval': return evaluateRetrieval(text)
    case 'workflow': return evaluateWorkflow(text)
    case 'citations': return evaluateCitations(text, required)
    default: return {}
  }
}

/**
 * Pure entry point: evaluate patent work product by mode.
 * @param mode - evaluation mode.
 * @param content - content to evaluate.
 * @param requiredCitations - statute citations that must be present.
 * @returns the structured score.
 */
export function evaluatePatentContent(mode: PatentEvalMode, content: string, requiredCitations: string[]): PatentEvalOutput {
  const text = content
  if (mode === 'comprehensive') return runComprehensiveEval(text, requiredCitations)
  const dims = evaluateMode(mode, text, requiredCitations)
  const overall = averageScores(Object.values(dims))
  const output: PatentEvalOutput = {
    mode,
    score: round2(overall),
    passed: overall >= PASS_LINE,
    details: dims,
    summary: summarize(mode, overall),
  }
  if (mode === 'retrieval') {
    const keywords = text.trim().split(/\s+/).filter(Boolean)
    if (keywords.length > 0) {
      output.searchStrategy = { query: text.trim(), keywords, hits: keywords.length }
    }
  }
  return output
}

/**
 * Build the `patent_eval` tool (pure, no dependencies).
 * @returns a registry-ready tool definition.
 */
export function createPatentEvalTool(): ToolDefinition {
  return defineTool({
    name: 'patent_eval',
    description: DESCRIPTION,
    parameters: {
      mode: { type: 'string', required: true, enum: ['report', 'retrieval', 'workflow', 'citations', 'comprehensive'], description: '评估模式: report(分析报告质量) / retrieval(检索式形态) / workflow(流程完整性) / citations(引用合规性) / comprehensive(全面评估)' },
      content: { type: 'string', description: '待评估的内容文本（报告正文/检索关键词列表/工作流步骤/引文列表等）' },
      required_citations: { type: 'array', items: { type: 'string' }, description: '要求必须包含的法条引用列表（如 ["第二十二条第二款", "第二十二条第三款"]）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          score: { type: 'number', required: true },
          passed: { type: 'boolean', required: true },
          details: { type: 'json', required: true },
          summary: { type: 'string', required: true },
          searchStrategy: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEval(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      const out = evaluatePatentContent(args.mode, args.content ?? '', args.required_citations ?? [])
      return {
        mode: out.mode,
        score: out.score,
        passed: out.passed,
        details: out.details,
        summary: out.summary,
        ...(out.searchStrategy !== undefined ? { searchStrategy: toJsonValue(out.searchStrategy) } : {}),
      }
    },
  })
}
