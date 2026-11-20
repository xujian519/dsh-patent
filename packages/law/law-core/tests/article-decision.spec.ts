/**
 * The competing-home rule: what evidence makes another entry the proposition's
 * home, and what evidence is too weak to accuse a correct citation.
 */
import { describe, expect, it } from 'vitest'
import {
  createOverlapIndex,
  decideArticleCitation,
  findCompetingEntries,
  supportMismatchReason,
  type ComparableEntry,
  type DecisionArticle,
  type OverlapIndex,
} from '../src/index.ts'

/** Build one comparable entry. */
function entry(label: string, topics: string[], text: string | null): ComparableEntry {
  return { label, topics, text }
}

/** Index a set of entries the way the decision indexes a baseline. */
function indexOf(entries: readonly ComparableEntry[]): OverlapIndex {
  return createOverlapIndex(entries)
}

describe('findCompetingEntries', () => {
  it('orders text carriers by the share of the proposition they carry', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', [], '甲乙丙'),
      entry('第 3 条', [], '甲乙丙丁'),
    ]
    const carriers = findCompetingEntries(entries, indexOf(entries), '甲乙丙丁', 0.5, '第 1 条')
    expect(carriers.map(carrier => carrier.label)).toEqual(['第 3 条', '第 2 条'])
    expect(carriers.map(carrier => carrier.textBacked)).toEqual([true, true])
    expect(carriers[1]?.evidence).toContain('字面重合 57%')
  })

  it('quotes the carrying sentence, not the opening sentence', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', [], '第一句无关。第二句提到目标主题。'),
    ]
    const [carrier] = findCompetingEntries(entries, indexOf(entries), '目标主题', 0.75, '第 1 条')
    expect(carrier?.evidence).toContain('第二句提到目标主题')
    expect(carrier?.evidence).not.toContain('第一句无关')
  })

  it('keeps a cross-sentence match on one line', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', [], '甲乙。\n\n丙丁'),
    ]
    const [carrier] = findCompetingEntries(entries, indexOf(entries), '乙丙', 0.75, '第 1 条')
    expect(carrier?.textBacked).toBe(true)
    expect(carrier?.evidence).toContain('甲乙。 丙丁')
    expect(carrier?.evidence).not.toContain('\n')
  })

  it('reports a topic that names the claim, with its text when it has one', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', ['分案申请'], '原申请不得改变类别。'),
      entry('第 3 条', ['复审请求书的撰写'], null),
    ]
    const carriers = findCompetingEntries(entries, indexOf(entries), '分案申请；复审请求书的撰写', 0.75, '第 1 条')
    expect(carriers.map(carrier => carrier.label)).toEqual(['第 3 条', '第 2 条'])
    expect(carriers[0]?.evidence).toBe('主题词「复审请求书的撰写」')
    expect(carriers[1]?.evidence).toContain('主题词「分案申请」；原文「')
    expect(carriers.every(carrier => !carrier.textBacked)).toBe(true)
  })

  it('accepts a topic that contains the whole claim', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', ['创造性判断方法'], null),
    ]
    expect(findCompetingEntries(entries, indexOf(entries), '创造性', 0.75, '第 1 条'))
      .toEqual([{ label: '第 2 条', textBacked: false, evidence: '主题词「创造性判断方法」' }])
  })

  it('rejects a topic that is only a shared word inside a longer claim', () => {
    const entries = [
      entry('第 1 条', [], null),
      entry('第 2 条', ['申请日'], '申请日另有定义。'),
    ]
    // 申请日 在 24 字命题里只占八分之一，不能据此指认第 2 条更贴近。
    expect(findCompetingEntries(entries, indexOf(entries), '申请人主动修改申请文件的时机为自申请日起2个月内', 0.75, '第 1 条'))
      .toEqual([])
  })

  it('reports no competing entry for a blank proposition', () => {
    const entries = [entry('第 1 条', [], null), entry('第 2 条', ['目标主题'], '目标主题正文')]
    expect(findCompetingEntries(entries, indexOf(entries), '   ', 0.75, '第 1 条')).toEqual([])
  })

  it('skips the cited entry and the labels the citation already covers', () => {
    const entries = [
      entry('第 1 条', ['目标主题'], null),
      entry('第 2 条', [], '目标主题正文'),
    ]
    expect(findCompetingEntries(entries, indexOf(entries), '目标主题', 0.75, '第 1 条', label => label === '第 2 条'))
      .toEqual([])
  })
})

describe('supportMismatchReason', () => {
  it('names every carrier with the evidence that makes it a home', () => {
    const reason = supportMismatchReason('专利法', '目标主题', [
      { label: '第 2 条', textBacked: true, evidence: '原文「目标主题」；字面重合 100%' },
      { label: '第 3 条', textBacked: false, evidence: '主题词「目标」' },
    ])
    expect(reason).toContain('《专利法》第 2 条（原文「目标主题」；字面重合 100%）、第 3 条（主题词「目标」）')
    expect(reason).toContain('更贴近命题「目标主题」')
  })
})

describe('narrowed citations', () => {
  const articles: DecisionArticle[] = [
    {
      article: 1,
      paragraphs: [1, 2],
      topics: [],
      text: '第一款写申请日。\n第二款写优先权。',
      sourceDoc: 'fixture',
      verifiedOn: '2026-01-01',
    },
    {
      article: 2,
      topics: ['主动修改'],
      text: '申请人可以提出请求。',
      sourceDoc: 'fixture',
      verifiedOn: '2026-01-01',
    },
    {
      article: 3,
      topics: [],
      text: '国务院专利行政部门应当更正错误。',
      sourceDoc: 'fixture',
      verifiedOn: '2026-01-01',
    },
  ]
  const baseline = { law: '专利法', maxArticle: 3, maxVerifiedOn: '2026-01-01', articles }
  const reference = { article: 1, paragraph: 1 }

  it('is not contradicted by another entry topic alone', () => {
    const verdict = decideArticleCitation(reference, baseline, articles[0], { proposition: '主动修改' })
    expect(verdict.decision).toBe('unmatched')
  })

  it('is contradicted by another entry whose transcribed text carries the claim', () => {
    const verdict = decideArticleCitation(reference, baseline, articles[0], {
      proposition: '国务院专利行政部门应当更正错误',
    })
    expect(verdict.decision).toBe('mismatch')
    expect(verdict.reason).toContain('第 3 条')
  })
})
