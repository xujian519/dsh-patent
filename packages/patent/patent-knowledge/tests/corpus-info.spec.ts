import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeDbVersionError, readCorpusInfo } from '@deepseek-ai/dsh-patent-knowledge'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Build a knowledge.db-shaped file with the requested freshness tables. */
function makeDb(options: { indexMeta?: boolean; versionHistory?: boolean; userVersion?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-corpus-info-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  const path = join(dir, 'knowledge.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA application_id = 0x53415449')
  db.exec(`PRAGMA user_version = ${options.userVersion ?? 1}`)
  if (options.indexMeta !== false) {
    db.exec('CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?)')
    insert.run('last_indexed_at', '2026-07-02T10:59:39.174Z')
    insert.run('total_docs', '81038')
    insert.run('total_chunks', '138609')
  }
  if (options.versionHistory !== false) {
    db.exec('CREATE TABLE version_history (version INTEGER NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL, doc_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0)')
    db.prepare('INSERT INTO version_history (version, created_at, description, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)')
      .run(2, '2026-06-01T00:00:00.000Z', 'older', 500, 900)
    db.prepare('INSERT INTO version_history (version, created_at, description, doc_count, chunk_count) VALUES (?, ?, ?, ?, ?)')
      .run(3, '2026-07-02T10:00:00.000Z', 'latest', 80000, 130000)
  }
  db.close()
  return path
}

describe('readCorpusInfo', () => {
  it('reads the upstream build time, latest version and size', () => {
    const info = readCorpusInfo(makeDb())
    expect(info).toMatchObject({
      lastIndexedAt: '2026-07-02T10:59:39.174Z',
      version: 3,
      versionCreatedAt: '2026-07-02T10:00:00.000Z',
      documents: 81038,
      chunks: 138609,
    })
    expect(Number.isNaN(Date.parse(info.fileModifiedAt))).toBe(false)
  })

  it('falls back to the latest version_history row when index_meta is absent', () => {
    const info = readCorpusInfo(makeDb({ indexMeta: false }))
    expect(info.lastIndexedAt).toBeUndefined()
    expect(info).toMatchObject({ version: 3, documents: 80000, chunks: 130000 })
  })

  it('reports only the local copy time when neither table exists', () => {
    const info = readCorpusInfo(makeDb({ indexMeta: false, versionHistory: false }))
    expect(info.lastIndexedAt).toBeUndefined()
    expect(info.version).toBeUndefined()
    expect(info.documents).toBeUndefined()
    expect(Number.isNaN(Date.parse(info.fileModifiedAt))).toBe(false)
  })

  it('refuses a database from a future schema version', () => {
    expect(() => readCorpusInfo(makeDb({ userVersion: 99 }))).toThrow(KnowledgeDbVersionError)
  })
})
