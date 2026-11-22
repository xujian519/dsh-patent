import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { asJsonArray, asJsonRecord, readJsonNumber, readJsonString } from '@deepseek-ai/dsh-patent-core'
import { createClaimLintTool } from '../src/tool/claim-lint.ts'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name: 'claim_lint', arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

// 案卷 CN2026-KN-001 的权利要求书（与 04-撰写/CN2026-KN-001_权利要求书.md 一致）。
const CASE_CLAIMS = `1. 一种转子，包括转子铁芯和永磁体，所述转子铁芯的周向上均布有沿轴向延伸的磁钢槽，每只所述磁钢槽内设有一只所述永磁体，相邻两只所述磁钢槽内的永磁体构成一对，同一对中的两只所述永磁体的同名磁极相对，相邻两只所述磁钢槽之间的铁芯部分构成极靴，所述极靴的径向外表面构成所述转子铁芯外圆的一部分，其特征在于，所述极靴的径向外表面包括位于周向中央的中央段和位于该中央段周向两侧的侧段，所述中央段的外径大于所述侧段的外径；所述极靴内设有一对隔磁槽，该一对隔磁槽分别自两个所述侧段向所述极靴的内部延伸。
2. 根据权利要求 1 所述的转子，其特征在于，所述磁钢槽的径向外端与所述转子铁芯的外圆之间设有隔磁桥，所述隔磁桥的径向厚度小于所述极靴的周向宽度。
3. 一种电机，包括定子和转子，其特征在于，所述转子为权利要求 1 所述的转子。
4. 根据权利要求 3 所述的电机，其特征在于，所述定子的内圆为圆形，所述气隙沿径向的尺寸的变化由所述极靴的径向外表面产生。`

const CLEAN_CLAIMS = '1. 一种转子，包括转子铁芯，其特征在于，所述转子铁芯为圆柱状。\n2. 根据权利要求 1 所述的转子，其特征在于，所述转子铁芯为空心。'

describe('claim_lint', () => {
  it('把 findings 按 error/warning 分段渲染到模型可见文本', async () => {
    const ctx = await ctxWith(createClaimLintTool())
    const result = await execute(ctx, { text: CASE_CLAIMS }, 'cl-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('权利要求书形式自检（确定性纯函数，未调用模型）：4 项，1 项 error、2 项 warning，未通过。')
    expect(out).toContain('## 必须修改（error）')
    expect(out).toContain('- [error] 权利要求 4｜antecedent-basis：')
    expect(out).toContain('## 需要复核（warning）')
  })

  it('规范输出与核心报告逐项对齐，全文级发现不带 claim 字段', async () => {
    const ctx = await ctxWith(createClaimLintTool())
    const result = await execute(ctx, { text: `# 权利要求书\n${CLEAN_CLAIMS}` }, 'cl-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = asJsonRecord(result.value)
    expect(readJsonNumber(value?.['claim_count'])).toBe(2)
    const [first] = asJsonArray(value?.['findings']) ?? []
    const finding = asJsonRecord(first)
    expect(readJsonString(finding?.['rule'])).toBe('non-claim-content')
    expect(Object.hasOwn(finding ?? {}, 'claim')).toBe(false)
    expect(readJsonString(finding?.['basis'])).toContain('审查指南')
  })

  it('无问题时明示未发现问题并通过', async () => {
    const ctx = await ctxWith(createClaimLintTool())
    const result = await execute(ctx, { text: CLEAN_CLAIMS }, 'cl-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('2 项，0 项 error、0 项 warning，通过。\n未发现问题。')
  })

  it('给出项数上限时把超限报为 warning', async () => {
    const ctx = await ctxWith(createClaimLintTool())
    const result = await execute(ctx, { text: CLEAN_CLAIMS, max_claims: 1 }, 'cl-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('超过撰写约束的 1 项上限')
    expect(out).toContain('1 项 warning，通过。')
  })

  it('正文为空时报输入错误', async () => {
    const ctx = await ctxWith(createClaimLintTool())
    const result = await execute(ctx, { text: '   ' }, 'cl-5')
    expect(result.isError).toBe(true)
  })
})
