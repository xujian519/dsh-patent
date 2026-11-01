/**
 * 证据判定器接口与基线评分辅助。
 *
 * 每类法定证据实现 `LegalEvidenceEvaluator` 接口，返回各维度的评分与理由。
 * 引擎按证据类型分派到对应的判定器。
 */

import type { LegalEvidenceDimensionJudgment, LegalEvidenceFinding, LegalEvidenceInput } from '../types.ts'

/** 证据判定器接口。 */
export interface LegalEvidenceEvaluator {
  /** 评估关联性。 */
  evaluateRelevance(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment
  /** 评估合法性。 */
  evaluateLegality(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment
  /** 评估真实性。 */
  evaluateAuthenticity(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment
  /** 类型特定检查（返回发现列表）。 */
  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[]
}

/** 单个维度的评估函数。 */
type LegalEvidenceAssessor = (input: LegalEvidenceInput) => LegalEvidenceDimensionJudgment

/**
 * 组装一个证据判定器。
 *
 * 关联性对所有法定证据类型采用同一套评分；合法性缺省也走通用评分，
 * 只有类型特有的合法性要点才单独提供。
 * @param parts - 真实性评估、可选合法性评估与类型特有检查。
 * @returns 完整的三性判定器。
 */
export function createEvaluator(parts: {
  assessAuthenticity: LegalEvidenceAssessor
  assessLegality?: LegalEvidenceAssessor
  checkFindings: (input: LegalEvidenceInput) => LegalEvidenceFinding[]
}): LegalEvidenceEvaluator {
  return {
    evaluateRelevance: evaluateGenericRelevance,
    evaluateLegality: parts.assessLegality ?? evaluateGenericLegality,
    evaluateAuthenticity: parts.assessAuthenticity,
    checkFindings: parts.checkFindings,
  }
}

/** 三性评分基线：证据记录本身的完备度起点。 */
export const TRIPLE_ATTRIBUTE_BASE = 0.5

/**
 * 字段是否填写了非空白内容。
 * @param value - 待检查的字段值。
 * @returns 是否包含非空白内容。
 */
export function hasText(value: string | undefined | null): boolean {
  return value !== undefined && value !== null && value.trim() !== ''
}

/**
 * 评分等级映射。
 * @param score - 0–1 的评分。
 * @returns 评分等级。
 */
export function levelFor(score: number): string {
  if (score >= 0.85) return 'high'
  if (score >= 0.65) return 'medium_high'
  if (score >= 0.45) return 'medium'
  return 'low'
}

/**
 * 通用关联性评估：基于待证事实的明确性与证据内容的相关度。
 * @param input - 证据输入。
 * @returns 关联性判定。
 */
export function evaluateGenericRelevance(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE
  const reasons: string[] = []
  if (hasText(input.factToProve)) {
    score += 0.15
    reasons.push('已明确待证事实')
  }
  if (hasText(input.content)) {
    score += 0.15
    reasons.push('已提供证据内容')
  }
  if (hasText(input.source)) {
    score += 0.1
    reasons.push('已记录证据来源')
  }
  score = Math.min(score, 1.0)
  return {
    dimension: 'relevance',
    score,
    level: levelFor(score),
    reasoning: reasons.length > 0 ? `关联性评估：${reasons.join('；')}` : '关联性评估：基础评分',
  }
}

/**
 * 通用合法性评估：基于收集合法性与形式合法性。
 * @param input - 证据输入。
 * @returns 合法性判定。
 */
export function evaluateGenericLegality(input: LegalEvidenceInput): LegalEvidenceDimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE
  const reasons: string[] = []
  if (input.collectionLegal === true) {
    score += 0.25
    reasons.push('证据收集合法')
  } else if (input.collectionLegal === false) {
    score -= 0.2
    reasons.push('证据收集合法性存疑')
  }
  if (input.formLegal === true) {
    score += 0.2
    reasons.push('证据形式合法')
  } else if (input.formLegal === false) {
    score -= 0.15
    reasons.push('证据形式合法性存疑')
  }
  if (hasText(input.source)) {
    score += 0.05
    reasons.push('已记录证据来源')
  }
  score = Math.max(0, Math.min(score, 1.0))
  return {
    dimension: 'legality',
    score,
    level: levelFor(score),
    reasoning: reasons.length > 0 ? `合法性评估：${reasons.join('；')}` : '合法性评估：基础评分',
  }
}
