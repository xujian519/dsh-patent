import { describe, expect, it } from 'vitest'
import {
  extractLawReferences,
  formatCnNumber,
  formatLawReference,
  parseCnNumber,
  parseLawReference,
  scanUnrecognizedCitations,
} from '../src/reference.ts'

describe('parseCnNumber', () => {
  it('parses Arabic digits', () => {
    expect(parseCnNumber('22')).toBe(22)
    expect(parseCnNumber(' 112 ')).toBe(112)
  })

  it('parses Chinese numerals', () => {
    expect(parseCnNumber('二十二')).toBe(22)
    expect(parseCnNumber('八十二')).toBe(82)
    expect(parseCnNumber('十')).toBe(10)
    expect(parseCnNumber('十五')).toBe(15)
    expect(parseCnNumber('一百')).toBe(100)
    expect(parseCnNumber('一百零五')).toBe(105)
    expect(parseCnNumber('一百一十二')).toBe(112)
    expect(parseCnNumber('一百四十九')).toBe(149)
    expect(parseCnNumber('〇')).toBe(0)
  })

  it('rejects text that is not a plain number', () => {
    expect(parseCnNumber('')).toBeNull()
    expect(parseCnNumber('abc')).toBeNull()
    expect(parseCnNumber('十十')).toBeNull()
    expect(parseCnNumber('一百百')).toBeNull()
    expect(parseCnNumber('十二三')).toBeNull()
    expect(parseCnNumber('一二三')).toBeNull()
  })

  it('rejects a digit string beyond the safe integer range', () => {
    expect(parseCnNumber('99999999999999999999')).toBeNull()
  })
})

describe('formatCnNumber', () => {
  it('renders the forms a Chinese document uses', () => {
    expect(formatCnNumber(0)).toBe('〇')
    expect(formatCnNumber(5)).toBe('五')
    expect(formatCnNumber(10)).toBe('十')
    expect(formatCnNumber(12)).toBe('十二')
    expect(formatCnNumber(22)).toBe('二十二')
    expect(formatCnNumber(100)).toBe('一百')
    expect(formatCnNumber(105)).toBe('一百零五')
    expect(formatCnNumber(112)).toBe('一百一十二')
    expect(formatCnNumber(149)).toBe('一百四十九')
  })

  it('rejects values outside 0..999', () => {
    expect(() => formatCnNumber(-1)).toThrow(RangeError)
    expect(() => formatCnNumber(1000)).toThrow(RangeError)
    expect(() => formatCnNumber(1.5)).toThrow(RangeError)
  })
})

describe('parseLawReference', () => {
  it('parses a bare statute reference with its paragraph and item', () => {
    expect(parseLawReference('专利法第22条第3款')).toEqual({
      kind: 'law-article',
      law: '专利法',
      article: 22,
      paragraph: 3,
      raw: '专利法第22条第3款',
    })
    expect(parseLawReference('专利法第22条第3款第2项')).toEqual({
      kind: 'law-article',
      law: '专利法',
      article: 22,
      paragraph: 3,
      item: 2,
      raw: '专利法第22条第3款第2项',
    })
  })

  it('parses written numerals and wrapping punctuation', () => {
    expect(parseLawReference('《专利法》第二十二条第三款')).toMatchObject({ article: 22 })
    expect(parseLawReference('（专利法第22条第3款）')?.raw).toBe('专利法第22条第3款')
    expect(parseLawReference('专利法第22条第3款。')?.raw).toBe('专利法第22条第3款')
  })

  it('accepts the spaced and full-width forms the shipped skills use', () => {
    expect(parseLawReference('专利法第 22 条第 3 款')).toMatchObject({ article: 22, paragraph: 3 })
    expect(parseLawReference('《专利法》第 22 条第 3 款')).toMatchObject({ article: 22, paragraph: 3 })
    expect(parseLawReference('专利法第２２条第３款')).toMatchObject({ article: 22, paragraph: 3 })
    expect(parseLawReference('细则第 112 条')).toMatchObject({ law: '专利法实施细则', article: 112 })
  })

  it('accepts the parenthesized item form and quotation marks', () => {
    expect(parseLawReference('专利法第22条第3款第（二）项'))
      .toMatchObject({ article: 22, paragraph: 3, item: 2 })
    expect(parseLawReference('“专利法第22条”')).toMatchObject({ article: 22 })
    expect(parseLawReference('「专利法第22条」')).toMatchObject({ article: 22 })
  })

  it('does not read article zero', () => {
    expect(parseLawReference('专利法第〇条')).toBeNull()
  })

  it('maps the abbreviated statute names onto the full ones', () => {
    expect(parseLawReference('细则第112条')?.law).toBe('专利法实施细则')
    expect(parseLawReference('实施细则第5条')?.law).toBe('专利法实施细则')
    expect(parseLawReference('中华人民共和国专利法第22条')?.law).toBe('专利法')
  })

  it('parses a judicial interpretation by its official title', () => {
    expect(parseLawReference('《最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释》第十九条'))
      .toMatchObject({
        kind: 'law-article',
        law: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
        article: 19,
      })
    // 解释（二）必须胜过同前缀的解释（一）的简称形式。
    expect(parseLawReference('最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）第三十一条')?.law)
      .toBe('最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）')
    expect(parseLawReference('最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释第五条'))
      .toMatchObject({ law: '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释', article: 5 })
  })

  it('parses the compact examination form', () => {
    expect(parseLawReference('A22.3')).toEqual({
      kind: 'law-article',
      law: '专利法',
      article: 22,
      paragraph: 3,
      raw: 'A22.3',
    })
    expect(parseLawReference('A26')).toMatchObject({ article: 26 })
  })

  it('parses a guideline section path', () => {
    expect(parseLawReference('审查指南第二部分第四章3.2.1.1')).toEqual({
      kind: 'guideline-section',
      law: '专利审查指南',
      path: '第二部分第四章3.2.1.1',
      raw: '审查指南第二部分第四章3.2.1.1',
    })
  })

  it('returns null for text that is not exactly one reference', () => {
    expect(parseLawReference('')).toBeNull()
    expect(parseLawReference('   ')).toBeNull()
    expect(parseLawReference('根据专利法第22条和细则第5条')).toBeNull()
    expect(parseLawReference('创造性判断')).toBeNull()
  })
})

describe('extractLawReferences', () => {
  it('keeps the order of appearance and deduplicates by reference identity', () => {
    const references = extractLawReferences('依据专利法第22条第3款、专利法实施细则第5条与专利法第22条第3款。')
    expect(references.map(reference => reference.raw)).toEqual(['专利法第22条第3款', '专利法实施细则第5条'])
  })

  it('keeps same-written continuations under different articles', () => {
    const text = '专利法第22条第3款、第4款；专利法第26条第3款、第4款'
    const references = extractLawReferences(text)
    expect(references.map(reference => reference.kind === 'law-article'
      ? [reference.article, reference.paragraph]
      : [0, 0]))
      .toEqual([[22, 3], [22, 4], [26, 3], [26, 4]])
    expect(scanUnrecognizedCitations(text, references)).toEqual([])
  })

  it('inherits the law across coordinated references', () => {
    const references = extractLawReferences('专利法第22条、第23条')
    expect(references).toHaveLength(2)
    expect(references[0]).toMatchObject({ law: '专利法', article: 22 })
    expect(references[1]).toMatchObject({ law: '专利法', article: 23 })
    expect(references[1]?.raw).toBe('第23条')
  })

  it('inherits the article and paragraph across coordinated references', () => {
    const references = extractLawReferences('专利法第22条第2款、第3款')
    expect(references).toHaveLength(2)
    expect(references[0]).toMatchObject({ article: 22, paragraph: 2 })
    expect(references[1]).toMatchObject({ article: 22, paragraph: 3 })
  })

  it('carries the context through a narrowing chain', () => {
    const references = extractLawReferences('专利法第22条、第23条第3款第（二）项')
    expect(references).toHaveLength(2)
    expect(references[0]).toMatchObject({ article: 22 })
    expect(references[1]).toMatchObject({ article: 23, paragraph: 3, item: 2 })
  })

  it('resolves the fee-asset citation form', () => {
    const references = extractLawReferences('专利法实施细则第110条第1款第（一）项、第112条')
    expect(references).toHaveLength(2)
    expect(references[0]).toMatchObject({ law: '专利法实施细则', article: 110, paragraph: 1, item: 1 })
    expect(references[1]).toMatchObject({ law: '专利法实施细则', article: 112 })
  })

  it('stops scanning at the end of the continuation run', () => {
    expect(extractLawReferences('专利法第22条、第23条以及权利要求1')).toHaveLength(2)
    expect(extractLawReferences('专利法第22条、第23条第3款第4项')).toHaveLength(2)
    expect(extractLawReferences('专利法第22条、第23条第（二）项')).toHaveLength(2)
  })

  it('stops a continuation at an unreadable or non-narrowing token', () => {
    expect(extractLawReferences('专利法第22条、第（二）条')).toHaveLength(1)
    expect(extractLawReferences('专利法第22条、第〇条')).toHaveLength(1)
    expect(extractLawReferences('专利法第22条、第十十条')).toHaveLength(1)
    expect(extractLawReferences('专利法第22条、第23条第〇款')).toHaveLength(1)
    expect(extractLawReferences('专利法第22条、第23条第3款第〇项')).toHaveLength(1)
    expect(extractLawReferences('专利法第22条、第23项第2款')).toHaveLength(1)
  })

  it('does not fold a citation in the next sentence into the previous one', () => {
    expect(extractLawReferences('专利法第22条。第23条')).toHaveLength(1)
  })

  it('accepts a guideline section written with spaces', () => {
    expect(extractLawReferences('审查指南第二部分第二章第 2.1.3 节')[0])
      .toMatchObject({ path: '第二部分第二章2.1.3' })
  })

  it('reports fragments the parser could not resolve', () => {
    const text = '专利法第22条，另见第99条、第99条。'
    expect(scanUnrecognizedCitations(text, extractLawReferences(text))).toEqual(['第99条'])
    expect(scanUnrecognizedCitations('专利法第22条、第23条', extractLawReferences('专利法第22条、第23条')))
      .toEqual([])
  })

  it('caps the unresolved fragments it reports', () => {
    const cited = Array.from({ length: 11 }, (_, index) => `第${index + 1}条`).join('、')
    const text = `专利法第22条，另见${cited}。`
    expect(scanUnrecognizedCitations(text, extractLawReferences(text))).toHaveLength(10)
  })

  it('prefers the longer statute name over an inner one', () => {
    const references = extractLawReferences('专利法实施细则第112条')
    expect(references).toHaveLength(1)
    expect(references[0]?.law).toBe('专利法实施细则')
  })

  it('does not read a compact form out of another token', () => {
    expect(extractLawReferences('A4纸与A22.3')).toHaveLength(1)
    expect(extractLawReferences('XA22')).toHaveLength(0)
  })

  it('normalizes the optional 第 and 节 of a guideline section', () => {
    expect(extractLawReferences('审查指南第五部分第七章第2.1节')[0]?.raw).toBe('审查指南第五部分第七章第2.1节')
    expect(extractLawReferences('审查指南第五部分第七章第2.1节')[0])
      .toMatchObject({ path: '第五部分第七章2.1' })
    expect(extractLawReferences('审查指南第一部分第一章 4.3')[0]).toMatchObject({ path: '第一部分第一章4.3' })
    expect(extractLawReferences('审查指南第四部分第三章')[0]).toMatchObject({ path: '第四部分第三章' })
  })

  it('skips a guideline reference whose part or chapter is unreadable', () => {
    expect(extractLawReferences('审查指南第〇部分')).toHaveLength(0)
    expect(extractLawReferences('审查指南第二部分第十十章')).toHaveLength(0)
  })

  it('skips a statute reference whose number the numeral parser rejects', () => {
    expect(extractLawReferences('依据专利法第十十条')).toHaveLength(0)
    expect(extractLawReferences('依据专利法第十二三条')).toHaveLength(0)
  })

  it('rejects a citation whose paragraph or item numeral cannot be read', () => {
    for (const text of [
      '专利法第22条第十十款',
      '专利法第22条第3款第十十项',
      '专利法第22条第3款第（十十）项',
      'A22.0',
    ]) {
      expect(parseLawReference(text), text).toBeNull()
      expect(extractLawReferences(text), text).toEqual([])
      expect(scanUnrecognizedCitations(text, []), text).not.toEqual([])
    }
    expect(scanUnrecognizedCitations('专利法第22条第十十款', [])).toEqual(['第22条', '第十十款'])
    const adjacent = '专利法第22条第3款。另见专利法第22条第十十款'
    expect(scanUnrecognizedCitations(adjacent, extractLawReferences(adjacent))).toEqual(['第22条', '第十十款'])
    // NFKC folds the full-width parentheses before the fragment is reported.
    expect(scanUnrecognizedCitations('专利法第22条第3款第（十十）项', [])).toEqual(['第22条', '第3款', '第(十十)项'])
  })

  it('keeps a guideline reference that names only a part', () => {
    expect(extractLawReferences('审查指南第三部分')[0]).toMatchObject({ path: '第三部分' })
  })

  it('returns nothing for text without a reference', () => {
    expect(extractLawReferences('本案未引用条文。')).toEqual([])
  })
})

describe('formatLawReference', () => {
  it('renders a statute reference in written numerals', () => {
    expect(formatLawReference({
      kind: 'law-article',
      law: '专利法',
      article: 22,
      paragraph: 3,
      raw: 'A22.3',
    })).toBe('《专利法》第二十二条第三款')
    expect(formatLawReference({
      kind: 'law-article',
      law: '专利法实施细则',
      article: 112,
      item: 1,
      raw: '细则第112条第1项',
    })).toBe('《专利法实施细则》第一百一十二条第一项')
    expect(formatLawReference({
      kind: 'law-article',
      law: '专利法',
      article: 1000,
      raw: '专利法第1000条',
    })).toBe('《专利法》第1000条')
  })

  it('renders a guideline reference by its section path', () => {
    expect(formatLawReference({
      kind: 'guideline-section',
      law: '专利审查指南',
      path: '第二部分第四章3.2.1.1',
      raw: '审查指南第二部分第四章3.2.1.1',
    })).toBe('《专利审查指南》第二部分第四章3.2.1.1')
  })
})
