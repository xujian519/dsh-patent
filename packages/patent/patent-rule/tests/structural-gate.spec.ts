import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import type { StructuralGateEntry } from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  renderGateUnavailableDenial,
  structuralGateUnresolved,
  textArgDeclarationIssues,
} from '../src/runtime/structural-gate.ts'

const signal = new AbortController().signal

/**
 * A rulesDir fixture: one block-level layout rule, one block-level effect rule,
 * and one warn-level rule (all structural_analysis = absence-based).
 */
function makeRulesFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'patent-rule-structural-'))
  const patentDir = join(root, 'patent')
  mkdirSync(patentDir)
  writeFileSync(
    join(patentDir, 'compliance.yaml'),
    [
      'rules:',
      '  - id: TEST-LAYOUT',
      '    name: 测试独权布局',
      '    severity: critical',
      '    action: block',
      '    legalBasis: 细则第二十一条第二款',
      '    check:',
      '      type: structural_analysis',
      '      requiresAll:',
      '        - element: characterizing',
      '          patterns: ["其特征在于"]',
      '  - id: TEST-EFFECT',
      '    name: 测试有益效果',
      '    severity: critical',
      '    action: block',
      '    check:',
      '      type: structural_analysis',
      '      requiresAll:',
      '        - element: effect',
      '          patterns: ["有益效果"]',
      '  - id: TEST-SOFT',
      '    name: 测试提示级结构',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: structural_analysis',
      '      requiresAll:',
      '        - element: effect',
      '          patterns: ["有益效果"]',
      '  - id: TEST-SYN',
      '    name: 测试同义词',
      '    severity: critical',
      '    action: block',
      '    check:',
      '      type: synonym_match',
      '      requirements:',
      '        - element: claim',
      '          keywords: ["权利要求"]',
    ].join('\n'),
    'utf8',
  )
  return root
}

function planOf(root: string, entries: readonly StructuralGateEntry[]) {
  return PatentRule.resolveStructuralGate(PatentRule.loadPatentFullRuleSet(root).ruleSet, entries)
}

describe('structuralGateText', () => {
  it('拼接声明入参里的全部字符串（记录取全部值、数组逐项展开）', () => {
    const args = {
      sections: { claims: '一种装置，其特征在于：A。', spec: { abstract: '摘要正文' } },
      other: '不参与',
      list: ['甲', '乙'],
    }
    expect(PatentRule.structuralGateText(args, ['sections'])).toBe('一种装置，其特征在于：A。\n摘要正文')
    expect(PatentRule.structuralGateText(args, ['sections', 'list'])).toBe('一种装置，其特征在于：A。\n摘要正文\n甲\n乙')
  })

  it('非字符串值与缺失入参不产出文本', () => {
    expect(PatentRule.structuralGateText({ count: 3, flag: true, nil: null }, ['count', 'flag', 'nil'])).toBe('')
    expect(PatentRule.structuralGateText({ count: 3 }, ['missing'])).toBe('')
    expect(PatentRule.structuralGateText(7, ['sections'])).toBe('')
    expect(PatentRule.structuralGateText(null, ['sections'])).toBe('')
    expect(PatentRule.structuralGateText([{ a: 'x' }], ['a'])).toBe('')
  })
})

describe('resolveStructuralGate', () => {
  it('把规则 id 解析成规则对象', () => {
    const plan = planOf(makeRulesFixture(), [{ tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] }])
    expect(plan.warnings).toEqual([])
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.rules.map(rule => rule.id)).toEqual(['TEST-LAYOUT'])
  })

  it('规则集内不存在的 id 告警并剔除，全部未知则整条不生效', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT', 'NO-SUCH-RULE'] },
      { tool: 'other_tool', textArgs: ['text'], ruleIds: ['NO-SUCH-RULE'] },
    ])
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.rules.map(rule => rule.id)).toEqual(['TEST-LAYOUT'])
    expect(plan.warnings).toEqual([
      '制品结构门禁 render_patent_document: 规则集内不存在规则 NO-SUCH-RULE，该条已忽略',
      '制品结构门禁 other_tool: 规则集内不存在规则 NO-SUCH-RULE，该条已忽略',
      '制品结构门禁 other_tool: 没有可用规则，该条不生效',
    ])
  })

  it('空 textArgs 告警并剔除该条', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: [], ruleIds: ['TEST-LAYOUT'] },
    ])
    expect(plan.entries).toEqual([])
    expect(plan.warnings).toEqual([
      '制品结构门禁 render_patent_document: 未声明承载制品文本的 textArgs，该条不生效',
    ])
  })

  it('非 block 规则告警，说明该条不会拒绝调用', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-SOFT'] },
    ])
    expect(plan.entries).toHaveLength(1)
    expect(plan.warnings.some(w => w.includes('action 为 warn') && w.includes('不会拒绝调用'))).toBe(true)
  })

  it('空声明得到空计划', () => {
    const plan = planOf(makeRulesFixture(), [])
    expect(plan.entries).toEqual([])
    expect(plan.warnings).toEqual([])
  })

  it('按工具入参声明核对 textArgs：未知入参告警，工具未注册时留给运行期', () => {
    const lookup = (tool: string): Record<string, unknown> | undefined =>
      tool === 'render_patent_document' ? { template: {}, sections: {} } : undefined
    const plan = PatentRule.resolveStructuralGate(
      PatentRule.loadPatentFullRuleSet(makeRulesFixture()).ruleSet,
      [
        { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] },
        { tool: 'render_patent_document', textArgs: ['draftt'], ruleIds: ['TEST-LAYOUT'] },
        { tool: 'unregistered_tool', textArgs: ['draft'], ruleIds: ['TEST-LAYOUT'] },
      ],
      lookup,
    )
    expect(plan.entries).toHaveLength(3)
    expect(plan.warnings).toEqual([
      '制品结构门禁 render_patent_document: 入参 draftt 不在 render_patent_document 的入参声明里，运行期会拒绝该工具的调用',
    ])
  })

  it('strict 声明遇到未知 textArgs 时在加载期失败', () => {
    const lookup = (): Record<string, unknown> => ({ draft: {} })
    expect(() => PatentRule.resolveStructuralGate(
      PatentRule.loadPatentFullRuleSet(makeRulesFixture()).ruleSet,
      [{ tool: 'render_patent_document', textArgs: ['draftt'], ruleIds: ['TEST-LAYOUT'], strict: true }],
      lookup,
    )).toThrow(/draftt/)
  })

  it('批量核对入参名：读 JSON Schema 的 properties，未注册工具跳过', () => {
    const lookup = (tool: string): Record<string, unknown> | undefined =>
      tool === 'render_patent_document' ? { type: 'object', properties: { draft: {} } } : undefined
    expect(textArgDeclarationIssues([
      { tool: 'render_patent_document', textArgs: ['draft'] },
      { tool: 'render_patent_document', textArgs: ['draftt'] },
      { tool: 'unregistered_tool', textArgs: ['text'] },
    ], lookup)).toEqual(['render_patent_document 的入参声明里没有 draftt'])
  })
})

describe('resolveStructuralGate strict 声明', () => {
  it('未知规则 id 在加载期失败，而不是丢弃该条', () => {
    let thrown: unknown
    try {
      planOf(makeRulesFixture(), [
        { tool: 'render_patent_document', textArgs: ['draft'], ruleIds: ['PR-OA-007'], strict: true },
      ])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PatentRule.StructuralGateConfigError)
    const error = thrown as PatentRule.StructuralGateConfigError
    expect(error.code).toBe('STRUCTURAL_GATE_UNRESOLVED')
    expect(error.name).toBe('StructuralGateConfigError')
    expect(error.message).toContain('strict')
    expect(error.message).toContain('制品结构门禁 render_patent_document（strict）: 规则集内不存在规则 PR-OA-007')
  })

  it('规则存在但不是 block 级也在加载期失败', () => {
    expect(() => planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-SOFT'], strict: true },
    ])).toThrow(/规则 TEST-SOFT 的 action 为 warn/)
  })

  it('条目本身无法执行（textArgs 为空 / ruleIds 全空）同样在加载期失败', () => {
    expect(() => planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: [], ruleIds: ['TEST-LAYOUT'], strict: true },
    ])).toThrow(/未声明承载制品文本的 textArgs/)
    expect(() => planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['draft'], ruleIds: [], strict: true },
    ])).toThrow(/没有可用规则/)
  })

  it('同一批里多条 strict 失败一次报全', () => {
    let message = ''
    try {
      planOf(makeRulesFixture(), [
        { tool: 'render_patent_document', textArgs: ['draft'], ruleIds: ['NO-SUCH-RULE'], strict: true },
        { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-SOFT'], strict: true },
      ])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('规则集内不存在规则 NO-SUCH-RULE')
    expect(message).toContain('规则 TEST-SOFT 的 action 为 warn')
  })

  it('strict 只约束声明了它的条目：同批非 strict 条目仍按告警口径放行', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['draft'], ruleIds: ['NO-SUCH-RULE'] },
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'], strict: true },
    ])
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.rules.map(rule => rule.id)).toEqual(['TEST-LAYOUT'])
    expect(plan.warnings).toEqual([
      '制品结构门禁 render_patent_document: 规则集内不存在规则 NO-SUCH-RULE，该条已忽略',
      '制品结构门禁 render_patent_document: 没有可用规则，该条不生效',
    ])
  })

  it('显式 strict: false 与未声明等价，不抛错', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['draft'], ruleIds: ['NO-SUCH-RULE'], strict: false },
    ])
    expect(plan.entries).toEqual([])
    expect(plan.warnings).toHaveLength(2)
  })
})

describe('structuralGateViolations', () => {
  const entries: StructuralGateEntry[] = [
    { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] },
    {
      tool: 'render_patent_document',
      textArgs: ['sections'],
      ruleIds: ['TEST-EFFECT'],
      whenArgs: { template: 'claims-spec' },
    },
  ]

  it('命中 block 级结构规则即产出违规', () => {
    const plan = planOf(makeRulesFixture(), entries)
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      sections: { claims: '一种装置，包括：A。' },
    })
    expect(violations.map(violation => violation.ruleId)).toEqual(['TEST-LAYOUT'])
    expect(violations[0]?.action).toBe('block')
  })

  it('whenArgs 精确匹配才生效', () => {
    const plan = planOf(makeRulesFixture(), entries)
    const matched = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      template: 'claims-spec',
      sections: { claims: '一种装置，其特征在于：A。' },
    })
    expect(matched.map(violation => violation.ruleId)).toEqual(['TEST-EFFECT'])
    const mismatched = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      template: 'oa-response',
      sections: { claims: '一种装置，其特征在于：A。' },
    })
    expect(mismatched).toEqual([])
  })

  it('入参不是记录时 whenArgs 不匹配', () => {
    const plan = planOf(makeRulesFixture(), entries)
    expect(PatentRule.structuralGateViolations(plan, 'render_patent_document', null)).toEqual([])
  })

  it('工具不匹配或制品文本为空时不判', () => {
    const plan = planOf(makeRulesFixture(), entries)
    expect(PatentRule.structuralGateViolations(plan, 'other_tool', { sections: { claims: '一种装置' } })).toEqual([])
    expect(PatentRule.structuralGateViolations(plan, 'render_patent_document', { sections: { claims: '   ' } })).toEqual([])
    expect(PatentRule.structuralGateViolations(plan, 'render_patent_document', { sections: { page: 3 } })).toEqual([])
  })

  it('synonym_match 使用传入的同义词表', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-SYN'] },
    ])
    const args = { sections: { claims: '权项 1 限定了一种装置。' } }
    expect(PatentRule.structuralGateViolations(plan, 'render_patent_document', args).map(v => v.ruleId))
      .toEqual(['TEST-SYN'])
    const synonyms = new Map([['权利要求', ['权项']]])
    expect(PatentRule.structuralGateViolations(plan, 'render_patent_document', args, synonyms)).toEqual([])
  })

  it('只取 block 级：warn 级结构规则命中不算门禁违规', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-SOFT'] },
    ])
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      sections: { claims: '一种装置，其特征在于：A。' },
    })
    expect(violations).toEqual([])
  })
})

describe('structuralGateUnresolved', () => {
  const entries: StructuralGateEntry[] = [
    { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] },
  ]

  it('取不到声明入参的文本时给出拒绝原因，有文本时为空', () => {
    const plan = planOf(makeRulesFixture(), entries)
    expect(structuralGateUnresolved(plan, 'render_patent_document', { sections: { claims: '一种装置。' } }))
      .toEqual([])
    expect(structuralGateUnresolved(plan, 'render_patent_document', { draft: '一种装置。' }))
      .toEqual(['入参 sections 未提供'])
  })

  it('入参名不在工具声明里时给出拒绝原因', () => {
    const plan = planOf(makeRulesFixture(), [
      { tool: 'render_patent_document', textArgs: ['draftt'], ruleIds: ['TEST-LAYOUT'] },
    ])
    expect(structuralGateUnresolved(
      plan,
      'render_patent_document',
      { draftt: '一种装置。' },
      { draft: {} },
    )).toEqual(['入参 draftt 不在 render_patent_document 的入参声明里'])
  })

  it('工具或 whenArgs 不匹配时不参与', () => {
    const plan = planOf(makeRulesFixture(), [
      {
        tool: 'render_patent_document',
        textArgs: ['sections'],
        ruleIds: ['TEST-LAYOUT'],
        whenArgs: { template: 'claims-spec' },
      },
    ])
    expect(structuralGateUnresolved(plan, 'other_tool', {})).toEqual([])
    expect(structuralGateUnresolved(plan, 'render_patent_document', { template: 'oa-response' })).toEqual([])
  })

  it('拒绝理由说明门禁无法执行及原因', () => {
    const text = renderGateUnavailableDenial('render_patent_document', ['入参 draft 未提供'])
    expect(text).toContain('门禁无法执行 render_patent_document')
    expect(text).toContain('入参 draft 未提供')
    expect(text).toContain('拒绝该次调用')
  })
})

describe('renderStructuralGateDenial', () => {
  it('给出规则编号、名称、说明与依据', () => {
    const plan = planOf(makeRulesFixture(), [{ tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] }])
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', { sections: { claims: '一种装置。' } })
    const text = PatentRule.renderStructuralGateDenial('render_patent_document', violations)
    expect(text).toContain('拒绝 render_patent_document')
    expect(text).toContain('TEST-LAYOUT')
    expect(text).toContain('测试独权布局')
    expect(text).toContain('依据：细则第二十一条第二款')
  })

  it('规则未声明依据时不出现依据括注', () => {
    const plan = planOf(makeRulesFixture(), [{ tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-EFFECT'] }])
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', { sections: { claims: '一种装置。' } })
    const text = PatentRule.renderStructuralGateDenial('render_patent_document', violations)
    expect(text).not.toContain('依据')
  })
})

describe('structural gate apply', () => {
  function documentTool() {
    return defineContentToolFixture({
      name: 'render_patent_document',
      description: 'render',
      parameters: { draft: { type: 'string' } },
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'ok' }] },
    })
  }

  async function mounted(textArgs: string[], strict: boolean): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(documentTool())
    await ctx.plugin(PatentRule, {
      rulesDir: makeRulesFixture(),
      structuralGate: [{ tool: 'render_patent_document', textArgs, ruleIds: ['TEST-LAYOUT'], strict }],
    })
    return ctx
  }

  it('strict textArgs 与已注册工具的入参不一致时加载失败', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(documentTool())
    await expect(ctx.plugin(PatentRule, {
      rulesDir: makeRulesFixture(),
      structuralGate: [{ tool: 'render_patent_document', textArgs: ['draftt'], ruleIds: ['TEST-LAYOUT'], strict: true }],
    })).rejects.toThrow(/draftt/)
  })

  it('运行期取不到声明入参的文本时拒绝调用', async () => {
    const ctx = await mounted(['draftt'], false)
    const result = await executeToolFixture(ctx, {
      name: 'render_patent_document',
      callId: ToolCallId('structural-drift'),
      arguments: { draft: '一种装置，其特征在于：A。' },
      signal,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('门禁无法执行')
    expect(result.error?.message).toContain('draftt')
  })
})

describe('selectGateRules 检查族', () => {
  it('默认只保留 keyword_blocklist，选中结构族时保留结构规则', () => {
    const ruleSet = PatentRule.loadPatentFullRuleSet(makeRulesFixture()).ruleSet
    expect(PatentRule.selectGateRules(ruleSet).rules).toEqual([])
    expect(
      PatentRule.selectGateRules(ruleSet, ['structural_analysis']).rules.map(rule => rule.id),
    ).toEqual(['TEST-LAYOUT', 'TEST-EFFECT', 'TEST-SOFT'])
  })

  it('isGateCheckType 只认已声明的检查族', () => {
    expect(PatentRule.isGateCheckType('structural_analysis')).toBe(true)
    expect(PatentRule.isGateCheckType('keyword_blocklist')).toBe(true)
    expect(PatentRule.isGateCheckType('relevance')).toBe(false)
  })
})

describe('tools/pre-execute 制品结构门禁', () => {
  function documentTool(name = 'render_patent_document') {
    return defineContentToolFixture({
      name,
      description: 'render',
      parameters: { template: { type: 'string' }, sections: { type: 'object', additionalProperties: true } },
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'HTML written: out.html' }] },
    })
  }

  async function mount(config: PatentRule.Config): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PatentRule, config)
    return ctx
  }

  function call(ctx: Context, args: Record<string, unknown>) {
    return executeToolFixture(ctx, {
      name: 'render_patent_document',
      callId: ToolCallId('structural-call'),
      arguments: args,
      signal,
    })
  }

  it('制品文本命中 block 级结构规则即拒绝该次调用', async () => {
    const ctx = await mount({
      rulesDir: makeRulesFixture(),
      structuralGate: [{ tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] }],
    })
    ctx.tools.register(documentTool())
    const result = await call(ctx, { template: 'claims-spec', sections: { claims: '一种装置，包括：A。' } })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-LAYOUT/)
    expect(result.error?.message).toMatch(/制品结构门禁拒绝 render_patent_document/)
  })

  it('制品合格时放行，且未声明的工具不受影响', async () => {
    const ctx = await mount({
      rulesDir: makeRulesFixture(),
      structuralGate: [{ tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] }],
    })
    ctx.tools.register(documentTool())
    ctx.tools.register(documentTool('other_tool'))
    const allowed = await call(ctx, { template: 'claims-spec', sections: { claims: '一种装置，其特征在于：A。' } })
    expect(allowed.isError).toBe(false)
    const other = await executeToolFixture(ctx, {
      name: 'other_tool',
      callId: ToolCallId('other-call'),
      arguments: { sections: { claims: '一种装置。' } },
      signal,
    })
    expect(other.isError).toBe(false)
  })

  it('whenArgs 不匹配时该条不适用', async () => {
    const ctx = await mount({
      rulesDir: makeRulesFixture(),
      structuralGate: [{
        tool: 'render_patent_document',
        textArgs: ['sections'],
        ruleIds: ['TEST-EFFECT'],
        whenArgs: { template: 'claims-spec' },
      }],
    })
    ctx.tools.register(documentTool())
    const result = await call(ctx, { template: 'oa-response', sections: { body: '答复如下。' } })
    expect(result.isError).toBe(false)
  })

  it('未声明制品结构门禁时不做 pre-execute 判定（opt-in）', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(documentTool())
    const result = await call(ctx, { template: 'claims-spec', sections: { claims: '一种装置，包括：A。' } })
    expect(result.isError).toBe(false)
  })

  it('strict 声明无法解析时插件加载失败，而不是带着未装上的门禁继续跑', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(PatentRule, {
      rulesDir: makeRulesFixture(),
      structuralGate: [{ tool: 'render_patent_document', textArgs: ['draft'], ruleIds: ['PR-OA-007'], strict: true }],
    })).rejects.toThrow(PatentRule.StructuralGateConfigError)
  })

  it('未知规则 id、未知门禁检查族与「缺失即违规」族都告警但不阻塞挂载', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(PatentRule, {
      rulesDir: makeRulesFixture(),
      gateCheckTypes: ['keyword_blocklist', 'not_a_check_type', 'structural_analysis'],
      structuralGate: [
        { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['NO-SUCH-RULE'] },
        { tool: 'render_patent_document', textArgs: ['sections'], ruleIds: ['TEST-LAYOUT'] },
      ],
    })
    ctx.tools.register(documentTool())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('未知的门禁检查类型 "not_a_check_type"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"structural_analysis" 是「缺失即违规」族'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('规则集内不存在规则 NO-SUCH-RULE'))
    const result = await call(ctx, { template: 'claims-spec', sections: { claims: '一种装置。' } })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-LAYOUT/)
    warnSpy.mockRestore()
  })
})

describe('OA 答复的制品结构门禁：PR-OA-007（2026-10-16 审阅甲7）', () => {
  const entry: StructuralGateEntry = {
    tool: 'render_patent_document',
    textArgs: ['draft'],
    ruleIds: ['PR-OA-007'],
    whenArgs: { template: 'oa-response' },
  }
  const plan = PatentRule.resolveStructuralGate(PatentRule.loadPatentFullRuleSet().ruleSet, [entry])
  const oaRule = PatentRule.loadPatentFullRuleSet().ruleSet.rules.find(rule => rule.id === 'PR-OA-007')

  it('26.3 答复缺判准落位（三项判准全缺）→ 拒绝', () => {
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      template: 'oa-response',
      draft: '说明书未记载相关技术手段，本申请符合专利法第二十六条第三款的规定。',
    })
    expect(violations.map(violation => violation.ruleId)).toEqual(['PR-OA-007'])
    expect(violations[0]?.action).toBe('block')
  })

  it('三项判准齐全的合规答复 → 放行', () => {
    const violations = PatentRule.structuralGateViolations(plan, 'render_patent_document', {
      template: 'oa-response',
      draft: '说明书第[0032]段记载了滤芯的活性炭配比与成型方法；对于本领域技术人员而言，能够实现该技术方案，符合专利法第二十六条第三款的规定。',
    })
    expect(violations).toEqual([])
  })

  it('判据修复：插词写法（第N段记载）计入依据，否定式（未记载）不计入', () => {
    if (oaRule === undefined) throw new Error('规则集缺少 PR-OA-007')
    const base = '本领域技术人员能够实现该方案。符合专利法第二十六条第三款的规定。'
    const negative = PatentRule.evaluateText(`说明书第3段未记载相关特征。${base}`, { rules: [oaRule] })
    expect(negative.violations.map(violation => violation.ruleId)).toEqual(['PR-OA-007'])
    const interpolated = PatentRule.evaluateText(`说明书第3段记载了相关特征。${base}`, { rules: [oaRule] })
    expect(interpolated.violations).toEqual([])
  })
})
