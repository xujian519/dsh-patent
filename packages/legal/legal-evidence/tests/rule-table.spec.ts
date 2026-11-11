/**
 * 规则表驱动测试：锁定 `assets/legal-evidence-rules.yaml` 与判定器产出的发现之间的对应关系。
 *
 * 守卫三类漂移：
 * 1. YAML 声明的每条规则都有对应的失败发现产出路径（声明了就要能跑到）。
 * 2. 判定器产出的每个 ruleId 都存在于 YAML 中（无孤儿发现）。
 * 3. 失败发现的 severity 与 YAML 声明一致。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LegalEvidenceEngine } from '../src/engine.ts'
import { parseLegalRuleSet } from '../src/rule-set.ts'
import type { LegalEvidenceInput, LegalEvidenceRule, LegalEvidenceType } from '../src/types.ts'
import { LEGAL_EVIDENCE_TYPES } from '../src/types.ts'

const ASSET_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'assets', 'legal-evidence-rules.yaml')
const yamlText = readFileSync(ASSET_PATH, 'utf8')
const parsed = parseLegalRuleSet(yamlText, ASSET_PATH)
const rules = parsed.ruleSet?.rules ?? []
const ruleById = new Map(rules.map(rule => [rule.id, rule]))

/** 为每条规则构造一个能触发其失败发现的输入。 */
function failingInputFor(rule: LegalEvidenceRule): LegalEvidenceInput {
  const base: LegalEvidenceInput = { evidenceId: `rt-${rule.id}`, evidenceType: baseTypeFor(rule) }
  switch (rule.id) {
    case 'LEGAL-EVI-GEN-001':
      return { ...base, factToProve: '' }
    case 'LEGAL-EVI-GEN-002':
      return { ...base, collectionLegal: false }
    case 'LEGAL-EVI-001':
      return { ...base, hasOriginal: false }
    case 'LEGAL-EVI-002':
      return { ...base, signatureVerified: false }
    case 'LEGAL-EVI-003':
      return { ...base, formationTimeClear: false }
    case 'LEGAL-EVI-004':
      return { ...base, storageIntegrityVerified: false }
    case 'LEGAL-EVI-005':
      return { ...base, contentHash: '' }
    case 'LEGAL-EVI-006':
      return { ...base, timestamp: '' }
    case 'LEGAL-EVI-007':
      return { ...base, witnessHasConflict: true, conflictDisclosed: false }
    case 'LEGAL-EVI-008':
      return { ...base, corroborated: false }
    case 'LEGAL-EVI-009':
      return { ...base, expertQualified: false }
    case 'LEGAL-EVI-010':
      return { ...base, expertProcedureLegal: false }
    case 'LEGAL-EVI-011':
      return { ...base, expertConclusionClear: false }
    case 'LEGAL-EVI-012':
      return { ...base, corroborated: false }
    case 'LEGAL-EVI-013':
      return { ...base, hasOriginal: false }
    case 'LEGAL-EVI-014':
      return { ...base, contentHash: '' }
    case 'LEGAL-EVI-015':
      return { ...base, inspectionHasWitness: false }
    case 'LEGAL-EVI-016':
      return { ...base, inspectionRecordComplete: false }
    default:
      return base
  }
}

/** 通用规则用 documentary 作为载体；其余用规则自身的 evidenceType。 */
function baseTypeFor(rule: LegalEvidenceRule): LegalEvidenceType {
  return rule.evidenceType === 'general' ? 'documentary' : rule.evidenceType
}

describe('legal-evidence rule table', () => {
  it('parses the shipped asset without fatal errors', () => {
    expect(parsed.ruleSet).not.toBeNull()
    expect(parsed.warnings).toHaveLength(0)
    expect(rules.length).toBeGreaterThan(0)
  })

  it('declares only known evidence types or general', () => {
    for (const rule of rules) {
      if (rule.evidenceType === 'general') continue
      expect(LEGAL_EVIDENCE_TYPES).toContain(rule.evidenceType)
    }
  })

  it('uses unique rule ids', () => {
    const ids = rules.map(rule => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches shipped weights to the engine defaults', () => {
    expect(parsed.ruleSet?.weights).toEqual({ relevance: 0.35, legality: 0.3, authenticity: 0.35 })
  })

  it.each(rules)('produces a failure finding for rule $id with declared severity', (rule) => {
    const engine = new LegalEvidenceEngine(yamlText, ASSET_PATH)
    const result = engine.assess(failingInputFor(rule))
    const finding = result.findings.find(f => f.ruleId === rule.id)
    expect(finding, `expected finding for ${rule.id}`).toBeDefined()
    expect(finding!.passed).toBe(false)
    expect(finding!.severity).toBe(rule.severity)
  })

  it('emits no orphan rule ids (every finding id exists in the YAML)', () => {
    const engine = new LegalEvidenceEngine(yamlText, ASSET_PATH)
    const emitted = new Set<string>()
    for (const evidenceType of LEGAL_EVIDENCE_TYPES) {
      const findings = engine.assess(maximallyFailing(evidenceType)).findings
      for (const finding of findings) emitted.add(finding.ruleId)
    }
    for (const ruleId of emitted) {
      expect(ruleById.has(ruleId), `orphan rule id ${ruleId} not declared in YAML`).toBe(true)
    }
  })

  it('declares every rule id that the engine can emit (no unimplemented declarations)', () => {
    const engine = new LegalEvidenceEngine(yamlText, ASSET_PATH)
    const emitted = new Set<string>()
    for (const evidenceType of LEGAL_EVIDENCE_TYPES) {
      const findings = engine.assess(maximallyFailing(evidenceType)).findings
      for (const finding of findings) emitted.add(finding.ruleId)
    }
    for (const rule of rules) {
      expect(emitted.has(rule.id), `rule ${rule.id} declared in YAML but never emitted`).toBe(true)
    }
  })
})

/** 构造一个会触发该类型全部失败发现的输入。 */
function maximallyFailing(evidenceType: LegalEvidenceType): LegalEvidenceInput {
  const base: LegalEvidenceInput = { evidenceId: `max-${evidenceType}`, evidenceType }
  switch (evidenceType) {
    case 'documentary':
      return { ...base, hasOriginal: false, signatureVerified: false, formationTimeClear: false }
    case 'electronic':
      return { ...base, storageIntegrityVerified: false, contentHash: '', timestamp: '' }
    case 'witness_testimony':
      return { ...base, witnessHasConflict: true, conflictDisclosed: false, corroborated: false }
    case 'expert_opinion':
      return { ...base, expertQualified: false, expertProcedureLegal: false, expertConclusionClear: false }
    case 'party_statement':
      return { ...base, corroborated: false }
    case 'physical':
      return { ...base, hasOriginal: false }
    case 'audio_visual':
      return { ...base, contentHash: '' }
    case 'inspection_record':
      return { ...base, inspectionHasWitness: false, inspectionRecordComplete: false }
  }
}
