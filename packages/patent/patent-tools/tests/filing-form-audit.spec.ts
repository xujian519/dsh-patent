/**
 * 申请文件成文前形式预检：校验的文本必须由成文通道同一份映射产出。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { SpecDraft } from '@deepseek-ai/dsh-patent-core'
import * as patentTools from '../src/index.ts'
import { auditFilingDraft, formTextFromDraft, renderFilingFormDenial } from '../src/tool/internal/filing-form-audit.ts'

/** 一份按交付要求写完的草案：五部分齐全、权项不带项号、附图说明每条一幅图。 */
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
    claims: [
      '一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。',
      '如权利要求 1 所述的智能保温杯，其特征在于，还包括控制模块。',
    ],
    abstract: ['本发明公开一种智能保温杯，包括杯体、温度显示模块和加热单元，能显示水温并保持恒温。'],
    figureFiles: ['fig1.png', 'fig2.png'],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于日用品技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温，使用者难以掌握饮水时机。' }],
      summary: [{ kind: 'paragraph', text: '本发明提供一种智能保温杯，能显示水温并保持恒温。' }],
      drawingDescriptions: [{ kind: 'list', items: ['智能保温杯的整体结构示意图', '加热控制逻辑的模块框图'] }],
      embodiment: [
        { kind: 'paragraph', text: '下面结合图1和图2对本发明作进一步说明。' },
        { kind: 'paragraph', text: '如图1所示，杯体1与杯盖2连接，温度显示模块3固定在杯盖2上。' },
        { kind: 'paragraph', text: '如图2所示，控制模块4与加热单元5连接。' },
      ],
    },
    ...overrides,
  }
}

describe('formTextFromDraft', () => {
  it('按 docx 通道的节点顺序摊平，五个部分各成一个标题行', () => {
    const { text, claims, abstract } = formTextFromDraft(specDraft())
    expect(text.split('\n').filter(line => line.startsWith('### '))).toEqual([
      '### 技术领域',
      '### 背景技术',
      '### 发明内容',
      '### 附图说明',
      '### 具体实施方式',
    ])
    expect(text).toContain('图1为智能保温杯的整体结构示意图；')
    expect(claims.split('\n')[0]).toBe('1. 一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。')
    expect(abstract).toContain('本发明公开一种智能保温杯')
  })

  it('表格行不进文本，表题段照常进入', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'table', name: '温度档位', header: ['档位', '温度'], rows: [['一档', '40℃']] },
    ]
    const { text } = formTextFromDraft(draft)
    expect(text).toContain('表 1 · 温度档位')
    expect(text).not.toContain('一档')
  })
})

describe('auditFilingDraft', () => {
  it('放行一份形式正确的草案', () => {
    expect(auditFilingDraft(specDraft())).toEqual([])
  })

  it('拒绝说明书记载的附图标记带括号', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'paragraph', text: '如图1所示，杯体（1）与杯盖（2）连接，温度显示模块（3）固定在杯盖（2）上。' },
    ]
    const violations = auditFilingDraft(draft)
    expect(violations.map(violation => violation.rule)).toContain('figure_mark_parentheses')
  })

  it('拒绝图号写成「图 1」留空格', () => {
    const draft = specDraft()
    draft.sections.embodiment = [{ kind: 'paragraph', text: '如图 1 所示，杯体1与杯盖2连接。' }]
    const violations = auditFilingDraft(draft)
    expect(violations.map(violation => violation.rule)).toContain('figure_number_spacing')
  })

  it('拒绝正文出现项目符号以外的规定外标题', () => {
    const draft = specDraft()
    draft.sections.summary = [{ kind: 'paragraph', text: '要解决的技术问题' }]
    // 段落里的纯文本不是 Markdown 标题，因此不报 heading_set；这条用例固定这一点，
    // 避免把「正文写了小标题文字」误判成标题行。
    expect(auditFilingDraft(draft).map(violation => violation.rule)).not.toContain('heading_set')
  })
})

describe('build_patent_filing 的成文前预检（真实插件注册路径）', () => {
  /** 成文工具本身由 patent-filing 提供；这里只验证 patent-tools 注册的 guard 拦不拦。 */
  const filingTool = defineContentToolFixture({
    name: 'build_patent_filing',
    description: 'build the filing',
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'docx written' }] },
  })

  async function mount(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const key: string = 'sandboxPolicy'
    ctx.provide(key, { workspaceRoot: process.cwd() })
    const fiber = await ctx.plugin(patentTools, {})
    ctx.tools.register(filingTool)
    return { ctx, dispose: () => fiber.dispose() }
  }

  function call(ctx: Context, args: Record<string, unknown>) {
    return executeToolFixture(ctx, {
      name: 'build_patent_filing',
      callId: ToolCallId('filing-form-audit'),
      arguments: args,
      signal: new AbortController().signal,
    })
  }

  it('形式不合规的草案在写出 docx 前被拒绝', async () => {
    const { ctx } = await mount()
    const draft = specDraft()
    draft.sections.embodiment = [{ kind: 'paragraph', text: '如图 1 所示，杯体1与杯盖2连接。' }]
    const result = await call(ctx, { draft })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('figure_number_spacing')
    expect(result.error?.message).toContain('不会写出 docx')
  })

  it('形式合规的草案放行到成文工具', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { draft: specDraft() })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('docx written')
  })

  it('插件 fiber 释放后预检随注册一起移除', async () => {
    const { ctx, dispose } = await mount()
    const draft = specDraft()
    draft.sections.embodiment = [{ kind: 'paragraph', text: '如图 1 所示，杯体1与杯盖2连接。' }]
    expect((await call(ctx, { draft })).isError).toBe(true)
    await dispose()
    expect((await call(ctx, { draft })).isError).toBe(false)
  })

  // 预检只拦「读得出草案且形式不合规」的调用。参数缺失、不是对象或草案不合法时，
  // 拒绝由工具自己的参数校验负责，预检不能抢在它前面给出第二种说法。
  it('参数里没有 draft 时放行到工具的参数校验', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, {})
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('docx written')
  })

  it('草案不合法时放行到工具的参数校验', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { draft: { meta: {} } })
    expect(result.error?.message ?? '').not.toContain('形式预检')
  })

  it('参数不是对象时放行到工具的参数校验', async () => {
    const { ctx } = await mount()
    for (const args of [null, 'draft']) {
      const result = await executeToolFixture(ctx, {
        name: 'build_patent_filing',
        callId: ToolCallId('filing-form-audit'),
        arguments: args,
        signal: new AbortController().signal,
      })
      expect(result.error?.message ?? '').not.toContain('形式预检')
    }
  })
})

describe('renderFilingFormDenial', () => {
  it('逐条列出规则与修法', () => {
    const draft = specDraft()
    draft.sections.embodiment = [{ kind: 'paragraph', text: '如图 1 所示，杯体1与杯盖2连接。' }]
    const text = renderFilingFormDenial(auditFilingDraft(draft))
    expect(text).toContain('figure_number_spacing')
    expect(text).toContain('修法：')
    expect(text).toContain('不会写出 docx')
  })

  it('给出规则命中的原句，而不是模型手上没有的行号', () => {
    const text = renderFilingFormDenial([
      {
        rule: 'figure_number_spacing',
        family: 'figures',
        severity: 'error',
        message: '图号与数字之间不得留空格',
        matchedSentence: '如图 1 所示，杯体1与杯盖2连接。',
        line: 3,
      },
    ])
    expect(text).toContain('命中句：如图 1 所示，杯体1与杯盖2连接。')
    expect(text).not.toContain('第 3 行')
  })

  it('没有命中句与修法时只列规则与说明', () => {
    const text = renderFilingFormDenial([
      { rule: 'abstract_length', family: 'abstract', severity: 'error', message: '摘要超过 300 字' },
    ])
    expect(text).toContain('- abstract_length：摘要超过 300 字\n修改 draft 后重新调用；被拒绝的调用不会写出 docx。')
  })
})
