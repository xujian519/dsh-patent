import { describe, expect, it } from 'vitest'
import {
  analyzeNumericRanges,
  crossCheckNumericVerdict,
  extractNumericFindings,
  extractNumericRanges,
  isNumericVerdict,
  readNumericVerdict,
  type NumericRangeAnalysis,
} from '../../src/novelty/index.ts'

// 用例表按 Mady domains/novelty/numeric_range_test.go 的情形划分重写（MIT，同作者）；
// 重叠情形改用语义命名，不断言审查指南的条文编号。

const prior = (text: string): { docId: string; text: string } => ({ docId: 'prior_art_1', text })
const claim = (text: string): { id: string; text: string } => ({ id: 'claim', text })

const analyze = (claimText: string, priorText: string): NumericRangeAnalysis =>
  analyzeNumericRanges({ claims: [claim(claimText)], priorArt: [prior(priorText)] })

describe('extractNumericFindings: 数值表述提取', () => {
  it('识别区间写法（连字符/波浪号/至/到/破折号）并归一上下界', () => {
    const findings = extractNumericFindings('温度为 90-20℃，厚度 5～10mm，长度 5~10cm，宽度 5至10m，高度 5到10mm')
    expect(findings.map(f => [f.expression, f.lower, f.upper])).toEqual([
      ['90-20', 20, 90],
      ['5～10', 5, 10],
      ['5~10', 5, 10],
      ['5至10', 5, 10],
      ['5到10', 5, 10],
    ])
  })

  it('识别单边表述，长方向词优先不被截断', () => {
    const findings = extractNumericFindings('温度不低于10℃，压力大于等于 2MPa，厚度至少 5mm，速度 >10m/s，时间不超过 30min')
    expect(findings.map(f => f.expression)).toEqual(['不低于10', '大于等于 2', '至少 5', '>10', '不超过 30'])
  })

  it('带单位即强发现，单位归一化并排除非单位汉字', () => {
    const byExpression = new Map(extractNumericFindings('50-80°C 时 60℃ 与 70°C 对比，厚度 5mm，编号 3个，温度 100度')
      .map(finding => [finding.expression, finding]))
    expect(byExpression.get('50-80')?.unit).toBe('°')
    expect(byExpression.get('60')?.unit).toBe('°')
    expect(byExpression.get('70')?.unit).toBe('°')
    expect(byExpression.get('5')?.unit).toBe('mm')
    expect(byExpression.get('3')?.unit).toBe('')
    expect(byExpression.get('100')?.unit).toBe('度')
    expect(byExpression.get('3')?.strong).toBe(false)
  })

  it('无单位数值仍记录（弱发现），不参与判定', () => {
    const findings = extractNumericFindings('权利要求1-3任一项所述', { claimId: 'claim_1' })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ expression: '1-3', unit: '', strong: false, claimId: 'claim_1' })
  })

  it('按出现位置排序，范围与单边表述混排', () => {
    const findings = extractNumericFindings('温度为 50-80°C，厚度至少 5mm，重量 1.5-2.5kg')
    expect(findings.map(f => f.expression)).toEqual(['50-80', '至少 5', '1.5-2.5'])
  })

  it('无范围/单边表述时兜底提取独立数值（数值点）', () => {
    const findings = extractNumericFindings('温度为 70℃ 时')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ expression: '70', isPoint: true, unit: '°', strong: true })
  })

  it('对比文件侧发现带 docId', () => {
    expect(extractNumericFindings('50-80℃', { docId: 'prior_art_2' })[0]?.docId).toBe('prior_art_2')
  })
})

describe('extractNumericFindings: 连接符前的单位（词表与 validate_specification 共享）', () => {
  it('「数值+单位+连接符+数值」读成一个区间，不拆成两个数值点', () => {
    const findings = extractNumericFindings('温度 20℃ 至 90℃，厚度 5mg-10mg，宽度 10mm~20mm')
    expect(findings.map(f => ({
      expression: f.expression,
      lower: f.lower,
      upper: f.upper,
      unit: f.unit,
      isPoint: f.isPoint,
    }))).toEqual([
      { expression: '20℃ 至 90', lower: 20, upper: 90, unit: '°', isPoint: false },
      { expression: '5mg-10', lower: 5, upper: 10, unit: 'mg', isPoint: false },
      { expression: '10mm~20', lower: 10, upper: 20, unit: 'mm', isPoint: false },
    ])
  })

  it('两侧都写中文单位时读成一个区间', () => {
    const findings = extractNumericFindings('温度为20毫米至90毫米')
    expect(findings).toEqual([
      expect.objectContaining({ expression: '20毫米至90', lower: 20, upper: 90, unit: '毫米', isPoint: false, strong: true }),
    ])
  })

  it('连接符集含 en dash 与「到」', () => {
    const findings = extractNumericFindings('温度 20–90℃，压力 20到30MPa')
    expect(findings.map(f => [f.lower, f.upper, f.unit])).toEqual([
      [20, 90, '°'],
      [20, 30, 'mpa'],
    ])
  })

  it('尾随单位缺席时用连接符前写的单位，不把强发现降级为弱发现', () => {
    const findings = extractNumericFindings('温度 20℃至90，成功率约 70%—75，重量比 50-80')
    expect(findings.map(f => ({ expression: f.expression, unit: f.unit, strong: f.strong }))).toEqual([
      { expression: '20℃至90', unit: '°', strong: true },
      { expression: '70%—75', unit: '%', strong: true },
      { expression: '50-80', unit: '', strong: false },
    ])
  })
})

describe('extractNumericFindings: 带符号数值与后缀单边表述', () => {
  it('负值区间保留符号并归一上下界', () => {
    const findings = extractNumericFindings('温度为-5至-10℃，厚度-1.5到-2.5mm')
    expect(findings.map(f => ({ expression: f.expression, lower: f.lower, upper: f.upper, unit: f.unit }))).toEqual([
      { expression: '-5至-10', lower: -10, upper: -5, unit: '°' },
      { expression: '-1.5到-2.5', lower: -2.5, upper: -1.5, unit: 'mm' },
    ])
  })

  it('Unicode 减号与全角减号按负号处理', () => {
    const findings = extractNumericFindings('温度为−5℃、－10℃')
    expect(findings.map(f => [f.expression, f.lower])).toEqual([['−5', -5], ['－10', -10]])
  })

  it('后缀式下界与上界', () => {
    const findings = extractNumericFindings('温度为 70℃以上，湿度 80%以下，压力不大于 2MPa')
    expect(findings.map(f => ({ expression: f.expression, lower: f.lower, upper: f.upper, unit: f.unit }))).toEqual([
      { expression: '70℃以上', lower: 70, upper: Infinity, unit: '°' },
      { expression: '80%以下', lower: -Infinity, upper: 80, unit: '%' },
      { expression: '不大于 2', lower: -Infinity, upper: 2, unit: 'mpa' },
    ])
  })

  it('方向词后的负数不被读成正数', () => {
    const findings = extractNumericFindings('温度不低于-5℃')
    expect(findings[0]).toMatchObject({ expression: '不低于-5', lower: -5, upper: Infinity, unit: '°' })
  })

  it('后缀未写单位 → 弱发现，不参与判定', () => {
    const findings = extractNumericFindings('温度为 70 以上')
    expect(findings).toEqual([
      expect.objectContaining({ expression: '70 以上', lower: 70, upper: Infinity, unit: '', strong: false }),
    ])
  })

  it('汉字单位后紧跟普通词时只取首字单位', () => {
    const findings = extractNumericFindings('长度为 50 米的装置')
    expect(findings[0]).toMatchObject({ expression: '50', unit: '米', strong: true })
  })
})

describe('extractNumericRanges: 面向模型的片段清单', () => {
  it('只保留范围与单边表述，去重且按位置排序', () => {
    expect(extractNumericRanges('温度范围为 50-80°C，厚度至少 5mm，速度大于 10m/s，压力 ≤ 2MPa，重量 1.5-2.5kg'))
      .toEqual(['50-80', '至少 5', '大于 10', '≤ 2', '1.5-2.5'])
    expect(extractNumericRanges('温度为 70℃')).toEqual([])
    expect(extractNumericRanges('50-80℃ 与 50-80℃')).toEqual(['50-80'])
    expect(extractNumericRanges('无任何数值')).toEqual([])
  })
})

describe('analyzeNumericRanges: 区间重叠判定', () => {
  it('区间重叠 → overlapped', () => {
    const analysis = analyze('温度为 50-80℃', 'D1 公开温度为 60-90℃')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.overlaps).toHaveLength(1)
    expect(analysis.overlaps[0]?.kind).toBe('overlapped')
    expect(analysis.overlaps[0]?.note).toContain('破坏新颖性')
    expect(analysis.summary).toContain('权利要求 1 处数值表述（强 1）')
  })

  it('数值点落在对比文件范围内且无共同端点 → inside_without_endpoint', () => {
    const analysis = analyze('温度为 70℃', 'D1 公开温度为 60-90℃')
    expect(analysis.verdict).toBe('inside_without_endpoint')
    expect(analysis.overlaps[0]?.kind).toBe('inside_without_endpoint')
    expect(analysis.overlaps[0]?.note).toContain('不破坏新颖性')
  })

  it('数值点与对比文件范围共有端点 → 仍为破坏性重叠', () => {
    const analysis = analyze('温度为 60℃', 'D1 公开温度为 60-90℃')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.overlaps[0]?.kind).toBe('overlapped')
  })

  it('区间不相交 → no_overlap', () => {
    const analysis = analyze('温度为 50-80℃', 'D1 公开温度为 100-200℃')
    expect(analysis.verdict).toBe('no_overlap')
    expect(analysis.overlaps).toEqual([])
    expect(analysis.summary).toContain('未发现数值范围重叠')
  })

  it('量纲不同的单位不可比 → inconclusive 且记录不可比对', () => {
    const analysis = analyze('长度为 50-80mm', 'D1 公开温度为 50-80℃')
    expect(analysis.verdict).toBe('inconclusive')
    expect(analysis.overlaps).toEqual([])
    expect(analysis.incomparablePairs).toHaveLength(1)
    expect(analysis.incomparablePairs[0]?.reason).toBe('dimension-mismatch')
    expect(analysis.reason).toContain('单位量纲不同')
    expect(analysis.summary).toContain('不可比 1 对')
  })

  it('单边表述按 ±Infinity 参与区间相交', () => {
    expect(analyze('温度不低于 70℃', 'D1 公开温度为 100-200℃').verdict).toBe('overlapped')
    expect(analyze('温度不超过 80℃', 'D1 公开温度为 100-200℃').verdict).toBe('no_overlap')
  })

  it('任一强发现缺失 → inconclusive', () => {
    expect(analyze('温度为 50-80', 'D1 公开温度为 60-90℃').verdict).toBe('inconclusive')
    expect(analyze('温度为 50-80℃', 'D1 公开了加热装置').verdict).toBe('inconclusive')
    expect(analyze('温度为 50-80℃', '').verdict).toBe('inconclusive')
    expect(analyze('温度为 50-80', 'D1 公开温度为 60-90').verdict).toBe('inconclusive')
    expect(analyzeNumericRanges({ claims: [], priorArt: [] }).verdict).toBe('inconclusive')
  })

  it('同时存在破坏性与提示性重叠 → 取破坏性结论并列出全部重叠对', () => {
    const analysis = analyze('温度为 50-80℃，湿度为 70%', 'D1 公开温度为 60-90℃，湿度为 50-90%')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.overlaps).toHaveLength(2)
    expect(analysis.summary).toContain('[claim × prior_art_1]')
    expect(analysis.summary).toContain('（inside_without_endpoint）')
  })

  it('inconclusive 的摘要说明无法判定', () => {
    expect(analyze('温度为 50-80', '').summary).toContain('未提取到足够的带单位数值表述，无法判定')
  })
})

describe('analyzeNumericRanges: 带符号数值与单位换算', () => {
  it('负值区间重叠 → overlapped', () => {
    expect(analyze('温度为-5至-10℃', 'D1 公开温度为-8至-6℃').verdict).toBe('overlapped')
  })

  it('负值数值点落入对比文件范围 → inside_without_endpoint', () => {
    expect(analyze('温度为-5℃', 'D1 公开温度为-10至-1℃').verdict).toBe('inside_without_endpoint')
  })

  it('跨零区间重叠 → overlapped', () => {
    expect(analyze('温度为-5至5℃', 'D1 公开温度为-3至3℃').verdict).toBe('overlapped')
  })

  it('同量纲不同单位换算后比较', () => {
    const analysis = analyze('加入量为 5-10mg', 'D1 公开加入量为 0.005-0.01g')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.incomparablePairs).toEqual([])
    expect(analysis.overlaps).toHaveLength(1)
  })

  it('中文单位与拉丁单位同量纲可比', () => {
    expect(analyze('厚度 5-10毫米', 'D1 公开厚度 0.5-1cm').verdict).toBe('overlapped')
  })

  it('两侧中文单位区间按范围判定而非拆成数值点', () => {
    const analysis = analyze('厚度为20毫米至90毫米', '对比文件公开厚度为25毫米至30毫米')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.claimRanges).toHaveLength(1)
    expect(analysis.priorRanges).toHaveLength(1)
    expect(analysis.overlaps).toHaveLength(1)
  })

  it('时间单位换算后比较', () => {
    expect(analyze('加热 1-2h', 'D1 公开加热 60-90min').verdict).toBe('overlapped')
  })

  it('摄氏度与「度」按同一温标比较', () => {
    expect(analyze('温度为 20℃', 'D1 公开温度为 20度').verdict).toBe('overlapped')
  })

  it('表外单位写法相同仍可比', () => {
    expect(analyze('粘度为 5-10cps', 'D1 公开粘度为 8-12cps').verdict).toBe('overlapped')
  })

  it('表外单位写法不同 → inconclusive', () => {
    const analysis = analyze('粘度为 5-10cps', 'D1 公开粘度为 5-10cp')
    expect(analysis.verdict).toBe('inconclusive')
    expect(analysis.incomparablePairs[0]?.reason).toBe('unknown-unit')
    expect(analysis.summary).toContain('单位不在可比词表中')
  })

  it('存在破坏性重叠时不可比对不改变结论', () => {
    const analysis = analyze(
      '温度为 50-80℃，加入量 5-10mg',
      'D1 公开温度为 60-90℃，加热时间 5-10s',
    )
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.incomparablePairs).toHaveLength(3)
    expect(analysis.reason).toContain('5-10')
  })

  it('无重叠但存在不可比对 → inconclusive', () => {
    expect(analyze(
      '温度为 50-80℃，加入量 5-10mg',
      'D1 公开温度为 100-200℃，加热时间 5-10s',
    ).verdict).toBe('inconclusive')
  })

  it('后缀下界与对比文件区间相交 → overlapped', () => {
    expect(analyze('温度在 70℃以上', 'D1 公开温度为 100-200℃').verdict).toBe('overlapped')
  })

  it('后缀上界与对比文件区间不相交 → no_overlap', () => {
    expect(analyze('温度在 80℃以下', 'D1 公开温度为 100-200℃').verdict).toBe('no_overlap')
  })

  it('全角百分号与半角百分号同单位', () => {
    expect(analyze('湿度为 70％', 'D1 公开湿度为 50-90%').verdict).toBe('inside_without_endpoint')
  })

  it('换算后的共同端点受浮点误差容差保护', () => {
    // 700 × 0.001 落在 0.7 的相邻 ulp 上，严格比较会把它误判为落在区间内部。
    const analysis = analyze('加入量为 700mg', 'D1 公开加入量为 0.7-1g')
    expect(analysis.verdict).toBe('overlapped')
    expect(analysis.overlaps[0]?.kind).toBe('overlapped')
  })

  it('换算溢出为 Infinity 时不误报重叠', () => {
    const huge = `1${'0'.repeat(308)}`
    const analysis = analyze(`温度为 ${huge}km`, 'D1 公开温度为 100-200km')
    expect(analysis.verdict).toBe('no_overlap')
    expect(analysis.overlaps).toEqual([])
  })
})

describe('crossCheckNumericVerdict: 与语义轨对照', () => {
  it('结论相同 → agree', () => {
    const analysis = analyze('温度为 50-80℃', 'D1 公开温度为 60-90℃')
    expect(crossCheckNumericVerdict(analysis, 'overlapped').llmAgreement).toBe('agree')
  })

  it('具体结论不同 → disagree 且在摘要中提示复核', () => {
    const analysis = analyze('温度为 50-80℃', 'D1 公开温度为 60-90℃')
    const checked = crossCheckNumericVerdict(analysis, 'no_overlap')
    expect(checked.llmAgreement).toBe('disagree')
    expect(checked.summary).toContain('与语义轨结论不一致，请重点复核')
    expect(checked.verdict).toBe('overlapped')
  })

  it('确定性结论无法判定或 LLM 结论缺失 → n_a', () => {
    const inconclusive = analyze('温度为 50-80', '')
    expect(crossCheckNumericVerdict(inconclusive, 'overlapped').llmAgreement).toBe('n_a')
    const determinate = analyze('温度为 50-80℃', 'D1 公开温度为 60-90℃')
    expect(crossCheckNumericVerdict(determinate, undefined).llmAgreement).toBe('n_a')
    expect(crossCheckNumericVerdict(determinate, 'bogus').llmAgreement).toBe('n_a')
    expect(crossCheckNumericVerdict(determinate, undefined).summary).not.toContain('与语义轨')
  })
})

describe('readNumericVerdict / isNumericVerdict', () => {
  it('读取 JSON 结论，容忍代码围栏', () => {
    expect(readNumericVerdict('{"verdict":"overlapped","assessments":[]}')).toBe('overlapped')
    expect(readNumericVerdict('```json\n{"verdict":"no_overlap"}\n```')).toBe('no_overlap')
  })

  it('无法识别时返回 undefined', () => {
    expect(readNumericVerdict('')).toBeUndefined()
    expect(readNumericVerdict('不是 JSON')).toBeUndefined()
    expect(readNumericVerdict('[1,2]')).toBeUndefined()
    expect(readNumericVerdict('{"verdict":"maybe"}')).toBeUndefined()
    expect(readNumericVerdict('{"assessments":[]}')).toBeUndefined()
  })

  it('类型守卫只接受四个枚举值', () => {
    expect(isNumericVerdict('inside_without_endpoint')).toBe(true)
    expect(isNumericVerdict('inconclusive')).toBe(true)
    expect(isNumericVerdict('overlapped ')).toBe(false)
    expect(isNumericVerdict(undefined)).toBe(false)
  })
})
