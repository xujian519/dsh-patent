/**
 * Legal regulation search engine for the legal domain (SQLite FTS5 + in-memory backends).
 *
 * Searches legal regulation records (法律法规) by keyword matching across
 * regulation name, article text, and level. Supports filtering by legal level
 * and point-in-time validity checking.
 *
 * Dual-backend architecture:
 * - SQLite mode (dbPath provided): FTS5 (BM25 ranking) → LIKE fallback → memory
 * - In-memory mode (no dbPath): keyword TF scoring (Phase 2 initial backend)
 *
 * FTS5 capability is probed at construction: the FTS table must exist AND the
 * runtime SQLite must have been compiled with FTS5 support.
 * @module @deepseek-ai/dsh-legal-knowledge/legal/search
 */

import { type DatabaseSync } from 'node:sqlite'
import { resolveResultLimit } from '@deepseek-ai/dsh-patent-core'
import { searchInMemory, filterRecords, toVisibleMemoryHits } from '../shared/memory-store.ts'
import { columnText, articleRowColumns, assignDatedColumns } from '../shared/row-text.ts'
import { filterByValidity, isVisible, resolveAsOf, resolveValidity } from '../shared/validity.ts'
import { prepareSearchText, SqliteBackedEngine, type SqliteSearchShape } from '../shared/sqlite-search.ts'
import type { LegalRegulationHit, LegalRegulationRecord, LegalSearchOptions } from '../types.ts'

/** Extract all searchable text from a legal regulation record. */
function extractSearchableText(record: LegalRegulationRecord): string {
  return [record.regulationName, record.articleText].join(' ')
}

/** Map one SQLite row to a regulation hit. */
function rowToHit(row: Record<string, unknown>, via: LegalRegulationHit['via']): LegalRegulationHit {
  const base: LegalRegulationHit = {
    regulationId: columnText(row.regulation_id ?? row.regulationId),
    regulationName: columnText(row.regulation_name ?? row.regulationName),
    level: (row.level ?? '其他') as LegalRegulationHit['level'],
    validity: 'unverified' as const, // Will be resolved by filterByValidity.
    ...articleRowColumns(row),
    relevanceScore: typeof row.fts_rank === 'number' ? row.fts_rank : 0,
    via,
  }
  return assignDatedColumns(base, row)
}

/** Map one SQLite row to a regulation record. */
function rowToRecord(row: Record<string, unknown>): LegalRegulationRecord {
  const base: LegalRegulationRecord = {
    // findRow matches this column, so a row handed to this mapper always carries it.
    regulationId: columnText(row.regulation_id),
    regulationName: columnText(row.regulation_name ?? row.regulationName),
    level: (row.level ?? '其他') as LegalRegulationRecord['level'],
    validity: 'unverified' as const,
    ...articleRowColumns(row),
  }
  return assignDatedColumns(base, row)
}

/** Build the regulation filter clause. */
function filterClause(
  options: LegalSearchOptions,
  alias: string,
): { sql: string; params: Array<string | number> } {
  if (!options.level) return { sql: '', params: [] }
  return { sql: ` AND ${alias}.level = ?`, params: [options.level] }
}

/** The regulation table's SQL shape. */
const REGULATION_TABLE: SqliteSearchShape<LegalSearchOptions, LegalRegulationHit> = {
  table: 'legal_regulations',
  alias: 'lr',
  ftsTable: 'legal_regulations_fts',
  likeColumns: ['regulation_name', 'article_text'],
  label: '法规',
  toHit: rowToHit,
  filterClause,
  // Over-fetch to account for validity filtering.
  fetchFactor: 2,
  postFilter: (hits, options) => filterByValidity(hits, options),
}

/**
 * Legal regulation search engine (SQLite FTS5 + in-memory dual backend).
 *
 * Provides keyword-based search over legal regulation records with filtering
 * by legal level and point-in-time validity checking. SQLite mode uses FTS5
 * BM25 ranking with LIKE fallback; in-memory mode uses term frequency scoring.
 */
export class LegalRegulationSearchEngine extends SqliteBackedEngine<LegalSearchOptions, LegalRegulationHit> {
  private readonly records: LegalRegulationRecord[]

  constructor(
    recordsOrOptions?: LegalRegulationRecord[] | {
      db?: DatabaseSync
      dbPath?: string
      records?: LegalRegulationRecord[]
      logger?: { warn: (message: string) => void }
    },
  ) {
    // Backward-compatible: accept either a records array or an options object.
    const options = Array.isArray(recordsOrOptions)
      ? { records: recordsOrOptions }
      : recordsOrOptions ?? {}
    super(options, REGULATION_TABLE)
    this.records = options.records ?? []
  }

  /**
   * Search legal regulation records by keyword.
   * NUL is removed before matching. An empty remainder returns no hits.
   * An omitted or non-finite cap uses 10. Any other cap is an integer of at least 1.
   * @param query - the search text.
   * @param options - result cap, level filter, and validity options.
   * @returns matching hits sorted by relevance (descending).
   */
  override search(query: string, options: LegalSearchOptions = {}): LegalRegulationHit[] {
    return super.search(query, options)
  }

  /**
   * Find regulations by name (fuzzy match).
   * @param name - the regulation name (or substring). NUL is removed first; an empty remainder returns no records.
   * @param limit - result cap. It defaults to 10, and a supplied cap is an integer of at least 1; a non-finite cap uses 10.
   * @param options - validity options.
   * @returns matching records.
   */
  findByName(name: string, limit = 10, options: LegalSearchOptions = {}): LegalRegulationRecord[] {
    const trimmed = prepareSearchText(name)
    if (!trimmed) return []
    const capped = resolveResultLimit(limit, 10, Number.MAX_SAFE_INTEGER)
    const asOf = resolveAsOf(options.asOf)
    const includeUnverified = options.includeUnverified ?? true
    if (this.sqlite.connected) {
      return this.findByNameFromSqlite(trimmed, capped, asOf, includeUnverified)
    }
    const lower = trimmed.toLowerCase()
    const matches = this.records
      .filter(r => r.regulationName.toLowerCase().includes(lower))
      .filter((r) => {
        const validity = resolveValidity(
          { effectiveDate: r.effectiveDate, expiryDate: r.expiryDate, expired: r.expired },
          asOf,
        )
        return isVisible(validity, includeUnverified)
      })
      .slice(0, capped)
    return matches.map(r => ({
      ...r,
      validity: resolveValidity(
        { effectiveDate: r.effectiveDate, expiryDate: r.expiryDate, expired: r.expired },
        asOf,
      ),
    }))
  }

  /**
   * Get a regulation record by its ID.
   * @param regulationId - the regulation identifier.
   * @param options - validity options.
   * @returns the record, or undefined when not found or not visible.
   */
  getById(regulationId: string, options: LegalSearchOptions = {}): LegalRegulationRecord | undefined {
    const asOf = resolveAsOf(options.asOf)
    const includeUnverified = options.includeUnverified ?? true
    if (this.sqlite.connected) {
      const row = this.sqlite.findRow('regulation_id', regulationId)
      if (row === undefined) return undefined
      const record = rowToRecord(row)
      const validity = resolveValidity(record, asOf)
      return isVisible(validity, includeUnverified) ? { ...record, validity } : undefined
    }
    const record = this.records.find(r => r.regulationId === regulationId)
    if (record === undefined) return undefined
    const validity = resolveValidity(
      { effectiveDate: record.effectiveDate, expiryDate: record.expiryDate, expired: record.expired },
      asOf,
    )
    return isVisible(validity, includeUnverified) ? { ...record, validity } : undefined
  }

  /**
   * Total number of regulation records.
   * @returns the total number of regulation records.
   */
  count(): number {
    if (this.sqlite.connected) return this.sqlite.count()
    return this.records.length
  }

  /**
   * Add records to the in-memory store (for bootstrap / incremental loading).
   * Only effective when the engine is in memory mode (no DB).
   * @param newRecords - records to add.
   */
  addRecords(newRecords: LegalRegulationRecord[]): void {
    this.records.push(...newRecords)
  }

  /** 按名称包含匹配读取记录，并在 SQLite 侧完成时间效力过滤。 */
  private findByNameFromSqlite(name: string, limit: number, asOf: string, includeUnverified: boolean): LegalRegulationRecord[] {
    const rows = this.sqlite.findRowsLike('regulation_name', name, limit * 2)
    const results: LegalRegulationRecord[] = []
    for (const row of rows) {
      if (results.length >= limit) break
      const record = rowToRecord(row)
      const validity = resolveValidity(record, asOf)
      if (!isVisible(validity, includeUnverified)) continue
      results.push({ ...record, validity })
    }
    return results
  }

  // --- Private: In-memory search path ---

  protected override searchInMemory(query: string, options: LegalSearchOptions, limit: number): LegalRegulationHit[] {
    const filtered = filterRecords(this.records, r => r.level, options.level)
    const hits = searchInMemory(filtered, query, extractSearchableText, limit * 2)
    return toVisibleMemoryHits(hits, options, limit)
  }
}
