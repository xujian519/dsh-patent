/**
 * SQLite 全文检索骨架（legal-knowledge 三个检索引擎共用）。
 *
 * 托管双后端中 SQLite 一侧的公共部分：只读打开 + FTS5 双条件探测、
 * FTS 优先 / LIKE 兜底的检索阶梯、粘性降级、按表计数与连接关闭。
 * 各引擎提供表名、过滤子句、行映射与可选的结果后过滤；内存后端仍由
 * 各引擎自己持有记录数组。
 * @module @deepseek-ai/dsh-legal-knowledge/shared/sqlite-search
 */

import { type DatabaseSync } from 'node:sqlite'
import { createFtsLadder, type FtsSearchOps } from '@deepseek-ai/dsh-patent-core'
import { errorMessage } from '@deepseek-ai/dsh-value'
import { escapeFtsPhrase, joinFtsOrTerms, sqliteHasFts5 } from './fts.ts'
import { runFtsSearch } from './fts-search.ts'

/** 选择一个后端的构造选项。 */
type SqliteSearchBackendOptions = {
  /** 已打开的只读数据库连接。 */
  db?: DatabaseSync
  /** 只读打开的数据库路径。 */
  dbPath?: string
  /** 降级告警出口。 */
  logger?: { warn: (message: string) => void }
}

/** 一张表的检索形状。 */
export type SqliteSearchShape<TOptions, THit> = {
  /** 主表名。 */
  table: string
  /** 主表在 SQL 中的别名。 */
  alias: string
  /** FTS5 虚拟表名。 */
  ftsTable: string
  /** LIKE 兜底匹配的列名。 */
  likeColumns: readonly string[]
  /** 索引引擎在降级日志中的标签。 */
  label: string
  /** 行到命中的映射。 */
  toHit: (row: Record<string, unknown>, via: 'fts' | 'like') => THit
  /** 选项到额外 WHERE 子句的映射。 */
  filterClause: (options: TOptions, alias: string) => { sql: string; params: Array<string | number> }
  /** 为有效性后过滤预留的超取倍数；缺省 1。 */
  fetchFactor?: number
  /** 结果后过滤（如按时间效力）；缺省不过滤。 */
  postFilter?: (hits: THit[], options: TOptions) => THit[]
}

/**
 * 把检索词转成 LIKE 模式，转义 `%`、`_` 与反斜杠。
 * @param keyword - 原始检索词。
 * @returns 可直接绑定到 `LIKE ... ESCAPE '\'` 的模式。
 */
function likePattern(keyword: string): string {
  return `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`
}

/** 一个表的 SQLite 检索器。 */
export class SqliteFtsTable<TOptions, THit> {
  private readonly db: DatabaseSync | null
  private readonly hasFts: boolean
  private readonly logger?: { warn: (message: string) => void }
  private readonly shape: SqliteSearchShape<TOptions, THit>
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  private ftsDegraded = false
  /** 绑定当前实例的三条查询路径，供检索阶梯复用。 */
  private readonly ops: FtsSearchOps<TOptions, THit> = {
    searchFts: (keyword, options, limit) => this.searchFts(keyword, options, limit),
    searchFtsKeywords: (keywords, options, limit) => this.searchFtsKeywords(keywords, options, limit),
    searchLike: (keyword, options, limit) => this.searchLike(keyword, options, limit),
    degrade: (reason) => { this.degradeFts(reason) },
  }

  /**
   * 打开（或接管）数据库连接并探测 FTS5。
   * @param options - 已打开的连接、数据库路径与告警出口。
   * @param shape - 表名、别名、FTS 表、LIKE 列、行映射与过滤。
   */
  constructor(options: SqliteSearchBackendOptions, shape: SqliteSearchShape<TOptions, THit>) {
    this.shape = shape
    if (options.logger) {
      this.logger = options.logger
    }
    let db: DatabaseSync | null = null
    let openedHere = false
    try {
      if (options.db) {
        db = options.db
      } else if (options.dbPath) {
        const { DatabaseSync: DB } = process.getBuiltinModule('node:sqlite')
        db = new DB(options.dbPath, { readOnly: true })
        openedHere = true
      }
      // 双重条件才启用 FTS：FTS 表存在 + 运行时 SQLite 编译了 FTS5。
      if (db) {
        const row = db
          .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
          .get(shape.ftsTable) as { present: number } | undefined
        this.hasFts = row !== undefined && sqliteHasFts5(db)
      } else {
        this.hasFts = false
      }
    } catch (error) {
      // The connection this constructor opened must not outlive the failed construction.
      if (openedHere) db?.close()
      throw error
    }
    this.db = db
  }

  /** SQLite 后端是否已连接。 */
  get connected(): boolean {
    return this.db !== null
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded
  }

  /**
   * 按关键词执行一次 FTS 优先、LIKE 兜底的检索。
   * @param keyword - 已 trim 的非空检索词。
   * @param options - 引擎的检索选项。
   * @param limit - 结果上限。
   * @returns 命中列表；未连接数据库时为空。
   */
  search(keyword: string, options: TOptions, limit: number): THit[] {
    if (!this.db) return []
    return runFtsSearch(createFtsLadder(
      { keyword, hasFts: this.hasFts, ftsDegraded: this.ftsDegraded },
      options,
      limit,
      this.ops,
    ))
  }

  /**
   * 读取一行。
   * @param column - 查询列名。
   * @param value - 列值。
   * @param table - 表名；缺省为本形状的主表。
   * @returns 原始行，未找到或查询失败时为 undefined。
   */
  findRow(column: string, value: string, table: string = this.shape.table): Record<string, unknown> | undefined {
    if (!this.db) return undefined
    try {
      return this.db
        .prepare(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`)
        .get(value)
    } catch (error) {
      this.warnQueryFailure('findRow', error)
      return undefined
    }
  }

  /**
   * 按一列的包含匹配读取多行。
   * @param column - 匹配列名。
   * @param value - 包含匹配的文本。
   * @param limit - 返回行数上限。
   * @returns 原始行列表；未连接或查询失败时为空。
   */
  findRowsLike(column: string, value: string, limit: number): Array<Record<string, unknown>> {
    if (!this.db) return []
    try {
      return this.db
        .prepare(`SELECT * FROM ${this.shape.table} WHERE ${column} LIKE ? ESCAPE '\\' LIMIT ?`)
        .all(likePattern(value), limit)
    } catch (error) {
      this.warnQueryFailure('findRowsLike', error)
      return []
    }
  }

  /**
   * 按多列中任一列的包含匹配读取多行。
   * @param columns - 参与匹配的列名。
   * @param value - 包含匹配的文本。
   * @param limit - 返回行数上限。
   * @param table - 表名；缺省为本形状的主表。
   * @returns 原始行列表；未连接或查询失败时为空。
   */
  findRowsLikeAny(
    columns: readonly string[],
    value: string,
    limit: number,
    table: string = this.shape.table,
  ): Array<Record<string, unknown>> {
    if (!this.db) return []
    const pattern = likePattern(value)
    const where = columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')
    try {
      return this.db
        .prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT ?`)
        .all(...columns.map(() => pattern), limit)
    } catch (error) {
      this.warnQueryFailure('findRowsLikeAny', error)
      return []
    }
  }

  /**
   * 表内记录数；查询失败时为 0。
   * @param table - 表名。
   * @returns 记录数。
   */
  count(table: string = this.shape.table): number {
    if (!this.db) return 0
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
      return row.c
    } catch (error) {
      this.warnQueryFailure('count', error)
      return 0
    }
  }

  /** 关闭底层数据库连接（未连接时无操作）。 */
  close(): void {
    this.db?.close()
  }

  private degradeFts(reason: string): void {
    this.ftsDegraded = true
    this.logger?.warn(`[legal-knowledge] ${this.shape.label} FTS5 不可用，已降级 LIKE: ${reason}`)
  }

  /** Report a failed query instead of letting it look like an empty result. */
  private warnQueryFailure(operation: string, error: unknown): void {
    this.logger?.warn(`[legal-knowledge] ${this.shape.label} ${operation} 查询失败: ${errorMessage(error)}`)
  }

  private searchFts(keyword: string, options: TOptions, limit: number): THit[] {
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit)
  }

  private searchFtsKeywords(keywords: string[], options: TOptions, limit: number): THit[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit)
  }

  private searchFtsWithQuery(matchQuery: string, options: TOptions, limit: number): THit[] {
    const { sql, params } = this.buildFtsQuery(options, limit)
    /* v8 ignore next -- the ladder reaches this method only after search() saw a connection */
    if (this.db === null) return []
    // A failed MATCH propagates to runFtsSearch, which degrades sticky and
    // retries LIKE with the original query instead of an FTS expression.
    const rows = this.db.prepare(sql).all(matchQuery, ...params) as Array<Record<string, unknown>>
    return this.mapHits(rows.map(row => this.shape.toHit(row, 'fts')), options)
  }

  private buildFtsQuery(options: TOptions, limit: number): { sql: string; params: Array<string | number> } {
    const { alias, ftsTable } = this.shape
    const { sql: filterSql, params: filterParams } = this.shape.filterClause(options, alias)
    const params: Array<string | number> = [...filterParams, limit * (this.shape.fetchFactor ?? 1)]
    return {
      sql: `
      SELECT ${alias}.*, bm25(${ftsTable}) AS fts_rank
      FROM ${ftsTable}
      JOIN ${this.shape.table} ${alias} ON ${alias}.id = ${ftsTable}.rowid
      WHERE ${ftsTable} MATCH ?
      ${filterSql}
      ORDER BY bm25(${ftsTable}) LIMIT ?
    `,
      params,
    }
  }

  private searchLike(keyword: string, options: TOptions, limit: number): THit[] {
    const { alias, table } = this.shape
    const pattern = likePattern(keyword)
    const { sql: filterSql, params: filterParams } = this.shape.filterClause(options, alias)
    const columns = this.shape.likeColumns.map(column => `${alias}.${column} LIKE ? ESCAPE '\\'`).join('\n             OR ')
    const sql = `
      SELECT ${alias}.*
      FROM ${table} ${alias}
      WHERE (${columns})
      ${filterSql}
      LIMIT ?
    `
    const params: Array<string | number> = [
      ...this.shape.likeColumns.map(() => pattern),
      ...filterParams,
      limit * (this.shape.fetchFactor ?? 1),
    ]
    try {
      /* v8 ignore next -- search() and the FTS catch reach this method only with a connection */
      if (this.db === null) return []
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
      return this.mapHits(rows.map(row => this.shape.toHit(row, 'like')), options)
    } catch (error) {
      this.warnQueryFailure('searchLike', error)
      return []
    }
  }

  private mapHits(hits: THit[], options: TOptions): THit[] {
    return this.shape.postFilter === undefined ? hits : this.shape.postFilter(hits, options)
  }
}

/**
 * 双后端检索引擎的公共骨构。
 *
 * 子类提供内存检索与表形状；`search`、`close` 与 `ftsAvailable` 在两种
 * 后端下行为一致，由这里统一实现。
 */
export abstract class SqliteBackedEngine<
  TOptions extends { limit?: number | undefined },
  THit,
> {
  protected readonly sqlite: SqliteFtsTable<TOptions, THit>

  /**
   * 创建引擎并连接 SQLite 后端（可无连接，此时只用内存记录）。
   * @param options - 已打开的连接、数据库路径与告警出口。
   * @param shape - 表名、别名、FTS 表、LIKE 列、行映射与过滤。
   */
  protected constructor(options: SqliteSearchBackendOptions, shape: SqliteSearchShape<TOptions, THit>) {
    this.sqlite = new SqliteFtsTable(options, shape)
  }

  /**
   * 按关键词检索；有数据库连接时走 SQLite，否则回退内存记录。
   * @param query - 检索文本。
   * @param options - 引擎的检索选项。
   * @returns 命中列表。
   */
  search(query: string, options: TOptions): THit[] {
    const limit = options.limit ?? 10
    const trimmed = query.trim()
    if (!trimmed) return []
    if (this.sqlite.connected) return this.sqlite.search(trimmed, options, limit)
    return this.searchInMemory(trimmed, options, limit)
  }

  /** 内存后端检索；只在没有数据库连接时调用。 */
  protected abstract searchInMemory(query: string, options: TOptions, limit: number): THit[]

  /** 关闭底层数据库连接（内存模式无操作）。 */
  close(): void {
    this.sqlite.close()
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.sqlite.ftsAvailable
  }
}
