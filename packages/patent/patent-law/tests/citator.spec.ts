import { describe, expect, it } from 'vitest'
import { decideValidity, queryValidity } from '../src/citator.ts'
import { loadLawBaselines } from '../src/baseline.ts'
import { verifyCitation } from '../src/verify.ts'
import type { LawBaseline, LawLineageSnapshot, LawName } from '../src/types.ts'
import {
  UNVERIFIED_ARTICLE_5,
  VERIFIED_ARTICLE_22,
  VERIFIED_SECTION,
  UNVERIFIED_SECTION,
  statuteBaseline as statute,
  guidelineBaseline as guideline,
  testBaselines as baselines,
} from './fixtures.ts'

describe('queryValidity — active', () => {
  it('returns active for a verified statute article', () => {
    const result = queryValidity({ provision: '专利法第22条第2款' }, baselines())
    expect(result.state).toBe('active')
    expect(result.reason).toContain('现行有效')
    expect(result.entry).toBeDefined()
    expect(result.reference.kind).toBe('law-article')
  })

  it('returns active for a verified guideline section not in staleSections', () => {
    // Use a section that is not a parent of any stale section.
    const index = new Map<LawName, LawBaseline>([
      ['专利法', statute()],
      ['专利法实施细则', statute({
        law: '专利法实施细则',
        maxArticle: null,
        maxVerifiedOn: null,
        articles: [UNVERIFIED_ARTICLE_5],
      })],
      ['专利审查指南', guideline({
        sections: [
          VERIFIED_SECTION,
          UNVERIFIED_SECTION,
          // A second verified section that is not stale and not a parent of stale.
          {
            path: '第一部分第一章4.2',
            topics: ['发明专利申请'],
            text: '发明专利申请的初步审查。',
            sourceDoc: '审查指南 2023',
            verifiedOn: '2026-01-01',
          },
        ],
      })],
    ])
    const result = queryValidity({ provision: '审查指南第一部分第一章4.2' }, index)
    expect(result.state).toBe('active')
    expect(result.reason).toContain('现行有效')
  })
})

describe('queryValidity — stale old paths', () => {
  it('returns unverified for a section in staleSections and marks the old path', () => {
    const result = queryValidity({ provision: '审查指南第二部分第四章3.2.1.1' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.stalePath).toBe(true)
    expect(result.reason).toContain('旧编号')
  })

  it('fails closed when supersededBy has no transcribed changes', () => {
    // Use a section that is not stale and not a parent of any stale section.
    const index = new Map<LawName, LawBaseline>([
      ['专利法', statute()],
      ['专利法实施细则', statute({
        law: '专利法实施细则',
        maxArticle: null,
        maxVerifiedOn: null,
        articles: [UNVERIFIED_ARTICLE_5],
      })],
      ['专利审查指南', {
        law: '专利审查指南',
        document: '专利审查指南',
        revision: '2023 年版',
        supersededBy: '2026 年修订版',
        staleSections: [],
        versions: [],
        maxArticle: null,
        maxVerifiedOn: null,
        maxSource: null,
        articles: [],
        sections: [
          {
            path: '第一部分第一章4.2',
            topics: ['发明专利申请'],
            text: '旧版正文',
            sourceDoc: '审查指南 2023',
            verifiedOn: '2026-01-01',
          },
        ],
      }],
    ])
    const result = queryValidity({ provision: '审查指南第一部分第一章4.2' }, index)
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('节修订记录')
  })
})

describe('queryValidity — unverified', () => {
  it('returns unverified for an article beyond a verified ceiling', () => {
    const result = queryValidity({ provision: '专利法第99条' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('共 82 条')
  })

  it('returns unverified for a paragraph the indexed article does not have', () => {
    const result = queryValidity({ provision: '专利法第22条第9款' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('共 3 款')
    expect(result.reason).toContain('不含第 9 款')
    const entry = result.entry
    expect(entry !== undefined && 'article' in entry ? entry.article : undefined).toBe(22)
  })

  it('returns unverified for an item the transcribed paragraph does not contain', () => {
    const article = { ...VERIFIED_ARTICLE_22 }
    delete article.paragraphs
    const index = new Map<LawName, LawBaseline>([['专利法', statute({
      articles: [{
        ...article,
        text: '申请人应当写明下列事项：\n（一）名称。',
      }],
    })]])
    const result = queryValidity({ provision: '专利法第22条第（二）项' }, index)
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('不含第 2 项')
  })

  it('keeps an article verifiable when the entry does not list its paragraphs', () => {
    const withoutParagraphs = { ...VERIFIED_ARTICLE_22 }
    delete withoutParagraphs.paragraphs
    const index = new Map<LawName, LawBaseline>([['专利法', statute({
      articles: [withoutParagraphs],
    })]])
    expect(queryValidity({ provision: '专利法第22条第9款' }, index).state).toBe('active')
  })

  it('returns unverified for a named revision the index does not carry', () => {
    const result = queryValidity({ provision: '审查指南第二部分第四章3.2', revision: '2025 年修订版' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('2025 年修订版')
  })

  it('returns unverified for an article not in the index', () => {
    const result = queryValidity({ provision: '专利法第78条' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('不在索引中')
  })

  it('returns unverified for a law not indexed', () => {
    const result = queryValidity({ provision: '专利法第22条' }, new Map<LawName, LawBaseline>())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('没有随包索引')
  })

  it('returns unverified for an unrecognised provision string', () => {
    const result = queryValidity({ provision: '这不是一个法条引用' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('无法将')
    expect(result.reason).toContain('解析')
  })

  it('returns unverified for an indexed article whose text is not transcribed', () => {
    const result = queryValidity({ provision: '专利法实施细则第5条' }, baselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('尚未转录核验')
  })

  it('returns unverified for a guideline section not in the index', () => {
    const result = queryValidity({ provision: '审查指南第三部分' }, baselines())
    expect(result.state).toBe('unverified')
  })
})

describe('decideValidity — direct reference API', () => {
  it('returns active for a verified article reference', () => {
    const ref = { kind: 'law-article' as const, law: '专利法' as const, article: 22, raw: '专利法第22条' }
    const result = decideValidity(ref, baselines())
    expect(result.state).toBe('active')
  })

  it('returns unverified for a stale guideline section reference', () => {
    const ref = { kind: 'guideline-section' as const, law: '专利审查指南' as const, path: '第二部分第四章3.2.1.1', raw: '审查指南第二部分第四章3.2.1.1' }
    const result = decideValidity(ref, baselines())
    expect(result.state).toBe('unverified')
    expect(result.stalePath).toBe(true)
    expect(result.reason).toContain('旧编号')
  })
})

describe('queryValidity — revision history', () => {
  it('reports revision history when versions exist', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利法', statute()],
      ['专利法实施细则', statute({
        law: '专利法实施细则',
        maxArticle: null,
        maxVerifiedOn: null,
        articles: [UNVERIFIED_ARTICLE_5],
      })],
      ['专利审查指南', guideline({
        versions: [{
          revision: '2026 年修订版（2026-01-01 施行）',
          sections: [{
            path: '第二部分第四章3.2.1.1',
            topics: ['技术启示（修订）'],
            text: '修订后正文',
            sourceDoc: '审查指南 2026',
            verifiedOn: '2026-01-01',
          }],
        }],
      })],
    ])
    // With a version override, the stale section is no longer stale, so it is
    // active and carries a revision history.
    const result = queryValidity({ provision: '审查指南第二部分第四章3.2.1.1' }, index)
    expect(result.state).toBe('active')
    expect(result.revisionHistory).toBeDefined()
    expect(result.revisionHistory).toHaveLength(1)
    expect(result.revisionHistory?.[0]?.effectiveDate).toBe('2026-01-01')
  })
})

describe('decideValidity — lineage narrowing', () => {
  const lineage: LawLineageSnapshot = {
    law: '专利法',
    document: '中华人民共和国专利法',
    lineageVersion: '1.0.0',
    revisions: [],
    articles: [{
      articleId: 22,
      title: null,
      currentStatus: 'active',
      revisionHistory: [{
        revision: '2020-amendment',
        effectiveDate: '2021-06-01',
        text: null,
        changed: false,
      }],
    }],
  }

  it('does not let an active lineage record vouch for a paragraph the article lacks', () => {
    const result = decideValidity(
      { kind: 'law-article', law: '专利法', article: 22, paragraph: 9, raw: '专利法第22条第9款' },
      baselines(),
      {},
      lineage,
    )
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('不含第 9 款')
    expect(result.revisionHistory).toHaveLength(1)
  })

  it('does not read items from an article the lineage record has not transcribed', () => {
    const index = new Map<LawName, LawBaseline>([['专利法', statute({
      articles: [{ ...VERIFIED_ARTICLE_22, text: null, sourceDoc: null, verifiedOn: null }],
    })]])
    const result = decideValidity(
      { kind: 'law-article', law: '专利法', article: 22, item: 2, raw: '专利法第22条第2项' },
      index,
      {},
      lineage,
    )
    expect(result.state).toBe('active')
  })

  it('keeps an existing paragraph active through the lineage record', () => {
    const result = decideValidity(
      { kind: 'law-article', law: '专利法', article: 22, paragraph: 2, raw: '专利法第22条第2款' },
      baselines(),
      {},
      lineage,
    )
    expect(result.state).toBe('active')
    expect(result.reason).toContain('沿革数据确认现行有效')
  })
})

describe('2026 年指南修订的效力口径（随包资产）', () => {
  const index = loadLawBaselines()
  const section = (path: string) => ({
    kind: 'guideline-section' as const,
    law: '专利审查指南' as const,
    path,
    raw: `审查指南${path}`,
  })

  it('未修改的创造性三步法节判现行有效，与引用核验一致', () => {
    const path = '第二部分第四章3.2.1.1'
    const validity = queryValidity({ provision: `审查指南${path}` }, index)
    expect(validity.state).toBe('active')
    expect(verifyCitation(section(path), index).decision).toBe('valid')
  })

  it('2026 年修改的节用新文本核验，两边都判有效', () => {
    const path = '第二部分第四章6.4'
    const validity = queryValidity({ provision: `审查指南${path}` }, index)
    expect(validity.state).toBe('active')
    expect(verifyCitation(section(path), index).decision).toBe('valid')
  })

  it('改号后的旧路径：编号被新节复用时判新节，未复用时仍为未核验', () => {
    const baseline = index.get('专利审查指南')
    const stale = baseline?.staleSections.map(entry => entry.path) ?? []
    const reused = new Set((baseline?.versions ?? []).flatMap(version =>
      version.sections.map(section => section.path)))
    expect(stale).toHaveLength(6)
    const unresolved = stale.filter(path => !reused.has(path))
    expect(unresolved.length).toBeGreaterThan(0)
    for (const path of stale) {
      const validity = queryValidity({ provision: `审查指南${path}` }, index)
      if (reused.has(path)) {
        // 该编号在 2026 年版指向新增或改号后的节，引用按新文本核验。
        expect(validity.state, path).toBe('active')
        continue
      }
      expect(validity.state, path).toBe('unverified')
      expect(validity.stalePath, path).toBe(true)
      expect(verifyCitation(section(path), index).decision, path).toBe('unverified')
    }
  })
})
