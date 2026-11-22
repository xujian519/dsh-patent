import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createCheckPatentFigureConsistencyTool } from '../src/tool/check-patent-figure-consistency.ts'
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

/** 断言执行成功并取出规范化输出（spec 内按字面量结构继续断言）。 */
function valueOf(result: ToolExecutionResult): ToolValue {
  if (result.isError) throw new Error(`tool call failed: ${JSON.stringify(result.error)}`)
  return result.value as ToolValue
}

type ToolValue = {
  figureCount: number
  numericComponents: { refNumber: string; name: string; figureNumbers: number[] }[]
  conflicts: { ref: string; message: string }[]
  missingFigureNumbers: number[]
  missingRefs: number[]
  warnings: string[]
  summary: string
  consistent: boolean
}

describe('check_patent_figure_consistency', () => {
  it('合并跨图标记并通过，摘要与渲染文本一致', async () => {
    const ctx = await ctxWith(createCheckPatentFigureConsistencyTool())
    const result = await execute(ctx, 'check_patent_figure_consistency', {
      figures: [
        { figure_number: 1, components: [{ ref_number: '10', name: '壳体' }] },
        { figure_number: 2, components: [{ ref_number: '10', name: '壳体' }, { ref_number: '20', name: '盖板' }] },
      ],
      claim_context: '壳体(10)与盖板(20)连接',
    }, 'c1')
    const value = valueOf(result)
    expect(value.consistent).toBe(true)
    expect(value.numericComponents).toEqual([
      { refNumber: '10', name: '壳体', figureNumbers: [1, 2] },
      { refNumber: '20', name: '盖板', figureNumbers: [2] },
    ])
    const rendered = text(result)
    expect(rendered).toContain('跨图一致性检查：2 张附图')
    expect(rendered).toContain('跨图一致性检查通过')
  })

  it('报出跨图冲突、缺号与缺标，名称缺省按空串处理', async () => {
    const ctx = await ctxWith(createCheckPatentFigureConsistencyTool())
    const result = await execute(ctx, 'check_patent_figure_consistency', {
      figures: [
        { figure_number: 1, components: [{ ref_number: '10', name: '壳体' }] },
        { figure_number: 3, components: [{ ref_number: '10', name: '底座' }, { ref_number: '20' }] },
      ],
      claim_context: '壳体(10)与转轴(30)连接',
    }, 'c2')
    const value = valueOf(result)
    expect(value.consistent).toBe(false)
    expect(value.conflicts).toHaveLength(1)
    expect(value.missingFigureNumbers).toEqual([2])
    expect(value.missingRefs).toEqual([30])
    expect(value.numericComponents).toContainEqual({ refNumber: '20', name: '', figureNumbers: [3] })
    const rendered = text(result)
    expect(rendered).toContain('## 跨图冲突')
    expect(rendered).toContain('## 缺失图号')
    expect(rendered).toContain('## 未识别标记')
  })

  it('figures 为空时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckPatentFigureConsistencyTool())
    const result = await execute(ctx, 'check_patent_figure_consistency', { figures: [] }, 'c3')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('至少需要一张附图')
    // The domain code reaches the event and the trajectory, not only the prose.
    expect(result.error?.info).toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
  })

  it('图号不是正整数时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckPatentFigureConsistencyTool())
    const result = await execute(ctx, 'check_patent_figure_consistency', {
      figures: [{ figure_number: 0, components: [] }],
    }, 'c4')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('必须是正整数')
  })

  it('图号重复时报 invalid_tool_input', async () => {
    const ctx = await ctxWith(createCheckPatentFigureConsistencyTool())
    const result = await execute(ctx, 'check_patent_figure_consistency', {
      figures: [
        { figure_number: 1, components: [] },
        { figure_number: 1, components: [] },
      ],
    }, 'c5')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('figure_number 重复')
  })
})
