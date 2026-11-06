import { describe, expect, it } from 'vitest'
import { readArticleContinuations } from '@deepseek-ai/dsh-law-core'
import type { ArticleCandidate } from '@deepseek-ai/dsh-law-core'

/** 基准引用：专利法第22条，end 指向扫描起点。 */
function base(text: string): ArticleCandidate<'专利法'> {
  return {
    start: 0,
    end: text.indexOf('条') + 1,
    reference: {
      kind: 'law-article',
      law: '专利法',
      article: 22,
      raw: '第22条',
    },
  }
}

describe('readArticleContinuations', () => {
  it('继承基准的法名并解析下一个条号', () => {
    const text = '专利法第22条、第23条'
    const candidates = readArticleContinuations(text, base(text), text.length)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.reference).toMatchObject({ law: '专利法', article: 23 })
    expect(candidates[0]?.reference.raw).toBe('第23条')
    expect(text.slice(candidates[0]!.start, candidates[0]!.end)).toBe('第23条')
  })

  it('链式续指继承前一个续指而非基准（第23条、第3款）', () => {
    const text = '专利法第22条、第23条第2款、第3款'
    const candidates = readArticleContinuations(text, base(text), text.length)
    expect(candidates.map(candidate => candidate.reference)).toEqual([
      { kind: 'law-article', law: '专利法', article: 23, paragraph: 2, raw: '第23条第2款' },
      { kind: 'law-article', law: '专利法', article: 23, paragraph: 3, raw: '第3款' },
    ])
  })

  it('续指必须带连接词，下一句的法条不会被并入', () => {
    const text = '专利法第22条。第23条'
    expect(readArticleContinuations(text, base(text), text.length)).toEqual([])
  })

  it('只在 limit 之前扫描，不越过下一个基准匹配', () => {
    const text = '专利法第22条、第23条'
    expect(readArticleContinuations(text, base(text), base(text).end)).toEqual([])
  })

  it('第（二）项 按项解析', () => {
    const text = '专利法第22条、第（二）项'
    const candidates = readArticleContinuations(text, base(text), text.length)
    expect(candidates[0]?.reference).toMatchObject({ article: 22, item: 2 })
    expect(candidates[0]?.reference.raw).toBe('第（二）项')
  })

  it('款在项之后出现时不算引用（收窄顺序只能是条→款→项）', () => {
    const text = '专利法第22条、第2项第3款'
    expect(readArticleContinuations(text, base(text), text.length)).toEqual([])
  })

  it('零号或畸形数字不产生引用', () => {
    const text = '专利法第22条、第〇条'
    expect(readArticleContinuations(text, base(text), text.length)).toEqual([])
  })
})
