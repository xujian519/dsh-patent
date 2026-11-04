import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeLawSearch, KnowledgeRuntimeStats } from '@deepseek-ai/dsh-patent-knowledge'

/** Fixture mirrors knowledge.db: documents(doc_type='law_article') + chunks + contentless trigram docs_fts. */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function createStore(): { search: KnowledgeLawSearch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-search-'))
  const dbPath = join(dir, 'knowledge.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
  `)
  const insDoc = db.prepare(
    'INSERT INTO documents (id, source, doc_type, title, indexed_at, level, file_path) VALUES (?, \'raw\', ?, ?, \'2026-01-01\', ?, ?)',
  )
  insDoc.run('law:专利法', 'law_article', '中华人民共和国专利法', '法律', '法律法规_md/中华人民共和国专利法.md')
  insDoc.run('law:实施细则', 'law_article', '中华人民共和国专利法实施细则', '行政法规', '法律法规_md/专利法实施细则.md')
  insDoc.run('raw:无效复审决定:xx', 'case', '某无效决定', null, null)
  // 指南全文（doc_type=guideline_rule）：与法规原文同一 documents 表，按 docTypes 区分。
  insDoc.run('raw:审查指南_md:第二部分第八章', 'guideline_rule', '专利审查指南 第二部分第八章-实质审查程序', '法律', '审查指南_md/第二部分第八章-实质审查程序.md')
  const insChunk = db.prepare(
    'INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, ?, \'text\', ?, ?)',
  )
  const c1 = insChunk.run('law:专利法', 0, '第一条 为了保护专利权人的合法权益，鼓励发明创造。', 30).lastInsertRowid as number
  const c2 = insChunk.run('law:专利法', 1, '第二十六条 说明书应当对发明作出清楚、完整的说明。', 26).lastInsertRowid as number
  const c3 = insChunk.run('law:实施细则', 0, '本细则依据专利法制订，对专利申请与审查程序作出具体规定。', 33).lastInsertRowid as number
  insChunk.run('raw:无效复审决定:xx', 0, '决定正文内容', 7)
  const c4 = insChunk.run('raw:审查指南_md:第二部分第八章', 0, '4.1 审查员应当发出审查意见通知书，指出申请文件的缺陷。', 40).lastInsertRowid as number
  const insFts = db.prepare(
    'INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, \'module\', \'patent\', NULL)',
  )
  insFts.run(c1, '中华人民共和国专利法', '第一条 为了保护专利权人的合法权益，鼓励发明创造。')
  insFts.run(c2, '中华人民共和国专利法', '第二十六条 说明书应当对发明作出清楚、完整的说明。')
  insFts.run(c3, '中华人民共和国专利法实施细则', '本细则依据专利法制订，对专利申请与审查程序作出具体规定。')
  insFts.run(c4, '专利审查指南 第二部分第八章-实质审查程序', '4.1 审查员应当发出审查意见通知书，指出申请文件的缺陷。')
  db.close()
  return { search: new KnowledgeLawSearch(dbPath), dir }
}

/** 以指定文档类型打开同一夹具库（指南引擎与法规引擎各一个实例）。 */
function createStoreWithTypes(docTypes: readonly ('law_article' | 'guideline_rule')[]): { search: KnowledgeLawSearch; dir: string } {
  const { dir } = createStore()
  return { search: new KnowledgeLawSearch(join(dir, 'knowledge.db'), { docTypes }), dir }
}

function withStore(): KnowledgeLawSearch {
  const { search, dir } = createStore()
  cleanups.push(() => {
    search.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return search
}

describe('KnowledgeLawSearch', () => {
  it('hits via FTS and de-duplicates per document', () => {
    const s = withStore()
    const hits = s.search('第二十六条')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.name).toBe('中华人民共和国专利法')
    expect(hits[0]!.level).toBe('法律')
    expect(hits[0]!.content).toContain('说明书应当')
  })

  it('runs the LIKE fallback against the content table, not the contentless FTS table', () => {
    const { search, dir } = createStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'knowledge.db'), { readOnly: true })
    try {
      const ftsLike = db.prepare("SELECT count(*) c FROM docs_fts WHERE docs_fts LIKE '%说明书%'").get() as { c: number }
      expect(ftsLike.c).toBe(0)
    } finally {
      db.close()
    }
    const hits = search.search('专利', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('专利')
  })

  it('excludes non-law_article documents', () => {
    const s = withStore()
    expect(s.search('无效决定')).toHaveLength(0)
  })

  it('filters by level', () => {
    const s = withStore()
    const hits = s.search('专利', { level: '行政法规' })
    expect(hits.map(h => h.name)).toEqual(['中华人民共和国专利法实施细则'])
  })

  it('falls back to LIKE for short queries', () => {
    const s = withStore()
    const hits = s.search('发明创造', { limit: 5 })
    expect(hits.some(h => h.name === '中华人民共和国专利法')).toBe(true)
  })

  it('getById/getByIds back-fill by documents.id', () => {
    const s = withStore()
    const byId = s.getById('law:专利法')
    expect(byId?.name).toBe('中华人民共和国专利法')
    expect(byId?.level).toBe('法律')
    const byIds = s.getByIds(['law:实施细则', 'law:专利法', '不存在'])
    expect(byIds.map(r => r.name)).toEqual(['中华人民共和国专利法实施细则', '中华人民共和国专利法'])
  })

  it('findByName and count', () => {
    const s = withStore()
    expect(s.findByName('实施细则').map(r => r.name)).toEqual(['中华人民共和国专利法实施细则'])
    expect(s.count()).toBe(2)
    expect(s.getCategories()).toEqual([])
  })

  it('is safe with no law_article documents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-search-empty-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent', title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id), chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
    `)
    db.close()
    const s = new KnowledgeLawSearch(dbPath)
    cleanups.push(() => {
      s.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(s.count()).toBe(0)
    expect(s.search('专利')).toEqual([])
    expect(s.ftsAvailable).toBe(false)
  })
})

type DocChunkRow = {
  document_id: string
  title: string
  level: string | null
  source: string | null
  content: string | null
  chunk_index: number
  char_count: number | null
  fts_rank?: number | null
}

function asInternals(search: KnowledgeLawSearch): {
  backfillContent(rows: DocChunkRow[]): DocChunkRow[]
  withLevelFilter(match: string, options: { level?: string }, limit: number): DocChunkRow[]
} {
  return search as unknown as {
    backfillContent(rows: DocChunkRow[]): DocChunkRow[]
    withLevelFilter(match: string, options: { level?: string }, limit: number): DocChunkRow[]
  }
}

describe('KnowledgeLawSearch edge paths', () => {
  /** Full law schema but a plain docs_fts table so the FTS statement fails to prepare. */
  function createDegraded(): { search: KnowledgeLawSearch; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-degraded-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, char_count INTEGER DEFAULT 0);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
      CREATE TABLE docs_fts (name TEXT);
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES ('law:专利法', 'raw', 'law_article', '中华人民共和国专利法', '2026-01-01', '法律')").run()
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES ('law:发明指南', 'raw', 'law_article', '发明%指南', '2026-01-01', '法律')").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:专利法', 0, 'text', '第一条 发明应当具备新颖性。', 20)").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:发明指南', 0, 'text', '发明%审查指引正文', 20)").run()
    db.close()
    return { search: new KnowledgeLawSearch(dbPath), dir }
  }

  it('degrades to LIKE when the FTS statement preparation fails, with stats and logger', () => {
    const warns: string[] = []
    const stats = new KnowledgeRuntimeStats()
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-degrade-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, char_count INTEGER DEFAULT 0);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
      CREATE TABLE docs_fts (name TEXT);
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES ('law:专利法', 'raw', 'law_article', '中华人民共和国专利法', '2026-01-01', '法律')").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:专利法', 0, 'text', '第一条 发明应当具备新颖性。', 20)").run()
    db.close()
    const search = new KnowledgeLawSearch(dbPath, { logger: { warn: m => warns.push(m) }, stats })
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(search.ftsAvailable).toBe(false)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/FTS5 不可用，已降级 LIKE/)
    expect(stats.snapshot().legalFtsDegraded).toBe(true)
    const hits = search.search('新颖性')
    expect(hits.some(h => h.name === '中华人民共和国专利法')).toBe(true)
  })

  it('falls back to keyword-OR FTS when the whole-phrase query misses', () => {
    const s = withStore()
    const hits = s.search('专利法的实施细则')
    expect(hits.some(h => h.name === '中华人民共和国专利法')).toBe(true)
    expect(hits.some(h => h.name === '中华人民共和国专利法实施细则')).toBe(true)
  })

  it('degrades at runtime when the FTS statement throws, then stays on LIKE', () => {
    const { search, dir } = createStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'knowledge.db'))
    db.exec('DROP TABLE docs_fts')
    db.close()

    expect(search.ftsAvailable).toBe(true)
    const first = search.search('发明创造')
    expect(first.some(h => h.name === '中华人民共和国专利法')).toBe(true)
    expect(search.ftsAvailable).toBe(false)
    const second = search.search('发明创造')
    expect(second.some(h => h.name === '中华人民共和国专利法')).toBe(true)
  })

  it('escapes wildcards in findByName and in the LIKE keyword', () => {
    const { search, dir } = createDegraded()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const byName = search.findByName('%指南')
    expect(byName.map(r => r.name)).toEqual(['发明%指南'])
    const byKeyword = search.search('发明%', { limit: 5 })
    expect(byKeyword.some(h => h.name === '发明%指南')).toBe(true)
  })

  it('returns undefined for an unknown getById and covers getByIds branches', () => {
    const s = withStore()
    expect(s.getById('不存在')).toBeUndefined()
    expect(s.getByIds([])).toEqual([])
    expect(s.getByIds([''])).toEqual([])
    expect(s.getByIds(['law:专利法']).map(r => r.name)).toEqual(['中华人民共和国专利法'])
    expect(s.getByIds(['不存在'])).toEqual([])
    expect(s.getByIds(['law:专利法', '不存在']).map(r => r.name)).toEqual(['中华人民共和国专利法'])
  })

  it('keeps getById inside the engine document types', () => {
    const { search, dir } = createStoreWithTypes(['guideline_rule'])
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(search.getById('raw:审查指南_md:第二部分第八章')?.name).toContain('专利审查指南')
    // 法规原文不在指南引擎的文档类型内，逐条回源也不返回。
    expect(search.getById('law:专利法')).toBeUndefined()
    expect(search.getByIds(['law:专利法'])).toEqual([])
  })

  it('runs the level-filtered FTS query', () => {
    const s = withStore()
    const hits = s.search('保护专利', { level: '法律' })
    expect(hits.map(h => h.name)).toEqual(['中华人民共和国专利法'])
  })

  it('runs the level-filtered LIKE query on a degraded engine', () => {
    const { search, dir } = createDegraded()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const hits = search.search('发明', { level: '法律' })
    expect(hits.some(h => h.name === '中华人民共和国专利法')).toBe(true)
  })

  it('de-duplicates multi-chunk documents and honors the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-dedupe-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, char_count INTEGER DEFAULT 0);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
    `)
    const insDoc = db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES (?, 'raw', 'law_article', ?, '2026-01-01', ?)")
    insDoc.run('law:A', '专利申请审查规定', '法律')
    insDoc.run('law:B', '专利申请格式要求', '行政法规')
    const insChunk = db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, ?, 'text', ?, 10)")
    const a1 = insChunk.run('law:A', 0, '专利申请新颖性判断标准。').lastInsertRowid as number
    const a2 = insChunk.run('law:A', 1, '专利申请创造性判断标准。').lastInsertRowid as number
    const b1 = insChunk.run('law:B', 0, '专利申请文件格式要求说明书应当清楚完整地记载技术方案，方便公众查阅。').lastInsertRowid as number
    const insFts = db.prepare("INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, 'patent', NULL)")
    insFts.run(a1, '专利申请审查规定', '专利申请新颖性判断标准。')
    insFts.run(a2, '专利申请审查规定', '专利申请创造性判断标准。')
    insFts.run(b1, '专利申请格式要求', '专利申请文件格式要求说明书应当清楚完整地记载技术方案，方便公众查阅。')
    db.close()
    const search = new KnowledgeLawSearch(dbPath)
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const hits = search.search('专利申请', { limit: 2 })
    expect(hits).toHaveLength(2)
    expect(hits.filter(h => h.name === '专利申请审查规定')).toHaveLength(1)
    expect(hits.some(h => h.name === '专利申请格式要求')).toBe(true)
  })

  it('maps a NULL level and empty content through toRecord', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-null-level-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, char_count INTEGER DEFAULT 0);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0);
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES ('law:空', 'raw', 'law_article', '无内容条款', '2026-01-01', NULL)").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:空', 0, 'text', '', 0)").run()
    db.close()
    const search = new KnowledgeLawSearch(dbPath)
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const byId = search.getById('law:空')
    expect(byId!.level).toBe('其他')
    expect(byId!.content).toBeUndefined()
    const found = search.findByName('无内容')
    expect(found[0]!.content).toBeUndefined()
  })

  it('backfills non-null rows unchanged and passes through missing chunk rows', () => {
    const s = withStore()
    const internals = asInternals(s)
    const withContent = internals.backfillContent([{
      document_id: 'law:专利法',
      title: '中华人民共和国专利法',
      level: '法律',
      source: 'raw',
      content: '已有正文',
      chunk_index: 0,
      char_count: 10,
    }])
    expect(withContent[0]!.content).toBe('已有正文')
    const missing = internals.backfillContent([{
      document_id: 'law:专利法',
      title: '中华人民共和国专利法',
      level: '法律',
      source: 'raw',
      content: null,
      chunk_index: 99,
      char_count: 10,
    }])
    expect(missing[0]!.content).toBeNull()
  })

  it('returns an empty result when the FTS statement is null in withLevelFilter', () => {
    const { search, dir } = createDegraded()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(asInternals(search).withLevelFilter('"x"', {}, 10)).toEqual([])
  })
})

describe('KnowledgeLawSearch 文档类型闭集', () => {
  it('缺省只索引法规原文：指南文档不出现在结果里', () => {
    const search = withStore()
    expect(search.search('审查意见通知书').every(hit => hit.id !== 'raw:审查指南_md:第二部分第八章')).toBe(true)
    expect(search.count()).toBeGreaterThan(0)
  })

  it('按 docTypes 索引指南全文时命中指南文档，并把 file_path 作为可溯源来源', () => {
    const { search, dir } = createStoreWithTypes(['guideline_rule'])
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const hits = search.search('审查意见通知书')
    expect(hits.map(hit => hit.id)).toContain('raw:审查指南_md:第二部分第八章')
    expect(hits[0]?.filename).toBe('审查指南_md/第二部分第八章-实质审查程序.md')
    // 指南引擎不索引法规原文。
    expect(hits.every(hit => hit.id !== 'law:专利法')).toBe(true)
  })

  it('法规命中也带 file_path（引文来源）', () => {
    const search = withStore()
    const hit = search.search('保护专利权人的合法权益')[0]
    expect(hit?.filename).toBe('法律法规_md/中华人民共和国专利法.md')
  })

  it('未知文档类型在构造期报错，不静默索引全部语料', () => {
    const { dir } = createStore()
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    expect(() => new KnowledgeLawSearch(join(dir, 'knowledge.db'), { docTypes: ['nope' as never] })).toThrow(/未知的文档类型/)
    // Failed construction closes the connection before rethrowing.
    expect(() => { rmSync(dir, { recursive: true, force: true }) }).not.toThrow()
  })
})

describe('KnowledgeLawSearch 时间效力过滤', () => {
  /** 带有效力列的夹具：现行 / 已废止 / 尚未生效 / 时间缺失四条。 */
  function createValidityStore(): { search: KnowledgeLawSearch; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-law-validity-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
        title TEXT NOT NULL, indexed_at TEXT NOT NULL, level TEXT, file_path TEXT, publish_date TEXT,
        valid_from TEXT, valid_to TEXT, expired INTEGER, validity_source TEXT,
        char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
      );
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
    `)
    const insDoc = db.prepare(`
      INSERT INTO documents (id, source, doc_type, title, indexed_at, level, file_path, publish_date, valid_from, valid_to, expired, validity_source)
      VALUES (?, 'raw', 'law_article', ?, '2026-01-01', '法律', ?, '2020-10-17', ?, ?, ?, 'test')
    `)
    const insChunk = db.prepare(
      'INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, 0, \'text\', ?, ?)',
    )
    const insFts = db.prepare(
      'INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, \'module\', \'patent\', NULL)',
    )
    const rows = [
      ['law:in-force', '现行法', 'common 现行条文 甲', '2020-01-01', '2099-01-01', 0],
      ['law:expired', '废止法', 'common 现行条文 乙', '2010-01-01', '2024-01-01', 1],
      ['law:future', '未来法', 'common 现行条文 丙', '2099-01-01', null, 0],
      ['law:unknown', '未知法', 'common 现行条文 丁', null, null, null],
    ] as const
    for (const [id, title, content, validFrom, validTo, expired] of rows) {
      insDoc.run(id, title, `laws/${id}.md`, validFrom, validTo, expired)
      const chunkId = insChunk.run(id, content, content.length).lastInsertRowid as number
      insFts.run(chunkId, title, content)
    }
    db.close()
    return { search: new KnowledgeLawSearch(dbPath), dir }
  }

  function withValidityStore(): KnowledgeLawSearch {
    const { search, dir } = createValidityStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return search
  }

  it('已废止与尚未生效的记录不返回；未核验默认返回并带状态', () => {
    const s = withValidityStore()
    const hits = s.search('现行条文', { asOf: '2026-01-01', limit: 10 })
    expect(hits.map(hit => hit.id).sort()).toEqual(['law:in-force', 'law:unknown'])
    expect(hits.find(hit => hit.id === 'law:in-force')?.validity).toBe('in-force')
    expect(hits.find(hit => hit.id === 'law:unknown')?.validity).toBe('unverified')
    expect(hits.find(hit => hit.id === 'law:unknown')?.expired).toBeUndefined()
    expect(hits.find(hit => hit.id === 'law:unknown')?.validFrom).toBeUndefined()
  })

  it('includeUnverified=false 只返回可证明在效的记录', () => {
    const s = withValidityStore()
    const hits = s.search('现行条文', { asOf: '2026-01-01', includeUnverified: false, limit: 10 })
    expect(hits.map(hit => hit.id)).toEqual(['law:in-force'])
  })

  it('效力过滤发生在 LIMIT 之前：高排名的废止条文不会挤掉有效条文', () => {
    const { search, dir } = createValidityStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    // 让废止条文在 BM25/LIKE 排序中都排在最前：重复检索词并增大字符数。
    const db = new DatabaseSync(join(dir, 'knowledge.db'))
    const content = '现行条文'.repeat(30)
    db.prepare(`
      INSERT INTO documents (id, source, doc_type, title, indexed_at, level, file_path, publish_date, valid_from, valid_to, expired, char_count)
      VALUES ('law:expired-hot', 'raw', 'law_article', '热门废止法', '2026-01-01', '法律', 'laws/hot.md', '2010-01-01', '2010-01-01', '2024-01-01', 1, ?)
    `).run(content.length)
    const chunkId = db.prepare(
      "INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:expired-hot', 0, 'text', ?, ?)",
    ).run(content, content.length).lastInsertRowid as number
    db.prepare(
      "INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, '热门废止法', ?, 'module', 'patent', NULL)",
    ).run(chunkId, content)
    db.close()

    const hits = search.search('现行条文', { asOf: '2026-01-01', includeUnverified: false, limit: 1 })
    expect(hits.map(hit => hit.id)).toEqual(['law:in-force'])
  })

  it('时点早于施行日时按尚未生效排除', () => {
    const s = withValidityStore()
    const hits = s.search('现行条文', { asOf: '2019-01-01', includeUnverified: false, limit: 10 })
    // 现行法 2020-01-01 才施行；其余已废止/未来/未核验均不可见。
    expect(hits).toEqual([])
  })

  it('getById / findByName / getByIds 同样过滤已废止记录', () => {
    const s = withValidityStore()
    expect(s.getById('law:expired')).toBeUndefined()
    expect(s.getById('law:in-force')?.validity).toBe('in-force')
    expect(s.findByName('废止法')).toEqual([])
    expect(s.getByIds(['law:in-force', 'law:expired']).map(r => r.id)).toEqual(['law:in-force'])
  })

  it('按名/按 id 查询也接受时点参数', () => {
    const s = withValidityStore()
    // 2099 年才施行：2019 年不可见，2100 年可见。
    expect(s.getById('law:future', { asOf: '2019-01-01' })).toBeUndefined()
    expect(s.getById('law:future', { asOf: '2100-01-01' })?.validity).toBe('in-force')
    expect(s.findByName('未来法', 10, { asOf: '2019-01-01' })).toEqual([])
    expect(s.findByName('未来法', 10, { asOf: '2100-01-01' }).map(r => r.id)).toEqual(['law:future'])
  })

  it('非法日期在严格模式下仍按未核验排除（SQL 过滤后由 JS 兜底）', () => {
    const { search, dir } = createValidityStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'knowledge.db'))
    db.prepare(`
      INSERT INTO documents (id, source, doc_type, title, indexed_at, level, file_path, valid_from, expired, char_count)
      VALUES ('law:bad-date', 'raw', 'law_article', '非法日期法', '2026-01-01', '法律', 'laws/bad.md', '2026-02-30', NULL, 10)
    `).run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:bad-date', 0, 'text', '非法日期条文', 10)").run()
    db.close()

    // SQLite 会把 2026-02-30 归一化为 3 月 2 日（date() 非空），JS 判为未核验。
    expect(search.getById('law:bad-date', { asOf: '2026-01-01', includeUnverified: false })).toBeUndefined()
    expect(search.getById('law:bad-date', { asOf: '2026-01-01' })?.validity).toBe('unverified')
  })

  it('空正文命中时 content 为 undefined', () => {
    const { search, dir } = createStore()
    cleanups.push(() => {
      search.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'knowledge.db'))
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at, level) VALUES ('law:empty', 'raw', 'law_article', '空正文法', '2026-01-01', '法律')").run()
    const chunkId = db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('law:empty', 0, 'text', '', 0)").run().lastInsertRowid as number
    db.prepare("INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, '空正文法', '', 'module', 'patent', NULL)").run(chunkId)
    db.close()

    const hit = search.search('空正文法')[0]
    expect(hit?.name).toBe('空正文法')
    expect(hit?.content).toBeUndefined()
  })

  it('存量库没有效力列时：expired 不是硬编码 0，记录标为未核验', () => {
    const s = withStore()
    const hit = s.search('第二十六条')[0]
    expect(hit?.validity).toBe('unverified')
    expect(hit?.expired).toBeUndefined()
  })
})

describe('KnowledgeLawSearch query input', () => {
  it('normalizes the result cap before binding it to SQLite', () => {
    const s = withStore()
    expect(s.search('专利法', { limit: 2.5 })).toHaveLength(2)
    expect(s.search('专利法', { limit: 0 })).toHaveLength(1)
    expect(s.search('专利法', { limit: -1 })).toHaveLength(1)
    expect(s.search('专利法', { limit: Number.NaN })).toHaveLength(2)
    // A rejected LIMIT used to escape the ladder as a sticky FTS degradation.
    expect(s.ftsAvailable).toBe(true)
  })

  it('strips NUL from the search text instead of degrading FTS', () => {
    const s = withStore()
    expect(s.search('第二十六条\u0000').map(hit => hit.name)).toEqual(['中华人民共和国专利法'])
    expect(s.ftsAvailable).toBe(true)
    expect(s.search('\u0000')).toEqual([])
  })
})
