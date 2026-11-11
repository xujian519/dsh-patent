import { describe, expect, it } from 'vitest'
import {
  articleReferenceIdentity,
  compactCitation,
  formatArticleCitation,
  formatCitationNumber,
  formatCnNumber,
  narrowed,
  normalizeCitationText,
  stripBookMarks,
  trimPunctuation,
} from '@deepseek-ai/dsh-law-core'

describe('normalizeCitationText', () => {
  it('全角数字与字母折叠为 ASCII', () => {
    expect(normalizeCitationText('第２２条')).toBe('第22条')
    expect(normalizeCitationText('Ａ２２.３')).toBe('A22.3')
  })

  it('保留已经是 ASCII 的文本', () => {
    expect(normalizeCitationText('专利法第22条')).toBe('专利法第22条')
  })
})

describe('formatCnNumber', () => {
  it('零与个位数', () => {
    expect(formatCnNumber(0)).toBe('〇')
    expect(formatCnNumber(1)).toBe('一')
    expect(formatCnNumber(9)).toBe('九')
  })

  it('十位组合，十位为一且无百位时省略“一”', () => {
    expect(formatCnNumber(10)).toBe('十')
    expect(formatCnNumber(11)).toBe('十一')
    expect(formatCnNumber(20)).toBe('二十')
    expect(formatCnNumber(99)).toBe('九十九')
  })

  it('百位组合与零占位', () => {
    expect(formatCnNumber(100)).toBe('一百')
    expect(formatCnNumber(101)).toBe('一百零一')
    expect(formatCnNumber(105)).toBe('一百零五')
    expect(formatCnNumber(110)).toBe('一百一十')
    expect(formatCnNumber(999)).toBe('九百九十九')
  })

  it('拒绝超出 0..999 或非整数的输入', () => {
    expect(() => formatCnNumber(-1)).toThrow(RangeError)
    expect(() => formatCnNumber(1.5)).toThrow(RangeError)
    expect(() => formatCnNumber(1000)).toThrow(RangeError)
  })
})

describe('formatCitationNumber', () => {
  it('范围内渲染为中文数字，范围外保留阿拉伯数字而不抛错', () => {
    expect(formatCitationNumber(22)).toBe('二十二')
    expect(formatCitationNumber(999)).toBe('九百九十九')
    expect(formatCitationNumber(1000)).toBe('1000')
    expect(formatCitationNumber(-1)).toBe('-1')
  })
})

describe('narrowed', () => {
  it('同时解析款与项', () => {
    expect(narrowed('三', '二')).toEqual({ paragraph: 3, item: 2 })
  })

  it('缺省的字段不出现在结果里', () => {
    expect(narrowed(undefined, undefined)).toEqual({})
    expect(narrowed(undefined, '二')).toEqual({ item: 2 })
  })

  it('无法解析或不是正整数的款、项拒绝整条窄化', () => {
    expect(narrowed('abc', undefined)).toBeNull()
    expect(narrowed('十十', undefined)).toBeNull()
    expect(narrowed('0', undefined)).toBeNull()
    expect(narrowed('三', '十十')).toBeNull()
    expect(narrowed(undefined, '0')).toBeNull()
  })
})

describe('stripBookMarks', () => {
  it('移除所有书名号收尾符，保留起始符', () => {
    expect(stripBookMarks('《专利法》》')).toBe('《专利法')
    expect(stripBookMarks('没有书名号')).toBe('没有书名号')
  })
})

describe('trimPunctuation', () => {
  it('移除首尾的括号、引号与标点', () => {
    expect(trimPunctuation('（第22条）。')).toBe('第22条')
    expect(trimPunctuation('“第22条”')).toBe('第22条')
    // 起始书名号属于首部括号类，会被一并移除；结尾的书名号不是收尾标点，予以保留。
    expect(trimPunctuation('《专利法》第二十二条')).toBe('专利法》第二十二条')
  })

  it('只修剪首尾，不触碰中间的标点', () => {
    expect(trimPunctuation('第22条、第23条')).toBe('第22条、第23条')
  })
})

describe('compactCitation', () => {
  it('移除所有空白，供包含关系比较使用', () => {
    expect(compactCitation('第 22 条 第 3 款')).toBe('第22条第3款')
  })
})

describe('formatArticleCitation', () => {
  it('按正式文书的写法渲染条、款、项', () => {
    expect(formatArticleCitation({ law: '专利法', article: 22 })).toBe('《专利法》第二十二条')
    expect(formatArticleCitation({ law: '专利法', article: 22, paragraph: 3 })).toBe('《专利法》第二十二条第三款')
    expect(formatArticleCitation({ law: '民法典', article: 102, paragraph: 2, item: 3 }))
      .toBe('《民法典》第一百零二条第二款第三项')
  })

  it('超出中文数字范围时保留阿拉伯数字', () => {
    expect(formatArticleCitation({ law: '专利法', article: 1000 })).toBe('《专利法》第1000条')
  })
})

describe('articleReferenceIdentity', () => {
  it('同一法条的两条引用得到相同标识', () => {
    expect(articleReferenceIdentity('专利法', 22, 3, 2)).toBe('article:专利法:22:3:2')
  })

  it('缺省款或项时该段留空，不同法条不会碰撞', () => {
    expect(articleReferenceIdentity('专利法', 22, undefined, undefined)).toBe('article:专利法:22::')
    expect(articleReferenceIdentity('专利法', 22, 3, undefined)).not.toBe(
      articleReferenceIdentity('专利法', 22, undefined, 3),
    )
  })
})
