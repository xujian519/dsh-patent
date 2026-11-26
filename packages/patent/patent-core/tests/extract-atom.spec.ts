import { describe, expect, it } from 'vitest'
import { ExtractHandler, type StageProvider } from '@deepseek-ai/dsh-patent-core'

/** 构造只返回指定 JSON 文本的 provider，并捕获本次请求的 schema。 */
function providerFor(
  raw: string,
  captured: { schema?: unknown; prompt?: string } = {},
): StageProvider {
  return {
    callLLM: async (prompt, opts) => {
      captured.prompt = prompt
      captured.schema = opts?.jsonSchema
      return raw
    },
  }
}

describe('extract 分键输出', () => {
  it('output_key=problems：只要求 problems，写入 state.problems', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'problems' },
      provider: providerFor(JSON.stringify({ problems: ['问题1'] }), captured),
    })

    expect(out.problems).toEqual(['问题1'])
    expect(out.features).toBeUndefined()
    expect(out._error).toBeUndefined()
    expect(captured.schema).toMatchObject({ required: ['problems'] })
    expect(captured.prompt).toContain('"problems"')
  })

  it('output_key=effects：只要求 effects，写入 state.effects', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'effects' },
      provider: providerFor(JSON.stringify({ effects: ['效果1'] })),
    })

    expect(out.effects).toEqual(['效果1'])
    expect(out.features).toBeUndefined()
    expect(out._error).toBeUndefined()
  })

  it('output_key=insight：只要求 insight，写入 state.insight，且不再声称按 problems 顺序对齐', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'insight' },
      provider: providerFor(JSON.stringify({ insight: ['认知1'] }), captured),
    })

    expect(out.insight).toEqual(['认知1'])
    expect(out.features).toBeUndefined()
    expect(out._error).toBeUndefined()
    // 独立模式看不到 problems：提示词与 schema 都不许再承诺跨数组顺序对齐。
    expect(JSON.stringify(captured.schema)).not.toContain('problems 的顺序')
    expect(captured.prompt).not.toContain('problems 的顺序')
  })

  it('output_key=features：接受 features-only 输出', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features' },
      provider: providerFor(JSON.stringify({ features: ['特征A'] })),
    })

    expect(out.features).toEqual(['特征A'])
    expect(out._error).toBeUndefined()
  })

  it('无 output_key：保持全量模式，schema 仍要求 features', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置' },
      provider: providerFor(
        JSON.stringify({ features: ['特征A'], problems: ['问题1'], effects: [] }),
        captured,
      ),
    })

    expect(out.features).toEqual(['特征A'])
    expect(out.problems).toEqual(['问题1'])
    expect(out.effects).toEqual([])
    expect(captured.schema).toMatchObject({ required: ['features'] })
  })

  it('目标键缺失：返回可操作降级，不静默回退原文', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'problems' },
      provider: providerFor(JSON.stringify({ features: ['特征A'] })),
    })

    expect(String(out._error)).toContain('problems 不是数组')
    expect(out.problems).toBeUndefined()
  })

  it('目标数组含非字符串项：指出下标并降级', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'problems' },
      provider: providerFor(JSON.stringify({ problems: ['问题1', { bad: true }] })),
    })

    expect(String(out._error)).toContain('problems 数组含非字符串项（下标 1）')
    expect(out.problems).toBeUndefined()
  })

  it('模型输出非 JSON：目标键模式下降级并说明缺少目标数组', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'problems' },
      provider: providerFor('这不是 JSON'),
    })

    expect(String(out._error)).toContain('缺少 problems 数组')
    expect(out.problems).toBeUndefined()
  })

  it('空数组是合法结果', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'problems' },
      provider: providerFor(JSON.stringify({ problems: [] })),
    })

    expect(out.problems).toEqual([])
    expect(out._error).toBeUndefined()
  })
})

describe('extract 问题—发明认知配对模式', () => {
  it('output_mode=problem_insight：写入配对数组与 problems 投影，不写 insight 投影', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({
        problem_insight: [
          { id: 'P1', problem: '问题1', insight: '认知1' },
          { id: 'P2', problem: '问题2' },
        ],
      }), captured),
    })

    expect(out.problem_insight).toEqual([
      { id: 'P1', problem: '问题1', insight: '认知1' },
      { id: 'P2', problem: '问题2' },
    ])
    expect(out.problems).toEqual(['问题1', '问题2'])
    expect(out.insight).toBeUndefined()
    expect(out._error).toBeUndefined()
    expect(captured.schema).toMatchObject({ required: ['problem_insight'] })
    expect(captured.prompt).toContain('"problem_insight"')
    expect(captured.prompt).toContain('id 在同一输出内唯一')
    expect(captured.prompt).toContain('不得编造原文没有的技术手段')
  })

  it.each([
    { label: '非数组', value: 'x', reason: 'problem_insight 不是数组' },
    { label: '非对象项', value: ['x'], reason: 'problem_insight 数组含非对象项（下标 0）' },
    { label: '缺 id', value: [{ problem: 'p' }], reason: 'problem_insight 第 1 项缺少非空 id' },
    {
      label: '重复 id',
      value: [{ id: 'P1', problem: 'p' }, { id: ' P1 ', problem: 'q' }],
      reason: 'problem_insight 的 id 重复：P1',
    },
    { label: '缺 problem', value: [{ id: 'P1' }], reason: 'problem_insight 第 1 项（id P1）缺少非空 problem' },
    {
      label: 'insight 非字符串',
      value: [{ id: 'P1', problem: 'p', insight: 1 }],
      reason: 'problem_insight 第 1 项（id P1）的 insight 不是字符串',
    },
    {
      label: 'parent 非字符串',
      value: [{ id: 'P1', problem: 'p', parent: 2 }],
      reason: 'problem_insight 第 1 项（id P1）的 parent 不是字符串或 null',
    },
    {
      label: 'parent 悬空',
      value: [{ id: 'P1', problem: 'p', parent: 'P7' }],
      reason: 'problem_insight 的 id P1 引用了不存在的上位问题 P7',
    },
    {
      label: 'parent 自指',
      value: [{ id: 'P1', problem: 'p', parent: 'P1' }],
      reason: 'problem_insight 的 id P1 把自己列为上位问题',
    },
    {
      label: 'parent 成环',
      value: [{ id: 'P1', problem: 'p', parent: 'P2' }, { id: 'P2', problem: 'q', parent: 'P1' }],
      reason: 'problem_insight 的父子引用成环：P1 → P2 → P1',
    },
  ])('非法配对输出（$label）：整阶段降级，不保留部分配对', async ({ value, reason }) => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({ problem_insight: value })),
    })

    expect(String(out._error)).toContain(reason)
    expect(out.problem_insight).toBeUndefined()
    expect(out.problems).toBeUndefined()
  })

  it('空白 insight 视为未提炼；配对数组为空是合法结果', async () => {
    const blank = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({ problem_insight: [{ id: 'P1', problem: '问题1', insight: '  ' }] })),
    })
    expect(blank.problem_insight).toEqual([{ id: 'P1', problem: '问题1' }])

    const empty = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({ problem_insight: [] })),
    })
    expect(empty.problem_insight).toEqual([])
    expect(empty.problems).toEqual([])
    expect(empty._error).toBeUndefined()
  })

  it('parent 进入 schema 与提示词；null 或空白按顶层构思剔除', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({
        problem_insight: [
          { id: 'P1', problem: '问题1', insight: '认知1', parent: null },
          { id: 'P2', problem: '问题2', parent: '  ' },
          { id: 'P3', problem: '问题3', parent: 'P1' },
        ],
      }), captured),
    })
    expect(out.problem_insight).toEqual([
      { id: 'P1', problem: '问题1', insight: '认知1' },
      { id: 'P2', problem: '问题2' },
      { id: 'P3', problem: '问题3', parent: 'P1' },
    ])
    expect(String(captured.prompt)).toContain('把上位问题的 id 写进下位条目的 parent')
    expect(String(captured.prompt)).toContain('不得自指或成环')
    expect(JSON.stringify(captured.schema)).toContain('"parent"')
  })

  it('缺少 problem_insight 或输出非 JSON：降级并点名该键', async () => {
    const missing = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor(JSON.stringify({ problems: ['问题1'] })),
    })
    expect(String(missing._error)).toContain('problem_insight 不是数组')

    const notJson = await new ExtractHandler().execute({
      state: { text: '一种装置', output_mode: 'problem_insight' },
      provider: providerFor('这不是 JSON'),
    })
    expect(String(notJson._error)).toContain('缺少 problem_insight 数组')
  })

  it('与规则缺口反哺组合：schema 同时要求配对数组与 revision_coverage', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: {
        text: '一种装置',
        output_mode: 'problem_insight',
        revision_targets: [{ checkId: 'time-baseline', provision: '专利法第22条第5款', label: '时间基准' }],
      },
      provider: providerFor(JSON.stringify({
        problem_insight: [{ id: 'P1', problem: '问题1', insight: '认知1' }],
        revision_coverage: { 'time-baseline': ['申请日 2024-01-01'] },
      }), captured),
    })

    expect(out.problem_insight).toEqual([{ id: 'P1', problem: '问题1', insight: '认知1' }])
    expect(out.revision_coverage).toEqual({ 'time-baseline': ['申请日 2024-01-01'] })
    expect(captured.schema).toMatchObject({ required: ['problem_insight', 'revision_coverage'] })
    expect(captured.prompt).toContain('[time-baseline] 专利法第22条第5款 — 时间基准')
  })

  it('output_mode 与 output_key 互斥；未知或非字符串 mode 直接降级', async () => {
    const provider = providerFor(JSON.stringify({ problem_insight: [] }))
    const both = await new ExtractHandler().execute({
      state: { text: 'x', output_mode: 'problem_insight', output_key: 'problems' },
      provider,
    })
    expect(String(both._error)).toContain('output_mode 与 output_key 不能同时使用')

    const unknown = await new ExtractHandler().execute({
      state: { text: 'x', output_mode: 'pairs' },
      provider,
    })
    expect(String(unknown._error)).toContain('未知的 output_mode：pairs')

    const notString = await new ExtractHandler().execute({
      state: { text: 'x', output_mode: 1 },
      provider,
    })
    expect(String(notString._error)).toContain('output_mode 不是字符串')
  })
})

describe('extract 规则缺口反哺', () => {
  const targets = [
    { checkId: 'time-baseline', provision: '专利法第22条第5款', label: '现有技术时间基准' },
    { checkId: 'grace-period', provision: '专利法第24条', label: '宽限期公开' },
  ]

  it('把反哺目标写进提示词，并要求逐项 revision_coverage', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features', revision_targets: targets },
      provider: providerFor(JSON.stringify({
        features: ['特征A'],
        revision_coverage: { 'time-baseline': ['申请日 2024-01-01'], 'grace-period': [] },
      }), captured),
    })

    expect(out.features).toEqual(['特征A'])
    expect(out.revision_coverage).toEqual({
      'time-baseline': ['申请日 2024-01-01'],
      'grace-period': [],
    })
    expect(captured.schema).toMatchObject({ required: ['features', 'revision_coverage'] })
    expect(captured.prompt).toContain('[time-baseline] 专利法第22条第5款 — 现有技术时间基准')
    expect(captured.prompt).toContain('规则缺口反哺')
  })

  it('缺少 revision_coverage 时保留已抽取特征，不把整轮判成降级', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features', revision_targets: targets },
      provider: providerFor(JSON.stringify({ features: ['特征A'] })),
    })

    expect(out._error).toBeUndefined()
    expect(out.features).toEqual(['特征A'])
    expect(out.revision_coverage).toEqual({})
  })

  it('覆盖项含非字符串时只丢弃该条，保留已抽取特征', async () => {
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features', revision_targets: targets },
      provider: providerFor(JSON.stringify({
        features: ['特征A'],
        revision_coverage: { 'time-baseline': ['申请日'], 'grace-period': [1] },
      })),
    })

    expect(out._error).toBeUndefined()
    expect(out.features).toEqual(['特征A'])
    expect(out.revision_coverage).toEqual({ 'time-baseline': ['申请日'], 'grace-period': [] })
  })

  it('多路提取的覆盖事实按 checkId 取并集，后一路不覆盖前一路', async () => {
    const out = await new ExtractHandler().execute({
      state: {
        text: '一种装置',
        output_key: 'effects',
        revision_targets: targets,
        revision_coverage: { 'time-baseline': ['申请日 2024-01-01'] },
      },
      provider: providerFor(JSON.stringify({
        effects: ['效果A'],
        revision_coverage: { 'time-baseline': ['同一申请日的另一处记载'], 'grace-period': ['首次公开日'] },
      })),
    })

    expect(out.revision_coverage).toEqual({
      'time-baseline': ['申请日 2024-01-01', '同一申请日的另一处记载'],
      'grace-period': ['首次公开日'],
    })
  })

  it('非法目标被丢弃；全部非法时按普通抽取执行', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features', revision_targets: [{ checkId: '' }, null, 'x'] },
      provider: providerFor(JSON.stringify({ features: ['特征A'] }), captured),
    })

    expect(out.features).toEqual(['特征A'])
    expect(out.revision_coverage).toBeUndefined()
    expect(captured.schema).toMatchObject({ required: ['features'] })
  })

  it('混合非法目标时只保留合法条目', async () => {
    const out = await new ExtractHandler().execute({
      state: {
        text: '一种装置',
        output_key: 'features',
        revision_targets: [
          { checkId: 1, provision: 'p', label: 'l' },
          { checkId: 'x', provision: '', label: 'l' },
          { checkId: 'y', provision: 'p', label: '' },
          targets[0],
        ],
      },
      provider: providerFor(JSON.stringify({
        features: ['特征A'],
        revision_coverage: { 'time-baseline': ['申请日'] },
      })),
    })

    expect(out.features).toEqual(['特征A'])
    expect(out.revision_coverage).toEqual({ 'time-baseline': ['申请日'] })
  })

  it('反哺目标超过上限时截断到 8 个', async () => {
    const captured: { schema?: unknown; prompt?: string } = {}
    const many = Array.from({ length: 9 }, (_, index) => ({
      checkId: `check-${index}`,
      provision: 'p',
      label: 'l',
    }))
    const out = await new ExtractHandler().execute({
      state: { text: '一种装置', output_key: 'features', revision_targets: many },
      provider: providerFor(JSON.stringify({ features: ['特征A'] }), captured),
    })
    expect(out.features).toEqual(['特征A'])
    expect(captured.prompt?.match(/\[check-\d\]/g)).toHaveLength(8)
  })

  it('覆盖条目非数组时跳过该条，既有覆盖值非数组时也忽略', async () => {
    const out = await new ExtractHandler().execute({
      state: {
        text: '一种装置',
        output_key: 'features',
        revision_targets: targets,
        revision_coverage: { 'time-baseline': 'stale' },
      },
      provider: providerFor(JSON.stringify({
        features: ['特征A'],
        revision_coverage: { 'time-baseline': ['申请日'], 'grace-period': 'not-an-array' },
      })),
    })

    expect(out.revision_coverage).toEqual({ 'time-baseline': ['申请日'] })
  })
})
