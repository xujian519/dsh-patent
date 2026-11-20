/**
 * 其余法定证据种类判定器（当事人陈述、物证、视听资料、勘验笔录）。
 *
 * 这四类证据的判定逻辑相对简单，统一使用通用评估函数。
 */

import type { LegalEvidenceFinding, LegalEvidenceInput } from '../types.ts'
import { createEvaluator, dimensionJudgment, hasText, TRIPLE_ATTRIBUTE_BASE, type LegalEvidenceEvaluator } from './base.ts'

/** 当事人陈述判定器。 */
export const partyStatementEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    if (hasText(input.content)) {
      score += 0.15
      reasons.push('已记录陈述内容')
    }

    // 当事人陈述需其他证据佐证
    if (input.corroborated === true) {
      score += 0.2
      reasons.push('有其他证据佐证')
    } else if (input.corroborated === false) {
      score -= 0.15
      reasons.push('缺乏其他证据佐证')
    }

    return dimensionJudgment('authenticity', score, reasons, '当事人陈述真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []
    if (input.corroborated !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-012',
        passed: false,
        reason: '当事人陈述缺乏其他证据佐证',
        severity: 'warning',
      })
    }
    return findings
  },
})

/** 物证判定器。 */
export const physicalEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    if (input.hasOriginal === true) {
      score += 0.25
      reasons.push('已提供原物')
    } else if (input.hasOriginal === false) {
      if (hasText(input.originalAbsenceReason)) {
        score += 0.05
        reasons.push('未提供原物但有合理说明')
      } else {
        score -= 0.15
        reasons.push('未提供原物且未说明原因')
      }
    }

    if (input.storageIntegrityVerified === true) {
      score += 0.15
      reasons.push('物证保管链完整')
    }

    return dimensionJudgment('authenticity', score, reasons, '物证真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []
    if (input.hasOriginal !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-013',
        passed: false,
        reason: '物证应提供原物，未提供且未说明原因',
        severity: 'warning',
      })
    }
    return findings
  },
})

/** 视听资料判定器。 */
export const audioVisualEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    if (hasText(input.contentHash)) {
      score += 0.15
      reasons.push('已记录内容哈希')
      if (input.hashVerified === true) {
        score += 0.15
        reasons.push('哈希已核验')
      }
    }

    if (input.storageIntegrityVerified === true) {
      score += 0.15
      reasons.push('存储完整性已核验')
    }

    if (hasText(input.timestamp)) {
      score += 0.1
      reasons.push('已记录时间信息')
    }

    return dimensionJudgment('authenticity', score, reasons, '视听资料真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []
    if (!hasText(input.contentHash)) {
      findings.push({
        ruleId: 'LEGAL-EVI-014',
        passed: false,
        reason: '视听资料未记录内容哈希',
        severity: 'warning',
      })
    }
    return findings
  },
})

/** 勘验笔录判定器。 */
export const inspectionRecordEvaluator: LegalEvidenceEvaluator = createEvaluator({
  assessAuthenticity(input) {
    let score = TRIPLE_ATTRIBUTE_BASE
    const reasons: string[] = []

    if (input.inspectionHasWitness === true) {
      score += 0.2
      reasons.push('勘验有见证人在场')
    } else if (input.inspectionHasWitness === false) {
      score -= 0.15
      reasons.push('勘验无见证人在场')
    }

    if (input.inspectionRecordComplete === true) {
      score += 0.2
      reasons.push('勘验记录完整')
    } else if (input.inspectionRecordComplete === false) {
      score -= 0.15
      reasons.push('勘验记录不完整')
    }

    return dimensionJudgment('authenticity', score, reasons, '勘验笔录真实性')
  },

  checkFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []
    if (input.inspectionHasWitness !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-015',
        passed: false,
        reason: '勘验无见证人在场',
        severity: 'warning',
      })
    }
    if (input.inspectionRecordComplete !== true) {
      findings.push({
        ruleId: 'LEGAL-EVI-016',
        passed: false,
        reason: '勘验记录不完整',
        severity: 'warning',
      })
    }
    return findings
  },
})
