import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { EvidenceEngine } from '@deepseek-ai/dsh-patent-core'
import type { RuleSet } from '@deepseek-ai/dsh-patent-core'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../src/error.ts'
import { createDraftClaimsTool, draftClaims, renderDraftClaims, validateClaims, type DraftedClaim } from '../src/tool/draft-claims.ts'
import { composeAbstract, createDraftSpecificationTool, draftSpecification } from '../src/tool/draft-specification.ts'
import { createEvaluateEvidenceTool } from '../src/tool/evaluate-evidence.ts'
import { createPatentEvalTool, evaluatePatentContent } from '../src/tool/patent-eval.ts'
import { createRuleCheckTool } from '../src/tool/rule-check.ts'
import { createClaimChartBuildTool } from '../src/tool/claim-chart-build.ts'
import { createKnowledgeNoteSaveTool, noteDocumentId } from '../src/tool/knowledge-note-save.ts'
import {
  createRecognizeChemicalStructureTool,
  renderChemicalStructure,
} from '../src/tool/recognize-chemical-structure.ts'
import type { PatentModelPort } from '@deepseek-ai/dsh-patent-core'
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

function jsonModel(json: string): PatentModelPort {
  return {
    stream: async function* () {
      yield { type: 'delta' as const, text: json }
      yield { type: 'done' as const }
    },
  }
}

describe('draft_claims deeper paths', () => {
  it('builds each technical-domain template and a prior-art preamble', () => {
    const mechanical = draftClaims({ invention_name: '壳体装置', technical_features: ['壳体'] })
    expect(mechanical.tech_domain).toBe('mechanical')
    const electrical = draftClaims({ invention_name: '电源装置', tech_domain: 'electrical', technical_features: ['电路'] })
    expect(electrical.claims[0]?.text).toContain('其特征在于，包括：')
    const chemical = draftClaims({ invention_name: '组合物', tech_domain: 'chemical', technical_features: ['组分'] })
    expect(chemical.claims[0]?.text).toContain('其特征在于，包含：')
    const software = draftClaims({ invention_name: '识别方法', tech_domain: 'software', technical_features: ['算法'] })
    expect(software.claims[0]?.text).toContain('包括以下步骤：')
    const withPrior = draftClaims({
      invention_name: '装置',
      tech_domain: 'mechanical',
      technical_features: ['特征A'],
      prior_art: '现有技术公开了装置结构；',
    })
    expect(withPrior.claims[0]?.text).toContain('其特征在于，还包括：特征A。')
    expect(withPrior.claims[0]?.text).not.toContain('；；')
  })

  it('falls back to the general template for missing features and long names', () => {
    const empty = draftClaims({ invention_name: '装置', technical_features: [] })
    expect(empty.claims[0]?.text).toContain('缺少必要技术特征')
    expect(empty.warnings[0]).toContain('未提供必要技术特征')
    const longName = draftClaims({ invention_name: '一'.repeat(30), technical_features: ['a'] })
    expect(longName.warnings[0]).toContain('超过 25 字')
  })

  it('auto-detects the domain and honors an explicit general hint', () => {
    expect(draftClaims({ invention_name: '带齿轮的装置', technical_features: ['a'] }).tech_domain).toBe('mechanical')
    expect(draftClaims({ invention_name: 'x', tech_domain: 'general', technical_features: ['a'] }).tech_domain).toBe('general')
  })

  it('flags vague terms and the additional-fee threshold through the tool render', async () => {
    const ctx = await ctxWith(createDraftClaimsTool())
    const result = await execute(ctx, 'draft_claims', {
      invention_name: '装置',
      technical_features: ['特征A'],
      optional_features: ['优选地 约 10% 的附加特征', ...Array.from({ length: 10 }, (_, i) => `附加特征${i + 1}`)],
    }, 'dc-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('形式校验违规')
    expect(text(result)).toContain('（引用 1）')
    expect(text(result)).toContain('additional_fee')
  })

  it('blocks a claim set over the ceiling the drafting instruction fixed', () => {
    const over = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      optional_features: ['附加特征1', '附加特征2'],
      max_claims: 2,
    })
    const cap = over.violations.find(v => v.rule === 'claim_count_cap')
    expect(cap?.severity).toBe('error')
    expect(cap?.message).toContain('超过本次撰写指令的项数上限 2 项')
    expect(over.claims).toHaveLength(3)

    const within = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      optional_features: ['附加特征1'],
      max_claims: 2,
    })
    expect(within.violations.map(v => v.rule)).not.toContain('claim_count_cap')
  })

  it('renders the missing-features warning through the tool', async () => {
    const ctx = await ctxWith(createDraftClaimsTool())
    const result = await execute(ctx, 'draft_claims', {
      invention_name: '装置',
      technical_features: [],
    }, 'dc-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('## 警告')
  })

  it('renders a violation without a claim number or suggestion', () => {
    const out = renderDraftClaims({
      invention_name: '装置',
      tech_domain: 'mechanical',
      claims: [{ number: 1, type: 'independent', text: '一种装置。' }],
      violations: [{ rule: 'bare', severity: 'warning', message: '裸违规' }],
      warnings: [],
    })
    expect(out).toContain('裸违规')
    expect(out).not.toContain('权1')
  })

  it('validates crafted claim sets covering each formal rule', () => {
    const claims: DraftedClaim[] = [
      { number: 2, type: 'independent', text: '一种装置，其特征在于，包括：壳体' },
      { number: 1, type: 'dependent', refersTo: 1, text: '根据权利要求1所述的装置，约 10% 的优选特征。' },
    ]
    const violations = validateClaims(claims)
    const rules = violations.map(v => v.rule)
    expect(rules).toContain('numbering')
    expect(rules).toContain('period')
    expect(rules).toContain('clarity')
    expect(rules).toContain('circular_reference')
  })

  it('rejects illustration references in claims', () => {
    const claims: DraftedClaim[] = [
      { number: 1, type: 'independent', text: '如图1所示的装置。' },
    ]
    const violations = validateClaims(claims)
    expect(violations.map(v => v.rule)).toContain('no_illustration')
  })

  it('renders a multi-branch dependent tree in ascending claim order', () => {
    const out = draftClaims({
      invention_name: '储罐',
      tech_domain: 'mechanical',
      technical_features: ['壳体'],
      dependent_tree: [
        { number: 4, parent: [1, 2], text: '螺距为 30-45mm', feature_id: 'F6' },
        { number: 2, parent: 1, text: '伴热夹套内设加热通道', feature_id: 'F4' },
        { number: 3, parent: 1, text: '加热通道为螺旋形通道', feature_id: 'F5' },
      ],
    })
    expect(out.claims.map(claim => claim.number)).toEqual([1, 2, 3, 4])
    expect(out.claims[1]?.text).toContain('根据权利要求1所述的储罐')
    expect(out.claims[2]?.text).toContain('根据权利要求1所述的储罐')
    expect(out.claims[3]?.text).toContain('根据权利要求1或2所述的储罐')
    expect(out.claims[3]?.refersTo).toEqual([1, 2])
    expect(out.claims[1]?.featureId).toBe('F4')
    expect(out.violations).toEqual([])
    expect(renderDraftClaims(out)).toContain('（引用 1 或 2）')
  })

  it('rejects a forward or self citation in a dependent tree', () => {
    const forward = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      dependent_tree: [{ number: 2, parent: 3, text: '附加特征' }],
    })
    expect(forward.violations.find(v => v.rule === 'circular_reference')?.claimNumber).toBe(2)

    const self = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      dependent_tree: [{ number: 2, parent: [1, 2], text: '附加特征' }],
    })
    expect(self.violations.some(v => v.rule === 'circular_reference' && v.message.includes('2'))).toBe(true)
  })

  it('rejects a non-contiguous dependent tree and an empty citation list', () => {
    const gap = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      dependent_tree: [
        { number: 2, parent: 1, text: '附加特征2' },
        { number: 4, parent: 1, text: '附加特征4' },
      ],
    })
    expect(gap.violations.find(v => v.rule === 'numbering')?.claimNumber).toBe(4)

    const empty = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      dependent_tree: [{ number: 2, parent: [], text: '附加特征' }],
    })
    expect(empty.violations.map(v => v.rule)).toContain('missing_reference')
  })

  it('rejects dependent_tree together with optional_features', () => {
    expect(() => draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      optional_features: ['扁平附加特征'],
      dependent_tree: [{ number: 2, parent: 1, text: '树附加特征' }],
    })).toThrow(/dependent_tree 与 optional_features 互斥/)
  })

  it('translates the mutual-exclusion rejection into invalid_tool_input at the tool boundary', async () => {
    const tool = createDraftClaimsTool()
    const signal = new AbortController().signal
    await expect(tool.execute({
      invention_name: '装置',
      technical_features: ['特征A'],
      optional_features: ['扁平附加特征'],
      dependent_tree: [{ number: 2, parent: 1, text: '树附加特征' }],
    }, { signal } as never)).rejects.toMatchObject({ code: 'invalid_tool_input' })
  })

  it('applies the claim ceiling and the additional-fee warning to a tree', () => {
    const tree = Array.from({ length: 10 }, (_, index) => ({
      number: index + 2,
      parent: 1,
      text: `附加特征${index + 1}`,
    }))
    const overTen = draftClaims({ invention_name: '装置', technical_features: ['特征A'], dependent_tree: tree })
    expect(overTen.claims).toHaveLength(11)
    expect(overTen.violations.find(v => v.rule === 'additional_fee')?.severity).toBe('warning')

    const capped = draftClaims({
      invention_name: '装置',
      technical_features: ['特征A'],
      dependent_tree: tree,
      max_claims: 5,
    })
    expect(capped.violations.find(v => v.rule === 'claim_count_cap')?.severity).toBe('error')
  })

  it('exposes the dependent tree through the tool schema and execution', async () => {
    const ctx = await ctxWith(createDraftClaimsTool())
    const result = await execute(ctx, 'draft_claims', {
      invention_name: '储罐',
      tech_domain: 'mechanical',
      technical_features: ['壳体'],
      dependent_tree: [
        { number: 2, parent: 1, text: '伴热夹套' },
        { number: 3, parent: [1, 2], text: '螺距为 30-45mm' },
      ],
    }, 'dc-tree')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('（引用 1 或 2）')
    expect(text(result)).toContain('根据权利要求1或2所述的储罐')

    const parameters = ctx.tools.get('draft_claims')?.parameters as { properties: Record<string, unknown> }
    expect(parameters.properties['dependent_tree']).toBeDefined()
  })
})

describe('draft_specification deeper paths', () => {
  it('assembles a fully-specified draft', () => {
    const out = draftSpecification({
      title: '一种装置',
      tech_domain: 'mechanical',
      technical_problem: '精度不足',
      technical_solution: '采用新型结构',
      beneficial_effects: '精度提升',
      background: '现有装置精度不足。',
      drawing_descriptions: ['图1为本发明的整体结构示意图', '俯视图'],
      embodiments: ['实施例1：结构细节', '实施例2：变体'],
    })
    const content = out.sections.find(s => s.name === '发明内容')
    expect(content?.placeholder).toBe(false)
    expect(content?.content).toContain('要解决的技术问题是：精度不足')
    const drawings = out.sections.find(s => s.name === '附图说明')
    expect(drawings?.content).toBe('图1为本发明的整体结构示意图\n图2为俯视图')
    expect(drawings?.content).not.toContain('图1为图1为')
    const embodiments = out.sections.find(s => s.name === '具体实施方式')
    expect(embodiments?.content).toContain('实施例1：结构细节')
  })

  it('composes a ≤300-character abstract with a keyword line and no claim citation', () => {
    const abstract = composeAbstract({
      title: '一种智能门锁',
      technical_problem: '现有门锁无法远程授权',
      technical_solution: '采用蓝牙模块与控制器',
      beneficial_effects: '授权响应时间缩短',
    })
    expect(Array.from(abstract).length).toBeLessThanOrEqual(300)
    expect(abstract).toContain('关键词：智能门锁')
    expect(abstract).not.toMatch(/权利要求\s*\d/)
    const clipped = composeAbstract({ title: '装置', technical_solution: '长'.repeat(400) })
    expect(Array.from(clipped).length).toBeLessThanOrEqual(300)
    expect(clipped).toContain('关键词：装置')
  })

  it('placeholder-flagged sections and drawing/embodiment hints', () => {
    const out = draftSpecification({ title: '装置', has_drawings: true })
    const content = out.sections.find(s => s.name === '发明内容')
    expect(content?.placeholder).toBe(true)
    const drawings = out.sections.find(s => s.name === '附图说明')
    expect(drawings?.content).toContain('按图序逐图说明')
  })

  it('auto-generates drawing descriptions from figure analysis with electrical detail', () => {
    const out = draftSpecification({
      title: '装置',
      figure_analysis: [
        {
          figureDescription: '图1为电路原理图；',
          electrical: { components: [{ ref: '3', name: '电容', value: '10μF' }, { ref: '4', name: '电阻' }] },
        },
        { figureDescription: '图2为结构图。' },
        { figureDescription: '图3为示意图；图中：1-壳体；', electrical: { components: [{ ref: '1', name: '壳体' }] } },
        { figureDescription: '   ', electrical: { components: [{ ref: '7', name: '连接器' }] } },
      ],
    })
    const drawings = out.sections.find(s => s.name === '附图说明')
    expect(drawings?.content).toContain('图中：3-电容（10μF）；4-电阻；')
    expect(drawings?.content).toContain('图4为电路原理图；图中：7-连接器；')
    expect(drawings?.content).not.toContain('图1为图1为')
    expect(out.warnings.some(w => w.includes('自动生成'))).toBe(true)
  })

  it('warns for an over-25-char title and renders the warning', async () => {
    const out = draftSpecification({ title: '一'.repeat(26), patent_type: 'invention' })
    expect(out.warnings[0]).toContain('超过 25 字')
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', { title: '二'.repeat(30), patent_type: 'invention' }, 'ds-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('**警告**')
  })

  it('warns for a utility model without drawings and auto-detects the domain', () => {
    const out = draftSpecification({ title: '装置', patent_type: 'utility_model', technical_solution: '包含电路' })
    expect(out.warnings.some(w => w.includes('附图'))).toBe(true)
    expect(out.tech_domain).toBe('electrical')
  })

  it('renders the warnings section through the tool', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', { title: '装置', patent_type: 'utility_model' }, 'ds-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('**警告**')
  })
})

describe('evaluate_evidence deeper paths', () => {
  function makeEngine(over: Record<string, unknown> = {}): EvidenceEngine {
    return {
      judge: () => ({
        spanId: 'span-1',
        overallScore: 0.85,
        confidence: 0.9,
        relevanceJudgment: { dimension: 'relevance', score: 0.9, level: 'high', reasoning: 'r' },
        legalityJudgment: { dimension: 'legality', score: 0.8, level: 'high', reasoning: 'r' },
        authenticityJudgment: { dimension: 'authenticity', score: 0.7, level: 'medium', reasoning: 'r' },
        typeSpecificJudgment: { public_use: { elements: 4 } },
        reasoning: 'reasoning',
        flaggedIssues: [{ type: 'EVI-013', description: '公知常识未论证', severity: 'warning' }],
        rulesApplied: [
          { ruleId: 'EVI-001', name: 'n', action: 'block', severity: 'error', satisfied: true, pendingInputs: [], failedConditions: [] },
          { ruleId: 'EVI-011', name: 'm', action: 'block', severity: 'error', satisfied: false, pendingInputs: ['notarized', 'translated'], failedConditions: [] },
        ],
        ...over,
      }),
      assessBurdenOfProof: () => ({ burdenHolder: 'h', standard: 's', hasShifted: true, reasoning: 'r' }),
    } as unknown as EvidenceEngine
  }

  it('carries every external guard field into the judgment and renders all sections', async () => {
    const tool = createEvaluateEvidenceTool({ engine: makeEngine() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'evaluate_evidence', {
      snippet: 's',
      sourceUri: 'web:https://example.com',
      docVersion: '2023-01-02',
      contentHash: 'abc',
      direction: 'contradicting',
      claimRefs: ['c1'],
      evidenceType: 'internet_publication',
      filingDate: '2020-01-01',
      priorityDate: '2019-06-01',
      caseType: 'invalidation',
      notarized: true,
      legalized: true,
      translated: true,
      witnessDisclosed: true,
      isWellKnown: false,
      isUncontested: false,
      deadlineDefined: true,
      submissionWithinDeadline: true,
      collectionLegal: true,
      supportingCount: 3,
      contradictingCount: 0,
      custodyChainTraceable: true,
      integrityVerified: true,
    }, 'ev-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('举证责任')
    expect(text(result)).toContain('已转移')
    expect(text(result)).toContain('适用规则')
    expect(text(result)).toContain('待外部输入')
    expect(text(result)).toContain('问题:')
  })

  it('renders without burden/rules/flags and falls back to low judgments', async () => {
    const engine = makeEngine({
      relevanceJudgment: undefined,
      legalityJudgment: undefined,
      authenticityJudgment: undefined,
      typeSpecificJudgment: undefined,
      flaggedIssues: [],
      rulesApplied: [],
    })
    const tool = createEvaluateEvidenceTool({ engine })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'evaluate_evidence', { snippet: 's' }, 'ev-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('相关性: 0 (low)')
  })

  it('loads the default engine when only rule dirs are injected', async () => {
    const tool = createEvaluateEvidenceTool({ ruleDirs: [] })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'evaluate_evidence', { snippet: 's' }, 'ev-4')
    expect(result.isError).toBe(false)
  })

  it('loads the default engine with no deps at all', async () => {
    const tool = createEvaluateEvidenceTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'evaluate_evidence', { snippet: 's' }, 'ev-5')
    expect(result.isError).toBe(false)
  })
})

describe('patent_eval deeper paths', () => {
  it('renders failing dimensions without details through the tool', async () => {
    const tool = createPatentEvalTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_eval', { mode: 'report', content: '短' }, 'pe-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('❌')
  })

  it('runs comprehensive evaluation with required citations', async () => {
    const out = evaluatePatentContent(
      'comprehensive',
      ['## 技术领域', '## 背景技术', '## 发明内容', '## 技术方案', '## 有益效果', '## 附图说明', '## 具体实施方式', '## 法律依据', '## 分析结论', '## 权利要求', '步骤1 步骤2 步骤3 步骤4 步骤5', '关键词1 关键词2 关键词3', '第二十二条第三款 第3条'].join('\n'),
      ['第二十二条第三款'],
    )
    expect(out.mode).toBe('comprehensive')
    expect(out.score).toBeGreaterThan(0)
    expect(out.details['引用合规性']).toBeDefined()
  })

  it('passes required citations through the tool execute', async () => {
    const tool = createPatentEvalTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_eval', {
      mode: 'citations',
      content: '第二十二条第三款',
      required_citations: ['第二十二条第三款'],
    }, 'pe-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('引用合规性')
  })

  it('defaults absent content to an empty string through the tool', async () => {
    const tool = createPatentEvalTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_eval', { mode: 'retrieval' }, 'pe-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('0 个关键词')
  })

  it('handles unknown modes by returning an empty-detail report', () => {
    const out = evaluatePatentContent('bogus' as never, '', [])
    expect(out).toMatchObject({ mode: 'bogus', score: 0, passed: false, details: {} })
  })

  it('scores workflow step counts at every threshold', () => {
    const one = evaluatePatentContent('workflow', '步骤1', [])
    expect(one.details['流程完整性']?.score).toBe(0.3)
    const three = evaluatePatentContent('workflow', '步骤1\n步骤2\n步骤3', [])
    expect(three.details['流程完整性']?.score).toBe(0.6)
    const five = evaluatePatentContent('workflow', '步骤1\n步骤2\n步骤3\n步骤4\n步骤5', [])
    expect(five.details['流程完整性']?.score).toBe(1)
    const none = evaluatePatentContent('workflow', '没有步骤标记', [])
    expect(none.details['流程完整性']?.score).toBe(0)
  })

  it('detects workflow steps written as markdown headings, lists, or ordinals', () => {
    const markdown = [
      '## 步骤1 检索现有技术',
      '## 步骤2 解析权利要求',
      '## 步骤3 构建对照表',
    ].join('\n')
    expect(evaluatePatentContent('workflow', markdown, []).details['流程完整性']?.score).toBe(0.6)

    const listed = [
      '- 步骤1 检索现有技术',
      '- 步骤2 解析权利要求',
      '1. 构建对照表',
      '2. 输出报告',
      '3. 复核',
    ].join('\n')
    expect(evaluatePatentContent('workflow', listed, []).details['流程完整性']?.score).toBe(1)

    const ordinals = ['第一步：检索', '第二阶段：解析', '第三环节：比对'].join('\n')
    expect(evaluatePatentContent('workflow', ordinals, []).details['流程完整性']?.score).toBe(0.6)
  })

  it('counts one line once and ignores inline mentions of 步骤', () => {
    const inline = ['本发明的处理流程如下所述。', '如该步骤中所述，壳体由不锈钢制成。'].join('\n')
    expect(evaluatePatentContent('workflow', inline, []).details['流程完整性']?.score).toBe(0)

    const repeated = '步骤1 步骤2 步骤3'
    expect(evaluatePatentContent('workflow', repeated, []).details['流程完整性']?.details).toBe('检出 1 个工作流步骤')

    const statute = '第二十二条第三款的规定'
    expect(evaluatePatentContent('workflow', statute, []).details['流程完整性']?.score).toBe(0)
  })

  it('scores the retrieval query form at every threshold', () => {
    const two = evaluatePatentContent('retrieval', 'a b', [])
    expect(two.details['关键词条数']?.score).toBe(0.5)
    const none = evaluatePatentContent('retrieval', '   ', [])
    expect(none.details['关键词条数']?.score).toBe(0)
    expect(none.details['关键词条数']?.passed).toBe(false)
  })

  it('scores citation coverage with and without a required list', () => {
    const withList = evaluatePatentContent('citations', '第二十二条第三款', ['第二十二条第三款', '第二十二条第二款'])
    expect(withList.details['引用合规性']?.score).toBe(0.5)
    const freeForm = evaluatePatentContent('citations', '依据第22条第3款 驳回理由', [])
    expect(freeForm.details['引用合规性']?.score).toBe(1)
    expect(freeForm.details['引用格式']?.score).toBe(1)
    const bare = evaluatePatentContent('citations', '涉及第X条的情况', [])
    expect(bare.details['引用合规性']?.score).toBe(0.3)
    expect(bare.details['引用格式']?.score).toBe(0.3)
  })

  it('scores content sufficiency across every length band', () => {
    const bands: Array<[string, number]> = [
      ['短'.repeat(30), 0.1],
      ['中'.repeat(120), 0.3],
      ['长'.repeat(300), 0.5],
      ['更'.repeat(700), 0.7],
      ['巨'.repeat(1200), 0.6],
      [`巨\n\n${'分'.repeat(1200)}\n\n${'段'.repeat(1200)}`, 1],
    ]
    for (const [content, expected] of bands) {
      const out = evaluatePatentContent('report', content, [])
      expect(out.details['内容充分性']?.score).toBe(expected)
    }
  })
})

describe('rule_check default scopes', () => {
  it('runs the bundled compliance rules without injected loaders', async () => {
    const tool = createRuleCheckTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: 'x', scope: 'patent' }, 'rc-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('rule_check(patent)')
  })

  it('defaults the scope to patent through the tool', async () => {
    const ctx = await ctxWith(createRuleCheckTool())
    const result = await execute(ctx, 'rule_check', { text: 'x' }, 'rc-1b')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('rule_check(patent)')
  })

  it('assembles an injected pack with header, warnings, and per-rule rendering', async () => {
    const ruleSet: RuleSet = {
      rules: [
        { id: 'p1', name: '规则一', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['禁止'] }, legalBasis: '专利法 A2' },
      ],
    }
    const pack = () => ({
      ruleSet,
      sources: ['base'],
      warnings: ['清单缺失，回退 base'],
      layers: new Map([['r1', 'base'], ['r2', 'domain:mechanical']]),
      manifestPath: null,
      manifestMtimeMs: null,
    })
    const tool = createRuleCheckTool({ pack, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '含禁止词', scope: 'pack' }, 'rc-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('规则分层')
    expect(text(result)).toContain('加载警告')
    expect(text(result)).toContain('p1')
    expect(text(result)).toContain('依据：专利法 A2')

    // 第二次调用走缓存命中路径。
    const again = await execute(ctx, 'rule_check', { text: '含禁止词', scope: 'pack' }, 'rc-3')
    expect(again.isError).toBe(false)
  })

  it('runs the electrical scope through an injected loader', async () => {
    const ruleSet: RuleSet = { rules: [{ id: 'e1', name: '电学规则', severity: 'critical', action: 'block', check: { type: 'keyword_blocklist', keywords: ['电路'] } }] }
    const tool = createRuleCheckTool({ loader: scope => (scope === 'patent-electrical' ? ruleSet : { rules: [] }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '电路', scope: 'patent-electrical' }, 'rc-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('e1')
  })

  it('loads the bundled electrical, full, and unknown scopes without a loader', async () => {
    const ctx = await ctxWith(createRuleCheckTool())
    const electrical = await execute(ctx, 'rule_check', { text: 'x', scope: 'patent-electrical' }, 'rc-5')
    expect(electrical.isError).toBe(false)
    const full = await execute(ctx, 'rule_check', { text: 'x', scope: 'patent-full' }, 'rc-6')
    expect(full.isError).toBe(false)
    const unknown = await execute(ctx, 'rule_check', { text: 'x', scope: 'bogus' }, 'rc-7')
    expect(unknown.isError).toBe(true)
    if (!unknown.isError) throw new Error('expected failure')
    expect(text(unknown)).toContain('patent-oa-response')
    expect(text(unknown)).toContain('patent-infringement')
  })

  it('loads the default layered pack without an injected pack loader', async () => {
    const tool = createRuleCheckTool({ synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: 'x', scope: 'pack' }, 'rc-8')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('rule_check(pack)')
  })

  it('filters a job scope to that job domains over the bundled assets', async () => {
    const sample = '被控产品的壁厚大约为 5mm 左右，与权利要求 1 的数值范围构成等同。侵权诉讼时效为两年。'
    const ctx = await ctxWith(createRuleCheckTool())
    const full = await execute(ctx, 'rule_check', { text: sample, scope: 'patent-full' }, 'rc-9')
    expect(full.isError).toBe(false)
    if (full.isError) throw new Error('expected success')
    // 权利要求域规则在 patent-full 下命中，在侵权 scope 下不参与评估（域被过滤）。
    expect(text(full)).toContain('EX-CLM-001')
    const scoped = await execute(ctx, 'rule_check', { text: sample, scope: 'patent-infringement' }, 'rc-10')
    expect(scoped.isError).toBe(false)
    if (scoped.isError) throw new Error('expected success')
    expect(text(scoped)).toContain('rule_check(patent-infringement)')
    expect(text(scoped)).toContain('LAW-TIMELIMIT-001')
    expect(text(scoped)).not.toContain('EX-CLM-001')
  })

  it('applies the job domains to an injected loader and reports the job scope in the error list', async () => {
    const ruleSet = {
      rules: [
        { id: 'in-scope', name: '侵权规则', domain: 'patent_infringement', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['等同'] } },
        { id: 'out-of-scope', name: '权利要求规则', domain: 'patent_claims', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['等同'] } },
      ],
    } as unknown as RuleSet
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '等同', scope: 'patent-infringement' }, 'rc-11')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('in-scope')
    expect(text(result)).not.toContain('out-of-scope')
  })

  it('renders a structural violation without evidence', async () => {
    const ruleSet: RuleSet = {
      rules: [
        {
          id: 's1',
          name: '结构规则',
          severity: 'critical',
          action: 'block',
          check: { type: 'structural_analysis', minConfidence: 1, requiresAll: [{ element: '结构', patterns: ['结构完整'] }] },
        },
      ],
    }
    const tool = createRuleCheckTool({ loader: () => ruleSet, synonyms: () => new Map() })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'rule_check', { text: '无结构内容', scope: 'patent' }, 'rc-9')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('s1')
    expect(text(result)).not.toContain('命中「')
  })
})

describe('claim_chart_build success paths', () => {
  const chartJson = JSON.stringify({
    elements: [{ id: '1a', claimNo: 1, kind: 'element', text: '一种装置' }, { id: '1b', claimNo: 1, kind: 'element', text: '包括壳体' }],
    rows: [{ elementId: '1a', targetId: 'D1', quote: '对比方案', pinCite: '[D1 段[0032]]', mapping: 'not-found' }],
  })

  it('builds a chart with a gap list and persisted paths', async () => {
    const original = process.cwd()
    const temp = await mkdtemp(join(tmpdir(), 'dsh-claim-chart-'))
    try {
      process.chdir(temp)
      const sourcePath = join(temp, 'd1.txt')
      await writeFile(sourcePath, '对比文件D1：[0032] 对比方案公开了特征。')
      const tool = createClaimChartBuildTool({ model: jsonModel(chartJson) })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'claim_chart_build', {
        mode: 'invalidity',
        claim_text: '1. 一种装置，包括壳体。',
        targets: [{ id: 'D1', kind: 'prior-art', title: '对比文件1', source_path: sourcePath }],
        case_id: 'case-1',
      }, 'cc-3')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('- 1a→D1（not-found）')
      expect(text(result)).toContain('落盘')
    } finally {
      process.chdir(original)
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects a case_id that would escape data/cases', async () => {
    const tool = createClaimChartBuildTool({ model: jsonModel(chartJson) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{ id: 'D1', kind: 'prior-art' }],
      case_id: '../../escape',
    }, 'cc-case-id')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('case_id')
    expect(text(result)).toContain('single path segment')
  })

  it('rejects null and incomplete targets with a field-level input error', async () => {
    const tool = createClaimChartBuildTool({ model: jsonModel(chartJson) })
    const ctx = await ctxWith(tool)
    const nullEntry = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [null],
    }, 'cc-target-null')
    expect(nullEntry.isError).toBe(true)
    expect(text(nullEntry)).toContain('targets[0] 必须是对象')

    const missingId = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{}],
    }, 'cc-target-id')
    expect(missingId.isError).toBe(true)
    expect(text(missingId)).toContain('targets[0].id 必须是字符串')

    const blankId = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{ id: '  ', kind: 'prior-art' }],
    }, 'cc-target-blank-id')
    expect(blankId.isError).toBe(true)
    expect(text(blankId)).toContain('targets[0].id 不能为空')

    const badKind = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{ id: 'D1', kind: 'other' }],
    }, 'cc-target-kind')
    expect(badKind.isError).toBe(true)
    expect(text(badKind)).toContain('targets[0].kind 必须是 prior-art 或 accused-product')

    const badTitle = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{ id: 'D1', kind: 'prior-art', title: 1 }],
    }, 'cc-target-title')
    expect(badTitle.isError).toBe(true)
    expect(text(badTitle)).toContain('targets[0].title 必须是字符串')

    const badSource = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置，包括壳体。',
      targets: [{ id: 'D1', kind: 'prior-art', source_path: 1 }],
    }, 'cc-target-source')
    expect(badSource.isError).toBe(true)
    expect(text(badSource)).toContain('targets[0].source_path 必须是字符串')
  })

  it('builds a gap-free chart when no targets are mapped', async () => {
    const tool = createClaimChartBuildTool({
      model: jsonModel(JSON.stringify({
        elements: [{ id: '1a', claimNo: 1, kind: 'element', text: '一种装置' }],
        rows: [],
      })),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'patentability',
      claim_text: '1. 一种装置。',
      targets: [],
    }, 'cc-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('无 gap（全部要素已映射）。')
  })

  it('maps targets without optional title or source path', async () => {
    const tool = createClaimChartBuildTool({
      model: jsonModel(JSON.stringify({
        elements: [{ id: '1a', claimNo: 1, kind: 'element', text: '一种装置' }],
        rows: [{ elementId: '1a', targetId: 'P', quote: '', pinCite: '', mapping: 'literal' }],
      })),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: '1. 一种装置。',
      targets: [{ id: 'P', kind: 'accused-product' }],
    }, 'cc-6')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('无 gap（全部要素已映射）。')
  })

  it('fails loud when the model output keeps failing validation', async () => {
    const tool = createClaimChartBuildTool({
      model: jsonModel(JSON.stringify({ elements: [{ id: 'x', claimNo: 9, kind: 'e', text: '不存在' }], rows: [] })),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: '1. 一种装置。',
      targets: [],
    }, 'cc-5')
    expect(result.isError).toBe(true)
  })
})

describe('claim_chart_build 侵权确定性结论', () => {
  const claimText = '1. 一种装置，其特征在于，包括壳体。'
  const chartJson = JSON.stringify({
    elements: [
      { id: '1a', claimNo: 1, kind: 'preamble', text: '一种装置' },
      { id: '1b', claimNo: 1, kind: 'limitation', text: '包括壳体' },
    ],
    rows: [
      { elementId: '1a', targetId: '产品A', quote: '为一种装置', pinCite: '[产品A 段[0001]]', mapping: 'literal' },
      { elementId: '1b', targetId: '产品A', quote: '有壳体', pinCite: '[产品A 段[0002]]', mapping: 'doe' },
    ],
  })
  const equivalentTriplet = {
    elementId: '1b',
    targetId: '产品A',
    sameMeans: true,
    sameFunction: true,
    sameEffect: true,
    inventiveEffortRequired: false,
    isEquivalent: true,
  }

  it('存在缺项时报"未覆盖"并列出缺项要素', async () => {
    const ctx = await ctxWith(createClaimChartBuildTool({
      model: jsonModel(JSON.stringify({
        elements: [
          { id: '1a', claimNo: 1, kind: 'preamble', text: '一种装置' },
          { id: '1b', claimNo: 1, kind: 'limitation', text: '包括壳体' },
        ],
        rows: [
          { elementId: '1a', targetId: '产品A', quote: '为一种装置', pinCite: '[产品A 段[0001]]', mapping: 'literal' },
          { elementId: '1b', targetId: '产品A', quote: '', pinCite: '[产品A 段[0002]]', mapping: 'not-found' },
        ],
      })),
    }))
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: claimText,
      targets: [{ id: '产品A', kind: 'accused-product' }],
    }, 'cc-18')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('被控产品 产品A: 存在未覆盖要素（缺项）')
    expect(text(result)).toContain('  - 缺项要素: 1b')
  })

  it('给出覆盖结论与等同矛盾，未给评分事实时不臆测风险等级', async () => {
    const ctx = await ctxWith(createClaimChartBuildTool({ model: jsonModel(chartJson) }))
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: claimText,
      targets: [{ id: '产品A', kind: 'accused-product' }],
    }, 'cc-7')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('## 确定性结论（程序按行级映射判定，未经模型判断）')
    expect(out).toContain('被控产品 产品A: 全部要素已覆盖，其中部分需按等同认定')
    expect(out).toContain('需等同认定的要素: 1b')
    expect(out).toContain('- 等同认定矛盾: 1 条')
    expect(out).toContain('1b→产品A [doe-without-triplet]')
    expect(out).toContain('风险等级: 未计算')
  })

  it('多权项时整体结论取覆盖最佳的权项，并列出逐权项结论', async () => {
    const multiClaimText = '1. 一种装置，其特征在于，包括壳体。\n2. 根据权利要求 1 所述的装置，其特征在于，所述壳体上设置有散热孔。'
    const ctx = await ctxWith(createClaimChartBuildTool({
      model: jsonModel(JSON.stringify({
        elements: [
          { id: '1a', claimNo: 1, kind: 'preamble', text: '一种装置' },
          { id: '1b', claimNo: 1, kind: 'limitation', text: '包括壳体' },
          { id: '2a', claimNo: 2, kind: 'limitation', text: '所述壳体上设置有散热孔' },
        ],
        rows: [
          { elementId: '1a', targetId: '产品A', quote: '一种装置', pinCite: '[产品A 段[0001]]', mapping: 'literal' },
          { elementId: '1b', targetId: '产品A', quote: '包括壳体', pinCite: '[产品A 段[0001]]', mapping: 'literal' },
          { elementId: '2a', targetId: '产品A', quote: '', pinCite: '[产品A 段[0002]]', mapping: 'not-found' },
        ],
      })),
    }))
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: multiClaimText,
      targets: [{ id: '产品A', kind: 'accused-product' }],
    }, 'cc-19')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('被控产品 产品A: 全部要素字面覆盖（要素 2 个')
    expect(out).toContain('逐权项结论: 权利要求 1 literal；权利要求 2 not-covered（整体取覆盖最佳权项）')
  })

  it('给出等同认定记录与抗辩事实时核验一致性并给出风险等级', async () => {
    const ctx = await ctxWith(createClaimChartBuildTool({ model: jsonModel(chartJson) }))
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: claimText,
      targets: [{ id: '产品A', kind: 'accused-product' }],
      risk: { defenses: ['low'], remedyExposureRatio: 0.5, equivalents: [equivalentTriplet] },
    }, 'cc-8')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    // 认定记录与图表一致（doe 行有认定且认定等同）→ 无矛盾，等同要素计入覆盖。
    expect(out).toContain('- 等同认定矛盾: 0 条')
    expect(out).toContain('风险等级: high（加权 0.850')
  })

  it('认定记录否定等同而图表按等同落格时报矛盾', async () => {
    const ctx = await ctxWith(createClaimChartBuildTool({ model: jsonModel(chartJson) }))
    const result = await execute(ctx, 'claim_chart_build', {
      mode: 'infringement',
      claim_text: claimText,
      targets: [{ id: '产品A', kind: 'accused-product' }],
      risk: {
        remedyExposureRatio: 0,
        estoppelApplied: true,
        dedicationApplied: true,
        equivalents: [{ ...equivalentTriplet, isEquivalent: false }],
      },
    }, 'cc-9')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('1b→产品A [triplet-denies-doe]')
    // 禁止反悔与捐献规则均适用：两个维度计 0，风险等级随之下降。
    expect(text(result)).toContain('风险等级: medium')
  })

  it('评分事实非法时报输入错误，不静默出分', async () => {
    const ctx = await ctxWith(createClaimChartBuildTool({ model: jsonModel(chartJson) }))
    const bad = async (risk: unknown, label: string) => {
      const outcome = await execute(ctx, 'claim_chart_build', {
        mode: 'infringement',
        claim_text: claimText,
        targets: [{ id: '产品A', kind: 'accused-product' }],
        risk,
      }, label)
      expect(outcome.isError).toBe(true)
    }
    await bad({ remedyExposureRatio: 1.5 }, 'cc-10')
    await bad({ remedyExposureRatio: 0.5, defenses: ['strong'] }, 'cc-11')
    await bad({ remedyExposureRatio: 0.5, equivalents: [{ ...equivalentTriplet, sameMeans: 'yes' }] }, 'cc-12')
    await bad([1, 2], 'cc-13')
    await bad({}, 'cc-15')
    await bad({ remedyExposureRatio: 0.5, equivalents: 'not-an-array' }, 'cc-16')
    await bad({ remedyExposureRatio: 0.5, equivalents: [null] }, 'cc-17')
    await bad({ remedyExposureRatio: 0.5, equivalents: [{ ...equivalentTriplet, elementId: 7 }] }, 'cc-19')
    await bad({ remedyExposureRatio: 0.5, equivalents: [{ ...equivalentTriplet, elementId: undefined }] }, 'cc-20')
    await bad({ remedyExposureRatio: 0.5, defenses: 'high' }, 'cc-21')
  })

  it('无效模式给单篇全覆盖结论段，不给侵权结论段；无可判定的模式两者都不给', async () => {
    const model = jsonModel(JSON.stringify({
      elements: [{ id: '1a', claimNo: 1, kind: 'preamble', text: '一种装置' }],
      rows: [{ elementId: '1a', targetId: 'D1', quote: '', pinCite: '[D1 段[0001]]', mapping: 'not-found' }],
    }))
    const ctx = await ctxWith(createClaimChartBuildTool({ model }))
    const invalidity = await execute(ctx, 'claim_chart_build', {
      mode: 'invalidity',
      claim_text: claimText,
      targets: [{ id: 'D1', kind: 'prior-art' }],
    }, 'cc-14')
    expect(invalidity.isError).toBe(false)
    if (invalidity.isError) throw new Error('expected success')
    expect(text(invalidity)).toContain('单篇全覆盖与区别特征')
    expect(text(invalidity)).toContain('权利要求 1: 未全覆盖')
    expect(text(invalidity)).toContain('区别特征')
    // 侵权结论段（全面覆盖与风险等级）不因无效模式出现。
    expect(text(invalidity)).not.toContain('风险等级')

    for (const mode of ['patentability', 'oa-response'] as const) {
      const result = await execute(ctx, 'claim_chart_build', {
        mode,
        claim_text: claimText,
        targets: [{ id: 'D1', kind: 'prior-art' }],
      }, `cc-${mode}`)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).not.toContain('确定性结论')
    }
  })
})

describe('knowledge_note_save', () => {
  it('persists a note and derives a deterministic id', async () => {
    const written: unknown[] = []
    const tool = createKnowledgeNoteSaveTool({
      writeNote: async (note) => {
        written.push(note)
        return { saved: true, path: '/tmp/notes/x.md' }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'knowledge_note_save', { title: 'OA 答复要点', content: '正文', project: '案1' }, 'kn-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('已沉淀笔记')
    const note = written[0] as { documentId: string; title: string; project: string }
    expect(note.documentId).toBe(noteDocumentId('案1', 'OA 答复要点', '正文'))
    expect(note.project).toBe('案1')
  })

  it('skips duplicates and empty content', async () => {
    const tool = createKnowledgeNoteSaveTool({
      writeNote: async () => ({ saved: false, reason: 'duplicate' as const }),
    })
    const ctx = await ctxWith(tool)
    const dup = await execute(ctx, 'knowledge_note_save', { title: 't', content: 'c' }, 'kn-2')
    expect(text(dup)).toContain('已存在')
    const empty = await execute(ctx, 'knowledge_note_save', { title: '   ', content: 'c' }, 'kn-3')
    expect(empty.isError).toBe(false)
    expect(text(empty)).toContain('跳过')
  })

  it('rejects oversized fields and wraps write failures', async () => {
    const tool = createKnowledgeNoteSaveTool({
      writeNote: async () => { throw new Error('disk full') },
    })
    const ctx = await ctxWith(tool)
    const longTitle = await execute(ctx, 'knowledge_note_save', { title: 't'.repeat(201), content: 'c' }, 'kn-4')
    expect(longTitle.isError).toBe(true)
    const longContent = await execute(ctx, 'knowledge_note_save', { title: 't', content: 'c'.repeat(20001) }, 'kn-4b')
    expect(longContent.isError).toBe(true)
    const failed = await execute(ctx, 'knowledge_note_save', { title: 't', content: 'c' }, 'kn-5')
    expect(failed.isError).toBe(true)
  })

  it('wraps a non-Error write failure as tool_execution_failed', async () => {
    const tool = createKnowledgeNoteSaveTool({
      writeNote: async () => { throw 'boom-string' },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'knowledge_note_save', { title: 't', content: 'c' }, 'kn-5b')
    expect(result.isError).toBe(true)
  })

  it('propagates the setup_required stub from an unwired writer', async () => {
    const tool = createKnowledgeNoteSaveTool({
      writeNote: async () => { throw new PatentToolError('setup_required', '未接线', {}) },
    })
    await expect(tool.execute({ title: 't', content: 'c' }, { signal } as never)).rejects.toMatchObject({
      code: 'setup_required',
    })
  })
})

describe('recognize_chemical_structure', () => {
  it('rejects an image mode without a path and a text mode without text', async () => {
    const tool = createRecognizeChemicalStructureTool()
    await expect(tool.execute({ mode: 'image' }, { signal } as never)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    await expect(tool.execute({ mode: 'text', text: '  ' }, { signal } as never)).rejects.toMatchObject({ code: 'invalid_tool_input' })
  })

  it('returns the canonical unavailable result in auto mode', async () => {
    const tool = createRecognizeChemicalStructureTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'recognize_chemical_structure', { image_path: 'mol.png', text: 'CCO' }, 'cs-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('化学结构识别不可用')
    expect(text(result)).toContain('化学识别引擎未接入')
  })

  it('dispatches auto mode on image-only and text-only input', async () => {
    const tool = createRecognizeChemicalStructureTool()
    const imageOnly = await tool.execute({ image_path: 'mol.png' }, { signal } as never)
    expect(imageOnly).toMatchObject({ imagePath: 'mol.png', usable: false })
    expect(imageOnly).not.toHaveProperty('sourceText')
    const textOnly = await tool.execute({ text: 'CCO' }, { signal } as never)
    expect(textOnly).toMatchObject({ sourceText: 'CCO', usable: false })
    expect(textOnly).not.toHaveProperty('imagePath')
  })

  it('renders the usable-result prose with candidates', () => {
    const out = renderChemicalStructure({
      kind: 'structure',
      candidates: [
        { smiles: 'CCO', confidence: 0.9, valid: true },
        { smiles: 'CC', confidence: 0.5, valid: false, validationError: 'bad' },
      ],
      chosenIndex: 0,
      canonicalSmiles: 'CCO',
      formula: 'C2H6O',
      names: ['乙醇'],
      confidence: 0.9,
      warnings: ['需人工核对'],
      needHumanReview: true,
      usable: true,
      modelUsed: 'm',
    })
    expect(out).toContain('化学结构识别结果（structure，置信度 0.90）')
    expect(out).toContain('名称：乙醇')
    expect(out).toContain('规范化 SMILES：CCO')
    expect(out).toContain('- CCO（valid，置信度 0.90）')
    expect(out).toContain('需人工复核')
  })

  it('renders a bare usable result with unknown reason and no sections', () => {
    const out = renderChemicalStructure({
      kind: 'formula',
      candidates: [],
      chosenIndex: -1,
      confidence: 0,
      names: [],
      warnings: [],
      needHumanReview: false,
      usable: true,
      modelUsed: 'm',
    })
    expect(out).toContain('化学结构识别结果（formula，置信度 0.00）')
  })

  it('renders an unavailable result without warnings as an unknown reason', () => {
    const out = renderChemicalStructure({
      kind: 'structure',
      candidates: [],
      chosenIndex: -1,
      confidence: 0,
      names: [],
      warnings: [],
      needHumanReview: true,
      usable: false,
      modelUsed: 'm',
    })
    expect(out).toContain('未知原因')
  })
})
