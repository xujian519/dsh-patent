/**
 * 电子数据判定器（《民事诉讼法》第 66 条第 5 项）。
 *
 * 电子数据评估要点：
 * - 关联性：待证事实明确性、电子数据与待证事实的关联度
 * - 合法性：收集主体合法、收集程序合法（不得非法侵入系统）
 * - 真实性：哈希校验、时间戳、存储完整性、生成/收集/传输过程可靠性
 */

import type { LegalEvidenceFinding, LegalEvidenceInput } from '../types.ts'
import { createEvaluator, dimensionJudgment, hasText, TRIPLE_ATTRIBUTE_BASE, type LegalEvidenceEvaluator } from './base.ts'

/** 电子数据判定器实现。 */
export const electronicEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessLegality(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    if (input.collectionLegal === true) {
      score += 0.25
      reasons.push('电子数据收集程序合法')
    } else if (input.collectionLegal === false) {
      score -= 0.3
      reasons.push('电子数据收集程序合法性存疑')
    }

    if (input.formLegal === true) {
      score += 0.2
      reasons.push('电子数据形式合法')
    } else if (input.formLegal === false) {
      score -= 0.15
      reasons.push('电子数据形式合法性存疑')
    }

    if (hasText(input.source)) {
      score += 0.1
      reasons.push('已记录电子数据来源')
    }

    return dimensionJudgment('legality', score, reasons, '电子数据合法性')
  },

  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    // 哈希校验
    if (hasText(input.contentHash)) {
      score += 0.15
      reasons.push('已记录内容哈希')
      if (input.hashVerified === true) {
        score += 0.2
        reasons.push('哈希已独立核验')
      } else if (input.hashVerified === false) {
        score -= 0.1
        reasons.push('哈希未独立核验')
      }
    } else {
      score -= 0.1
      reasons.push('未记录内容哈希')
    }

    // 时间戳
    if (hasText(input.timestamp)) {
      score += 0.1
      reasons.push('已记录时间戳')
    } else {
      score -= 0.05
      reasons.push('未记录时间戳')
    }

    // 存储完整性
    if (input.storageIntegrityVerified === true) {
      score += 0.15
      reasons.push('存储完整性已核验')
    } else if (input.storageIntegrityVerified === false) {
      score -= 0.15
      reasons.push('存储完整性未核验')
    }

    return dimensionJudgment('authenticity', score, reasons, '电子数据真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []

    // LEGAL-EVI-004: 电子数据应验证完整性
    if (input.storageIntegrityVerified !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-004',
        passed: false,
        reason: '电子数据存储完整性未核验',
        severity: 'critical',
      })
    } else {
      findings.push({
        ruleId: 'LEGAL-EVI-004',
        passed: true,
        reason: '电子数据存储完整性已核验',
        severity: 'info',
      })
    }

    // LEGAL-EVI-005: 电子数据应有内容哈希
    if (!hasText(input.contentHash)) {
      findings.push({
        ruleId: 'LEGAL-EVI-005',
        passed: false,
        reason: '电子数据未记录内容哈希',
        severity: 'warning',
      })
    } else if (input.hashVerified !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-005',
        passed: false,
        reason: '电子数据内容哈希未独立核验',
        severity: 'warning',
      })
    }

    // LEGAL-EVI-006: 电子数据应有时间戳
    if (!hasText(input.timestamp)) {
      findings.push({
        ruleId: 'LEGAL-EVI-006',
        passed: false,
        reason: '电子数据未记录时间戳',
        severity: 'warning',
      })
    }

    return findings
  },
})
