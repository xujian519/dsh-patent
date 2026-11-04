import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KgStore } from '@deepseek-ai/dsh-patent-knowledge'

/**
 * KgStore tests over small fixture graphs. The unified fixture mirrors
 * knowledge.db (kg_nodes/kg_edges/kg_nodes_fts with trigram FTS over name/title
 * only, so content-only phrases exercise the LIKE fallback); legacy fixtures
 * mirror the old patent_kg.db schema.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function withStore(dbPath: string): KgStore {
  const store = new KgStore(dbPath)
  cleanups.push(() => { store.close() })
  return store
}

function createUnifiedSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT
    );
    CREATE TABLE kg_edges (source_id TEXT, target_id TEXT, relation TEXT);
  `)
}

function insertUnifiedRows(db: DatabaseSync): void {
  const insNode = db.prepare('INSERT INTO kg_nodes (id, node_type, name, content) VALUES (?, ?, ?, ?)')
  insNode.run('n1', 'Concept', '创造性', '创造性是指与现有技术相比具有突出的实质性特点。')
  insNode.run('n2', 'Concept', '新颖性', '新颖性是指不属于现有技术。')
  insNode.run('n3', 'SupremeCourtJudgment', '判决', '判决书正文。')
  insNode.run('n5', 'Concept', '创造%标准', '特殊字符节点。')
  insNode.run('n6', 'Concept', '细则', '判断标准应当结合本领域技术人员的认知水平。')
  const insEdge = db.prepare('INSERT INTO kg_edges (source_id, target_id, relation) VALUES (?, ?, ?)')
  insEdge.run('n1', 'n2', 'RELATED_TO')
  insEdge.run('n1', 'n2', 'SIMILAR_TO')
  insEdge.run('n1', 'n4', 'SIMILAR_TO') // n4 has no kg_nodes row
  insEdge.run('n1', 'n1', 'CITES')      // self-loop
  insEdge.run('n1', 'n3', 'CITES')
  insEdge.run('n1', 'n3', 'REFERENCES')
  insEdge.run('n1', 'n4', 'REFERENCES') // missing target in the cites loop
  insEdge.run('n2', 'n3', 'CITES')
}

function makeUnifiedDb(dir: string, withFts = true): string {
  const dbPath = join(dir, 'knowledge.db')
  const db = new DatabaseSync(dbPath)
  createUnifiedSchema(db)
  if (withFts) {
    db.exec("CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(name, title, tokenize='trigram', content='', contentless_delete=1)")
  }
  insertUnifiedRows(db)
  if (withFts) {
    const insFts = db.prepare('INSERT INTO kg_nodes_fts (rowid, name, title) VALUES (?, ?, NULL)')
    insFts.run(1, '创造性')
    insFts.run(2, '新颖性')
    insFts.run(3, '判决')
    insFts.run(4, '创造%标准')
  }
  db.close()
  return dbPath
}

/**
 * Unified fixture whose trigram FTS indexes name/title/content and stays row-aligned
 * with kg_nodes. `stale` omits n6 from the FTS index; `unindexedContent` keeps the
 * row count aligned while indexing NULL content; both exercise the LIKE fallback.
 */
function makeContentFtsDb(
  dir: string,
  options: { stale?: boolean; unindexedContent?: boolean; emptyContent?: boolean } = {},
): string {
  const dbPath = join(dir, 'knowledge.db')
  const db = new DatabaseSync(dbPath)
  createUnifiedSchema(db)
  db.exec(
    "CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(name, title, content, tokenize='trigram', content='', contentless_delete=1)",
  )
  insertUnifiedRows(db)
  // Share the four-character phrase with n6 so the ordered whole-phrase batch returns
  // them in rowid order (n1 then n6).
  db.prepare("UPDATE kg_nodes SET content = ? WHERE id = 'n1'")
    .run('创造性判断标准是指与现有技术相比具有突出的实质性特点。')
  if (options.emptyContent) db.exec('UPDATE kg_nodes SET content = NULL')
  const rows = db.prepare('SELECT rowid, id, name, title, content FROM kg_nodes ORDER BY rowid').all() as Array<{
    rowid: number
    id: string
    name: string | null
    title: string | null
    content: string | null
  }>
  const insFts = db.prepare('INSERT INTO kg_nodes_fts (rowid, name, title, content) VALUES (?, ?, ?, ?)')
  for (const row of rows) {
    if (options.stale && row.id === 'n6') continue
    insFts.run(row.rowid, row.name, row.title, options.unindexedContent ? null : row.content)
  }
  db.close()
  return dbPath
}

function makeLegacyDb(dir: string, ftsTable: 'trigram' | 'unicode61' | 'broken' | 'none'): string {
  const dbPath = join(dir, 'patent_kg.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs_count INTEGER, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT, version TEXT
    );
    CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);
  `)
  if (ftsTable === 'trigram') {
    db.exec("CREATE VIRTUAL TABLE nodes_fts_trigram USING fts5(id, name, title, tokenize='trigram')")
    db.prepare('INSERT INTO nodes_fts_trigram (id, name, title) VALUES (?, ?, NULL)').run('n1', '创造性')
  } else if (ftsTable === 'unicode61') {
    db.exec('CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title)')
    db.prepare('INSERT INTO nodes_fts (id, name, title) VALUES (?, ?, NULL)').run('n1', '创造性')
  } else if (ftsTable === 'broken') {
    db.exec('CREATE TABLE nodes_fts (id TEXT, name TEXT, title TEXT)')
  }
  db.prepare('INSERT INTO nodes (id, node_type, name, content) VALUES (?, ?, ?, ?)').run('n1', 'Concept', '创造性', '创造性判断标准。')
  db.prepare('INSERT INTO edges (source, target, relation) VALUES (?, ?, ?)').run('n1', 'n2', 'RELATED_TO')
  db.close()
  return dbPath
}

describe('KgStore unified schema', () => {
  it('reports the schema kind and trigram FTS mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-unified-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    expect(store.schemaKind()).toBe('unified')
    expect(store.ftsMode()).toBe('trigram')
  })

  it('caches getNode hits and misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-cache-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    expect(store.getNode('n1')?.name).toBe('创造性')
    expect(store.getNode('n1')?.name).toBe('创造性') // cache hit
    expect(store.getNode('nope')).toBeUndefined()
    expect(store.getNode('nope')).toBeUndefined() // cached miss
  })

  it('keeps getNode semantics under a one-entry bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-cache-bound-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = new KgStore(makeUnifiedDb(dir, true), { nodeCacheMaxEntries: 1 })
    cleanups.push(() => { store.close() })
    expect(store.getNode('n1')?.name).toBe('创造性')
    expect(store.getNode('n1')?.name).toBe('创造性') // the bound only decides what stays cached
    expect(store.getNode('nope')).toBeUndefined()
    expect(store.getNode('n1')?.id).toBe('n1')
  })

  it('searches via FTS, falls back to LIKE on FTS miss, and rejects blank queries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-search-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    expect(store.searchByKeyword('创造性', 10).map(n => n.id)).toContain('n1')
    // kg_nodes_fts indexes name/title only: a content-only phrase hits LIKE.
    expect(store.searchByKeyword('实质性特点', 10).map(n => n.id)).toContain('n1')
    // A separated phrase skips the LIKE fallback (near-zero recall).
    expect(store.searchByKeyword('创造性 三步法', 10)).toEqual([])
    expect(store.searchByKeyword('   ')).toEqual([])
  })

  it('normalizes the result cap and strips NUL before querying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-query-input-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    // Two content-only matches reach the LIKE fallback; the cap keeps one.
    expect(store.searchByKeyword('现有技术', 10)).toHaveLength(2)
    expect(store.searchByKeyword('现有技术', 1.5)).toHaveLength(1)
    expect(store.searchByKeyword('现有技术', -1)).toHaveLength(1)
    expect(store.searchByKeyword('现有技术', Number.NaN)).toHaveLength(2)
    // A NUL used to reach FTS5 as an unterminated phrase and surface as a raw
    // SQLite error; it is never part of a searchable term.
    expect(store.searchByKeyword('\u0000')).toEqual([])
    expect(store.searchByKeyword('创造性\u0000').map(node => node.id)).toContain('n1')
  })

  it('searches without FTS via LIKE and escapes wildcards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-like-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, false))
    expect(store.ftsMode()).toBe('none')
    const hits = store.searchByKeyword('创造%', 10)
    expect(hits.some(n => n.id === 'n5')).toBe(true)
    expect(hits.some(n => n.id === 'n1')).toBe(false) // "%" is a literal, not a wildcard
  })

  it('runs OR-mode searches across separators, windows, and LIKE terms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-or-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    // Separated multi-word query: both words become FTS terms.
    expect(store.searchByKeyword('创造性 新颖性', 10, { mode: 'or' }).map(n => n.id).sort()).toEqual(['n1', 'n2'])
    // Two-char terms go to the multi-term LIKE scan.
    expect(store.searchByKeyword('创造 新颖', 10, { mode: 'or' }).map(n => n.id).sort()).toContain('n1')
    // Exactly one LIKE term after one-char words are dropped: single-term scan.
    expect(store.searchByKeyword('创造 的', 10, { mode: 'or' }).map(n => n.id)).toContain('n1')
    // Short unseparated word collects directly.
    expect(store.searchByKeyword('创造性', 5, { mode: 'or' }).map(n => n.id)).toContain('n1')
    // Long unseparated word: whole-word LIKE + 2-char window LIKE terms.
    expect(store.searchByKeyword('创造性判断', 10, { mode: 'or' }).map(n => n.id)).toContain('n1')
    // Long word with a whole-word LIKE hit (literal % in the target name).
    expect(store.searchByKeyword('创造%标', 10, { mode: 'or' }).map(n => n.id)).toContain('n5')
    // 6+ runes use a 3-char window: windows become FTS terms.
    expect(store.searchByKeyword('创造性判断标准', 10, { mode: 'or' }).map(n => n.id)).toContain('n1')
    // FTS misses a content-only 3-char word; the final whole-word LIKE fallback hits.
    expect(store.searchByKeyword('判断标', 10, { mode: 'or' }).map(n => n.id)).toContain('n6')
    // No candidate hits: a final whole-word LIKE fallback still runs.
    expect(store.searchByKeyword('无此词汇', 10, { mode: 'or' })).toEqual([])
    // One-char terms are dropped; a separated phrase gets no fallback.
    expect(store.searchByKeyword('创 新', 10, { mode: 'or' })).toEqual([])
  })

  it('uses a content-complete trigram index for content-only phrases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-content-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeContentFtsDb(dir))
    // Both phrases live only in content, which this fixture indexes.
    expect(store.searchByKeyword('实质性特点', 10).map(n => n.id)).toContain('n1')
    expect(store.searchByKeyword('判断标准应当', 10).map(n => n.id)).toContain('n6')
    // A miss returns no rows directly; the whole-table LIKE fallback is skipped.
    expect(store.searchByKeyword('无此词汇', 10)).toEqual([])
  })

  it('keeps rowid order for the OR whole-phrase batch and fills with window terms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-content-order-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeContentFtsDb(dir))
    // The whole phrase hits n1 (rowid 1) and n6 (rowid 5); the 2-char window adds n5.
    expect(store.searchByKeyword('判断标准', 10, { mode: 'or' }).map(n => n.id)).toEqual(['n1', 'n6', 'n5'])
    // A limit filled by the whole-phrase batch skips window expansion.
    expect(store.searchByKeyword('判断标准', 1, { mode: 'or' }).map(n => n.id)).toEqual(['n1'])
    // Whole phrase misses; 2-char windows still recall both concepts.
    const windowed = store.searchByKeyword('创造新颖', 10, { mode: 'or' }).map(n => n.id)
    expect(windowed).toContain('n1')
    expect(windowed).toContain('n2')
    // Two-char queries stay on the LIKE path.
    expect(store.searchByKeyword('创造', 10, { mode: 'or' }).map(n => n.id)).toContain('n1')
    // No candidate hits: the whole-word LIKE fallback is not re-run.
    expect(store.searchByKeyword('无此词汇', 10, { mode: 'or' })).toEqual([])
  })

  it('falls back to LIKE when the content index row count is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-content-stale-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeContentFtsDb(dir, { stale: true }))
    // n6 is missing from the FTS index: the count check disables the fast path,
    // so the content-only phrase still comes back through LIKE.
    expect(store.searchByKeyword('判断标准应当', 10).map(n => n.id)).toContain('n6')
  })

  it('falls back to LIKE when the declared content column was indexed empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-content-unindexed-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeContentFtsDb(dir, { unindexedContent: true }))
    // Row counts match, but the column-filtered probe misses: LIKE still finds n6.
    expect(store.searchByKeyword('判断标准应当', 10).map(n => n.id)).toContain('n6')
  })

  it('keeps the fast path when no node carries content to probe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-content-empty-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeContentFtsDb(dir, { emptyContent: true }))
    expect(store.searchByKeyword('创造性', 10).map(n => n.id)).toEqual(['n1'])
    expect(store.searchByKeyword('判断标准应当', 10)).toEqual([])
  })

  it('traverses neighbors, lists by type, and expands to depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-graph-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeUnifiedDb(dir, true))
    const neighbors = store.getNeighbors('n1')
    expect(neighbors.some(n => n.targetId === 'n2' && n.relation === 'RELATED_TO')).toBe(true)
    const cites = store.getNeighbors('n1', 'CITES')
    expect(cites.map(n => n.targetId).sort()).toEqual(['n1', 'n3'])

    const concepts = store.listByType('Concept')
    expect(concepts.map(n => n.id).sort()).toEqual(['n1', 'n2', 'n5', 'n6'])
    expect(store.listByType('Concept', 1)).toHaveLength(1)

    // Depth 2: n1 → n2 → n3; self-loop and missing target are skipped.
    const expanded = store.expandNeighbors('n1')
    expect(expanded.map(e => e.node.id).sort()).toEqual(['n2', 'n3'])
    expect(store.expandNeighbors('n1', 'RELATED_TO', 1, 5).map(e => e.node.id)).toEqual(['n2'])
  })

  it('closes the underlying database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-close-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const dbPath = makeUnifiedDb(dir, true)
    const store = new KgStore(dbPath)
    expect(store.getNode('n1')?.id).toBe('n1')
    store.close()
  })
})

describe('KgStore legacy schema', () => {
  it('detects the legacy trigram FTS table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-legacy-tri-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeLegacyDb(dir, 'trigram'))
    expect(store.schemaKind()).toBe('legacy')
    expect(store.ftsMode()).toBe('trigram')
    expect(store.searchByKeyword('创造性', 5).map(n => n.id)).toContain('n1')
    // OR mode with two LIKE terms runs the multi-term scan against the legacy nodes table.
    expect(store.searchByKeyword('创造 新颖', 10, { mode: 'or' }).map(n => n.id)).toContain('n1')
  })

  it('detects the legacy unicode61 FTS table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-legacy-uni-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeLegacyDb(dir, 'unicode61'))
    expect(store.ftsMode()).toBe('unicode61')
  })

  it('degrades to none when the legacy FTS statement cannot be prepared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-legacy-broken-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const store = withStore(makeLegacyDb(dir, 'broken'))
    expect(store.ftsMode()).toBe('none')
    expect(store.searchByKeyword('创造性', 5).map(n => n.id)).toContain('n1')
  })

  it('fails loud when no graph tables exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-failclosed-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const dbPath = join(dir, 'empty.db')
    new DatabaseSync(dbPath).close()
    expect(() => new KgStore(dbPath)).toThrow(/知识图谱表/)
  })
})

describe('KgStore edge-table validation', () => {
  it('names the missing unified edge table and dbPath, then releases the handle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-missing-edge-'))
    const dbPath = join(dir, 'knowledge.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE kg_nodes (
        id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
        law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT
      );
    `)
    db.close()
    let message = ''
    try {
      new KgStore(dbPath)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('kg_edges')
    expect(message).toContain(dbPath)
    // A leaked handle would make this recursive removal fail on Windows.
    expect(() => { rmSync(dir, { recursive: true, force: true }) }).not.toThrow()
  })

  it('names the missing legacy edge table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-missing-legacy-edge-'))
    const dbPath = join(dir, 'patent_kg.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)')
    db.close()
    expect(() => new KgStore(dbPath)).toThrow(/边表（edges）/)
    expect(() => { rmSync(dir, { recursive: true, force: true }) }).not.toThrow()
  })
})
