/**
 * Case-law search engine for the legal domain (SQLite FTS5 + in-memory backends).
 *
 * Searches case-law records (裁判案例) by keyword matching across the columns
 * the FTS index covers: case name, full text, and summary. Document type, court,
 * and case type are filters and are not searchable text on either backend.
 *
 * Dual-backend architecture:
 * - SQLite mode (dbPath provided): FTS5 (BM25 ranking) → LIKE fallback → memory
 * - In-memory mode (no dbPath): keyword TF scoring (Phase 2 initial backend)
 *
 * FTS5 capability is probed at construction: the FTS table must exist AND the
 * runtime SQLite must have been compiled with FTS5 support.
 * @module @deepseek-ai/dsh-legal-knowledge/case-law/search
 */

import { type DatabaseSync } from 'node:sqlite'
import { resolveResultLimit } from '@deepseek-ai/dsh-knowledge-core'
import { searchInMemory, filterRecords } from '../shared/memory-store.ts'
import { columnText } from '../shared/row-text.ts'
import { prepareSearchText, SqliteBackedEngine, type SqliteSearchShape } from '../shared/sqlite-search.ts'
import type { CaseLawHit, CaseLawRecord, CaseLawSearchOptions } from '../types.ts'

/** Maximum result limit for case-law search. */
const MAX_LIMIT = 50

/**
 * Extract the text the FTS index covers, so the in-memory backend matches the
 * same columns as the SQLite backend's `case_law_fts` table.
 */
function extractSearchableText(record: CaseLawRecord): string {
  return [record.caseName, record.fullText, record.summary ?? ''].join(' ')
}

/** Map one SQLite row to a case-law hit. */
function rowToHit(row: Record<string, unknown>, via: CaseLawHit['via']): CaseLawHit {
  const base: CaseLawHit = {
    caseId: columnText(row.case_id ?? row.caseId),
    docType: (row.doc_type ?? row.docType ?? 'judgment') as CaseLawHit['docType'],
    caseName: columnText(row.case_name ?? row.caseName),
    court: columnText(row.court),
    decisionDate: columnText(row.decision_date ?? row.decisionDate),
    caseNumber: columnText(row.case_number ?? row.caseNumber),
    caseType: columnText(row.case_type ?? row.caseType),
    fullText: columnText(row.full_text ?? row.fullText),
    relevanceScore: typeof row.fts_rank === 'number' ? row.fts_rank : 0,
    via,
  }
  const summaryVal = row.summary
  if (summaryVal != null) base.summary = columnText(summaryVal)
  return base
}

/** Map one SQLite row to a case-law record. */
function rowToRecord(row: Record<string, unknown>): CaseLawRecord {
  const base: CaseLawRecord = {
    caseId: columnText(row.case_id),
    docType: (row.doc_type ?? 'judgment') as CaseLawRecord['docType'],
    caseName: columnText(row.case_name),
    court: columnText(row.court),
    decisionDate: columnText(row.decision_date),
    caseNumber: columnText(row.case_number),
    caseType: columnText(row.case_type),
    fullText: columnText(row.full_text),
  }
  const summaryVal = row.summary
  if (summaryVal != null) base.summary = columnText(summaryVal)
  return base
}

/** Build the case-law filter clause. */
function filterClause(
  options: CaseLawSearchOptions,
  alias: string,
): { sql: string; params: Array<string | number> } {
  let sql = ''
  const params: Array<string | number> = []
  if (options.docType) {
    sql += ` AND ${alias}.doc_type = ?`
    params.push(options.docType)
  }
  if (options.court) {
    sql += ` AND ${alias}.court LIKE ? ESCAPE '\\'`
    params.push(`%${options.court.replace(/[%_\\]/g, m => `\\${m}`)}%`)
  }
  if (options.caseType) {
    sql += ` AND ${alias}.case_type = ?`
    params.push(options.caseType)
  }
  return { sql, params }
}

/** The case-law table's SQL shape. */
const CASE_LAW_TABLE: SqliteSearchShape<CaseLawSearchOptions, CaseLawHit> = {
  table: 'case_law',
  alias: 'cl',
  ftsTable: 'case_law_fts',
  likeColumns: ['case_name', 'full_text', 'summary'],
  label: 'case-law',
  toHit: rowToHit,
  filterClause,
}

/**
 * Case-law search engine (SQLite FTS5 + in-memory dual backend).
 *
 * Provides keyword-based search over case-law records with filtering by
 * document type, court, and case type. SQLite mode uses FTS5 BM25 ranking
 * with LIKE fallback; in-memory mode uses term frequency scoring.
 */
export class CaseLawSearchEngine extends SqliteBackedEngine<CaseLawSearchOptions, CaseLawHit> {
  private readonly records: CaseLawRecord[]

  constructor(
    recordsOrOptions?: CaseLawRecord[] | {
      db?: DatabaseSync
      dbPath?: string
      records?: CaseLawRecord[]
      logger?: { warn: (message: string) => void }
    },
  ) {
    // Backward-compatible: accept either a records array or an options object.
    const options = Array.isArray(recordsOrOptions)
      ? { records: recordsOrOptions }
      : recordsOrOptions ?? {}
    super(options, CASE_LAW_TABLE)
    this.records = options.records ?? []
  }

  /**
   * Search case-law records by keyword.
   * NUL is removed before matching. An empty remainder returns no hits.
   * An omitted or non-finite cap uses 5. Any other cap is an integer in `[1, 50]`.
   * @param query - the search text.
   * @param options - result cap, docType, court, and caseType filters.
   * @returns matching hits sorted by relevance (descending).
   */
  override search(query: string, options: CaseLawSearchOptions = {}): CaseLawHit[] {
    const limit = resolveResultLimit(options.limit, 5, MAX_LIMIT)
    const trimmed = prepareSearchText(query)
    if (!trimmed) return []

    if (this.sqlite.connected) {
      return this.sqlite.search(trimmed, options, limit)
    }
    return this.searchInMemory(trimmed, options, limit)
  }

  /**
   * Get a case-law record by its ID.
   * @param caseId - the case identifier.
   * @returns the record, or undefined when not found.
   */
  getById(caseId: string): CaseLawRecord | undefined {
    if (this.sqlite.connected) {
      const row = this.sqlite.findRow('case_id', caseId)
      return row === undefined ? undefined : rowToRecord(row)
    }
    return this.records.find(r => r.caseId === caseId)
  }

  /**
   * Total number of case-law records.
   * @returns the total number of case-law records.
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
  addRecords(newRecords: CaseLawRecord[]): void {
    this.records.push(...newRecords)
  }

  // --- Private: In-memory search path ---

  protected override searchInMemory(query: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    let filtered = this.records
    filtered = filterRecords(filtered, r => r.docType, options.docType, 'exact')
    // `court` is a containment filter in SQL (`LIKE '%值%'`), so it keeps the default match.
    filtered = filterRecords(filtered, r => r.court, options.court)
    filtered = filterRecords(filtered, r => r.caseType, options.caseType, 'exact')

    const hits = searchInMemory(filtered, query, extractSearchableText, limit)

    return hits.map(hit => ({
      ...hit.record,
      relevanceScore: hit.score,
      via: 'memory' as const,
    }))
  }
}
