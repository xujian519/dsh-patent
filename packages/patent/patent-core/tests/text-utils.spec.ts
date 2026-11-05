import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEGATION_WINDOW,
  DEFAULT_NEGATION_WORDS,
  hasNegationContext,
  locateMatch,
  locationAt,
} from '@deepseek-ai/dsh-patent-core'

describe('hasNegationContext', () => {
  it('否定词命中（默认窗口与词表）', () => {
    expect(hasNegationContext('本方案避免侵权', 5)).toBe(true)
    expect(hasNegationContext('该方案防止侵权', 5)).toBe(true)
    expect(hasNegationContext('本方案不构成侵权', 6)).toBe(true)
    expect(hasNegationContext('该方法避免了对现有技术的侵权', 12)).toBe(true)
  })

  it('句界分隔否定不跨句', () => {
    expect(hasNegationContext('本方案避免侵权。但需注意侵权风险', 15)).toBe(false)
    expect(hasNegationContext('本方案避免侵权！仍需注意侵权风险', 15)).toBe(false)
    expect(hasNegationContext('本方案避免侵权？仍需注意侵权风险', 15)).toBe(false)
    expect(hasNegationContext('本方案避免侵权\n但需注意侵权风险', 15)).toBe(false)
  })

  it('窗口外否定不算', () => {
    const far = '避免'.padEnd(DEFAULT_NEGATION_WINDOW + 10, '字') + '侵权'
    expect(hasNegationContext(far, far.length - 2)).toBe(false)
  })

  it('复合词吞入的否定词不算（无可避免的侵权仍是侵权陈述）', () => {
    expect(hasNegationContext('使用无可避免的侵权风险', 7)).toBe(false)
    expect(hasNegationContext('存在不可避免的侵权风险', 7)).toBe(false)
  })

  it('自定义词表与窗口（synonym-engine 场景）', () => {
    const custom = ['无法证明', '不具有']
    expect(hasNegationContext('本方案无法证明新颖性', 7, { window: 60, negationWords: custom })).toBe(true)
    expect(hasNegationContext('本方案避免侵权', 5, { window: 60, negationWords: custom })).toBe(false)
  })

  it('adjacentWords 只豁免紧邻前缀（与 negationWords 的窗口语义相反）', () => {
    // 传空 negationWords 隔离两条通道：命中「窃听」（matchStart=8）时前缀「防」紧邻，
    // 命中的是「赌博」（matchStart=17）时前缀「检测」隔了十余字——前者豁免、后者不豁免。
    const adjacentOnly = { negationWords: [] as string[], adjacentWords: ['防', '检测'] }
    expect(hasNegationContext('本发明提供一种防窃听装置', 8, adjacentOnly)).toBe(true)
    // 中文逗号不在 SENTENCE_BOUNDARIES 内，故这条走的是「窗口内有前缀词但不紧邻」，
    // 而非被句界提前拦下——窗口路径才是本用例要证的区分点。
    expect(hasNegationContext('本系统通过检测用户行为，诱导其参与赌博', 17, adjacentOnly)).toBe(false)
    expect(hasNegationContext('本装置防范风险，可用于赌博', 11, adjacentOnly)).toBe(false)
  })

  it('adjacentWords 先于句界判定（复合词地位不依赖前文）', () => {
    // 「乙。本发明提供防窃听装置」的「防」紧邻命中词，前置句号不该取消「防窃听」的复合词
    // 地位；若把紧邻判定挪到句界检查之后，此用例转红。
    expect(hasNegationContext('乙。本发明提供防窃听装置', 8, { adjacentWords: ['防'] })).toBe(true)
  })

  it('adjacentWords 的空串前缀不豁免（endsWith 对空串恒真，须显式排除）', () => {
    expect(hasNegationContext('本发明涉及窃听', 5, { negationWords: [], adjacentWords: [''] })).toBe(false)
  })

  it('默认导出词表与既有镜像一致', () => {
    expect([...DEFAULT_NEGATION_WORDS]).toEqual([
      '防止', '避免', '不用于', '排除', '禁止', '严禁', '不得', '不应', '不为', '非用于', '不构成', '区别于', '不属于',
    ])
  })
})

describe('locateMatch', () => {
  it('回报 1 基行号与命中所在句', () => {
    const text = '第一行无关。\n第二行含目标词。\n第三行无关。'
    expect(locateMatch(text, ['目标词'])).toEqual({ line: 2, matchedSentence: '第二行含目标词。' })
  })

  it('多个片段取文本中最早出现的一处，而非片段表顺序', () => {
    const text = '第一行出现甲。\n第二行出现乙。'
    const found = locateMatch(text, ['乙', '甲'])
    expect(found?.line).toBe(1)
    expect(found?.matchedSentence).toBe('第一行出现甲。')
  })

  it('命中处不在句首时只取该句，不带上文', () => {
    const text = '前一句无关。目标词出现在这一句中间，后接其余内容。后一句无关。'
    expect(locateMatch(text, ['目标词'])?.matchedSentence).toBe('目标词出现在这一句中间，后接其余内容。')
  })

  it('文本中不含任何片段时返回 undefined', () => {
    expect(locateMatch('文本', ['缺失'])).toBeUndefined()
    expect(locateMatch('文本', [])).toBeUndefined()
    expect(locateMatch('文本', [''])).toBeUndefined()
  })

  it('超长无标点段落按命中位置居中截断，且保留命中词', () => {
    const text = `${'甲'.repeat(200)}目标${'乙'.repeat(200)}`
    const found = locateMatch(text, ['目标'])
    expect(found?.line).toBe(1)
    expect(found?.matchedSentence).toContain('目标')
    expect(found?.matchedSentence.length).toBeLessThanOrEqual(122)
    expect(found?.matchedSentence.startsWith('…')).toBe(true)
    expect(found?.matchedSentence.endsWith('…')).toBe(true)
  })
})

describe('locationAt', () => {
  it('按下标给出该处的行号与所在句', () => {
    const text = '第一行无关。\n第二行含目标词。\n第三行无关。'
    expect(locationAt(text, text.indexOf('目标词'))).toEqual({ line: 2, matchedSentence: '第二行含目标词。' })
  })

  it('取指定下标那一处，而非同词更早的命中', () => {
    const text = '第一行含目标词。\n第二行也含目标词。'
    expect(locationAt(text, text.lastIndexOf('目标词'))).toEqual({ line: 2, matchedSentence: '第二行也含目标词。' })
  })

  it('下标为 0 时落在第一行句首', () => {
    expect(locationAt('目标词起头。后一句。', 0)).toEqual({ line: 1, matchedSentence: '目标词起头。' })
  })
})
