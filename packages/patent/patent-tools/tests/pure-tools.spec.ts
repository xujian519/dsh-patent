import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createPatentEvalTool, evaluatePatentContent } from '../src/tool/patent-eval.ts'
import { createDraftClaimsTool, draftClaims } from '../src/tool/draft-claims.ts'
import { createDraftSpecificationTool, draftSpecification } from '../src/tool/draft-specification.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
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

describe('patent_eval', () => {
  it('scores an empty report at zero', () => {
    const out = evaluatePatentContent('report', '', [])
    expect(out.mode).toBe('report')
    expect(out.passed).toBe(false)
  })

  it('detects missing report sections', () => {
    const out = evaluatePatentContent('report', '# 技术领域\n技术方案', [])
    expect(out.details['结构完整性']).toBeDefined()
    expect(out.details['结构完整性']?.passed).toBe(false)
  })

  it('evaluates citations against required statutes', () => {
    const out = evaluatePatentContent('citations', '第二十二条第三款', ['第二十二条第二款', '第二十二条第三款'])
    expect(out.details['引用合规性']).toBeDefined()
    expect(out.details['引用合规性']?.score).toBe(0.5)
  })

  it('standardizes the search strategy for retrieval mode', () => {
    const out = evaluatePatentContent('retrieval', '创造性 三步法 技术启示', [])
    expect(out.searchStrategy).toBeDefined()
    expect(out.searchStrategy?.query).toBe('创造性 三步法 技术启示')
    expect(out.searchStrategy?.keywords).toEqual(['创造性', '三步法', '技术启示'])
    expect(out.searchStrategy?.hits).toBe(3)
  })

  it('runs through the registered tool', async () => {
    const ctx = await ctxWith(createPatentEvalTool())
    const result = await execute(ctx, 'patent_eval', { mode: 'retrieval', content: 'a b c' }, 'e-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('检索式形态')
  })
})

describe('draft_claims', () => {
  it('drafts an independent + dependent claim', () => {
    const out = draftClaims({ invention_name: '一种装置', technical_features: ['特征A', '特征B'], optional_features: ['特征C'] })
    expect(out.claims.length).toBe(2)
    expect(out.claims[0]?.type).toBe('independent')
    expect(out.claims[1]?.type).toBe('dependent')
    expect(out.claims[1]?.refersTo).toBe(1)
  })

  it('flags a trailing-period violation', () => {
    const out = draftClaims({ invention_name: '一种装置', technical_features: ['特征A'] })
    // The independent claim ends with '。' per the template, so no period violation.
    expect(out.violations.every(v => v.rule !== 'period')).toBe(true)
  })

  it('runs through the registered tool', async () => {
    const ctx = await ctxWith(createDraftClaimsTool())
    const result = await execute(ctx, 'draft_claims', { invention_name: '一种装置', technical_features: ['特征A'] }, 'dc-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('权利要求书草案')
  })
})

describe('draft_specification', () => {
  it('assembles the five sections', () => {
    const out = draftSpecification({ title: '一种装置', has_drawings: true })
    expect(out.sections.map(s => s.name)).toEqual(['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式'])
    expect(out.sections.some(s => s.placeholder)).toBe(true)
    expect(out.complete).toBe(false)
    expect(out.missing_inputs).toContain('具体实施方式')
  })

  it('warns when a utility model lacks drawings', () => {
    const out = draftSpecification({ title: '一种装置', patent_type: 'utility_model' })
    expect(out.warnings.some(w => w.includes('附图'))).toBe(true)
  })

  it('runs through the registered tool', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', { title: '一种装置' }, 'ds-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('说明书草案')
  })

  it('rejects null or incomplete figure_analysis entries at the tool boundary', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const nullEntry = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [null],
    }, 'ds-2')
    expect(nullEntry.isError).toBe(true)
    expect(text(nullEntry)).toContain('figure_analysis[0] 必须是对象')

    const missingDescription = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{}],
    }, 'ds-3')
    expect(missingDescription.isError).toBe(true)
    expect(text(missingDescription)).toContain('figure_analysis[0].figureDescription 必须是字符串')
  })

  it('rejects invalid optional fields with field-level input errors', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const badProblem = await execute(ctx, 'draft_specification', { title: '一种装置', technical_problem: 1 }, 'ds-6')
    expect(text(badProblem)).toContain('invalid arguments')

    const badDrawings = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      drawing_descriptions: [1],
    }, 'ds-7')
    expect(text(badDrawings)).toContain('invalid arguments')

    const badDrawingsFlag = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      has_drawings: 'yes',
    }, 'ds-9')
    expect(text(badDrawingsFlag)).toContain('invalid arguments')
  })

  it('validates nested figure_analysis structure before drafting', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const badElectrical = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{ figureDescription: '结构示意图', electrical: [] }],
    }, 'ds-10')
    expect(text(badElectrical)).toContain('figure_analysis[0].electrical 必须是对象')

    const badComponents = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{ figureDescription: '结构示意图', electrical: { components: 'x' } }],
    }, 'ds-11')
    expect(text(badComponents)).toContain('figure_analysis[0].electrical.components 必须是数组')

    const badComponent = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{ figureDescription: '结构示意图', electrical: { components: [{}] } }],
    }, 'ds-12')
    expect(text(badComponent)).toContain('figure_analysis[0].electrical.components[0].ref 必须是字符串')

    const badValue = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{
        figureDescription: '结构示意图',
        electrical: { components: [{ ref: '1', name: '壳体', value: 1 }] },
      }],
    }, 'ds-13')
    expect(text(badValue)).toContain('figure_analysis[0].electrical.components[0].value 必须是字符串')
  })

  it('accepts validated figure_analysis and auto-generates drawing descriptions', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{
        figureDescription: '整体结构示意图',
        electrical: { components: [{ ref: '1', name: '壳体', value: '金属' }] },
      }],
    }, 'ds-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('壳体')
  })

  it('accepts entries without electrical data or without component values', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [
        { figureDescription: '整体结构示意图' },
        { figureDescription: '电路原理图', electrical: { components: [{ ref: '2', name: '电源' }] } },
      ],
    }, 'ds-15')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('电源')
  })

  it('rejects a null electrical component entry', async () => {
    const ctx = await ctxWith(createDraftSpecificationTool())
    const result = await execute(ctx, 'draft_specification', {
      title: '一种装置',
      figure_analysis: [{ figureDescription: '电路原理图', electrical: { components: [null] } }],
    }, 'ds-16')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('figure_analysis[0].electrical.components[0] 必须是对象')
  })
})

describe('draft_claims additional-fee threshold', () => {
  it('warns when the draft exceeds 10 claims', () => {
    const out = draftClaims({
      invention_name: '一种装置',
      technical_features: ['特征A'],
      optional_features: Array.from({ length: 11 }, (_, i) => `附加特征${i + 1}`),
    })
    expect(out.claims).toHaveLength(12)
    const fee = out.violations.find(v => v.rule === 'additional_fee')
    expect(fee).toBeDefined()
    expect(fee!.severity).toBe('warning')
    expect(fee!.message).toContain('申请附加费')
  })

  it('leaves a draft of exactly 10 claims unwarned', () => {
    const out = draftClaims({
      invention_name: '一种装置',
      technical_features: ['特征A'],
      optional_features: Array.from({ length: 9 }, (_, i) => `附加特征${i + 1}`),
    })
    expect(out.claims).toHaveLength(10)
    expect(out.violations.find(v => v.rule === 'additional_fee')).toBeUndefined()
  })
})
