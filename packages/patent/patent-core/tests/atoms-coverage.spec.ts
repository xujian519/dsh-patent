import { expect, it } from 'vitest'
import {
  AtomRegistry,
  AtomRegistryError,
  ClaimChartHandler,
  CompareHandler,
  DraftClaimsHandler,
  ExtractHandler,
  InterruptStageError,
  KeywordsHandler,
  LookupStageHandler,
  NoveltyHandler,
  SearchHandler,
  StageCancelledError,
  StageHandlerRegistry,
  collectStateText,
  registerBuiltinAtoms,
  type ClaimChart,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'

registerBuiltinAtoms()

// ---------------------------------------------------------------------------
// 注册表与错误模型其余分支
// ---------------------------------------------------------------------------

it('AtomRegistry：缺少 description 抛错', () => {
  const reg = new AtomRegistry()
  expect(() => {
    reg.register({ name: 'x', description: '  ', category: 'search', inputSchema: [], outputSchema: [] })
  }).toThrow(AtomRegistryError)
})

it('StageHandlerRegistry：缺少 name 抛错（构造函数经 register 覆盖）', () => {
  const reg = new StageHandlerRegistry()
  try {
    reg.register({ name: '  ', category: 'search', execute: async () => ({}) })
    expect.unreachable('应抛出 StageHandlerRegistryError')
  } catch (err) {
    expect((err as Error).name).toBe('StageHandlerRegistryError')
  }
})

// ---------------------------------------------------------------------------
// collectStateText：skipKey / 数组块 / fallback
// ---------------------------------------------------------------------------

it('collectStateText：skipKey 过滤与数组块', () => {
  expect(collectStateText({ a: 'text' }, { skipKey: key => key === 'a' })).toBe('')
  expect(collectStateText({ list: ['x', 'y'] })).toBe('## list\n[\n  "x",\n  "y"\n]')
})

it('collectStateText：无块时 fallback 兜底', () => {
  expect(collectStateText({ _meta: 'm', empty: '' }, { fallback: 'fb' })).toBe('fb')
  expect(collectStateText({ _meta: 'm' })).toBe('')
})

// ---------------------------------------------------------------------------
// search：空结果 / 长查询 / 检索异常
// ---------------------------------------------------------------------------

it('search：空结果与长查询摘要截断', async () => {
  const h = new SearchHandler()
  const empty = await h.execute({ state: { query: 'x' }, provider: { search: async () => [] } })
  expect(String(empty.search_summary)).toMatch(/未检索到相关文献/)

  const longQuery = '长'.repeat(100)
  const withDocs = await h.execute({
    state: { query: longQuery },
    provider: { search: async () => [{ title: 't', url: 'https://example.com' }] },
  })
  expect(String(withDocs.search_summary)).toContain('…')
  expect(String(withDocs.search_summary)).toMatch(/检索到 1 篇/)

  const emptyLong = await h.execute({ state: { query: longQuery }, provider: { search: async () => [] } })
  expect(String(emptyLong.search_summary)).toContain('…')
})

it('search：摘要携带命中详情，并与调用方提供的证据合并去重', async () => {
  const h = new SearchHandler()
  const out = await h.execute({
    state: {
      query: '阀体',
      prior_art: [{ title: '调用方证据', url: 'https://example.com/same', publicationDate: '2022-01-01' }],
    },
    provider: {
      search: async () => [
        { title: '调用方证据', url: 'https://example.com/same' },
        { title: '检索命中', publicationDate: '2023-01-01', snippet: '摘要片段' },
      ],
    },
  })
  expect(out.prior_art).toHaveLength(2)
  expect(out.prior_art).toMatchObject([{ title: '调用方证据' }, { title: '检索命中' }])
  const summary = String(out.search_summary)
  expect(summary).toContain('检索到 2 篇相关文献')
  expect(summary).toContain('连同调用方提供的 1 篇，共 2 篇')
  expect(summary).toContain('- D1 调用方证据')
  expect(summary).toContain('- D2 检索命中｜公开日 2023-01-01')
  expect(summary).toContain('摘要片段')
})

it('search：非对象条目与缺失元数据仍能渲染并去重', async () => {
  const h = new SearchHandler()
  const out = await h.execute({
    state: {
      query: '阀体',
      prior_art: [
        '调用方纯文本',
        { publicationDate: '2023-01-01', dLabel: 5 },
        { title: '格式错误的标号', dLabel: 'X' },
        { title: '带标号', dLabel: 'D9' },
        { title: '无元数据' },
      ],
    },
    provider: {
      search: async () => [
        { title: '检索命中', snippet: '摘要'.repeat(200) },
        { title: '' },
      ],
    },
  })
  const summary = String(out.search_summary)
  expect(summary).toContain('- D1 调用方纯文本')
  expect(summary).toContain('- D2 #2')
  expect(summary).toContain('- D3 格式错误的标号')
  expect(summary).toContain('- D9 带标号')
  expect(summary).toContain('- D5 无元数据')
  expect(summary).toContain('- D6 检索命中')
  expect(summary).toContain('- D7 #7')
  expect(summary).toContain('…')
  expect(out.prior_art).toHaveLength(7)
})

it('search：检索抛 Error 与非 Error 均降级', async () => {
  const h = new SearchHandler()
  const err = await h.execute({ state: { query: 'x' }, provider: { search: async () => { throw new Error('net') } } })
  expect(String(err._error)).toMatch(/检索失败: net/)
  const nonErr = await h.execute({ state: { query: 'x' }, provider: { search: async () => { throw 'boom' } } })
  expect(String(nonErr._error)).toMatch(/检索失败: boom/)
})

it('search：已取消的信号不发起检索', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await expect(new SearchHandler().execute({
    state: { query: 'x' },
    provider: { search: async () => { calls += 1; return [] } },
    signal: controller.signal,
  })).rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'search' })
  expect(calls).toBe(0)
})

it('search：执行中取消与 AbortError 均传播为类型化取消，不降级', async () => {
  const h = new SearchHandler()
  const controller = new AbortController()
  const pending = h.execute({
    state: { query: 'x' },
    provider: {
      search: () => new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    },
    signal: controller.signal,
  })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'search' })

  await expect(h.execute({
    state: { query: 'x' },
    provider: { search: async () => { throw new DOMException('aborted', 'AbortError') } },
  })).rejects.toBeInstanceOf(StageCancelledError)
  await expect(h.execute({
    state: { query: 'x' },
    provider: { search: async () => { throw new StageCancelledError('inner') } },
  })).rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'inner' })
})

// ---------------------------------------------------------------------------
// keywords：LLM 失败 / 非数组输出 / 端口路由
// ---------------------------------------------------------------------------

it('keywords：LLM 失败与 JSON 解析失败降级', async () => {
  const h = new KeywordsHandler()
  const failing = await h.execute({
    state: { extraction_result: 'x' },
    provider: { callLLM: async () => { throw new Error('timeout') } },
  })
  expect(String(failing._error)).toMatch(/LLM 调用失败: timeout/)
  const throwing = await h.execute({
    state: { extraction_result: 'x' },
    provider: { callLLM: async () => { throw 'boom' } },
  })
  expect(String(throwing._error)).toMatch(/LLM 调用失败: boom/)
  const noKeywords = await h.execute({
    state: { extraction_result: 'x' },
    provider: { callLLM: async () => JSON.stringify({ other: [] }) },
  })
  expect(String(noKeywords._error)).toMatch(/keywords 不是数组/)
})

it('keywords：经 provider.llm 端口路由（schema/temperature 透传）', async () => {
  const h = new KeywordsHandler()
  const port: StageProvider = {
    llm: {
      stream: async function* () {
        yield { type: 'delta', text: '{"keywords": ["关键词1"]}' }
        yield { type: 'done' }
      },
    },
  }
  const out = await h.execute({ state: { extraction_result: 'x' }, provider: port })
  expect(out.keywords).toEqual(['关键词1'])
})

// ---------------------------------------------------------------------------
// compare：prior_art 缺字段 / 输出兜底 / 失败路径
// ---------------------------------------------------------------------------

it('compare：prior_art 缺 title/snippet 的格式化', async () => {
  const h = new CompareHandler()
  const out = await h.execute({
    state: { claim: '特征 F1', prior_art: [{ url: 'https://example.com/d1' }] },
    provider: {
      callLLM: async () => JSON.stringify({ claim_chart: [{ feature: 'F1', prior_art_match: '', identical: false }] }),
    },
  })
  expect(Array.isArray(out.claim_chart)).toBe(true)
})

it('compare：缺 diff_features / 缺 claim_chart / 失败路径', async () => {
  const h = new CompareHandler()
  const noDiff = await h.execute({
    state: { claim: 'F1', prior_art: [] },
    provider: { callLLM: async () => JSON.stringify({ claim_chart: [{ feature: 'F1' }] }) },
  })
  expect(noDiff.diff_features).toEqual([])

  const noChart = await h.execute({
    state: { claim: 'F1' },
    provider: { callLLM: async () => '{"foo":1}' },
  })
  expect(String(noChart._error)).toMatch(/claim_chart 不是数组/)

  const noProvider = await h.execute({ state: { claim: 'F1' }, provider: {} })
  expect(String(noProvider._error)).toMatch(/未配置 LLM/)

  const noClaim = await h.execute({ state: {}, provider: { callLLM: async () => '{}' } })
  expect(String(noClaim._error)).toMatch(/权利要求为空/)

  const failing = await h.execute({ state: { claim: 'F1' }, provider: { callLLM: async () => { throw new Error('x') } } })
  expect(String(failing._error)).toMatch(/LLM 调用失败/)
})

// ---------------------------------------------------------------------------
// novelty：失败路径与输出兜底
// ---------------------------------------------------------------------------

it('novelty：无 LLM / 缺 assessments / 缺 conclusion', async () => {
  const h = new NoveltyHandler()
  const noProvider = await h.execute({ state: { features: ['F1'] }, provider: {} })
  expect(String(noProvider._error)).toMatch(/未配置 LLM/)

  const noAssessments = await h.execute({
    state: { features: ['F1'] },
    provider: { callLLM: async () => JSON.stringify({ conclusion: 'c' }) },
  })
  expect(String(noAssessments._error)).toMatch(/assessments 不是数组/)

  const noConclusion = await h.execute({
    state: { features: ['F1'] },
    provider: { callLLM: async () => JSON.stringify({ assessments: [{ feature: 'F1', disclosed: false }] }) },
  })
  expect(noConclusion.novelty_conclusion).toBe('')

  const failing = await h.execute({ state: { features: ['F1'] }, provider: { callLLM: async () => { throw new Error('x') } } })
  expect(String(failing._error)).toMatch(/LLM 调用失败/)
})

// ---------------------------------------------------------------------------
// reasoning：显式输入 / LLM 失败
// ---------------------------------------------------------------------------

it('reasoning：显式 reasoning_input 直传', async () => {
  const h = LookupStageHandler('reasoning')!
  const out = await h.execute({
    state: { reasoning_input: '显式输入', reasoning_prompt: '分析' },
    provider: { callLLM: async () => '结论' },
  })
  expect(out.conclusion).toBe('结论')
  const failing = await h.execute({
    state: { reasoning_prompt: 'p' },
    provider: { callLLM: async () => { throw new Error('x') } },
  })
  expect(String(failing._error)).toMatch(/LLM 调用失败/)
})

// ---------------------------------------------------------------------------
// groundedness：原文缺失 / scores 兜底 / 全部高依据
// ---------------------------------------------------------------------------

it('groundedness：原文缺失与 scores 非数组', async () => {
  const h = LookupStageHandler('groundedness')!
  const noSource = await h.execute({ state: { features: ['F1'] }, provider: { callLLM: async () => '{}' } })
  expect(String(noSource._error)).toMatch(/原文缺失/)

  const noScores = await h.execute({
    state: { features: ['F1'], source_text: 'x' },
    provider: { callLLM: async () => JSON.stringify({ feedback: 'f' }) },
  })
  expect(noScores.groundedness_result).toBe('{"feedback":"f"}')
})

it('groundedness：缺 feature 的低分项与全部高依据反馈', async () => {
  const h = LookupStageHandler('groundedness')!
  // 低分项缺 feature → feature ?? '' 兜底后过滤；lowNames 为空 → 高依据反馈分支
  const mixed = await h.execute({
    state: { features: ['F1'], source_text: 'x' },
    provider: {
      callLLM: async () => JSON.stringify({ scores: [{ score: 0.3 }, { score: 0.8, feature: 'F2' }], feedback: 'f' }),
    },
  })
  expect(String(mixed.groundedness_feedback)).toMatch(/全部特征均有充分原文依据/)
})

// ---------------------------------------------------------------------------
// draft-claims：策略表必填、确定性渲染与 claim_lint 否决
// ---------------------------------------------------------------------------

/** 一份可渲染的已复核策略表。 */
function claimStrategy(optionalText = '图像采集模块'): string {
  return JSON.stringify({
    invention_name: '灌溉装置',
    tech_domain: 'mechanical',
    essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块', anchor_reason: 'exact' }],
    optional_features: [{ id: 'F2', text: optionalText, anchor: '图像采集模块', anchor_reason: 'exact' }],
    dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    prior_art_ref: null,
    prior_art_text: '',
  })
}

it('draft-claims：按策略表确定性渲染独权与多路从权', async () => {
  const h = new DraftClaimsHandler()
  const out = await h.execute({ state: { claim_strategy: claimStrategy() } })
  expect(String(out.claims_draft)).toMatch(/^1\. 一种灌溉装置，其特征在于，包括：控制模块。/)
  expect(String(out.claims_draft)).toContain('2. 根据权利要求1所述的灌溉装置，其特征在于，还包括：图像采集模块。')
  expect(String(out.review_context)).toContain('【权利要求策略表】')
  expect(String(out.draft_claims_result)).toContain('"specialist":"skipped"')
})

it('draft-claims：策略表缺失或不可解析时降级，不写半成品', async () => {
  const h = new DraftClaimsHandler()
  const missing = await h.execute({ state: { merge_result: 'x' } })
  expect(String(missing._error)).toMatch(/claim_strategy 缺失/)
  expect(missing.claims_draft).toBeUndefined()

  const malformed = await h.execute({ state: { claim_strategy: '{"essential_features":[]}' } })
  expect(String(malformed._error)).toMatch(/invention_name|essential_features/)
  expect(malformed.claims_draft).toBeUndefined()
})

it('draft-claims：claim_lint 任一 error 否决本轮草稿', async () => {
  const h = new DraftClaimsHandler()
  const out = await h.execute({ state: { claim_strategy: claimStrategy('所述壳体') } })
  expect(String(out._error)).toMatch(/claim_lint 否决/)
  expect(out.claims_draft).toBeUndefined()
})

// ---------------------------------------------------------------------------
// extract：失败路径与数组兜底
// ---------------------------------------------------------------------------

it('extract：LLM 失败与缺 features 兜底', async () => {
  const h = new ExtractHandler()
  const failing = await h.execute({ state: { text: 'x' }, provider: { callLLM: async () => { throw new Error('x') } } })
  expect(String(failing._error)).toMatch(/LLM 调用失败/)

  const noFeatures = await h.execute({
    state: { text: 'x' },
    provider: { callLLM: async () => JSON.stringify({ problems: ['P'] }) },
  })
  expect(String(noFeatures._error)).toMatch(/features 不是数组/)

  const wrongTypes = await h.execute({
    state: { text: 'x' },
    provider: { callLLM: async () => JSON.stringify({ features: ['F'], problems: 'x', effects: 42 }) },
  })
  expect(String(wrongTypes._error)).toMatch(/problems 不是数组/)
})

// ---------------------------------------------------------------------------
// merge：问题数多于特征数 → 缺位补空
// ---------------------------------------------------------------------------

it('merge：问题数多于特征/效果时补空数组', async () => {
  const h = LookupStageHandler('merge')!
  const out = await h.execute({ state: { problems: ['P1', 'P2'], features: ['F1'], effects: [] } })
  const triples = out.pfe_triples as Array<{ features: string[]; effects: string[] }>
  expect(triples[1]!.features).toEqual([])
  expect(triples[1]!.effects).toEqual([])
})

// ---------------------------------------------------------------------------
// approval-gate：缺省上下文
// ---------------------------------------------------------------------------

it('approval-gate：缺省 review_context/guardrail_level', async () => {
  const h = LookupStageHandler('approval-gate')!
  await expect(h.execute({ state: {} })).rejects.toSatisfy((err: unknown) => {
    expect(isInterruptError(err)).toBe(true)
    expect((err as InterruptStageError).data.review_context).toBe('该阶段产出需要人工确认')
    expect((err as InterruptStageError).data.guardrail_level).toBe('high')
    return true
  })
})

function isInterruptError(err: unknown): boolean {
  return err instanceof InterruptStageError
}

// ---------------------------------------------------------------------------
// claim-chart：chart_targets 解析与缺省分支
// ---------------------------------------------------------------------------

const CLAIM = '1. 一种过滤装置，包括壳体和滤芯，所述滤芯含有活性炭。'
const ELEMENTS_ONLY = {
  elements: [{ id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' }],
  rows: [],
}

it('claim-chart：chart_targets 解析失败与缺省字段', async () => {
  const handler = new ClaimChartHandler()
  const goodProvider: StageProvider = { callLLM: async () => JSON.stringify(ELEMENTS_ONLY) }

  // 空 chart_targets → 元素模式
  const empty = await handler.execute({ state: { claim: CLAIM, chart_targets: '' }, provider: goodProvider })
  expect(typeof empty.claim_chart_doc).toBe('string')

  // 非数组 JSON → 降级
  const notArray = await handler.execute({ state: { claim: CLAIM, chart_targets: '{"x":1}' }, provider: goodProvider })
  expect(String(notArray._error)).toMatch(/不是数组/)

  // 损坏 JSON → 降级
  const broken = await handler.execute({ state: { claim: CLAIM, chart_targets: '{oops' }, provider: goodProvider })
  expect(String(broken._error)).toMatch(/解析失败/)

  // 非法 kind（id 为字符串）→ 降级
  const badKind = await handler.execute({
    state: { claim: CLAIM, chart_targets: JSON.stringify([{ id: 'X', kind: 'foo' }]) },
    provider: goodProvider,
  })
  expect(String(badKind._error)).toMatch(/kind 非法/)
  expect(String(badKind._error)).toContain('"X"')

  // 缺 id → 带下标的降级（id 是行映射的引用键）
  const noId = await handler.execute({
    state: { claim: CLAIM, chart_targets: JSON.stringify([{ kind: 'bogus' }]) },
    provider: goodProvider,
  })
  expect(String(noId._error)).toMatch(/chart_targets\[0\] 缺少 id/)

  // product kind 归一化 + 无 title → 成功且 target 字段缺省
  const product = await handler.execute({
    state: { claim: CLAIM, chart_targets: JSON.stringify([{ id: 'P1', kind: 'product' }]) },
    provider: goodProvider,
  })
  const productDoc = JSON.parse(product.claim_chart_doc as string) as ClaimChart
  expect(productDoc.targets[0]!.kind).toBe('accused-product')
  expect(productDoc.targets[0]!.title).toBeUndefined()

  // 无 id 的 prior-art target → 降级（不能成为行映射目标）
  const unnamed = await handler.execute({
    state: { claim: CLAIM, chart_targets: JSON.stringify([{ kind: 'prior-art' }]) },
    provider: goodProvider,
  })
  expect(String(unnamed._error)).toMatch(/chart_targets\[0\] 缺少 id/)

  // 非法 mode → 降级并列出取值域（不静默回退）
  const badMode = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]', chart_mode: 'bogus' },
    provider: goodProvider,
  })
  expect(String(badMode._error)).toMatch(/chart_mode 非法/)
  expect(String(badMode._error)).toContain('"bogus"')

  // 无 chart_mode → 缺省 invalidity
  const noMode = await handler.execute({ state: { claim: CLAIM, chart_targets: '[]' }, provider: goodProvider })
  expect((JSON.parse(noMode.claim_chart_doc as string) as { mode: string }).mode).toBe('invalidity')
})

it('claim-chart：无 provider / 无 claim / LLM 失败 / 非数组输出', async () => {
  const handler = new ClaimChartHandler()

  const noProvider = await handler.execute({ state: { claim: CLAIM, chart_targets: '[]' }, provider: {} })
  expect(String(noProvider._error)).toMatch(/未配置 LLM/)

  const noClaim = await handler.execute({ state: { chart_targets: '[]' }, provider: { callLLM: async () => '{}' } })
  expect(String(noClaim._error)).toMatch(/权利要求为空/)

  const failing = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]' },
    provider: { callLLM: async () => { throw new Error('timeout') } },
  })
  expect(String(failing._error)).toMatch(/LLM 调用失败/)

  // LLM 输出非数组 elements/rows → parseLlmJson 兜底 → 空要素列表校验失败 → 重做超限降级
  const nonArray = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]' },
    provider: { callLLM: async () => JSON.stringify({ foo: 1 }) },
  })
  expect(String(nonArray._error)).toMatch(/校验失败且重做超限/)
})

it('claim-chart：字段级 malformed 打回重做；多 claimNo 排序', async () => {
  const handler = new ClaimChartHandler()
  const prompts: string[] = []
  let calls = 0
  const malformed = {
    elements: [{ id: 42, claimNo: 'x', text: 't', kind: null }],
    rows: [{ elementId: 1, targetId: 2, quote: 'q', pinCite: 3, mapping: 4 }],
  }
  const multiClaim = {
    elements: [
      { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
      { id: '2a', claimNo: 2, text: '和滤芯', kind: 'limitation' },
    ],
    rows: [],
  }
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1
      prompts.push(prompt)
      return calls === 1 ? JSON.stringify(malformed) : JSON.stringify(multiClaim)
    },
  }
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]', chart_mode: 'invalidity' },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!).toMatch(/校验失败/)
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.claimNos).toEqual([1, 2])
})
