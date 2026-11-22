import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LegalEvidenceEngine } from '../src/engine.ts'
import { createEvaluateLegalEvidenceTool, type EvaluateLegalEvidenceOutput } from '../src/tool/evaluate-evidence.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

async function host(engine?: LegalEvidenceEngine): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createEvaluateLegalEvidenceTool(engine ?? new LegalEvidenceEngine()))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('evaluate-legal-evidence'),
    name: 'evaluate_legal_evidence',
    arguments: args,
  })
}

async function run(ctx: Context, args: unknown): Promise<EvaluateLegalEvidenceOutput> {
  const result = await execute(ctx, args)
  expect(result.isError).toBe(false)
  return result.value as EvaluateLegalEvidenceOutput
}

describe('evaluate_legal_evidence tool', () => {
  it('assesses documentary evidence and returns scores', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'doc-1',
      evidenceType: 'documentary',
      source: '合同原件',
      content: '销售合同',
      factToProve: '合同关系存在',
      hasOriginal: true,
      signatureVerified: true,
      formationTimeClear: true,
      collectionLegal: true,
    })

    expect(output.assessment.evidenceId).toBe('doc-1')
    expect(output.assessment.evidenceType).toBe('documentary')
    expect(output.assessment.score.relevance).toBeGreaterThan(0)
    expect(output.assessment.score.legality).toBeGreaterThan(0)
    expect(output.assessment.score.authenticity).toBeGreaterThan(0)
    expect(output.assessment.score.overall).toBeGreaterThan(0)
    expect(output.summary).toContain('doc-1')
  })

  it('assesses electronic evidence with hash verification', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'elec-1',
      evidenceType: 'electronic',
      source: '微信聊天记录',
      contentHash: 'sha256:abc123',
      hashVerified: true,
      timestamp: '2024-01-15T10:30:00Z',
      storageIntegrityVerified: true,
    })

    expect(output.assessment.evidenceType).toBe('electronic')
    expect(output.assessment.score.authenticity).toBeGreaterThan(0.5)
    expect(output.assessment.findings.some(f => f.ruleId === 'LEGAL-EVI-004' && f.passed)).toBe(true)
  })

  it('assesses witness testimony with conflict check', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'witness-1',
      evidenceType: 'witness_testimony',
      source: '证人李某',
      witnessHasConflict: false,
      corroborated: true,
    })

    expect(output.assessment.evidenceType).toBe('witness_testimony')
    expect(output.assessment.findings.some(f => f.ruleId === 'LEGAL-EVI-007' && f.passed)).toBe(true)
  })

  it('reports an unknown witness conflict as unassessed rather than a critical problem', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'witness-unknown',
      evidenceType: 'witness_testimony',
      source: '证人王某',
      factToProve: '合同签订时间',
      collectionLegal: true,
      corroborated: true,
    })

    expect(output.assessment.findings.find(f => f.ruleId === 'LEGAL-EVI-007')).toMatchObject({
      passed: false,
      notAssessed: true,
    })
    expect(output.summary).toContain('未评估 1 项')
    expect(output.summary).not.toContain('严重问题')
  })

  it('assesses expert opinion with qualification check', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'expert-1',
      evidenceType: 'expert_opinion',
      source: '司法鉴定中心',
      expertQualified: true,
      expertProcedureLegal: true,
      expertConclusionClear: true,
    })

    expect(output.assessment.evidenceType).toBe('expert_opinion')
    expect(output.assessment.score.legality).toBeGreaterThan(0.5)
    expect(output.assessment.findings.some(f => f.ruleId === 'LEGAL-EVI-009' && f.passed)).toBe(true)
  })

  it('reports critical findings when required attributes are missing', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'doc-missing',
      evidenceType: 'documentary',
      hasOriginal: false,
    })

    expect(output.assessment.findings.some(f => f.ruleId === 'LEGAL-EVI-001' && !f.passed && f.severity === 'critical')).toBe(true)
  })

  it('throws on missing evidence id', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      evidenceType: 'documentary',
    })

    expect(result.isError).toBe(true)
  })

  it('marks the identifying pair required in the parameter schema', async () => {
    const ctx = await host()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'evaluate_legal_evidence')
    expect(schema?.parameters.required).toEqual(['evidenceId', 'evidenceType'])
  })

  it('rejects a blank evidence id', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      evidenceId: '   ',
      evidenceType: 'documentary',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'EvaluateLegalEvidenceToolError', code: 'no_evidence_id' })
  })

  it('throws on invalid evidence type', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      evidenceId: 'test-1',
      evidenceType: 'invalid_type',
    })

    expect(result.isError).toBe(true)
  })

  it('includes burden holder and standard in output', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'doc-2',
      evidenceType: 'documentary',
      burdenHolder: 'plaintiff',
      standard: 'preponderance',
    })

    expect(output.assessment.burdenHolder).toBe('plaintiff')
    expect(output.assessment.standard).toBe('preponderance')
  })

  it('renders a human-readable summary', async () => {
    const ctx = await host()
    const output = await run(ctx, {
      evidenceId: 'doc-3',
      evidenceType: 'documentary',
      source: '合同',
      content: '合同内容',
      factToProve: '待证事实',
    })

    expect(output.summary).toContain('doc-3')
    expect(output.summary).toContain('documentary')
    expect(output.summary).toContain('关联性')
    expect(output.summary).toContain('合法性')
    expect(output.summary).toContain('真实性')
  })
})
