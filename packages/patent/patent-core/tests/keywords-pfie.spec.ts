import { describe, expect, it } from 'vitest'
import type { StageProvider } from '@deepseek-ai/dsh-patent-core'
import { KeywordsHandler, SearchHandler } from '../src/atoms/handlers/builtin/search.ts'

/** 捕获提示词并按关键词 JSON 应答。 */
function captureProvider(prompts: string[]): StageProvider {
  return {
    callLLM: async (prompt) => {
      prompts.push(prompt)
      return JSON.stringify({ keywords: ['分拣', '传感器'] })
    },
  }
}

describe('keywords：PFIE 输入', () => {
  it('只有 pfe_triples 时按四元组格式化提示词', async () => {
    const prompts: string[] = []
    const out = await new KeywordsHandler().execute({
      state: {
        pfe_triples: [
          {
            id: 'T1',
            problem: '如何自动分拣',
            insight: '视觉闭环',
            features: ['传送带', ''],
            effects: ['提高准确率'],
          },
        ],
      },
      provider: captureProvider(prompts),
    })

    expect(out.keywords).toEqual(['分拣', '传感器'])
    const prompt = prompts[0]!
    expect(prompt).toContain('【PFIE 分析结果】')
    expect(prompt).toContain('问题：如何自动分拣')
    expect(prompt).toContain('发明认知：视觉闭环')
    expect(prompt).toContain('特征：传送带')
    expect(prompt).toContain('效果：提高准确率')
    expect(prompt).not.toContain('【分析结果】')
  })

  it('PFIE 优先于 extraction_result / source_text', async () => {
    const prompts: string[] = []
    await new KeywordsHandler().execute({
      state: {
        pfe_triples: [{ problem: '如何自动分拣', features: ['传送带'], effects: [] }],
        extraction_result: '原始抽取 JSON',
        source_text: '原始交底书',
      },
      provider: captureProvider(prompts),
    })

    const prompt = prompts[0]!
    expect(prompt).toContain('问题：如何自动分拣')
    expect(prompt).not.toContain('原始抽取 JSON')
    expect(prompt).not.toContain('原始交底书')
  })

  it('跳过非对象条目、空字段与标量字段；没有可渲染条目时回退文本输入', async () => {
    const prompts: string[] = []
    await new KeywordsHandler().execute({
      state: {
        pfe_triples: ['纯文本条目', {}, { problem: '', insight: 42, features: '单条特征', effects: [] }],
        source_text: '交底书正文',
      },
      provider: captureProvider(prompts),
    })

    const prompt = prompts[0]!
    expect(prompt).toContain('【PFIE 分析结果】')
    expect(prompt).toContain('特征：单条特征')
    expect(prompt).not.toContain('纯文本条目')
    expect(prompt).not.toContain('问题：')
  })

  it('pfe_triples 全为空且无其他文本时降级', async () => {
    const out = await new KeywordsHandler().execute({
      state: { pfe_triples: [null, { problem: '' }] },
      provider: captureProvider([]),
    })
    expect(String(out._error)).toMatch(/输入为空/)
  })

  it('无 PFIE 时沿用文本输入并标注【分析结果】', async () => {
    const prompts: string[] = []
    await new KeywordsHandler().execute({
      state: { source_text: '一种分拣装置' },
      provider: captureProvider(prompts),
    })

    const prompt = prompts[0]!
    expect(prompt).toContain('【分析结果】')
    expect(prompt).toContain('一种分拣装置')
    expect(prompt).not.toContain('【PFIE 分析结果】')
  })

  it('模型返回非 JSON 时降级', async () => {
    const out = await new KeywordsHandler().execute({
      state: { source_text: '一种分拣装置' },
      provider: { callLLM: async () => '抱歉，我无法生成关键词。' },
    })
    expect(String(out._error)).toMatch(/关键词 JSON 解析失败/)
  })
})

describe('search：max_results', () => {
  it('接受数字与数字字符串，向下取整，非法值回退 5', async () => {
    const cases: { value: unknown; expected: number }[] = [
      { value: '3', expected: 3 },
      { value: 3, expected: 3 },
      { value: 3.9, expected: 3 },
      { value: 0, expected: 5 },
      { value: Number.NaN, expected: 5 },
      { value: Infinity, expected: 5 },
      { value: 'abc', expected: 5 },
      { value: '  ', expected: 5 },
      { value: undefined, expected: 5 },
    ]

    for (const { value, expected } of cases) {
      const seen: number[] = []
      await new SearchHandler().execute({
        state: { query: '分拣装置', max_results: value },
        provider: {
          search: async (_query, options) => {
            seen.push(options?.maxResults ?? -1)
            return []
          },
        },
      })
      expect(seen, `max_results=${String(value)}`).toEqual([expected])
    }
  })
})
