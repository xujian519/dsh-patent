import { afterEach, describe, expect, it } from 'vitest'
import {
  extractLegalLawReferences,
  formatCnNumber,
  formatLegalLawReference,
  parseCnNumber,
  parseLegalLawReference,
  rebuildStatutePattern,
  scanUnrecognizedLegalCitations,
} from '../src/reference.ts'

/** The names the shipped pattern starts with; tests that extend it restore this set. */
const BUILTIN_LAW_NAMES = ['民法典', '民事诉讼法', '劳动合同法', '公司法'] as const

afterEach(() => {
  rebuildStatutePattern(BUILTIN_LAW_NAMES)
})

describe('parseCnNumber', () => {
  it('parses Arabic digits', () => {
    expect(parseCnNumber('143')).toBe(143)
    expect(parseCnNumber(' 22 ')).toBe(22)
  })

  it('parses Chinese numerals', () => {
    expect(parseCnNumber('二十二')).toBe(22)
    expect(parseCnNumber('十')).toBe(10)
    expect(parseCnNumber('十五')).toBe(15)
    expect(parseCnNumber('一百')).toBe(100)
    expect(parseCnNumber('一百四十三')).toBe(143)
    expect(parseCnNumber('〇')).toBe(0)
  })

  it('rejects non-number text', () => {
    expect(parseCnNumber('')).toBeNull()
    expect(parseCnNumber('abc')).toBeNull()
    expect(parseCnNumber('十十')).toBeNull()
  })
})

describe('formatCnNumber', () => {
  it('renders Chinese numeral forms', () => {
    expect(formatCnNumber(0)).toBe('〇')
    expect(formatCnNumber(5)).toBe('五')
    expect(formatCnNumber(10)).toBe('十')
    expect(formatCnNumber(143)).toBe('一百四十三')
  })

  it('rejects values outside 0..999', () => {
    expect(() => formatCnNumber(-1)).toThrow(RangeError)
    expect(() => formatCnNumber(1000)).toThrow(RangeError)
  })
})

describe('parseLegalLawReference', () => {
  it('parses a bare statute reference', () => {
    expect(parseLegalLawReference('民法典第143条')).toEqual({
      kind: 'law-article',
      law: '民法典',
      article: 143,
      raw: '民法典第143条',
    })
  })

  it('parses a reference with paragraph and item', () => {
    const ref = parseLegalLawReference('劳动合同法第10条第2款')
    expect(ref).toEqual({
      kind: 'law-article',
      law: '劳动合同法',
      article: 10,
      paragraph: 2,
      raw: '劳动合同法第10条第2款',
    })
  })

  it('parses Chinese numeral references', () => {
    const ref = parseLegalLawReference('民法典第一百四十三条')
    expect(ref).not.toBeNull()
    expect(ref!.article).toBe(143)
    expect(ref!.law).toBe('民法典')
  })

  it('parses the full formal name', () => {
    const ref = parseLegalLawReference('中华人民共和国民法典第143条')
    expect(ref).not.toBeNull()
    expect(ref!.law).toBe('民法典')
    expect(ref!.article).toBe(143)
  })

  it('returns null for unparseable text', () => {
    expect(parseLegalLawReference('')).toBeNull()
    expect(parseLegalLawReference('没有引用')).toBeNull()
  })

  it('parses all four supported laws', () => {
    expect(parseLegalLawReference('民法典第1条')!.law).toBe('民法典')
    expect(parseLegalLawReference('民事诉讼法第66条')!.law).toBe('民事诉讼法')
    expect(parseLegalLawReference('劳动合同法第10条')!.law).toBe('劳动合同法')
    expect(parseLegalLawReference('公司法第20条')!.law).toBe('公司法')
  })

  it('resolves a law name added by an index load', () => {
    rebuildStatutePattern(
      [...BUILTIN_LAW_NAMES, '会计法'],
      new Map([['中华人民共和国会计法', '会计法']]),
    )
    expect(parseLegalLawReference('会计法第9条')).toEqual({
      kind: 'law-article',
      law: '会计法',
      article: 9,
      raw: '会计法第9条',
    })
    expect(parseLegalLawReference('中华人民共和国会计法第9条')!.law).toBe('会计法')
  })

  it('matches names from every chunk of the statute pattern', () => {
    const names = Array.from({ length: 1_200 }, (_, index) => `测试法${index}`)
    rebuildStatutePattern(names)
    for (const name of [names[0], names[600], names[1_199]]) {
      expect(parseLegalLawReference(`${name!}第12条`)).toMatchObject({
        law: name,
        article: 12,
        raw: `${name}第12条`,
      })
    }
  })

  it('keeps one reference when a nested name falls in a later chunk', () => {
    const short = '中华人民共和国测试法'
    const long = `某省实施《${short}》`
    // Longer than the nested name and shorter than the compound name, so the
    // filler pushes the nested name into the second chunk.
    const filler = Array.from({ length: 500 }, (_, index) => `填充法律法规实施条例${index}`)
    rebuildStatutePattern([long, ...filler, short])
    const references = extractLegalLawReferences(`${long}第3条`)
    expect(references).toEqual([{
      kind: 'law-article',
      law: long,
      article: 3,
      raw: `${long.replaceAll('》', '')}第3条`,
    }])
  })
})

describe('extractLegalLawReferences', () => {
  it('drops an article number the numeral parser rejects', () => {
    expect(extractLegalLawReferences('民法典第十十条')).toEqual([])
  })

  it('rejects a citation whose paragraph or item numeral cannot be read', () => {
    for (const text of ['民法典第143条第十十款', '民法典第143条第2款第十十项', '民法典第143条第2款第（十十）项']) {
      expect(parseLegalLawReference(text), text).toBeNull()
      expect(extractLegalLawReferences(text), text).toEqual([])
      expect(scanUnrecognizedLegalCitations(text, []), text).not.toEqual([])
    }
    expect(scanUnrecognizedLegalCitations('民法典第143条第十十款', [])).toEqual(['第143条', '第十十款'])
  })

  it('extracts multiple references from text', () => {
    const text = '根据民法典第143条和第577条，以及劳动合同法第10条的规定'
    const refs = extractLegalLawReferences(text)
    expect(refs).toHaveLength(3)
    expect(refs[0]!.law).toBe('民法典')
    expect(refs[0]!.article).toBe(143)
    expect(refs[1]!.article).toBe(577)
    expect(refs[2]!.law).toBe('劳动合同法')
  })

  it('deduplicates identical references', () => {
    const text = '民法典第143条，民法典第143条'
    const refs = extractLegalLawReferences(text)
    expect(refs).toHaveLength(1)
  })

  it('returns empty for text without citations', () => {
    expect(extractLegalLawReferences('没有法律引用的文本')).toEqual([])
  })

  it('handles continuation references', () => {
    const text = '民法典第143条第1款、第2款'
    const refs = extractLegalLawReferences(text)
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })
})

describe('formatLegalLawReference', () => {
  it('renders a bare reference in Chinese numeral form', () => {
    expect(formatLegalLawReference({
      kind: 'law-article',
      law: '民法典',
      article: 143,
      raw: 'test',
    })).toBe('《民法典》第一百四十三条')
  })

  it('renders a reference with paragraph and item', () => {
    expect(formatLegalLawReference({
      kind: 'law-article',
      law: '劳动合同法',
      article: 10,
      paragraph: 2,
      item: 1,
      raw: 'test',
    })).toBe('《劳动合同法》第十条第二款第一项')
  })
})

describe('scanUnrecognizedLegalCitations', () => {
  it('returns citation-like fragments the parser did not resolve', () => {
    const recognized = extractLegalLawReferences('民法典第143条')
    const unrecognized = scanUnrecognizedLegalCitations('民法典第143条和刑法第20条', recognized)
    expect(unrecognized).toContain('第20条')
  })

  it('returns empty when everything is recognized', () => {
    const recognized = extractLegalLawReferences('民法典第143条')
    const unrecognized = scanUnrecognizedLegalCitations('民法典第143条', recognized)
    expect(unrecognized).toEqual([])
  })

  it('caps at 10 unrecognized fragments', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i + 1}条`).join('，')
    const unrecognized = scanUnrecognizedLegalCitations(text, [])
    expect(unrecognized.length).toBeLessThanOrEqual(10)
  })
})
