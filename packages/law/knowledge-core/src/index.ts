/**
 * Knowledge-database query machinery shared by the legal and patent domains:
 * the FTS5 helpers and the FTS-to-LIKE degradation ladder, query-text
 * sanitization, query keyword splitting, result-cap normalization, statute
 * validity rules, the shared install file operations, and real-path
 * normalization.
 * @module @deepseek-ai/dsh-knowledge-core
 */

export { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sanitizeSearchText, sqliteHasFts5 } from './fts.ts'
export { createFtsLadder, runFtsSearch } from './fts-search.ts'
export type { FtsSearchLadder, FtsSearchOps } from './fts-search.ts'
export { extractLawKeywords } from './keywords.ts'
export { resolveResultLimit } from './result-limit.ts'
export { isLawVisible, resolveAsOf, resolveLawValidity, todayIsoDate } from './validity.ts'
export type { LawValidity, LawValidityInput } from './validity.ts'
export {
  commitTempSibling,
  countTableRows,
  formatGigabytes,
  prepareTempSibling,
} from './install-fs.ts'
export { resolveRealPath } from './real-path.ts'
