// Real-service test: mounts the patent-knowledge service on a real Context
// pointed at an in-test fixture knowledge.db and drives every query engine.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PatentKnowledge from '@deepseek-ai/dsh-patent-knowledge'

/** Build a fixture knowledge.db (documents/chunks/docs_fts + kg_nodes/kg_edges). */
function makeDb(dir: string): string {
  const dbPath = join(dir, 'knowledge.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, doc_type TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'patent',
      title TEXT NOT NULL, level TEXT, court TEXT, decision_number TEXT, case_number TEXT,
      module TEXT, char_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0, indexed_at TEXT NOT NULL, file_path TEXT
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_index INTEGER NOT NULL, chunk_type TEXT NOT NULL, content TEXT NOT NULL, char_count INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE docs_fts USING fts5(title, content, module, domain, tags, tokenize='trigram', content='', contentless_delete=1);
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT
    );
    CREATE TABLE kg_edges (source_id TEXT, target_id TEXT, relation TEXT);
  `)
  const insDoc = db.prepare(
    `INSERT INTO documents (id, source, doc_type, title, level, court, decision_number, case_number, char_count, indexed_at, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', ?)`,
  )
  insDoc.run('case:d1', 'raw', 'case', '创造性三步法无效决定', null, null, '566693', '008073341', 100, null)
  insDoc.run('law:专利法', 'raw', 'law_article', '中华人民共和国专利法', '法律', null, null, null, 100, '法律法规_md/中华人民共和国专利法.md')
  insDoc.run('g:第二部分第八章', 'raw', 'guideline_rule', '专利审查指南 第二部分第八章-实质审查程序', '法律', null, null, null, 100, '审查指南_md/第二部分第八章-实质审查程序.md')
  const insChunk = db.prepare(
    'INSERT INTO chunks (document_id, chunk_index, chunk_type, content, char_count) VALUES (?, ?, \'paragraph\', ?, ?)',
  )
  const c1 = insChunk.run('case:d1', 0, '创造性判断应当采用三步法框架。', 50).lastInsertRowid as number
  const c2 = insChunk.run('law:专利法', 0, '第一条 为了保护专利权人的合法权益，鼓励发明创造。', 50).lastInsertRowid as number
  const c3 = insChunk.run('g:第二部分第八章', 0, '4.1 审查员应当发出审查意见通知书，指出申请文件的缺陷。', 40).lastInsertRowid as number
  const insFts = db.prepare(
    'INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, \'patent\', NULL)',
  )
  insFts.run(c1, '创造性三步法无效决定', '创造性判断应当采用三步法框架。')
  insFts.run(c2, '中华人民共和国专利法', '第一条 为了保护专利权人的合法权益，鼓励发明创造。')
  insFts.run(c3, '专利审查指南 第二部分第八章-实质审查程序', '4.1 审查员应当发出审查意见通知书，指出申请文件的缺陷。')

  db.prepare(
    'INSERT INTO kg_nodes (id, node_type, name, content) VALUES (?, ?, ?, ?)',
  ).run('kg:n1', 'Concept', '创造性', '创造性是指与现有技术相比具有突出的实质性特点。')
  db.prepare(
    'INSERT INTO kg_nodes (id, node_type, name, content) VALUES (?, ?, ?, ?)',
  ).run('kg:n2', 'Concept', '新颖性', '新颖性是指不属于现有技术。')
  db.prepare('INSERT INTO kg_edges (source_id, target_id, relation) VALUES (?, ?, ?)').run('kg:n1', 'kg:n2', 'RELATED_TO')
  db.close()
  return dbPath
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('PatentKnowledge service', () => {
  it('serves every query engine over a fixture knowledge.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-knowledge-svc-'))
    makeDb(dir)
    const ctx = new Context()
    await ctx.plugin(PatentKnowledge, { knowledgeDir: dir })
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    try {
      expect(ctx.patentKnowledge).toBeInstanceOf(PatentKnowledge)

      const caseHits = ctx.patentKnowledge.caseLawSearch('创造性')
      expect(caseHits.some(h => h.documentId === 'case:d1')).toBe(true)

      const lawHits = ctx.patentKnowledge.legalSearch('专利法')
      expect(lawHits.some(h => h.name === '中华人民共和国专利法')).toBe(true)

      // 指南全文走独立语料（guideline_rule）：指南节号从外接 IP 知识库取原文并带来源路径。
      const guidelineHits = ctx.patentKnowledge.guidelineSearch('审查意见通知书')
      expect(guidelineHits.some(h => h.id === 'g:第二部分第八章')).toBe(true)
      expect(guidelineHits[0]?.filename).toBe('审查指南_md/第二部分第八章-实质审查程序.md')
      // 法规引擎不返回指南文档，指南引擎不返回法规文档。
      expect(lawHits.every(h => h.id !== 'g:第二部分第八章')).toBe(true)
      expect(guidelineHits.every(h => h.id !== 'law:专利法')).toBe(true)

      const node = ctx.patentKnowledge.kgGetNode('kg:n1')
      expect(node?.name).toBe('创造性')

      const concepts = ctx.patentKnowledge.kgListByType('Concept')
      expect(concepts.length).toBeGreaterThanOrEqual(2)

      const hits = ctx.patentKnowledge.kgSearch('创造性')
      expect(hits.some(h => h.node.id === 'kg:n1')).toBe(true)

      const similar = ctx.patentKnowledge.kgSimilarNodes('kg:n1')
      expect(similar.map(entry => [entry.node.id, entry.relation])).toEqual([['kg:n2', 'RELATED_TO']])
      const neighbors = ctx.patentKnowledge.kgNeighbors('kg:n1', 'RELATED_TO')
      expect(neighbors.map(entry => entry.targetId)).toEqual(['kg:n2'])

      const classified = ctx.patentKnowledge.ipcClassify('一种无线通信电路，包含集成电路芯片和天线')
      expect(classified[0]!.section).toBe('H')

      // IPC examination-standard lookups run off the shipped asset, no db needed.
      const sectionCards = ctx.patentKnowledge.ipcStandards('A')
      expect(Array.isArray(sectionCards)).toBe(true)
      const articleCards = ctx.patentKnowledge.ipcStandardsByArticle('patent-law-a22.3')
      expect(Array.isArray(articleCards)).toBe(true)
      const searched = ctx.patentKnowledge.ipcStandardsSearch('新颖性')
      expect(Array.isArray(searched)).toBe(true)
      const searchedDefault = ctx.patentKnowledge.ipcStandardsSearch('A')
      expect(Array.isArray(searchedDefault)).toBe(true)

      // wiki dir is absent in the fixture: keyword and prefix lookups degrade to empty.
      expect(ctx.patentKnowledge.wikiCards('创造性')).toEqual([])
      expect(ctx.patentKnowledge.wikiCardsIn('专利实务/说明书', '')).toEqual([])
      expect(ctx.patentKnowledge.wikiContext('专利实务/说明书/missing')).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults the node-cache bound when the config omits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-knowledge-cache-default-'))
    makeDb(dir)
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const ctx = new Context()
    // Constructing the service directly skips the Loader's schema defaulting,
    // so the constructor resolves the omitted bound itself.
    const service = new PatentKnowledge(ctx, { knowledgeDir: dir })
    try {
      expect(service.kgGetNode('kg:n1')?.name).toBe('创造性')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes ctx.patentKnowledge when its fiber disposes (HMR safety)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-knowledge-hmr-'))
    makeDb(dir)
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const ctx = new Context()
    const fiber = ctx.plugin(PatentKnowledge, { knowledgeDir: dir })
    await fiber
    expect(ctx.patentKnowledge).toBeInstanceOf(PatentKnowledge)
    await fiber.dispose()
    expect(ctx.get('patentKnowledge')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
