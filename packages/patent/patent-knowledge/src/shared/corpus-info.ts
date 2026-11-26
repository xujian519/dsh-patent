/**
 * 本地知识库的语料新鲜度读取：把 `index_meta`（上游索引构建时间与规模）、
 * `version_history`（最新版本行）与数据库文件的修改时间组装成 {@link CorpusInfo}。
 *
 * 只读打开；版本不符按 `openKnowledgeDb` 的协议 fail-loud，绝不把陌生库当作本库读。
 * @module @deepseek-ai/dsh-patent-knowledge/shared/corpus-info
 */

import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { openKnowledgeDb } from './db-version.ts'
import { KNOWLEDGE_DB } from './schema-versions.ts'
import type { CorpusInfo } from '../types.ts'

/** 表是否存在（旧库可能没有 index_meta / version_history）。 */
function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined
  return row !== undefined
}

/** 读取 index_meta 的 key/value 行；表缺席时为空。 */
function readIndexMeta(db: DatabaseSync): Record<string, string> {
  if (!tableExists(db, 'index_meta')) return {}
  const rows = db.prepare('SELECT key, value FROM index_meta').all() as Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map(row => [row.key, row.value]))
}

/** 把 index_meta 的数字字符串解析成非负整数；无法解析时 undefined。 */
function toCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** 最新 version_history 行的版本与规模；表缺席或为空时 undefined。 */
function readLatestVersion(
  db: DatabaseSync,
): { version: number; createdAt: string; documents: number; chunks: number } | undefined {
  if (!tableExists(db, 'version_history')) return undefined
  const row = db
    .prepare('SELECT version, created_at, doc_count, chunk_count FROM version_history ORDER BY version DESC LIMIT 1')
    .get() as { version: number; created_at: string; doc_count: number; chunk_count: number } | undefined
  if (row === undefined) return undefined
  return { version: row.version, createdAt: row.created_at, documents: row.doc_count, chunks: row.chunk_count }
}

/**
 * Read one knowledge database's corpus freshness and size.
 * @param dbPath - the database the query engines open.
 * @returns the corpus facts; fields the database does not record are omitted.
 */
export function readCorpusInfo(dbPath: string): CorpusInfo {
  const fileModifiedAt = statSync(dbPath).mtime.toISOString()
  const { db } = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true })
  try {
    const meta = readIndexMeta(db)
    const latest = readLatestVersion(db)
    const documents = toCount(meta.total_docs) ?? latest?.documents
    const chunks = toCount(meta.total_chunks) ?? latest?.chunks
    return {
      dbPath,
      fileModifiedAt,
      ...(meta.last_indexed_at === undefined ? {} : { lastIndexedAt: meta.last_indexed_at }),
      ...(latest === undefined ? {} : { version: latest.version, versionCreatedAt: latest.createdAt }),
      ...(documents === undefined ? {} : { documents }),
      ...(chunks === undefined ? {} : { chunks }),
    }
  } finally {
    db.close()
  }
}
