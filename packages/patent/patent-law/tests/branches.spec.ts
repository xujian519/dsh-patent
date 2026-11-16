/** Remaining decision branches of the lineage loader, citator, rule-lock, and verification. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideValidity, queryValidity } from '../src/citator.ts'
import {
  LawLineageError,
  loadLawLineageFile,
  parseLawLineage,
  queryStatusSnapshot,
} from '../src/lineage.ts'
import {
  DEFAULT_RULE_LOCK_PROVISIONS_KEY,
  lockProvisions,
  renderRuleLockReport,
  RuleLockHandler,
  type RuleLockEntry,
} from '../src/rule-lock.ts'
import { verifyCitation } from '../src/verify.ts'
import type { LawBaseline, LawLineageSnapshot, LawName, ValidityState } from '../src/types.ts'
import {
  guidelineBaseline as guideline,
  statuteBaseline as statute,
  testBaselines,
} from './fixtures.ts'

const HEADER = [
  'law: 专利法',
  'document: 中华人民共和国专利法',
  'lineageVersion: "1.0.0"',
  'revisions:',
  '  - id: "v1"',
  '    label: "2021 修正"',
  '    effectiveDate: "2021-06-01"',
  '    source: "test"',
  'articles:',
  '  - articleId: 22',
  '    title: null',
  '    currentStatus: active',
  '    revisionHistory:',
  '      - revision: "v1"',
  '        effectiveDate: "2021-06-01"',
  '        text: null',
  '        changed: false',
  '        source: "test"',
].join('\n')

/** Replace one line of the valid lineage fixture. */
function lineageWith(find: string | RegExp, replace: string): string {
  return HEADER.replace(find, replace)
}

/** Replace the whole articles section. */
function withoutArticles(value: string): string {
  return `${HEADER.slice(0, HEADER.indexOf('\narticles:'))}\narticles: ${value}`
}

/** Replace the whole revisionHistory section. */
function withoutHistory(value: string): string {
  return `${HEADER.slice(0, HEADER.indexOf('    revisionHistory:'))}    revisionHistory: ${value}`
}

/** A lineage snapshot with arbitrary article statuses. */
function lineage(statuses: Array<[number, ValidityState]>, versions: LawLineageSnapshot['revisions'] = []): LawLineageSnapshot {
  return {
    law: '专利法',
    document: '中华人民共和国专利法',
    lineageVersion: '1.0.0',
    revisions: versions,
    articles: statuses.map(([articleId, currentStatus]) => ({
      articleId,
      title: null,
      currentStatus,
      revisionHistory: [{
        revision: versions[0]?.id ?? 'v1',
        effectiveDate: versions[0]?.effectiveDate ?? '2021-06-01',
        text: null,
        changed: true,
      }],
    })),
  }
}

describe('lineage loader', () => {
  it('loads a lineage snapshot from a file', () => {
    const path = join(import.meta.dirname, '..', 'assets', 'lineage', 'cn-patent-law-lineage.yaml')
    const snapshot = loadLawLineageFile(path)
    expect(snapshot.law).toBe('专利法')
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
  })

  it('rejects a missing or empty revisions array', () => {
    expect(() => parseLawLineage(lineageWith(/revisions:\n(?:.*\n)*?articles:/u, 'revisions: []\narticles:'), 'x.yaml'))
      .toThrow('字段 revisions 必须是非空数组')
    expect(() => parseLawLineage(HEADER.replace('revisions:\n', 'revisions: nope\n'), 'x.yaml'))
      .toThrow(LawLineageError)
  })

  it('rejects a duplicate revision id', () => {
    const source = HEADER.replace(
      '  - id: "v1"',
      '  - id: "v1"',
    ).replace(
      '    source: "test"\narticles:',
      '    source: "test"\n  - id: "v1"\n    label: "dup"\n    effectiveDate: "2022-01-01"\n    source: "test"\narticles:',
    )
    expect(() => parseLawLineage(source, 'x.yaml')).toThrow('revisions 的 id 重复：v1')
  })

  it('rejects a malformed revision date', () => {
    expect(() => parseLawLineage(lineageWith('effectiveDate: "2021-06-01"\n    source', 'effectiveDate: "2021/06/01"\n    source'), 'x.yaml'))
      .toThrow('revisions[v1].effectiveDate 必须是 YYYY-MM-DD 格式')
  })

  it('rejects missing or empty articles', () => {
    expect(() => parseLawLineage(withoutArticles('[]'), 'x.yaml'))
      .toThrow('字段 articles 必须是非空数组')
    expect(() => parseLawLineage(withoutArticles('nope'), 'x.yaml'))
      .toThrow('字段 articles 必须是非空数组')
  })

  it('rejects duplicate article ids', () => {
    const article = [
      '  - articleId: 22',
      '    title: null',
      '    currentStatus: active',
      '    revisionHistory:',
      '      - revision: "v1"',
      '        effectiveDate: "2021-06-01"',
      '        text: null',
      '        changed: false',
    ].join('\n')
    expect(() => parseLawLineage(`${HEADER}\n${article}`, 'x.yaml'))
      .toThrow('articles 的 articleId 重复：22')
  })

  it('rejects invalid article ids, statuses, and histories', () => {
    expect(() => parseLawLineage(lineageWith('articleId: 22', 'articleId: 0'), 'x.yaml'))
      .toThrow('articleId 必须是正整数')
    expect(() => parseLawLineage(lineageWith('currentStatus: active', 'currentStatus: stale'), 'x.yaml'))
      .toThrow('currentStatus 必须是 active/revised/repealed/unverified 之一')
    expect(() => parseLawLineage(withoutHistory('none'), 'x.yaml'))
      .toThrow('revisionHistory 必须是数组')
    expect(() => parseLawLineage(lineageWith('effectiveDate: "2021-06-01"\n        text', 'effectiveDate: "2021/06/01"\n        text'), 'x.yaml'))
      .toThrow('revisionHistory[0].effectiveDate 必须是 YYYY-MM-DD')
    expect(() => parseLawLineage(lineageWith('changed: false', 'changed: null'), 'x.yaml'))
      .toThrow('changed 必须声明')
    expect(() => parseLawLineage(withoutHistory('[]'), 'x.yaml'))
      .toThrow('revisionHistory 必须至少有一条记录')
  })

  it('omits a revision source that the asset does not declare', () => {
    const snapshot = parseLawLineage(lineageWith('        source: "test"', '        source: null'), 'x.yaml')
    expect(snapshot.articles[0]?.revisionHistory[0]).not.toHaveProperty('source')
  })

  it('counts only statuses with an effective revision at the date', () => {
    const snapshot = lineage([[22, 'active']], [{
      id: 'v1', label: 'v1', effectiveDate: '2021-06-01', source: 'test',
    }])
    expect(queryStatusSnapshot(snapshot, '2020-01-01')).toEqual({
      active: 0, revised: 0, repealed: 0, unverified: 0,
    })
  })
})

describe('citator branches', () => {
  it('reports an out-of-range article under an unverified ceiling', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利法', statute({ maxArticle: 10, maxVerifiedOn: null, articles: [] })],
    ])
    const result = queryValidity({ provision: '专利法第22条' }, index)
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('上限本身尚未核验')
  })

  it('reports a stale section that is not indexed', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利审查指南', guideline({
        sections: [],
        staleSections: [{ path: '第二部分第四章3.2.1.1', reason: '修订' }],
      })],
    ])
    const result = queryValidity({ provision: '审查指南第二部分第四章3.2.1.1' }, index)
    expect(result.state).toBe('unverified')
    expect(result.stalePath).toBe(true)
    expect(result.entry).toBeUndefined()
  })

  it('reports a superseded section that is not indexed', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利审查指南', guideline({
        sections: [],
        staleSections: [],
        supersededBy: '2026 年修订版',
      })],
    ])
    const result = queryValidity({ provision: '审查指南第一部分第一章4.2' }, index)
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('节修订记录')
    expect(result.entry).toBeUndefined()
  })

  it('reports an indexed guideline section that is not transcribed', () => {
    const result = queryValidity({ provision: '审查指南第五部分第七章2.1' }, testBaselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('正文尚未转录核验')
  })

  it('keeps an unmodified section active when a version covers other sections', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利审查指南', guideline({
        staleSections: [],
        supersededBy: '2026 年修订版',
        sections: [{
          path: '第一部分第一章4.2', topics: ['发明'], text: '旧版正文',
          sourceDoc: '审查指南 2023', verifiedOn: '2023-01-01',
        }],
        versions: [{
          revision: '2026 年修订版',
          sections: [{
            path: '第二部分第九章1.1', topics: ['其他'], text: '其他正文',
            sourceDoc: '审查指南 2026', verifiedOn: '2026-01-01',
          }],
        }],
      })],
    ])
    const result = queryValidity({ provision: '审查指南第一部分第一章4.2' }, index)
    expect(result.state).toBe('active')
    expect(result.reason).toContain('现行有效')
  })

  it('reports a parsed guideline section that is not indexed', () => {
    const result = queryValidity({ provision: '审查指南第一部分第一章9.9' }, testBaselines())
    expect(result.state).toBe('unverified')
    expect(result.reason).toContain('不在索引中')
  })

  it('applies a version whose revision matches supersededBy', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利审查指南', guideline({
        revision: '2023 年版',
        supersededBy: '2026 年修订版（2026-01-01 施行）',
        staleSections: [],
        versions: [{
          revision: '2026 年修订版（2026-01-01 施行）',
          sections: [{
            path: '第一部分第一章4.2', topics: ['发明'], text: '新版正文',
            sourceDoc: '审查指南 2026', verifiedOn: '2026-01-01',
          }],
        }],
        sections: [{
          path: '第一部分第一章4.2', topics: ['发明'], text: '旧版正文',
          sourceDoc: '审查指南 2023', verifiedOn: '2023-01-01',
        }],
      })],
    ])
    const result = queryValidity({ provision: '审查指南第一部分第一章4.2' }, index)
    expect(result.state).toBe('active')
    expect(result.revisionHistory?.[0]?.effectiveDate).toBe('2026-01-01')
  })

  it('keeps the baseline when a named revision is unknown', () => {
    const baseline = guideline({
      versions: [{
        revision: '2026 年修订版',
        sections: [{
          path: '第一部分第一章4.2', topics: ['发明'], text: '新版正文',
          sourceDoc: '审查指南 2026', verifiedOn: '2026-01-01',
        }],
      }],
    })
    const result = decideValidity(
      { kind: 'guideline-section', law: '专利审查指南', path: '第一部分第一章4.2', raw: '审查指南第一部分第一章4.2' },
      new Map<LawName, LawBaseline>([['专利审查指南', baseline]]),
      { revision: 'unknown' },
    )
    expect(result.state).toBe('unverified')
  })

  it('uses the revision label when it embeds no date', () => {
    const baseline = guideline({
      versions: [{
        revision: '2026 年修订版',
        sections: [{
          path: '第一部分第一章4.2', topics: ['发明'], text: '新版正文',
          sourceDoc: '审查指南 2026', verifiedOn: '2026-01-01',
        }],
      }],
    })
    const result = decideValidity(
      { kind: 'guideline-section', law: '专利审查指南', path: '第一部分第一章4.2', raw: '审查指南第一部分第一章4.2' },
      new Map<LawName, LawBaseline>([['专利审查指南', baseline]]),
    )
    expect(result.revisionHistory?.[0]?.effectiveDate).toBe('2026 年修订版')
  })

  it('labels every lineage status', () => {
    const index = testBaselines()
    const statuses: ValidityState[] = ['active', 'revised', 'repealed', 'unverified']
    for (const status of statuses) {
      const result = queryValidity(
        { provision: '专利法第22条' },
        index,
        lineage([[22, status]]),
      )
      expect(result.state).toBe(status)
      expect(result.reason).toContain(status === 'unverified' ? '沿革状态为unverified' : '沿革数据确认')
    }
  })
})

describe('rule-lock branches', () => {
  it('labels a repealed entry in the report', () => {
    const entry: RuleLockEntry = {
      provision: '专利法第1条', level: 'article', effectiveDate: null, stale: true, validityStatus: 'repealed',
    }
    const report = renderRuleLockReport({ locked: [entry], unverified: [] })
    expect(report).toContain('已废止 1')
    expect(report).toContain('已废止 ⚠️已失效')
  })

  it('treats a blank JSON string as an empty list', async () => {
    const out = await new RuleLockHandler(testBaselines()).execute({
      state: { [DEFAULT_RULE_LOCK_PROVISIONS_KEY]: '   ' },
    })
    expect(out.rule_lock_report).toContain('为空')
  })

  it('rejects a JSON value that is not an array', async () => {
    const out = await new RuleLockHandler(testBaselines()).execute({
      state: { [DEFAULT_RULE_LOCK_PROVISIONS_KEY]: '{"provisions":[]}' },
    })
    expect(out.rule_lock_report).toContain('不可读')
  })

  it('reports a list with no usable strings', async () => {
    const out = await new RuleLockHandler(testBaselines()).execute({
      state: { [DEFAULT_RULE_LOCK_PROVISIONS_KEY]: [1, null, '  '] },
    })
    expect(out.rule_lock_report).toContain('无有效字符串元素')
  })

  it('locks an untranscribed article with no effective date', () => {
    const result = lockProvisions(['专利法实施细则第5条'], testBaselines())
    expect(result.locked[0]).toMatchObject({ validityStatus: 'unverified', effectiveDate: null })
  })

  it('leaves the effective date null when an unparsed reference has no entry', () => {
    const result = lockProvisions(['not a citation'], testBaselines())
    expect(result.locked[0]?.effectiveDate).toBeNull()
  })

  it('takes the effective date from revision history when no entry is indexed', () => {
    const index = new Map<LawName, LawBaseline>([
      ['专利审查指南', guideline({
        sections: [],
        staleSections: [{ path: '第二部分第四章3.2.1.1', reason: '修订' }],
        versions: [{
          revision: '2026 年修订版（2026-01-01 施行）',
          sections: [{
            path: '第二部分第九章1.1', topics: ['其他'], text: '其他正文',
            sourceDoc: '审查指南 2026', verifiedOn: '2026-01-01',
          }],
        }],
      })],
    ])
    const result = lockProvisions(['审查指南第二部分第四章3.2.1.1'], index)
    expect(result.locked[0]).toMatchObject({
      validityStatus: 'unverified',
      stalePath: true,
      effectiveDate: '2026-01-01',
    })
  })
})

describe('verify with a statute-only proposition', () => {
  it('compares against articles when the baseline has no sections', () => {
    const baseline = statute()
    const finding = verifyCitation(
      { kind: 'law-article', law: '专利法', article: 22, raw: '专利法第22条' },
      new Map<LawName, LawBaseline>([['专利法', baseline]]),
      { proposition: '完全不同且无关的文字' },
    )
    expect(finding.decision).toBe('unmatched')
  })
})
