import { describe, expect, it } from 'vitest'
import { readStatuteArticleCandidate, scanUnrecognizedReferences } from '@deepseek-ai/dsh-law-core'

function matchOf(text: string): RegExpExecArray {
  const match = /[\s\S]+/.exec(text)
  if (match === null) throw new Error('expected a match')
  return match
}

describe('readStatuteArticleCandidate', () => {
  it('接受可解析的条、款、项', () => {
    expect(readStatuteArticleCandidate(matchOf('专利法第22条第3款第（二）项'), {
      article: '22',
      paragraph: '3',
      itemParen: '二',
    }, '专利法')?.reference).toMatchObject({ article: 22, paragraph: 3, item: 2 })
  })

  it('条号不可解析时拒绝整条引用', () => {
    expect(readStatuteArticleCandidate(matchOf('专利法第十十条'), { article: '十十' }, '专利法')).toBeNull()
  })

  it('款或项不可解析时拒绝整条引用，而不是降级为更宽的条', () => {
    expect(readStatuteArticleCandidate(matchOf('专利法第22条第十十款'), {
      article: '22',
      paragraph: '十十',
    }, '专利法')).toBeNull()
    expect(readStatuteArticleCandidate(matchOf('专利法第22条第3款第十十项'), {
      article: '22',
      paragraph: '3',
      item: '十十',
    }, '专利法')).toBeNull()
    expect(readStatuteArticleCandidate(matchOf('专利法第22条第3款第（十十）项'), {
      article: '22',
      paragraph: '3',
      itemParen: '十十',
    }, '专利法')).toBeNull()
  })
})

describe('scanUnrecognizedReferences', () => {
  const pattern = () => /第\d+条/g

  it('略去落在已识别引用里面的片段，包括书名号后的条号', () => {
    expect(scanUnrecognizedReferences('《专利法》第22条，另见第99条', [{ raw: '专利法第22条' }], pattern()))
      .toEqual(['第99条'])
  })

  it('同一条号出现在已识别引用之外时仍然列出', () => {
    expect(scanUnrecognizedReferences(
      '第22条第3款。另见第22条第十十款',
      [{ raw: '第22条第3款' }],
      pattern(),
    )).toEqual(['第22条'])
  })

  it('重复出现的已识别引用每一处都盖住', () => {
    expect(scanUnrecognizedReferences('第22条。第22条。', [{ raw: '第22条' }], pattern())).toEqual([])
  })
})
