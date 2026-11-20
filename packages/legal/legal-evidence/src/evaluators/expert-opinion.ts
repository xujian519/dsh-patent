/**
 * 鉴定意见判定器（《民事诉讼法》第 66 条第 7 项）。
 *
 * 鉴定意见评估要点：
 * - 关联性：待证事实明确性、鉴定事项与待证事实的关联度
 * - 合法性：鉴定机构/鉴定人资质合法、鉴定程序合法
 * - 真实性：鉴定方法科学、鉴定结论明确、鉴定材料真实完整
 */

import type { LegalEvidenceFinding, LegalEvidenceInput } from '../types.ts'
import { createEvaluator, dimensionJudgment, hasText, TRIPLE_ATTRIBUTE_BASE, type LegalEvidenceEvaluator } from './base.ts'

/** 鉴定意见判定器实现。 */
export const expertOpinionEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessLegality(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    // 鉴定资质
    if (input.expertQualified === true) {
      score += 0.3
      reasons.push('鉴定机构/鉴定人资质已核验')
    } else if (input.expertQualified === false) {
      score -= 0.3
      reasons.push('鉴定机构/鉴定人资质未核验')
    }

    // 鉴定程序
    if (input.expertProcedureLegal === true) {
      score += 0.2
      reasons.push('鉴定程序合法')
    } else if (input.expertProcedureLegal === false) {
      score -= 0.25
      reasons.push('鉴定程序合法性存疑')
    }

    return dimensionJudgment('legality', score, reasons, '鉴定意见合法性')
  },

  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    // 鉴定结论明确性
    if (input.expertConclusionClear === true) {
      score += 0.25
      reasons.push('鉴定结论明确')
    } else if (input.expertConclusionClear === false) {
      score -= 0.2
      reasons.push('鉴定结论不明确')
    }

    // 鉴定材料
    if (hasText(input.content)) {
      score += 0.1
      reasons.push('已记录鉴定材料')
    }

    // 资质核验
    if (input.expertQualified === true) {
      score += 0.15
      reasons.push('鉴定资质已核验')
    }

    return dimensionJudgment('authenticity', score, reasons, '鉴定意见真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []

    // LEGAL-EVI-009: 鉴定机构/鉴定人应具备相应资质
    if (input.expertQualified !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-009',
        passed: false,
        reason: '鉴定机构/鉴定人资质未核验',
        severity: 'critical',
      })
    } else {
      findings.push({
        ruleId: 'LEGAL-EVI-009',
        passed: true,
        reason: '鉴定机构/鉴定人资质已核验',
        severity: 'info',
      })
    }

    // LEGAL-EVI-010: 鉴定程序应合法
    if (input.expertProcedureLegal !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-010',
        passed: false,
        reason: '鉴定程序合法性未确认',
        severity: 'critical',
      })
    }

    // LEGAL-EVI-011: 鉴定结论应明确
    if (input.expertConclusionClear !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-011',
        passed: false,
        reason: '鉴定结论不明确',
        severity: 'warning',
      })
    }

    return findings
  },
})
