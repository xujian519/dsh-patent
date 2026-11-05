import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LawLineageError,
  parseLawLineage,
  queryArticleAtDate,
  queryArticleLineage,
  queryDiffBetween,
  queryStatusSnapshot,
} from '../src/lineage.ts'
import { decideValidity, queryValidity } from '../src/citator.ts'
import type { LawLineageSnapshot, LawName } from '../src/types.ts'
import { statuteBaseline, guidelineBaseline, testBaselines } from './fixtures.ts'

const ASSET_DIR = join(import.meta.dirname, '..', 'assets', 'lineage')

/** Load the shipped lineage asset for integration tests. */
function loadShippedLineage(): LawLineageSnapshot {
  return parseLawLineage(
    readFileSync(join(ASSET_DIR, 'cn-patent-law-lineage.yaml'), 'utf8'),
    join(ASSET_DIR, 'cn-patent-law-lineage.yaml'),
  )
}

/** A minimal two-revision lineage for unit tests. */
function twoRevisionLineage(): LawLineageSnapshot {
  return {
    law: '专利法',
    document: '中华人民共和国专利法',
    lineageVersion: '1.0.0',
    revisions: [
      { id: '2008-amendment', label: '2008 年第三次修正', effectiveDate: '2009-10-01', source: '第十一届全国人大常委会第四次会议' },
      { id: '2020-amendment', label: '2020 年第四次修正', effectiveDate: '2021-06-01', source: '第十三届全国人大常委会第二十二次会议' },
    ],
    articles: [
      {
        articleId: 22,
        title: '新颖性创造性实用性',
        currentStatus: 'active',
        revisionHistory: [
          { revision: '2008-amendment', effectiveDate: '2009-10-01', text: '旧版新颖性条款', changed: false },
          { revision: '2020-amendment', effectiveDate: '2021-06-01', text: '新版新颖性条款', changed: true },
        ],
      },
      {
        articleId: 67,
        title: '现有技术抗辩',
        currentStatus: 'active',
        revisionHistory: [
          { revision: '2008-amendment', effectiveDate: '2009-10-01', text: null, changed: false },
          { revision: '2020-amendment', effectiveDate: '2021-06-01', text: null, changed: true },
        ],
      },
      {
        articleId: 99,
        title: '已废止条款',
        currentStatus: 'repealed',
        revisionHistory: [
          { revision: '2008-amendment', effectiveDate: '2009-10-01', text: '旧条文', changed: false },
          { revision: '2020-amendment', effectiveDate: '2021-06-01', text: null, changed: false },
        ],
      },
    ],
  }
}

describe('parseLawLineage — shipped asset', () => {
  it('loads the cn-patent-law-lineage.yaml without error', () => {
    const snapshot = loadShippedLineage()
    expect(snapshot.law).toBe('专利法')
    expect(snapshot.document).toBe('中华人民共和国专利法')
    expect(snapshot.lineageVersion).toBe('1.0.0')
    expect(snapshot.revisions).toHaveLength(5)
    expect(snapshot.revisions[0]?.id).toBe('1984-original')
    expect(snapshot.articles.length).toBeGreaterThan(0)
  })

  it('records every history revision in the catalogue, with its date, in order', () => {
    const snapshot = loadShippedLineage()
    const revisions = new Map(snapshot.revisions.map(entry => [entry.id, entry]))
    for (const article of snapshot.articles) {
      const dates = article.revisionHistory.map(entry => entry.effectiveDate)
      expect(dates, `第${article.articleId}条`).toEqual([...dates].sort())
      for (const entry of article.revisionHistory) {
        const declared = revisions.get(entry.revision)
        expect(declared, `第${article.articleId}条：${entry.revision}`).toBeDefined()
        expect(entry.effectiveDate, `第${article.articleId}条：${entry.revision}`).toBe(declared?.effectiveDate)
      }
    }
  })

  it('rejects malformed YAML', () => {
    expect(() => parseLawLineage('not: [valid: yaml: {', 'test.yaml')).toThrow(LawLineageError)
  })

  it('rejects unknown law name', () => {
    expect(() => parseLawLineage(`
law: 未知法律
document: test
lineageVersion: "1.0.0"
revisions:
  - id: "v1"
    label: "v1"
    effectiveDate: "2021-01-01"
    source: "test"
articles:
  - articleId: 1
    title: null
    currentStatus: active
    revisionHistory:
      - revision: "v1"
        effectiveDate: "2021-01-01"
        text: null
        changed: false
`, 'test.yaml')).toThrow(LawLineageError)
  })
})

describe('queryArticleLineage', () => {
  it('returns the lineage for an existing article', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleLineage(lineage, 22)
    expect(result).not.toBeNull()
    expect(result?.articleId).toBe(22)
    expect(result?.currentStatus).toBe('active')
    expect(result?.revisionHistory).toHaveLength(2)
  })

  it('returns null for a non-existent article', () => {
    const lineage = twoRevisionLineage()
    expect(queryArticleLineage(lineage, 999)).toBeNull()
  })

  it('returns the correct status for a repealed article', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleLineage(lineage, 99)
    expect(result?.currentStatus).toBe('repealed')
  })
})

describe('queryArticleAtDate', () => {
  it('returns the revision effective at a given date', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleAtDate(lineage, 22, '2010-01-01')
    expect(result).not.toBeNull()
    expect(result?.revision).toBe('2008-amendment')
  })

  it('returns the latest revision when date is after all effective dates', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleAtDate(lineage, 22, '2025-01-01')
    expect(result?.revision).toBe('2020-amendment')
  })

  it('returns null when date is before all revisions', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleAtDate(lineage, 22, '2008-01-01')
    expect(result).toBeNull()
  })

  it('returns null for a non-existent article', () => {
    const lineage = twoRevisionLineage()
    expect(queryArticleAtDate(lineage, 999, '2025-01-01')).toBeNull()
  })

  it('returns the exact revision on the effective date', () => {
    const lineage = twoRevisionLineage()
    const result = queryArticleAtDate(lineage, 22, '2021-06-01')
    expect(result?.revision).toBe('2020-amendment')
  })
})

describe('queryStatusSnapshot', () => {
  it('counts status distribution without date', () => {
    const lineage = twoRevisionLineage()
    const counts = queryStatusSnapshot(lineage)
    expect(counts.active).toBe(2)
    expect(counts.repealed).toBe(1)
    expect(counts.revised).toBe(0)
    expect(counts.unverified).toBe(0)
  })

  it('counts status distribution with a date', () => {
    const lineage = twoRevisionLineage()
    const counts = queryStatusSnapshot(lineage, '2025-01-01')
    // All three articles have revisions effective by 2025.
    expect(counts.active).toBe(2)
    expect(counts.repealed).toBe(1)
  })

  it('excludes articles with no effective revision at the date', () => {
    const lineage = twoRevisionLineage()
    const counts = queryStatusSnapshot(lineage, '2008-01-01')
    // No revisions are effective by 2008-01-01.
    expect(counts.active).toBe(0)
    expect(counts.repealed).toBe(0)
  })
})

describe('queryDiffBetween', () => {
  it('returns articles changed between two revisions', () => {
    const lineage = twoRevisionLineage()
    const changed = queryDiffBetween(lineage, '2008-amendment', '2020-amendment')
    expect(changed).toHaveLength(2)
    expect(changed.map(a => a.articleId).sort((a, b) => a - b)).toEqual([22, 67])
  })

  it('returns empty when from >= to', () => {
    const lineage = twoRevisionLineage()
    expect(queryDiffBetween(lineage, '2020-amendment', '2008-amendment')).toHaveLength(0)
  })

  it('returns empty for unknown revision ids', () => {
    const lineage = twoRevisionLineage()
    expect(queryDiffBetween(lineage, 'unknown', '2020-amendment')).toHaveLength(0)
  })
})

describe('citator integration with lineage', () => {
  it('overrides status from lineage when provided', () => {
    // Article 99 is beyond the baseline ceiling, so it is out-of-range before
    // lineage is consulted. Use a custom baseline that indexes article 99 as
    // unverified, so the lineage check is reached.
    const customBaselines = new Map<LawName, import('../src/types.ts').LawBaseline>([
      ['专利法', statuteBaseline({
        maxArticle: 100,
        maxVerifiedOn: '2026-01-01',
        articles: [{ article: 99, topics: ['test'], text: null, sourceDoc: null, verifiedOn: null }],
      })],
      ['专利法实施细则', statuteBaseline({
        law: '专利法实施细则',
        maxArticle: null,
        maxVerifiedOn: null,
        articles: [{ article: 5, topics: ['期限'], text: null, sourceDoc: null, verifiedOn: null }],
      })],
      ['专利审查指南', guidelineBaseline()],
    ])
    const lineage = twoRevisionLineage()
    const result = queryValidity(
      { provision: '专利法第99条' },
      customBaselines,
      lineage,
    )
    expect(result.state).toBe('repealed')
    expect(result.reason).toContain('沿革数据确认已被废止')
    expect(result.revisionHistory).toHaveLength(2)
  })

  it('reports revision history from lineage', () => {
    const baselines = testBaselines()
    const lineage = twoRevisionLineage()
    const ref = { kind: 'law-article' as const, law: '专利法' as const, article: 22, raw: '专利法第22条' }
    const result = decideValidity(ref, baselines, {}, lineage)
    expect(result.state).toBe('active')
    expect(result.revisionHistory).toBeDefined()
    expect(result.revisionHistory).toHaveLength(2)
    expect(result.revisionHistory?.[0]?.revision).toBe('2008-amendment')
    expect(result.revisionHistory?.[1]?.revision).toBe('2020-amendment')
  })

  it('falls through to baseline when article not in lineage', () => {
    const baselines = testBaselines()
    const lineage = twoRevisionLineage()
    // Article 5 is in the baseline but not in the two-revision lineage.
    const result = queryValidity(
      { provision: '专利法第5条' },
      baselines,
      lineage,
    )
    // Should use the baseline result (unverified since text is null).
    expect(result.state).toBe('unverified')
  })

  it('works without lineage (backward compatible)', () => {
    const baselines = testBaselines()
    const result = queryValidity({ provision: '专利法第22条' }, baselines)
    expect(result.state).toBe('active')
    expect(result.revisionHistory).toBeUndefined()
  })

  it('loads and queries the shipped lineage asset', () => {
    const snapshot = loadShippedLineage()
    const article = queryArticleLineage(snapshot, 67)
    expect(article).not.toBeNull()
    expect(article?.title).toBe('现有技术抗辩')
    expect(article?.currentStatus).toBe('unverified')
    expect(article?.revisionHistory).toHaveLength(5)
    expect(article?.revisionHistory[0]?.revision).toBe('1984-original')
  })
})
