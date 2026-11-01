import { describe, expect, it } from 'vitest'
import { locateQuote, type AnchorResult } from '@deepseek-ai/dsh-patent-core'

/** 取回命中区间对应的原文片段；同时证明 matched 结果确实带 range。 */
function rangeSlice(source: string, result: AnchorResult): string {
  expect(result.range, 'matched result must carry a range').toBeDefined()
  if (result.range === undefined) throw new Error('expected an anchor range')
  return source.slice(result.range.start, result.range.end)
}

describe('locateQuote', () => {
  it('完全一致返回 exact 与原文区间', () => {
    const source = '本发明提供一种数据处理装置，包括存储器与处理器。'
    const quote = '一种数据处理装置'
    const result = locateQuote(quote, source)
    const start = source.indexOf(quote)
    expect(result).toMatchObject({ matched: true, reason: 'exact' })
    expect(result.range).toEqual({ start, end: start + quote.length })
    expect(rangeSlice(source, result)).toBe(quote)
  })

  it('仅全半角标点差异返回 normalized', () => {
    const source = '所述装置，包括：壳体（1）与盖体（2）；其特征在于，所述壳体为圆柱形。'
    const quote = '所述装置,包括:壳体(1)与盖体(2);其特征在于,所述壳体为圆柱形.'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe(source)

    const asciiSource = '所述装置,包括:壳体(1)与盖体(2);其特征在于,所述壳体为圆柱形.'
    const cjkQuote = '所述装置，包括：壳体（1）与盖体（2）；其特征在于，所述壳体为圆柱形。'
    expect(locateQuote(cjkQuote, asciiSource)).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(asciiSource, locateQuote(cjkQuote, asciiSource))).toBe(asciiSource)
  })

  it('CJK 标点与省略号归一化后命中，区间仍指向原文', () => {
    const source = '步骤包括：采集…处理…输出。'
    const quote = '步骤包括:采集...处理...输出.'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe(source)
  })

  it('仅空白差异返回 normalized', () => {
    const source = '本发明\t提供   一种　数据   处理装置。'
    const quote = '本发明 提供 一种 数据 处理装置。'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe(source)
  })

  it('跨段摘录按原文区间回填（CRLF 与 LF 视作同一段边界）', () => {
    const source = '第一段记载了特征A。\r\n第二段记载了特征B。'
    const quote = '第一段记载了特征A。\n第二段记载了特征B。'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe(source)
  })

  it('段边界与空格互相容忍，命中区间仍含原文换行', () => {
    const source = '第一段记载了特征A。\n第二段记载了特征B。'
    const quote = '第一段记载了特征A。 第二段记载了特征B。'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe(source)

    const spacedSource = '第一段记载了特征A。 第二段记载了特征B。'
    const newlineQuote = '第一段记载了特征A。\n第二段记载了特征B。'
    const reverse = locateQuote(newlineQuote, spacedSource)
    expect(reverse).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(spacedSource, reverse)).toBe(spacedSource)
  })

  it('优先段内命中，跨段候选不抢先', () => {
    const source = '前缀。上半句。\n下半句。\n段内：上半句。  下半句。'
    const quote = '上半句。 下半句。'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe('上半句。  下半句。')
  })

  it('改写一个字不命中', () => {
    const source = '本发明提供一种数据处理器。'
    const quote = '本发明提供一种数据存储器。'
    expect(locateQuote(quote, source)).toEqual({ matched: false, reason: 'not-found' })
  })

  it('截断的摘录按实际子串命中', () => {
    const source = '本发明提供一种数据处理装置，能够提高效率。'
    const quote = '本发明提供一种数据处'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'exact' })
    expect(result.range).toEqual({ start: 0, end: quote.length })
    expect(rangeSlice(source, result)).toBe(quote)
  })

  it('摘录比原文多一个字不命中', () => {
    const source = '本发明提供一种数据处理装置。'
    const quote = '本发明提供一种数据处理装置。X'
    expect(locateQuote(quote, source)).toEqual({ matched: false, reason: 'not-found' })
  })

  it('跨段结构存在但内容不符时仍不命中', () => {
    const source = '第一段。\n第二段。'
    const quote = '第一段。第三段。'
    expect(locateQuote(quote, source)).toEqual({ matched: false, reason: 'not-found' })
  })

  it('空摘录与纯空白摘录返回 empty', () => {
    const source = '本发明提供一种数据处理装置。'
    expect(locateQuote('', source)).toEqual({ matched: false, reason: 'empty' })
    expect(locateQuote(' \t\n\u3000', source)).toEqual({ matched: false, reason: 'empty' })
  })

  it('空源文返回 not-found', () => {
    expect(locateQuote('装置', '')).toEqual({ matched: false, reason: 'not-found' })
  })

  it('全角数字不按数字改写', () => {
    const source = '反应温度为２０℃至３０℃。'
    const quote = '反应温度为20℃至30℃。'
    expect(locateQuote(quote, source)).toEqual({ matched: false, reason: 'not-found' })
  })

  it('去除摘录首尾空白后按原文命中', () => {
    const source = '本发明提供一种数据处理装置。'
    const quote = '  一种数据处理装置\n'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'exact' })
    const start = source.indexOf('一种数据处理装置')
    expect(result.range).toEqual({ start, end: start + '一种数据处理装置'.length })
  })

  it('重复出现时取最早命中', () => {
    const source = '装置。装置。'
    const quote = '装置。'
    const result = locateQuote(quote, source)
    expect(result.range).toEqual({ start: 0, end: quote.length })
  })

  it('源文末尾的空白串折叠为段边界后仍可命中', () => {
    const source = '本发明提供一种装置。\n'
    const quote = '本发明提供一种装置.'
    const result = locateQuote(quote, source)
    expect(result).toMatchObject({ matched: true, reason: 'normalized' })
    expect(rangeSlice(source, result)).toBe('本发明提供一种装置。')
  })
})
