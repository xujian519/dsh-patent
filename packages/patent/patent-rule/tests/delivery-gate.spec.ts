import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {  defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

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
        { field: 'ok', equals: true },
        { field: 'manifestId', equals: 'patent_oa_response_v1' },
      ],
    })
  })

  it('未声明时门禁缺省为空（opt-in）', () => {
    expect(PatentRule.Config({}).deliveryGate).toEqual([])
  })
})

describe('tools/guard 交付前置门禁', () => {
  async function mount(config: PatentRule.Config): Promise<Context> {
    const ctx = new Context()
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
