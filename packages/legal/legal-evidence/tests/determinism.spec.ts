/**
 * 确定性与缺失字段边界测试。
 *
 * - 相同输入必须产出位级相同的输出（确定性）。
 * - 八类证据的最小输入（仅 evidenceId + evidenceType）评分必须落在 [0, 1]，
 *   且 reasoning 非空（缺失字段走保守默认，不得崩溃或产出空说明）。
 */
import { describe, expect, it } from 'vitest'
import { LegalEvidenceEngine } from '../src/engine.ts'
import type { LegalEvidenceInput, LegalEvidenceType } from '../src/types.ts'
import { LEGAL_EVIDENCE_TYPES } from '../src/types.ts'

const engine = new LegalEvidenceEngine()

/** 每类证据的一个字段较全的输入，用于确定性断言。 */
const FULL_INPUTS: Record<LegalEvidenceType, LegalEvidenceInput> = {
  party_statement: {
    evidenceId: 'det-party', evidenceType: 'party_statement',
    content: '陈述内容', factToProve: '待证事实', source: '当事人', corroborated: true,
    collectionLegal: true, formLegal: true,
  },
  documentary: {
    evidenceId: 'det-doc', evidenceType: 'documentary',
    source: '合同原件', content: '销售合同', factToProve: '合同关系',
    hasOriginal: true, signatureVerified: true, formationTimeClear: true,
    collectionLegal: true, formLegal: true,
  },
  physical: {
    evidenceId: 'det-phys', evidenceType: 'physical',
    source: '物证来源', factToProve: '物证事实', hasOriginal: true, storageIntegrityVerified: true,
    collectionLegal: true,
  },
  audio_visual: {
    evidenceId: 'det-av', evidenceType: 'audio_visual',
    source: '录音来源', factToProve: '视听事实', contentHash: 'sha256:abc', hashVerified: true,
    timestamp: '2024-01-01T00:00:00Z', storageIntegrityVerified: true, collectionLegal: true,
  },
  electronic: {
    evidenceId: 'det-elec', evidenceType: 'electronic',
    source: '聊天记录', content: '聊天内容', factToProve: '电子数据事实',
    contentHash: 'sha256:abc', hashVerified: true, timestamp: '2024-01-01T00:00:00Z',
    storageIntegrityVerified: true, collectionLegal: true, formLegal: true,
  },
  witness_testimony: {
    evidenceId: 'det-wit', evidenceType: 'witness_testimony',
    source: '证人张某', content: '证言内容', factToProve: '证言事实',
    witnessHasConflict: false, corroborated: true, collectionLegal: true, formLegal: true,
  },
  expert_opinion: {
    evidenceId: 'det-exp', evidenceType: 'expert_opinion',
    source: '鉴定中心', content: '鉴定材料', factToProve: '鉴定事实',
    expertQualified: true, expertProcedureLegal: true, expertConclusionClear: true,
    collectionLegal: true,
  },
  inspection_record: {
    evidenceId: 'det-insp', evidenceType: 'inspection_record',
    source: '勘验笔录', factToProve: '勘验事实',
    inspectionHasWitness: true, inspectionRecordComplete: true, collectionLegal: true,
  },
}

describe('legal-evidence determinism', () => {
  it.each(LEGAL_EVIDENCE_TYPES)('produces identical output for identical input (%s)', (type) => {
    const input = FULL_INPUTS[type]
    const a = engine.assess(input)
    const b = engine.assess(input)
    const c = engine.assess(input)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('batchAssess agrees with sequential assess', () => {
    const inputs = LEGAL_EVIDENCE_TYPES.map(type => FULL_INPUTS[type])
    const batch = engine.batchAssess(inputs)
    const sequential = inputs.map(input => engine.assess(input))
    expect(batch).toEqual(sequential)
  })
})

describe('legal-evidence missing-field boundaries', () => {
  it.each(LEGAL_EVIDENCE_TYPES)('clamps all scores in [0, 1] for minimal input (%s)', (type) => {
    const result = engine.assess({ evidenceId: `min-${type}`, evidenceType: type })
    const { relevance, legality, authenticity, overall } = result.score
    for (const value of [relevance, legality, authenticity, overall]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it.each(LEGAL_EVIDENCE_TYPES)('keeps every dimension reasoning non-empty for minimal input (%s)', (type) => {
    const result = engine.assess({ evidenceId: `min-${type}`, evidenceType: type })
    expect(result.dimensions.relevance.reasoning.trim()).not.toBe('')
    expect(result.dimensions.legality.reasoning.trim()).not.toBe('')
    expect(result.dimensions.authenticity.reasoning.trim()).not.toBe('')
    expect(result.reasoning.trim()).not.toBe('')
  })

  it.each(LEGAL_EVIDENCE_TYPES)('keeps level within the known bands for minimal input (%s)', (type) => {
    const result = engine.assess({ evidenceId: `min-${type}`, evidenceType: type })
    const levels = new Set(['high', 'medium_high', 'medium', 'low'])
    expect(levels.has(result.dimensions.relevance.level)).toBe(true)
    expect(levels.has(result.dimensions.legality.level)).toBe(true)
    expect(levels.has(result.dimensions.authenticity.level)).toBe(true)
  })

  it('does not set hasShifted on any assessment', () => {
    for (const type of LEGAL_EVIDENCE_TYPES) {
      const result = engine.assess(FULL_INPUTS[type])
      expect(result).not.toHaveProperty('hasShifted')
    }
  })
})
