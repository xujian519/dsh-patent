import { describe, expect, it } from 'vitest'
import {
  ClaimStrategyHandler,
  type PipelineState,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'

const SOURCE = '一种灌溉装置，包括控制模块、图像采集模块和无线通信模块。'
const NOVELTY = 'D1 公开了一种灌溉装置，区别特征为图像采集模块。'
const PRIOR_ART = [{ title: 'CN123456A 一种灌溉装置', snippet: '土壤湿度传感器' }]

/** 一份可复核的模型输出；`overrides` 覆写顶层字段。 */
function modelStrategy(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块', source_feature_id: 'f1' }],
    optional_features: [{ id: 'F2', text: '图像采集模块', anchor: '图像采集模块', kind: 'preferred' }],
    dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    prior_art_ref: null,
    ...overrides,
  })
}

/**
 * 执行 claim-strategy。
 * @param state - 附加状态。
 * @param raw - 模型输出；省略时不提供 provider（confirmed 路径）。
 * @returns 阶段输出。
 */
async function run(state: Record<string, unknown>, raw?: string): Promise<PipelineState> {
  const provider: StageProvider | undefined = raw === undefined ? undefined : { callLLM: async () => raw }
  return await new ClaimStrategyHandler().execute({
    state: { source_text: SOURCE, novelty_conclusion: NOVELTY, prior_art: PRIOR_ART, ...state },
    ...(provider !== undefined ? { provider } : {}),
  })
}

/**
 * 断言阶段因给定原因降级。
 * @param state - 附加状态。
 * @param raw - 模型输出。
 * @param reason - 期望的原因片段。
 */
async function expectDegraded(state: Record<string, unknown>, raw: string, reason: RegExp): Promise<void> {
  const out = await run(state, raw)
  expect(String(out._error)).toMatch(reason)
  expect(out.claim_strategy).toBeUndefined()
}

describe('ClaimStrategyHandler', () => {
  it('把模型决策固化为带锚点与从权树的策略表', async () => {
    const out = await run({ title: '灌溉装置', tech_domain: 'mechanical' }, modelStrategy({ prior_art_ref: 'D1' }))
    const strategy = JSON.parse(String(out.claim_strategy)) as Record<string, unknown>
    expect(strategy).toMatchObject({
      invention_name: '灌溉装置',
      tech_domain: 'mechanical',
      prior_art_ref: 'D1',
    })
    expect((strategy.essential_features as unknown[]).length).toBe(1)
    expect((strategy.optional_features as unknown[]).length).toBe(1)
    expect(strategy.dependent_tree).toEqual([{ number: 2, parent: 1, feature_id: 'F2' }])
    expect(String(out.claim_strategy_report)).toContain('权利要求2 → 引用1（F2）')
    expect(String(out.claim_strategy_report)).toContain('最接近现有技术：D1')
  })

  it('没有从权树时按可选特征顺序生成线性链', async () => {
    const out = await run({
      source_text: '一种装置，包括控制模块和图像采集模块。',
    }, JSON.stringify({
      essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块' }],
      optional_features: [
        { id: 'F2', text: '图像采集模块', anchor: '图像采集模块' },
        { id: 'F3', text: '无线通信模块', anchor: '一种装置' },
      ],
      prior_art_ref: null,
    }))
    const strategy = JSON.parse(String(out.claim_strategy)) as { dependent_tree: unknown[] }
    expect(strategy.dependent_tree).toEqual([
      { number: 2, parent: 1, feature_id: 'F2' },
      { number: 3, parent: 2, feature_id: 'F3' },
    ])
  })

  it('父项数组表示择一引用', async () => {
    const out = await run({}, modelStrategy({
      dependent_tree: [{ number: 2, parent: [1], feature_id: 'F2' }],
    }))
    const strategy = JSON.parse(String(out.claim_strategy)) as { dependent_tree: unknown[] }
    expect(strategy.dependent_tree).toEqual([{ number: 2, parent: [1], feature_id: 'F2' }])
    expect(String(out.claim_strategy_report)).toContain('权利要求2 → 引用1（F2）')
  })

  it('调用方 confirmed_features 存在时按同一校验读取且不调用模型', async () => {
    const confirmed = {
      essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块' }],
      optional_features: [{ id: 'F2', text: '图像采集模块', anchor: '图像采集模块' }],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
    }
    const out = await run({ confirmed_features: confirmed })
    expect(String(out.claim_strategy)).toContain('"F1"')
    expect(out._error).toBeUndefined()
  })

  it('confirmed_features 也接受 JSON 字符串', async () => {
    const out = await run({
      title: '灌溉装置',
      confirmed_features: JSON.stringify({
        essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块' }],
      }),
    })
    const strategy = JSON.parse(String(out.claim_strategy)) as Record<string, unknown>
    expect(strategy.invention_name).toBe('灌溉装置')
    expect(strategy.dependent_tree).toEqual([])
  })

  it('confirmed_features 类型或 JSON 非法即降级', async () => {
    const wrongType = await run({ confirmed_features: 42 })
    expect(String(wrongType._error)).toMatch(/既不是对象也不是 JSON 字符串/)
    const badJson = await run({ confirmed_features: '{oops' })
    expect(String(badJson._error)).toMatch(/不是 JSON 对象/)
  })

  it('标题与领域：显式标题优先，过长首行退回技术方案，领域从状态读取', async () => {
    const titled = await run({
      title: '灌溉装置',
      tech_domain: 'software',
      confirmed_features: {
        essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块' }],
      },
    })
    const titledStrategy = JSON.parse(String(titled.claim_strategy)) as Record<string, unknown>
    expect(titledStrategy.invention_name).toBe('灌溉装置')
    expect(titledStrategy.tech_domain).toBe('software')

    const long = await run({
      source_text: '这是一个非常长的技术交底书首行标题用于测试退回兜底名称'.repeat(2),
      confirmed_features: {
        essential_features: [{
          id: 'F1',
          text: '控制模块',
          anchor: '这是一个非常长的技术交底书首行标题用于测试退回兜底名称',
        }],
      },
    })
    const longStrategy = JSON.parse(String(long.claim_strategy)) as Record<string, unknown>
    expect(longStrategy.invention_name).toBe('技术方案')
  })

  it('多行交底书取首行作为发明名称', async () => {
    const out = await run({
      source_text: '灌溉控制方法\n控制模块根据土壤湿度生成灌溉策略。',
      confirmed_features: {
        essential_features: [{ id: 'F1', text: '控制模块', anchor: '控制模块' }],
      },
    })
    const strategy = JSON.parse(String(out.claim_strategy)) as Record<string, unknown>
    expect(strategy.invention_name).toBe('灌溉控制方法')
  })

  it('缺少交底书原文即降级', async () => {
    const out = await new ClaimStrategyHandler().execute({ state: { source_text: '   ' } })
    expect(String(out._error)).toMatch(/state.source_text 缺失/)
  })

  it('调参非法、无 LLM、模型失败或非 JSON 均降级', async () => {
    const tuned = await run({ temperature: 9 }, modelStrategy())
    expect(String(tuned._error)).toMatch(/temperature/)
    const noLlm = await new ClaimStrategyHandler().execute({ state: { source_text: SOURCE }, provider: {} })
    expect(String(noLlm._error)).toMatch(/未配置 LLM/)
    const failing = await new ClaimStrategyHandler().execute({
      state: { source_text: SOURCE },
      provider: { callLLM: async () => { throw new Error('upstream') } },
    })
    expect(String(failing._error)).toMatch(/LLM 调用失败/)
    await expectDegraded({}, 'not json', /模型输出不是 JSON 对象/)
  })

  it('必要特征为空、数组/字段类型非法均降级', async () => {
    await expectDegraded({}, modelStrategy({ essential_features: [] }), /essential_features 为空/)
    await expectDegraded({}, modelStrategy({ essential_features: 'x' }), /essential_features 不是数组/)
    await expectDegraded({}, modelStrategy({ essential_features: [null] }), /第 1 项不是对象/)
    await expectDegraded({}, modelStrategy({ essential_features: [{ text: '控制模块', anchor: '控制模块' }] }), /缺少非空 id/)
    await expectDegraded({}, modelStrategy({ essential_features: [{ id: 'F1', anchor: '控制模块' }] }), /缺少非空 text/)
    await expectDegraded({}, modelStrategy({ essential_features: [{ id: 'F1', text: '控制模块' }] }), /缺少非空 anchor/)
    await expectDegraded({}, modelStrategy({ optional_features: 'x' }), /optional_features 不是数组/)
    await expectDegraded({}, modelStrategy({ optional_features: [null] }), /optional_features 第 1 项不是对象/)
    await expectDegraded({}, modelStrategy({
      optional_features: [{ id: 'F2', text: '图像采集模块', anchor: '图像采集模块', kind: 'other' }],
    }), /kind 不是 fallback\/preferred\/range/)
  })

  it('特征编号重复即降级', async () => {
    await expectDegraded({}, modelStrategy({
      essential_features: [
        { id: 'F1', text: '控制模块', anchor: '控制模块' },
        { id: 'F1', text: '图像采集模块', anchor: '图像采集模块' },
      ],
    }), /特征编号重复：F1/)
    await expectDegraded({}, modelStrategy({
      optional_features: [{ id: 'F1', text: '图像采集模块', anchor: '图像采集模块' }],
    }), /特征编号重复：F1/)
  })

  it('锚点为空或未命中原文即降级', async () => {
    await expectDegraded({}, modelStrategy({
      essential_features: [{ id: 'F1', text: '控制模块', anchor: '未公开的特征' }],
    }), /必要特征 F1 摘录未在交底书原文中命中/)
    await expectDegraded({}, modelStrategy({
      optional_features: [{ id: 'F2', text: '图像采集模块', anchor: '未公开的特征' }],
    }), /可选特征 F2 摘录未在交底书原文中命中/)
  })

  it('PFIE 四元组与特征数组分别作为模型参考输入', async () => {
    const withTriples = await run({ pfe_triples: [{ id: 'T1' }] }, modelStrategy())
    expect(String(withTriples.claim_strategy)).toContain('"F1"')
    const withFeatures = await run({ features: ['控制模块'] }, modelStrategy())
    expect(String(withFeatures.claim_strategy)).toContain('"F1"')
    const optionalSourceId = await run({}, modelStrategy({
      optional_features: [{ id: 'F2', text: '图像采集模块', anchor: '图像采集模块', source_feature_id: 'f2' }],
    }))
    expect(String(optionalSourceId.claim_strategy)).toContain('"source_feature_id":"f2"')
  })

  it('从权树结构非法即降级', async () => {
    const tree = (value: unknown): string => modelStrategy({ dependent_tree: value })
    await expectDegraded({}, tree('x'), /dependent_tree 不是数组/)
    await expectDegraded({}, tree([null]), /第 1 项不是对象/)
    await expectDegraded({}, tree([{ number: '2', parent: 1, feature_id: 'F2' }]), /number 不是整数/)
    await expectDegraded({}, tree([{ number: 2, parent: [], feature_id: 'F2' }]), /parent 非法/)
    await expectDegraded({}, tree([{ number: 2, parent: [1, 'x'], feature_id: 'F2' }]), /parent 非法/)
    await expectDegraded({}, tree([{ number: 2, parent: 1 }]), /缺少 feature_id/)
    await expectDegraded({}, tree([{ number: 1, parent: 1, feature_id: 'F2' }]), /从权编号 1 小于 2/)
    await expectDegraded({}, tree([
      { number: 2, parent: 1, feature_id: 'F2' },
      { number: 2, parent: 1, feature_id: 'F2' },
    ]), /从权编号重复：2/)
    await expectDegraded({}, tree([{ number: 2, parent: 1, feature_id: 'F9' }]), /feature_id F9 不在 optional_features/)
    await expectDegraded({}, tree([{ number: 2, parent: 2, feature_id: 'F2' }]), /引用了自身/)
    await expectDegraded({}, tree([{ number: 2, parent: 3, feature_id: 'F2' }]), /引用了在后的权 3/)
    await expectDegraded({}, tree([
      { number: 4, parent: 3, feature_id: 'F2' },
      { number: 2, parent: 1, feature_id: 'F2' },
    ]), /引用了不存在的权 3/)
  })

  it('prior_art_ref 只接受结论或已过滤文献中出现的编号', async () => {
    const strategy = (ref: unknown): string => modelStrategy({ prior_art_ref: ref })
    await expectDegraded({}, strategy(1), /既不是字符串也不是 null/)
    await expectDegraded({}, strategy('D9'), /不得编造文献编号/)
    await expectDegraded({ novelty_conclusion: 'D10 公开了' }, strategy('D1'), /不得编造文献编号/)

    const fromNovelty = await run({}, strategy('D1'))
    expect(String(fromNovelty.claim_strategy)).toContain('"prior_art_ref":"D1"')

    const fromPriorArt = await run({ novelty_conclusion: '' }, strategy('CN123456A'))
    const parsed = JSON.parse(String(fromPriorArt.claim_strategy)) as Record<string, unknown>
    expect(parsed.prior_art_text).toBe('CN123456A 一种灌溉装置')

    const withNonObjectEntry = await run({
      prior_art: [null, { title: 'CN123456A 一种灌溉装置' }],
    }, strategy('CN123456A'))
    const nonObjectParsed = JSON.parse(String(withNonObjectEntry.claim_strategy)) as Record<string, unknown>
    expect(nonObjectParsed.prior_art_text).toBe('CN123456A 一种灌溉装置')
  })

  it('null 现有技术编号写成 null 且不渲染现有技术描述', async () => {
    const out = await run({}, modelStrategy({ prior_art_ref: null }))
    const parsed = JSON.parse(String(out.claim_strategy)) as Record<string, unknown>
    expect(parsed.prior_art_ref).toBeNull()
    expect(parsed.prior_art_text).toBe('')
    expect(String(out.claim_strategy_report)).toContain('未点名')
  })
})
