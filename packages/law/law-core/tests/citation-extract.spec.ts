import { describe, expect, it } from 'vitest'
import { readStatuteArticleCandidate } from '@deepseek-ai/dsh-law-core'

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
