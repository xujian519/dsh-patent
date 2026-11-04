/**
 * knowledge.db 规范全文搜索引擎（法规原文与《专利审查指南》全文）。
 *
 * 数据源：knowledge.db `documents`（doc_type 为 `law_article` 或 `guideline_rule`）/ `chunks` /
 * `docs_fts`（contentless FTS5 trigram）。docs_fts rowid = chunks.id，
 * 正文经 JOIN chunks/documents 回源（与 case-law-search 同模式）。
 *
 * 与 LegalSearchEngine（laws-full.db）接口对齐，供 LegalMemoryProvider
 * 作为知识库法规后端（复用 XiaoNuo 产物，不再依赖 laws-full）。
 *
 * LawRecord 映射：
 *   id     = documents.id（如 "raw:法律法规司法解释_md:中华人民共和国专利法_20201017"）
 *   name   = documents.title（法规名）
 *   level  = documents.level（法律/行政法规/司法解释/部门规章…）
 *   content= 该文档最长 chunk（法规章节片段，注入上下文时截断）
 */

import { type StatementSync } from 'node:sqlite'
import { KnowledgeFtsSearchBase, type KnowledgeSearchEngineOptions } from '../shared/knowledge-fts.ts'
import { escapeFtsPhrase, joinFtsOrTerms } from '../shared/fts.ts'
import { resolveResultLimit } from '@deepseek-ai/dsh-patent-core'
import { decompressChunk } from '../shared/chunk-compression.ts'
import { errorMessage } from '@deepseek-ai/dsh-value'
import type { LawCategory, LawLookupOptions, LawRecord, LawSearchResult, LegalSearchSource } from './types.ts'
import { isLawVisible, resolveAsOf, resolveLawValidity, todayIsoDate } from './validity.ts'

/**
 * 引擎可索引的规范文档类型（闭集）：`law_article` 是法规原文，`guideline_rule` 是
 * 《专利审查指南》全文。闭集既让同一引擎服务两类语料，也保证文档类型不会被拼进 SQL。
 */
export const KNOWLEDGE_DOC_TYPES = ['law_article', 'guideline_rule'] as const

/** 规范文档类型。 */
export type KnowledgeDocType = (typeof KNOWLEDGE_DOC_TYPES)[number]

/** Engine constructor options (all optional). */
export type KnowledgeLawSearchEngineOptions = KnowledgeSearchEngineOptions & {
  /** 索引的文档类型（默认 `['law_article']`，即法规原文）。 */
  docTypes?: readonly KnowledgeDocType[]
}

/** 法规全文搜索选项。 */
export type KnowledgeLawSearchOptions = {
  /** 返回条数上限（默认 10；小数截断、非有限值回退默认、下限 1）。 */
  limit?: number
  /** 按法律层级过滤（法律/行政法规/司法解释/部门规章…）。 */
  level?: string
  /** 分类过滤：knowledge.db 无 category 概念，忽略。 */
  category?: string
  /**
   * 判定时点（YYYY-MM-DD），缺省为今天。已废止与尚未生效的记录不返回；
   * 未核验记录是否返回由 `includeUnverified` 决定。
   */
  asOf?: string
  /**
   * 是否返回时间效力未核验的记录（时间列缺失），缺省 true。
   * 设为 false 时只返回能证明在该时点有效的记录。
   */
  includeUnverified?: boolean
}

type DocChunkRow = {
  document_id: string
  title: string
  level: string | null
  source: string | null
  /** documents.file_path：语料内的相对路径，作为该文档的可溯源来源。 */
  file_path: string | null
  /** 公布日（documents.publish_date；列缺失时为 NULL）。 */
  publish_date: string | null
  /** 施行日（documents.valid_from；列缺失时为 NULL = 未核验）。 */
  valid_from: string | null
  /** 失效日（documents.valid_to；列缺失时为 NULL = 未核验）。 */
  valid_to: string | null
  /** 废止标记（documents.expired；列缺失时为 NULL = 未核验）。 */
  expired: number | null
  /** 时间列来源标签（documents.validity_source；可选）。 */
  validity_source: string | null
  /** 正文片段（LIKE/回源路径有值；FTS 主查询不取正文，经回源填充——延迟解压）。 */
  content: string | null
  chunk_index: number
  char_count: number | null
  /** FTS5 BM25 分数（负值，越大越相关；仅 FTS 路径有值）。 */
  fts_rank?: number | null
}

const FETCH_MULTIPLIER = 3

/** 每个文档取最长 chunk 作为正文片段（LIKE/按名/按 id 路径共用）。 */
const LONGEST_CHUNK_JOIN = `JOIN chunks c ON c.id = (
  SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)`

/** knowledge.db 法规全文搜索引擎（law_article 文档，FTS5 优先，LIKE 降级）。 */
export class KnowledgeLawSearch extends KnowledgeFtsSearchBase<KnowledgeLawSearchOptions, DocChunkRow>
  implements LegalSearchSource {
  private readonly stmtSearchLike: StatementSync
  private readonly stmtSearchFts: StatementSync | null
  private readonly stmtFindByName: StatementSync
  private readonly stmtGetById: StatementSync
  /** 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源，保持"命中 chunk"语义）。 */
  private readonly stmtGetChunkAt: StatementSync
  private readonly stmtCount: StatementSync
  /** 本引擎索引的文档类型（SQL 片段，值取自 {@link KNOWLEDGE_DOC_TYPES} 闭集）。 */
  private readonly docTypeIn: string
  /**
   * 语料库是否有 `documents.file_path` 列：装配后的库有，个别旧源库没有。缺列时投影
   * NULL，引擎照常检索，只是命中不带来源路径（来源由调用方按 id 判定）。
   */
  private readonly filePathColumn: string
  /**
   * 时间效力列的投影片段：列存在时取原列，缺失时投影 NULL。投影集中一处，
   * 所有检索路径（FTS/LIKE/按名/按 id）都返回同一组时间字段。
   */
  private readonly validityColumns: string
  /** 共享的记录投影与最长 chunk 回源；各查询只追加自己的 WHERE/ORDER BY。 */
  private readonly recordSelect: string
  /**
   * 时间效力过滤的 WHERE 片段（在 LIMIT 之前生效）：已废止、尚未生效的记录先被
   * 排除，避免它们占满 limit 把有效记录挤掉。无法核验的日期（格式非法或日历越界）
   * 按「未核验」处理，由 JS 侧 `isLawVisible` 做最终判定。
   */
  private readonly validityWhere: string
  /** 时间列是否存在，决定 `validityWhere` 的 asOf 参数顺序。 */
  private readonly hasValidFromColumn: boolean
  private readonly hasValidToColumn: boolean

  constructor(dbPath: string, options: KnowledgeLawSearchEngineOptions = {}) {
    super(dbPath, options)
    try {
      // 文档类型取自闭集常量，故可安全拼进 SQL 文本（调用方传的是类型值，不是自由字符串）。
      const docTypes = options.docTypes ?? ['law_article']
      const docTypeList = docTypes.map((type) => {
        if (!(KNOWLEDGE_DOC_TYPES as readonly string[]).includes(type)) {
          throw new Error(`knowledge: 未知的文档类型 ${type}（可用：${KNOWLEDGE_DOC_TYPES.join(' / ')}）`)
        }
        return `'${type}'`
      }).join(', ')
      const docTypeIn = `d.doc_type IN (${docTypeList})`
      this.docTypeIn = docTypeIn
      const columns = this.db
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('documents') WHERE name = 'file_path'")
        .get() as { c: number }
      const filePathColumn = columns.c > 0 ? 'd.file_path' : 'NULL AS file_path'
      this.filePathColumn = filePathColumn
      const documentColumns = new Set(
        (this.db.prepare("SELECT name FROM pragma_table_info('documents')").all() as Array<{ name: string }>)
          .map(row => row.name),
      )
      const projection = (column: string): string => documentColumns.has(column) ? `d.${column}` : 'NULL'
      this.validityColumns = [
        `${projection('publish_date')} AS publish_date`,
        `${projection('valid_from')} AS valid_from`,
        `${projection('valid_to')} AS valid_to`,
        `${projection('expired')} AS expired`,
        `${projection('validity_source')} AS validity_source`,
      ].join(', ')
      this.recordSelect = [
        `SELECT d.id AS document_id, d.title, d.level, d.source, ${this.filePathColumn}, ${this.validityColumns},`,
        'c.content AS content, c.char_count',
        'FROM documents d',
        LONGEST_CHUNK_JOIN,
      ].join('\n')

      // 时间效力过滤：日期列只在日期是规范 ISO 日期时参与比较；非法/越界日期留给
      // JS 判定为「未核验」。`? = 1` 表示 includeUnverified，严格模式只放行能证明
      // 在该时点有效的记录。
      const validityClauses: string[] = []
      if (documentColumns.has('expired')) validityClauses.push('(d.expired IS NULL OR d.expired <> 1)')
      if (documentColumns.has('valid_to')) {
        validityClauses.push(
          "(d.valid_to IS NULL OR trim(d.valid_to) = '' OR date(d.valid_to) IS NULL OR date(d.valid_to) <> d.valid_to OR date(d.valid_to) >= date(?))",
        )
      }
      if (documentColumns.has('valid_from')) {
        validityClauses.push(
          "(d.valid_from IS NULL OR trim(d.valid_from) = '' OR date(d.valid_from) IS NULL OR date(d.valid_from) <> d.valid_from OR date(d.valid_from) <= date(?))",
        )
      }
      const evidence = [
        ...(documentColumns.has('expired') ? ['d.expired = 0'] : []),
        ...(documentColumns.has('valid_from') ? ['date(d.valid_from) IS NOT NULL'] : []),
        ...(documentColumns.has('valid_to') ? ['date(d.valid_to) IS NOT NULL'] : []),
      ]
      validityClauses.push(`(? = 1 OR (${evidence.length > 0 ? evidence.join(' OR ') : '0'}))`)
      this.validityWhere = ` AND ${validityClauses.join(' AND ')}`
      this.hasValidFromColumn = documentColumns.has('valid_from')
      this.hasValidToColumn = documentColumns.has('valid_to')

      // LIKE 降级：documents.title 或每文档最长 chunk 的 content（压缩 chunk 先
      // 解压再匹配）；子查询取最长 chunk 作片段。content 取原始存储（TEXT 明文 /
      // SC 魔数 gzip BLOB），JS 层 decompressChunk 解压——绕开 node:sqlite JS UDF
      // 的 ~4ms/次边界开销；WHERE 的 sati_uncompress 仅匹配语义（LIKE 降级路径低频）。
      this.stmtSearchLike = this.db.prepare(`
        ${this.recordSelect}
        WHERE ${this.docTypeIn}
          AND (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')${this.validityWhere}
        ORDER BY d.char_count DESC LIMIT ?
      `)
      // 正文不在此取（sati_uncompress 延迟到 JS 层对 top-N 回源——避免解压
      // FETCH_MULTIPLIER×limit 行全文）。排序保持 bm25(docs_fts)：实测 JOIN 场景
      // ORDER BY rank 触发 FTS5 rank 全量物化（354ms vs bm25 0.12ms，3000 倍倒退）
      // ——rank 渐进优化仅适用无 JOIN 的 FTS 直查（H5 实测证伪，勿改回 rank）。
      this.stmtSearchFts = null
      if (this.hasFts) {
        try {
          this.stmtSearchFts = this.db.prepare(`
            SELECT d.id AS document_id, d.title, d.level, d.source, ${this.filePathColumn}, ${this.validityColumns},
                   NULL AS content, c.chunk_index, c.char_count, bm25(docs_fts) AS fts_rank
            FROM docs_fts
            JOIN chunks c ON c.id = docs_fts.rowid
            JOIN documents d ON d.id = c.document_id
            WHERE docs_fts MATCH ? AND ${docTypeIn}${this.validityWhere}
            ORDER BY bm25(docs_fts) LIMIT ?
          `)
        } catch (error) {
          this.degradeFts(errorMessage(error))
          this.stmtSearchFts = null
        }
      }
      this.stmtFindByName = this.db.prepare(`
        ${this.recordSelect}
        WHERE ${docTypeIn} AND d.title LIKE ? ESCAPE '\\'${this.validityWhere}
        LIMIT ?
      `)
      this.stmtGetById = this.db.prepare(`
        ${this.recordSelect}
        WHERE ${this.docTypeIn} AND d.id = ?${this.validityWhere}
      `)
      // 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源）。
      this.stmtGetChunkAt = this.db.prepare(`
        SELECT d.id AS document_id, d.title, d.level, d.source, ${this.filePathColumn}, ${this.validityColumns},
               c.content AS content, c.char_count
        FROM documents d
        JOIN chunks c ON c.document_id = d.id AND c.chunk_index = ?
        WHERE d.id = ?
      `)
      this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE doc_type IN (${docTypeList})`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  protected readonly degradeLabel = '法规'
  protected markFtsDegraded(): void {
    this.stats?.setLegalFtsDegraded(true)
  }

  /**
   * 所有检索路径共用的时间效力选项：缺省按今天判定并放行未核验记录。
   * @param options - 调用方选项。
   * @returns 规范化后的判定时点与未核验记录策略。
   */
  private visibility(options: LawLookupOptions): { asOf: string; includeUnverified: boolean } {
    return { asOf: resolveAsOf(options.asOf), includeUnverified: options.includeUnverified ?? true }
  }

  /**
   * `validityWhere` 的参数：按 SQL 中日期列的出现顺序绑 asOf，最后是 includeUnverified。
   * @param asOf - 判定时点。
   * @param includeUnverified - 是否放行时间列缺失/不可判定的记录。
   * @returns 与占位符顺序一致的参数。
   */
  private validityParams(asOf: string, includeUnverified: boolean): Array<string | number> {
    const params: Array<string | number> = []
    if (this.hasValidToColumn) params.push(asOf)
    if (this.hasValidFromColumn) params.push(asOf)
    params.push(includeUnverified ? 1 : 0)
    return params
  }

  /** 法规全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；按文档去重。 */
  search(keyword: string, options: KnowledgeLawSearchOptions = {}): LawSearchResult[] {
    const limit = resolveResultLimit(options.limit, 10, Number.MAX_SAFE_INTEGER)
    const { asOf, includeUnverified } = this.visibility(options)
    // SQL 已按时间效力过滤（在 LIMIT 之前），JS 再按规范化日期兜底：SQL 日期函数
    // 会把部分非法日期归一化，最终可见性以 resolveLawValidity 为准。
    const rows = this.runSearch(keyword, options, limit)
      .filter(row => isLawVisible(this.validityOf(row, asOf), includeUnverified))
    return rows.map(row => this.toSearchResult(row, asOf))
  }

  /** 按法规名模糊查找（返回全部匹配文档）。 */
  findByName(name: string, limit = 10, options: LawLookupOptions = {}): LawRecord[] {
    const pattern = `%${name.replace(/[%_\\]/g, m => `\\${m}`)}%`
    const { asOf, includeUnverified } = this.visibility(options)
    const rows = this.stmtFindByName.all(
      pattern,
      ...this.validityParams(asOf, includeUnverified),
      limit,
    ) as DocChunkRow[]
    return rows
      .filter(row => isLawVisible(this.validityOf(row, asOf), includeUnverified))
      .map(row => this.toRecord(row, asOf))
  }

  /** 按 documents.id 精确查询（语义路回源）；域外的文档类型不返回，与 search 的范围一致。 */
  getById(id: string, options: LawLookupOptions = {}): LawRecord | undefined {
    const { asOf, includeUnverified } = this.visibility(options)
    const row = this.stmtGetById.get(
      id,
      ...this.validityParams(asOf, includeUnverified),
    ) as DocChunkRow | undefined
    if (row === undefined) return undefined
    return isLawVisible(this.validityOf(row, asOf), includeUnverified) ? this.toRecord(row, asOf) : undefined
  }

  /** 批量按 documents.id 查询（一次 IN 查询）。 */
  getByIds(
    ids: string[],
    options: LawLookupOptions = {},
  ): LawRecord[] {
    const unique = Array.from(new Set(ids.filter(id => id.length > 0)))
    if (unique.length === 0) return []
    if (unique.length === 1) {
      const single = unique[0]
      /* v8 ignore start -- ids.filter(id => id.length > 0) can never yield an undefined element */
      if (single !== undefined) {
        const record = this.getById(single, options)
        return record ? [record] : []
      }
      return []
      /* v8 ignore stop */
    }
    const { asOf, includeUnverified } = this.visibility(options)
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`
        ${this.recordSelect}
        WHERE ${this.docTypeIn} AND d.id IN (${placeholders})${this.validityWhere}
      `)
      .all(...unique, ...this.validityParams(asOf, includeUnverified)) as DocChunkRow[]
    const byId = new Map(
      rows
        .filter(row => isLawVisible(this.validityOf(row, asOf), includeUnverified))
        .map(row => [row.document_id, this.toRecord(row, asOf)]),
    )
    return unique.map(id => byId.get(id)).filter((r): r is LawRecord => r !== undefined)
  }

  /** knowledge.db 无分类概念，返回空数组（接口对齐）。 */
  getCategories(): LawCategory[] {
    return []
  }

  /** 法规文档总数（诊断用）。 */
  count(): number {
    const row = this.stmtCount.get() as { c: number }
    return row.c
  }

  protected searchFts(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit)
  }

  protected searchFtsKeywords(keywords: string[], options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit)
  }

  private searchFtsWithQuery(query: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const rows = this.withLevelFilter(query, options, limit * FETCH_MULTIPLIER)
    return this.backfillContent(this.dedupeByDocument(rows, limit))
  }

  /**
   * 延迟解压回源：FTS 主查询不取正文（避免解压 FETCH_MULTIPLIER×limit 行全文），
   * 去重后仅对最终 top-limit 行按 (document_id, chunk_index) 回源**命中 chunk**
   * 片段（含解压）——保持旧行为"片段 = 命中的 chunk"。
   */
  private backfillContent(rows: DocChunkRow[]): DocChunkRow[] {
    return rows.map((row) => {
      if (row.content !== null) return row
      const hit = this.stmtGetChunkAt.get(row.chunk_index, row.document_id) as DocChunkRow | undefined
      return hit ? { ...row, content: decompressChunk(hit.content) } : row
    })
  }

  /** FTS 查询 + 可选 level 过滤（动态 SQL；无过滤走预编译热路径）。 */
  private withLevelFilter(match: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const { asOf, includeUnverified } = this.visibility(options)
    const validityParams = this.validityParams(asOf, includeUnverified)
    if (!options.level) {
      const ftsSearch = this.stmtSearchFts
      if (ftsSearch === null) {
        // 不可达：FTS 入口（search）已确认 hasFts && !ftsDegraded，prepare 失败会置 ftsDegraded。
        return []
      }
      return ftsSearch.all(match, ...validityParams, limit) as DocChunkRow[]
    }
    const sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source, ${this.filePathColumn}, ${this.validityColumns},
             NULL AS content, c.chunk_index, c.char_count, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ? AND ${this.docTypeIn} AND d.level = ?${this.validityWhere}
      ORDER BY bm25(docs_fts) LIMIT ?
    `
    return this.db
      .prepare(sql)
      .all(match, options.level, ...validityParams, limit) as DocChunkRow[]
  }

  protected searchLike(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    // LIKE 回退计数（设计内降级路径：短词/未命中/FTS 降级；不 warn 避免噪音）。
    this.stats?.recordLikeFallback()
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`
    const { asOf, includeUnverified } = this.visibility(options)
    const validityParams = this.validityParams(asOf, includeUnverified)
    if (!options.level) {
      return this.stmtSearchLike.all(pattern, pattern, ...validityParams, limit) as DocChunkRow[]
    }
    let sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source, ${this.filePathColumn}, ${this.validityColumns},
             sati_uncompress(c.content) AS content, c.char_count
      FROM documents d
      ${LONGEST_CHUNK_JOIN}
      WHERE ${this.docTypeIn}
        AND (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
    `
    const params: Array<string | number> = [pattern, pattern]
    // The !options.level early return above guarantees level is set here.
    /* v8 ignore next -- defensive re-check after the early return */
    if (options.level) {
      sql += ' AND d.level = ?'
      params.push(options.level)
    }
    sql += `${this.validityWhere} ORDER BY d.char_count DESC LIMIT ?`
    params.push(...validityParams)
    params.push(limit)
    return this.db.prepare(sql).all(...params) as DocChunkRow[]
  }

  /** 按文档去重（一文档一行，保留 bm25 最优 chunk——排序后首个出现的行）。 */
  private dedupeByDocument(rows: DocChunkRow[], limit: number): DocChunkRow[] {
    const seen = new Set<string>()
    const deduped: DocChunkRow[] = []
    for (const row of rows) {
      if (seen.has(row.document_id)) continue
      seen.add(row.document_id)
      deduped.push(row)
      if (deduped.length >= limit) break
    }
    return deduped
  }

  /** 按给定时点计算一行的效力状态；缺失列保持未核验。 */
  private validityOf(row: DocChunkRow, asOf: string): LawRecord['validity'] {
    return resolveLawValidity(
      { validFrom: row.valid_from, validTo: row.valid_to, expired: row.expired },
      asOf,
    )
  }

  private toRecord(row: DocChunkRow, asOf: string = todayIsoDate()): LawRecord {
    const content = decompressChunk(row.content)
    return {
      id: row.document_id,
      level: row.level ?? '其他',
      name: row.title,
      ...(row.file_path === null ? {} : { filename: row.file_path }),
      ...(row.publish_date === null ? {} : { publish: row.publish_date }),
      // 列缺失时保留 undefined：0 是「未废止」的断言，不能用来表示「不知道」。
      ...(row.expired === null ? {} : { expired: row.expired }),
      validity: this.validityOf(row, asOf),
      ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
      ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
      ...(row.validity_source === null ? {} : { validitySource: row.validity_source }),
      categoryId: 0,
      content: content.length > 0 ? content : undefined,
      categoryName: '法律法规',
    }
  }

  private toSearchResult(row: DocChunkRow, asOf: string): LawSearchResult {
    return { ...this.toRecord(row, asOf), score: row.fts_rank ?? 0 }
  }
}
