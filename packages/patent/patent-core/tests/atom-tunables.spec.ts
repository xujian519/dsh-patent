import { describe, expect, it } from 'vitest'
import {
  ClaimChartHandler,
  ClaimStrategyHandler,
  CompareHandler,
  ExtractHandler,
  GroundednessHandler,
  KeywordsHandler,
  NoveltyHandler,
  ReasoningHandler,
  type StageHandler,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import {
  DEFAULT_CHART_SOURCE_MAX_BYTES,
  MAX_CHART_SOURCE_MAX_BYTES,
  readChartSourceMaxBytes,
  readChartSourceRoots,
  readGroundednessThreshold,
  readMaxRetries,
  readPromptCharLimit,
  readTemperature,
} from '../src/atoms/tunables.ts'

describe('atomic tunable readers', () => {
  it('absent keys keep the fallback and report unconfigured', () => {
    expect(readTemperature({}, 0.2)).toEqual({ ok: true, value: 0.2, configured: false })
  })

  it('accepts in-range values and reports configured', () => {
    expect(readTemperature({ temperature: 1.5 }, 0)).toEqual({ ok: true, value: 1.5, configured: true })
    expect(readMaxRetries({ max_retries: 10 }, 2)).toEqual({ ok: true, value: 10, configured: true })
    expect(readPromptCharLimit({ prompt_char_limit: 1 }, 8000)).toEqual({ ok: true, value: 1, configured: true })
    expect(readGroundednessThreshold({ groundedness_threshold: 0 }, 0.6)).toEqual({
      ok: true,
      value: 0,
      configured: true,
    })
  })

  it('rejects non-numbers, non-finite values and out-of-range values', () => {
    expect(readTemperature({ temperature: '0.5' }, 0)).toEqual({
      ok: false,
      reason: 'params.temperature 必须是：0-2 的数字',
    })
    expect(readTemperature({ temperature: Number.NaN }, 0).ok).toBe(false)
    expect(readTemperature({ temperature: Number.POSITIVE_INFINITY }, 0).ok).toBe(false)
    expect(readTemperature({ temperature: 3 }, 0).ok).toBe(false)
    expect(readTemperature({ temperature: -1 }, 0).ok).toBe(false)
  })

  it('max_retries requires an integer in [0, 10]', () => {
    expect(readMaxRetries({ max_retries: 1.5 }, 2).ok).toBe(false)
    expect(readMaxRetries({ max_retries: -1 }, 2).ok).toBe(false)
    expect(readMaxRetries({ max_retries: 11 }, 2).ok).toBe(false)
  })

  it('prompt_char_limit requires a positive integer', () => {
    expect(readPromptCharLimit({ prompt_char_limit: 1.5 }, 8000).ok).toBe(false)
    expect(readPromptCharLimit({ prompt_char_limit: 0 }, 8000).ok).toBe(false)
  })

  it('groundedness_threshold requires a number in [0, 1]', () => {
    expect(readGroundednessThreshold({ groundedness_threshold: 1.5 }, 0.6).ok).toBe(false)
    expect(readGroundednessThreshold({ groundedness_threshold: -0.5 }, 0.6).ok).toBe(false)
  })

  it('chart_source_roots keeps the default, accepts explicit lists and empty lockdown', () => {
    expect(readChartSourceRoots({})).toEqual({ ok: true, roots: undefined })
    expect(readChartSourceRoots({ chart_source_roots: ['/cases', 'relative'] })).toEqual({
      ok: true,
      roots: ['/cases', 'relative'],
    })
    expect(readChartSourceRoots({ chart_source_roots: [] })).toEqual({ ok: true, roots: [] })
  })

  it('chart_source_roots rejects non-arrays and blank or non-string entries', () => {
    expect(readChartSourceRoots({ chart_source_roots: 'cases' }).ok).toBe(false)
    expect(readChartSourceRoots({ chart_source_roots: [1] }).ok).toBe(false)
    expect(readChartSourceRoots({ chart_source_roots: [''] }).ok).toBe(false)
    expect(readChartSourceRoots({ chart_source_roots: ['   '] }).ok).toBe(false)
  })

  it('chart_source_max_bytes requires a positive integer up to the ceiling', () => {
    expect(readChartSourceMaxBytes({})).toEqual({
      ok: true,
      value: DEFAULT_CHART_SOURCE_MAX_BYTES,
      configured: false,
    })
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: 10 })).toEqual({
      ok: true,
      value: 10,
      configured: true,
    })
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: 1 }).ok).toBe(true)
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: MAX_CHART_SOURCE_MAX_BYTES }).ok).toBe(true)
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: 0 }).ok).toBe(false)
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: 1.5 }).ok).toBe(false)
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: MAX_CHART_SOURCE_MAX_BYTES + 1 }).ok).toBe(false)
    expect(readChartSourceMaxBytes({ chart_source_max_bytes: '10' }).ok).toBe(false)
  })
})

type HandlerCase = { name: string; handler: StageHandler; state: Record<string, unknown> }

const PROMPT_HANDLERS: readonly HandlerCase[] = [
  { name: 'extract', handler: new ExtractHandler(), state: { text: '输入文本' } },
  { name: 'claim-strategy', handler: new ClaimStrategyHandler(), state: { source_text: '交底书原文' } },
  { name: 'compare', handler: new CompareHandler(), state: { claim: '权利要求' } },
  { name: 'novelty', handler: new NoveltyHandler(), state: { features: ['F1'] } },
  { name: 'keywords', handler: new KeywordsHandler(), state: { extraction_result: '分析摘要' } },
  { name: 'reasoning', handler: new ReasoningHandler(), state: { reasoning_input: '上下文' } },
  {
    name: 'groundedness',
    handler: new GroundednessHandler(),
    state: { features: ['F1'], source_text: '原文' },
  },
  { name: 'claim-chart', handler: new ClaimChartHandler(), state: { claim: '权利要求', chart_targets: '[]' } },
]

describe('handler tunable degradation', () => {
  it.each(PROMPT_HANDLERS)('$name rejects an invalid temperature before calling the model', async ({ name, handler, state }) => {
    let calls = 0
    const provider: StageProvider = { callLLM: async () => { calls += 1; return '{}' } }
    const out = await handler.execute({ state: { ...state, temperature: 3 }, provider })
    expect(String(out._error)).toBe(`[${name}] params.temperature 必须是：0-2 的数字`)
    expect(calls).toBe(0)
  })

  it.each(PROMPT_HANDLERS)('$name rejects an invalid prompt_char_limit', async ({ name, handler, state }) => {
    const out = await handler.execute({ state: { ...state, prompt_char_limit: 0 }, provider: {} })
    expect(String(out._error)).toBe(`[${name}] params.prompt_char_limit 必须是：正整数`)
  })

  it('claim-chart rejects an invalid max_retries', async () => {
    const out = await new ClaimChartHandler().execute({
      state: { claim: '权利要求', chart_targets: '[]', max_retries: 1.5 },
      provider: {},
    })
    expect(String(out._error)).toBe('[claim-chart] params.max_retries 必须是：0-10 的整数')
  })

  it('groundedness rejects an invalid groundedness_threshold', async () => {
    const out = await new GroundednessHandler().execute({
      state: { features: ['F1'], source_text: '原文', groundedness_threshold: 1.5 },
      provider: {},
    })
    expect(String(out._error)).toBe('[groundedness] params.groundedness_threshold 必须是：0-1 的数字')
  })
})

/** Capture prompts and per-call temperatures from the string LLM seam. */
function captureLlm(reply: string): {
  provider: StageProvider
  prompts: string[]
  temperatures: Array<number | undefined>
} {
  const prompts: string[] = []
  const temperatures: Array<number | undefined> = []
  return {
    prompts,
    temperatures,
    provider: {
      callLLM: async (prompt, opts) => {
        prompts.push(prompt)
        temperatures.push(opts?.temperature)
        return reply
      },
    },
  }
}

describe('handler tunable application', () => {
  it('extract forwards temperature and caps the prompt data block', async () => {
    const llm = captureLlm(JSON.stringify({ features: ['F1'] }))
    await new ExtractHandler().execute({
      state: { text: 'x'.repeat(100), temperature: 0.7, prompt_char_limit: 10 },
      provider: llm.provider,
    })
    expect(llm.temperatures).toEqual([0.7])
    expect(llm.prompts[0]).toContain('x'.repeat(10))
    expect(llm.prompts[0]).not.toContain('x'.repeat(11))
  })

  it('claim-strategy applies one limit to the PFIE and source blocks', async () => {
    const llm = captureLlm(JSON.stringify({ essential_features: [] }))
    await new ClaimStrategyHandler().execute({
      state: {
        merge_result: 'm'.repeat(100),
        source_text: 's'.repeat(100),
        prompt_char_limit: 5,
      },
      provider: llm.provider,
    })
    expect(llm.prompts[0]).toContain('m'.repeat(5))
    expect(llm.prompts[0]).not.toContain('m'.repeat(6))
    expect(llm.prompts[0]).toContain('s'.repeat(5))
    expect(llm.prompts[0]).not.toContain('s'.repeat(6))
  })

  it('compare raises the claim cap when configured above its default', async () => {
    const claim = 'a'.repeat(5000)
    const llm = captureLlm(JSON.stringify({ claim_chart: [{ feature: 'F1' }] }))
    await new CompareHandler().execute({
      state: { claim, prompt_char_limit: 5000 },
      provider: llm.provider,
    })
    expect(llm.prompts[0]).toContain(claim)
  })

  it('claim-chart honors max_retries = 0 with a single model call', async () => {
    let calls = 0
    const provider: StageProvider = {
      callLLM: async () => {
        calls += 1
        return JSON.stringify({
          elements: [{ id: '1a', claimNo: 1, kind: 'limitation' }],
          rows: [],
        })
      },
    }
    const out = await new ClaimChartHandler().execute({
      state: { claim: '1. 一种装置，包括壳体。', chart_targets: '[]', max_retries: 0 },
      provider,
    })
    expect(calls).toBe(1)
    expect(String(out._error)).toContain('重做超限（0 次）')
  })

  it('groundedness applies the configured threshold and states it in the prompt', async () => {
    const llm = captureLlm(JSON.stringify({ scores: [{ feature: 'F1', score: 0.8 }] }))
    const out = await new GroundednessHandler().execute({
      state: { features: ['F1'], source_text: '原文', groundedness_threshold: 0.9 },
      provider: llm.provider,
    })
    expect(out.low_confidence_features).toEqual(['F1'])
    expect(llm.prompts[0]).toContain('<0.9')
  })
})
