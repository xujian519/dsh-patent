import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createCheckClaimFigureCoverageTool } from '../src/tool/check-claim-figure-coverage.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const tool of tools) ctx.tools.register(tool)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** 断言执行成功并取出规范化输出。 */
function valueOf(result: ToolExecutionResult): ToolValue {
  if (result.isError) throw new Error(`tool call failed: ${JSON.stringify(result.error)}`)
  return result.value as ToolValue
}

type ToolValue = {
  boundFeatureCount: number
  unboundFeatureCount: number
  findings: { check: string; claimId: string; feature: string; ref?: string; message: string }[]
  summary: string
  covered: boolean
}

const figures = [
  {
    figure_number: 1,
    components: [{ ref_number: '10', name: '壳体' }, { ref_number: '20' }],
  },
]

describe('check_claim_figure_coverage tool', () => {
  it('特征与标号全部对上时返回 covered', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [
        { claim_id: 'claim_1', feature: '壳体', ref_numbers: ['10'] },
        { claim_id: 'claim_1', feature: '盖板', ref_numbers: ['20'] },
      ],
      figures,
    }, 'coverage-ok')

    const value = valueOf(result)
    expect(value.covered).toBe(true)
    expect(value.boundFeatureCount).toBe(2)
    expect(value.unboundFeatureCount).toBe(0)
    expect(value.findings).toEqual([])
    expect(text(result)).toContain('## 结论')
  })

  it('未指定标号与标号不在图面分别成节渲染', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [
        { claim_id: 'claim_1', feature: '弹簧', ref_numbers: [] },
        { claim_id: 'claim_2', feature: '底座', ref_numbers: ['99'] },
      ],
      figures,
    }, 'coverage-findings')

    const value = valueOf(result)
    expect(value.covered).toBe(false)
    expect(value.findings.map(finding => finding.check)).toEqual(['feature-unbound', 'ref-not-on-figure'])
    const rendered = text(result)
    expect(rendered).toContain('## 未指定标号')
    expect(rendered).toContain('## 标号不在图面')
    expect(rendered).not.toContain('## 结论')
  })

  it('空特征单独成节', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [{ claim_id: 'claim_1', feature: '  ', ref_numbers: ['10'] }],
      figures,
    }, 'coverage-empty-feature')

    expect(valueOf(result).findings[0]).toMatchObject({ check: 'feature-empty' })
    expect(text(result)).toContain('## 空特征')
  })

  it('bindings 为空时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [],
      figures,
    }, 'coverage-no-bindings')

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
  })

  it('figures 为空时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [{ claim_id: 'claim_1', feature: '壳体', ref_numbers: ['10'] }],
      figures: [],
    }, 'coverage-no-figures')

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
  })

  it('图号重复时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [{ claim_id: 'claim_1', feature: '壳体', ref_numbers: ['10'] }],
      figures: [figures[0], figures[0]],
    }, 'coverage-duplicate-figure')

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
  })

  it('图号非正整数时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [{ claim_id: 'claim_1', feature: '壳体', ref_numbers: ['10'] }],
      figures: [{ figure_number: 0, components: [] }],
    }, 'coverage-bad-figure-number')

    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
  })

  it('缺少 ref_numbers 时被参数校验拒绝', async () => {
    const ctx = await ctxWith(createCheckClaimFigureCoverageTool())
    const result = await execute(ctx, 'check_claim_figure_coverage', {
      bindings: [{ claim_id: 'claim_1', feature: '壳体' }],
      figures,
    }, 'coverage-missing-refs')

    expect(result.isError).toBe(true)
  })
})
