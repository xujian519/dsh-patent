import { describe, expect, it } from 'vitest'
import { createOverlapIndex, textOverlap, topicOverlap } from '@deepseek-ai/dsh-law-core'
import type { ComparableEntry } from '@deepseek-ai/dsh-law-core'

describe('createOverlapIndex', () => {
  it('只统计已转录的条目，空索引没有文档', () => {
    const entries: ComparableEntry[] = [
      { label: '第1条', topics: [], text: '甲乙' },
      { label: '第2条', topics: [], text: null },
    ]
    const index = createOverlapIndex(entries)
    expect(index.documents).toBe(1)
    expect(index.texts.size).toBe(1)
    expect(createOverlapIndex([]).documents).toBe(0)
  })
})

describe('textOverlap', () => {
  it('空命题得 0 分', () => {
    const index = createOverlapIndex([{ label: '第1条', topics: [], text: '甲乙' }])
    expect(textOverlap(index, '  ', '甲乙')).toBe(0)
  })

  it('原文完全相同得 1 分，忽略标点与全角差异', () => {
    const index = createOverlapIndex([{ label: '第1条', topics: [], text: '国务院专利行政部门' }])
    expect(textOverlap(index, '国务院专利行政部门', '国务院专利行政部门')).toBe(1)
    expect(textOverlap(index, '国务院，专利行政部门。', '国务院 专利行政部门')).toBe(1)
  })

  it('无关文本得 0 分', () => {
    const index = createOverlapIndex([{ label: '第1条', topics: [], text: '甲乙' }])
    expect(textOverlap(index, '丙丁', '戊己')).toBe(0)
  })

  it('命中基线中更常见的字符对权重更低', () => {
    // “甲乙”只在一条条目出现，“乙丙”在两条条目出现：同样的命中，
    // 少见字符对携带的信息更多，得分应更高。
    const entries: ComparableEntry[] = [
      { label: 'A', topics: [], text: '甲乙' },
      { label: 'B', topics: [], text: '乙丙' },
      { label: 'C', topics: [], text: '乙丙' },
    ]
    const index = createOverlapIndex(entries)
    const rare = textOverlap(index, '甲乙丙', '甲乙')
    const common = textOverlap(index, '甲乙丙', '乙丙')
    expect(rare).toBeGreaterThan(common)
  })
})

describe('topicOverlap', () => {
  it('主题词出现在命题中即命中', () => {
    expect(topicOverlap(['创造性'], '本发明具备创造性')).toBe(true)
  })

  it('命题是主题词的子串也命中', () => {
    expect(topicOverlap(['发明所要解决的技术问题'], '技术问题')).toBe(true)
  })

  it('空命题或空主题列表不命中', () => {
    expect(topicOverlap(['创造性'], '  ')).toBe(false)
    expect(topicOverlap([], '创造性')).toBe(false)
  })
})
