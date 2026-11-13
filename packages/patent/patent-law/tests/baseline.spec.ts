import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findArticle, findSection, LawBaselineError, loadLawBaselines, parseLawBaseline } from '../src/baseline.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a temporary directory holding the given files. */
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-law-'))
  tempDirs.push(dir)
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content)
  return dir
}

const STATUTE = [
  'law: 专利法',
  'document: 中华人民共和国专利法',
  'revision: null',
  'maxArticle: 82',
  'maxVerifiedOn: null',
  'articles:',
  '  - article: 22',
  '    topics: [新颖性, 创造性]',
  '    text: null',
  '    sourceDoc: null',
  '    verifiedOn: null',
].join('\n')

/** The statute fixture re-labelled as the implementing regulations. */
const REGULATIONS = STATUTE.replace('law: 专利法', 'law: 专利法实施细则')

const GUIDELINES = [
  'law: 专利审查指南',
  'document: 专利审查指南',
  'revision: null',
  'maxArticle: null',
  'maxVerifiedOn: null',
  'sections:',
  '  - path: 第二部分第四章3.2',
  '    topics: [创造性, 三步法]',
  '    text: null',
  '    sourceDoc: null',
  '    verifiedOn: null',
].join('\n')

/** Parse a fixture expected to fail, returning the error for assertions. */
function parseFailing(source: string): LawBaselineError {
  try {
    parseLawBaseline(source, 'fixture.yaml')
  } catch (error) {
    if (error instanceof LawBaselineError) return error
    throw error
  }
  throw new Error('expected the parse to fail')
}

describe('parseLawBaseline', () => {
  it('parses a statute index and sorts its articles', () => {
    const baseline = parseLawBaseline([
      'law: 专利法',
      'document: 中华人民共和国专利法',
      'revision: 2020 年第四次修正',
      'maxArticle: 82',
      'maxVerifiedOn: null',
      'maxSource: fixture',
      'articles:',
      '  - article: 26',
      '    topics: [清楚]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
      '  - article: 22',
      '    topics: [新颖性]',
      '    paragraphs: [1, 2, 3]',
      '    text: 现行条文',
      '    sourceDoc: 主席令第五十五号',
      '    verifiedOn: 2026-01-01',
    ].join('\n'), 'fixture.yaml')
    expect(baseline.law).toBe('专利法')
    expect(baseline.revision).toBe('2020 年第四次修正')
    expect(baseline.maxArticle).toBe(82)
    expect(baseline.maxVerifiedOn).toBeNull()
    expect(baseline.maxSource).toBe('fixture')
    expect(baseline.articles.map(entry => entry.article)).toEqual([22, 26])
    expect(baseline.articles[0]?.paragraphs).toEqual([1, 2, 3])
    expect(baseline.articles[0]?.verifiedOn).toBe('2026-01-01')
    expect(baseline.sections).toEqual([])
    expect(baseline.supersededBy).toBeNull()
    expect(baseline.staleSections).toEqual([])
    expect(baseline.versions).toEqual([])
  })

  it('parses a guideline index and sorts its sections', () => {
    const baseline = parseLawBaseline([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: null',
      'maxArticle: null',
      'maxVerifiedOn: null',
      'sections:',
      '  - path: 第五部分第七章2.1',
      '    topics: [期限]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
      '  - path: 第二部分第四章3.2',
      '    topics: [创造性]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n'), 'fixture.yaml')
    expect(baseline.law).toBe('专利审查指南')
    expect(baseline.sections).toHaveLength(2)
    expect(baseline.articles).toEqual([])
    expect(baseline.supersededBy).toBeNull()
    expect(baseline.staleSections).toEqual([])
    expect(baseline.versions).toEqual([])
  })

  it('reads a superseding revision and the sections whose text it supersedes', () => {
    const baseline = parseLawBaseline([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: 2023 年修订版（2024-01-20 施行）',
      'supersededBy: 2026 年修订版（2026-01-01 施行）',
      'maxArticle: null',
      'maxVerifiedOn: null',
      'staleSections:',
      '  - path: 第四部分第三章2.1',
      '    reason: 2026 年修订版已修改本节',
      'sections:',
      '  - path: 第四部分第三章2.1',
      '    topics: [一事不再理]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n'), 'fixture.yaml')
    expect(baseline.supersededBy).toBe('2026 年修订版（2026-01-01 施行）')
    expect(baseline.staleSections).toEqual([
      { path: '第四部分第三章2.1', reason: '2026 年修订版已修改本节' },
    ])
  })

  it('rejects a stale-section record that names an unindexed section', () => {
    expect(parseFailing([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: null',
      'staleSections:',
      '  - path: 不存在的节',
      '    reason: fixture',
      'sections:',
      '  - path: 第四部分第三章2.1',
      '    topics: [一事不再理]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n')).message).toContain('不存在的 section')
  })

  it('rejects stale-section records on a statute', () => {
    expect(parseFailing([
      STATUTE,
      'staleSections:',
      '  - path: 第四部分第三章2.1',
      '    reason: fixture',
    ].join('\n')).message).toContain('不能声明 staleSections')
  })

  it('rejects a stale-section field that is not a list', () => {
    expect(parseFailing([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: null',
      'staleSections: not-a-list',
      'sections:',
      '  - path: 第四部分第三章2.1',
      '    topics: [一事不再理]',
    ].join('\n')).message).toContain('必须是数组')
  })

  it('rejects duplicate stale-section records', () => {
    expect(parseFailing([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: null',
      'staleSections:',
      '  - path: 第四部分第三章2.1',
      '    reason: fixture',
      '  - path: 第四部分第三章2.1',
      '    reason: fixture',
      'sections:',
      '  - path: 第四部分第三章2.1',
      '    topics: [一事不再理]',
    ].join('\n')).message).toContain('路径重复')
  })

  it('reads revision-specific section overrides and sorts them', () => {
    const baseline = parseLawBaseline([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: 2023 年修订版（2024-01-20 施行）',
      'supersededBy: 2026 年修订版（2026-01-01 施行）',
      'maxArticle: null',
      'maxVerifiedOn: null',
      'versions:',
      '  - revision: 2026 年修订版（2026-01-01 施行）',
      '    sections:',
      '      - path: 第四部分第三章3.3',
      '        topics: [无效宣告]',
      '        text: 2026 正文',
      '        sourceDoc: 修改对照表',
      '        verifiedOn: 2026-10-17',
      '      - path: 第二部分第一章4.4',
      '        topics: [植物品种]',
      '        text: 2026 正文',
      '        sourceDoc: 修改对照表',
      '        verifiedOn: 2026-10-17',
      'sections:',
      '  - path: 第四部分第三章2.1',
      '    topics: [一事不再理]',
      '    text: 2023 正文',
      '    sourceDoc: 2023 全文',
      '    verifiedOn: 2026-01-01',
    ].join('\n'), 'fixture.yaml')
    expect(baseline.versions).toHaveLength(1)
    expect(baseline.versions[0]?.revision).toBe('2026 年修订版（2026-01-01 施行）')
    expect(baseline.versions[0]?.sections.map(section => section.path))
      .toEqual(['第二部分第一章4.4', '第四部分第三章3.3'])
  })

  it('rejects version overrides on a statute', () => {
    expect(parseFailing([
      STATUTE,
      'versions:',
      '  - revision: 2026 年修订版',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
    ].join('\n')).message).toContain('不能声明 versions')
  })

  it('rejects a version field that is not a list, or a version with an empty revision', () => {
    const head = [
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: 2023 年修订版',
    ]
    const sections = [
      'sections:',
      '  - path: 第二部分第四章3.2',
      '    topics: [a]',
    ]
    expect(parseFailing([...head, 'versions: not-a-list', ...sections].join('\n')).message)
      .toContain('必须是数组')
    expect(parseFailing([
      ...head,
      'versions:',
      '  - revision: "   "',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
      ...sections,
    ].join('\n')).message).toContain('必须是非空字符串')
  })

  it('rejects a version that repeats the base revision, repeats itself, or has no sections', () => {
    const base = [
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: 2023 年修订版',
    ]
    const sections = [
      'sections:',
      '  - path: 第二部分第四章3.2',
      '    topics: [a]',
    ]
    expect(parseFailing([
      ...base,
      'versions:',
      '  - revision: 2023 年修订版',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
      ...sections,
    ].join('\n')).message).toContain('不能与基础 revision 相同')
    expect(parseFailing([
      ...base,
      'versions:',
      '  - revision: 2026 年修订版',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
      '  - revision: 2026 年修订版',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
      ...sections,
    ].join('\n')).message).toContain('revision 重复')
    expect(parseFailing([
      ...base,
      'versions:',
      '  - revision: 2026 年修订版',
      '    sections: []',
      ...sections,
    ].join('\n')).message).toContain('至少声明一个 section')
  })

  it('rejects duplicate paths inside one version', () => {
    expect(parseFailing([
      'law: 专利审查指南',
      'document: 专利审查指南',
      'revision: 2023 年修订版',
      'versions:',
      '  - revision: 2026 年修订版',
      '    sections:',
      '      - path: 第二部分第四章3.2',
      '        topics: [a]',
      '      - path: 第二部分第四章3.2',
      '        topics: [b]',
      'sections:',
      '  - path: 第二部分第四章3.2',
      '    topics: [a]',
    ].join('\n')).message).toContain('重复')
  })

  it('rejects a law name it does not index', () => {
    expect(parseFailing('law: 商标法\ndocument: x\narticles:\n  - article: 1\n    topics: [a]').message)
      .toContain('未知的法律名称')
  })

  it('rejects a missing document, a blank optional string, and a blank text', () => {
    expect(parseFailing('law: 专利法\narticles:\n  - article: 1\n    topics: [a]').message)
      .toContain('document')
    expect(parseFailing('law: 专利法\ndocument: x\nrevision: ""\narticles:\n  - article: 1\n    topics: [a]').message)
      .toContain('revision')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: [a]\n    text: ""').message)
      .toContain('text')
  })

  it('rejects a malformed article ceiling and verification date', () => {
    expect(parseFailing('law: 专利法\ndocument: x\nmaxArticle: 0\narticles:\n  - article: 1\n    topics: [a]').message)
      .toContain('maxArticle')
    expect(parseFailing('law: 专利法\ndocument: x\nmaxVerifiedOn: yesterday\narticles:\n  - article: 1\n    topics: [a]').message)
      .toContain('maxVerifiedOn')
  })

  it('rejects a malformed article list', () => {
    expect(parseFailing('law: 专利法\ndocument: x\narticles: nope').message).toContain('articles')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - nope').message).toContain('必须是映射')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - topics: [a]').message).toContain('article 必须是正整数')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: [a]\n  - article: 1\n    topics: [b]').message)
      .toContain('article 重复')
  })

  it('rejects a transcription record that is not all-or-nothing', () => {
    expect(parseFailing([
      'law: 专利法',
      'document: x',
      'articles:',
      '  - article: 1',
      '    topics: [a]',
      '    text: 正文',
      '    sourceDoc: 主席令',
      '    verifiedOn: null',
    ].join('\n')).message).toContain('sourceDoc 与 verifiedOn 必须同时记录')
    expect(parseFailing([
      'law: 专利法',
      'document: x',
      'articles:',
      '  - article: 1',
      '    topics: [a]',
      '    text: null',
      '    sourceDoc: 主席令',
      '    verifiedOn: null',
    ].join('\n')).message).toContain('不能单独记录')
    expect(parseFailing([
      'law: 专利审查指南',
      'document: x',
      'sections:',
      '  - path: 第二部分第四章3.2',
      '    topics: [a]',
      '    text: 正文',
      '    sourceDoc: null',
      '    verifiedOn: 2026-01-01',
    ].join('\n')).message).toContain('sourceDoc 与 verifiedOn 必须同时记录')
  })

  it('rejects a missing or malformed topic list', () => {
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1').message).toContain('topics')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: []').message).toContain('topics')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: [""]').message)
      .toContain('非空字符串')
  })

  it('rejects a malformed paragraph list', () => {
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: [a]\n    paragraphs: []').message)
      .toContain('paragraphs')
    expect(parseFailing('law: 专利法\ndocument: x\narticles:\n  - article: 1\n    topics: [a]\n    paragraphs: [0]').message)
      .toContain('paragraphs')
  })

  it('rejects a statute carrying sections, a guideline carrying articles, and an empty index', () => {
    expect(parseFailing(`${STATUTE}\nsections:\n  - path: 第二部分第四章3.2\n    topics: [a]`).message)
      .toContain('不能声明 sections')
    expect(parseFailing(`${GUIDELINES}\narticles:\n  - article: 1\n    topics: [a]`).message)
      .toContain('不能声明 articles')
    expect(parseFailing('law: 专利法\ndocument: x\narticles: []').message).toContain('至少一个 article')
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections: []').message).toContain('至少一个 section')
  })

  it('rejects a malformed section list', () => {
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections: nope').message).toContain('sections')
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections:\n  - path: ""\n    topics: [a]').message)
      .toContain('path')
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections:\n  - path: p\n    topics: [a]\n  - path: p\n    topics: [b]').message)
      .toContain('重复')
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections:\n  - nope').message).toContain('必须是映射')
    expect(parseFailing('law: 专利审查指南\ndocument: x\nsections:\n  - path: p\n    topics: [""]').message)
      .toContain('非空字符串')
  })

  it('rejects a document that is not a mapping and unparsable YAML', () => {
    expect(parseFailing('- a\n- b').message).toContain('根节点必须是映射')
    expect(parseFailing('law: [').message).toContain('YAML 解析失败')
  })
})

describe('loadLawBaselines', () => {
  it('loads the packaged index for all three documents', () => {
    const baselines = loadLawBaselines()
    expect([...baselines.keys()].sort()).toEqual(['专利审查指南', '专利法', '专利法实施细则'].sort())
    expect(baselines.get('专利法')?.articles.some(entry => entry.article === 22)).toBe(true)
    expect(baselines.get('专利审查指南')?.sections.length).toBeGreaterThan(0)
  })

  it('ships the coverage counts the README documents', () => {
    const baselines = loadLawBaselines()
    expect(baselines.get('专利法')?.articles).toHaveLength(82)
    expect(baselines.get('专利法实施细则')?.articles).toHaveLength(45)
    expect(baselines.get('专利审查指南')?.sections).toHaveLength(85)
    expect(baselines.get('专利审查指南')?.sections.filter(section => section.text !== null)).toHaveLength(70)
  })

  it('transcribes every packaged statute entry and states where the text came from', () => {
    const baselines = loadLawBaselines()
    const articles = [
      ...(baselines.get('专利法')?.articles ?? []),
      ...(baselines.get('专利法实施细则')?.articles ?? []),
    ]
    expect(articles.length).toBeGreaterThan(0)
    expect(articles.every(entry => entry.text !== null && entry.text.length > 0)).toBe(true)
    expect(articles.every(entry => entry.sourceDoc !== null && entry.verifiedOn !== null)).toBe(true)
  })

  it('verifies the article ceiling of both statutes and records where it came from', () => {
    const baselines = loadLawBaselines()
    expect(baselines.get('专利法')).toMatchObject({ maxArticle: 82 })
    expect(baselines.get('专利法实施细则')).toMatchObject({ maxArticle: 149 })
    expect(baselines.get('专利法')?.maxVerifiedOn).not.toBeNull()
    expect(baselines.get('专利法实施细则')?.maxVerifiedOn).not.toBeNull()
    expect(baselines.get('专利法')?.maxSource).not.toBeNull()
    expect(baselines.get('专利法实施细则')?.maxSource).not.toBeNull()
  })

  it('lists each article paragraph once, so the stated count is the paragraph count', () => {
    const baselines = loadLawBaselines()
    for (const name of ['专利法', '专利法实施细则'] as const) {
      for (const article of baselines.get(name)?.articles ?? []) {
        const paragraphs = article.paragraphs
        if (paragraphs === undefined) continue
        expect(new Set(paragraphs).size, `《${name}》第${article.article}条`).toBe(paragraphs.length)
      }
    }
  })

  it('loads an override directory that mirrors the packaged layout', () => {
    const dir = fixtureDir({ 'law.yaml': STATUTE, 'regulations.yaml': REGULATIONS, 'guidelines.yaml': GUIDELINES })
    expect(loadLawBaselines(dir).get('专利法')?.maxArticle).toBe(82)
  })

  it('rejects an unreadable directory, an empty directory, and a duplicated law', () => {
    expect(() => loadLawBaselines('/nonexistent/law-dir')).toThrow(LawBaselineError)
    expect(() => loadLawBaselines(fixtureDir({}))).toThrow(/没有 \.yaml 文件/)
    const dir = fixtureDir({ 'a.yaml': STATUTE, 'b.yaml': STATUTE })
    expect(() => loadLawBaselines(dir)).toThrow(/同一部法律被索引了两次/)
  })

  it('rejects a directory missing one of the three documents', () => {
    const dir = fixtureDir({ 'law.yaml': STATUTE, 'guidelines.yaml': GUIDELINES })
    expect(() => loadLawBaselines(dir)).toThrow(/缺少：专利法实施细则/)
  })
})

describe('index lookups', () => {
  const baselines = loadLawBaselines()

  it('finds an indexed article and reports a missing one', () => {
    const law = baselines.get('专利法')
    expect(law).toBeDefined()
    expect(findArticle(law!, 22)?.topics).toContain('新颖性')
    expect(findArticle(law!, 83)).toBeUndefined()
  })

  it('finds an indexed section and reports a missing one', () => {
    const guide = baselines.get('专利审查指南')
    expect(guide).toBeDefined()
    expect(findSection(guide!, '第二部分第四章3.2.1.1')?.topics).toContain('三步法')
    expect(findSection(guide!, '第九部分第九章9.9')).toBeUndefined()
  })
})
