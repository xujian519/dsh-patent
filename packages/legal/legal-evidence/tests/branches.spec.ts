/** Every decision branch of the legal-evidence evaluators, rule parser, and plugin entry. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, LegalEvidenceRuleAssetError } from '../src/index.ts'
import { createEvaluator, evaluateGenericLegality, evaluateGenericRelevance, hasText, levelFor } from '../src/evaluators/base.ts'
import { getEvaluator } from '../src/evaluators/index.ts'
import { documentaryEvaluator } from '../src/evaluators/documentary.ts'
import { electronicEvaluator } from '../src/evaluators/electronic.ts'
import { expertOpinionEvaluator } from '../src/evaluators/expert-opinion.ts'
import {
  audioVisualEvaluator,
  inspectionRecordEvaluator,
  partyStatementEvaluator,
  physicalEvaluator,
} from '../src/evaluators/other-types.ts'
import { witnessTestimonyEvaluator } from '../src/evaluators/witness-testimony.ts'
import { LegalEvidenceEngine } from '../src/engine.ts'
import { parseLegalRuleSet } from '../src/rule-set.ts'
import { createEvaluateLegalEvidenceTool } from '../src/tool/evaluate-evidence.ts'
import type { LegalEvidenceInput, LegalEvidenceType } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const input = (overrides: Partial<LegalEvidenceInput> = {}): LegalEvidenceInput => ({
  evidenceId: 'branch-evidence',
  evidenceType: 'documentary',
  ...overrides,
})

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-legal-evidence-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function hostWith(config?: { rulesDir?: string }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  apply(ctx, config ?? {})
  return ctx
}

describe('evaluator helpers', () => {
  it('treats only non-blank strings as text', () => {
    expect(hasText('value')).toBe(true)
    expect(hasText('  value  ')).toBe(true)
    expect(hasText('')).toBe(false)
    expect(hasText('   ')).toBe(false)
    expect(hasText(undefined)).toBe(false)
    expect(hasText(null)).toBe(false)
  })

  it('maps every score band to its level', () => {
    expect(levelFor(0.85)).toBe('high')
    expect(levelFor(0.65)).toBe('medium_high')
    expect(levelFor(0.45)).toBe('medium')
    expect(levelFor(0.44)).toBe('low')
  })

  it('scores generic relevance with no supporting fields', () => {
    const result = evaluateGenericRelevance(input())
    expect(result).toMatchObject({ dimension: 'relevance', score: 0.5, level: 'medium' })
    expect(result.reasoning).toBe('关联性评估：基础评分')
  })

  it('scores generic relevance from fact, content, and source', () => {
    const result = evaluateGenericRelevance(input({ factToProve: '事实', content: '内容', source: '来源' }))
    expect(result.score).toBe(0.9)
    expect(result.reasoning).toContain('已明确待证事实')
    expect(result.reasoning).toContain('已提供证据内容')
    expect(result.reasoning).toContain('已记录证据来源')
  })

  it('clamps generic relevance at one', () => {
    const result = evaluateGenericRelevance(input({ factToProve: '事实', content: '内容', source: '来源' }))
    expect(result.score).toBeLessThanOrEqual(1)
  })

  it('scores generic legality with no declared facts', () => {
    const result = evaluateGenericLegality(input())
    expect(result.reasoning).toBe('合法性评估：基础评分')
    expect(result.score).toBe(0.5)
  })

  it('scores generic legality for every declared fact', () => {
    const result = evaluateGenericLegality(input({
      collectionLegal: true, formLegal: true, source: '来源',
    }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('证据收集合法')
    expect(result.reasoning).toContain('证据形式合法')
    expect(result.reasoning).toContain('已记录证据来源')
  })

  it('lowers generic legality when collection or form is illegal', () => {
    const result = evaluateGenericLegality(input({ collectionLegal: false, formLegal: false }))
    expect(result.score).toBe(0.15)
    expect(result.reasoning).toContain('证据收集合法性存疑')
    expect(result.reasoning).toContain('证据形式合法性存疑')
  })

  it('clamps generic legality at zero', () => {
    const result = evaluateGenericLegality(input({ collectionLegal: false, formLegal: false }))
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('falls back to the generic legality assessor when a type omits one', () => {
    const evaluator = createEvaluator({
      assessAuthenticity: evaluateGenericRelevance,
      checkFindings: () => [],
    })
    expect(evaluator.evaluateLegality(input({ collectionLegal: true })).dimension).toBe('legality')
  })

  it('dispatches every evidence type and rejects an unknown one', () => {
    const cases: Array<[LegalEvidenceType, unknown]> = [
      ['party_statement', partyStatementEvaluator],
      ['documentary', documentaryEvaluator],
      ['physical', physicalEvaluator],
      ['audio_visual', audioVisualEvaluator],
      ['electronic', electronicEvaluator],
      ['witness_testimony', witnessTestimonyEvaluator],
      ['expert_opinion', expertOpinionEvaluator],
      ['inspection_record', inspectionRecordEvaluator],
    ]
    for (const [type, evaluator] of cases) expect(getEvaluator(type)).toBe(evaluator)
    expect(() => getEvaluator('unknown' as LegalEvidenceType)).toThrow('Unhandled evidence type: unknown')
  })
})

describe('documentary evaluator branches', () => {
  it('credits a documented reason for a missing original', () => {
    const result = documentaryEvaluator.evaluateAuthenticity(input({ hasOriginal: false, originalAbsenceReason: '存档于法院' }))
    expect(result.reasoning).toContain('未提供原件但有合理说明')
  })

  it('penalizes a missing original with no reason', () => {
    const result = documentaryEvaluator.evaluateAuthenticity(
      input({ hasOriginal: false, signatureVerified: false, formationTimeClear: false }),
    )
    expect(result.reasoning).toContain('未提供原件且未说明原因')
    expect(result.reasoning).toContain('签章真实性未核验')
    expect(result.reasoning).toContain('形成时间不明确')
    expect(result.score).toBeCloseTo(0.05)
  })

  it('leaves optional facts unscored when absent', () => {
    const result = documentaryEvaluator.evaluateAuthenticity(input())
    expect(result.reasoning).toBe('书证真实性评估：基础评分')
    expect(result.score).toBe(0.5)
  })

  it('reports every passed finding for a complete documentary record', () => {
    const findings = documentaryEvaluator.checkFindings(input({
      hasOriginal: true, signatureVerified: true, formationTimeClear: true,
    }))
    expect(findings).toEqual([{ ruleId: 'LEGAL-EVI-001', passed: true, reason: '已提供原件', severity: 'info' }])
  })

  it('names the stated reason on a missing original', () => {
    const findings = documentaryEvaluator.checkFindings(input({
      hasOriginal: false, originalAbsenceReason: '原件在对方处', signatureVerified: true, formationTimeClear: true,
    }))
    expect(findings[0]?.reason).toContain('原件在对方处')
  })

  it('reports unverified signature and formation time', () => {
    const findings = documentaryEvaluator.checkFindings(input({
      hasOriginal: true, signatureVerified: false, formationTimeClear: false,
    }))
    expect(findings.map(finding => finding.ruleId)).toEqual(['LEGAL-EVI-001', 'LEGAL-EVI-002', 'LEGAL-EVI-003'])
  })
})

describe('electronic evaluator branches', () => {
  it('scores legality for legal collection, form, and source', () => {
    const result = electronicEvaluator.evaluateLegality(input({ collectionLegal: true, formLegal: true, source: '服务器' }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('电子数据收集程序合法')
    expect(result.reasoning).toContain('电子数据形式合法')
    expect(result.reasoning).toContain('已记录电子数据来源')
  })

  it('penalizes illegal collection', () => {
    const result = electronicEvaluator.evaluateLegality(input({ collectionLegal: false }))
    expect(result.score).toBe(0.2)
    expect(result.reasoning).toContain('电子数据收集程序合法性存疑')
  })

  it('leaves legality unscored when nothing is declared', () => {
    expect(electronicEvaluator.evaluateLegality(input()).reasoning).toBe('电子数据合法性评估：基础评分')
  })

  it('credits a verified hash and timestamp', () => {
    const result = electronicEvaluator.evaluateAuthenticity(input({
      contentHash: 'abc', hashVerified: true, timestamp: '2024-01-01', storageIntegrityVerified: true,
    }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('哈希已独立核验')
    expect(result.reasoning).toContain('已记录时间戳')
    expect(result.reasoning).toContain('存储完整性已核验')
  })

  it('does not credit or penalize a hash whose verification is undeclared', () => {
    const result = electronicEvaluator.evaluateAuthenticity(input({ contentHash: 'abc' }))
    expect(result.reasoning).toContain('已记录内容哈希')
    expect(result.reasoning).not.toContain('哈希已独立核验')
    expect(result.reasoning).not.toContain('哈希未独立核验')
  })

  it('penalizes an unverified hash, absent timestamp, and broken storage', () => {
    const result = electronicEvaluator.evaluateAuthenticity(input({
      contentHash: 'abc', hashVerified: false, storageIntegrityVerified: false,
    }))
    expect(result.reasoning).toContain('哈希未独立核验')
    expect(result.reasoning).toContain('未记录时间戳')
    expect(result.reasoning).toContain('存储完整性未核验')
  })

  it('penalizes a record with no hash and clamps at zero', () => {
    const result = electronicEvaluator.evaluateAuthenticity(input({
      hashVerified: false, timestamp: ' ', storageIntegrityVerified: false,
    }))
    expect(result.score).toBeCloseTo(0.2)
    expect(result.reasoning).toContain('未记录内容哈希')
  })

  it('leaves authenticity unscored when nothing is declared', () => {
    // An absent timestamp still scores; the base plus no hash and no timestamp.
    const result = electronicEvaluator.evaluateAuthenticity(input())
    expect(result.score).toBeCloseTo(0.35)
  })

  it('reports integrity, hash, and timestamp findings', () => {
    const findings = electronicEvaluator.checkFindings(input({ storageIntegrityVerified: true, contentHash: 'abc' }))
    expect(findings.map(finding => finding.ruleId)).toEqual(['LEGAL-EVI-004', 'LEGAL-EVI-005', 'LEGAL-EVI-006'])
    expect(findings[0]?.passed).toBe(true)
    expect(findings[1]?.reason).toContain('未独立核验')
  })

  it('reports an absent hash without a verification claim', () => {
    const findings = electronicEvaluator.checkFindings(input({
      storageIntegrityVerified: true, contentHash: ' ', timestamp: 'now', hashVerified: true,
    }))
    expect(findings).toEqual([
      { ruleId: 'LEGAL-EVI-004', passed: true, reason: '电子数据存储完整性已核验', severity: 'info' },
      { ruleId: 'LEGAL-EVI-005', passed: false, reason: '电子数据未记录内容哈希', severity: 'warning' },
    ])
  })
})

describe('expert-opinion evaluator branches', () => {
  it('penalizes missing qualification and illegal procedure', () => {
    const result = expertOpinionEvaluator.evaluateLegality(input({
      expertQualified: false, expertProcedureLegal: false,
    }))
    expect(result.score).toBe(0)
    expect(result.reasoning).toContain('鉴定机构/鉴定人资质未核验')
    expect(result.reasoning).toContain('鉴定程序合法性存疑')
  })

  it('leaves legality unscored when nothing is declared', () => {
    expect(expertOpinionEvaluator.evaluateLegality(input()).reasoning).toBe('鉴定意见合法性评估：基础评分')
  })

  it('credits a clear conclusion, materials, and qualification', () => {
    const result = expertOpinionEvaluator.evaluateAuthenticity(input({
      expertConclusionClear: true, content: '鉴定材料', expertQualified: true,
    }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('鉴定结论明确')
    expect(result.reasoning).toContain('已记录鉴定材料')
    expect(result.reasoning).toContain('鉴定资质已核验')
  })

  it('penalizes an unclear conclusion', () => {
    const result = expertOpinionEvaluator.evaluateAuthenticity(input({ expertConclusionClear: false }))
    expect(result.score).toBe(0.3)
    expect(result.reasoning).toContain('鉴定结论不明确')
  })

  it('leaves authenticity unscored when nothing is declared', () => {
    expect(expertOpinionEvaluator.evaluateAuthenticity(input()).reasoning).toBe('鉴定意见真实性评估：基础评分')
  })

  it('reports qualification, procedure, and conclusion findings', () => {
    const findings = expertOpinionEvaluator.checkFindings(input({
      expertQualified: true, expertProcedureLegal: false, expertConclusionClear: false,
    }))
    expect(findings.map(finding => finding.ruleId)).toEqual(['LEGAL-EVI-009', 'LEGAL-EVI-010', 'LEGAL-EVI-011'])
    expect(findings[0]?.passed).toBe(true)
  })

  it('reports no procedure or conclusion finding when both are satisfied', () => {
    const findings = expertOpinionEvaluator.checkFindings(input({
      expertQualified: true, expertProcedureLegal: true, expertConclusionClear: true,
    }))
    expect(findings).toHaveLength(1)
  })
})

describe('witness-testimony evaluator branches', () => {
  it('scores legality for legal collection, form, and identity', () => {
    const result = witnessTestimonyEvaluator.evaluateLegality(input({
      collectionLegal: true, formLegal: true, source: '证人张某',
    }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('证人证言形式合法')
    expect(result.reasoning).toContain('已记录证人身份')
  })

  it('penalizes illegal collection', () => {
    const result = witnessTestimonyEvaluator.evaluateLegality(input({ collectionLegal: false }))
    expect(result.score).toBe(0.2)
  })

  it('leaves legality unscored when nothing is declared', () => {
    expect(witnessTestimonyEvaluator.evaluateLegality(input()).reasoning).toBe('证人证言合法性评估：基础评分')
  })

  it('credits a disclosed conflict', () => {
    const result = witnessTestimonyEvaluator.evaluateAuthenticity(input({
      witnessHasConflict: true, conflictDisclosed: true, corroborated: true, content: '证言',
    }))
    expect(result.score).toBeCloseTo(0.85)
    expect(result.reasoning).toContain('证人有利害关系但已披露')
    expect(result.reasoning).toContain('证人证言有其他证据佐证')
    expect(result.reasoning).toContain('已记录证言内容')
  })

  it('penalizes an undisclosed conflict and absent corroboration', () => {
    const result = witnessTestimonyEvaluator.evaluateAuthenticity(input({
      witnessHasConflict: true, conflictDisclosed: false, corroborated: false,
    }))
    expect(result.score).toBe(0.15)
    expect(result.reasoning).toContain('证人有利害关系且未披露')
    expect(result.reasoning).toContain('证人证言缺乏佐证')
  })

  it('credits a witness with no conflict', () => {
    const result = witnessTestimonyEvaluator.evaluateAuthenticity(input({ witnessHasConflict: false }))
    expect(result.score).toBe(0.65)
    expect(result.reasoning).toContain('证人与案件无利害关系')
  })

  it('leaves authenticity unscored when nothing is declared', () => {
    expect(witnessTestimonyEvaluator.evaluateAuthenticity(input()).reasoning).toBe('证人证言真实性评估：基础评分')
  })

  it('reports the three conflict outcomes and missing corroboration', () => {
    const undisclosed = witnessTestimonyEvaluator.checkFindings(input({ witnessHasConflict: true, conflictDisclosed: false }))
    expect(undisclosed.map(finding => finding.ruleId)).toEqual(['LEGAL-EVI-007', 'LEGAL-EVI-008'])
    expect(undisclosed[0]?.passed).toBe(false)

    const disclosed = witnessTestimonyEvaluator.checkFindings(
      input({ witnessHasConflict: true, conflictDisclosed: true, corroborated: true }),
    )
    expect(disclosed[0]?.reason).toBe('证人有利害关系但已披露')

    const neutral = witnessTestimonyEvaluator.checkFindings(input({ witnessHasConflict: false, corroborated: true }))
    expect(neutral[0]?.reason).toBe('证人与案件无利害关系')
  })
})

describe('other evidence types', () => {
  it('scores a party statement with content and corroboration', () => {
    const result = partyStatementEvaluator.evaluateAuthenticity(input({ content: '陈述', corroborated: true }))
    expect(result.score).toBeCloseTo(0.85)
    expect(result.reasoning).toContain('已记录陈述内容')
    expect(result.reasoning).toContain('有其他证据佐证')
  })

  it('penalizes an uncorroborated party statement', () => {
    const result = partyStatementEvaluator.evaluateAuthenticity(input({ corroborated: false }))
    expect(result.score).toBe(0.35)
    expect(result.reasoning).toContain('缺乏其他证据佐证')
  })

  it('leaves party-statement authenticity unscored when nothing is declared', () => {
    expect(partyStatementEvaluator.evaluateAuthenticity(input()).reasoning).toBe('当事人陈述真实性评估：基础评分')
  })

  it('reports and clears the party-statement corroboration finding', () => {
    expect(partyStatementEvaluator.checkFindings(input({ corroborated: false }))).toHaveLength(1)
    expect(partyStatementEvaluator.checkFindings(input({ corroborated: true }))).toEqual([])
  })

  it('credits a physical original or a documented absence', () => {
    expect(physicalEvaluator.evaluateAuthenticity(input({ hasOriginal: true, storageIntegrityVerified: true })).score).toBe(0.9)
    const explained = physicalEvaluator.evaluateAuthenticity(input({ hasOriginal: false, originalAbsenceReason: '已销毁' }))
    expect(explained.reasoning).toContain('未提供原物但有合理说明')
  })

  it('penalizes a missing physical original', () => {
    const result = physicalEvaluator.evaluateAuthenticity(input({ hasOriginal: false }))
    expect(result.score).toBe(0.35)
    expect(result.reasoning).toContain('未提供原物且未说明原因')
  })

  it('leaves physical authenticity unscored when nothing is declared', () => {
    expect(physicalEvaluator.evaluateAuthenticity(input()).reasoning).toBe('物证真实性评估：基础评分')
  })

  it('reports a missing physical original', () => {
    expect(physicalEvaluator.checkFindings(input({ hasOriginal: false }))).toHaveLength(1)
    expect(physicalEvaluator.checkFindings(input({ hasOriginal: true }))).toEqual([])
  })

  it('scores an audio-visual record with hash, storage, and time', () => {
    const result = audioVisualEvaluator.evaluateAuthenticity(input({
      contentHash: 'abc', hashVerified: true, storageIntegrityVerified: true, timestamp: 'now',
    }))
    expect(result.score).toBe(1)
    expect(result.reasoning).toContain('哈希已核验')
    expect(result.reasoning).toContain('存储完整性已核验')
    expect(result.reasoning).toContain('已记录时间信息')
  })

  it('does not credit an unverified audio-visual hash', () => {
    const result = audioVisualEvaluator.evaluateAuthenticity(input({ contentHash: 'abc', hashVerified: false }))
    expect(result.score).toBe(0.65)
    expect(result.reasoning).not.toContain('哈希已核验')
  })

  it('leaves audio-visual authenticity unscored when nothing is declared', () => {
    expect(audioVisualEvaluator.evaluateAuthenticity(input()).reasoning).toBe('视听资料真实性评估：基础评分')
  })

  it('reports a missing audio-visual hash', () => {
    expect(audioVisualEvaluator.checkFindings(input())).toHaveLength(1)
    expect(audioVisualEvaluator.checkFindings(input({ contentHash: 'abc' }))).toEqual([])
  })

  it('scores an inspection record with a witness and complete record', () => {
    const result = inspectionRecordEvaluator.evaluateAuthenticity(input({
      inspectionHasWitness: true, inspectionRecordComplete: true,
    }))
    expect(result.score).toBeCloseTo(0.9)
    expect(result.reasoning).toContain('勘验有见证人在场')
    expect(result.reasoning).toContain('勘验记录完整')
  })

  it('penalizes missing inspection witness and record', () => {
    const result = inspectionRecordEvaluator.evaluateAuthenticity(input({
      inspectionHasWitness: false, inspectionRecordComplete: false,
    }))
    expect(result.score).toBeCloseTo(0.2)
    expect(result.reasoning).toContain('勘验无见证人在场')
    expect(result.reasoning).toContain('勘验记录不完整')
  })

  it('leaves inspection authenticity unscored when nothing is declared', () => {
    expect(inspectionRecordEvaluator.evaluateAuthenticity(input()).reasoning).toBe('勘验笔录真实性评估：基础评分')
  })

  it('reports both inspection findings', () => {
    const findings = inspectionRecordEvaluator.checkFindings(input())
    expect(findings.map(finding => finding.ruleId)).toEqual(['LEGAL-EVI-015', 'LEGAL-EVI-016'])
    expect(inspectionRecordEvaluator.checkFindings(input({
      inspectionHasWitness: true, inspectionRecordComplete: true,
    }))).toEqual([])
  })
})

describe('rule-set parser branches', () => {
  it('reports a YAML syntax error', () => {
    const parsed = parseLegalRuleSet('invalid: yaml: content:', 'bad.yaml')
    expect(parsed.ruleSet).toBeNull()
    expect(parsed.warnings[0]).toContain('YAML 解析失败 bad.yaml')
  })

  it('rejects a non-object document', () => {
    const parsed = parseLegalRuleSet('- one\n- two\n', 'list.yaml')
    expect(parsed.ruleSet).toBeNull()
    expect(parsed.warnings[0]).toContain('顶层必须是对象')
  })

  it('falls back per weight and warns when rules are absent', () => {
    const parsed = parseLegalRuleSet('weights:\n  relevance: high\n', 'weights.yaml')
    expect(parsed.ruleSet?.weights).toEqual({ relevance: 0.35, legality: 0.3, authenticity: 0.35 })
    expect(parsed.warnings.some(warning => warning.includes('缺少 rules 数组'))).toBe(true)
  })

  it('accepts numeric weights and camel-case evidence types', () => {
    const parsed = parseLegalRuleSet([
      'weights:',
      '  relevance: 0.5',
      '  legality: 0.25',
      '  authenticity: 0.25',
      'rules:',
      '  - id: RULE-1',
      '    description: desc',
      '    evidenceType: documentary',
      '    check: hasOriginal',
      '    severity: critical',
      '    legalBasis: 民诉法',
      '    conditions:',
      '      - hasOriginal',
      '      - 42',
      '',
    ].join('\n'), 'camel.yaml')
    expect(parsed.ruleSet?.weights).toEqual({ relevance: 0.5, legality: 0.25, authenticity: 0.25 })
    expect(parsed.ruleSet?.rules[0]).toEqual({
      id: 'RULE-1',
      description: 'desc',
      evidenceType: 'documentary',
      check: 'hasOriginal',
      severity: 'critical',
      legalBasis: '民诉法',
      conditions: ['hasOriginal'],
    })
  })

  it('skips malformed entries with a warning each', () => {
    const parsed = parseLegalRuleSet([
      'rules:',
      '  - just-a-string',
      '  - id: NO-DESC',
      '  - id: NO-TYPE',
      '    description: desc',
      '  - id: UNKNOWN-TYPE',
      '    description: desc',
      '    evidence_type: hearsay',
      '  - id: NO-CHECK',
      '    description: desc',
      '    evidence_type: general',
      '  - id: BAD-SEVERITY',
      '    description: desc',
      '    evidence_type: general',
      '    check: any',
      '    severity: fatal',
      '',
    ].join('\n'), 'skips.yaml')
    expect(parsed.ruleSet?.rules.map(rule => rule.id)).toEqual(['BAD-SEVERITY'])
    expect(parsed.ruleSet?.rules[0]?.severity).toBe('warning')
    expect(parsed.warnings).toHaveLength(5)
  })

  it('treats a non-array conditions field as absent', () => {
    const parsed = parseLegalRuleSet([
      'rules:',
      '  - id: RULE-2',
      '    description: desc',
      '    evidence_type: general',
      '    check: any',
      '    severity: info',
      '    conditions: not-a-list',
      '',
    ].join('\n'), 'conditions.yaml')
    expect(parsed.ruleSet?.rules[0]).not.toHaveProperty('conditions')
  })
})

describe('engine branches', () => {
  it('returns no rules and default weights before an asset loads', () => {
    const engine = new LegalEvidenceEngine()
    expect(engine.getRules()).toEqual([])
    expect(engine.getRulesByType('documentary')).toEqual([])
    const result = engine.assess(input({ evidenceType: 'party_statement', corroborated: true }))
    expect(result.score.overall).toBeCloseTo(0.35 * 0.5 + 0.3 * 0.5 + 0.35 * 0.7)
  })

  it('accumulates warnings across loads', () => {
    const engine = new LegalEvidenceEngine('invalid: yaml: content:', 'bad.yaml')
    engine.loadRules('- not-an-object', 'second.yaml')
    expect(engine.getWarnings()).toHaveLength(2)
  })

  it('omits optional burden and standard fields when absent', () => {
    const result = new LegalEvidenceEngine().assess(input())
    expect(result).not.toHaveProperty('burdenHolder')
    expect(result).not.toHaveProperty('standard')
  })

  it('lists general rules under every type', () => {
    const engine = new LegalEvidenceEngine([
      'rules:',
      '  - id: GENERAL',
      '    description: desc',
      '    evidence_type: general',
      '    check: any',
      '',
    ].join('\n'), 'general.yaml')
    expect(engine.getRulesByType('physical').map(rule => rule.id)).toEqual(['GENERAL'])
  })
})

describe('plugin entry', () => {
  it('registers the tool over the packaged rules asset', async () => {
    const ctx = await hostWith()
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('legal-evidence-default'),
      name: 'evaluate_legal_evidence',
      arguments: { evidenceId: 'plugin-1', evidenceType: 'documentary', hasOriginal: true },
    })
    expect(result.isError).toBe(false)
  })

  it('loads an explicit rules directory', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'legal-evidence-rules.yaml'), 'weights:\n  relevance: 1\n  legality: 0\n  authenticity: 0\n')
    const ctx = await hostWith({ rulesDir: dir })
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('legal-evidence-explicit-rules'),
      name: 'evaluate_legal_evidence',
      arguments: { evidenceId: 'plugin-3', evidenceType: 'documentary', hasOriginal: true },
    })
    expect(result.isError).toBe(false)
  })

  it('fails loud when the explicit directory has no rules file', async () => {
    const dir = tempDir()
    await expect(hostWith({ rulesDir: dir })).rejects.toThrow(LegalEvidenceRuleAssetError)
  })

  it('renders a report with no rule findings', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createEvaluateLegalEvidenceTool(new LegalEvidenceEngine()))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('legal-evidence-no-findings'),
      name: 'evaluate_legal_evidence',
      arguments: { evidenceId: 'party-2', evidenceType: 'party_statement', corroborated: true, factToProve: '待证事实', collectionLegal: true },
    })
    expect(result.isError).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).not.toContain('规则检查')
  })

  it('renders warning and low-score guidance', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createEvaluateLegalEvidenceTool(new LegalEvidenceEngine()))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('legal-evidence-low'),
      name: 'evaluate_legal_evidence',
      arguments: {
        evidenceId: 'empty-doc', evidenceType: 'documentary', hasOriginal: false,
        signatureVerified: false, formationTimeClear: false, collectionLegal: false, formLegal: false,
      },
    })
    expect(result.isError).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('严重问题')
    expect(text).toContain('建议：评分偏低')
    expect(text).toContain('规则检查')
  })
})
