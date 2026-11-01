/**
 * src/adversary/review — 换位重跑：从对立审查员视角评估最终意见陈述书。
 *
 * 与 adversary-model（评估答复计划）不同，adversary-review 评估最终产物：
 * - 输入：final_draft + reference_documents + claims + office_action
 * - 目的：评估最终意见陈述书的论证强度、遗漏驳回理由、证据完整性
 * - 信息隔离：不可访问 dispute_framing_report、claim_chart、response_plan、draft 中间版本
 *
 * 当前为确定性骨架（不调用模型），TODO 完整版需模型注入。
 */

import type { AdversaryDispute } from './types.ts'
import { GROUND_TO_STATUTE } from './types.ts'

/**
 * 换位审查报告：评估最终意见陈述书的论证强度。
 *
 * 与 AdversaryReport 不同，AdversaryReviewReport 关注最终产物质量：
 * - argumentStrength：论证强度（strong/weak/insufficient）
 * - missedRejections：遗漏的驳回理由列表
 * - evidenceGaps：证据缺口列表
 */
export type AdversaryReviewReport = {
  /** 识别的争议点。 */
  disputes: AdversaryDispute[]
  /** 论证强度：strong（充分）、weak（部分不足）、insufficient（严重不足）。 */
  argumentStrength: 'strong' | 'weak' | 'insufficient'
  /** 遗漏的驳回理由（通知书中有但最终产物未回应）。 */
  missedRejections: string[]
  /** 证据缺口（论证缺少支撑证据）。 */
  evidenceGaps: string[]
  /** 整体置信度 [0,1]。 */
  overallConfidence: number
  /** 可读摘要（中文）。 */
  summary: string
}

/**
 * 换位审查输入：最终产物评估所需的最小契约。
 *
 * 与 adversary-model 的输入不同：
 * - final_draft：最终意见陈述书（非 response_plan）
 * - reference_documents：对比文件原文或引用信息
 * - claims：权利要求书
 * - office_action：通知书
 */
export type AdversaryReviewInput = {
  finalDraft?: string
  referenceDocuments?: string
  claims?: string
  officeAction?: AdversaryReviewOfficeAction
}

/**
 * 通知书结构化字段（换位审查最小契约）。
 *
 * 与 AdversaryOfficeAction 一致：rejectionTypes + affectedClaims。
 */
export type AdversaryReviewOfficeAction = {
  rejectionTypes?: string[]
  affectedClaims?: number[]
  examinerArguments?: string | readonly string[]
}

/**
 * 从对立审查员视角评估最终意见陈述书的论证强度。
 *
 * 确定性骨架：检查 final_draft 是否覆盖通知书中的所有驳回理由。
 * TODO：完整版需模型注入，做深度论证评估。
 *
 * @param input - 换位审查输入（final_draft、reference_documents、claims、office_action）。
 * @returns 换位审查报告。
 */
export function reviewFinalDraft(input: AdversaryReviewInput): AdversaryReviewReport {
  const { finalDraft, referenceDocuments, claims, officeAction } = input

  // 步骤 1：识别遗漏的驳回理由
  const missedRejections = detectMissedRejections(finalDraft ?? '', officeAction)

  // 步骤 2：识别证据缺口
  const evidenceGaps = detectEvidenceGaps(finalDraft ?? '', referenceDocuments ?? '', officeAction)

  // 步骤 2b：检查权利要求覆盖度（claims 消费点）
  if (claims !== undefined && claims.trim().length > 0 && finalDraft !== undefined) {
    const claimsCoverage = detectClaimsCoverage(finalDraft, claims)
    evidenceGaps.push(...claimsCoverage)
  }

  // 步骤 3：识别争议点（从最终产物角度）
  const disputes = identifyReviewDisputes(officeAction, missedRejections, evidenceGaps)

  // 步骤 4：评估论证强度
  const argumentStrength = assessArgumentStrength(missedRejections, evidenceGaps, disputes)

  // 步骤 5：计算整体置信度
  const overallConfidence = computeReviewConfidence(disputes, argumentStrength)

  // 步骤 6：生成摘要
  const summary = buildReviewSummary(missedRejections, evidenceGaps, argumentStrength, overallConfidence)

  return {
    disputes,
    argumentStrength,
    missedRejections,
    evidenceGaps,
    overallConfidence,
    summary,
  }
}

/**
 * 检测遗漏的驳回理由：通知书中有但最终产物未回应的驳回类型。
 *
 * 确定性检查：扫描 final_draft 文本是否包含各驳回类型对应的关键词。
 * TODO：完整版需模型做语义匹配，而非关键词扫描。
 *
 * @param finalDraft - 最终意见陈述书文本。
 * @param officeAction - 通知书结构化字段。
 * @returns 遗漏的驳回理由列表。
 */
export function detectMissedRejections(
  finalDraft: string,
  officeAction?: AdversaryReviewOfficeAction,
): string[] {
  if (officeAction?.rejectionTypes === undefined || officeAction.rejectionTypes.length === 0) {
    return []
  }

  const missedRejections: string[] = []

  for (const ground of officeAction.rejectionTypes) {
    // 检查 final_draft 是否回应了该驳回理由
    // 简化版：检查是否包含相关关键词
    const keywords = getRejectionKeywords(ground)
    const hasResponse = keywords.some(kw => finalDraft.includes(kw))
    if (!hasResponse) {
      missedRejections.push(ground)
    }
  }

  return missedRejections
}

/**
 * 检测证据缺口：论证缺少支撑证据。
 *
 * 确定性骨架：检查 final_draft 是否引用了 reference_documents 中的内容。
 * TODO：完整版需模型做深度证据评估。
 *
 * @param finalDraft - 最终意见陈述书文本。
 * @param referenceDocuments - 对比文件原文或引用信息。
 * @param officeAction - 通知书结构化字段。
 * @returns 证据缺口列表。
 */
export function detectEvidenceGaps(
  finalDraft: string,
  referenceDocuments: string,
  officeAction?: AdversaryReviewOfficeAction,
): string[] {
  const gaps: string[] = []

  // 检查 1：有对比文件但最终产物未引用
  if (referenceDocuments.trim().length > 0 && finalDraft.trim().length > 0) {
    // 简化版：检查 final_draft 是否包含对比文件中的关键词
    const refKeywords = extractReferenceKeywords(referenceDocuments)
    const citedCount = refKeywords.filter(kw => finalDraft.includes(kw)).length
    if (citedCount === 0 && refKeywords.length > 0) {
      gaps.push('最终产物未引用对比文件内容')
    }
  }

  // 检查 2：通知书提到创造性问题但最终产物未充分论证
  if (officeAction?.rejectionTypes?.includes('inventiveness')) {
    const hasInventivenessArgument = finalDraft.includes('创造性') || finalDraft.includes('A22.3')
    if (!hasInventivenessArgument) {
      gaps.push('通知书指出创造性问题但最终产物未论证')
    }
  }

  return gaps
}

/**
 * 检测最终产物对权利要求的覆盖度。
 *
 * 确定性骨架：检查 finalDraft 是否引用了 claims 中的关键编号（权项号）。
 * 如果权利要求书包含编号权项（“权利要求 1”“权 1”等）但最终产物未提及任何
 * 编号，则报告覆盖缺口。
 * TODO：完整版需模型做语义比对，判断最终产物是否实质回应了每项权利要求。
 *
 * @param finalDraft - 最终意见陈述书文本。
 * @param claims - 权利要求书文本。
 * @returns 覆盖缺口列表。
 */
export function detectClaimsCoverage(finalDraft: string, claims: string): string[] {
  const gaps: string[] = []
  // 提取权利要求中的编号权项标记（“权利要求 1”“权 1”等）
  const claimMarkers = claims.match(/(?:权利要求|权)\s*\d+/g) ?? []
  if (claimMarkers.length === 0) return gaps
  const uniqueMarkers = [...new Set(claimMarkers)]
  const citedMarkers = uniqueMarkers.filter(m => finalDraft.includes(m))
  if (citedMarkers.length === 0 && uniqueMarkers.length > 0) {
    gaps.push(`最终产物未引用任何权利要求编号（共 ${uniqueMarkers.length} 项权项标记未覆盖）`)
  }
  return gaps
}

/**
 * 关键词未命中驳回理由的启发式置信度。
 *
 * 低于 0.9：确定性骨架只做字面扫描，不能当高置信度实体判断。
 */
export const MISSED_REJECTION_HEURISTIC_CONFIDENCE = 0.6

/** 对比文件引用缺口的启发式置信度。 */
export const CITATION_GAP_HEURISTIC_CONFIDENCE = 0.75

/** 创造性论证缺口的启发式置信度。 */
export const INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE = 0.7

/** 权利要求覆盖缺口的启发式置信度。 */
export const CLAIMS_COVERAGE_GAP_HEURISTIC_CONFIDENCE = 0.65

/**
 * 按证据缺口文案与通知书驳回类型归因法条；无可靠来源时返回 `unknown`，不默认 A22.3。
 *
 * @param gap - 证据缺口文案。
 * @param officeAction - 通知书结构化字段。
 * @returns 规范化法条编号或 `unknown`。
 */
export function statuteForEvidenceGap(
  gap: string,
  officeAction: AdversaryReviewOfficeAction | undefined,
): string {
  if (gap.includes('创造性')) return 'A22.3'
  if (gap.includes('权利要求')) return 'A26.4'
  if (gap.includes('对比文件')) {
    for (const ground of officeAction?.rejectionTypes ?? []) {
      const statute = GROUND_TO_STATUTE.get(ground)
      if (statute !== undefined) return statute
    }
    return 'unknown'
  }
  return 'unknown'
}

/**
 * 按证据缺口类型给出启发式置信度分档。
 * @param gap - 证据缺口文案。
 * @returns 置信度 [0,1]。
 */
export function confidenceForEvidenceGap(gap: string): number {
  if (gap.includes('对比文件')) return CITATION_GAP_HEURISTIC_CONFIDENCE
  if (gap.includes('创造性')) return INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE
  if (gap.includes('权利要求')) return CLAIMS_COVERAGE_GAP_HEURISTIC_CONFIDENCE
  return INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE
}

/**
 * 识别争议点：从最终产物角度识别需要关注的争议。
 *
 * @param officeAction - 通知书结构化字段。
 * @param missedRejections - 遗漏的驳回理由。
 * @param evidenceGaps - 证据缺口。
 * @returns 争议点列表。
 */
export function identifyReviewDisputes(
  officeAction: AdversaryReviewOfficeAction | undefined,
  missedRejections: string[],
  evidenceGaps: string[],
): AdversaryDispute[] {
  const disputes: AdversaryDispute[] = []

  // 从遗漏的驳回理由生成争议点
  for (const ground of missedRejections) {
    const statute = GROUND_TO_STATUTE.get(ground) ?? 'unknown'
    disputes.push({
      statute,
      claims: officeAction?.affectedClaims ?? [],
      point: `遗漏驳回理由：${ground}`,
      relation: 'missed_by_baseline',
      confidence: MISSED_REJECTION_HEURISTIC_CONFIDENCE,
      tag: 'heuristic',
    })
  }

  // 从证据缺口生成争议点：法条随缺口来源归因，不一律写 A22.3。
  for (const gap of evidenceGaps) {
    disputes.push({
      statute: statuteForEvidenceGap(gap, officeAction),
      claims: officeAction?.affectedClaims ?? [],
      point: `证据缺口：${gap}`,
      relation: 'disagreement',
      confidence: confidenceForEvidenceGap(gap),
      tag: 'heuristic',
    })
  }

  return disputes
}

/**
 * 评估论证强度。
 *
 * @param missedRejections - 遗漏的驳回理由。
 * @param evidenceGaps - 证据缺口。
 * @param disputes - 争议点。
 * @returns 论证强度评级。
 */
export function assessArgumentStrength(
  missedRejections: string[],
  evidenceGaps: string[],
  disputes: AdversaryDispute[],
): 'strong' | 'weak' | 'insufficient' {
  // 有遗漏的驳回理由 → insufficient
  if (missedRejections.length > 0) {
    return 'insufficient'
  }

  // 有多个证据缺口 → weak
  if (evidenceGaps.length >= 2) {
    return 'weak'
  }

  // 有高置信度争议点 → weak
  const highConfidenceDisputes = disputes.filter(d => d.confidence >= 0.8)
  if (highConfidenceDisputes.length > 0) {
    return 'weak'
  }

  // 否则 → strong
  return 'strong'
}

/**
 * 计算换位审查的整体置信度。
 *
 * 公式：
 *   1. 无争议点时：strong → 0.8，否则 → 0.5（基线置信）。
 *   2. 有争议点时：按置信度加权平均（权重 = 各争议点自身置信度），
 *      即 weightedAvg = Σ(confidence²) / Σ(confidence)，
 *      高置信度争议点对结果影响更大。
 *   3. 论证强度调整：strong × 1.0 / weak × 0.7 / insufficient × 0.4，
 *      结果裁剪到 [0, 1]。
 *
 * @param disputes - 争议点列表。
 * @param argumentStrength - 论证强度。
 * @returns 整体置信度 [0,1]。
 */
export function computeReviewConfidence(
  disputes: AdversaryDispute[],
  argumentStrength: 'strong' | 'weak' | 'insufficient',
): number {
  if (disputes.length === 0) {
    return argumentStrength === 'strong' ? 0.8 : 0.5
  }

  // 基于争议点的加权平均
  const totalWeight = disputes.reduce((sum, d) => sum + d.confidence, 0)
  if (totalWeight === 0) return 0

  const weightedAvg = disputes.reduce((sum, d) => sum + d.confidence * d.confidence, 0) / totalWeight

  // 论证强度调整
  const strengthFactor = argumentStrength === 'strong' ? 1.0 : argumentStrength === 'weak' ? 0.7 : 0.4

  return Math.min(1, Math.max(0, weightedAvg * strengthFactor))
}

/**
 * 生成换位审查摘要。
 *
 * @param missedRejections - 遗漏的驳回理由。
 * @param evidenceGaps - 证据缺口。
 * @param argumentStrength - 论证强度。
 * @param overallConfidence - 整体置信度。
 * @returns 可读摘要（中文）。
 */
export function buildReviewSummary(
  missedRejections: string[],
  evidenceGaps: string[],
  argumentStrength: 'strong' | 'weak' | 'insufficient',
  overallConfidence: number,
): string {
  const parts: string[] = []

  parts.push(`论证强度：${argumentStrength === 'strong' ? '充分' : argumentStrength === 'weak' ? '部分不足' : '严重不足'}`)

  if (missedRejections.length > 0) {
    parts.push(`遗漏 ${missedRejections.length} 项驳回理由：${missedRejections.join('、')}`)
  }

  if (evidenceGaps.length > 0) {
    parts.push(`存在 ${evidenceGaps.length} 处证据缺口`)
  }

  parts.push(`整体置信度：${(overallConfidence * 100).toFixed(1)}%`)

  return parts.join('；')
}

/**
 * 获取驳回类型对应的关键词（用于简化版检测）。
 * TODO：完整版需模型做语义匹配。
 */
function getRejectionKeywords(ground: string): string[] {
  const keywordMap: Record<string, string[]> = {
    novelty: ['新颖性', 'A22.2', '第二十二条第二款'],
    inventiveness: ['创造性', 'A22.3', '第二十二条第三款', '三步法'],
    utility: ['实用性', 'A22.4', '第二十二条第四款'],
    disclosure: ['说明不充分', '充分公开', 'A26.3', '第二十六条第三款'],
    clarity: ['不清楚', '权利要求不清楚', 'A26.4', '第二十六条第四款'],
    support: ['得不到说明书支持', '说明书支持', 'A26.4', '第二十六条第四款'],
    'claim-clarity': ['权利要求不清楚', '不清楚', 'A26.4', '第二十六条第四款'],
    'necessary-features': ['必要技术特征', 'A26.4', '第二十六条第四款'],
    amendment: ['修改超范围', 'A33', '第三十三条'],
    scope: ['修改超范围', 'A33', '第三十三条'],
  }
  return keywordMap[ground] ?? [ground]
}

/**
 * 从对比文件文本提取关键词（简化版）。
 * TODO：完整版需模型做深度抽取。
 */
function extractReferenceKeywords(referenceDocuments: string): string[] {
  // 简化版：提取数字、专利号等
  const patterns = [
    /CN\d+[A-Z]/g, // 中国专利号
    /\b\d{4,}\b/g, // 4位以上数字
  ]
  const keywords: string[] = []
  for (const pattern of patterns) {
    const matches = referenceDocuments.match(pattern)
    if (matches !== null) {
      keywords.push(...matches.slice(0, 5)) // 限制数量
    }
  }
  return [...new Set(keywords)]
}
