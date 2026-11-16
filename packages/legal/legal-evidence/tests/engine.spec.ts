import { describe, expect, it } from 'vitest'
import { LegalEvidenceEngine } from '../src/engine.ts'
import type { LegalEvidenceInput } from '../src/types.ts'

const DOCUMENTARY_INPUT: LegalEvidenceInput = {
  evidenceId: 'test-doc-1',
  evidenceType: 'documentary',
  source: '合同原件',
  content: '甲方与乙方签订的销售合同',
  factToProve: '双方存在买卖合同关系',
  hasOriginal: true,
  signatureVerified: true,
  formationTimeClear: true,
  collectionLegal: true,
  formLegal: true,
}

const ELECTRONIC_INPUT: LegalEvidenceInput = {
  evidenceId: 'test-elec-1',
  evidenceType: 'electronic',
  source: '微信聊天记录',
  content: '双方关于合同变更的聊天记录',
  factToProve: '双方协商一致变更合同',
  contentHash: 'sha256:abc123',
  hashVerified: true,
  timestamp: '2024-01-15T10:30:00Z',
  storageIntegrityVerified: true,
  collectionLegal: true,
}

const WITNESS_INPUT: LegalEvidenceInput = {
  evidenceId: 'test-witness-1',
  evidenceType: 'witness_testimony',
  source: '证人张某',
  content: '目击事故经过的证言',
  factToProve: '事故发生过程',
  witnessHasConflict: false,
  corroborated: true,
  collectionLegal: true,
}

const EXPERT_INPUT: LegalEvidenceInput = {
  evidenceId: 'test-expert-1',
  evidenceType: 'expert_opinion',
  source: '某司法鉴定中心',
  content: '笔迹鉴定意见书',
  factToProve: '签名真实性',
  expertQualified: true,
  expertProcedureLegal: true,
  expertConclusionClear: true,
}

describe('LegalEvidenceEngine', () => {
  it('assesses documentary evidence with high scores when all attributes are present', () => {
    const engine = new LegalEvidenceEngine()
    const result = engine.assess(DOCUMENTARY_INPUT)

    expect(result.evidenceId).toBe('test-doc-1')
    expect(result.evidenceType).toBe('documentary')
    expect(result.score.relevance).toBeGreaterThan(0.5)
    expect(result.score.legality).toBeGreaterThan(0.5)
    expect(result.score.authenticity).toBeGreaterThan(0.5)
    expect(result.score.overall).toBeGreaterThan(0.5)
    expect(result.dimensions.relevance.dimension).toBe('relevance')
    expect(result.dimensions.legality.dimension).toBe('legality')
    expect(result.dimensions.authenticity.dimension).toBe('authenticity')
  })

  it('assesses electronic evidence with hash verification', () => {
    const engine = new LegalEvidenceEngine()
    const result = engine.assess(ELECTRONIC_INPUT)

    expect(result.evidenceType).toBe('electronic')
    expect(result.score.authenticity).toBeGreaterThan(0.5)
    expect(result.findings.some(f => f.ruleId === 'LEGAL-EVI-004' && f.passed)).toBe(true)
  })

  it('assesses witness testimony with conflict check', () => {
    const engine = new LegalEvidenceEngine()
    const result = engine.assess(WITNESS_INPUT)

    expect(result.evidenceType).toBe('witness_testimony')
    expect(result.findings.some(f => f.ruleId === 'LEGAL-EVI-007' && f.passed)).toBe(true)
  })

  it('assesses expert opinion with qualification check', () => {
    const engine = new LegalEvidenceEngine()
    const result = engine.assess(EXPERT_INPUT)

    expect(result.evidenceType).toBe('expert_opinion')
    expect(result.score.legality).toBeGreaterThan(0.5)
    expect(result.findings.some(f => f.ruleId === 'LEGAL-EVI-009' && f.passed)).toBe(true)
  })

  it('reports critical findings when attributes are missing', () => {
    const engine = new LegalEvidenceEngine()
    const input: LegalEvidenceInput = {
      evidenceId: 'test-doc-missing',
      evidenceType: 'documentary',
      hasOriginal: false,
      signatureVerified: false,
    }
    const result = engine.assess(input)

    expect(result.findings.some(f => f.ruleId === 'LEGAL-EVI-001' && !f.passed && f.severity === 'critical')).toBe(true)
    expect(result.score.authenticity).toBeLessThan(0.6)
  })

  it('batch assesses multiple inputs', () => {
    const engine = new LegalEvidenceEngine()
    const results = engine.batchAssess([DOCUMENTARY_INPUT, ELECTRONIC_INPUT])

    expect(results).toHaveLength(2)
    expect(results[0]!.evidenceType).toBe('documentary')
    expect(results[1]!.evidenceType).toBe('electronic')
  })

  it('loads YAML rules and applies weights', () => {
    const yamlText = `
weights:
  relevance: 0.4
  legality: 0.3
  authenticity: 0.3
rules:
  - id: TEST-001
    description: Test rule
    evidence_type: documentary
    check: hasOriginal
    severity: warning
`
    const engine = new LegalEvidenceEngine(yamlText, 'test.yaml')
    const rules = engine.getRules()

    expect(rules).toHaveLength(1)
    expect(rules[0]!.id).toBe('TEST-001')
  })

  it('drives general rules from the asset declaration', () => {
    const yamlText = `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - id: GEN-COLLECT
    description: 证据收集应合法
    evidence_type: general
    check: collectionLegal
    severity: warning
`
    const engine = new LegalEvidenceEngine(yamlText, 'test.yaml')
    const input: LegalEvidenceInput = {
      evidenceId: 'gen-collect',
      evidenceType: 'documentary',
      factToProve: '合同关系存在',
      hasOriginal: true,
      signatureVerified: true,
      formationTimeClear: true,
    }
    const result = engine.assess(input)

    const finding = result.findings.find(f => f.ruleId === 'GEN-COLLECT')
    expect(finding).toEqual({
      ruleId: 'GEN-COLLECT',
      passed: false,
      reason: '证据收集合法性未确认',
      severity: 'warning',
    })
    // The asset's rule list is the only source: the omitted default rules do not run.
    expect(result.findings.some(f => f.ruleId === 'LEGAL-EVI-GEN-001')).toBe(false)
    expect(result.reasoning).not.toContain('严重问题')
  })

  it('runs no general rule when the asset declares none', () => {
    const yamlText = `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules: []
`
    const engine = new LegalEvidenceEngine(yamlText, 'test.yaml')
    const result = engine.assess({ evidenceId: 'no-general', evidenceType: 'documentary' })

    expect(result.findings.some(f => f.ruleId.startsWith('LEGAL-EVI-GEN'))).toBe(false)
  })

  it('warns when a general rule names a check the engine cannot run', () => {
    const yamlText = `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - id: GEN-TYPO
    description: 写错检查名
    evidence_type: general
    check: hasFactToProveTypo
    severity: critical
`
    const engine = new LegalEvidenceEngine(yamlText, 'test.yaml')

    expect(engine.getWarnings().join('\n')).toContain('GEN-TYPO')
    expect(engine.getWarnings().join('\n')).toContain('hasFactToProveTypo')
    const result = engine.assess({ evidenceId: 'typo', evidenceType: 'documentary' })
    expect(result.findings.some(f => f.ruleId === 'GEN-TYPO')).toBe(false)
  })

  it('keeps the two general checks when no asset is loaded', () => {
    const result = new LegalEvidenceEngine().assess({ evidenceId: 'default', evidenceType: 'documentary' })

    expect(result.findings.filter(f => f.ruleId.startsWith('LEGAL-EVI-GEN')).map(f => [f.ruleId, f.severity]))
      .toEqual([['LEGAL-EVI-GEN-001', 'critical'], ['LEGAL-EVI-GEN-002', 'critical']])
  })

  it('returns rules by evidence type', () => {
    const yamlText = `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - id: DOC-001
    description: Documentary rule
    evidence_type: documentary
    check: hasOriginal
    severity: warning
  - id: ELEC-001
    description: Electronic rule
    evidence_type: electronic
    check: hashVerified
    severity: warning
`
    const engine = new LegalEvidenceEngine(yamlText, 'test.yaml')
    const docRules = engine.getRulesByType('documentary')

    expect(docRules).toHaveLength(1)
    expect(docRules[0]!.id).toBe('DOC-001')
  })

  it('handles invalid YAML gracefully', () => {
    const engine = new LegalEvidenceEngine('invalid: yaml: content:', 'bad.yaml')
    const warnings = engine.getWarnings()

    expect(warnings.length).toBeGreaterThan(0)
    // Engine should still work with default weights
    const result = engine.assess(DOCUMENTARY_INPUT)
    expect(result.score.overall).toBeGreaterThan(0)
  })

  it('includes burden holder and standard when provided', () => {
    const engine = new LegalEvidenceEngine()
    const input: LegalEvidenceInput = {
      ...DOCUMENTARY_INPUT,
      burdenHolder: 'plaintiff',
      standard: 'preponderance',
    }
    const result = engine.assess(input)

    expect(result.burdenHolder).toBe('plaintiff')
    expect(result.standard).toBe('preponderance')
  })
})
