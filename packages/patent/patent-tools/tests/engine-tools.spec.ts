import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RuleSet } from '@deepseek-ai/dsh-patent-core'
import type { EvidenceEngine } from '@deepseek-ai/dsh-patent-core'
import { createRuleCheckTool } from '../src/tool/rule-check.ts'
import { createEvaluateEvidenceTool } from '../src/tool/evaluate-evidence.ts'
import { createClaimChartBuildTool } from '../src/tool/claim-chart-build.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

describe('rule_check', () => {
  it('fails loud on an unknown scope (empty rule set)', async () => {
    const tool = createRuleCheckTool({ loader: () => ({ rules: [] }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: 'x', scope: 'bogus' }, 'r-1')
    expect(result.isError).toBe(true)
  })

  it('rejects blank text so a zero-byte call cannot stand in for a gate run', async () => {
    const tool = createRuleCheckTool({ loader: () => ({ rules: [{ id: 'r1', name: '禁止词', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止词'] } }] }), synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    for (const [label, text] of [['r-blank-1', ''], ['r-blank-2', ' \n\t ']] as const) {
      const result = await execute(ctx, 'rule_check', { text, scope: 'patent' }, label)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('text 不能为空白')
    }
  })

  it('patent-mechanical scope adds the mechanical domain pack on top of the full assets', async () => {
    const tool = createRuleCheckTool()
    const ctx = await ctxWith(tool)
    // 语境锚点在、但缺「作用或技术效果」的分析 → MECH-INV-001 命中
    const hit = await execute(ctx, 'rule_check', { text: '对比文件1的压板与本申请的结构等效。', scope: 'patent-mechanical' }, 'r-mech-1')
    expect(hit.isError).toBe(false)
    if (hit.isError) throw new Error('expected success')
    expect(JSON.stringify(hit.value)).toContain('MECH-INV-001')

    // 不含等效/等同的文本不评估该规则
    const clean = await execute(ctx, 'rule_check', { text: '所述壳体设置在底座上，起到支撑作用。', scope: 'patent-mechanical' }, 'r-mech-2')
    expect(clean.isError).toBe(false)
    if (clean.isError) throw new Error('expected success')
    expect(JSON.stringify(clean.value)).not.toContain('MECH-INV-001')
  })

  it('patent-software scope adds the software domain pack on top of the full assets', async () => {
    const tool = createRuleCheckTool()
    const ctx = await ctxWith(tool)
    // 语境锚点在、但缺「技术效果」→ SOFT-INV-001 命中
    const hit = await execute(ctx, 'rule_check', { text: '本方案不属于智力活动规则，其技术问题与技术手段如下。', scope: 'patent-software' }, 'r-soft-1')
    expect(hit.isError).toBe(false)
    if (hit.isError) throw new Error('expected success')
    expect(JSON.stringify(hit.value)).toContain('SOFT-INV-001')

    // 三要素齐备 → 不命中
    const complete = await execute(ctx, 'rule_check', { text: '本方案不属于智力活动规则：技术问题为识别准确率低，技术手段为卷积神经网络，技术效果为准确率提升 3%。', scope: 'patent-software' }, 'r-soft-2')
    expect(complete.isError).toBe(false)
    if (complete.isError) throw new Error('expected success')
    expect(JSON.stringify(complete.value)).not.toContain('SOFT-INV-001')

    // 未讨论客体的文本不评估该规则
    const unrelated = await execute(ctx, 'rule_check', { text: '所述壳体设置在底座上，起到支撑作用。', scope: 'patent-software' }, 'r-soft-3')
    expect(unrelated.isError).toBe(false)
    if (unrelated.isError) throw new Error('expected success')
    expect(JSON.stringify(unrelated.value)).not.toContain('SOFT-INV-001')
  })

  it('patent-chemical scope adds the chemistry domain pack on top of the full assets', async () => {
    const tool = createRuleCheckTool()
    const ctx = await ctxWith(tool)
    // 保藏语境在，但缺保藏单位、日期与分类命名 → CHEM-DIS-001 命中
    const hit = await execute(ctx, 'rule_check', { text: '菌株已保藏，保藏编号为 CCTCC NO: C2024123。', scope: 'patent-chemical' }, 'r-chem-1')
    expect(hit.isError).toBe(false)
    if (hit.isError) throw new Error('expected success')
    expect(JSON.stringify(hit.value)).toContain('CHEM-DIS-001')

    // 四要素齐备 → 不命中
    const complete = await execute(ctx, 'rule_check', {
      text: '菌株保藏于中国典型培养物保藏中心，保藏日期 2024-01-01，保藏编号 CCTCC NO: C2024123，分类命名为 Escherichia coli。',
      scope: 'patent-chemical',
    }, 'r-chem-2')
    expect(complete.isError).toBe(false)
    if (complete.isError) throw new Error('expected success')
    expect(JSON.stringify(complete.value)).not.toContain('CHEM-DIS-001')

    // 未讨论保藏的文本不评估该规则
    const unrelated = await execute(ctx, 'rule_check', { text: '本发明涉及一种化合物的制备方法。', scope: 'patent-chemical' }, 'r-chem-3')
    expect(unrelated.isError).toBe(false)
    if (unrelated.isError) throw new Error('expected success')
    expect(JSON.stringify(unrelated.value)).not.toContain('CHEM-DIS-001')
  })

  it('evaluates a keyword blocklist rule', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'r1', name: '禁止词', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止词'] } }] }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '包含禁止词的文本', scope: 'patent' }, 'r-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('1 条违规')
    expect(text(result)).toContain('r1')
    expect(text(result)).toContain('门禁结论: 存在 block 级违规')
    expect(result.value).toMatchObject({ blocked: true })
  })

  it('renders where the hit is, so a warning can be judged without re-reading the whole text', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'PAT-RISK-001', name: '专利风险结论免责声明', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['专利性'] } }] }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const body = [
      '## 技术领域',
      '本发明涉及一种装置。',
      '本分析由 AI 辅助生成，不构成正式法律意见。专利申请和专利性判断应由具备资质的专利代理人或专利律师确认。',
    ].join('\n')
    const result = await execute(ctx, 'rule_check', { text: body, scope: 'patent' }, 'r-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('（第 3 行「专利申请和专利性判断应由具备资质的专利代理人或专利律师确认。」）')
  })

  it('states the identity of the text it read, so a second run can be compared with it', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'r1', name: '禁止词', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止词'] } }] }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const body = '包含禁止词的文本'
    const result = await execute(ctx, 'rule_check', { text: body, scope: 'patent' }, 'r-5')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`评估输入: text ${body.length} 字 · `)
  })

  it('reports zero violations on clean text', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'r1', name: '禁止词', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止词'] } }] }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '干净文本', scope: 'patent' }, 'r-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('无违规')
    expect(result.value).toMatchObject({ blocked: false })
  })

  const dualRules: RuleSet = {
    rules: [
      { id: 'PR-OA-008', name: '答复—驳回理由覆盖', severity: 'major', action: 'warn', check: { type: 'notice_ground_coverage' } },
      { id: 'PR-OA-009', name: '答复—未提条款引用', severity: 'major', action: 'warn', domain: 'patent_oa_response', check: { type: 'unraised_statute_citation' } },
      { id: 'PR-OA-099', name: '域外规则', severity: 'minor', action: 'warn', domain: 'unrelated_domain', check: { type: 'unraised_statute_citation' } },
    ],
  }

  it('evaluates the dual-input rules against the supplied notice', async () => {
    const tool = createRuleCheckTool({ loader: () => dualRules, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const notice = '权利要求 1-2 不具备创造性，不符合专利法第22条第3款的规定；权利要求 3 的保护范围不清楚，不符合专利法第26条第4款的规定。'
    const response = '关于创造性：对比文件 1 与 2 的结合无技术启示。本申请符合专利法第26条第3款的规定。'
    const result = await execute(ctx, 'rule_check', { text: response, scope: 'patent-oa-response', notice }, 'r-6')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('PR-OA-008')
    expect(text(result)).toContain('PR-OA-009')
    expect(text(result)).not.toContain('PR-OA-099')
    expect(text(result)).toContain(`评估输入: text ${response.length} 字 · `)
    expect(text(result)).toContain(`notice ${notice.length} 字 · `)
  })

  it('reports a notice that the selected scope cannot evaluate', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'r1', name: '禁止词', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止词'] } }] }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '干净文本', scope: 'patent', notice: '通知书正文' }, 'r-8')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain("scope 'patent' 没有可评估的双输入规则，notice 未参与判定")
  })

  it('lists the dual-input rules it did not evaluate when notice is missing', async () => {
    const tool = createRuleCheckTool({ loader: () => dualRules, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '答复正文。', scope: 'patent-oa-response' }, 'r-7')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('双输入规则未评估（未提供 notice）: PR-OA-008、PR-OA-009')
    expect(text(result)).not.toContain('PR-OA-099')
  })

  it('keeps the dual-input filter working without a job scope', async () => {
    const tool = createRuleCheckTool({ loader: () => dualRules, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '答复正文。', scope: 'patent' }, 'r-8')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('PR-OA-008、PR-OA-009、PR-OA-099')
  })

  it('reports no dual violation when the response covers every notice ground', async () => {
    const ruleSet: RuleSet = {
      rules: [{ id: 'PR-OA-008', name: '答复—驳回理由覆盖', severity: 'major', action: 'warn', check: { type: 'notice_ground_coverage' } }],
    }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const notice = '权利要求 1 不具备创造性，不符合专利法第22条第3款的规定。'
    const response = '关于创造性：对比文件 1 无技术启示，符合专利法第22条第3款的规定。'
    const result = await execute(ctx, 'rule_check', { text: response, scope: 'patent-oa-response', notice }, 'r-9')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('无违规')
  })
})

describe('evaluate_evidence', () => {
  const engine = {
    judge: (span: { id: string }) => ({
      spanId: span.id, overallScore: 0.85, confidence: 0.9,
      relevanceJudgment: { dimension: 'relevance', score: 0.9, level: 'high', reasoning: 'r' },
      legalityJudgment: { dimension: 'legality', score: 0.8, level: 'high', reasoning: 'r' },
      authenticityJudgment: { dimension: 'authenticity', score: 0.7, level: 'medium', reasoning: 'r' },
      reasoning: 'reasoning', flaggedIssues: [], rulesApplied: [
        { ruleId: 'EVI-001', name: 'n', action: 'block', severity: 'error', satisfied: true, pendingInputs: [], failedConditions: [] },
        { ruleId: 'EVI-011', name: 'm', action: 'block', severity: 'error', satisfied: false, pendingInputs: ['notarized'], failedConditions: [] },
      ],
    }),
    assessBurdenOfProof: (_caseType: string) => ({ burdenHolder: 'h', standard: 's', hasShifted: false, reasoning: 'r' }),
  } as unknown as EvidenceEngine

  it('judges a snippet and carries EVI-011 guard fields', async () => {
    const tool = createEvaluateEvidenceTool({ engine })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'evaluate_evidence', { snippet: 's', caseType: 'invalidation', notarized: true, translated: true }, 'ev-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('0.85')
    expect(text(result)).toContain('EVI-011')
  })
})

describe('claim_chart_build', () => {
  it('fails loud without a model port', async () => {
    const tool = createClaimChartBuildTool({})
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', { mode: 'invalidity', claim_text: 'c', targets: [] }, 'cc-1')
    expect(result.isError).toBe(true)
  })

  it('rejects empty claim_text', async () => {
    const tool = createClaimChartBuildTool({ model: { stream: async function* () { yield { type: 'done' as const } } } })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', { mode: 'invalidity', claim_text: '  ', targets: [] }, 'cc-2')
    expect(result.isError).toBe(true)
  })
})
