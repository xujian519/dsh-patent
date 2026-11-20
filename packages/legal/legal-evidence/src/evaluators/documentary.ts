/**
 * 书证判定器（《民事诉讼法》第 66 条第 2 项）。
 *
 * 书证评估要点：
 * - 关联性：待证事实明确性、书证内容与待证事实的关联度
 * - 合法性：收集主体合法、收集程序合法、形式合法（签章等）
 * - 真实性：原件核对、签章真实性、形成时间明确性
 */

import type { LegalEvidenceFinding, LegalEvidenceInput } from '../types.ts'
import { createEvaluator, dimensionJudgment, hasText, TRIPLE_ATTRIBUTE_BASE, type LegalEvidenceEvaluator } from './base.ts'

/** 书证判定器实现。 */
export const documentaryEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    // 原件核对
    if (input.hasOriginal === true) {
      score += 0.2
      reasons.push('已提供原件')
    } else if (input.hasOriginal === false) {
      if (hasText(input.originalAbsenceReason)) {
        score += 0.05
        reasons.push('未提供原件但有合理说明')
      } else {
        score -= 0.15
        reasons.push('未提供原件且未说明原因')
      }
    }

    // 签章核验
    if (input.signatureVerified === true) {
      score += 0.2
      reasons.push('签章已核验')
    } else if (input.signatureVerified === false) {
      score -= 0.2
      reasons.push('签章真实性未核验')
    }

    // 形成时间
    if (input.formationTimeClear === true) {
      score += 0.1
      reasons.push('形成时间明确')
    } else if (input.formationTimeClear === false) {
      score -= 0.1
      reasons.push('形成时间不明确')
    }

    return dimensionJudgment('authenticity', score, reasons, '书证真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []

    // LEGAL-EVI-001: 书证应提供原件
    if (input.hasOriginal !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-001',
        passed: false,
        reason: hasText(input.originalAbsenceReason)
          ? `未提供原件，但已说明原因：${input.originalAbsenceReason}`
          : '书证应提供原件，未提供且未说明原因',
        severity: 'critical',
      })
    } else {
      findings.push({
        ruleId: 'LEGAL-EVI-001',
        passed: true,
        reason: '已提供原件',
        severity: 'info',
      })
    }

    // LEGAL-EVI-002: 书证签章应核验
    if (input.signatureVerified !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-002',
        passed: false,
        reason: '书证签章真实性未核验',
        severity: 'warning',
      })
    }

    // LEGAL-EVI-003: 书证形成时间应明确
    if (input.formationTimeClear !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-003',
        passed: false,
        reason: '书证形成时间不明确，可能影响证据效力',
        severity: 'warning',
      })
    }

    return findings
  },
})
