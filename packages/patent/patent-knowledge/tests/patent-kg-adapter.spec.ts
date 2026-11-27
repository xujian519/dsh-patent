import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KgStore, PatentKgAdapter, resolveNodeTypes } from '@deepseek-ai/dsh-patent-knowledge'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** Small knowledge.db graph: keyword hit + similar/cite relations incl. missing targets. */
function makeStore(): { adapter: PatentKgAdapter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'patent-kg-adapter-'))
  const dbPath = join(dir, 'knowledge.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY, node_type TEXT, name TEXT, title TEXT, content TEXT,
      law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT
    );
    CREATE TABLE kg_edges (source_id TEXT, target_id TEXT, relation TEXT);
    CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(name, title, tokenize='trigram', content='', contentless_delete=1);
  `)
  const insNode = db.prepare('INSERT INTO kg_nodes (id, node_type, name, content) VALUES (?, ?, ?, ?)')
  insNode.run('n1', 'Concept', '创造性', '创造性是指与现有技术相比具有突出的实质性特点。')
  insNode.run('n2', 'Concept', '新颖性', '新颖性是指不属于现有技术。')
  insNode.run('n3', 'SupremeCourtJudgment', '判决', '判决书正文。')
  // 真库（knowledge-lite.db）里这类节点的 node_type 就是 Judgment，不带法院前缀。
  insNode.run('n5', 'Judgment', '某判决', '判决书正文。')
  const insFts = db.prepare('INSERT INTO kg_nodes_fts (rowid, name, title) VALUES (?, ?, NULL)')
  insFts.run(1, '创造性')
  insFts.run(2, '新颖性')
  insFts.run(3, '判决')
  const insEdge = db.prepare('INSERT INTO kg_edges (source_id, target_id, relation) VALUES (?, ?, ?)')
  insEdge.run('n1', 'n2', 'RELATED_TO')
  insEdge.run('n1', 'n2', 'SIMILAR_TO')  // duplicate target: skipped on the second relation
  insEdge.run('n1', 'n4', 'SIMILAR_TO')  // missing target: skipped
  insEdge.run('n1', 'n1', 'CITES')       // self-loop: already seen
  insEdge.run('n1', 'n3', 'CITES')
  insEdge.run('n1', 'n3', 'REFERENCES')  // duplicate target: skipped
  insEdge.run('n1', 'n4', 'REFERENCES')  // missing target: skipped
  db.close()
  const adapter = new PatentKgAdapter(new KgStore(dbPath))
  cleanups.push(() => {
    adapter.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { adapter, dir }
}

describe('resolveNodeTypes', () => {
  it('maps aliases exactly, case-insensitively, and passes through unknown types', () => {
    expect(resolveNodeTypes('')).toEqual([])
    expect(resolveNodeTypes('  ')).toEqual([])
    expect(resolveNodeTypes('Judgment')).toEqual(['Judgment', 'SupremeCourtJudgment', 'RegionalCourtJudgment'])
    expect(resolveNodeTypes('LawArticle')).toEqual(['LawArticle', 'Clause', 'Chapter'])
    expect(resolveNodeTypes('lawarticle')).toEqual(['lawarticle', 'Clause', 'Chapter'])
    expect(resolveNodeTypes('judgment')).toEqual(['judgment', 'SupremeCourtJudgment', 'RegionalCourtJudgment'])
    expect(resolveNodeTypes('IPC')).toEqual(['IPC'])
    expect(resolveNodeTypes('  Concept  ')).toEqual(['Concept', 'ConceptDetail', '一级概念', '二级概念', '三级概念'])
  })

  it('browses the requested type even when the corpus stores it under that exact name', () => {
    const { adapter } = makeStore()
    // 消费方（patent_kg_query 的类型浏览）逐个 listByType(resolveNodeTypes(...))；
    // 展开结果不含原名 'Judgment' 时这里的浏览会恒为 0 条。
    const found = resolveNodeTypes('Judgment').flatMap(type => adapter.listByType(type))
    expect(found.some(node => node.id === 'n5')).toBe(true)
  })
})

describe('PatentKgAdapter', () => {
  it('gets nodes and reports the FTS mode', () => {
    const { adapter } = makeStore()
    expect(adapter.getNode('n1')?.name).toBe('创造性')
    expect(adapter.getNode('nope')).toBeUndefined()
    expect(adapter.ftsMode()).toBe('trigram')
  })

  it('searches keywords and expands similar/cite relations with dedupe', () => {
    const { adapter } = makeStore()
    const hits = adapter.searchRelevant('创造性')
    expect(hits.filter(h => h.via === 'keyword').map(h => h.node.id)).toEqual(['n1'])
    expect(hits.filter(h => h.via === 'similar').map(h => h.node.id)).toEqual(['n2'])
    expect(hits.filter(h => h.via === 'cites').map(h => h.node.id)).toEqual(['n3'])
  })

  it('supports OR mode and custom limits', () => {
    const { adapter } = makeStore()
    const hits = adapter.searchRelevant('创造性 新颖性', { mode: 'or', keywordLimit: 5, expandLimit: 2 })
    expect(hits.some(h => h.node.id === 'n1')).toBe(true)
    expect(hits.some(h => h.node.id === 'n2')).toBe(true)
  })

  it('returns similar nodes, lists by type, and reads neighbors', () => {
    const { adapter } = makeStore()
    const similar = adapter.getSimilarNodes('n1')
    expect(similar.map(s => s.node.id)).toEqual(['n2'])
    expect(adapter.getSimilarNodes('n1', 1).length).toBeGreaterThanOrEqual(1)

    const concepts = adapter.listByType('Concept')
    expect(concepts.map(n => n.id).sort()).toEqual(['n1', 'n2'])
    expect(adapter.listByType('Concept', 1)).toHaveLength(1)

    const neighbors = adapter.getNeighbors('n1')
    expect(neighbors.some(n => n.targetId === 'n3')).toBe(true)
    const cites = adapter.getNeighbors('n1', 'CITES')
    expect(cites.some(n => n.targetId === 'n3')).toBe(true)
  })
})
