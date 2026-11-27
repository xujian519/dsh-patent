import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {  defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { contentHash, validateSpecDraft, type SpecDraft } from '@deepseek-ai/dsh-patent-core'
import { filingTextsFromDraft } from '@deepseek-ai/dsh-patent-filing'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
// 新 digest 观测的渲染函数不从插件入口导出（package-surface 规则），测试直接读模块。
import { renderDeliveryDigestObservation } from '../src/runtime/delivery-gate.ts'

const signal = new AbortController().signal

/** 最小可校验 claims-spec 草案（无附图形态）。 */
function specDraft(overrides: Partial<SpecDraft> = {}): SpecDraft {
  return {
    meta: {
      caseNumber: 'CN2026-0001',
      title: '一种智能保温杯',
      applicant: '示例科技有限公司',
      inventor: '张三',
      agent: 'XX 知识产权代理事务所',
      date: '2026-10-09',
    },
    claims: ['一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。'],
    abstract: ['本发明公开一种智能保温杯，主要用途是恒温饮水。'],
    figureFiles: [],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于日用品技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温。' }],
      summary: [{ kind: 'paragraph', text: '本发明提供一种智能保温杯。' }],
      drawingDescriptions: [],
      embodiment: [{ kind: 'paragraph', text: '下面结合附图对本发明作进一步说明。' }],
    },
    ...overrides,
  }
}

/** 一份草案的四个投影 digest，与门禁内部的投影计算同源。 */
function projectionDigests(draft: SpecDraft): Record<'text' | 'claims' | 'abstract' | 'title', string> {
  const texts = filingTextsFromDraft(validateSpecDraft(draft))
  return {
    text: contentHash(texts.text),
    claims: contentHash(texts.claims),
    abstract: contentHash(texts.abstract),
    title: contentHash(texts.title),
  }
}

/** 只改权利要求一个字符的草案：claims 投影变，text/abstract 投影不变。 */
function changedClaimsDraft(): SpecDraft {
  return specDraft({ claims: ['一种智能保温杯，其特征在于，包括杯体、温度显示模块、加热单元和密封圈。'] })
}

/** The agent surface a tool call carries. */
type ToolAgent = NonNullable<ToolExecutionInput['agent']>

/**
 * A call's owning agent. The gate attributes a call by the agent object's
 * identity, and the tool runtime hands it only to `scopeTarget`, which reads no
 * field, so this fixture carries the identity and asserts the live-Agent surface
 * it does not exercise.
 * @param id - session id the call is attributed to.
 * @returns the agent value a tool call carries.
 */
function fakeAgent(id: string): ToolAgent {
  return { id: SessionId(id) } as ToolAgent
}

/** Two callers: the ledger groups by it, so one never satisfies the other. */
const AGENT = fakeAgent('session-delivery-gate')
const OTHER_AGENT = fakeAgent('session-other')

let callSeq = 0

function okTool(name: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'ok' }] },
  })
}

function failingTool(name: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { throw new Error(`${name} 执行失败`) },
  })
}

function documentTool() {
  return defineContentToolFixture({
    name: 'render_patent_document',
    description: 'render',
    parameters: { template: { type: 'string' } },
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'HTML written: out.html' }] },
  })
}

/** A prerequisite whose canonical result is the given JSON value. */
function resultTool(name: string, value: JsonValue) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: `${name} result` }],
    },
    execute: () => Promise.resolve(value),
  })
}

function call(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent?: ToolAgent,
) {
  callSeq += 1
  return executeToolFixture(ctx, {
    name,
    callId: ToolCallId(`delivery-${callSeq}`),
    arguments: args,
    signal,
    ...(agent === undefined ? {} : { agent }),
  })
}

describe('args-match', () => {
  it('把对象收窄为字符串记录，数组与非记录返回 null', () => {
    expect(PatentRule.jsonRecord({ template: 'claims-spec' })).toEqual({ template: 'claims-spec' })
    expect(PatentRule.jsonRecord(['claims-spec'])).toBeNull()
    expect(PatentRule.jsonRecord(null)).toBeNull()
    expect(PatentRule.jsonRecord('claims-spec')).toBeNull()
  })

  it('未声明约束时恒适用；入参不是记录时不适用', () => {
    expect(PatentRule.declaredArgsMatch(undefined, { template: 'claims-spec' })).toBe(true)
    expect(PatentRule.declaredArgsMatch({ template: 'claims-spec' }, 'claims-spec')).toBe(false)
  })

  it('字符串为精确匹配，字符串数组为取值集合', () => {
    const args = { template: 'claims-spec' }
    expect(PatentRule.declaredArgsMatch({ template: 'claims-spec' }, args)).toBe(true)
    expect(PatentRule.declaredArgsMatch({ template: 'oa-response' }, args)).toBe(false)
    expect(PatentRule.declaredArgsMatch({ template: ['oa-response', 'claims-spec'] }, args)).toBe(true)
    expect(PatentRule.declaredArgsMatch({ template: ['oa-response'] }, args)).toBe(false)
    // 取值集合只认字符串：实际入参不是字符串时集合不命中。
    expect(PatentRule.declaredArgsMatch({ template: ['claims-spec'] }, { template: 7 })).toBe(false)
  })
})

describe('resolveDeliveryGate', () => {
  it('空声明告警并剔除，其余按声明顺序保留', () => {
    const plan = PatentRule.resolveDeliveryGate([
      { tool: 'draft_claims', requires: [] },
      { tool: 'render_patent_document', requires: ['rule_check'] },
    ])
    expect(plan.entries.map(entry => entry.tool)).toEqual(['render_patent_document'])
    expect(plan.warnings).toEqual(['交付前置门禁 draft_claims: 未声明任何前置调用，该条不生效'])
  })

  it('rejects evidence declared for a tool the entry does not require', () => {
    expect(() => PatentRule.resolveDeliveryGate([{
      tool: 'render_patent_document',
      requires: ['rule_check'],
      evidence: { law_verify: [{ field: 'findings', minItems: 1 }] },
    }])).toThrow(/evidence.*requires.*law_verify/)
  })

  it('rejects a matchesDraftTexts projection the draft does not have', () => {
    expect(() => PatentRule.resolveDeliveryGate([{
      tool: 'render_patent_document',
      requires: ['rule_check'],
      evidence: { rule_check: [{ field: 'evaluated', matchesDraftTexts: ['body'] }] },
    }])).toThrow(/matchesDraftTexts.*未知投影 body/)
  })

  it('collects every declared field across entries that share a prerequisite', () => {
    const plan = PatentRule.resolveDeliveryGate([
      { tool: 'render_patent_document', requires: ['rule_check'], evidence: { rule_check: [{ field: 'evaluated', minItems: 1 }] } },
      { tool: 'build_patent_filing', requires: ['rule_check'], evidence: { rule_check: [{ field: 'scope', equals: 'patent' }] } },
    ])
    expect(plan.evidenceFields.get('rule_check')).toEqual(new Set(['evaluated', 'scope']))
  })
})

describe('DeliveryAttemptLedger', () => {
  it('按归属单位分组：只认已登记的调用，别的会话不顶替', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    expect(ledger.has(AGENT, 'rule_check')).toBe(false)
    ledger.record(AGENT, 'rule_check')
    ledger.record(AGENT, 'law_verify')
    expect(ledger.has(AGENT, 'rule_check')).toBe(true)
    expect(ledger.has(AGENT, 'law_verify')).toBe(true)
    expect(ledger.has(OTHER_AGENT, 'rule_check')).toBe(false)
  })

  it('把声明了案卷键的前置记录限定在该案卷内', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', 'case-A')
    expect(ledger.has(AGENT, 'rule_check', 'case-A')).toBe(true)
    expect(ledger.has(AGENT, 'rule_check', 'case-B')).toBe(false)
    // 未声明案卷的查询无法区分案卷，采用本会话内任一条记录。
    expect(ledger.has(AGENT, 'rule_check')).toBe(true)
  })

  it('案卷没有专属记录时回退到会话级记录', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check')
    expect(ledger.has(AGENT, 'rule_check', 'case-A')).toBe(true)
    ledger.record(AGENT, 'law_verify', 'case-B')
    expect(ledger.has(AGENT, 'law_verify', 'case-A')).toBe(false)
  })

  it('records result evidence and reports which condition a call failed', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    const findings = [{ field: 'findings', minItems: 1 }] as const
    ledger.record(AGENT, 'law_verify', undefined, { findings: [] })
    expect(ledger.evidenceFailure(AGENT, 'law_verify', undefined, findings)).toContain('findings')
    // A later record that carries the evidence satisfies the same prerequisite.
    ledger.record(AGENT, 'law_verify', undefined, { findings: [{ raw: '专利法第22条' }] })
    expect(ledger.evidenceFailure(AGENT, 'law_verify', undefined, findings)).toBeUndefined()
  })
})

describe('caseKeyOfArguments', () => {
  it('reads the case id from the documented argument names', () => {
    expect(PatentRule.caseKeyOfArguments({ caseId: ' A ' })).toBe('A')
    expect(PatentRule.caseKeyOfArguments({ case_id: 'B' })).toBe('B')
    expect(PatentRule.caseKeyOfArguments({ case_dir: '/cases/C' })).toBe('/cases/C')
    expect(PatentRule.caseKeyOfArguments({ caseDir: 'D' })).toBe('D')
    expect(PatentRule.caseKeyOfArguments({ template: 'claims-spec' })).toBeUndefined()
    expect(PatentRule.caseKeyOfArguments(null)).toBeUndefined()
  })
})

describe('deliveryGateMissing', () => {
  const plan = PatentRule.resolveDeliveryGate([
    { tool: 'render_patent_document', requires: ['rule_check', 'law_verify'] },
    { tool: 'render_patent_document', requires: ['law_verify', 'patent_workflow_run'] },
    { tool: 'render_patent_document', requires: ['patent_fees'], whenArgs: { template: 'claims-spec' } },
    { tool: 'draft_specification', requires: ['patent_fees'] },
  ])

  it('按声明顺序去重，跨条目重复的前置只报一次', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check')
    expect(PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'render_patent_document', { template: 'oa-response' }))
      .toEqual(['law_verify', 'patent_workflow_run'])
  })

  it('whenArgs 命中时才追加该条的前置', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check')
    expect(PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'render_patent_document', { template: 'claims-spec' }))
      .toEqual(['law_verify', 'patent_workflow_run', 'patent_fees'])
  })

  it('未声明门禁的工具没有缺口', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    expect(PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'validate_specification', {})).toEqual([])
  })

  it('归属不明时按全部未满足处理', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    expect(PatentRule.deliveryGateMissing(plan, ledger, undefined, 'render_patent_document', { template: 'oa-response' }))
      .toEqual(['rule_check', 'law_verify', 'patent_workflow_run'])
  })
})

describe('deliveryEvidence', () => {
  it('extracts only the declared fields from a record result', () => {
    expect(PatentRule.deliveryEvidence({ evaluated: [], manifestId: 'm' }, new Set(['evaluated'])))
      .toEqual({ evaluated: [] })
    expect(PatentRule.deliveryEvidence({ manifestId: 'm' }, new Set(['evaluated']))).toEqual({})
    expect(PatentRule.deliveryEvidence({ manifestId: 'm' }, undefined)).toBeUndefined()
    expect(PatentRule.deliveryEvidence({ manifestId: 'm' }, new Set())).toBeUndefined()
    expect(PatentRule.deliveryEvidence('m', new Set(['manifestId']))).toEqual({})
  })
})

describe('evidence matching', () => {
  it('matches exact strings, booleans, value sets, and minimum array lengths', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'probe', undefined, { manifestId: 'patent_oa_response_v1', ok: true, findings: [{}], scope: 'patent' })

    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [])).toBeUndefined()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'manifestId', equals: 'patent_oa_response_v1' }]))
      .toBeUndefined()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'manifestId', equals: ['other', 'patent_oa_response_v1'] }]))
      .toBeUndefined()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'ok', equals: true }])).toBeUndefined()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'findings', minItems: 1 }])).toBeUndefined()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'scope' }])).toBeUndefined()

    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'manifestId', equals: 'other' }]))
      .toContain('manifestId')
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'manifestId', equals: ['other'] }]))
      .toContain('manifestId')
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'ok', equals: false }])).toContain('ok')
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'findings', minItems: 2 }]))
      .toContain('不足 2 项')
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'absent' }]))
      .toContain('未携带 absent')
    // A minimum length on a non-array field, and a value set on a non-string field, fail.
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'manifestId', minItems: 1 }]))
      .toContain('不足 1 项')
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'ok', equals: ['true'] }]))
      .toContain('ok')
  })

  it('requires one record to satisfy every condition', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'probe', undefined, { ok: true, manifestId: 'patent_disclosure_v1' })
    ledger.record(AGENT, 'probe', undefined, { ok: false, manifestId: 'patent_oa_response_v1' })
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [
      { field: 'ok', equals: true },
      { field: 'manifestId', equals: 'patent_oa_response_v1' },
    ])).toBeDefined()
  })

  it('reports a missing field when the prerequisite has no record at all', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, [{ field: 'evaluated', minItems: 1 }]))
      .toContain('未携带 evaluated')
  })

  it('shadow 下没有满足非 digest 条件的记录时仍拒绝，不上报 digest 不符', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    const onMismatch = vi.fn()
    ledger.record(AGENT, 'probe', undefined, { evaluated: [] })
    const failure = ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text'] }],
      { mode: 'shadow', expected: new Map([['text', 'sha256:want']]), onMismatch },
    )
    expect(failure).toContain('不足 1 项')
    expect(onMismatch).not.toHaveBeenCalled()
  })

  it('digest 字段不是数组时按无 digest 观测，不抛异常', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    const onMismatch = vi.fn()
    ledger.record(AGENT, 'probe', undefined, { evaluated: 'sha256:old' })
    expect(ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      [{ field: 'evaluated', matchesDraftTexts: ['text'] }],
      { mode: 'shadow', expected: new Map([['text', 'sha256:want']]), onMismatch },
    )).toBeUndefined()
    expect(onMismatch).toHaveBeenCalledWith({
      projections: ['text'],
      expected: { text: 'sha256:want' },
      actual: [],
    })
  })

  it('digest 条目跳过非记录与 digest 非字符串的项', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'probe', undefined, {
      evaluated: [null, { field: 'text' }, { digest: 7 }, { digest: 'sha256:want' }],
    })
    expect(ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      [{ field: 'evaluated', matchesDraftTexts: ['text'] }],
      { expected: new Map([['text', 'sha256:want']]) },
    )).toBeUndefined()
  })

  it('shadow 观测省略 expected 中未提供的投影 digest', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    const onMismatch = vi.fn()
    ledger.record(AGENT, 'probe', undefined, { evaluated: [] })
    expect(ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      [{ field: 'evaluated', matchesDraftTexts: ['text'] }],
      { mode: 'shadow', expected: new Map(), onMismatch },
    )).toBeUndefined()
    expect(onMismatch).toHaveBeenCalledWith({ projections: ['text'], expected: {}, actual: [] })
  })

  it('digest 条件在缺定期望或已匹配时不算失败', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'probe', undefined, { ok: false, evaluated: [{ digest: 'sha256:want' }] })
    const requirements = [
      { field: 'evaluated', matchesDraftTexts: ['text'] },
      { field: 'ok', equals: true },
    ]
    expect(ledger.evidenceFailure(AGENT, 'probe', undefined, requirements)).toContain('ok')
    expect(ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      requirements,
      { expected: new Map([['text', 'sha256:want']]) },
    )).toContain('ok')
  })

  it('shadow 观测混合条件时只收集声明了 digest 的前置条件', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    const onMismatch = vi.fn()
    ledger.record(AGENT, 'probe', undefined, { ok: true, evaluated: [{ digest: 'sha256:old' }] })
    expect(ledger.evidenceFailure(
      AGENT,
      'probe',
      undefined,
      [
        { field: 'ok', equals: true },
        { field: 'evaluated', matchesDraftTexts: ['text'] },
      ],
      { mode: 'shadow', expected: new Map([['text', 'sha256:want']]), onMismatch },
    )).toBeUndefined()
    expect(onMismatch).toHaveBeenCalledWith({
      projections: ['text'],
      expected: { text: 'sha256:want' },
      actual: ['sha256:old'],
    })
  })
})

describe('deliveryGateMissing digest 核对', () => {
  const plan = PatentRule.resolveDeliveryGate([
    {
      tool: 'build_patent_filing',
      requires: ['rule_check', 'validate_specification'],
      evidence: {
        rule_check: [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text'] }],
        validate_specification: [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text', 'claims', 'abstract'] }],
      },
    },
  ])

  /** 台账：rule_check 与 validate_specification 都读过 `draft` 的规范文本。 */
  function ledgerWith(draft: SpecDraft): PatentRule.DeliveryAttemptLedger {
    const digests = projectionDigests(draft)
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 120, digest: digests.text }] })
    ledger.record(AGENT, 'validate_specification', undefined, {
      evaluated: [
        { field: 'text', chars: 120, digest: digests.text },
        { field: 'claims', chars: 60, digest: digests.claims },
        { field: 'abstract', chars: 30, digest: digests.abstract },
      ],
    })
    return ledger
  }

  it('同一 draft：前置检查读过的文本与交付文本一致，放行', () => {
    const draft = specDraft()
    expect(PatentRule.deliveryGateMissing(plan, ledgerWith(draft), AGENT, 'build_patent_filing', { draft })).toEqual([])
  })

  it('只改权利要求一个字符：rule_check 核的 text 投影不受影响，validate_specification 的 claims 投影不符', () => {
    const draft = changedClaimsDraft()
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', { draft })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatch(/^validate_specification（/)
    expect(missing[0]).toContain('claims 投影不一致')
    expect(missing[0]).toContain('用本次 draft 重跑该前置工具后再交付')
  })

  it('改了说明书正文：text 投影变化，两个前置同时不符', () => {
    const draft = specDraft()
    draft.sections.technicalField = [{ kind: 'paragraph', text: '本发明属于智能容器技术领域。' }]
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', { draft })
    expect(missing).toHaveLength(2)
    expect(missing[0]).toMatch(/^rule_check（/)
    expect(missing[1]).toMatch(/^validate_specification（/)
  })

  it('多个投影必须落在同一条前置记录内，跨记录不拼凑', () => {
    const crossRecord = PatentRule.resolveDeliveryGate([
      {
        tool: 'render_patent_document',
        requires: ['rule_check'],
        whenArgs: { template: ['claims-spec'] },
        evidence: { rule_check: [{ field: 'evaluated', matchesDraftTexts: ['claims', 'abstract'] }] },
      },
    ])
    const draft = specDraft()
    const digests = projectionDigests(draft)
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 60, digest: digests.claims }] })
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 30, digest: digests.abstract }] })
    const missing = PatentRule.deliveryGateMissing(crossRecord, ledger, AGENT, 'render_patent_document', { template: 'claims-spec', draft })
    expect(missing).toHaveLength(1)
    // 失败描述按最近一条记录：它只带 abstract 的 digest，缺 claims。
    expect(missing[0]).toContain('claims 投影不一致')

    // 同一条记录带齐两个 digest 即满足。
    const complete = new PatentRule.DeliveryAttemptLedger()
    complete.record(AGENT, 'rule_check', undefined, {
      evaluated: [
        { field: 'text', chars: 60, digest: digests.claims },
        { field: 'title', chars: 30, digest: digests.abstract },
      ],
    })
    expect(PatentRule.deliveryGateMissing(crossRecord, complete, AGENT, 'render_patent_document', { template: 'claims-spec', draft }))
      .toEqual([])
  })

  it('按 digest 值匹配，不看条目 field 名：rule_check 的 text 字段装着权项投影也算数', () => {
    const claimsOnly = PatentRule.resolveDeliveryGate([
      {
        tool: 'render_patent_document',
        requires: ['rule_check'],
        whenArgs: { template: ['claims-spec'] },
        evidence: { rule_check: [{ field: 'evaluated', matchesDraftTexts: ['claims'] }] },
      },
    ])
    const draft = specDraft()
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 60, digest: projectionDigests(draft).claims }] })
    expect(PatentRule.deliveryGateMissing(claimsOnly, ledger, AGENT, 'render_patent_document', { template: 'claims-spec', draft }))
      .toEqual([])
  })

  it('evaluated 缺失或为空时仍按现有证据条件拒绝', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, {})
    ledger.record(AGENT, 'validate_specification', undefined, { evaluated: [] })
    const missing = PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'build_patent_filing', { draft: specDraft() })
    expect(missing).toHaveLength(2)
    expect(missing[0]).toContain('未携带 evaluated')
    expect(missing[1]).toContain('不足 1 项')
  })

  it('草案未通过结构校验：enforce 不拿 digest 拦，成文工具自己报结构错误', () => {
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', { draft: { claims: [] } })
    expect(missing).toEqual([])
  })

  it('shadow：仅 digest 不符时放行并上报观测，观测含投影、期望与实际 digest', () => {
    const observations: PatentRule.DeliveryDigestObservation[] = []
    const draft = changedClaimsDraft()
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', { draft, caseId: 'case-A' }, {
      mode: 'shadow',
      onObservation: observation => observations.push(observation),
    })
    expect(missing).toEqual([])
    expect(observations).toHaveLength(1)
    const mismatch = observations[0]
    expect(mismatch).toMatchObject({
      kind: 'mismatch',
      tool: 'build_patent_filing',
      prerequisite: 'validate_specification',
      caseKey: 'case-A',
    })
    if (mismatch?.kind !== 'mismatch') throw new Error('expected a mismatch observation')
    expect(mismatch.projections).toEqual(['claims'])
    expect(mismatch.expected).toEqual({ claims: projectionDigests(draft).claims })
    expect(mismatch.actual).toContain(projectionDigests(specDraft()).claims)
  })

  it('shadow：草案非法时上报「无法核对」，digest 条件不生效', () => {
    const observations: PatentRule.DeliveryDigestObservation[] = []
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', {
      draft: { claims: [] },
      caseId: 'case-A',
    }, {
      mode: 'shadow',
      onObservation: observation => observations.push(observation),
    })
    expect(missing).toEqual([])
    expect(observations).toEqual([
      { kind: 'unverifiable', tool: 'build_patent_filing', prerequisite: 'rule_check', caseKey: 'case-A' },
      { kind: 'unverifiable', tool: 'build_patent_filing', prerequisite: 'validate_specification', caseKey: 'case-A' },
    ])
  })

  it('shadow：入参不是记录时按无法核对处理', () => {
    const observations: PatentRule.DeliveryDigestObservation[] = []
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', null, {
      mode: 'shadow',
      onObservation: observation => observations.push(observation),
    })
    expect(missing).toEqual([])
    expect(observations).toEqual([
      { kind: 'unverifiable', tool: 'build_patent_filing', prerequisite: 'rule_check' },
      { kind: 'unverifiable', tool: 'build_patent_filing', prerequisite: 'validate_specification' },
    ])
  })

  it('草案校验抛出非校验错误时继续抛出，不静默跳过 digest 核对', () => {
    const draft = specDraft()
    Object.defineProperty(draft, 'claims', {
      get(): never { throw new Error('draft getter failed') },
    })
    expect(() => PatentRule.deliveryGateMissing(
      plan,
      ledgerWith(specDraft()),
      AGENT,
      'build_patent_filing',
      { draft },
      { mode: 'shadow' },
    )).toThrow('draft getter failed')
  })

  it('enforce 不触发观测回调', () => {
    const onObservation = vi.fn()
    const missing = PatentRule.deliveryGateMissing(plan, ledgerWith(specDraft()), AGENT, 'build_patent_filing', { draft: changedClaimsDraft() }, {
      mode: 'enforce',
      onObservation,
    })
    expect(missing).toHaveLength(1)
    expect(onObservation).not.toHaveBeenCalled()
  })

  it('未声明 matchesDraftTexts 的条目不计算投影，也不产生观测', () => {
    const plain = PatentRule.resolveDeliveryGate([
      { tool: 'render_patent_document', requires: ['rule_check'], evidence: { rule_check: [{ field: 'evaluated', minItems: 1 }] } },
    ])
    const onObservation = vi.fn()
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 10, digest: 'sha256:x' }] })
    expect(PatentRule.deliveryGateMissing(plain, ledger, AGENT, 'render_patent_document', { draft: { claims: [] } }, {
      mode: 'shadow',
      onObservation,
    })).toEqual([])
    expect(onObservation).not.toHaveBeenCalled()
  })
})

describe('renderDeliveryDigestObservation', () => {
  it('mismatch 观测点名工具、投影与期望/实际 digest', () => {
    const text = renderDeliveryDigestObservation({
      kind: 'mismatch',
      tool: 'build_patent_filing',
      prerequisite: 'validate_specification',
      caseKey: 'case-A',
      projections: ['claims'],
      expected: { claims: 'sha256:new' },
      actual: ['sha256:old'],
    })
    expect(text).toContain('案卷 case-A')
    expect(text).toContain('build_patent_filing')
    expect(text).toContain('validate_specification')
    expect(text).toContain('claims')
    expect(text).toContain('sha256:new')
    expect(text).toContain('sha256:old')

    const empty = renderDeliveryDigestObservation({
      kind: 'mismatch',
      tool: 'build_patent_filing',
      prerequisite: 'validate_specification',
      projections: ['claims'],
      expected: { claims: 'sha256:new' },
      actual: [],
    })
    expect(empty).toContain('实际 （无 digest 条目）')
  })

  it('unverifiable 观测说明无法核对且按放行处理', () => {
    const text = renderDeliveryDigestObservation({
      kind: 'unverifiable',
      tool: 'build_patent_filing',
      prerequisite: 'rule_check',
    })
    expect(text).toContain('无法核对')
    expect(text).toContain('rule_check')
  })
})

describe('delivery evidence', () => {
  const plan = PatentRule.resolveDeliveryGate([
    {
      tool: 'render_patent_document',
      requires: ['rule_check', 'law_verify'],
      evidence: {
        rule_check: [{ field: 'evaluated', minItems: 1 }],
        law_verify: [{ field: 'findings', minItems: 1 }],
      },
    },
    {
      tool: 'render_patent_document',
      requires: ['patent_workflow_run'],
      whenArgs: { template: 'oa-response' },
      evidence: {
        patent_workflow_run: [
          { field: 'ok', equals: true },
          { field: 'manifestId', equals: 'patent_oa_response_v1' },
        ],
      },
    },
  ])

  it('a successful call with an empty evaluated list or findings does not satisfy the gate', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [] })
    ledger.record(AGENT, 'law_verify', undefined, { findings: [] })
    ledger.record(AGENT, 'patent_workflow_run', undefined, { ok: true, manifestId: 'patent_disclosure_v1' })

    const missing = PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'render_patent_document', { template: 'oa-response' })
    expect(missing).toHaveLength(3)
    expect(missing[0]).toMatch(/^rule_check（/)
    expect(missing[1]).toMatch(/^law_verify（/)
    expect(missing[2]).toMatch(/^patent_workflow_run（/)
  })

  it('a failed manifest run does not satisfy the closure gate', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 120, digest: 'd' }] })
    ledger.record(AGENT, 'law_verify', undefined, { findings: [{ raw: '专利法第22条第3款' }] })
    ledger.record(AGENT, 'patent_workflow_run', undefined, { ok: false, manifestId: 'patent_oa_response_v1' })

    const missing = PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'render_patent_document', { template: 'oa-response' })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatch(/^patent_workflow_run（/)
  })

  it('accepts only the manifest the template requires', () => {
    const ledger = new PatentRule.DeliveryAttemptLedger()
    ledger.record(AGENT, 'rule_check', undefined, { evaluated: [{ field: 'text', chars: 120, digest: 'd' }] })
    ledger.record(AGENT, 'law_verify', undefined, { findings: [{ raw: '专利法第22条第3款' }] })
    ledger.record(AGENT, 'patent_workflow_run', undefined, { ok: true, manifestId: 'patent_oa_response_v1' })

    expect(PatentRule.deliveryGateMissing(plan, ledger, AGENT, 'render_patent_document', { template: 'oa-response' }))
      .toEqual([])
  })
})

describe('renderDeliveryGateDenial', () => {
  it('点名缺失的前置调用，并说明补哪一步', () => {
    const text = PatentRule.renderDeliveryGateDenial('render_patent_document', ['rule_check', 'law_verify'])
    expect(text).toContain('交付前置门禁拒绝 render_patent_document')
    expect(text).toContain('rule_check、law_verify')
    expect(text).toContain('再重新调用该工具')
  })
})

describe('Config.deliveryGate', () => {
  it('接受部署声明的形态：字符串数组 whenArgs 与并列多条', () => {
    const parsed = PatentRule.Config({
      deliveryGate: [
        { tool: 'render_patent_document', requires: ['rule_check', 'law_verify'] },
        {
          tool: 'render_patent_document',
          requires: ['patent_workflow_run'],
          whenArgs: { template: ['patentability-opinion', 'search-report'] },
        },
      ],
    })
    expect(parsed.deliveryGate).toEqual([
      { tool: 'render_patent_document', requires: ['rule_check', 'law_verify'], whenArgs: {}, evidence: {} },
      {
        tool: 'render_patent_document',
        requires: ['patent_workflow_run'],
        whenArgs: { template: ['patentability-opinion', 'search-report'] },
        evidence: {},
      },
    ])
  })

  it('accepts result evidence declared for a required prerequisite', () => {
    const parsed = PatentRule.Config({
      deliveryGate: [{
        tool: 'render_patent_document',
        requires: ['patent_workflow_run'],
        whenArgs: { template: 'oa-response' },
        evidence: {
          patent_workflow_run: [
            { field: 'ok', equals: true },
            { field: 'manifestId', equals: 'patent_oa_response_v1' },
          ],
        },
      }],
    })
    expect(parsed.deliveryGate?.[0]?.evidence).toEqual({
      patent_workflow_run: [
        // Config 解析给未声明的数组补 []：matchesDraftTexts 空数组与未声明同义。
        { field: 'ok', equals: true, matchesDraftTexts: [] },
        { field: 'manifestId', equals: 'patent_oa_response_v1', matchesDraftTexts: [] },
      ],
    })
  })

  it('未声明时门禁缺省为空（opt-in）', () => {
    expect(PatentRule.Config({}).deliveryGate).toEqual([])
  })

  it('接受 matchesDraftTexts 证据与 digest 模式，模式缺省 enforce', () => {
    const parsed = PatentRule.Config({
      deliveryGateDigestMode: 'shadow',
      deliveryGate: [{
        tool: 'build_patent_filing',
        requires: ['rule_check'],
        evidence: { rule_check: [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text'] }] },
      }],
    })
    expect(parsed.deliveryGateDigestMode).toBe('shadow')
    expect(parsed.deliveryGate?.[0]?.evidence?.rule_check?.[0]?.matchesDraftTexts).toEqual(['text'])
    expect(PatentRule.Config({}).deliveryGateDigestMode).toBe('enforce')
  })
})

describe('tools/guard 交付前置门禁', () => {
  async function mount(config: Partial<PatentRule.Config>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PatentRule, config)
    return ctx
  }

  it('未跑前置调用即拒绝交付渲染，并点名缺哪一步', async () => {
    const ctx = await mount({
      deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check', 'law_verify'] }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))
    ctx.tools.register(okTool('law_verify'))

    const result = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/交付前置门禁拒绝 render_patent_document/)
    expect(result.error?.message).toMatch(/rule_check、law_verify/)
  })

  // 反例注入：patent preset 声明的交付门禁以 matter_log_append 为前置（案卷留档），
  // 未留档即渲染必须被拒并点名该缺步。用例驱动真实的门禁判定，而不是复述声明文本。
  it('rejects a delivery render whose round was not archived', async () => {
    const ctx = await mount({
      deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check', 'law_verify', 'matter_log_append'] }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))
    ctx.tools.register(okTool('law_verify'))
    ctx.tools.register(okTool('matter_log_append'))

    const denied = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/matter_log_append/)

    // 另两道闸门跑过后仍被拒：缺的正是留档这一步。
    expect((await call(ctx, 'rule_check', {}, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'law_verify', {}, AGENT)).isError).toBe(false)
    const stillDenied = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(stillDenied.isError).toBe(true)
    expect(stillDenied.error?.message).toMatch(/交付前置门禁拒绝 render_patent_document.*matter_log_append/s)

    expect((await call(ctx, 'matter_log_append', {}, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })

  it('前置调用成功返回后放行', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))

    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(true)
    expect((await call(ctx, 'rule_check', { text: '权利要求 1' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })

  it('does not let one case satisfy another case delivery', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))

    expect((await call(ctx, 'rule_check', { caseId: 'case-A' }, AGENT)).isError).toBe(false)
    const denied = await call(ctx, 'render_patent_document', { template: 'claims-spec', caseId: 'case-B' }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/rule_check/)

    expect((await call(ctx, 'rule_check', { caseId: 'case-B' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec', caseId: 'case-B' }, AGENT)).isError)
      .toBe(false)
  })

  it('被输出门禁拦住的前置调用不算跑过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patent-rule-delivery-'))
    const patentDir = join(root, 'patent')
    mkdirSync(patentDir)
    writeFileSync(
      join(patentDir, 'compliance.yaml'),
      [
        'rules:',
        '  - id: TEST-BLOCK',
        '    name: 测试拦截',
        '    severity: critical',
        '    action: block',
        '    check: { type: keyword_blocklist, keywords: ["BLOCKWORD"] }',
      ].join('\n'),
      'utf8',
    )
    const ctx = await mount({
      rulesDir: root,
      gateToolNames: ['rule_check', 'render_patent_document'],
      deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(defineContentToolFixture({
      name: 'rule_check',
      description: 'rule_check',
      parameters: {},
      async execute(): Promise<ContentBlock[]> {
        return [{ type: 'text', text: '包含 BLOCKWORD 的检查' }]
      },
    }))

    const blocked = await call(ctx, 'rule_check', {}, AGENT)
    expect(blocked.isError).toBe(true)
    expect(blocked.error?.message).toMatch(/TEST-BLOCK/)

    const denied = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/交付前置门禁拒绝 render_patent_document/)
    expect(denied.error?.message).toMatch(/rule_check/)
  })

  it('前置调用报错不算跑过', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(failingTool('rule_check'))

    expect((await call(ctx, 'rule_check', {}, AGENT)).isError).toBe(true)
    const result = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/rule_check/)
  })

  it('前置结果声明 blocked:true 不算跑过', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['law_verify'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(resultTool('law_verify', { blocked: true }))

    expect((await call(ctx, 'law_verify', {}, AGENT)).isError).toBe(false)
    const denied = await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/law_verify/)
  })

  it('denies a delivery whose prerequisite results lack the declared evidence', async () => {
    const ctx = await mount({
      deliveryGate: [{
        tool: 'render_patent_document',
        requires: ['rule_check', 'law_verify', 'patent_workflow_run'],
        whenArgs: { template: 'oa-response' },
        evidence: {
          rule_check: [{ field: 'evaluated', minItems: 1 }],
          law_verify: [{ field: 'findings', minItems: 1 }],
          patent_workflow_run: [
            { field: 'ok', equals: true },
            { field: 'manifestId', equals: 'patent_oa_response_v1' },
          ],
        },
      }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(resultTool('rule_check', { blocked: false, evaluated: [] }))
    ctx.tools.register(resultTool('law_verify', { blocked: false, findings: [] }))
    ctx.tools.register(resultTool('patent_workflow_run', { ok: true, manifestId: 'patent_disclosure_v1' }))

    expect((await call(ctx, 'rule_check', { text: '' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'law_verify', {}, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'patent_workflow_run', { input: '交底书' }, AGENT)).isError).toBe(false)

    const denied = await call(ctx, 'render_patent_document', { template: 'oa-response' }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/rule_check（/)
    expect(denied.error?.message).toMatch(/law_verify（/)
    expect(denied.error?.message).toMatch(/patent_workflow_run（/)
  })

  it('allows a delivery once the prerequisite results carry the declared evidence', async () => {
    const ctx = await mount({
      deliveryGate: [{
        tool: 'render_patent_document',
        requires: ['rule_check', 'law_verify', 'patent_workflow_run'],
        whenArgs: { template: 'oa-response' },
        evidence: {
          rule_check: [{ field: 'evaluated', minItems: 1 }],
          law_verify: [{ field: 'findings', minItems: 1 }],
          patent_workflow_run: [
            { field: 'ok', equals: true },
            { field: 'manifestId', equals: 'patent_oa_response_v1' },
          ],
        },
      }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(resultTool('rule_check', { blocked: false, evaluated: [{ field: 'text', chars: 120, digest: 'd' }] }))
    ctx.tools.register(resultTool('law_verify', { blocked: false, findings: [{ raw: '专利法第22条第3款' }] }))
    ctx.tools.register(resultTool('patent_workflow_run', { ok: true, manifestId: 'patent_oa_response_v1' }))

    expect((await call(ctx, 'rule_check', { text: '答复正文' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'law_verify', { text: '专利法第22条第3款' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'patent_workflow_run', { manifestId: 'patent_oa_response_v1', input: '通知书' }, AGENT)).isError)
      .toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'oa-response' }, AGENT)).isError).toBe(false)
  })

  it('前置结果没有 blocked:true 时放行', async () => {
    for (const value of [{ blocked: false }, 'ok', null] as const) {
      const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['law_verify'] }] })
      ctx.tools.register(documentTool())
      ctx.tools.register(resultTool('law_verify', value))
      expect((await call(ctx, 'law_verify', {}, AGENT)).isError).toBe(false)
      expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
    }
  })

  it('台账按会话隔离：别的会话跑过不算本会话跑过', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))

    expect((await call(ctx, 'rule_check', {}, OTHER_AGENT)).isError).toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(true)
  })

  it('同一 draft 放行，改一字后拒绝并指名不一致的投影', async () => {
    const ctx = await mount({
      deliveryGate: [
        { tool: 'render_patent_document', requires: ['rule_check'], evidence: { rule_check: [{ field: 'evaluated', minItems: 1 }] } },
        {
          tool: 'render_patent_document',
          requires: ['rule_check'],
          whenArgs: { template: ['claims-spec'] },
          evidence: { rule_check: [{ field: 'evaluated', matchesDraftTexts: ['claims'] }] },
        },
      ],
    })
    ctx.tools.register(documentTool())
    const draft = specDraft()
    ctx.tools.register(resultTool('rule_check', {
      blocked: false,
      evaluated: [{ field: 'text', chars: 120, digest: projectionDigests(draft).claims }],
    }))

    expect((await call(ctx, 'rule_check', { text: '权利要求' }, AGENT)).isError).toBe(false)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec', draft }, AGENT)).isError).toBe(false)

    const denied = await call(ctx, 'render_patent_document', { template: 'claims-spec', draft: changedClaimsDraft() }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/交付前置门禁拒绝 render_patent_document/)
    expect(denied.error?.message).toMatch(/claims 投影不一致/)
    expect(denied.error?.message).toMatch(/用本次 draft 重跑该前置工具后再交付/)
  })

  it('前置检查读的是旧稿：拒绝', async () => {
    const ctx = await mount({
      deliveryGate: [{
        tool: 'build_patent_filing',
        requires: ['rule_check'],
        evidence: { rule_check: [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text'] }] },
      }],
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'build_patent_filing',
      description: 'build_patent_filing',
      parameters: { draft: { type: 'object', additionalProperties: true } },
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'docx written' }] },
    }))
    const oldDraft = specDraft()
    ctx.tools.register(resultTool('rule_check', {
      blocked: false,
      evaluated: [{ field: 'text', chars: 120, digest: projectionDigests(oldDraft).text }],
    }))

    expect((await call(ctx, 'rule_check', { text: '说明书全文' }, AGENT)).isError).toBe(false)
    const revised = specDraft()
    revised.sections.technicalField = [{ kind: 'paragraph', text: '本发明属于智能容器技术领域。' }]
    const denied = await call(ctx, 'build_patent_filing', { draft: revised }, AGENT)
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toMatch(/text 投影不一致/)
  })

  it('shadow 模式：digest 不符只观测不拒绝，日志点名投影', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(PatentRule, {
      deliveryGateDigestMode: 'shadow',
      deliveryGate: [{
        tool: 'render_patent_document',
        requires: ['rule_check'],
        whenArgs: { template: ['claims-spec'] },
        evidence: { rule_check: [{ field: 'evaluated', matchesDraftTexts: ['claims'] }] },
      }],
    })
    ctx.tools.register(documentTool())
    const draft = specDraft()
    ctx.tools.register(resultTool('rule_check', {
      blocked: false,
      evaluated: [{ field: 'text', chars: 120, digest: projectionDigests(draft).claims }],
    }))

    expect((await call(ctx, 'rule_check', { text: '权利要求' }, AGENT)).isError).toBe(false)
    const allowed = await call(ctx, 'render_patent_document', { template: 'claims-spec', draft: changedClaimsDraft() }, AGENT)
    expect(allowed.isError).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('交付前置门禁 digest 观测'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claims'))
  })

  it('草案结构非法：门禁不拿 digest 拦，由成文工具报结构错误', async () => {
    const ctx = await mount({
      deliveryGate: [{
        tool: 'build_patent_filing',
        requires: ['rule_check'],
        evidence: { rule_check: [{ field: 'evaluated', minItems: 1, matchesDraftTexts: ['text'] }] },
      }],
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'build_patent_filing',
      description: 'build_patent_filing',
      parameters: { draft: { type: 'object', additionalProperties: true } },
      async execute(): Promise<ContentBlock[]> {
        throw new Error('草案结构非法：claims 至少一项')
      },
    }))
    ctx.tools.register(resultTool('rule_check', {
      blocked: false,
      evaluated: [{ field: 'text', chars: 120, digest: projectionDigests(specDraft()).text }],
    }))

    expect((await call(ctx, 'rule_check', { text: '说明书全文' }, AGENT)).isError).toBe(false)
    const result = await call(ctx, 'build_patent_filing', { draft: { claims: [] } }, AGENT)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/草案结构非法/)
    expect(result.error?.message).not.toMatch(/交付前置门禁/)
  })

  it('whenArgs 按模板收窄：分析类要收口，撰写类不要', async () => {
    const ctx = await mount({
      deliveryGate: [{
        tool: 'render_patent_document',
        requires: ['patent_workflow_run'],
        whenArgs: { template: ['patentability-opinion', 'search-report'] },
      }],
    })
    ctx.tools.register(documentTool())

    expect((await call(ctx, 'render_patent_document', { template: 'patentability-opinion' }, AGENT)).isError).toBe(true)
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })

  it('归属不明的调用拿不出本会话记录，按未满足处理', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('rule_check'))

    const result = await call(ctx, 'render_patent_document', { template: 'claims-spec' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/rule_check/)
  })

  it('未声明交付门禁时不做判定（opt-in）', async () => {
    const ctx = await mount({})
    ctx.tools.register(documentTool())
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })

  it('被门禁的工具之外的调用不受影响', async () => {
    const ctx = await mount({ deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }] })
    ctx.tools.register(documentTool())
    ctx.tools.register(okTool('validate_specification'))
    expect((await call(ctx, 'validate_specification', {}, AGENT)).isError).toBe(false)
  })

  it('空声明告警且该条不生效', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(PatentRule, { deliveryGate: [{ tool: 'render_patent_document', requires: [] }] })
    ctx.tools.register(documentTool())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('交付前置门禁 render_patent_document: 未声明任何前置调用'))
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })

  it('撤销贡献后门禁随之移除（HMR 安全）', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(PatentRule, {
      deliveryGate: [{ tool: 'render_patent_document', requires: ['rule_check'] }],
    })
    ctx.tools.register(documentTool())

    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(true)
    await fiber.dispose()
    expect((await call(ctx, 'render_patent_document', { template: 'claims-spec' }, AGENT)).isError).toBe(false)
  })
})
