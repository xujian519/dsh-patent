import { getEventListeners } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertLegalLawIndexReadable,
  createLegalLawIndex,
  findLegalArticle,
  LegalLawBaselineError,
  legalLawNames,
  loadLegalLawBaselines,
  loadLegalLawBaselinesAsync,
  parseLegalLawBaseline,
  parseLegalLawManifest,
} from '../src/baseline.ts'
import { LEGAL_LAW_MANIFEST_FILE, legalLawBaselineDir, listLegalLawFiles } from '../src/asset-location.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a temporary directory holding the given files. */
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-law-'))
  tempDirs.push(dir)
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content)
  return dir
}

/** Manifest text for the given `[law, document, file]` rows. */
function manifestText(rows: Array<[string, string, string]>): string {
  return JSON.stringify({ laws: rows })
}

const CIVIL_CODE = [
  'law: 民法典',
  'document: 中华人民共和国民法典',
  'revision: null',
  'maxArticle: 1260',
  'maxVerifiedOn: 2026-10-23',
  'articles:',
  '  - article: 143',
  '    topics: [民事法律行为, 有效条件]',
  '    text: 具备下列条件的民事法律行为有效：（一）行为人具有相应的民事行为能力；',
  '    sourceDoc: 官方全文',
  '    verifiedOn: 2026-10-23',
  '  - article: 577',
  '    topics: [违约责任]',
  '    text: null',
  '    sourceDoc: null',
  '    verifiedOn: null',
].join('\n')

/** Parse a fixture expected to fail, returning the error for assertions. */
function parseFailing(source: string): LegalLawBaselineError {
  try {
    parseLegalLawBaseline(source, 'fixture.yaml')
  } catch (error) {
    if (error instanceof LegalLawBaselineError) return error
    throw error
  }
  throw new Error('expected the parse to fail')
}

describe('parseLegalLawBaseline', () => {
  it('parses a valid index and sorts articles by number', () => {
    const baseline = parseLegalLawBaseline([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'revision: 2020 年通过',
      'maxArticle: 1260',
      'maxVerifiedOn: 2026-10-23',
      'maxSource: fixture',
      'articles:',
      '  - article: 577',
      '    topics: [违约责任]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
      '  - article: 143',
      '    topics: [民事法律行为]',
      '    paragraphs: [1, 2]',
      '    text: 条文内容',
      '    sourceDoc: 官方全文',
      '    verifiedOn: 2026-10-23',
    ].join('\n'), 'test.yaml')

    expect(baseline.law).toBe('民法典')
    expect(baseline.document).toBe('中华人民共和国民法典')
    expect(baseline.revision).toBe('2020 年通过')
    expect(baseline.maxArticle).toBe(1260)
    expect(baseline.articles).toHaveLength(2)
    expect(baseline.articles[0]!.article).toBe(143)
    expect(baseline.articles[1]!.article).toBe(577)
    expect(baseline.articles[0]!.paragraphs).toEqual([1, 2])
  })

  it('accepts any non-empty law name (dynamic expansion)', () => {
    // LegalLawName is now `string` to support dynamic expansion; any non-empty name is accepted
    const baseline = parseLegalLawBaseline([
      'law: 刑法',
      'document: 中华人民共和国刑法',
      'articles:',
      '  - article: 1',
      '    topics: [test]',
    ].join('\n'), 'test.yaml')
    expect(baseline.law).toBe('刑法')
  })

  it('rejects an empty law name', () => {
    const error = parseFailing([
      'law: ""',
      'document: 空名称法律',
      'articles:',
      '  - article: 1',
      '    topics: [test]',
    ].join('\n'))
    expect(error).toBeInstanceOf(LegalLawBaselineError)
  })

  it('rejects a file with no articles', () => {
    const error = parseFailing([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'articles: []',
    ].join('\n'))
    expect(error.message).toContain('至少一个 article')
  })

  it('rejects duplicate article numbers', () => {
    const error = parseFailing([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'articles:',
      '  - article: 1',
      '    topics: [test]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
      '  - article: 1',
      '    topics: [test2]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n'))
    expect(error.message).toContain('重复')
  })

  it('rejects text without sourceDoc or verifiedOn', () => {
    const error = parseFailing([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'articles:',
      '  - article: 1',
      '    topics: [test]',
      '    text: 条文',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n'))
    expect(error.message).toContain('sourceDoc')
  })

  it('rejects a maxArticle below the highest indexed article', () => {
    const error = parseFailing([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'maxArticle: 100',
      'articles:',
      '  - article: 143',
      '    topics: [test]',
      '    text: null',
      '    sourceDoc: null',
      '    verifiedOn: null',
    ].join('\n'))
    expect(error.message).toContain('maxArticle=100')
    expect(error.message).toContain('143')
  })

  it('rejects a maxVerifiedOn older than an entry verification date', () => {
    const error = parseFailing([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'maxVerifiedOn: 2026-10-01',
      'articles:',
      '  - article: 143',
      '    topics: [test]',
      '    text: 条文',
      '    sourceDoc: 官方全文',
      '    verifiedOn: 2026-10-23',
    ].join('\n'))
    expect(error.message).toContain('maxVerifiedOn=2026-10-01')
    expect(error.message).toContain('2026-10-23')
  })

  it('skips the version checks when the header declares neither bound', () => {
    const baseline = parseLegalLawBaseline([
      'law: 民法典',
      'document: 中华人民共和国民法典',
      'articles:',
      '  - article: 143',
      '    topics: [test]',
      '    text: 条文',
      '    sourceDoc: 官方全文',
      '    verifiedOn: 2026-10-23',
    ].join('\n'), 'fixture.yaml')
    expect(baseline.maxArticle).toBeNull()
    expect(baseline.maxVerifiedOn).toBeNull()
  })
})

describe('loadLegalLawBaselines', () => {
  it('loads every YAML file in a directory', () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'civil-procedure-law.yaml': CIVIL_CODE.replace('law: 民法典', 'law: 民事诉讼法').replace('document: 中华人民共和国民法典', 'document: 中华人民共和国民事诉讼法'),
    })
    const baselines = loadLegalLawBaselines(dir)
    expect(baselines.size).toBe(2)
    expect(baselines.has('民法典')).toBe(true)
    expect(baselines.has('民事诉讼法')).toBe(true)
  })

  it('rejects duplicate law names across files', () => {
    const dir = fixtureDir({
      'a.yaml': CIVIL_CODE,
      'b.yaml': CIVIL_CODE,
    })
    expect(() => loadLegalLawBaselines(dir)).toThrow(LegalLawBaselineError)
  })

  it('fails on an empty directory', () => {
    const dir = fixtureDir({})
    expect(() => loadLegalLawBaselines(dir)).toThrow(LegalLawBaselineError)
  })

  it('loads the same index asynchronously', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'civil-procedure-law.yaml': CIVIL_CODE.replace('law: 民法典', 'law: 民事诉讼法').replace('document: 中华人民共和国民法典', 'document: 中华人民共和国民事诉讼法'),
    })
    const baselines = await loadLegalLawBaselinesAsync(dir)
    expect(baselines.size).toBe(2)
    expect(baselines.has('民事诉讼法')).toBe(true)
  })

  it('rejects duplicate law names while loading asynchronously', async () => {
    const dir = fixtureDir({ 'a.yaml': CIVIL_CODE, 'b.yaml': CIVIL_CODE })
    await expect(loadLegalLawBaselinesAsync(dir)).rejects.toThrow(LegalLawBaselineError)
  })

  it('reports the names added by a load', async () => {
    const dir = fixtureDir({
      'accounting.yaml': CIVIL_CODE
        .replace('law: 民法典', 'law: 会计法')
        .replace('document: 中华人民共和国民法典', 'document: 中华人民共和国会计法'),
    })
    await loadLegalLawBaselinesAsync(dir)
    expect(legalLawNames()).toContain('会计法')
    expect(Object.isFrozen(legalLawNames())).toBe(true)
  })

  // Loading 7,900+ YAML files takes minutes under coverage instrumentation.
  it('loads the packaged index without errors', () => {
    // Loading 7900+ YAML files takes time
    const baselines = loadLegalLawBaselines()
    expect(baselines.size).toBeGreaterThanOrEqual(4)
    expect(baselines.has('民法典')).toBe(true)
    expect(baselines.has('民事诉讼法')).toBe(true)
    expect(baselines.has('劳动合同法')).toBe(true)
    expect(baselines.has('公司法')).toBe(true)
  }, 180_000)
})

describe('parseLegalLawManifest', () => {
  it('keys the rows by law name', () => {
    const manifest = parseLegalLawManifest(manifestText([
      ['民法典', '中华人民共和国民法典', 'civil-code.yaml'],
      ['会计法', '中华人民共和国会计法', 'accounting.yaml'],
    ]), 'manifest.json')
    expect([...manifest.keys()]).toEqual(['民法典', '会计法'])
    expect(manifest.get('会计法')).toEqual({
      law: '会计法',
      document: '中华人民共和国会计法',
      file: 'accounting.yaml',
    })
  })

  it('rejects malformed JSON', () => {
    expect(() => parseLegalLawManifest('{', 'manifest.json')).toThrow(LegalLawBaselineError)
  })

  it('rejects a root without a laws array', () => {
    expect(() => parseLegalLawManifest('[]', 'manifest.json')).toThrow('必须声明 laws 数组')
    expect(() => parseLegalLawManifest('null', 'manifest.json')).toThrow('必须声明 laws 数组')
    expect(() => parseLegalLawManifest('{"laws":{}}', 'manifest.json')).toThrow('laws 必须是数组')
  })

  it('rejects a row that is not an array', () => {
    expect(() => parseLegalLawManifest(JSON.stringify({ laws: ['民法典'] }), 'manifest.json'))
      .toThrow('必须是 [law, document, file] 数组')
  })

  it('rejects a row that is not three strings', () => {
    expect(() => parseLegalLawManifest(JSON.stringify({ laws: [['民法典', '中华人民共和国民法典']] }), 'manifest.json'))
      .toThrow('三个字符串')
  })

  it('rejects a row with an empty field', () => {
    expect(() => parseLegalLawManifest(JSON.stringify({ laws: [['民法典', ' ', 'civil-code.yaml']] }), 'manifest.json'))
      .toThrow('有空字段')
  })

  it('rejects a file outside the index directory', () => {
    for (const file of ['civil-code.json', '../civil-code.yaml', 'nested/civil-code.yaml']) {
      expect(() => parseLegalLawManifest(JSON.stringify({ laws: [['民法典', '中华人民共和国民法典', file]] }), 'manifest.json'))
        .toThrow('索引目录内的 .yaml 文件')
    }
  })

  it('rejects a file listed twice', () => {
    expect(() => parseLegalLawManifest(manifestText([
      ['民法典', '中华人民共和国民法典', 'civil-code.yaml'],
      ['会计法', '中华人民共和国会计法', 'civil-code.yaml'],
    ]), 'manifest.json')).toThrow('同一索引文件被登记了两次')
  })

  it('rejects a law listed twice', () => {
    expect(() => parseLegalLawManifest(manifestText([
      ['民法典', '中华人民共和国民法典', 'civil-code.yaml'],
      ['民法典', '中华人民共和国民法典', 'civil-code-copy.yaml'],
    ]), 'manifest.json')).toThrow('同一部法律被索引了两次')
  })

  it('rejects a manifest with no laws', () => {
    expect(() => parseLegalLawManifest(manifestText([]), 'manifest.json')).toThrow('没有登记任何法律')
  })
})

describe('createLegalLawIndex', () => {
  it('learns the law names from the manifest without parsing a law file', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'accounting.yaml': 'law: 会计法',
      'manifest.json': manifestText([
        ['民法典', '中华人民共和国民法典', 'civil-code.yaml'],
        ['会计法', '中华人民共和国会计法', 'accounting.yaml'],
      ]),
    })
    const names = await createLegalLawIndex(dir).loadNames()
    expect(names).toEqual(['民法典', '会计法'])
    expect(Object.isFrozen(names)).toBe(true)
    expect(legalLawNames()).toContain('会计法')
  })

  it('parses only the laws a call names', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'accounting.yaml': 'law: 会计法',
      'manifest.json': manifestText([
        ['民法典', '中华人民共和国民法典', 'civil-code.yaml'],
        ['会计法', '中华人民共和国会计法', 'accounting.yaml'],
      ]),
    })
    const index = createLegalLawIndex(dir)
    const baselines = await index.load(['民法典'])
    expect(baselines.has('民法典')).toBe(true)
    expect(baselines.has('会计法')).toBe(false)
    await expect(index.load(['会计法'])).rejects.toThrow(LegalLawBaselineError)
  })

  it('keeps a parsed law across calls', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    const index = createLegalLawIndex(dir)
    await index.load(['民法典'])
    rmSync(join(dir, 'civil-code.yaml'))
    expect((await index.load(['民法典'])).get('民法典')?.articles).toHaveLength(2)
  })

  it('omits law names the manifest does not list', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    expect((await createLegalLawIndex(dir).load(['不存在的法'])).size).toBe(0)
  })

  it('shares one read between concurrent loads of a law', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    const index = createLegalLawIndex(dir)
    const [first, second] = await Promise.all([index.load(['民法典']), index.load(['民法典'])])
    expect(first.get('民法典')).toBe(second.get('民法典'))
  })

  it('reports a missing law file and retries once it appears', async () => {
    const dir = fixtureDir({
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    const index = createLegalLawIndex(dir)
    await expect(index.load(['民法典'])).rejects.toThrow('法条索引文件不可读')
    writeFileSync(join(dir, 'civil-code.yaml'), CIVIL_CODE)
    expect((await index.load(['民法典'])).get('民法典')?.articles).toHaveLength(2)
  })

  it('retries the manifest after a failed read', async () => {
    const dir = fixtureDir({ 'civil-code.yaml': CIVIL_CODE })
    const index = createLegalLawIndex(dir)
    await expect(index.loadNames()).rejects.toThrow('法条索引清单不可读')
    writeFileSync(join(dir, 'manifest.json'), manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]))
    expect(await index.loadNames()).toEqual(['民法典'])
  })

  it('fails when the index has no manifest', async () => {
    const dir = fixtureDir({ 'civil-code.yaml': CIVIL_CODE })
    await expect(createLegalLawIndex(dir).loadNames()).rejects.toThrow('法条索引清单不可读')
  })

  it('fails when a file disagrees with its manifest row', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': manifestText([['会计法', '中华人民共和国会计法', 'civil-code.yaml']]),
    })
    await expect(createLegalLawIndex(dir).load(['会计法'])).rejects.toThrow('法条索引清单与文件不一致')
  })

  it('stops loading when the caller aborts', async () => {
    const dir = fixtureDir({
      'accounting.yaml': 'law: 会计法',
      'manifest.json': manifestText([['会计法', '中华人民共和国会计法', 'accounting.yaml']]),
    })
    const controller = new AbortController()
    controller.abort()
    await expect(createLegalLawIndex(dir).loadNames(controller.signal)).rejects.toThrow(/abort/i)
    const index = createLegalLawIndex(dir)
    await index.loadNames()
    await expect(index.load(['会计法'], controller.signal)).rejects.toThrow(/abort/i)
  })

  it('ends the wait when the caller aborts a manifest read', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': `${' '.repeat(4 * 1024 * 1024)}${manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']])}`,
    })
    const controller = new AbortController()
    const pending = createLegalLawIndex(dir).loadNames(controller.signal)
    // The padding keeps the read in flight long enough for the abort below.
    setImmediate(() => { controller.abort() })
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('ends the wait when the caller aborts a law read', async () => {
    const padding = `# ${'x'.repeat(4094)}\n`.repeat(1024)
    const dir = fixtureDir({
      'civil-code.yaml': `${padding}${CIVIL_CODE}`,
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    const index = createLegalLawIndex(dir)
    await index.loadNames()
    const controller = new AbortController()
    const pending = index.load(['民法典'], controller.signal)
    setImmediate(() => { controller.abort() })
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('reports a non-Error abort reason as an Error', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': `${' '.repeat(4 * 1024 * 1024)}${manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']])}`,
    })
    const controller = new AbortController()
    const pending = createLegalLawIndex(dir).loadNames(controller.signal)
    setImmediate(() => { controller.abort('stop now') })
    await expect(pending).rejects.toThrow('stop now')
  })

  it('keeps another caller loading when one caller aborts a law read', async () => {
    const padding = `# ${'x'.repeat(4094)}\n`.repeat(1024)
    const dir = fixtureDir({
      'civil-code.yaml': `${padding}${CIVIL_CODE}`,
      'manifest.json': manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]),
    })
    const index = createLegalLawIndex(dir)
    await index.loadNames()
    const cancelled = new AbortController()
    const survivor = new AbortController()
    const first = index.load(['民法典'], cancelled.signal)
    const second = index.load(['民法典'], survivor.signal)
    setImmediate(() => { cancelled.abort() })
    await expect(first).rejects.toThrow(/abort/i)
    expect((await second).get('民法典')?.articles).toHaveLength(2)
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(survivor.signal, 'abort')).toHaveLength(0)
  })

  it('keeps another caller loading when one caller aborts the manifest read', async () => {
    const dir = fixtureDir({
      'civil-code.yaml': CIVIL_CODE,
      'manifest.json': `${' '.repeat(4 * 1024 * 1024)}${manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']])}`,
    })
    const index = createLegalLawIndex(dir)
    const cancelled = new AbortController()
    const survivor = new AbortController()
    const first = index.loadNames(cancelled.signal)
    const second = index.loadNames(survivor.signal)
    setImmediate(() => { cancelled.abort() })
    await expect(first).rejects.toThrow(/abort/i)
    expect(await second).toEqual(['民法典'])
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(survivor.signal, 'abort')).toHaveLength(0)
  })
})

describe('assertLegalLawIndexReadable', () => {
  it('requires the manifest beside the index files', () => {
    const dir = fixtureDir({ 'civil-code.yaml': CIVIL_CODE })
    expect(() => { assertLegalLawIndexReadable(dir) }).toThrow('法条索引清单不可读')
    writeFileSync(join(dir, 'manifest.json'), manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]))
    expect(() => { assertLegalLawIndexReadable(dir) }).not.toThrow()
  })
})

describe('packaged index manifest', () => {
  it('names every packaged index file', () => {
    const dir = legalLawBaselineDir()
    const manifest = parseLegalLawManifest(
      readFileSync(join(dir, LEGAL_LAW_MANIFEST_FILE), 'utf8'),
      join(dir, LEGAL_LAW_MANIFEST_FILE),
    )
    const files = listLegalLawFiles(dir).map(file => basename(file)).sort()
    expect(manifest.size).toBe(files.length)
    expect([...manifest.values()].map(entry => entry.file).sort()).toEqual(files)
    expect([...manifest.keys()]).toEqual([...manifest.keys()].sort())
  })
})

describe('findLegalArticle', () => {
  it('returns the entry when the article exists', () => {
    const baseline = parseLegalLawBaseline(CIVIL_CODE, 'test.yaml')
    const entry = findLegalArticle(baseline, 143)
    expect(entry).toBeDefined()
    expect(entry!.article).toBe(143)
    expect(entry!.topics).toContain('民事法律行为')
  })

  it('returns undefined for an unindexed article', () => {
    const baseline = parseLegalLawBaseline(CIVIL_CODE, 'test.yaml')
    expect(findLegalArticle(baseline, 999)).toBeUndefined()
  })
})
