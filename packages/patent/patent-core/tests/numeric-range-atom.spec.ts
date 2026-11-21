import { describe, expect, it } from 'vitest'
import { NumericRangeHandler, numericRangeAtom } from '../src/atoms/handlers/builtin/numeric-range.ts'

const handler = new NumericRangeHandler()

describe('numeric-range atom', () => {
  it('声明报告为主输出，输入读取权利要求侧文本与检索结果', () => {
    expect(numericRangeAtom.name).toBe('numeric-range')
    expect(numericRangeAtom.category).toBe('compare')
    expect(numericRangeAtom.outputSchema[0]).toBe('numeric_range_report')
    expect(numericRangeAtom.inputSchema).toContain('claim')
    expect(numericRangeAtom.inputSchema).toContain('prior_art')
  })

  it('区间重叠 → overlapped，并保留可复核的重叠对', async () => {
    const out = await handler.execute({
      state: {
        claim: '权利要求 1：温度为 50-80℃。',
        prior_art: [{ title: 'D1', snippet: 'D1 公开温度为 60-90℃。' }],
      },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(out.numeric_range_overlaps).toEqual([
      {
        claimId: 'claim',
        claimExpression: '50-80',
        priorDocId: 'D1',
        priorExpression: '60-90',
        kind: 'overlapped',
        note: '数值范围重叠或存在共同端点，破坏新颖性',
      },
    ])
    expect(String(out.numeric_range_report)).toContain('破坏新颖性')
    expect(String(out.numeric_range_report)).toContain('不替代语义新颖性分析')
  })

  it('数值点落入对比文件范围且无共同端点 → inside_without_endpoint', async () => {
    const out = await handler.execute({
      state: { claim: '输送温度为 70℃。', prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(out.numeric_range_verdict).toBe('inside_without_endpoint')
    expect(out.numeric_range_report).toContain('不破坏新颖性')
  })

  it('数值点与对比文件范围共有端点 → overlapped', async () => {
    const out = await handler.execute({
      state: { claim: '输送温度为 60℃。', prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
  })

  it('区间不相交 → no_overlap；量纲不同的单位不可比 → inconclusive', async () => {
    const disjoint = await handler.execute({
      state: { claim: '温度为 50-80℃。', prior_art: [{ text: 'D1 公开温度为 100-200℃。' }] },
    })
    expect(disjoint.numeric_range_verdict).toBe('no_overlap')
    expect(disjoint.numeric_range_overlaps).toEqual([])

    const differentUnit = await handler.execute({
      state: { claim: '长度为 50-80mm。', prior_art: [{ text: 'D1 公开温度为 50-80℃。' }] },
    })
    expect(differentUnit.numeric_range_verdict).toBe('inconclusive')
    expect(String(differentUnit.numeric_range_report)).toContain('单位量纲不同')
  })

  it('同量纲不同单位换算后仍判定重叠', async () => {
    const out = await handler.execute({
      state: { claim: '加入量为 5-10mg。', prior_art: [{ text: 'D1 公开加入量为 0.005-0.01g。' }] },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
  })

  it('未提供现有技术时给出 inconclusive，不标记降级', async () => {
    const out = await handler.execute({ state: { claim: '温度为 50-80℃。' } })
    expect(out._error).toBeUndefined()
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('未提供现有技术文本（state.prior_art）')
    expect(out.numeric_ranges).toEqual(['50-80'])
  })

  it('现有技术条目均无可读文本时说明原因，不误报“未提供”', async () => {
    const out = await handler.execute({
      state: { claim: '温度为 50-80℃。', prior_art: [{}, { title: '' }] },
    })
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('提供的 2 篇现有技术条目均无可读取文本')
  })

  it('权利要求侧没有带单位数值 → 无需专项分析（拒绝路径）', async () => {
    const out = await handler.execute({
      state: { claim: '权利要求 1-3 任一项所述。', prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_overlaps).toEqual([])
    expect(out.numeric_ranges).toEqual([])
    expect(out.numeric_range_report).toContain('未检测到带单位的数值表述')
  })

  it('权利要求文本类型错误 → 降级并指明键名', async () => {
    const out = await handler.execute({ state: { claim: 123 } })
    expect(out._error).toContain('[numeric-range]')
    expect(out._error).toContain('state.claim 不是字符串或字符串数组')
  })

  it('没有任何文本 → inconclusive 并列出读取的键（信息不足不降级）', async () => {
    const out = await handler.execute({ state: { prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] } })
    expect(out._error).toBeUndefined()
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('缺少权利要求文本')
    expect(out.numeric_range_report).toContain('state.claim / claim_text / features')
  })

  it('空白的 features 数组不充当权利要求文本', async () => {
    const out = await handler.execute({
      state: { features: ['  ', ''], prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(out._error).toBeUndefined()
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('缺少权利要求文本')
  })

  it('features 数组可作为权利要求侧文本来源', async () => {
    const out = await handler.execute({
      state: {
        features: ['温度为 50-80℃', '厚度为 5mm'],
        prior_art: [{ text: 'D1 公开温度为 60-90℃，厚度为 1-3mm。' }],
      },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(out.numeric_ranges).toEqual(['50-80', '5'])
    expect(String(out.numeric_range_report)).toContain('[features × D1]')
  })

  it('权利要求键缺失时回退到 source_text 或 input', async () => {
    const out = await handler.execute({
      state: { source_text: '本申请温度为 50-80℃。', prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(String(out.numeric_range_report)).toContain('[source_text × D1]')

    const fromInput = await handler.execute({
      state: { input: '本申请温度为 50-80℃。', prior_art: [{ text: 'D1 公开温度为 60-90℃。' }] },
    })
    expect(fromInput.numeric_range_verdict).toBe('overlapped')
    expect(String(fromInput.numeric_range_report)).toContain('[input × D1]')
  })

  it('claim 与 claim_text 指向同一文本时只计数一次', async () => {
    const out = await handler.execute({
      state: {
        claim: '温度为 50-80℃。',
        claim_text: '温度为 50-80℃。',
        prior_art: [{ text: 'D1 公开温度为 60-90℃。' }],
      },
    })
    expect(out.numeric_ranges).toEqual(['50-80'])
    expect(String(out.numeric_range_report)).toContain('权利要求 1 处数值表述（强 1）')
  })

  it('现有技术文本字段按全文、片段、标题的顺序读取', async () => {
    const out = await handler.execute({
      state: {
        claim: '温度为 50-80℃。',
        prior_art: [{ text: 'D1 公开温度为 60-90℃。', snippet: '无关内容 100-200℃。' }],
      },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(out.numeric_range_overlaps).toEqual([
      expect.objectContaining({ priorExpression: '60-90' }),
    ])
  })

  it('字符串条目、非对象条目与保留的 dLabel 都能参与比对', async () => {
    const out = await handler.execute({
      state: {
        claim: '温度为 50-80℃。',
        prior_art: [null, { text: 'D3 公开温度为 60-90℃。', dLabel: 'D3' }],
      },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(out.numeric_range_overlaps).toEqual([
      expect.objectContaining({ priorDocId: 'D3' }),
    ])
    expect(out.numeric_range_report).toContain('1 篇现有技术条目无可读取文本')

    const fromString = await handler.execute({
      state: { claim: '温度为 50-80℃。', prior_art: ['D1 公开温度为 60-90℃。'] },
    })
    expect(fromString.numeric_range_verdict).toBe('overlapped')
  })

  it('字符串数组中没有有效文本时视为未提供', async () => {
    const out = await handler.execute({ state: { claim: ['   ', 3] } })
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('缺少权利要求文本')
  })

  it('空白字符串条目视为无可读取文本', async () => {
    const out = await handler.execute({
      state: { claim: '温度为 50-80℃。', prior_art: ['   '] },
    })
    expect(out.numeric_range_verdict).toBe('inconclusive')
    expect(out.numeric_range_report).toContain('提供的 1 篇现有技术条目均无可读取文本')
  })

  it('prior_art 不是数组 → 降级（输入边界拒绝）', async () => {
    const out = await handler.execute({ state: { claim: '温度为 50-80℃。', prior_art: {} } })
    expect(out._error).toContain('[numeric-range]')
    expect(out._error).toContain('state.prior_art 不是数组')
  })

  it('参数可覆盖权利要求文本键与检索结果键', async () => {
    const out = await handler.execute({
      state: {
        claim_text_keys: ['claims_text'],
        claims_text: '温度为 50-80℃。',
        prior_art_key: 'evidence',
        evidence: [{ text: 'D1 公开温度为 60-90℃。' }],
      },
    })
    expect(out.numeric_range_verdict).toBe('overlapped')
    expect(String(out.numeric_range_report)).toContain('[claims_text × D1]')
  })

  it('配置键非法 → 降级', async () => {
    const badKeys = await handler.execute({
      state: { claim_text_keys: 'claim', claim: '温度为 50-80℃。' },
    })
    expect(badKeys._error).toContain('params.claim_text_keys')

    const badItem = await handler.execute({
      state: { claim_text_keys: ['claim', 3], claim: '温度为 50-80℃。' },
    })
    expect(badItem._error).toContain('params.claim_text_keys')

    const badPriorArtKey = await handler.execute({
      state: { claim: '温度为 50-80℃。', prior_art_key: '' },
    })
    expect(badPriorArtKey._error).toContain('params.prior_art_key')
  })
})
