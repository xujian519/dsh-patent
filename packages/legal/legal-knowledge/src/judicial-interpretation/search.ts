/**
 * Judicial interpretation search engine for the legal domain (SQLite FTS5 + in-memory backends).
 *
 * Searches judicial interpretation records (司法解释) and guiding case records
 * (指导性案例) by keyword matching. Supports filtering by interpretation type
 * and point-in-time validity checking.
 *
 * Dual-backend architecture:
 * - SQLite mode (dbPath provided): FTS5 (BM25 ranking) → LIKE fallback → memory
 * - In-memory mode (no dbPath): keyword TF scoring (Phase 2 initial backend)
 *
 * FTS5 capability is probed at construction: the FTS table must exist AND the
 * runtime SQLite must have been compiled with FTS5 support.
 * @module @deepseek-ai/dsh-legal-knowledge/judicial-interpretation/search
 */

import { type DatabaseSync } from 'node:sqlite'
import { resolveResultLimit } from '@deepseek-ai/dsh-knowledge-core'
import { searchInMemory, filterRecords, toVisibleMemoryHits } from '../shared/memory-store.ts'
import { columnText, articleRowColumns, assignDatedColumns } from '../shared/row-text.ts'
import { filterByValidity, isVisible, resolveAsOf, resolveValidity } from '../shared/validity.ts'
import { prepareSearchText, SqliteBackedEngine, type SqliteSearchShape } from '../shared/sqlite-search.ts'
import type {
  GuidingCaseHit,
  GuidingCaseRecord,
  JudicialInterpretationHit,
  JudicialInterpretationRecord,
  JudicialInterpretationSearchOptions,
} from '../types.ts'

/** Extract all searchable text from a judicial interpretation record. */
function extractInterpretationText(record: JudicialInterpretationRecord): string {
  return [record.interpretationName, record.documentNumber, record.articleText].join(' ')
}

/** Extract all searchable text from a guiding case record. */
function extractGuidingCaseText(record: GuidingCaseRecord): string {
  return [record.caseName, record.guidingCaseNumber, record.keyPoints, record.fullText].join(' ')
}

/** Parse the related-laws column, which may be a JSON array, comma text, or an unrecognized value. */
function parseRelatedLaws(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      return value.split(',').map(s => s.trim()).filter(Boolean)
    }
  }
  return []
}

/** Map one SQLite row to a judicial interpretation record. */
function rowToRecord(row: Record<string, unknown>): JudicialInterpretationRecord {
  const base: JudicialInterpretationRecord = {
    interpretationId: columnText(row.interpretation_id ?? row.interpretationId),
    interpretationName: columnText(row.interpretation_name ?? row.interpretationName),
    interpretationType: (row.interpretation_type ?? row.interpretationType ?? 'judicial-interpretation') as JudicialInterpretationRecord['interpretationType'],
    issuingBody: columnText(row.issuing_body ?? row.issuingBody),
    documentNumber: columnText(row.document_number ?? row.documentNumber),
    validity: 'unverified' as const,
    ...articleRowColumns(row),
  }
  return assignDatedColumns(base, row)
}

/** Map one SQLite row to a judicial interpretation hit. */
function rowToHit(row: Record<string, unknown>, via: JudicialInterpretationHit['via']): JudicialInterpretationHit {
  return {
    ...rowToRecord(row),
    relevanceScore: typeof row.fts_rank === 'number' ? row.fts_rank : 0,
    via,
  }
}

/** Map one SQLite row to a guiding case record. */
function rowToGuidingCaseRecord(row: Record<string, unknown>): GuidingCaseRecord {
  return {
    caseId: columnText(row.case_id ?? row.caseId),
    guidingCaseNumber: columnText(row.guiding_case_number ?? row.guidingCaseNumber),
    caseName: columnText(row.case_name ?? row.caseName),
    court: columnText(row.court),
    decisionDate: columnText(row.decision_date ?? row.decisionDate),
    caseType: columnText(row.case_type ?? row.caseType),
    keyPoints: columnText(row.key_points ?? row.keyPoints),
    relatedLaws: parseRelatedLaws(row.related_laws ?? row.relatedLaws),
    fullText: columnText(row.full_text ?? row.fullText),
  }
}

/** Map one SQLite row to a guiding case hit. */
function rowToGuidingCaseHit(row: Record<string, unknown>, via: GuidingCaseHit['via']): GuidingCaseHit {
  return {
    ...rowToGuidingCaseRecord(row),
    relevanceScore: 0,
    via,
  }
}

/** Build the judicial interpretation filter clause. */
function filterClause(
  options: JudicialInterpretationSearchOptions,
  alias: string,
): { sql: string; params: Array<string | number> } {
  if (!options.interpretationType) return { sql: '', params: [] }
  return { sql: ` AND ${alias}.interpretation_type = ?`, params: [options.interpretationType] }
}

/** The judicial interpretation table's SQL shape. */
const INTERPRETATION_TABLE: SqliteSearchShape<JudicialInterpretationSearchOptions, JudicialInterpretationHit> = {
  table: 'judicial_interpretations',
  alias: 'ji',
  ftsTable: 'judicial_interpretations_fts',
  likeColumns: ['interpretation_name', 'article_text', 'document_number'],
  label: '司法解释',
  toHit: rowToHit,
  filterClause,
  // Over-fetch to account for validity filtering.
  fetchFactor: 2,
  postFilter: (hits, options) => filterByValidity(hits, options),
}

/** The guiding case table, matched by LIKE only; columns mirror the in-memory search text. */
const GUIDING_CASE_COLUMNS: readonly string[] = ['guiding_case_number', 'case_name', 'key_points', 'full_text']

/**
 * Judicial interpretation search engine (SQLite FTS5 + in-memory dual backend).
 *
 * Provides keyword-based search over judicial interpretation records and
 * guiding case records with filtering by interpretation type and point-in-time
 * validity checking. SQLite mode uses FTS5 BM25 ranking with LIKE fallback;
 * in-memory mode uses term frequency scoring.
 */
export class JudicialInterpretationSearch extends SqliteBackedEngine<JudicialInterpretationSearchOptions, JudicialInterpretationHit> {
  private readonly interpretations: JudicialInterpretationRecord[]
  private readonly guidingCases: GuidingCaseRecord[]

  constructor(options: {
    db?: DatabaseSync
    dbPath?: string
    interpretations?: JudicialInterpretationRecord[]
    guidingCases?: GuidingCaseRecord[]
    logger?: { warn: (message: string) => void }
  } = {}) {
    super(options, INTERPRETATION_TABLE)
    this.interpretations = options.interpretations ?? []
    this.guidingCases = options.guidingCases ?? []
  }

  /**
   * Search judicial interpretation records by keyword.
   * NUL is removed before matching. An empty remainder returns no hits.
   * An omitted or non-finite cap uses 10. Any other cap is an integer of at least 1.
   * @param query - the search text.
   * @param options - result cap, type filter, and validity options.
   * @returns matching hits sorted by relevance (descending).
   */
  override search(query: string, options: JudicialInterpretationSearchOptions = {}): JudicialInterpretationHit[] {
    return super.search(query, options)
  }

  /**
   * Search guiding cases by keyword.
   * @param query - the search text. NUL is removed first; an empty remainder returns no hits.
   * @param limit - result cap. It defaults to 10, and a supplied cap is an integer of at least 1; a non-finite cap uses 10.
   * @returns matching guiding case hits sorted by relevance.
   */
  searchGuidingCases(query: string, limit = 10): GuidingCaseHit[] {
    const trimmed = prepareSearchText(query)
    if (!trimmed) return []
    const capped = resolveResultLimit(limit, 10, Number.MAX_SAFE_INTEGER)

    if (this.sqlite.connected) {
      return this.searchGuidingCasesFromSqlite(trimmed, capped)
    }
    return this.searchGuidingCasesInMemory(trimmed, capped)
  }

  /**
   * Get a judicial interpretation by its ID.
   * @param interpretationId - the interpretation identifier.
   * @param options - validity options.
   * @returns the record, or undefined when not found or not visible.
   */
  getById(
    interpretationId: string,
    options: JudicialInterpretationSearchOptions = {},
  ): JudicialInterpretationRecord | undefined {
    const asOf = resolveAsOf(options.asOf)
    const includeUnverified = options.includeUnverified ?? true
    if (this.sqlite.connected) {
      const row = this.sqlite.findRow('interpretation_id', interpretationId)
      if (row === undefined) return undefined
      const record = rowToRecord(row)
      const validity = resolveValidity(record, asOf)
      return isVisible(validity, includeUnverified) ? { ...record, validity } : undefined
    }
    const record = this.interpretations.find(r => r.interpretationId === interpretationId)
    if (record === undefined) return undefined
    const validity = resolveValidity(
      { effectiveDate: record.effectiveDate, expiryDate: record.expiryDate, expired: record.expired },
      asOf,
    )
    return isVisible(validity, includeUnverified) ? { ...record, validity } : undefined
  }

  /**
   * Get a guiding case by its ID.
   * @param caseId - the guiding case identifier.
   * @returns the record, or undefined when not found.
   */
  getGuidingCaseById(caseId: string): GuidingCaseRecord | undefined {
    if (this.sqlite.connected) {
      const row = this.sqlite.findRow('case_id', caseId, 'guiding_cases')
      return row === undefined ? undefined : rowToGuidingCaseRecord(row)
    }
    return this.guidingCases.find(r => r.caseId === caseId)
  }

  /**
   * Total number of judicial interpretation records.
   * @returns the total number of judicial interpretation records.
   */
  countInterpretations(): number {
    if (this.sqlite.connected) return this.sqlite.count()
    return this.interpretations.length
  }

  /**
   * Total number of guiding case records.
   * @returns the total number of guiding case records.
   */
  countGuidingCases(): number {
    if (this.sqlite.connected) return this.sqlite.count('guiding_cases')
    return this.guidingCases.length
  }

  /**
   * Add interpretation records to the in-memory store (for bootstrap / incremental loading).
   * Only effective when the engine is in memory mode (no DB).
   * @param newRecords - records to add.
   */
  addInterpretations(newRecords: JudicialInterpretationRecord[]): void {
    this.interpretations.push(...newRecords)
  }

  /**
   * Add guiding case records to the in-memory store (for bootstrap / incremental loading).
   * Only effective when the engine is in memory mode (no DB).
   * @param newRecords - records to add.
   */
  addGuidingCases(newRecords: GuidingCaseRecord[]): void {
    this.guidingCases.push(...newRecords)
  }

  /** Close the underlying database connection (no-op for memory mode). */
  override close(): void {
    super.close()
  }

  // --- Private: SQLite search path (guiding cases) ---

  private searchGuidingCasesFromSqlite(keyword: string, limit: number): GuidingCaseHit[] {
    const rows = this.sqlite.findRowsLikeAny(GUIDING_CASE_COLUMNS, keyword, limit, 'guiding_cases')
    return rows.map(row => rowToGuidingCaseHit(row, 'like'))
  }

  // --- Private: In-memory search path ---

  protected override searchInMemory(
    query: string,
    options: JudicialInterpretationSearchOptions,
    limit: number,
  ): JudicialInterpretationHit[] {
    const filtered = filterRecords(this.interpretations, r => r.interpretationType, options.interpretationType, 'exact')
    const hits = searchInMemory(filtered, query, extractInterpretationText, limit * 2)
    return toVisibleMemoryHits(hits, options, limit)
  }

  private searchGuidingCasesInMemory(query: string, limit: number): GuidingCaseHit[] {
    const hits = searchInMemory(this.guidingCases, query, extractGuidingCaseText, limit)
    return hits.map(hit => ({
      ...hit.record,
      relevanceScore: hit.score,
      via: 'memory' as const,
    }))
  }
}
