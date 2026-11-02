import { describe, expect, it } from 'vitest'
import {
  DraftClaimsHandler,
  type PipelineState,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'

/** 一份可渲染的策略表 JSON。 */
function strategy(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    invention_name: '灌溉装置',
    tech_domain: 'mechanical',
    essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块', anchor_reason: 'exact' }],
    optional_features: [
      { id: 'F2', text: '图像采集模块', anchor: '图像采集模块', anchor_reason: 'exact' },
      { id: 'F3', text: '无线通信模块', anchor: '无线通信模块', anchor_reason: 'exact' },
    ],
    dependent_tree: [
      { number: 2, parent: 1, feature_id: 'F2' },
      { number: 3, parent: [1, 2], feature_id: 'F3' },
    ],
    prior_art_ref: null,
    prior_art_text: '',
    ...overrides,
  })
}

/**
 * 执行 draft-claims。
 * @param raw - 策略表 JSON。
 * @param rawModel - 从权专员输出；省略时不提供 provider。
 * @param extra - 附加状态。
 * @returns 阶段输出。
 */
async function run(
  raw: string,
  rawModel?: string,
  extra: Record<string, unknown> = {},
): Promise<PipelineState> {
  const provider: StageProvider | undefined = rawModel === undefined ? undefined : { callLLM: async () => rawModel }
  return await new DraftClaimsHandler().execute({
    state: { claim_strategy: raw, ...extra },
    ...(provider !== undefined ? { provider } : {}),
  })
}

/**
 * 断言阶段因给定原因降级且不写 claims_draft。
 * @param raw - 策略表 JSON。
 * @param reason - 期望的原因片段。
 */
async function expectDegraded(raw: string, reason: RegExp): Promise<void> {
  const out = await run(raw)
  expect(String(out._error)).toMatch(reason)
  expect(out.claims_draft).toBeUndefined()
}

describe('DraftClaimsHandler', () => {
  it('按策略表渲染多路从权并写入复核上下文', async () => {
    const out = await run(strategy())
    const text = String(out.claims_draft)
    expect(text).toMatch(/^1\. 一种灌溉装置，其特征在于，包括：控制模块。/)
    expect(text).toContain('2. 根据权利要求1所述的灌溉装置，其特征在于，还包括：图像采集模块。')
    expect(text).toContain('3. 根据权利要求1或2所述的灌溉装置，其特征在于，还包括：无线通信模块。')
    expect(String(out.review_context)).toContain('披露分析报告、权利要求与说明书草案需人工复核')
    expect(String(out.review_context)).toContain('【权利要求策略表】')
    expect(String(out.review_context)).toContain('【权利要求草稿】')
    expect(String(out.draft_claims_result)).toContain('"specialist":"skipped"')
    expect(String(out.draft_claims_result)).toContain('"specialist_reason":"未配置 LLM，保留确定性从权"')
  })

  it('最接近现有技术编号写进独立权利要求前序部分', async () => {
    const out = await run(strategy({ prior_art_ref: 'D1', prior_art_text: 'D1 一种灌溉装置' }))
    expect(String(out.claims_draft)).toContain('一种灌溉装置，包括：D1 一种灌溉装置；其特征在于，还包括：控制模块。')
  })

  it('项数上限与形式违规否决本轮草稿', async () => {
    const out = await new DraftClaimsHandler().execute({
      state: { claim_strategy: strategy(), max_claims: 1 },
    })
    expect(String(out._error)).toMatch(/claim_count_cap/)
  })

  it('策略表缺失或不可解析即降级', async () => {
    const missing = await new DraftClaimsHandler().execute({ state: {} })
    expect(String(missing._error)).toMatch(/claim_strategy 缺失/)
    await expectDegraded('not json', /state.claim_strategy 不是 JSON 对象/)
    await expectDegraded(JSON.stringify({ essential_features: [] }), /缺少 invention_name/)
    await expectDegraded(JSON.stringify({ invention_name: '装置', essential_features: [] }), /essential_features 为空/)
    await expectDegraded(JSON.stringify({ invention_name: '装置', essential_features: [null] }), /含非对象项/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: '', text: '控制模块' }],
    }), /essential_features 的 id\/text 非法/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: 'x',
    }), /optional_features 不是数组/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [null],
    }), /optional_features 含非对象项/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [{ id: 'F2', text: '' }],
    }), /optional_features 的 id\/text 非法/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [],
      dependent_tree: 'x',
    }), /dependent_tree 不是数组/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [],
      dependent_tree: [null],
    }), /dependent_tree 含非对象项/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [],
      dependent_tree: [{ number: 2, parent: [], feature_id: 'F2' }],
    }), /number\/parent\/feature_id 非法/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [],
      dependent_tree: [{ number: 2, parent: [1, 'x'], feature_id: 'F2' }],
    }), /number\/parent\/feature_id 非法/)
    await expectDegraded(JSON.stringify({
      invention_name: '装置',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [{ id: 'F2', text: '图像采集模块' }],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F9' }],
    }), /feature_id F9 不在策略表中/)
  })

  it('非法技术领域退回 general，忽略非字符串的现有技术描述', async () => {
    const out = await run(JSON.stringify({
      invention_name: '装置',
      tech_domain: 'unknown',
      essential_features: [{ id: 'F1', text: '控制模块' }],
      optional_features: [],
      dependent_tree: [],
      prior_art_text: 42,
    }))
    const parsed = JSON.parse(String(out.draft_claims_result)) as Record<string, unknown>
    expect(parsed.strategy).toMatchObject({ essential: ['F1'], optional: [], dependent_tree: [] })
    expect(String(out.claims_draft)).toMatch(/^1\. 一种装置/)
  })

  it('从权专员重排/补充从权时独权文本保持确定性渲染', async () => {
    let prompt = ''
    const provider: StageProvider = {
      callLLM: async (text) => {
        prompt = text
        return JSON.stringify({
          dependents: [
            { number: 3, parent: [1, 2], feature_id: 'F3', text: '按灌溉区域分别控制' },
            { number: 2, parent: 1, feature_id: 'F2', text: '周期性拍摄' },
          ],
          notes: '重排从权',
        })
      },
    }
    const out = await new DraftClaimsHandler().execute({
      state: { claim_strategy: strategy(), slop_revision_hint: '删除填充词「进一步地」' },
      provider,
    })
    const text = String(out.claims_draft)
    expect(text).toMatch(/^1\. 一种灌溉装置，其特征在于，包括：控制模块。/)
    expect(text).toContain('2. 根据权利要求1所述的灌溉装置，其特征在于，还包括：周期性拍摄。')
    expect(text).toContain('3. 根据权利要求1或2所述的灌溉装置，其特征在于，还包括：按灌溉区域分别控制。')
    expect(String(out.draft_claims_result)).toContain('"specialist":"applied"')
    expect(prompt).toContain('【反套话修订提示】')
    expect(prompt).toContain('进一步地')
  })

  it('可选特征用途与项数上限进入渲染路径', async () => {
    const withKind = await run(strategy({
      optional_features: [
        { id: 'F2', text: '图像采集模块', kind: 'preferred' },
        { id: 'F3', text: '无线通信模块' },
      ],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    }), JSON.stringify({
      dependents: [{ number: 2, parent: 1, feature_id: 'F2', text: '周期性拍摄' }],
    }))
    expect(String(withKind.claims_draft)).toContain('周期性拍摄。')

    const withoutFeatureId = await run(strategy({
      optional_features: [{ id: 'F2', text: '图像采集模块' }],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    }), JSON.stringify({
      dependents: [{ number: 2, parent: 1, text: '周期性拍摄。' }],
    }))
    expect(String(withoutFeatureId.claims_draft)).toContain('周期性拍摄。')

    const withinCap = await run(strategy(), undefined, { max_claims: 3 })
    expect(withinCap._error).toBeUndefined()
  })

  it('调参非法即降级', async () => {
    const out = await run(strategy(), undefined, { temperature: 9 })
    expect(String(out._error)).toMatch(/temperature/)
  })

  it('没有从权时跳过从权专员', async () => {
    const out = await run(strategy({
      optional_features: [],
      dependent_tree: [],
    }), '{"dependents":[]}')
    expect(String(out.draft_claims_result)).toContain('"specialist":"skipped"')
    expect(String(out.draft_claims_result)).toContain('没有从属权利要求')
  })

  it('从权专员调用失败或输出非法时保留确定性从权', async () => {
    const failing = await new DraftClaimsHandler().execute({
      state: { claim_strategy: strategy() },
      provider: { callLLM: async () => { throw new Error('upstream') } },
    })
    expect(String(failing.draft_claims_result)).toContain('从权专员调用失败')

    const cases: Array<[string, RegExp]> = [
      ['not json', /不是 JSON 对象/],
      ['{"dependents":"x"}', /缺少 dependents 数组/],
      ['{"dependents":[null]}', /第 1 项不是对象/],
      ['{"dependents":[{"number":"2","parent":1,"text":"x"}]}', /number 不是整数/],
      ['{"dependents":[{"number":2,"parent":[],"text":"x"}]}', /parent 非法/],
      ['{"dependents":[{"number":2,"parent":1,"text":"  "}]}', /缺少 text/],
      ['{"dependents":[{"number":2,"parent":1,"text":"x","feature_id":"F9"}]}', /feature_id 不在可选特征表中/],
      ['{"dependents":[]}', /没有返回任何从权/],
      ['{"dependents":[{"number":3,"parent":1,"text":"x"}]}', /必须从 2 起连续/],
      ['{"dependents":[{"number":2,"parent":5,"text":"x"}]}', /引用了非在先权 5/],
      ['{"dependents":[{"number":2,"parent":3,"text":"x"}]}', /引用了非在先权 3/],
    ]
    for (const [raw, reason] of cases) {
      const out = await run(strategy(), raw)
      const result = String(out.draft_claims_result)
      expect(result).toContain('"specialist":"skipped"')
      expect(result).toMatch(reason)
      expect(String(out.claims_draft)).toContain('2. 根据权利要求1所述的灌溉装置')
    }
  })

  it('claim_lint 否决时降级且不覆盖已有草稿', async () => {
    const out = await run(strategy({
      optional_features: [{ id: 'F2', text: '所述壳体', anchor: '控制模块' }],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    }), undefined, { claims_draft: '1. 一种灌溉装置，其特征在于，包括：控制模块。' })
    expect(String(out._error)).toMatch(/claim_lint 否决/)
    expect(out.claims_draft).toBeUndefined()
  })
})
