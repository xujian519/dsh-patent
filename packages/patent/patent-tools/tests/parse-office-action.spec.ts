import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ParsedOfficeAction } from '@deepseek-ai/dsh-patent-core'
import { createParseOfficeActionTool } from '../src/tool/parse-office-action.ts'
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

const OA_TEXT = [
  '权利要求1-5不具备创造性，不符合专利法第22条第3款的规定。',
  '对比文件1（CN112345678A，Y类）公开了权利要求1的前序特征。',
  '审查员认为：本领域技术人员有动机将对比文件1与公知常识结合。',
].join('\n')

describe('parse_office_action', () => {
  it('解析通知书并把结构化事实渲染到模型可见文本', async () => {
    const ctx = await ctxWith(createParseOfficeActionTool())
    const result = await execute(ctx, 'parse_office_action', { text: OA_TEXT }, 'poa-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('审查意见通知书解析（确定性纯函数，未调用模型）')
    expect(out).toContain('驳回类型: 创造性（专利法第22条第3款）')
    expect(out).toContain('影响权利要求: 1, 2, 3, 4, 5')
    expect(out).toContain('## 引用文献逐条（权项为同句共现，非权威对应）')
    expect(out).toContain('- CN112345678A（Y 类）→ 同句提到的权项: 1')
    expect(out).toContain('审查员论点:')
  })

  it('工具的规范输出可与解析器结果逐字段对齐', async () => {
    const tool = createParseOfficeActionTool()
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'parse_office_action', { text: OA_TEXT }, 'poa-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = (result as { value?: { parsed?: ParsedOfficeAction } }).value
    expect(value?.parsed?.rejectionType).toBe('inventiveness')
    expect(value?.parsed?.affectedClaims).toEqual([1, 2, 3, 4, 5])
  })

  it('未标注相关性类别时不推断类别', async () => {
    const ctx = await ctxWith(createParseOfficeActionTool())
    const result = await execute(ctx, 'parse_office_action', {
      text: '权利要求1不具备新颖性，不符合专利法第22条第2款的规定。对比文件2（CN109876543A）公开了权利要求1的全部特征。',
    }, 'poa-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('- CN109876543A（未标注）→ 同句提到的权项: 1')
  })

  it('引用文献所在句未涉及权项时明示"无"', async () => {
    const ctx = await ctxWith(createParseOfficeActionTool())
    const result = await execute(ctx, 'parse_office_action', {
      text: '权利要求1不具备新颖性，不符合专利法第22条第2款的规定。\n对比文件3（CN1234567A，X类）公开了相关技术。',
    }, 'poa-5')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('- CN1234567A（X 类）→ 同句提到的权项: 无')
  })

  it('无引用文献时不渲染引用段', async () => {
    const ctx = await ctxWith(createParseOfficeActionTool())
    const result = await execute(ctx, 'parse_office_action', {
      text: '权利要求1不具备创造性，不符合专利法第22条第3款的规定。',
    }, 'poa-6')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('引用文献: 无')
    expect(text(result)).not.toContain('引用文献逐条')
  })

  it('正文为空时报输入错误', async () => {
    const ctx = await ctxWith(createParseOfficeActionTool())
    const result = await execute(ctx, 'parse_office_action', { text: '   ' }, 'poa-4')
    expect(result.isError).toBe(true)
  })
})
