/**
 * 判例全文检索引擎（基于外接 knowledge.db）。
 *
 * 与 LegalSearchEngine（法条检索）同策略：FTS5（trigram tokenizer，BM25 排序）优先，
 * 短查询（< 3 个 CJK 字符）或缺失 FTS 表时降级 LIKE 匹配。
 * 降级路径在 documents.search_prefix 存在时只扫标题与前缀列（install 生成，
 * 每文档最长 chunk 的前 N 个码点），无需解压全部 chunks；缺列时回退整表解压。
 *
 * 数据映射（已验证）：docs_fts 为 contentless FTS5（content=''，tokenize=trigram），
 * 其 rowid 即 chunks.id（144,069/144,178 命中 99.9%），正文必须经
 * `JOIN chunks c ON c.id = docs_fts.rowid` 再 `JOIN documents d ON d.id = c.document_id` 回源。
 *
 * FTS5 能力探测：docs_fts 表存在**且**运行时的 SQLite 编译了 FTS5 才走 FTS 路径。
 * 桌面端捆绑的旧版 Node（node:sqlite 未编译 FTS5，如 v22.14.0）即便表存在，
 * MATCH 查询也会抛 "no such module: fts5"——此时整体降级 LIKE，避免工具执行崩溃。
 */

import { type StatementSync } from 'node:sqlite'
import { KnowledgeFtsSearchBase, type KnowledgeSearchEngineOptions } from '../shared/knowledge-fts.ts'
import { escapeFtsPhrase, joinFtsOrTerms } from '../shared/fts.ts'
import { resolveResultLimit } from '@deepseek-ai/dsh-knowledge-core'
import { decompressChunk } from '../shared/chunk-compression.ts'
import { errorMessage } from '@deepseek-ai/dsh-value'
import type { CaseLawChunk, CaseLawHit, CaseLawSearchOptions } from './types.ts'

/** 引擎构造选项（全部可选；不传时行为与旧签名完全一致）。 */
export type CaseLawSearchEngineOptions = KnowledgeSearchEngineOptions

/**
 * 每文档多 chunk 命中时的放大取数系数（供 JS 层按文档去重）。
 */
const FETCH_MULTIPLIER = 5

/** 引擎层单次检索返回的判例上限（工具层另有更严格的 1-10 限制）。 */
const MAX_LIMIT = 50

/** 是否存在会改变 SQL 形状的过滤条件（有过滤时走动态 SQL，低频）。 */
function hasCaseLawFilters(options: CaseLawSearchOptions): boolean {
  return Boolean(options.docType || options.court || options.excludeSource)
}

type CaseLawRow = {
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
  /** 正文片段（LIKE/回源路径有值；FTS 主查询不取正文，经回源填充——延迟解压）。 */
  content: string | null
  fts_rank?: number | null
}

/** 前缀 LIKE 的 documents 投影（片段另取最长 chunk）。 */
type CaseLawPrefixRow = Omit<CaseLawRow, 'chunk_index' | 'content' | 'fts_rank'>

/** 前缀路径回源的最长 chunk。 */
type CaseLawChunkRow = {
  chunk_index: number
  content: string | Uint8Array | null
}

/** 前缀路径的两条预编译语句（仅在 documents.search_prefix 存在时创建）。 */
type CaseLawPrefixStatements = {
  search: StatementSync
  longestChunk: StatementSync
}

/** 一条 LIKE 降级查询的路径片段（投影与过滤子句由 buildLikeQuery 统一拼接）。 */
type CaseLawLikeQuery = {
  /** 额外的文档投影（整表路径取命中 chunk 的序号与正文）。 */
  projection: string
  /** FROM 之后的 JOIN 子句；前缀路径不 JOIN chunks。 */
  join: string
  /** 标题之外用于匹配正文的列表达式。 */
  contentColumn: string
}

/** 整表路径：JOIN 每文档最长 chunk 并解压正文，作为片段与匹配来源。 */
const LIKE_QUERY_LONGEST_CHUNK: CaseLawLikeQuery = {
  projection: ', c.chunk_index, sati_uncompress(c.content) AS content',
  join: `JOIN chunks c ON c.id = (
          SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)`,
  contentColumn: 'sati_uncompress(c.content)',
}

/** 前缀路径：只读 documents 的 title/search_prefix，不解压 chunks。 */
const LIKE_QUERY_SEARCH_PREFIX: CaseLawLikeQuery = {
  projection: '',
  join: '',
  contentColumn: 'd.search_prefix',
}

/** 判例全文检索引擎（knowledge.db docs_fts/chunks/documents，FTS5 优先，LIKE 降级）。 */
export class CaseLawSearchEngine extends KnowledgeFtsSearchBase<CaseLawSearchOptions, CaseLawHit> {
  // 热路径 prepared statements（固定 SQL；带过滤的查询走动态 SQL）
  private readonly stmtSearchLike: StatementSync
  private readonly stmtSearchFts: StatementSync | null
  private readonly stmtGetById: StatementSync
  /** 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源，保持"命中 chunk"语义）。 */
  private readonly stmtGetChunkAt: StatementSync
  /** install 生成的 documents.search_prefix 检索资源；缺列时为 null（整表解压路径）。 */
  private readonly prefixStatements: CaseLawPrefixStatements | null
  private readonly stmtCount: StatementSync

  constructor(dbPath: string, options: CaseLawSearchEngineOptions = {}) {
    super(dbPath, options)

    try {
      // documents.search_prefix 由 install 生成（每文档最长 chunk 的前 N 个码点）。
      // 存在时短查询只扫 title/前缀列；旧库缺列时保留整表解压的 JOIN 路径。
      const documentColumns = this.db
        .prepare("SELECT name FROM pragma_table_info('documents')")
        .all() as Array<{ name: string }>
      const hasSearchPrefix = documentColumns.some(column => column.name === 'search_prefix')
      this.prefixStatements = hasSearchPrefix
        ? {
          search: this.db.prepare(`
            SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
                   d.court, d.source, d.module, d.char_count
            FROM documents d
            WHERE (d.title LIKE ? ESCAPE '\\' OR d.search_prefix LIKE ? ESCAPE '\\')
            LIMIT ?
          `),
          longestChunk: this.db.prepare(
            'SELECT chunk_index, content FROM chunks WHERE document_id = ? ORDER BY char_count DESC LIMIT 1',
          ),
        }
        : null

      // LIKE 降级：documents.title 或 每文档最长 chunk 的 content（压缩 chunk 先
      // 解压再匹配）；子查询取最长 chunk 作片段。
      this.stmtSearchLike = this.db.prepare(`
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, c.chunk_index,
               sati_uncompress(c.content) AS content
        FROM documents d
        JOIN chunks c ON c.id = (
          SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
        WHERE (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
        LIMIT ?
      `)

      // 按 documents.id 取全文分块（供"查看判例全文"场景）。
      // 注：content 取原始存储（TEXT 明文 / SC 魔数 gzip BLOB），JS 层
      // decompressChunk 解压——绕开 node:sqlite JS UDF 的 ~4ms/次边界开销
      // （实测：UDF 单行 4.18ms vs 原始列 0.04ms）。
      this.stmtGetById = this.db.prepare(`
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, c.chunk_index,
               c.content AS content
        FROM documents d
        JOIN chunks c ON c.document_id = d.id
        WHERE d.id = ?
        ORDER BY c.chunk_index
      `)

      // 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源；保持
      // 旧行为"片段 = 命中的 chunk"而非最长 chunk）。
      this.stmtGetChunkAt = this.db.prepare(`
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, c.chunk_index,
               c.content AS content
        FROM documents d
        JOIN chunks c ON c.document_id = d.id AND c.chunk_index = ?
        WHERE d.id = ?
      `)

      // 无过滤 FTS 查询（searchFts 与 searchFtsKeywords 的 SQL 相同，仅 MATCH 参数
      // 不同，共用一条语句）。docs_fts 表可能存在但运行时 SQLite 未注册 FTS5
      // （如捆绑旧版 Node 的 bm25/MATCH），prepare 会抛错——捕获并降级 LIKE。
      // 正文不在此取（sati_uncompress 延迟到 JS 层对 top-N 回源——避免解压
      // FETCH_MULTIPLIER×limit 行全文）。排序保持 bm25(docs_fts)：实测 JOIN 场景
      // ORDER BY rank 触发 FTS5 rank 全量物化（354ms vs bm25 0.12ms，3000 倍倒退）
      // ——rank 渐进优化仅适用无 JOIN 的 FTS 直查（H5 实测证伪，勿改回 rank）。
      this.stmtSearchFts = null
      if (this.hasFts) {
        try {
          this.stmtSearchFts = this.db.prepare(`
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count,
               c.chunk_index, NULL AS content, bm25(docs_fts) AS fts_rank
        FROM docs_fts
        JOIN chunks c ON c.id = docs_fts.rowid
        JOIN documents d ON d.id = c.document_id
        WHERE docs_fts MATCH ?
        ORDER BY bm25(docs_fts) LIMIT ?
      `)
        } catch (error) {
          this.degradeFts(errorMessage(error))
          this.stmtSearchFts = null
        }
      }

      this.stmtCount = this.db.prepare('SELECT COUNT(*) AS c FROM documents')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  protected readonly degradeLabel = 'case-law'
  protected markFtsDegraded(): void {
    this.stats?.setCaseLawFtsDegraded(true)
  }

  /**
   * 判例全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；结果按文档去重（一文档一行）。
   * @param keyword 检索关键词。
   * @param options 检索选项（docType/court/excludeSource/limit 过滤与数量）。
   * @returns 匹配的判例命中列表（按文档去重，一文档一行）。
   */
  search(keyword: string, options: CaseLawSearchOptions = {}): CaseLawHit[] {
    const limit = resolveResultLimit(options.limit, 5, MAX_LIMIT)
    return this.runSearch(keyword, options, limit)
  }

  /**
   * 按 documents.id 取判例全文分块（供"查看全文"场景；不经过检索，无 via/ftsRank 语义）。
   * @param documentId 判例文档 id。
   * @returns 该判例的全文分块列表（按 chunk_index 排序）。
   */
  getById(documentId: string): CaseLawChunk[] {
    const rows = this.stmtGetById.all(documentId) as CaseLawRow[]
    return rows.map(row => ({
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: decompressChunk(row.content),
    }))
  }

  /**
   * 统计判例文档总数（诊断用）。
   * @returns documents 表行数。
   */
  count(): number {
    const row = this.stmtCount.get() as { c: number }
    return row.c
  }

  /** 构建 FTS 查询（固定投影 + 可选过滤；带过滤时拼接动态 SQL）。 */
  private buildFtsQuery(options: CaseLawSearchOptions): { sql: string; filterParams: Array<string | number | null> } {
    let sql = `
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count,
             c.chunk_index, NULL AS content, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ?
    `
    const filterParams: Array<string | number | null> = []
    sql = this.appendCaseLawFilters(sql, options, filterParams)
    sql += ' ORDER BY bm25(docs_fts) LIMIT ?'
    return { sql, filterParams }
  }

  /**
   * 构建带过滤条件的 LIKE 降级查询：投影、匹配列与 JOIN 由路径决定，过滤子句共用。
   * @param query 该路径的投影、JOIN 与正文匹配列。
   * @param pattern 已转义的 LIKE 模式（title 与正文各绑定一次）。
   * @param options 检索选项（过滤字段）。
   * @param limit 返回行数上限。
   * @returns 完整 SQL 与按占位符顺序排列的参数（title、正文、过滤值、limit）。
   */
  private buildLikeQuery(
    query: CaseLawLikeQuery,
    pattern: string,
    options: CaseLawSearchOptions,
    limit: number,
  ): { sql: string; params: Array<string | number | null> } {
    let sql = `
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count${query.projection}
      FROM documents d
      ${query.join}
      WHERE (d.title LIKE ? ESCAPE '\\' OR ${query.contentColumn} LIKE ? ESCAPE '\\')
    `
    const params: Array<string | number | null> = [pattern, pattern]
    sql = this.appendCaseLawFilters(sql, options, params)
    sql += ' LIMIT ?'
    params.push(limit)
    return { sql, params }
  }

  /**
   * 追加 docType/court/excludeSource 三个过滤子句（buildFtsQuery 与 searchLike 共用）。
   * @param sql 已构建的查询前缀。
   * @param options 检索选项（过滤字段）。
   * @param params 占位符参数数组（就地追加过滤参数）。
   * @returns 追加过滤子句后的 SQL 文本。
   */
  private appendCaseLawFilters(
    sql: string,
    options: CaseLawSearchOptions,
    params: Array<string | number | null>,
  ): string {
    let result = sql
    if (options.docType) {
      result += ' AND d.doc_type = ?'
      params.push(options.docType)
    }
    if (options.court) {
      result += " AND d.court LIKE ? ESCAPE '\\'"
      params.push(`%${options.court.replace(/[%_\\]/g, m => `\\${m}`)}%`)
    }
    if (options.excludeSource) {
      result += ' AND d.source != ?'
      params.push(options.excludeSource)
    }
    return result
  }

  protected searchFts(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    // trigram 分词对引号敏感：整体作为 phrase 查询（与 law_fts 同策略）。
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit)
  }

  /** 多个关键词 OR 组合的 FTS 查询（用于长查询切词降级）。 */
  protected searchFtsKeywords(keywords: string[], options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit)
  }

  private searchFtsWithQuery(query: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    let rows: CaseLawRow[]
    if (this.stmtSearchFts !== null && !hasCaseLawFilters(options)) {
      rows = this.stmtSearchFts.all(query, limit * FETCH_MULTIPLIER) as CaseLawRow[]
    } else {
      const { sql, filterParams } = this.buildFtsQuery(options)
      rows = this.db.prepare(sql).all(query, ...filterParams, limit * FETCH_MULTIPLIER) as CaseLawRow[]
    }
    return this.backfillContent(this.dedupeByDocument(rows, limit))
  }

  /**
   * 延迟解压回源：FTS 主查询不取正文（避免解压 FETCH_MULTIPLIER×limit 行全文），
   * 去重后仅对最终 top-limit 行按 (document_id, chunk_index) 回源**命中 chunk**
   * 片段——保持旧行为"片段 = 命中的 chunk"；JS 层解压（绕开 UDF 边界开销）。
   */
  private backfillContent(hits: CaseLawHit[]): CaseLawHit[] {
    return hits.map((hit) => {
      if (hit.snippet) return hit
      const row = this.stmtGetChunkAt.get(hit.chunkIndex, hit.documentId) as CaseLawRow | undefined
      return row ? { ...hit, snippet: decompressChunk(row.content) } : hit
    })
  }

  protected searchLike(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    // LIKE 回退计数（设计内降级路径：短词/未命中/FTS 降级；不 warn 避免噪音）。
    this.stats?.recordLikeFallback()
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`
    if (this.prefixStatements !== null) return this.searchLikePrefix(this.prefixStatements, pattern, options, limit)
    let rows: CaseLawRow[]
    if (!hasCaseLawFilters(options)) {
      rows = this.stmtSearchLike.all(pattern, pattern, limit) as CaseLawRow[]
    } else {
      const { sql, params } = this.buildLikeQuery(LIKE_QUERY_LONGEST_CHUNK, pattern, options, limit)
      rows = this.db.prepare(sql).all(...params) as CaseLawRow[]
    }
    return rows.map(row => this.toHit(row, null, 'like'))
  }

  /**
   * 前缀 LIKE：先扫 documents 的 title/search_prefix（无需解压），再按文档取最长
   * chunk 作片段。候选窗口放大到 `limit * FETCH_MULTIPLIER`，让无 chunk 的文档
   * 被跳过后仍能补满 limit。
   * 召回只覆盖每个文档最长 chunk 的前缀；需要前缀之外的正文匹配时，打开未安装
   * search_prefix 的库走整表解压路径。
   * @param statements 前缀路径的两条预编译语句。
   * @param pattern 已转义的 LIKE 模式。
   * @param options 检索选项（过滤字段）。
   * @param limit 返回命中上限。
   * @returns 前缀命中的判例列表（一文档一行，按 documents 扫描序）。
   */
  private searchLikePrefix(
    statements: CaseLawPrefixStatements,
    pattern: string,
    options: CaseLawSearchOptions,
    limit: number,
  ): CaseLawHit[] {
    let rows: CaseLawPrefixRow[]
    if (!hasCaseLawFilters(options)) {
      rows = statements.search.all(pattern, pattern, limit * FETCH_MULTIPLIER) as CaseLawPrefixRow[]
    } else {
      const { sql, params } = this.buildLikeQuery(
        LIKE_QUERY_SEARCH_PREFIX,
        pattern,
        options,
        limit * FETCH_MULTIPLIER,
      )
      rows = this.db.prepare(sql).all(...params) as CaseLawPrefixRow[]
    }
    const hits: CaseLawHit[] = []
    for (const row of rows) {
      if (hits.length >= limit) break
      const chunk = statements.longestChunk.get(row.document_id) as CaseLawChunkRow | undefined
      if (chunk === undefined) continue
      hits.push(this.toHit({
        ...row,
        chunk_index: chunk.chunk_index,
        content: decompressChunk(chunk.content),
      }, null, 'like'))
    }
    return hits
  }

  /**
   * 同一文档多 chunk 命中时按文档去重，保留 bm25 最优（最小值）chunk（一文档一行）。
   * FTS5 的 bm25() 为负值，越接近负无穷越相关；缺 rank 的行按最差处理。
   */
  private dedupeByDocument(rows: CaseLawRow[], limit: number): CaseLawHit[] {
    const bestByDoc = new Map<string, CaseLawRow>()
    for (const row of rows) {
      const best = bestByDoc.get(row.document_id)
      if (!best || (row.fts_rank ?? Infinity) < (best.fts_rank ?? Infinity)) {
        bestByDoc.set(row.document_id, row)
      }
    }
    const ranked = Array.from(bestByDoc.values())
      .map(row => ({ row, rank: row.fts_rank ?? Infinity }))
      .sort((left, right) => left.rank - right.rank)
      .slice(0, limit)
    return ranked.map(({ row }) => this.toHit(row, row.fts_rank ?? null, 'fts'))
  }

  private toHit(row: CaseLawRow, ftsRank: number | null, via: CaseLawHit['via']): CaseLawHit {
    return {
      documentId: row.document_id,
      docType: row.doc_type,
      title: row.title,
      decisionNumber: row.decision_number ?? undefined,
      caseNumber: row.case_number ?? undefined,
      court: row.court ?? undefined,
      source: row.source ?? undefined,
      module: row.module ?? undefined,
      charCount: row.char_count,
      chunkIndex: row.chunk_index,
      snippet: decompressChunk(row.content),
      ftsRank,
      via,
    }
  }
}
