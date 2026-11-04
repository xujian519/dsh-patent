import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CaseLawSearchEngine, KnowledgeRuntimeStats } from '@deepseek-ai/dsh-patent-knowledge'
import type { CaseLawHit } from '@deepseek-ai/dsh-patent-knowledge'

/**
 * CaseLawSearchEngine tests. The fixture mirrors the real knowledge.db:
 * contentless trigram FTS5 docs_fts whose rowid equals chunks.id, with the body
 * back-filled by JOIN chunks then JOIN documents.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function createEngine(includeFts = true, includePrefix = false): { engine: CaseLawSearchEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'case-law-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, file_path TEXT, module TEXT, priority TEXT, level TEXT, publish_date TEXT,
      case_number TEXT, court TEXT, decision_number TEXT, article_number TEXT, content_hash TEXT,
      indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, heading TEXT, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE INDEX idx_chunks_document ON chunks(document_id, chunk_index);
  `)
  if (includeFts) {
    db.exec(
      `CREATE VIRTUAL TABLE docs_fts USING fts5(
        title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1
      )`,
    )
  }
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, domain, title, case_number, court, decision_number, char_count, chunk_count, indexed_at)
     VALUES (?, ?, ?, 'patent', ?, ?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
  )
  insertDoc.run('d1', 'raw', 'case', '专利无效复审决定 008073341', '008073341', null, '566693', 300, 2)
  insertDoc.run('d2', 'raw', 'judgment', '某专利侵权判决', null, '最高人民法院', null, 200, 1)
  insertDoc.run('d3', 'raw', 'case', '另一无效决定', '999999999', null, '777777', 100, 1)
  insertDoc.run('d4', 'wiki', 'case', '创造性-审查标准-磨削抛光', null, null, null, 150, 1)

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, chunk_type, heading, content, char_count)
     VALUES (?, ?, ?, 'paragraph', NULL, ?, ?)`,
  )
  insertChunk.run(1, 'd1', 0, '本案涉及创造性三步法判断，审查员认为技术方案显而易见。', 150)
  insertChunk.run(2, 'd1', 1, '合议组认为区别特征产生了预料不到的技术效果。', 100)
  insertChunk.run(3, 'd2', 0, '判决书正文：创造性判断应采用三步法框架进行认定。', 120)
  insertChunk.run(4, 'd3', 0, '本决定认为权利要求不具备新颖性。', 80)
  insertChunk.run(5, 'd4', 0, '创造性审查标准：技术启示的判断应当结合本领域技术人员认知。', 150)

  if (includePrefix) {
    // install 以每文档最长 chunk 的前 N 个码点填充；这里正文都很短，等价于全文。
    db.exec('ALTER TABLE documents ADD COLUMN search_prefix TEXT')
    const setPrefix = db.prepare('UPDATE documents SET search_prefix = ? WHERE id = ?')
    setPrefix.run('本案涉及创造性三步法判断，审查员认为技术方案显而易见。', 'd1')
    setPrefix.run('判决书正文：创造性判断应采用三步法框架进行认定。', 'd2')
    setPrefix.run('本决定认为权利要求不具备新颖性。', 'd3')
    setPrefix.run('创造性审查标准：技术启示的判断应当结合本领域技术人员认知。', 'd4')
  }

  if (includeFts) {
    const insertFts = db.prepare(
      'INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, \'patent\', NULL)',
    )
    insertFts.run(1, '专利无效复审决定 008073341', '本案涉及创造性三步法判断，审查员认为技术方案显而易见。')
    insertFts.run(2, '专利无效复审决定 008073341', '合议组认为区别特征产生了预料不到的技术效果。')
    insertFts.run(3, '某专利侵权判决', '判决书正文：创造性判断应采用三步法框架进行认定。')
    insertFts.run(4, '另一无效决定', '本决定认为权利要求不具备新颖性。')
    insertFts.run(5, '创造性-审查标准-磨削抛光', '创造性审查标准：技术启示的判断应当结合本领域技术人员认知。')
  }
  db.close()
  return { engine: new CaseLawSearchEngine(dbPath), dir }
}

function withEngine(includeFts = true, includePrefix = false): CaseLawSearchEngine {
  const { engine, dir } = createEngine(includeFts, includePrefix)
  cleanups.push(() => {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return engine
}

describe('CaseLawSearchEngine', () => {
  it('hits via FTS and de-duplicates per document', () => {
    const engine = withEngine()
    const hits = engine.search('创造性')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const d1 = hits.find(h => h.documentId === 'd1')
    expect(d1).toBeDefined()
    expect(d1!.via).toBe('fts')
    expect(hits.filter(h => h.documentId === 'd1')).toHaveLength(1)
    expect(d1!.snippet.length).toBeGreaterThan(0)
  })

  it('orders hits by bm25 ascending (lower is more relevant)', () => {
    const engine = withEngine()
    const hits = engine.search('创造性')
    const ranks = hits.map(h => h.ftsRank ?? 0)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i - 1]!).toBeLessThanOrEqual(ranks[i]!)
    }
  })

  it('filters by doc_type', () => {
    const engine = withEngine()
    const hits = engine.search('创造性', { docType: 'judgment' })
    expect(hits.every(h => h.docType === 'judgment')).toBe(true)
    expect(hits.some(h => h.documentId === 'd2')).toBe(true)
  })

  it('filters by court substring', () => {
    const engine = withEngine()
    const hits = engine.search('创造性', { court: '最高' })
    expect(hits.every(h => h.court?.includes('最高'))).toBe(true)
  })

  it('falls back to LIKE for 2-char queries', () => {
    const engine = withEngine()
    const hits = engine.search('认为')
    expect(hits.some(h => h.documentId === 'd1' && h.snippet.includes('认为'))).toBe(true)
    expect(hits.every(h => h.via === 'like')).toBe(true)
  })

  it('uses the plaintext prefix for short queries when the column exists', () => {
    const engine = withEngine(true, true)
    const hits = engine.search('认为')
    expect(hits.some(h => h.documentId === 'd1' && h.snippet.includes('认为'))).toBe(true)
    expect(hits.every(h => h.via === 'like')).toBe(true)
  })

  it('keeps hit fields identical to the legacy LIKE path', () => {
    const legacy = withEngine(true)
    const prefixed = withEngine(true, true)
    expect(prefixed.search('认为')).toEqual(legacy.search('认为'))
  })

  it('degrades to LIKE when no docs_fts table exists', () => {
    const engine = withEngine(false)
    expect(engine.ftsAvailable).toBe(false)
    const hits = engine.search('认为')
    expect(hits.some(h => h.documentId === 'd1')).toBe(true)
    expect(hits.every(h => h.via === 'like')).toBe(true)
  })

  it('falls back to LIKE when FTS returns no hits', () => {
    const engine = withEngine()
    const hits = engine.search('预料不到的技术效果')
    expect(hits.some(h => h.documentId === 'd1')).toBe(true)
  })

  it('getById returns chunks ordered by chunk_index', () => {
    const engine = withEngine()
    const chunks = engine.getById('d1')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.chunkIndex).toBe(0)
    expect(chunks[1]!.chunkIndex).toBe(1)
    expect(chunks[0]!.content).toContain('三步法')
  })

  it('returns empty for blank queries and honors limit', () => {
    const engine = withEngine()
    expect(engine.search('')).toHaveLength(0)
    expect(engine.search('创造性', { limit: 1 })).toHaveLength(1)
  })

  it('counts documents', () => {
    const engine = withEngine()
    expect(engine.count()).toBe(4)
  })

  it('excludes a source (wiki cards)', () => {
    const engine = withEngine()
    const all = engine.search('创造性')
    expect(all.some(h => h.documentId === 'd4')).toBe(true)
    const rawOnly = engine.search('创造性', { excludeSource: 'wiki' })
    expect(rawOnly.some(h => h.documentId === 'd4')).toBe(false)
    expect(rawOnly.some(h => h.documentId === 'd1')).toBe(true)
  })

  it('reuses the prepared FTS statement across repeated calls', () => {
    const engine = withEngine()
    expect(engine.ftsAvailable).toBe(true)
    const first = engine.search('创造性')
    const second = engine.search('创造性')
    expect(first.map(h => h.documentId)).toEqual(second.map(h => h.documentId))
    expect(first.length).toBeGreaterThanOrEqual(1)
  })

  it('reuses the prepared LIKE statement across repeated calls', () => {
    const engine = withEngine()
    const first = engine.search('认为')
    const second = engine.search('认为')
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(first.map(h => h.documentId).sort()).toEqual(second.map(h => h.documentId).sort())
    expect(first.every(h => h.via === 'like')).toBe(true)
  })
})

/** Fixture whose search_prefix diverges from chunk bodies, proving which path ran. */
function createPrefixOnlyFixture(includePrefix: boolean): { engine: CaseLawSearchEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'case-law-prefix-'))
  const dbPath = join(dir, 'test.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, court TEXT, decision_number TEXT, case_number TEXT, module TEXT,
      indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
  `)
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, court, char_count, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')`,
  )
  insertDoc.run('p1', 'raw', 'case', '无关标题', null, 300)
  insertDoc.run('p2', 'wiki', 'judgment', '另一判决', '最高人民法院', 50)
  insertDoc.run('p3', 'raw', 'case', '无分块文档', null, 0)
  insertDoc.run('p4', 'raw', 'case', '百分号标题', null, 10)
  insertDoc.run('p5', null, 'case', '对照标题', null, 10)
  const insertChunk = db.prepare(
    "INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, ?, 'paragraph', ?, ?)",
  )
  insertChunk.run('p1', 0, '正文不含该词', 100)
  insertChunk.run('p1', 1, '更长的正文片段', 200)
  insertChunk.run('p2', 0, '判决正文片段', 50)
  insertChunk.run('p4', 0, '普通正文', 10)
  insertChunk.run('p5', 0, '普通正文', 10)
  if (includePrefix) {
    db.exec('ALTER TABLE documents ADD COLUMN search_prefix TEXT')
    const setPrefix = db.prepare('UPDATE documents SET search_prefix = ? WHERE id = ?')
    setPrefix.run('前缀命中词', 'p1')
    setPrefix.run('前缀命中词', 'p2')
    setPrefix.run('前缀命中词', 'p3')
    setPrefix.run('100%专利', 'p4')
    setPrefix.run('100X专利', 'p5')
  }
  db.close()
  return { engine: new CaseLawSearchEngine(dbPath), dir }
}

function withPrefixFixture(includePrefix = true): CaseLawSearchEngine {
  const { engine, dir } = createPrefixOnlyFixture(includePrefix)
  cleanups.push(() => {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return engine
}

describe('CaseLawSearchEngine search_prefix path', () => {
  it('matches a prefix-only term and takes the longest chunk as snippet', () => {
    const hits = withPrefixFixture().search('前缀')
    expect(hits.map(h => h.documentId)).toEqual(['p1', 'p2'])
    expect(hits[0]!.snippet).toBe('更长的正文片段')
    expect(hits[0]!.chunkIndex).toBe(1)
    expect(hits[0]!.via).toBe('like')
    expect(hits[0]!.ftsRank).toBeNull()
  })

  it('misses the same prefix-only term without the column (path proof)', () => {
    expect(withPrefixFixture(false).search('前缀')).toEqual([])
  })

  it('applies filters on the prefix path', () => {
    const engine = withPrefixFixture()
    expect(engine.search('前缀', { docType: 'judgment', court: '最高' }).map(h => h.documentId)).toEqual(['p2'])
    expect(engine.search('前缀', { docType: 'judgment', court: '最高', excludeSource: 'wiki' })).toEqual([])
    expect(engine.search('前缀', { docType: 'case' }).map(h => h.documentId)).toEqual(['p1'])
  })

  it('skips documents without chunks and fills the limit from later candidates', () => {
    const engine = withPrefixFixture()
    expect(engine.search('前缀', { limit: 2 }).map(h => h.documentId)).toEqual(['p1', 'p2'])
    expect(engine.search('前缀', { limit: 1 }).map(h => h.documentId)).toEqual(['p1'])
  })

  it('escapes LIKE wildcards in the prefix column', () => {
    expect(withPrefixFixture().search('%').map(h => h.documentId)).toEqual(['p4'])
  })

  it('maps a NULL source column to undefined on the prefix path', () => {
    const hits = withPrefixFixture().search('100X')
    expect(hits.map(h => h.documentId)).toEqual(['p5'])
    expect(hits[0]!.source).toBeUndefined()
  })
})

/** Extra fixture: plain docs_fts table (not FTS5) so FTS statement preparation fails. */
type RowLike = {
  document_id: string
  doc_type: string
  title: string
  decision_number: string | null
  case_number: string | null
  court: string | null
  source: string | null
  module: string | null
  char_count: number
  chunk_index: number
  content: string | null
  fts_rank?: number | null
}

function rowFor(overrides: Partial<RowLike>): RowLike {
  return {
    document_id: 'x',
    doc_type: 'case',
    title: 't',
    decision_number: null,
    case_number: null,
    court: null,
    source: null,
    module: null,
    char_count: 1,
    chunk_index: 0,
    content: null,
    fts_rank: null,
    ...overrides,
  }
}

function asInternals(engine: CaseLawSearchEngine): {
  backfillContent(hits: CaseLawHit[]): CaseLawHit[]
  dedupeByDocument(rows: RowLike[], limit: number): CaseLawHit[]
} {
  return engine as unknown as {
    backfillContent(hits: CaseLawHit[]): CaseLawHit[]
    dedupeByDocument(rows: RowLike[], limit: number): CaseLawHit[]
  }
}

describe('CaseLawSearchEngine edge paths', () => {
  it('degrades to LIKE when FTS statement preparation fails, with stats and logger', () => {
    const warns: string[] = []
    const stats = new KnowledgeRuntimeStats()
    const dir = mkdtempSync(join(tmpdir(), 'case-law-degrade-'))
    const dbPath = join(dir, 'test.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
        title TEXT NOT NULL, file_path TEXT, module TEXT, priority TEXT, level TEXT, publish_date TEXT,
        case_number TEXT, court TEXT, decision_number TEXT, article_number TEXT, content_hash TEXT,
        indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, heading TEXT, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
      );
      CREATE TABLE docs_fts (name TEXT);
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, char_count, chunk_count, indexed_at) VALUES ('d1', 'raw', 'case', '无效决定', 100, 1, '2026-01-01')").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d1', 0, 'p', '认为审查员认定正确', 10)").run()
    db.close()
    const engine = new CaseLawSearchEngine(dbPath, { logger: { warn: m => warns.push(m) }, stats })
    cleanups.push(() => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(engine.ftsAvailable).toBe(false)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/FTS5 不可用，已降级 LIKE/)
    expect(stats.snapshot().caseLawFtsDegraded).toBe(true)
    const hits = engine.search('认为')
    expect(hits.some(h => h.documentId === 'd1')).toBe(true)
    expect(hits.every(h => h.via === 'like')).toBe(true)
  })

  it('falls back to keyword-OR FTS when the whole-phrase query misses', () => {
    const engine = withEngine()
    // "创造性 三步法" has no trigram run in any chunk, but its split keywords hit.
    const hits = engine.search('创造性 三步法')
    expect(hits.some(h => h.documentId === 'd1')).toBe(true)
  })

  it('degrades at runtime when the FTS statement throws, then stays on LIKE', () => {
    const { engine, dir } = createEngine()
    cleanups.push(() => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'test.db'))
    db.exec('DROP TABLE docs_fts')
    db.close()

    expect(engine.ftsAvailable).toBe(true)
    // The prepared FTS statement re-prepares against the dropped table and throws.
    const first = engine.search('创造性')
    expect(first.some(h => h.documentId === 'd1')).toBe(true)
    expect(first.every(h => h.via === 'like')).toBe(true)
    expect(engine.ftsAvailable).toBe(false)
    // Second search short-circuits to LIKE without touching FTS.
    const second = engine.search('认为')
    expect(second.some(h => h.documentId === 'd1')).toBe(true)
    expect(second.every(h => h.via === 'like')).toBe(true)
  })

  it('escapes court filter wildcards and LIKE keyword wildcards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'case-law-escape-'))
    const dbPath = join(dir, 'test.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, source TEXT, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
        title TEXT NOT NULL, case_number TEXT, court TEXT, decision_number TEXT, module TEXT,
        indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
      );
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, court, indexed_at) VALUES ('d1', 'raw', 'case', '某%判决', '最_高_院', '2026-01-01')").run()
    db.prepare("INSERT INTO documents (id, source, doc_type, title, court, indexed_at) VALUES ('d2', 'raw', 'case', '另一判决', '最高人民法院', '2026-01-01')").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d1', 0, 'p', '创造性三步法判断', 10)").run()
    db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d2', 0, 'p', '普通内容', 10)").run()
    db.close()
    const engine = new CaseLawSearchEngine(dbPath)
    cleanups.push(() => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    })

    // "_" in the court filter is escaped to a literal underscore.
    const byCourt = engine.search('创造性', { court: '最_高' })
    expect(byCourt.some(h => h.documentId === 'd1')).toBe(true)
    expect(byCourt.some(h => h.documentId === 'd2')).toBe(false)
    // "%" in the LIKE keyword is escaped: only the literal "%" title matches.
    const byTitle = engine.search('某%判决')
    expect(byTitle.some(h => h.documentId === 'd1')).toBe(true)
  })

  it('runs the dynamic LIKE statement when FTS is unavailable and filters are set', () => {
    const engine = withEngine(false)
    const hits = engine.search('认为', { docType: 'case' })
    expect(hits.some(h => h.documentId === 'd1')).toBe(true)
    expect(hits.every(h => h.docType === 'case')).toBe(true)
    expect(hits.every(h => h.via === 'like')).toBe(true)
  })

  it('de-duplicates a document with multiple matching chunks by best rank', () => {
    const { engine, dir } = createEngine()
    cleanups.push(() => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const db = new DatabaseSync(join(dir, 'test.db'))
    db.prepare("INSERT INTO documents (id, source, doc_type, title, char_count, chunk_count, indexed_at) VALUES ('d5', 'raw', 'case', '创造性多分块判决', 400, 2, '2026-01-01')").run()
    const c1 = db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d5', 0, 'p', '创造性判断应当考虑技术启示。', 10)").run().lastInsertRowid as number
    const c2 = db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d5', 1, 'p', '创造性判断还需要考虑预料不到的效果。', 10)").run().lastInsertRowid as number
    db.prepare("INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, '创造性多分块判决', ?, NULL, 'patent', NULL)").run(c1, '创造性判断应当考虑技术启示。')
    db.prepare("INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, '创造性多分块判决', ?, NULL, 'patent', NULL)").run(c2, '创造性判断还需要考虑预料不到的效果。')
    db.close()

    const hits = engine.search('创造性')
    const d5 = hits.filter(h => h.documentId === 'd5')
    expect(d5).toHaveLength(1)
  })

  it('closes the database when statement preparation fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'case-law-close-'))
    const dbPath = join(dir, 'broken.db')
    const db = new DatabaseSync(dbPath)
    // Missing chunks table: the LIKE statement cannot be prepared.
    db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, source TEXT, doc_type TEXT, title TEXT, char_count INTEGER, indexed_at TEXT)')
    db.close()
    expect(() => new CaseLawSearchEngine(dbPath)).toThrow()
    // A leaked handle would make this recursive removal fail on Windows.
    expect(() => { rmSync(dir, { recursive: true, force: true }) }).not.toThrow()
  })

  it('maps a NULL source column to undefined via FTS back-fill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'case-law-null-source-'))
    const dbPath = join(dir, 'test.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, source TEXT, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
        title TEXT NOT NULL, case_number TEXT, court TEXT, decision_number TEXT, module TEXT,
        indexed_at TEXT NOT NULL, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
        chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
      );
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
    `)
    db.prepare("INSERT INTO documents (id, source, doc_type, title, indexed_at) VALUES ('d1', NULL, 'case', '创造性来源测试', '2026-01-01')").run()
    const c1 = db.prepare("INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES ('d1', 0, 'p', '创造性来源测试内容', 10)").run().lastInsertRowid as number
    db.prepare("INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, '创造性来源测试', ?, NULL, 'patent', NULL)").run(c1, '创造性来源测试内容')
    db.close()
    const engine = new CaseLawSearchEngine(dbPath)
    cleanups.push(() => {
      engine.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const hits = engine.search('创造性')
    expect(hits.some(h => h.documentId === 'd1' && h.source === undefined)).toBe(true)
  })

  it('backfills snippet-bearing hits unchanged and passes through missing chunk rows', () => {
    const engine = withEngine()
    const internals = asInternals(engine)
    const withSnippet = internals.backfillContent([{
      documentId: 'd1',
      docType: 'case',
      title: 't',
      decisionNumber: undefined,
      caseNumber: undefined,
      court: undefined,
      source: undefined,
      module: undefined,
      charCount: 1,
      chunkIndex: 0,
      snippet: '已有片段',
      ftsRank: -1,
      via: 'fts',
    }])
    expect(withSnippet[0]!.snippet).toBe('已有片段')
    // (chunkIndex, documentId) pairs without a chunks row pass the hit through.
    const missingRow = internals.backfillContent([{
      documentId: 'd1',
      docType: 'case',
      title: 't',
      decisionNumber: undefined,
      caseNumber: undefined,
      court: undefined,
      source: undefined,
      module: undefined,
      charCount: 1,
      chunkIndex: 99,
      snippet: '',
      ftsRank: -1,
      via: 'fts',
    }])
    expect(missingRow[0]!.snippet).toBe('')
  })

  it('de-duplicates rows keeping the best (lowest) bm25 rank', () => {
    const engine = withEngine()
    const internals = asInternals(engine)
    const rows: RowLike[] = [
      rowFor({ document_id: 'A', chunk_index: 0, fts_rank: -5 }),
      rowFor({ document_id: 'A', chunk_index: 1, fts_rank: null }), // null is worst → keep -5
      rowFor({ document_id: 'B', chunk_index: 0, fts_rank: null }),
      rowFor({ document_id: 'B', chunk_index: 1, fts_rank: -2 }), // -2 beats null → keep second
      rowFor({ document_id: 'C', chunk_index: 0, fts_rank: null }),
      rowFor({ document_id: 'C', chunk_index: 1, fts_rank: -3 }),
      rowFor({ document_id: 'C', chunk_index: 2, fts_rank: -9 }), // most relevant
    ]
    const hits = internals.dedupeByDocument(rows, 10)
    const byDoc = new Map(hits.map(h => [h.documentId, h]))
    expect(byDoc.get('A')!.chunkIndex).toBe(0)
    expect(byDoc.get('B')!.chunkIndex).toBe(1)
    expect(byDoc.get('C')!.chunkIndex).toBe(2)
    expect(hits.map(h => h.documentId)).toEqual(['C', 'A', 'B'])
  })

  it('keeps a document whose only matched chunk has no bm25 rank', () => {
    const engine = withEngine()
    const internals = asInternals(engine)
    const hits = internals.dedupeByDocument([
      rowFor({ document_id: 'D', chunk_index: 0, fts_rank: null }),
    ], 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ documentId: 'D', ftsRank: null })
  })
})

describe('CaseLawSearchEngine query input', () => {
  it('normalizes the result cap before binding it to SQLite', () => {
    const engine = withEngine()
    expect(engine.search('创造性', { limit: 2.5 })).toHaveLength(2)
    expect(engine.search('创造性', { limit: 0 })).toHaveLength(1)
    expect(engine.search('创造性', { limit: -1 })).toHaveLength(1)
    expect(engine.search('创造性', { limit: Number.NaN })).toHaveLength(3)
    expect(engine.search('创造性', { limit: Number.POSITIVE_INFINITY })).toHaveLength(3)
    // A rejected LIMIT used to escape the ladder as a sticky FTS degradation.
    expect(engine.ftsAvailable).toBe(true)
  })

  it('strips NUL from the search text instead of degrading FTS', () => {
    const engine = withEngine()
    expect(engine.search('创造性\u0000')).toHaveLength(3)
    expect(engine.ftsAvailable).toBe(true)
    expect(engine.search('\u0000')).toEqual([])
  })
})
