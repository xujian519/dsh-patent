import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  EVIDENCE_COMPLIANCE_TOOL,
  createEvidenceComplianceGuards,
  evi011GuardConditionFields,
  patentAssetDir,
} from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

function exec(name: string, args: unknown): ToolExecution {
  return { callId: ToolCallId('c'), name, arguments: args, signal } as unknown as ToolExecution
}

function evidenceTool() {
  return defineContentToolFixture({
    name: EVIDENCE_COMPLIANCE_TOOL,
    description: 'evaluate evidence',
    parameters: {},
    async execute(): Promise<Array<{ type: 'text'; text: string }>> { return [{ type: 'text', text: 'ok' }] },
  })
}

describe('EVI-011 evidence-compliance guards', () => {
  it('derives condition fields from the packaged evidence-rules.yaml', () => {
    const conditions = evi011GuardConditionFields([patentAssetDir()])
    expect([...conditions].sort()).toEqual(['legalized', 'notarized', 'translated'])
  })

  it('falls back to the hardcoded condition fields when assets are missing', () => {
    const conditions = evi011GuardConditionFields([])
    expect([...conditions].sort()).toEqual(['legalized', 'notarized', 'translated'])
  })

  it('ignores EVI-011 conditions outside the guard field mapping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-rule-'))
    const patentDir = join(dir, 'patent')
    mkdirSync(patentDir)
    writeFileSync(
      join(patentDir, 'evidence-rules.yaml'),
      [
        'rules:',
        '  - ruleId: EVI-011',
        '    name: 域外证据审查规则',
        '    evidenceType: overseas',
        '    check:',
        '      type: overseas',
        '      conditions:',
        '        - evidence_notarized',
        '        - evidence_custom_unknown',
      ].join('\n'),
      'utf8',
    )
    try {
      const conditions = evi011GuardConditionFields([patentDir])
      expect([...conditions]).toEqual(['notarized'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('abstains on non-matching tools and non-object arguments', () => {
    const [notarizationGuard] = createEvidenceComplianceGuards([])
    expect(notarizationGuard!(exec('other_tool', {}))).toBeUndefined()
    expect(notarizationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, null))).toBeUndefined()
  })

  it('denies overseas evidence missing notarization/legalization', () => {
    const [notarizationGuard] = createEvidenceComplianceGuards([])
    const denial = notarizationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', notarized: false, legalized: false }))
    expect(denial).toMatch(/EVI-011-notarization/)
    expect(notarizationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', notarized: true, legalized: true }))).toBeUndefined()
  })

  it('denies foreign-language evidence missing a translation', () => {
    const [, translationGuard] = createEvidenceComplianceGuards([])
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, null))).toBeUndefined()
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'foreign_language', translated: false }))).toMatch(/EVI-011-translation/)
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'foreign_language', translated: true }))).toBeUndefined()
    // 域外（overseas）是来源地分类而非语言分类：未声明语言或声明中文时不要求译本。
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', translated: false }))).toBeUndefined()
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', language: '中文', translated: false }))).toBeUndefined()
    // 域外 + 外文：语言字段让两道 EVI-011 守卫同时生效。
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', language: 'en', translated: false })))
      .toMatch(/EVI-011-translation/)
    expect(translationGuard!(exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', language: 'ja', translated: true })))
      .toBeUndefined()
  })

  it('is monotonic deny: a pre-execute allow cannot override it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(evidenceTool())
    for (const guard of createEvidenceComplianceGuards([patentAssetDir()])) {
      ctx.tools.guard(guard)
    }
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })

    const result = await executeToolFixture(ctx, exec(EVIDENCE_COMPLIANCE_TOOL, { evidenceType: 'overseas', notarized: false, legalized: false }))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/EVI-011-notarization/)
  })
})
