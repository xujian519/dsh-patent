import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  blockingCitationDecisions,
  citationGateBlocking,
  renderCitationGateDenial,
} from '../src/runtime/citation-gate.ts'

const signal = new AbortController().signal

function rulesDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'patent-rule-citation-'))
  const patentDir = join(root, 'patent')
  mkdirSync(patentDir)
  writeFileSync(join(patentDir, 'compliance.yaml'), [
    'rules:',
    '  - id: CITE-FIXTURE',
    '    name: 夹具',
    '    severity: minor',
    '    action: warn',
    '    basisKind: practice-note',
    '    check:',
    '      type: keyword_blocklist',
    '      keywords: ["绝对可以"]',
  ].join('\n'))
  return root
}

function documentTool() {
  return defineContentToolFixture({
    name: 'render_patent_document',
    description: 'render',
    parameters: { draft: { type: 'string' } },
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'written' }] },
  })
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PatentRule, {
    rulesDir: rulesDir(),
    citationGate: [{ tool: 'render_patent_document', textArgs: ['draft'] }],
  })
  ctx.tools.register(documentTool())
  return ctx
}

function call(ctx: Context, draft: string) {
  return executeToolFixture(ctx, {
    name: 'render_patent_document',
    callId: ToolCallId('citation-call'),
    arguments: { draft },
    signal,
  })
}

describe('blockingCitationDecisions', () => {
  it('ignores blank text and accepts a civil-procedure article', () => {
    expect(blockingCitationDecisions('   ')).toEqual([])
    expect(blockingCitationDecisions('依照民事诉讼法第66条。')).toEqual([])
  })

  it('reports a civil-procedure article past the statute and a second call uses the cache', () => {
    const reasons = blockingCitationDecisions('民事诉讼法第999条')
    expect(reasons[0]).toContain('第999条')
    expect(blockingCitationDecisions('民事诉讼法第66条')).toEqual([])
  })

  it('applies only to the declared tool and arguments', () => {
    const entries = [{ tool: 'render_patent_document', textArgs: ['draft'], whenArgs: { template: 'oa-response' } }]
    expect(citationGateBlocking(entries, 'other', { draft: '专利法第99条' })).toEqual([])
    expect(citationGateBlocking(entries, 'render_patent_document', { template: 'claims-spec', draft: '专利法第99条' })).toEqual([])
    expect(citationGateBlocking(entries, 'render_patent_document', { template: 'oa-response', draft: '专利法第22条' })).toEqual([])
  })

  it('names the extra citations when more than eight fail', () => {
    const reasons = Array.from({ length: 9 }, (_, index) => `第${index}条`)
    expect(renderCitationGateDenial('render_patent_document', reasons)).toContain('另有 1 处')
    expect(renderCitationGateDenial('render_patent_document', ['专利法第99条'])).not.toContain('另有')
  })
})

describe('交付物引用门禁', () => {
  it('放行索引中的现行条文', async () => {
    const result = await call(await mount(), '依照专利法第22条第3款评价创造性。')
    expect(result.isError).toBe(false)
  })

  it('拒绝超出索引范围的条号', async () => {
    const result = await call(await mount(), '依照专利法第99条。')
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('交付物引用门禁拒绝')
    expect(result.error?.message).toContain('第99条')
  })

  it('未声明门禁时不核验制品文本', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PatentRule, { rulesDir: rulesDir() })
    ctx.tools.register(documentTool())
    const result = await call(ctx, '依照专利法第99条。')
    expect(result.isError).toBe(false)
  })
})
