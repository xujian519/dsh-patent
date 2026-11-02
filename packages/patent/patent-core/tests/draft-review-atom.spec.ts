import { describe, expect, it } from 'vitest'
import {
  DRAFT_REVIEW_ALLOWED_KEYS,
  DRAFT_REVIEW_FORBIDDEN_KEYS,
  DraftReviewHandler,
  REVISION_SIGNALS_KEY,
  checkDraftReviewInput,
  draftReviewAtom,
  type PipelineState,
  type StageProvider,
} from '../src/index.ts'

/** 说明书夹具：缺实施例的特征用于种植 26.3 缺陷。 */
const SPECIFICATION = [
  '## 具体实施方式',
  '本实施例提供一种数据处理方法，包括采集步骤与输出步骤。',
  '实施例1：采集步骤由传感器完成，输出步骤由控制器完成。',
].join('\n')

/** 权利要求夹具。 */
const CLAIMS = [
  '1. 一种数据处理方法，其特征在于，包括：',
  '  采集步骤，由传感器完成；',
  '  输出步骤，由控制器完成。',
].join('\n')

/** 只返回预设 JSON 的 provider。 */
function providerFor(payload: unknown): StageProvider {
  return { callLLM: async () => JSON.stringify(payload) }
}

/** 带完整输入的最小 state。 */
function stateWith(extra: PipelineState = {}): PipelineState {
  return {
    specification: SPECIFICATION,
    claims_draft: CLAIMS,
    ...extra,
  }
}

/** 运行一次审查并返回输出。 */
async function run(
  payload: unknown,
  state: PipelineState = stateWith(),
): Promise<PipelineState> {
  return new DraftReviewHandler().execute({ state, provider: providerFor(payload) })
}

describe('draft-review 原子契约', () => {
  it('只声明白名单输入，且报告与判定同时出现', () => {
    expect(draftReviewAtom.inputSchema).toEqual([...DRAFT_REVIEW_ALLOWED_KEYS])
    for (const key of DRAFT_REVIEW_FORBIDDEN_KEYS) {
      expect(draftReviewAtom.inputSchema).not.toContain(key)
    }
    expect(draftReviewAtom.usesModel).toBe(true)
    expect(draftReviewAtom.logInputScope).toBe(true)
    expect(draftReviewAtom.outputSchema).toEqual([
      'draft_review_report',
      'draft_review_disputes',
      'draft_review_passed',
    ])
  })
})

describe('draft-review 输入隔离', () => {
  it('组装输入携带禁用键时拒绝并报告泄漏键', () => {
    const result = checkDraftReviewInput({ specification: 'x', claim_strategy: '内部策略', merge_result: '融合' })
    expect(result.clean).toBe(false)
    expect(result.leakedKeys).toEqual(['claim_strategy', 'merge_result'])
  })

  it('PFIE 特征与检索文献进入提示词，缺席时省略对应块', async () => {
    let prompt = ''
    const provider: StageProvider = {
      callLLM: async (value) => {
        prompt = value
        return JSON.stringify({ disputes: [] })
      },
    }
    const bare = await new DraftReviewHandler().execute({ state: stateWith(), provider })
    expect(bare._error).toBeUndefined()
    expect(prompt).not.toContain('【PFIE 特征】')
    expect(prompt).not.toContain('【检索文献】')

    const withSources = await new DraftReviewHandler().execute({
      state: stateWith({
        pfe_triples: [{ problem: '提高换热效率' }],
        prior_art: [{ title: 'D1', snippet: '直管加热' }],
      }),
      provider,
    })
    expect(withSources._error).toBeUndefined()
    expect(prompt).toContain('【PFIE 特征】')
    expect(prompt).toContain('提高换热效率')
    expect(prompt).toContain('【检索文献】')
    expect(prompt).toContain('D1')

    const featuresOnly = await new DraftReviewHandler().execute({
      state: stateWith({ features: [{ id: 'F1', text: '换热翅片' }] }),
      provider,
    })
    expect(featuresOnly._error).toBeUndefined()
    expect(prompt).toContain('【PFIE 特征】')
    expect(prompt).toContain('F1')
  })

  it('状态中的策略表与融合结果不进入提示词', async () => {
    let prompt = ''
    const provider: StageProvider = {
      callLLM: async (value) => {
        prompt = value
        return JSON.stringify({ disputes: [] })
      },
    }
    const state = stateWith({
      claim_strategy: 'CLAIM_STRATEGY_LEAK_MARKER',
      claim_strategy_report: 'CLAIM_STRATEGY_REPORT_LEAK_MARKER',
      merge_result: 'MERGE_RESULT_LEAK_MARKER',
      draft_claims_result: 'DRAFT_CLAIMS_RESULT_LEAK_MARKER',
      review_context: 'REVIEW_CONTEXT_LEAK_MARKER',
    })
    const out = await new DraftReviewHandler().execute({ state, provider })
    expect(out._error).toBeUndefined()
    // dataBlock 会把换行转义进 JSON 字面量，按内容片段断言而不是整段原文。
    expect(prompt).toContain('实施例1')
    expect(prompt).toContain('采集步骤')
    for (const marker of [
      'CLAIM_STRATEGY_LEAK_MARKER',
      'CLAIM_STRATEGY_REPORT_LEAK_MARKER',
      'MERGE_RESULT_LEAK_MARKER',
      'DRAFT_CLAIMS_RESULT_LEAK_MARKER',
      'REVIEW_CONTEXT_LEAK_MARKER',
    ]) {
      expect(prompt).not.toContain(marker)
    }
  })
})

describe('draft-review 判定与报告', () => {
  it('干净稿：争议点为空时通过且不发回退信号', async () => {
    const out = await run({ disputes: [] })
    expect(out._error).toBeUndefined()
    expect(out.draft_review_passed).toBe(true)
    expect(out.draft_review_disputes).toEqual([])
    expect(out.draft_review_report).toContain('通过')
    expect(out[REVISION_SIGNALS_KEY]).toBeUndefined()
  })

  it('全部 none 也算通过', async () => {
    const out = await run({
      disputes: [{ category: 'clarity', recommendation: 'none', claimNumber: 1 }],
    })
    expect(out.draft_review_passed).toBe(true)
    expect(out[REVISION_SIGNALS_KEY]).toBeUndefined()
  })

  it('种植缺陷：说明书缺实施例时定位到具体特征与法条并建议补实施例', async () => {
    const out = await run({
      disputes: [{
        category: 'enablement',
        recommendation: 'add-embodiment',
        claimNumber: 1,
        featureId: 'C1F2',
        anchor: '输出步骤由控制器完成。',
      }],
    })
    expect(out._error).toBeUndefined()
    expect(out.draft_review_passed).toBe(false)
    expect(out.draft_review_disputes).toEqual([{
      category: 'enablement',
      provision: '专利法第26条第3款',
      recommendation: 'add-embodiment',
      claimNumber: 1,
      featureId: 'C1F2',
      anchor: '输出步骤由控制器完成。',
    }])
    expect(out.draft_review_report).toContain('充分公开')
    expect(out.draft_review_report).toContain('权利要求 1')
    expect(out.draft_review_report).toContain('特征 C1F2')
    expect(out.draft_review_report).toContain('锚点命中说明书')
    const signals = out[REVISION_SIGNALS_KEY] as Array<{ gapId: string; evidence?: string }>
    expect(signals).toEqual([{
      gapId: 'draft-review:enablement',
      rationale: '专利法第26条第3款 — 充分公开：补充实施例',
      evidence: '权利要求 1；特征 C1F2',
    }])
  })

  it('锚点只在权利要求中命中时标注权利要求，并带上审查说明', async () => {
    const out = await run({
      disputes: [{ category: 'clarity', recommendation: 'clarify-term', anchor: '其特征在于' }],
      notes: '通读两遍',
    })
    expect(out._error).toBeUndefined()
    expect(out.draft_review_report).toContain('锚点命中权利要求')
    expect(out.draft_review_report).toContain('审查说明：通读两遍')
  })

  it('重复争议点只保留第一条', async () => {
    const dispute = { category: 'support', recommendation: 'tighten-claim', claimNumber: 1 }
    const out = await run({ disputes: [dispute, dispute] })
    expect(out.draft_review_disputes).toHaveLength(1)
  })

  it('无法定位到权项或特征的争议点按全篇记录，信号证据回落到争议点清单', async () => {
    const out = await run({ disputes: [{ category: 'unity', recommendation: 'split-unity' }] })
    expect(out.draft_review_report).toContain('全篇')
    const signals = out[REVISION_SIGNALS_KEY] as Array<{ evidence?: string }>
    expect(signals[0]?.evidence).toBe('draft_review_disputes')
  })

  it('同类别多个争议点只发一个回退信号', async () => {
    const out = await run({
      disputes: [
        { category: 'support', recommendation: 'tighten-claim', claimNumber: 1 },
        { category: 'support', recommendation: 'tighten-claim', claimNumber: 2 },
      ],
    })
    expect(out.draft_review_disputes).toHaveLength(2)
    const signals = out[REVISION_SIGNALS_KEY] as Array<{ gapId: string }>
    expect(signals.map(signal => signal.gapId)).toEqual(['draft-review:support'])
  })

  it('每条审查口径都有稳定的法条映射', async () => {
    const categories = ['enablement', 'support', 'clarity', 'unity', 'amendment'] as const
    const out = await run({
      disputes: categories.map(category => ({ category, recommendation: 'none' as const })),
    })
    expect(out.draft_review_disputes).toEqual([
      { category: 'enablement', provision: '专利法第26条第3款', recommendation: 'none' },
      { category: 'support', provision: '专利法第26条第4款', recommendation: 'none' },
      { category: 'clarity', provision: '专利法第26条第4款', recommendation: 'none' },
      { category: 'unity', provision: '专利法第31条第1款', recommendation: 'none' },
      { category: 'amendment', provision: '专利法第33条', recommendation: 'none' },
    ])
  })
})

describe('draft-review 失败路径', () => {
  it('锚点未命中原文时阶段失败，不产出空报告', async () => {
    const out = await run({
      disputes: [{ category: 'enablement', recommendation: 'add-embodiment', anchor: '说明书中不存在的句子' }],
    })
    expect(out.draft_review_passed).toBeUndefined()
    expect(out._error).toContain('锚点未在说明书或权利要求中命中')
  })

  it('审查说明夹带推理过程或己方决策术语时阶段失败', async () => {
    const out = await run({
      disputes: [],
      notes: '推理过程如下：先看 claim_strategy 的特征归属。',
    })
    expect(out.draft_review_passed).toBeUndefined()
    expect(out._error).toContain('输出隔离失败')
    expect(out._error).toContain('推理过程')
    expect(out._error).toContain('claim_strategy')
  })

  it('类别或建议越界时阶段失败', async () => {
    const badCategory = await run({ disputes: [{ category: 'novelty', recommendation: 'none' }] })
    expect(badCategory._error).toContain('category 必须是')
    const badRecommendation = await run({ disputes: [{ category: 'unity', recommendation: 'rewrite' }] })
    expect(badRecommendation._error).toContain('recommendation 必须是')
  })

  it('字段形状不符时逐项报告原因', async () => {
    const nonObject = await run({ disputes: ['不是对象'] })
    expect(nonObject._error).toContain('不是对象')

    const badClaim = await run({ disputes: [{ category: 'unity', recommendation: 'none', claimNumber: 0 }] })
    expect(badClaim._error).toContain('claimNumber 必须是正整数')

    const fractionalClaim = await run({ disputes: [{ category: 'unity', recommendation: 'none', claimNumber: 1.5 }] })
    expect(fractionalClaim._error).toContain('claimNumber 必须是正整数')

    const badFeature = await run({ disputes: [{ category: 'unity', recommendation: 'none', featureId: 3 }] })
    expect(badFeature._error).toContain('featureId 必须是非空字符串')

    const emptyFeature = await run({ disputes: [{ category: 'unity', recommendation: 'none', featureId: ' ' }] })
    expect(emptyFeature._error).toContain('featureId 必须是非空字符串')

    const badAnchor = await run({ disputes: [{ category: 'unity', recommendation: 'none', anchor: 3 }] })
    expect(badAnchor._error).toContain('anchor 必须是非空字符串')
  })

  it('输出不是 JSON、缺 disputes 或缺输入时降级', async () => {
    const provider: StageProvider = { callLLM: async () => '不是 JSON' }
    const notJson = await new DraftReviewHandler().execute({ state: stateWith(), provider })
    expect(notJson._error).toContain('模型输出不是 JSON 对象')

    const missingList = await run({ notes: '只有说明' })
    expect(missingList._error).toContain('disputes 不是数组')

    const noSpec = await run({ disputes: [] }, { claims_draft: CLAIMS })
    expect(noSpec._error).toContain('state.specification 缺失')

    const noClaims = await run({ disputes: [] }, { specification: SPECIFICATION })
    expect(noClaims._error).toContain('state.claims_draft 缺失')

    const noProvider = await new DraftReviewHandler().execute({ state: stateWith() })
    expect(noProvider._error).toContain('未配置 LLM')
  })

  it('可调参数非法时降级，配置了上限时按配置截断', async () => {
    const badTemperature = await run({ disputes: [] }, stateWith({ temperature: 5 }))
    expect(badTemperature._error).toContain('params.temperature')

    const configured = await run({ disputes: [] }, stateWith({ prompt_char_limit: 4000 }))
    expect(configured._error).toBeUndefined()
    expect(configured.draft_review_passed).toBe(true)
  })

  it('LLM 调用抛错时降级并保留原因', async () => {
    const provider: StageProvider = {
      callLLM: async () => {
        throw new Error('上游 502')
      },
    }
    const out = await new DraftReviewHandler().execute({ state: stateWith(), provider })
    expect(out._error).toContain('LLM 调用失败: 上游 502')
  })
})
