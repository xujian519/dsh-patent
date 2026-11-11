/**
 * patent-knowledge:install — the knowledge.db trim bootstrap.
 *
 * Produces a compact knowledge-lite.db from a local source knowledge.db by
 * vacuuming into a fresh copy, gzip-compressing chunks.content long bodies
 * (readers decompress transparently via sati_uncompress), and dropping the
 * embeddings tables (P0.4: no vector infrastructure in P1). The source database
 * is opened read-only and never modified.
 *
 * The install logic never runs on plugin load; it is exported for programmatic
 * use and wrapped by the patent-knowledge-install bin.
 * @module @deepseek-ai/dsh-patent-knowledge/install
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { commitTempSibling, countTableRows, formatGigabytes, prepareTempSibling, resolveRealPath } from '@deepseek-ai/dsh-knowledge-core'
import { compressIfSmaller, decompressChunk } from './shared/chunk-compression.ts'
import { KgStore } from './shared/kg-store.ts'
import { KnowledgeLawSearch } from './legal/knowledge-law-search.ts'
import { CaseLawSearchEngine } from './case-law/case-law-search.ts'
import { DEFAULT_KNOWLEDGE_DIR, DEFAULT_SOURCE_DB_PATH } from './config.ts'
import type { InstallKnowledgeDbOptions, InstallResult } from './types.ts'

/** Compress each long chunks.content body once to a gzip BLOB. Returns the compressed count. */
function compressChunksTable(db: DatabaseSync): number {
  const select = db.prepare('SELECT id, content FROM chunks')
  const update = db.prepare('UPDATE chunks SET content = ? WHERE id = ?')
  let compressed = 0
  for (const row of select.iterate()) {
    const content = row.content
    const id = row.id
    if (typeof content !== 'string' || typeof id !== 'number') continue
    const blob = compressIfSmaller(content)
    if (blob !== null) {
      update.run(blob, id)
      compressed += 1
    }
  }
  return compressed
}

/** Default number of code points copied into documents.search_prefix. */
const SEARCH_PREFIX_DEFAULT_CHARS = 512

/** search_prefix length bounds: below 64 the short-query scan loses too much recall, above 2048 the column stops being compact. */
const SEARCH_PREFIX_MIN_CHARS = 64
const SEARCH_PREFIX_MAX_CHARS = 2048

/** Escape a single quote for the VACUUM INTO string literal. */
function sqlQuote(path: string): string {
  return path.replace(/'/g, "''")
}

/**
 * 列出表的所有列名；表不存在时返回空集合。
 * @param db 已打开的知识库连接。
 * @param table 表名（仅包内字面量，不接受外部输入）。
 * @returns 列名集合。
 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

/**
 * 给 documents 补时间效力列（可空三态：NULL = 未核验）。
 *
 * 只建列、不写默认值：`expired INTEGER NOT NULL DEFAULT 0` 会把「不知道」写成
 * 「未废止」。回填依赖后续的法规沿革数据；在回填前查询层把缺失视为未核验。
 * @param db - 已打开的输出库连接。
 * @returns 新增的列名。
 */
function ensureLawValidityColumns(db: DatabaseSync): string[] {
  const documentColumns = tableColumns(db, 'documents')
  if (!documentColumns.has('id')) return []
  const added: string[] = []
  const definitions: ReadonlyArray<readonly [string, string]> = [
    ['valid_from', 'TEXT'],
    ['valid_to', 'TEXT'],
    ['validity_source', 'TEXT'],
  ]
  for (const [name, type] of definitions) {
    if (documentColumns.has(name)) continue
    db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`)
    added.push(name)
  }
  return added
}

/**
 * 生成 documents.search_prefix：每个文档最长 chunk 的前 `chars` 个码点。
 * 内容可能已被上一次 install 压缩，故无条件解压（对明文幂等）。
 * 源库缺少 documents.id 或 chunks.document_id/char_count 时跳过并返回 null。
 * @param db 已打开的输出库连接。
 * @param chars 保留的码点数。
 * @returns 写入前缀的文档数；schema 不支持时为 null。
 */
function buildSearchPrefix(db: DatabaseSync, chars: number): number | null {
  const documentColumns = tableColumns(db, 'documents')
  const chunkColumns = tableColumns(db, 'chunks')
  if (!documentColumns.has('id') || !chunkColumns.has('document_id') || !chunkColumns.has('char_count')) {
    return null
  }
  if (!documentColumns.has('search_prefix')) {
    db.exec('ALTER TABLE documents ADD COLUMN search_prefix TEXT')
  }
  const select = db.prepare(`
    SELECT document_id, content FROM (
      SELECT document_id, content,
             ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY char_count DESC) AS rn
      FROM chunks
    ) WHERE rn = 1
  `)
  const update = db.prepare('UPDATE documents SET search_prefix = ? WHERE id = ?')
  let documents = 0
  // 单事务写入：逐行自动提交会在 8 万次 UPDATE 上产生同等次数的 fsync。
  // 失败时异常向上抛出，连接关闭时 SQLite 回滚未提交事务。
  db.exec('BEGIN')
  for (const row of select.iterate()) {
    const documentId = row.document_id
    if (typeof documentId !== 'string') continue
    const content = row.content as string | Uint8Array | null
    update.run(Array.from(decompressChunk(content)).slice(0, chars).join(''), documentId)
    documents += 1
  }
  db.exec('COMMIT')
  return documents
}

/**
 * 删除输出库中可能由上一次 install 继承的 documents.search_prefix。
 * 关闭前缀路径时必须移除该列，否则读取端仍会按列存在走有界召回路径。
 * @param db 已打开的输出库连接。
 * @returns 删除了列时 true；源库没有该列时 false。
 */
function dropSearchPrefix(db: DatabaseSync): boolean {
  if (!tableColumns(db, 'documents').has('search_prefix')) return false
  db.exec('ALTER TABLE documents DROP COLUMN search_prefix')
  return true
}

function countRows(db: DatabaseSync, table: string): number {
  return countTableRows(db, table)
}

function gb(bytes: number): string {
  return formatGigabytes(bytes)
}

/**
 * Trim a source knowledge.db into knowledgeDir, keeping the full-text and
 * knowledge-graph capability while dropping embeddings.
 *
 * @param options - input/output paths, trimming toggles, and a log sink.
 * @returns the run summary (paths, sizes, dropped tables, compressed count).
 */
/**
 * patent-knowledge:install 的入口。
 * @param options - source/输出路径与裁剪开关。
 * @returns 安装结果（输出路径、去表清单与压缩统计）。
 */
// oxlint-disable-next-line typescript/require-await -- public export contract returns Promise<InstallResult>; callers await it
export async function installKnowledgeDb(options: InstallKnowledgeDbOptions = {}): Promise<InstallResult> {
  const log = options.log ?? console.log
  const knowledgeDir = options.knowledgeDir ?? DEFAULT_KNOWLEDGE_DIR
  const sourceDbPath = options.sourceDbPath ?? DEFAULT_SOURCE_DB_PATH
  const input = sourceDbPath
  const output = options.output ?? join(knowledgeDir, 'knowledge-lite.db')
  const compress = options.compressChunks ?? true
  const keepEmbeddings = options.keepEmbeddings ?? false
  const noFts = options.noFts ?? false
  const skipVerify = options.skipVerify ?? false
  const searchPrefix = options.searchPrefix ?? false
  const searchPrefixChars = options.searchPrefixChars ?? SEARCH_PREFIX_DEFAULT_CHARS
  if (!Number.isInteger(searchPrefixChars) || searchPrefixChars < SEARCH_PREFIX_MIN_CHARS || searchPrefixChars > SEARCH_PREFIX_MAX_CHARS) {
    throw new Error(`searchPrefixChars 必须是 ${SEARCH_PREFIX_MIN_CHARS}–${SEARCH_PREFIX_MAX_CHARS} 之间的整数（收到 ${searchPrefixChars}）`)
  }

  log(`输入: ${input}`)
  log(`输出: ${output}`)
  const dropped: string[] = []
  if (!keepEmbeddings) dropped.push('embeddings', 'ivf_index', 'index_meta')
  if (noFts) dropped.push('docs_fts', 'kg_nodes_fts')
  log(`去除: ${dropped.length > 0 ? dropped.join(', ') : '无（仅 VACUUM 去碎片）'}`)

  if (!existsSync(input)) {
    throw new Error(`输入库不存在（${input}）。请用 --from 指定 knowledge.db 路径。`)
  }
  // 同文件守卫用真实路径比较：文本相等会漏掉 /x/./k.db、symlink 别名等写法，
  // 一旦误判为不同路径，先删后建会把源库不可逆删除。
  if (resolveRealPath(input) === resolveRealPath(output)) {
    throw new Error('--output 与 --input 指向同一文件（含路径别名），会破坏源库 ，请指定不同输出路径。')
  }

  const sourceBytes = statSync(input).size

  // 1. VACUUM INTO 生成紧凑副本：先写临时文件，成功后原子替换输出——
  // VACUUM INTO 要求目标不存在，直接 rmSync(output) 会在 VACUUM 失败时
  // 丢掉上一份可用产物。
  const tmpOutput = prepareTempSibling(output)
  log('[1/3] VACUUM INTO 生成紧凑副本…')
  {
    const db = new DatabaseSync(input, { readOnly: true })
    try {
      db.exec(`VACUUM INTO '${sqlQuote(tmpOutput)}'`)
    } finally {
      db.close()
    }
  }
  commitTempSibling(tmpOutput, output, log)

  // 2. Build the short-query prefix, compress chunks, drop tables, then vacuum again.
  let compressedChunks = 0
  {
    const db = new DatabaseSync(output)
    try {
      log('[2/3] 裁剪副本（检索辅助列 / 压缩 / 删表）…')
      if (searchPrefix) {
        log(`    生成 documents.search_prefix（每文档前 ${searchPrefixChars} 个字符）…`)
        const prefixDocs = buildSearchPrefix(db, searchPrefixChars)
        log(prefixDocs === null
          ? '    跳过：源库缺少 documents.id 或 chunks(document_id, char_count)'
          : `    完成：search_prefix ${prefixDocs.toLocaleString()} 个文档`)
      } else if (dropSearchPrefix(db)) {
        log('    已删除继承的 documents.search_prefix（未启用前缀路径）')
      }
      const addedValidity = ensureLawValidityColumns(db)
      if (addedValidity.length > 0) {
        log(`    新增 documents 时间效力列: ${addedValidity.join(', ')}（未回填 = 未核验）`)
      }
      if (compress) {
        log('    压缩 chunks.content（长 chunk 转 gzip BLOB）…')
        compressedChunks = compressChunksTable(db)
        log(`    完成：压缩 ${compressedChunks.toLocaleString()} 条（其余明文保留）`)
      }
      if (dropped.length > 0) {
        log(`    删除: ${dropped.join(', ')}…`)
        db.exec(dropped.map(t => `DROP TABLE IF EXISTS "${t}"`).join(';\n'))
      }
      log('[3/3] 二次 VACUUM 释放空间…')
      db.exec('VACUUM')
    } finally {
      db.close()
    }
  }

  const outputBytes = statSync(output).size
  log('')
  log('=== 结果 ===')
  log(`源库:   ${gb(sourceBytes)}`)
  log(`裁剪版: ${gb(outputBytes)}（-${Math.round((1 - outputBytes / sourceBytes) * 100)}%）`)
  {
    const db = new DatabaseSync(output, { readOnly: true })
    try {
      log('保留表行数:')
      for (const t of ['kg_nodes', 'kg_edges', 'documents', 'chunks']) {
        const n = countRows(db, t)
        log(`  ${t.padEnd(12)} ${n >= 0 ? n.toLocaleString() : '（缺失）'}`)
      }
    } finally {
      db.close()
    }
  }

  if (!skipVerify) {
    verifyComponents(output, noFts, log)
  }

  return { input, output, inputBytes: sourceBytes, outputBytes, dropped, compressedChunks }
}

/** Fail-loud component verification of the trimmed database. */
function verifyComponents(output: string, noFts: boolean, log: (line: string) => void): void {
  log('=== 组件验证 ===')
  const kg = new KgStore(output)
  log(`  KgStore schema=${kg.schemaKind()} fts=${kg.ftsMode()}`)
  const hit = kg.searchByKeyword('创造性', 1)
  log(`  KgStore 关键词检索: ${hit.length > 0 ? `命中 ${hit.length}` : '无命中'}`)
  kg.close()

  const law = new KnowledgeLawSearch(output)
  const lawCount = law.count()
  const lawHits = law.search('新颖性', { limit: 1 })
  log(`  KnowledgeLawSearch count=${lawCount} fts=${law.ftsAvailable} 检索: ${lawHits.length > 0 ? `命中 ${lawHits[0]?.name}` : '无命中'}`)
  law.close()

  const cs = new CaseLawSearchEngine(output)
  const csCount = cs.count()
  const query = noFts ? '创造性' : '创造性 三步法'
  const csHits = cs.search(query, { limit: 1 })
  log(`  CaseLawSearchEngine count=${csCount} fts=${cs.ftsAvailable} 检索"${query}": ${csHits.length > 0 ? `命中 ${csHits[0]?.title}` : '无命中'}`)
  cs.close()
}
