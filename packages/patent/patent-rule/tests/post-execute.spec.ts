import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

function exec(name: string): ToolExecution {
  const agent = { session: { header: { id: 's1' } } }
  return { callId: ToolCallId(`call-${name}`), name, arguments: {}, agent, signal } as unknown as ToolExecution
}

/** A call with no owning agent: the gate cannot address an approval request for it. */
function execWithoutAgent(name: string): ToolExecution {
  // Derived from exec() so the fixture needs no second `as unknown` construction.
  const { agent: _omitted, ...rest } = exec(name)
  return rest
}

function deliveryTool(name: string, text: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text }] },
  })
}

/** A rulesDir fixture with one block, review, warn, and log rule (all keyword_blocklist, non-PAT). */
function makeRulesFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'patent-rule-'))
  const patentDir = join(root, 'patent')
  mkdirSync(patentDir)
  writeFileSync(
    join(patentDir, 'compliance.yaml'),
    [
      'rules:',
      '  - id: TEST-BLOCK',
      '    name: 测试拦截',
      '    severity: critical',
      '    action: block',
      '    check: { type: keyword_blocklist, keywords: ["BLOCKWORD"] }',
      '  - id: TEST-REVIEW',
      '    name: 测试审批',
      '    severity: major',
      '    action: review',
      '    check: { type: keyword_blocklist, keywords: ["REVIEWWORD"] }',
      '  - id: TEST-WARN',
      '    name: 测试提示',
      '    severity: minor',
      '    action: warn',
      '    check: { type: keyword_blocklist, keywords: ["WARNWORD"] }',
      '  - id: TEST-LOG',
      '    name: 测试记录',
      '    severity: minor',
      '    action: log',
      '    check: { type: keyword_blocklist, keywords: ["LOGWORD"] }',
    ].join('\n'),
    'utf8',
  )
  return root
}

async function mount(config: PatentRule.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PatentRule, config)
  return ctx
}

describe('tools/post-execute output gate', () => {
  it('blocks a delivery-tool result hitting a block-level rule', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('render_patent_document', '包含 BLOCKWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-BLOCK/)
  })

  it('accepts a review-level result when approval allows', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    let requested: unknown
    ctx.provide('approval', { request: async (req: unknown): Promise<string> => { requested = req; return 'allowed-once' } })
    ctx.tools.register(deliveryTool('draft_claims', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('draft_claims'))
    expect(result.isError).toBe(false)
    expect(requested).toBeDefined()
    expect((requested as { toolName?: string })?.toolName).toBe('draft_claims')
  })

  it('blocks a review-level result when approval rejects', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.provide('approval', { request: async (): Promise<string> => 'rejected' })
    ctx.tools.register(deliveryTool('draft_specification', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('draft_specification'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-REVIEW/)
  })

  it.each(['cancelled', 'unavailable'] as const)(
    'blocks a review-level result when approval returns %s',
    async (outcome) => {
      const ctx = await mount({ rulesDir: makeRulesFixture() })
      ctx.provide('approval', { request: async (): Promise<string> => outcome })
      ctx.tools.register(deliveryTool('draft_claims', '包含 REVIEWWORD 的文档'))
      const result = await executeToolFixture(ctx, exec('draft_claims'))
      expect(result.isError).toBe(true)
      expect(result.error?.message).toMatch(/TEST-REVIEW/)
      expect(result.error?.message).toMatch(/审批未通过/)
    },
  )

  it('fails closed when the approval channel throws', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.provide('approval', {
      request: async (): Promise<string> => { throw new Error('approval bridge unavailable') },
    })
    ctx.tools.register(deliveryTool('draft_claims', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('draft_claims'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/审批通道异常/)
    expect(result.error?.message).toMatch(/approval bridge unavailable/)
  })

  it('fails closed on a review-level result with no approval answerer', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('validate_specification', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('validate_specification'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/无审批通道/)
  })

  it('fails closed without asking when approval is disabled by config', async () => {
    // The answerer is mounted and would allow the result: only the config switch
    // can produce the block, so `requested` staying false pins which guard fired.
    const ctx = await mount({ rulesDir: makeRulesFixture(), approvalDisabled: true })
    let requested = false
    ctx.provide('approval', {
      request: async (): Promise<string> => { requested = true; return 'allowed-once' },
    })
    ctx.tools.register(deliveryTool('draft_claims', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('draft_claims'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/无审批通道/)
    expect(requested).toBe(false)
  })

  it('fails closed without asking when the call carries no agent', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    let requested = false
    ctx.provide('approval', {
      request: async (): Promise<string> => { requested = true; return 'allowed-once' },
    })
    ctx.tools.register(deliveryTool('draft_claims', '包含 REVIEWWORD 的文档'))
    const result = await executeToolFixture(ctx, execWithoutAgent('draft_claims'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/无审批通道/)
    expect(requested).toBe(false)
  })

  it('fails closed on a shipped PAT-APPROVAL-001 hit with no approval service', async () => {
    // The packaged asset is the shipped deployment: a conclusion-bearing draft
    // is blocked rather than delivered when no approval channel is mounted.
    const ctx = await mount({})
    ctx.tools.register(deliveryTool('draft_claims', '本次分析的最终建议如下。'))
    const result = await executeToolFixture(ctx, exec('draft_claims'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/PAT-APPROVAL-001/)
    expect(result.error?.message).toMatch(/无审批通道/)
  })

  it('delegates non-matching tools via next()', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    let downstreamCalled = false
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      downstreamCalled = true
      return next()
    })
    ctx.tools.register(deliveryTool('other_tool', '包含 BLOCKWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('other_tool'))
    expect(result.isError).toBe(false)
    expect(downstreamCalled).toBe(true)
  })

  it('unregisters the output gate when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(PatentRule, { rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('render_patent_document', '包含 BLOCKWORD 的文档'))
    expect((await executeToolFixture(ctx, exec('render_patent_document'))).isError).toBe(true)
    await fiber.dispose()
    const after = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(after.isError).toBe(false)
  })

  it('delegates via next() when a result carries no text blocks', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    let downstreamCalled = false
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      downstreamCalled = true
      return next()
    })
    ctx.tools.register(
      defineContentToolFixture({
        name: 'render_patent_document',
        description: 'render',
        parameters: {},
        async execute(): Promise<Array<{ type: 'reasoning'; text: string }>> {
          return [{ type: 'reasoning', text: '推理过程' }]
        },
      }),
    )
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(false)
    expect(downstreamCalled).toBe(true)
  })

  it('delegates via next() for whitespace-only results', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    let downstreamCalled = false
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      downstreamCalled = true
      return next()
    })
    ctx.tools.register(deliveryTool('render_patent_document', '   '))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(false)
    expect(downstreamCalled).toBe(true)
  })

  it('carries warn-level hits as context for the next request and passes the result through', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    let downstreamCalled = false
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      downstreamCalled = true
      return next()
    })
    ctx.tools.register(deliveryTool('render_patent_document', '包含 WARNWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(false)
    expect(downstreamCalled).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('命中 warn 级规则 TEST-WARN'))
    warnSpy.mockRestore()
    const [context] = result.additionalContexts ?? []
    expect(context).toBeDefined()
    const text = (context?.content ?? [])
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('TEST-WARN')
    expect(text).toContain('测试提示')
    expect(text).toContain('WARNWORD')
    expect(context?.source.kind).toBe('patent-rule-gate')
  })

  it('keeps a downstream block decision and its own context, with the warn context first', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    const downstream = createUserMessage({
      content: [{ type: 'text', text: '下游上下文' }],
      source: { kind: 'user' },
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'block', feedback: [{ type: 'text', text: '下游拦截' }], additionalContexts: [downstream] }
    })
    ctx.tools.register(deliveryTool('render_patent_document', '包含 WARNWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('下游拦截')
    const contexts = result.additionalContexts ?? []
    expect(contexts.map(context => context.source.kind)).toEqual(['patent-rule-gate', 'user'])
  })

  it('adds warn context to a block-level hit of the same result', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('render_patent_document', 'BLOCKWORD 与 WARNWORD 同现'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-BLOCK/)
    const [context] = result.additionalContexts ?? []
    const text = (context?.content ?? [])
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('TEST-WARN')
  })

  it('adds warn context to a review-level hit that fails closed', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('validate_specification', 'REVIEWWORD 与 WARNWORD 同现'))
    const result = await executeToolFixture(ctx, exec('validate_specification'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/无审批通道/)
    const [context] = result.additionalContexts ?? []
    const text = (context?.content ?? [])
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('TEST-WARN')
  })

  it('records log-level hits in the logger without attaching context', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    const infoSpy = vi.spyOn(ctx.logger, 'info')
    ctx.tools.register(deliveryTool('render_patent_document', '包含 LOGWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(false)
    expect(result.additionalContexts ?? []).toHaveLength(0)
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('命中 log 级规则 TEST-LOG'))
    infoSpy.mockRestore()
  })

  it('attaches no context when no rule fires', async () => {
    const ctx = await mount({ rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('render_patent_document', '普通文档，无命中'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(false)
    expect(result.additionalContexts ?? []).toHaveLength(0)
  })

  it('injects warn context from the shipped rule set', async () => {
    const ctx = await mount({})
    ctx.tools.register(deliveryTool('draft_claims', '本方案毫无疑问优于现有技术。'))
    const result = await executeToolFixture(ctx, exec('draft_claims'))
    expect(result.isError).toBe(false)
    const [context] = result.additionalContexts ?? []
    const text = (context?.content ?? [])
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('PAT-ABS-001')
    expect(context?.source).toMatchObject({ kind: 'patent-rule-gate', form: 'notice' })
  })

  it('apply without gateToolNames falls back to the default delivery tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin({
      name: 'patent-rule-raw-apply',
      inject: ['tools'],
      apply(fiber: Context, config: { rulesDir?: string }): void {
        PatentRule.apply(fiber, config)
      },
    }, { rulesDir: makeRulesFixture() })
    ctx.tools.register(deliveryTool('render_patent_document', '包含 BLOCKWORD 的文档'))
    const result = await executeToolFixture(ctx, exec('render_patent_document'))
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/TEST-BLOCK/)
  })
})
