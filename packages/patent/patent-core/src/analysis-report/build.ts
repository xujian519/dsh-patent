/**
 * src/patent/analysis-report/build — 专利分析产物的确定性聚合器。
 *
 * 输入各引擎结果（checker 裁决 / IPC 分类 / graph 结论 / evidence 收据 / KG 统计）
 * 与可选的 LLM 补分（novelty/technical_strength），输出统一的 PatentAnalysisReport。
 * 纯函数：clarity/completeness 由规则确定性推导，novelty/technical_strength 由调用方
 * 经 ModelPort 打分后经 modelScores 注入；无 modelScores 时仅含确定性维度。
 */

import type { RuleCheckResult } from '../checker/types.ts'
import { aggregate } from '../checker/engine.ts'
import type { IpcClassification } from '../ipc/types.ts'
import { getIpcDomain } from '../ipc/ipc-classifier.ts'
import { NUMERIC_ANY_UNIT_ALTERNATION } from '../novelty/numeric-vocabulary.ts'
import { computeFeatureStatistics, extractTechnicalFeatures } from './feature-extract.ts'
import type {
  GraphConclusionSummary,
  IpcSummary,
  KgAnalysisSummary,
  PatentAnalysisReport,
  QualityDomain,
  QualityScore,
  SearchStrategy,
} from './types.ts'

/** LLM 补分条目。 */
export interface ModelScoreEntry {
  score: number
  rationale: string
}

/** 聚合器输入。 */
export interface AnalysisReportInputs {
  patentId?: string
  title?: string
  claims: readonly string[]
  abstract?: string
  /** checker 失败明细（未运行 checker 时省略）。 */
  checkerFailures?: readonly RuleCheckResult[]
  /** IPC 分类结果。 */
  ipc?: readonly IpcClassification[]
  graphConclusions?: GraphConclusionSummary
  evidenceReceiptCount?: number
  kgAnalysis?: KgAnalysisSummary
  /** 经 ModelPort 的 LLM 补分（novelty/technical_strength 等；clarity/completeness 亦可覆盖）。 */
  modelScores?: Partial<Record<QualityDomain, ModelScoreEntry>>
  /** 本次检索策略记录（标准契约）。 */
  searchStrategy?: SearchStrategy
}

/** 确定性维度评分的基础分（0..100）与扣分粒度。 */
const BASE_SCORE = 100
const FUZZY_TERM_PENALTY = 5
/** 模糊限定词表（降低权利要求清晰度）。 */
const FUZZY_TERMS = ['约', '大约', '左右', '大概', '若干', '优选地'] as const
const SIGNED_NUMBER = '[+\\-−－]?\\d+(?:\\.\\d+)?'
/** 「约」「左右」只在数值限定语境中计为模糊词，避免误伤「约束」「左右对称」等术语。 */
const FUZZY_TERM_PATTERNS: Readonly<Record<(typeof FUZZY_TERMS)[number], RegExp>> = {
  约: new RegExp(`(?:约\\s*(?:为|是)?\\s*(?=${SIGNED_NUMBER})|${SIGNED_NUMBER}\\s*约)`),
  大约: /大约/,
  左右: new RegExp(`${SIGNED_NUMBER}\\s*(?:${NUMERIC_ANY_UNIT_ALTERNATION})?\\s*左右`),
  大概: /大概/,
  若干: /若干/,
  优选地: /优选地/,
}
const SINGLE_CLAIM_PENALTY = 20
const MISSING_ABSTRACT_PENALTY = 15
const NARROW_INDEPENDENT_PENALTY = 10
const INDEPENDENT_MIN_LENGTH = 30
const HIGH_CONFIDENCE_SCORE = 70
const NEW_KNOWLEDGE_PENALTY = 70

/** 单一质量维度评分的稳定顺序。 */
const SCORE_ORDER: readonly QualityDomain[] = ['novelty', 'clarity', 'completeness', 'technical_strength']

/** 权利要求清晰度评分：模糊限定词越少越高。
 * @param claims - 全部权利要求文本。
 * @returns 清晰度维度的确定性评分。
 */
export function computeClarityScore(claims: readonly string[]): QualityScore {
  if (claims.length === 0) {
    return { domain: 'clarity', score: 0, basis: 'deterministic', rationale: '缺少权利要求文本' }
  }
  const fuzzyFound = new Set<string>()
  for (const claim of claims) {
    for (const term of FUZZY_TERMS) {
      if (FUZZY_TERM_PATTERNS[term].test(claim)) fuzzyFound.add(term)
    }
  }
  const score = Math.max(0, BASE_SCORE - fuzzyFound.size * FUZZY_TERM_PENALTY)
  const rationale = fuzzyFound.size === 0 ? '未检出模糊限定词' : `检出模糊限定词：${[...fuzzyFound].join('、')}`
  return { domain: 'clarity', score, basis: 'deterministic', rationale }
}

/** 完整性评分：权利要求与摘要要素覆盖。
 * @param claims - 全部权利要求文本。
 * @param abstract - 说明书摘要；缺省按缺失扣分。
 * @returns 完整性维度的确定性评分。
 */
export function computeCompletenessScore(claims: readonly string[], abstract?: string): QualityScore {
  if (claims.length === 0) {
    return { domain: 'completeness', score: 0, basis: 'deterministic', rationale: '缺少权利要求文本' }
  }
  let score = BASE_SCORE
  const notes: string[] = []

  if (claims.length === 1) {
    score -= SINGLE_CLAIM_PENALTY
    notes.push('仅 1 条权利要求')
  }
  if (!abstract || abstract.trim().length === 0) {
    score -= MISSING_ABSTRACT_PENALTY
    notes.push('缺摘要')
  }
  /* v8 ignore next -- claims.length was checked above. */
  const independent = claims[0] ?? ''
  if (independent.length < INDEPENDENT_MIN_LENGTH) {
    score -= NARROW_INDEPENDENT_PENALTY
    notes.push('独立权利要求特征不充分')
  }

  const rationale = notes.length === 0 ? '权利要求与摘要要素较完整' : notes.join('；')
  return { domain: 'completeness', score: Math.max(0, score), basis: 'deterministic', rationale }
}

/** 合并确定性评分与 LLM 补分（LLM 覆盖同维度），按稳定顺序输出。
 * @param deterministic - 确定性评分集合。
 * @param modelScores - 模型补分；同维度覆盖确定性结果。
 * @returns 按 `SCORE_ORDER` 排序的合并评分。
 */
export function mergeScores(
  deterministic: readonly QualityScore[],
  modelScores?: Partial<Record<QualityDomain, ModelScoreEntry>>,
): QualityScore[] {
  const byDomain = new Map<QualityDomain, QualityScore>()
  for (const s of deterministic) byDomain.set(s.domain, s)
  if (modelScores) {
    for (const domain of SCORE_ORDER) {
      const ms = modelScores[domain]
      if (ms) byDomain.set(domain, { domain, score: ms.score, basis: 'model', rationale: ms.rationale })
    }
  }
  const result: QualityScore[] = []
  for (const domain of SCORE_ORDER) {
    const score = byDomain.get(domain)
    if (score !== undefined) result.push(score)
  }
  return result
}

/** 把 IPC 分类映射为报告摘要（name 自 IPC_DOMAINS 解析）。
 * @param classification - IPC 分类结果。
 * @returns 报告使用的 IPC 摘要。
 */
export function toIpcSummary(classification: IpcClassification): IpcSummary {
  const domain = getIpcDomain(classification.section)
  const summary: IpcSummary = {
    section: classification.section,
    domainName: domain?.name ?? '未知',
    confidence: classification.confidence,
    matchedKeywords: classification.matchedKeywords,
  }
  if (classification.detail) summary.detail = classification.detail
  if (classification.noveltyImplications !== undefined) summary.noveltyImplications = classification.noveltyImplications
  return summary
}

/** 创新性洞察（确定性规则推导）。 */
function deriveInnovationInsights(input: {
  ipc: IpcSummary[]
  scores: QualityScore[]
  verdict: string | undefined
  hasFeatures: boolean
}): string[] {
  const insights: string[] = []
  const topIpc = input.ipc[0]
  if (topIpc && topIpc.confidence >= 0.8) {
    insights.push(`请求保护主题定位于${topIpc.domainName}领域（IPC ${topIpc.section}，置信度 ${topIpc.confidence.toFixed(2)}）`)
  }
  const novelty = input.scores.find(s => s.domain === 'novelty')
  if (novelty && novelty.score >= HIGH_CONFIDENCE_SCORE) {
    insights.push(`新颖性评估良好（${novelty.score} 分）`)
  } else if (novelty && novelty.score < NEW_KNOWLEDGE_PENALTY) {
    insights.push(`新颖性评估偏低（${novelty.score} 分），建议补充现有技术对比检索`)
  }
  if (input.hasFeatures) {
    insights.push('已识别到分散于权利要求的可区别技术特征，可据此构建对比基础')
  }
  if (input.verdict === 'blocked') {
    insights.push('存在必须修订的质量缺陷，建议先修订再评估创新性')
  }
  return insights
}

/** 专家考虑因素（确定性规则推导）。 */
function deriveExpertConsiderations(input: {
  checkerFailures: readonly { severity: string; message: string }[]
  graphConclusions: GraphConclusionSummary | undefined
  evidenceReceiptCount: number | undefined
  kgAnalysis: KgAnalysisSummary | undefined
  claimsCount: number
}): string[] {
  const considerations: string[] = []
  if (input.checkerFailures.some(f => f.severity === 'critical')) {
    considerations.push('存在 critical 级检查失败，需优先核验')
  }
  if (input.graphConclusions?.novelty || input.graphConclusions?.inventiveness) {
    considerations.push('新颖性/创造性判断需人工复核现有技术边界')
  }
  if ((input.evidenceReceiptCount ?? 0) === 0) {
    considerations.push('尚未记录证据收据，建议补充对比文件/实验证据闭环')
  }
  if (input.kgAnalysis && input.kgAnalysis.confidence < 0.8) {
    considerations.push(`知识图谱关联置信度较低（${input.kgAnalysis.confidence.toFixed(2)}），建议扩大检索`)
  }
  if (input.claimsCount === 1) {
    considerations.push('仅一条权利要求，保护范围需评估独立权利要求的概括是否过宽/过窄')
  }
  return considerations
}

/**
 * 聚合生成专利分析报告。
 * @param inputs - 各引擎结果与可选的 LLM 补分。
 * @returns 统一分析产物（确定性路径零模型依赖）。
 */
export function buildAnalysisReport(inputs: AnalysisReportInputs): PatentAnalysisReport {
  const claims = inputs.claims
  const features = extractTechnicalFeatures(claims)
  const statistics = computeFeatureStatistics(features)
  const ipc = (inputs.ipc ?? []).map(toIpcSummary)

  const deterministicScores = [computeClarityScore(claims), computeCompletenessScore(claims, inputs.abstract)]
  const scores = mergeScores(deterministicScores, inputs.modelScores)

  const checkerFailures: PatentAnalysisReport['checkerFailures'] = (inputs.checkerFailures ?? []).map(f => ({
    ruleId: f.ruleId,
    message: f.message,
    severity: f.severity,
  }))
  // 未运行 checker（输入省略）时保留 undefined；否则用 checker 的 aggregate 判级。
  const checkerVerdict = inputs.checkerFailures === undefined ? undefined : aggregate(inputs.checkerFailures)

  const report: PatentAnalysisReport = {
    ipc,
    technicalFeatures: features,
    featureStatistics: statistics,
    scores,
    checkerFailures,
    innovationInsights: deriveInnovationInsights({
      ipc,
      scores,
      verdict: checkerVerdict,
      hasFeatures: features.length > 0,
    }),
    expertConsiderations: deriveExpertConsiderations({
      checkerFailures,
      graphConclusions: inputs.graphConclusions,
      evidenceReceiptCount: inputs.evidenceReceiptCount,
      kgAnalysis: inputs.kgAnalysis,
      claimsCount: claims.length,
    }),
  }

  if (inputs.patentId !== undefined) report.patentId = inputs.patentId
  if (inputs.title !== undefined) report.title = inputs.title
  if (checkerVerdict !== undefined) report.checkerVerdict = checkerVerdict
  if (inputs.graphConclusions !== undefined) report.graphConclusions = inputs.graphConclusions
  if (inputs.evidenceReceiptCount !== undefined) report.evidenceReceiptCount = inputs.evidenceReceiptCount
  if (inputs.kgAnalysis !== undefined) report.kgAnalysis = inputs.kgAnalysis
  if (inputs.searchStrategy !== undefined) report.searchStrategy = inputs.searchStrategy
  return report
}
