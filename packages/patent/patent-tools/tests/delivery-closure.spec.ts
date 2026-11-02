/**
 * 交付闭环集成测试（2026-10-16 审阅甲5/丙3 联动）：交付前置门禁与制品结构门禁挡在
 * 真实 `render_patent_document` 工具前的行为——「缺记录即拒绝」的拒绝文案点名全部缺失
 * 前置项；补齐四项前置后同一调用出件成功、html 落盘；前置齐备但草案缺 26.3 判准落位
 * 时结构门禁仍拒绝。门禁声明与 `patent.patch.yml` 同形（preset spec 守卫声明内容，
 * 本用例守卫行为）。四项前置工具在此以成功桩代替：门禁按「本会话成功调用记录」记账，
 * 各工具自身行为由其包内测试覆盖。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { createRenderPatentDocumentTool } from '@deepseek-ai/dsh-patent-document'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

/** 调用归属 fixture：交付门禁按 agent 对象身份记账（与 patent-rule 的交付门禁用例同构造）。 */
type ToolAgent = NonNullable<ToolExecutionInput['agent']>

function fakeAgent(id: string): ToolAgent {
  return { id: SessionId(id) } as ToolAgent
}

const AGENT = fakeAgent('session-delivery-closure')

/** 仅 html 渲染的子进程替身：任何子进程调用都是契约违背（html 路径不得触达 Chrome）。 */
class RefusingSubprocess extends SubprocessRuntime {
  async resolveExecutable(): Promise<string> {
    throw new Error('html-only render must not resolve executables')
  }

  async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    throw new Error('html-only render must not inspect a terminal')
  }

  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    throw new Error('html-only render must not spawn')
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('html-only render must not allocate a terminal')
  }
}

/** `patent.patch.yml` 交付门禁声明的同形副本（内容由 preset spec 守卫）。 */
const deliveryGate: PatentRule.DeliveryGateEntry[] = [
  { tool: 'render_patent_document', requires: ['rule_check', 'law_verify', 'matter_log_append'] },
  { tool: 'build_patent_filing', requires: ['rule_check', 'law_verify', 'matter_log_append'] },
  {
    tool: 'render_patent_document',
    requires: ['patent_workflow_run'],
    whenArgs: { template: ['oa-response'] },
  },
]

/** `patent.patch.yml` 制品结构门禁声明的同形副本。 */
const structuralGate: PatentRule.StructuralGateEntry[] = [
  {
    tool: 'render_patent_document',
    whenArgs: { template: 'oa-response' },
    ruleIds: ['PR-OA-007'],
    textArgs: ['draft'],
  },
]

/** oa-response 最小合规草案（与 patent-document 渲染用例同形，含事实/规则/论证新槽位）。 */
function oaDraft(): Record<string, unknown> {
  return {
    fields: {
      'meta-appno': 'CN2022209876543',
      'meta-title': '一种带式输送机的自动张紧机构',
      'meta-oa-no': '第一次审查意见通知书',
      'meta-oa-date': '2026-09-01',
      'meta-response-date': '2026-10-09',
      'meta-agent': 'XX 知识产权代理事务所',
      'position-summary': '申请人认为权利要求具备新颖性与创造性。',
      'conclusion-text': '恳请授予专利权。',
      'footer-case': 'OA-2026-0042 · 机密',
      'footer-date': '2026 年 10 月 09 日',
    },
    sections: [
      { id: 'doc-number', blocks: [{ kind: 'paragraph', text: '答复编号：OA-2026-0042 · 版本 V1.0' }] },
      { id: 'position-points', blocks: [{ kind: 'list', items: ['要点一；', '要点二。'], ordered: true }] },
      { id: 'amendment-table', rows: [['权利要求 1', '未限定随动结构', '增加随动结构', '克服创造性缺陷']] },
      { id: 'amended-claim-1', blocks: [{ kind: 'paragraph', text: '1. 一种带式输送机的自动张紧机构，其特征在于，还包括随动结构。' }] },
      { id: 'facts-application', blocks: [{ kind: 'paragraph', text: 'F1 随动结构记载于原权利要求 1。' }] },
      { id: 'facts-prior-art', blocks: [{ kind: 'paragraph', text: 'P1 对比文件 1 未公开随动结构。' }] },
      { id: 'rules-body', blocks: [{ kind: 'paragraph', text: 'R1《专利法》第 22 条第 3 款。' }] },
      { id: 'argument-novelty', blocks: [{ kind: 'paragraph', text: '对比文件 1 未公开随动结构，权利要求 1 具备新颖性。' }] },
      { id: 'argument-inventiveness', blocks: [{ kind: 'paragraph', text: '对比文件 1 与 2 的结合无技术启示。' }] },
      { id: 'evidence-table', rows: [['D1', 'CN213456789 U', '2021.06.22', '实用新型', '随动结构未公开', '证据来源']] },
      { id: 'citation-table', rows: [['D1', 'CN213456789 U', '2021.06.22', '对比文件', '全文', '1']] },
    ],
  }
}

type Mounted = { ctx: Context; dir: string }

async function mount(): Promise<Mounted> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(RefusingSubprocess)
  await ctx.plugin(PatentRule, { rulesDir: '', deliveryGate, structuralGate })
  for (const name of ['rule_check', 'law_verify', 'matter_log_append', 'patent_workflow_run']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} 成功桩（门禁按调用记录记账）`,
      parameters: {},
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: `${name}: ok` }] },
    }))
  }
  ctx.tools.register(createRenderPatentDocumentTool({ subprocess: ctx.subprocess }))
  return { ctx, dir }
}

function execute(ctx: Context, name: string, args: Record<string, unknown>) {
  return executeToolFixture(ctx, {
    name,
    callId: ToolCallId(`${name}-closure-call`),
    arguments: args,
    signal,
    agent: AGENT,
  })
}

async function satisfyPrerequisites(ctx: Context): Promise<void> {
  const calls: [string, Record<string, unknown>][] = [
    ['rule_check', { scope: 'patent-oa-response', text: '答复正文（桩）。' }],
    ['law_verify', { references: ['专利法第22条第3款'] }],
    ['matter_log_append', { case_dir: '.', action: '建案', artifacts: [], changes: '集成测试留档（桩）。' }],
    ['patent_workflow_run', { manifestId: 'patent_oa_response_v1', input: '通知书正文（桩）。' }],
  ]
  for (const [name, args] of calls) {
    const result = await execute(ctx, name, args)
    expect(result.isError, `${name} 应成功`).toBe(false)
  }
}

describe('交付闭环：门禁 + 真实渲染工具（#449 正例）', () => {
  it('缺前置记录时 render 被拒，拒绝文案点名全部缺失项', async () => {
    const { ctx, dir } = await mount()
    try {
      const result = await execute(ctx, 'render_patent_document', {
        template: 'oa-response',
        outputName: 'oa-refused',
        format: 'html',
        outputDir: dir,
        draft: oaDraft(),
      })
      expect(result.isError).toBe(true)
      const message = result.error?.message ?? ''
      for (const missing of ['rule_check', 'law_verify', 'matter_log_append', 'patent_workflow_run']) {
        expect(message).toContain(missing)
      }
      expect(message).toContain('缺记录即为未跑')
      expect(existsSync(join(dir, 'oa-refused.html'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('补齐四项前置后出件成功，html 落盘', async () => {
    const { ctx, dir } = await mount()
    const previousCwd = process.cwd()
    try {
      // render_patent_document resolves outputDir against the process working
      // directory and rejects a target outside it.
      process.chdir(dir)
      await satisfyPrerequisites(ctx)
      const rendered = await execute(ctx, 'render_patent_document', {
        template: 'oa-response',
        outputName: 'oa-ok',
        format: 'html',
        outputDir: dir,
        draft: oaDraft(),
      })
      expect(rendered.isError, rendered.error?.message).toBe(false)
      expect(existsSync(join(dir, 'oa-ok.html'))).toBe(true)
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('前置齐备但草案缺 26.3 判准落位时，制品结构门禁仍拒绝', async () => {
    const { ctx, dir } = await mount()
    try {
      await satisfyPrerequisites(ctx)
      const result = await execute(ctx, 'render_patent_document', {
        template: 'oa-response',
        outputName: 'oa-263-miss',
        format: 'html',
        outputDir: dir,
        draft: {
          fields: {},
          sections: [{
            id: 'argument-inventiveness',
            blocks: [{ kind: 'paragraph', text: '说明书未记载相关处理手段，不符合专利法第二十六条第三款的规定。' }],
          }],
        },
      })
      expect(result.isError).toBe(true)
      expect(result.error?.message).toMatch(/制品结构门禁拒绝 render_patent_document/)
      expect(result.error?.message).toMatch(/PR-OA-007/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
