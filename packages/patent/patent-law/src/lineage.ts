/**
 * Law-article lineage loader and query functions.
 *
 * Loads a YAML snapshot that records how each article of a statute has evolved
 * across revisions, and provides point-in-time and diff queries over that
 * history.
 * @module @deepseek-ai/dsh-patent-law/lineage
 */

import { readFileSync } from 'node:fs'
import {
  IndexAssetError,
  parseYamlMapping,
  readMapping,
  readOptionalBoolean,
  readOptionalString,
  readString,
  type AssetFail,
} from '@deepseek-ai/dsh-patent-index-asset'
import type {
  ArticleLineage,
  ArticleRevision,
  LawLineageSnapshot,
  RevisionDescriptor,
  StatuteName,
  ValidityState,
} from './types.ts'

/** Thrown when a lineage asset file is missing, unreadable, or malformed. */
export class LawLineageError extends IndexAssetError {
  /**
   * @param message - what is wrong with the asset.
   * @param origin - the file the error came from.
   */
  constructor(message: string, origin: string | null) {
    super(message, origin)
    this.name = 'LawLineageError'
  }
}

/** Statute names a lineage file may declare. */
const LINEAGE_LAW_NAMES: readonly StatuteName[] = ['专利法', '专利法实施细则']

/**
 * Load a lineage snapshot from a YAML file.
 * @param filePath - path to the YAML file.
 * @returns the parsed snapshot.
 * @throws LawLineageError when the file is unreadable or malformed.
 */
export function loadLawLineageFile(filePath: string): LawLineageSnapshot {
  return parseLawLineage(readFileSync(filePath, 'utf8'), filePath)
}

/**
 * Parse a lineage snapshot from YAML text.
 * @param source - the file's text.
 * @param origin - the file path, used in error messages.
 * @returns the parsed snapshot.
 * @throws LawLineageError when the YAML is malformed.
 */
export function parseLawLineage(source: string, origin: string): LawLineageSnapshot {
  const fail: AssetFail = message => new LawLineageError(message, origin)
  const root = parseYamlMapping(source, '法条沿革快照', fail)

  const law = readString(root, 'law', fail)
  if (!isLineageStatuteName(law)) throw fail(`未知的法律名称：${law}`)
  const document = readString(root, 'document', fail)
  const lineageVersion = readString(root, 'lineageVersion', fail)
  const revisions = readRevisions(root['revisions'], fail)
  const articles = readArticleLineages(root['articles'], fail, revisions)

  return {
    law,
    document,
    lineageVersion,
    revisions,
    articles: [...articles].sort((a, b) => a.articleId - b.articleId),
  }
}

/**
 * Query the complete lineage of one article.
 * @param lineage - the loaded snapshot.
 * @param articleId - the article number.
 * @returns the article lineage, or null when the article is not recorded.
 */
export function queryArticleLineage(
  lineage: LawLineageSnapshot,
  articleId: number,
): ArticleLineage | null {
  return lineage.articles.find(a => a.articleId === articleId) ?? null
}

/**
 * Query the revision effective at a given date for one article.
 *
 * Walks the revision history chronologically and returns the latest revision
 * whose effective date is on or before the query date.
 * @param lineage - the loaded snapshot.
 * @param articleId - the article number.
 * @param date - the query date (YYYY-MM-DD).
 * @returns the applicable revision, or null when no revision is effective by that date.
 */
export function queryArticleAtDate(
  lineage: LawLineageSnapshot,
  articleId: number,
  date: string,
): ArticleRevision | null {
  const article = queryArticleLineage(lineage, articleId)
  if (article === null) return null
  let result: ArticleRevision | null = null
  for (const revision of article.revisionHistory) {
    if (revision.effectiveDate <= date) {
      result = revision
    } else {
      break
    }
  }
  return result
}

/**
 * Compute the status distribution across all articles, optionally filtered by date.
 *
 * When no date is given, counts every article by its `currentStatus`. When a
 * date is given, only articles that have at least one revision effective on or
 * before that date are counted; articles not yet in force by the query date are
 * excluded entirely. The status bucket used is always the article's
 * `currentStatus` — the date filters *which* articles are counted, not *which*
 * status is read. This is intentional: `currentStatus` reflects the latest
 * known classification, while the date acts as an existence filter ("was this
 * article in force by this date?").
 *
 * Note: this function does NOT reconstruct the historical status at the given
 * date. For point-in-time status of a single article, use `queryArticleAtDate`.
 * @param lineage - the loaded snapshot.
 * @param date - optional query date (YYYY-MM-DD); when omitted, all articles are counted.
 * @returns counts keyed by validity state.
 */
export function queryStatusSnapshot(
  lineage: LawLineageSnapshot,
  date?: string,
): Record<ValidityState, number> {
  const counts: Record<ValidityState, number> = {
    active: 0,
    revised: 0,
    repealed: 0,
    unverified: 0,
  }
  for (const article of lineage.articles) {
    if (date === undefined) {
      counts[article.currentStatus]++
    } else {
      const revision = queryArticleAtDate(lineage, article.articleId, date)
      if (revision !== null) {
        // The date only gates whether the article is counted at all; the
        // bucket is always the article's currentStatus (today's classification).
        counts[article.currentStatus]++
      }
    }
  }
  return counts
}

/**
 * Find articles that differ between two revisions.
 *
 * Returns the lineage records of articles whose `changed` flag is set in the
 * `toRevision`, i.e. articles that were substantively modified.
 * @param lineage - the loaded snapshot.
 * @param fromRevision - the earlier revision identifier.
 * @param toRevision - the later revision identifier.
 * @returns the articles changed between the two revisions.
 */
export function queryDiffBetween(
  lineage: LawLineageSnapshot,
  fromRevision: string,
  toRevision: string,
): ArticleLineage[] {
  const fromIdx = lineage.revisions.findIndex(r => r.id === fromRevision)
  const toIdx = lineage.revisions.findIndex(r => r.id === toRevision)
  if (fromIdx < 0 || toIdx < 0) return []
  if (fromIdx >= toIdx) return []

  return lineage.articles.filter(article =>
    article.revisionHistory.some(
      rev => rev.revision === toRevision && rev.changed,
    ),
  )
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function isLineageStatuteName(value: string): value is StatuteName {
  return (LINEAGE_LAW_NAMES as readonly string[]).includes(value)
}

function readRevisions(value: unknown, fail: AssetFail): RevisionDescriptor[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('字段 revisions 必须是非空数组')
  }
  const seen = new Set<string>()
  let previousDate: string | undefined
  return value.map((item) => {
    const entry = readMapping(item, 'revisions 的每一项', fail)
    const id = readString(entry, 'id', fail)
    if (seen.has(id)) throw fail(`revisions 的 id 重复：${id}`)
    seen.add(id)
    const label = readString(entry, 'label', fail)
    const effectiveDate = readString(entry, 'effectiveDate', fail)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate)) {
      throw fail(`revisions[${id}].effectiveDate 必须是 YYYY-MM-DD 格式`)
    }
    // 修订目录按生效时间升序：queryDiffBetween 用目录下标作为时间先后。
    if (previousDate !== undefined && effectiveDate <= previousDate) {
      throw fail(`revisions 必须按 effectiveDate 升序排列（${id} 的 ${effectiveDate} 不晚于 ${previousDate}）`)
    }
    previousDate = effectiveDate
    const source = readString(entry, 'source', fail)
    return { id, label, effectiveDate, source }
  })
}

function readArticleLineages(
  value: unknown,
  fail: AssetFail,
  revisions: readonly RevisionDescriptor[],
): ArticleLineage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('字段 articles 必须是非空数组')
  }
  const catalogue = new Map(revisions.map(revision => [revision.id, revision.effectiveDate]))
  const seen = new Set<number>()
  return value.map((item) => {
    const entry = readMapping(item, 'articles 的每一项', fail)
    const articleId = readArticleId(entry, fail)
    if (seen.has(articleId)) throw fail(`articles 的 articleId 重复：${articleId}`)
    seen.add(articleId)
    const title = readOptionalString(entry, 'title', fail)
    const currentStatus = readStatus(entry, fail, articleId)
    const revisionHistory = readRevisionHistory(entry['revisionHistory'], fail, articleId)
    if (revisionHistory.length === 0) {
      throw fail(`第${articleId}条的 revisionHistory 必须至少有一条记录`)
    }
    validateRevisionHistory(articleId, revisionHistory, catalogue, fail)
    return { articleId, title, currentStatus, revisionHistory }
  })
}

/**
 * A history entry must name a catalogued revision, carry that revision's
 * effective date, and stay in ascending date order. `queryArticleAtDate` stops
 * at the first later date and `queryDiffBetween` matches revision ids, so an
 * unvalidated typo or reordering silently mis-decides both queries.
 */
function validateRevisionHistory(
  articleId: number,
  revisionHistory: readonly ArticleRevision[],
  catalogue: ReadonlyMap<string, string>,
  fail: AssetFail,
): void {
  let previousDate: string | undefined
  for (const revision of revisionHistory) {
    const declaredDate = catalogue.get(revision.revision)
    if (declaredDate === undefined) {
      throw fail(`第${articleId}条的 revisionHistory 引用了 revisions 中不存在的修订：${revision.revision}`)
    }
    if (revision.effectiveDate !== declaredDate) {
      throw fail(`第${articleId}条 ${revision.revision} 的 effectiveDate 为 ${revision.effectiveDate}，与 revisions 的 ${declaredDate} 不一致`)
    }
    if (previousDate !== undefined && revision.effectiveDate <= previousDate) {
      throw fail(`第${articleId}条的 revisionHistory 必须按 effectiveDate 升序排列（${revision.revision} 的 ${revision.effectiveDate} 不晚于 ${previousDate}）`)
    }
    previousDate = revision.effectiveDate
  }
}

function readArticleId(entry: Record<string, unknown>, fail: AssetFail): number {
  const value = entry['articleId']
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw fail('articleId 必须是正整数')
  }
  return value
}

function readStatus(
  entry: Record<string, unknown>,
  fail: AssetFail,
  articleId: number,
): ValidityState {
  const value = entry['currentStatus']
  const valid: readonly ValidityState[] = ['active', 'revised', 'repealed', 'unverified']
  if (typeof value !== 'string' || !(valid as readonly string[]).includes(value)) {
    throw fail(`第${articleId}条的 currentStatus 必须是 active/revised/repealed/unverified 之一`)
  }
  return value as ValidityState
}

function readRevisionHistory(
  value: unknown,
  fail: AssetFail,
  articleId: number,
): ArticleRevision[] {
  if (!Array.isArray(value)) {
    throw fail(`第${articleId}条的 revisionHistory 必须是数组`)
  }
  return value.map((item, idx) => {
    const entry = readMapping(item, `第${articleId}条 revisionHistory[${idx}]`, fail)
    const revision = readString(entry, 'revision', fail)
    const effectiveDate = readString(entry, 'effectiveDate', fail)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate)) {
      throw fail(`第${articleId}条 revisionHistory[${idx}].effectiveDate 必须是 YYYY-MM-DD`)
    }
    const text = readOptionalString(entry, 'text', fail)
    const changed = readOptionalBoolean(entry, 'changed', fail)
    if (changed === null) {
      throw fail(`第${articleId}条 revisionHistory[${idx}].changed 必须声明`)
    }
    const source = readOptionalString(entry, 'source', fail)
    const base: ArticleRevision = { revision, effectiveDate, text, changed }
    if (source !== null) base.source = source
    return base
  })
}
