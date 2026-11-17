/**
 * `patent_analysis_report` tool: assemble a standardized patent-analysis product
 * from the application text. Deterministic parts (feature extraction, IPC
 * classification, clarity/completeness scores, rule-derived insights/considerations)
 * come from `@deepseek-ai/dsh-patent-core`'s analysis-report aggregator; the
 * novelty / technical_strength scores are optionally filled by a ModelPort LLM
 * call. When no LLM route is configured (or the call fails) the report falls
 * back to the deterministic dimensions only. The canonical result is written to
 * the session log via the `tools/result` observation point.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-analysis-report
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { toJsonValue } from './internal/json-value.ts'
import { loggedToolModel } from './internal/model-call-log.ts'
import {
  buildAnalysisReport,
  classifyIpc,
  collectPortText,
  dataBlock,
  tryParseJson,
  type IpcClassification,
  type PatentAnalysisReport,
  type PatentModelPort,
  type QualityDomain,
  type SearchStrategy,
} from '@deepseek-ai/dsh-patent-core'

/** Input for the patent_analysis_report tool. */
export type PatentAnalysisReportInput = {
  /** Patent number (optional). */
  patent_id?: string
  /** Invention title. */
  title?: string
  /** Abstract. */
  abstract?: string
  /** Independent + dependent claims (claim 1 first; index order = claim number). */
  claims: string[]
}

/** Output is the canonical {@link PatentAnalysisReport}. */
export type PatentAnalysisReportOutput = PatentAnalysisReport

/** An LLM score-entry placeholder used for the optional model-fill. */
type ModelScoreEntry = { score: number; rationale: string }

/** Dependencies: the optional ModelPort used for novelty / technical_strength. */
export type PatentAnalysisReportDeps = {
  model?: PatentModelPort
}

const DESCRIPTION =
  '生成标准化的专利分析报告：从权利要求抽取技术特征（类型/重要性），进行 IPC 分类，给出清晰度与完整性等确定性评分，并结合 LLM 对新颖性与技术强度补分，输出创新性洞察与专家考量。适合在评估提案、对比现有技术或提交人工复核前生成结构化分析基线。'

const SCORE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    novelty: { type: 'object', properties: { score: { type: 'number' }, rationale: { type: 'string' } } },
    technical_strength: { type: 'object', properties: { score: { type: 'number' }, rationale: { type: 'string' } } },
  },
} as const

/** Narrow the parsed model JSON to a well-formed score entry. */
function asScoreEntry(value: unknown): ModelScoreEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.score !== 'number' || record.score < 0 || record.score > 100) return undefined
  return { score: Math.round(record.score), rationale: typeof record.rationale === 'string' ? record.rationale : '' }
}

/** Ask the model for novelty / technical_strength scores; returns undefined on any failure (fallback). */
async function scoreWithModel(
  model: PatentModelPort,
  input: PatentAnalysisReportInput,
  signal?: AbortSignal,
): Promise<Partial<Record<QualityDomain, ModelScoreEntry>> | undefined> {
  const text = [input.title, input.abstract, ...input.claims].filter(s => s !== undefined && s !== '').join('\n')
  const prompt =
    '你是专利分析助手。基于下面的专利申请内容，对两项指标各打 0-100 分并给出依据。' +
    '若未提供最接近的现有技术，新颖性评分请给出保守的初步判断并注明。只输出 JSON，不要多余文字：\n' +
    '{"novelty":{"score":0,"rationale":""},"technical_strength":{"score":0,"rationale":""}}\n\n' +
    dataBlock(text)
  try {
    const raw = await collectPortText(model, prompt, signal, { temperature: 0.2, schema: SCORE_JSON_SCHEMA })
    const parsed = tryParseJson(raw)
    if (parsed === undefined) return undefined
    const result: Partial<Record<QualityDomain, ModelScoreEntry>> = {}
    const novelty = asScoreEntry(parsed['novelty'])
    if (novelty !== undefined) result.novelty = novelty
    const strength = asScoreEntry(parsed['technical_strength'])
    if (strength !== undefined) result.technical_strength = strength
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    // Unconfigured LLM route (fail-loud stub) or a failed call: fall back to the
    // deterministic dimensions only — the report stays usable without a model.
    return undefined
  }
}

/** Render the canonical report into model-facing Markdown prose. */
function renderReport(report: PatentAnalysisReport): string {
  const lines: string[] = []
  if (report.title !== undefined) lines.push(`# 专利分析报告：${report.title}`)
  else lines.push('# 专利分析报告')
  if (report.patentId !== undefined) lines.push(`专利号：${report.patentId}`)
  const top = report.ipc[0]
  if (top !== undefined) {
    lines.push(
      `IPC：${top.section} ${top.domainName}（置信度 ${top.confidence.toFixed(2)}）` +
        (top.detail !== undefined ? `，大类 ${top.detail}` : ''),
    )
    if (top.noveltyImplications !== undefined && top.noveltyImplications.length > 0) {
      lines.push(`领域创造性要点：${top.noveltyImplications.join('；')}`)
    }
  }
  lines.push('', '## 技术特征')
  for (const feature of report.technicalFeatures) {
    lines.push(`- 权${feature.claimNo} [${feature.type}/${feature.importance}] ${feature.text}`)
  }
  lines.push('', '## 质量评分')
  for (const s of report.scores) {
    lines.push(`- ${s.domain}：${s.score}/100（${s.basis === 'model' ? 'LLM' : '规则'}）— ${s.rationale}`)
  }
  lines.push('', '## 创新性洞察')
  for (const insight of report.innovationInsights) lines.push(`- ${insight}`)
  if (report.expertConsiderations.length > 0) {
    lines.push('', '## 专家考量')
    for (const c of report.expertConsiderations) lines.push(`- ${c}`)
  }
  if (report.searchStrategy !== undefined) {
    const s = report.searchStrategy
    lines.push('', '## 检索策略')
    lines.push(`- 检索式：${s.query}`)
    if (s.ipc !== undefined && s.ipc.length > 0) lines.push(`- IPC：${s.ipc.join('、')}`)
    if (s.keywords !== undefined && s.keywords.length > 0) lines.push(`- 关键词：${s.keywords.slice(0, 8).join('、')}`)
  }
  if (report.checkerVerdict !== undefined) lines.push('', `检查判定：${report.checkerVerdict}`)
  return lines.join('\n')
}

/** Derive a suggested standardized search strategy from the IPC classification. */
function buildSuggestedSearchStrategy(combined: string, ipc: readonly IpcClassification[]): SearchStrategy | undefined {
  const top = ipc[0]
  if (top === undefined) return undefined
  const codes: string[] = []
  /* v8 ignore next -- every IPC section produced by classifyIpc is non-empty */
  if (top.section !== '') codes.push(top.section)
  if (top.detail !== undefined) codes.push(top.detail)
  return {
    query: combined.trim().slice(0, 200),
    ipc: codes,
    ...(top.matchedKeywords.length > 0 ? { keywords: [...top.matchedKeywords] } : {}),
  }
}

/**
 * Build the `patent_analysis_report` tool.
 * @param deps - optional ModelPort for the novelty / technical_strength fill.
 * @returns a registry-ready tool definition.
 */
export function createPatentAnalysisReportTool(deps: PatentAnalysisReportDeps = {}): ToolDefinition {
  return defineTool({
    name: 'patent_analysis_report',
    description: DESCRIPTION,
    parameters: {
      patent_id: { type: 'string', description: '专利号（可选）' },
      title: { type: 'string', description: '发明名称' },
      abstract: { type: 'string', description: '摘要' },
      claims: { type: 'array', items: { type: 'string' }, required: true, description: '权利要求（权 1 起）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patentId: { type: 'string' },
          title: { type: 'string' },
          checkerVerdict: { type: 'string' },
          ipc: { type: 'json', required: true },
          technicalFeatures: { type: 'json', required: true },
          featureStatistics: { type: 'json', required: true },
          scores: { type: 'json', required: true },
          innovationInsights: { type: 'json', required: true },
          expertConsiderations: { type: 'json', required: true },
          searchStrategy: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value as unknown as PatentAnalysisReport) }],
    },
    async execute(args, exec) {
      const input: PatentAnalysisReportInput = {
        claims: args.claims,
        ...(args.patent_id !== undefined ? { patent_id: args.patent_id } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.abstract !== undefined ? { abstract: args.abstract } : {}),
      }
      const combined = [input.title, input.abstract, ...input.claims].filter(s => s !== undefined && s !== '').join(' ')
      const ipc = combined.trim().length > 0 ? classifyIpc(combined) : []
      const strategy = buildSuggestedSearchStrategy(combined, ipc)
      const model = loggedToolModel(exec, deps.model, { callSite: 'patent_analysis_report' })
      const modelScores = model !== undefined ? await scoreWithModel(model, input, exec.signal) : undefined
      const report = buildAnalysisReport({
        claims: input.claims,
        ...(input.patent_id !== undefined ? { patentId: input.patent_id } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.abstract !== undefined ? { abstract: input.abstract } : {}),
        ipc,
        ...(modelScores !== undefined ? { modelScores } : {}),
        ...(strategy !== undefined ? { searchStrategy: strategy } : {}),
      })
      return {
        ipc: toJsonValue(report.ipc),
        technicalFeatures: toJsonValue(report.technicalFeatures),
        featureStatistics: toJsonValue(report.featureStatistics),
        scores: toJsonValue(report.scores),
        innovationInsights: toJsonValue(report.innovationInsights),
        expertConsiderations: toJsonValue(report.expertConsiderations),
        ...(report.patentId !== undefined ? { patentId: report.patentId } : {}),
        ...(report.title !== undefined ? { title: report.title } : {}),
        /* v8 ignore next -- this tool never supplies checker failures, so the report has no verdict */
        ...(report.checkerVerdict !== undefined ? { checkerVerdict: report.checkerVerdict } : {}),
        ...(report.searchStrategy !== undefined ? { searchStrategy: toJsonValue(report.searchStrategy) } : {}),
      }
    },
  })
}
