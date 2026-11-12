/**
 * In-memory record store with keyword-based search (fallback backend).
 *
 * This module provides a simple in-memory store that supports keyword matching
 * for search. It serves as the fallback backend for legal-knowledge engines
 * when no SQLite database is configured or when useFts5 is false.
 *
 * Search scoring uses term frequency (TF) — the number of query terms that
 * appear in the record's searchable fields — normalized by field count.
 * @module @deepseek-ai/dsh-legal-knowledge/shared/memory-store
 */

import type { LegalRegulationValidity } from '../types.ts'
import { filterByValidity, type ValidityDated } from './validity.ts'

/** One in-memory search hit. */
export type MemoryHit<T> = {
  /** The matched record. */
  record: T
  /** Relevance score (higher is more relevant; count of matched query terms). */
  score: number
}

/**
 * Search records in memory by keyword matching across text extracted from each record.
 * @param records - the record array to search.
 * @param query - the search query (split into terms).
 * @param extractText - function to extract searchable text from a record.
 * @param limit - result cap.
 * @returns matching records sorted by score descending, capped at limit.
 */
export function searchInMemory<T>(
  records: T[],
  query: string,
  extractText: (record: T) => string,
  limit: number,
): MemoryHit<T>[] {
  const terms = extractSearchTerms(query)
  if (terms.length === 0) return []

  const hits: MemoryHit<T>[] = []
  for (const record of records) {
    const text = extractText(record).toLowerCase()
    let score = 0
    for (const term of terms) {
      if (text.includes(term)) score += 1
    }
    if (score > 0) hits.push({ record, score })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/**
 * Extract search terms from a query string (CJK-aware splitting).
 *
 * The in-memory backend and the SQLite `LIKE` rung share these terms so both
 * backends apply the same multi-term OR semantics to one query.
 * @param query - raw query string.
 * @returns lowercased terms of 2+ characters.
 */
export function extractSearchTerms(query: string): string[] {
  return query
    .trim()
    .split(/[\s,，。、；;：:"'（）()【】\[\]]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2)
}

/**
 * Filter records by a field value.
 *
 * `contains` mirrors the SQL `LIKE '%值%'` the `court` filter uses; `exact`
 * mirrors the SQL `=` the enum-like filters (`docType`, `caseType`, `level`,
 * `interpretationType`) use, so the in-memory backend matches the same records
 * as the SQLite backend.
 * @param records - the record array.
 * @param extractField - function to extract the filterable text from a record.
 * @param value - the filter value; undefined means no filtering.
 * @param match - `contains` for substring matching (default), `exact` for equality.
 * @returns filtered records.
 */
export function filterRecords<T>(
  records: T[],
  extractField: (record: T) => string | undefined,
  value: string | undefined,
  match: 'contains' | 'exact' = 'contains',
): T[] {
  if (value === undefined) return records
  if (match === 'exact') return records.filter(record => extractField(record) === value)
  const lower = value.toLowerCase()
  return records.filter((record) => {
    const fieldVal = extractField(record)
    return fieldVal !== undefined && fieldVal.toLowerCase().includes(lower)
  })
}

/**
 * 把内存命中按时间效力过滤并转换成引擎命中。
 *
 * 内存后端与 SQLite 后端共享相同的可见性规则：失效与未生效记录不返回，
 * 未核验记录由调用方决定是否返回。
 * @param hits - 内存检索命中（按得分降序）。
 * @param options - as-of 日期、未核验可见性与结果上限。
 * @param limit - 结果上限。options.limit 缺省时用它。
 * @returns 带效力状态与得分的可见命中。
 */
export function toVisibleMemoryHits<T extends ValidityDated>(
  hits: readonly MemoryHit<T>[],
  options: { asOf?: string | undefined; includeUnverified?: boolean | undefined; limit?: number | undefined },
  limit: number,
): Array<T & { validity: LegalRegulationValidity; relevanceScore: number; via: 'memory' }> {
  const dated = hits.map(hit => ({ ...hit.record, relevanceScore: hit.score, via: 'memory' as const }))
  return filterByValidity(dated, { ...options, limit: options.limit ?? limit })
}
