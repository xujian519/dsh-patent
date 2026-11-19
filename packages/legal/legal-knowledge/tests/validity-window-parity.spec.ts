/**
 * F-LEG-013: the SQLite and in-memory backends must return the same visible
 * records when the expired ones fill the recall window.
 *
 * Filtering after truncation loses a current version that sits behind expired
 * ones: the caller sees an empty result and reads it as "not in this deployment".
 * Both backends therefore filter first and truncate second.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LegalRegulationSearchEngine } from '@deepseek-ai/dsh-legal-knowledge'
import type { LegalRegulationRecord } from '@deepseek-ai/dsh-legal-knowledge'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-knowledge-validity-window-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One expired version of the same regulation. */
function expired(id: string, expiryDate: string): LegalRegulationRecord {
  return {
    regulationId: id,
    regulationName: '中华人民共和国民法典',
    level: '法律',
    effectiveDate: '2001-01-01',
    expiryDate,
    expired: 1,
    validity: 'unverified',
    articleNumber: 577,
    articleText: '当事人一方不履行合同义务的，应当承担违约责任。',
  }
}

/** The current version, last in insertion order so a fixed window misses it. */
const CURRENT: LegalRegulationRecord = {
  regulationId: 'reg-current',
  regulationName: '中华人民共和国民法典',
  level: '法律',
  effectiveDate: '2021-01-01',
  validity: 'unverified',
  articleNumber: 577,
  articleText: '当事人一方不履行合同义务的，应当承担违约责任。',
}

/** Three expired versions ahead of the current one. */
const RECORDS: LegalRegulationRecord[] = [
  expired('reg-1', '2010-12-31'),
  expired('reg-2', '2015-12-31'),
  expired('reg-3', '2020-12-31'),
  CURRENT,
]

function createLegalDb(path: string, records: readonly LegalRegulationRecord[] = RECORDS): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE legal_regulations (
        id INTEGER PRIMARY KEY, regulation_id TEXT UNIQUE, regulation_name TEXT, level TEXT,
        publish_date TEXT, effective_date TEXT, expiry_date TEXT, expired INTEGER,
        article_number INTEGER, article_text TEXT
      );
      CREATE VIRTUAL TABLE legal_regulations_fts USING fts5(
        regulation_name, article_text, content='legal_regulations', content_rowid='id'
      );
    `)
    for (const [index, record] of records.entries()) {
      db.prepare(`
        INSERT INTO legal_regulations VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        index + 1, record.regulationId, record.regulationName, record.level,
        record.effectiveDate, record.expiryDate ?? null, record.expired ?? null,
        record.articleNumber, record.articleText,
      )
      db.prepare(`
        INSERT INTO legal_regulations_fts(rowid, regulation_name, article_text) VALUES (?, ?, ?)
      `).run(index + 1, record.regulationName, record.articleText)
    }
  } finally {
    db.close()
  }
}

function engines(): { sqlite: LegalRegulationSearchEngine; memory: LegalRegulationSearchEngine } {
  const dbPath = join(tempDir(), 'legal.db')
  createLegalDb(dbPath)
  return {
    sqlite: new LegalRegulationSearchEngine({ dbPath }),
    memory: new LegalRegulationSearchEngine(RECORDS),
  }
}

/** The page size one name lookup reads; a full page means another page follows. */
const PAGE_SIZE = 50

describe('效力窗口内的可见记录（F-LEG-013）', () => {
  it('一页读满时继续翻页，直到凑满可见记录', () => {
    // 一页 50 行：前 50 条全失效，第 51 条是现行版本。凑不满就不翻页，
    // 现行版本会落在窗口之外。
    const many: LegalRegulationRecord[] = []
    for (let index = 1; index <= PAGE_SIZE; index += 1) many.push(expired(`reg-${String(index)}`, '2020-12-31'))
    many.push(CURRENT)
    const dbPath = join(tempDir(), 'legal.db')
    createLegalDb(dbPath, many)
    const sqlite = new LegalRegulationSearchEngine({ dbPath })
    const memory = new LegalRegulationSearchEngine(many)
    try {
      const options = { asOf: '2025-01-01' }
      const sqliteIds = sqlite.findByName('民法典', 1, options).map(record => record.regulationId)
      const memoryIds = memory.findByName('民法典', 1, options).map(record => record.regulationId)
      expect(sqliteIds).toEqual(memoryIds)
      expect(sqliteIds).toEqual(['reg-current'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('findByName 在 SQLite 与内存后端给出同一集合，现行版本不被失效版本挤出窗口', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      const sqliteIds = sqlite.findByName('民法典', 1, options).map(record => record.regulationId)
      const memoryIds = memory.findByName('民法典', 1, options).map(record => record.regulationId)
      expect(sqliteIds).toEqual(memoryIds)
      expect(memoryIds).toEqual(['reg-current'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('search 在 SQLite 与内存后端给出同一集合', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      const sqliteIds = sqlite.search('违约', { ...options, limit: 1 }).map(hit => hit.regulationId)
      const memoryIds = memory.search('违约', { ...options, limit: 1 }).map(hit => hit.regulationId)
      expect(sqliteIds).toEqual(memoryIds)
      expect(memoryIds).toEqual(['reg-current'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('翻页不重不漏：分页结果与一次取全的结果相同', () => {
    const { sqlite } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      // 每页一条，逐页翻；分页顺序必须稳定，否则会漏行或重复行。
      const paged = sqlite.search('违约', { ...options, limit: 1 }).map(hit => hit.regulationId)
      const whole = sqlite.search('违约', { ...options, limit: 10 }).map(hit => hit.regulationId)
      expect(paged).toEqual(whole)
      expect(new Set(paged).size).toBe(paged.length)
    } finally {
      sqlite.close()
    }
  })

  it('上限大于可见记录数时按可见记录数返回，不补齐失效版本', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      for (const limit of [1, 2, 10]) {
        const sqliteIds = sqlite.findByName('民法典', limit, options).map(record => record.regulationId)
        const memoryIds = memory.findByName('民法典', limit, options).map(record => record.regulationId)
        expect(sqliteIds, `limit ${String(limit)}`).toEqual(memoryIds)
        expect(sqliteIds, `limit ${String(limit)}`).toEqual(['reg-current'])
      }
    } finally {
      sqlite.close()
      memory.close()
    }
  })
})
