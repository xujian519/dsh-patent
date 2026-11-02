import { describe, expect, it } from 'vitest'
import {
  CompareHandler,
  ExtractHandler,
  KeywordsHandler,
  NoveltyHandler,
  type StageHandler,
} from '@deepseek-ai/dsh-patent-core'

const run = async (
  handler: StageHandler,
  state: Record<string, unknown>,
  raw: string,
): Promise<Record<string, unknown>> =>
  await handler.execute({ state, provider: { callLLM: async () => raw } })

const expectDegradedWithoutStringification = (out: Record<string, unknown>, reason: RegExp): void => {
  expect(String(out._error)).toMatch(reason)
  expect(JSON.stringify(out)).not.toContain('[object Object]')
}

describe('keywords：字符串数组严格校验', () => {
  it('非字符串项降级并带下标', async () => {
    const out = await run(new KeywordsHandler(), { extraction_result: 'x' }, JSON.stringify({ keywords: ['壳体', { x: 1 }] }))
    expectDegradedWithoutStringification(out, /keywords 数组含非字符串项（下标 1）/)
  })
})

describe('compare：claim_chart 与 diff_features 严格校验', () => {
  const STATE = { claim: 'F1', prior_art: [] }

  it('claim_chart 含 null 项降级并带下标', async () => {
    const out = await run(
      new CompareHandler(),
      STATE,
      JSON.stringify({ claim_chart: [{ feature: 'F1' }, null] }),
    )
    expectDegradedWithoutStringification(out, /claim_chart 数组含非对象项（下标 1）/)
  })

  it('claim_chart 条目缺少 feature 降级并带下标', async () => {
    const out = await run(new CompareHandler(), STATE, JSON.stringify({ claim_chart: [{}] }))
    expectDegradedWithoutStringification(out, /claim_chart\[0\] 缺少 feature 字符串/)
  })

  it('claim_chart 的可选字段类型错误降级', async () => {
    const out = await run(
      new CompareHandler(),
      STATE,
      JSON.stringify({ claim_chart: [{ feature: 'F1', identical: 'yes' }] }),
    )
    expectDegradedWithoutStringification(out, /claim_chart\[0\] 的 identical 不是布尔值/)
  })

  it('claim_chart 的 prior_art_match 与 note 类型错误降级', async () => {
    const priorArtMatch = await run(
      new CompareHandler(),
      STATE,
      JSON.stringify({ claim_chart: [{ feature: 'F1', prior_art_match: 1 }] }),
    )
    expectDegradedWithoutStringification(priorArtMatch, /prior_art_match 不是字符串/)
    const note = await run(
      new CompareHandler(),
      STATE,
      JSON.stringify({ claim_chart: [{ feature: 'F1', note: false }] }),
    )
    expectDegradedWithoutStringification(note, /note 不是字符串/)
  })

  it('非 JSON 输出保留原文兜底', async () => {
    const out = await run(new CompareHandler(), STATE, '模型返回了纯文本对比')
    expect(out.claim_chart).toBe('模型返回了纯文本对比')
  })

  it('diff_features 含非字符串项降级并带下标', async () => {
    const out = await run(
      new CompareHandler(),
      STATE,
      JSON.stringify({ claim_chart: [{ feature: 'F1' }], diff_features: ['F1', 2] }),
    )
    expectDegradedWithoutStringification(out, /diff_features 数组含非字符串项（下标 1）/)
  })
})

describe('novelty：assessments 严格校验', () => {
  const STATE = { features: ['F1'], prior_art: [] }

  it('缺 feature 降级并带下标', async () => {
    const out = await run(new NoveltyHandler(), STATE, JSON.stringify({ assessments: [{ disclosed: true }] }))
    expectDegradedWithoutStringification(out, /assessments\[0\] 缺少 feature 字符串/)
  })

  it('assessments 的可选字段类型错误降级', async () => {
    const priorArt = await run(
      new NoveltyHandler(),
      STATE,
      JSON.stringify({ assessments: [{ feature: 'F1', disclosed: true, prior_art: 1 }] }),
    )
    expectDegradedWithoutStringification(priorArt, /prior_art 不是字符串/)
    const reasoning = await run(
      new NoveltyHandler(),
      STATE,
      JSON.stringify({ assessments: [{ feature: 'F1', disclosed: true, reasoning: [] }] }),
    )
    expectDegradedWithoutStringification(reasoning, /reasoning 不是字符串/)
  })

  it('非 JSON 输出保留原文兜底', async () => {
    const out = await run(new NoveltyHandler(), STATE, '模型返回了纯文本新颖性分析')
    expect(out.novelty_result).toBe('模型返回了纯文本新颖性分析')
    expect(out.evidence_coverage).toBe('none')
  })

  it('disclosed 非布尔值降级并带下标', async () => {
    const out = await run(
      new NoveltyHandler(),
      STATE,
      JSON.stringify({ assessments: [{ feature: 'F1', disclosed: 'yes' }] }),
    )
    expectDegradedWithoutStringification(out, /assessments\[0\] 的 disclosed 不是布尔值/)
  })
})

describe('extract：全量模式字符串数组严格校验', () => {
  it('features 含非字符串项降级并带下标', async () => {
    const out = await run(new ExtractHandler(), { text: 'x' }, JSON.stringify({ features: ['壳体', {}] }))
    expectDegradedWithoutStringification(out, /features 数组含非字符串项（下标 1）/)
  })

  it('effects 含非字符串项降级并带下标', async () => {
    const out = await run(new ExtractHandler(), { text: 'x' }, JSON.stringify({ features: ['壳体'], effects: [{}] }))
    expectDegradedWithoutStringification(out, /effects 数组含非字符串项（下标 0）/)
  })
})
