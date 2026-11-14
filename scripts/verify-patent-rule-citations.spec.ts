import { describe, expect, it } from 'vitest'
import { checkPackagedRuleCitations, suggestBasisKind } from './verify-patent-rule-citations.ts'

describe('suggestBasisKind', () => {
  it('classifies a statute, a guideline, a judgment, and a practice note', () => {
    expect(suggestBasisKind('专利法第二十二条第三款')).toBe('statute')
    expect(suggestBasisKind('专利审查指南第二部分第四章3.2.1.1')).toBe('guideline')
    expect(suggestBasisKind('（2023）最高法知民终844号')).toBe('judgment')
    expect(suggestBasisKind('执业规范：AI 输出不构成正式法律意见')).toBe('practice-note')
    expect(suggestBasisKind(undefined)).toBe('practice-note')
  })

  it('prefers a statute citation over a case number in the same basis', () => {
    expect(suggestBasisKind('专利法第七十一条第一款；司法实践总结（2022）最高法知民终2920号')).toBe('statute')
  })
})

describe('packaged rule citations', () => {
  it('accepts every shipped rule', () => {
    expect(checkPackagedRuleCitations()).toEqual([])
  })
})
