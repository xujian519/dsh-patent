import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  createPatentWorkerValidateTool,
  renderWorkerValidate,
  type PatentWorkerValidateOutput,
} from '../src/tool/patent-worker-validate.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const exec = { signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]

describe('patent_worker_validate', () => {
  const tool = createPatentWorkerValidateTool()

  it('registers under patent_worker_validate', () => {
    expect(tool.name).toBe('patent_worker_validate')
  })

  it('passes a known worker whose hard fields are all present', async () => {
    const value = (await tool.execute(
      { workerName: 'patent-technical-analyzer', outputText: '技术问题\n技术特征\n技术效果' },
      exec,
    )) as PatentWorkerValidateOutput
    expect(value.found).toBe(true)
    expect(value.valid).toBe(true)
    expect(value.missingHardFields).toEqual([])
  })

  it('degrades a known worker missing hard fields', async () => {
    const value = (await tool.execute(
      { workerName: 'patent-technical-analyzer', outputText: '只有技术问题' },
      exec,
    )) as PatentWorkerValidateOutput
    expect(value.found).toBe(true)
    expect(value.valid).toBe(false)
    expect(value.missingHardFields).toEqual(expect.arrayContaining(['技术特征', '技术效果']))
    expect(value.degradationReason).toContain('技术特征')
  })

  it('returns found=false with the catalog for an unknown worker', async () => {
    const value = (await tool.execute({ workerName: 'nope', outputText: 'anything' }, exec)) as PatentWorkerValidateOutput
    expect(value.found).toBe(false)
    expect(value.valid).toBe(false)
    expect(value.availableWorkers).toEqual(expect.arrayContaining(['quality_checker', 'patent-novelty-analyzer']))
  })

  it('renders pass, degraded, and unknown-worker prose', () => {
    const pass = renderWorkerValidate({ workerName: 'w', found: true, valid: true, missingHardFields: [], missingSoftFields: [] })
    expect(pass).toContain('通过 ✅')
    const degraded = renderWorkerValidate({
      workerName: 'w',
      found: true,
      valid: false,
      missingHardFields: ['技术特征'],
      missingSoftFields: ['x'],
      degradationReason: '硬性契约字段缺失: 技术特征',
    })
    expect(degraded).toContain('降级 ⚠️')
    expect(degraded).toContain('缺失硬性字段: 技术特征')
    expect(degraded).toContain('缺失软性字段: x')
    const unknown = renderWorkerValidate({
      workerName: 'w',
      found: false,
      valid: false,
      missingHardFields: [],
      missingSoftFields: [],
      availableWorkers: ['a', 'b'],
    })
    expect(unknown).toContain('未知 worker "w"')
    expect(unknown).toContain('a, b')
  })

  it('renders fallbacks for missing catalog and degradation reason', () => {
    const bareUnknown = renderWorkerValidate({ workerName: 'w', found: false, valid: false, missingHardFields: [], missingSoftFields: [] })
    expect(bareUnknown).toContain('可用: ')
    const bareDegraded = renderWorkerValidate({
      workerName: 'w',
      found: true,
      valid: false,
      missingHardFields: ['技术特征'],
      missingSoftFields: [],
    })
    expect(bareDegraded).toContain('硬性字段缺失')
  })

  it('renders through the registered tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createPatentWorkerValidateTool())
    const signal = new AbortController().signal
    const result = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('wv-1'),
      name: 'patent_worker_validate',
      arguments: { workerName: 'patent-technical-analyzer', outputText: '技术问题' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(text).toContain('patent_worker_validate(patent-technical-analyzer)')
  })
})
