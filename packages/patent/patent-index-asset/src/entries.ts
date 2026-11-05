/**
 * The entries of a shipped law index.
 *
 * Both the patent and the legal index transcribe one entry per article and
 * refuse the same malformed forms: duplicate numbers, empty topic lists, and a
 * transcription record where the text, its source, and its date disagree. This
 * module reads those entries so neither baseline carries its own copy of the
 * rules.
 * @module @deepseek-ai/dsh-patent-index-asset/entries
 */

import type { AssetFail } from './errors.ts'
import { readMapping, readOptionalCount, readOptionalString } from './fields.ts'
import { readRecordedSource, type RecordedSource } from './source.ts'

/** One indexed article, with its topics and transcription record. */
export type IndexedArticle = {
  /** Article number. */
  article: number
  /** Paragraph numbers the entry knows to exist; omitted when not yet verified. */
  paragraphs?: number[]
  /**
   * Topic keywords a proposition can name. They are one of the two signals a
   * proposition is matched by — the other is `text` — and they are an index aid,
   * not statutory text.
   */
  topics: string[]
  /** Article text, or null while it has not been transcribed. */
  text: string | null
} & RecordedSource

/** Read the optional paragraph list of one article. */
function readParagraphs(value: unknown, fail: AssetFail, article: number): { paragraphs?: number[] } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`第${article}条的 paragraphs 必须是 null 或非空数组`)
  }
  const paragraphs = value.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
      throw fail(`第${article}条的 paragraphs 只能是正整数`)
    }
    return item
  })
  if (new Set(paragraphs).size !== paragraphs.length) {
    throw fail(`第${article}条的 paragraphs 有重复款号`)
  }
  return { paragraphs }
}

/**
 * Read the topics of one indexed entry.
 *
 * A topic is a match keyword, so it is returned trimmed: `topics: [" 新颖性 "]`
 * would otherwise never match a proposition, which compares the declared strings
 * as written. Surrounding whitespace is the only change; the keyword itself is
 * kept verbatim.
 * @param value - the raw `topics` field.
 * @param fail - the caller's error factory.
 * @param where - the entry's label, used in the error message.
 * @returns the topic keywords, trimmed.
 */
export function readEntryTopics(value: unknown, fail: AssetFail, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`${where} 的 topics 必须是非空数组`)
  }
  return value.map((topic) => {
    if (typeof topic !== 'string' || topic.trim() === '') {
      throw fail(`${where} 的 topics 只能包含非空字符串`)
    }
    return topic.trim()
  })
}

/**
 * Enforce that an entry's transcription record is all-or-nothing.
 *
 * A text without a source or a date would be reported as verified while the
 * copy has no recorded source, and a source without a text claims a copy
 * that does not exist. Both are load errors, so a hand-edited index cannot
 * create the fail-open state the verifier is designed to avoid.
 * @param text - the entry's transcribed text, or null.
 * @param source - the recorded source and verification date.
 * @param fail - the caller's error factory.
 * @param where - the entry's label, used in the error message.
 */
export function checkRecordedSource(
  text: string | null,
  source: RecordedSource,
  fail: AssetFail,
  where: string,
): void {
  if (text !== null && (source.sourceDoc === null || source.verifiedOn === null)) {
    throw fail(`${where} 的 text 已转录，但 sourceDoc 与 verifiedOn 必须同时记录`)
  }
  if (text === null && (source.sourceDoc !== null || source.verifiedOn !== null)) {
    throw fail(`${where} 尚未转录 text，不能单独记录 sourceDoc 或 verifiedOn`)
  }
}

/**
 * Read the article list, rejecting duplicate numbers.
 * @param value - the raw `articles` field.
 * @param fail - the caller's error factory.
 * @returns the parsed entries, in declaration order.
 */
export function readArticleEntries(value: unknown, fail: AssetFail): IndexedArticle[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('字段 articles 必须是数组')
  const seen = new Set<number>()
  return value.map((item) => {
    const entry = readMapping(item, 'articles 的每一项', fail)
    const article = readOptionalCount(entry, 'article', fail)
    if (article === null) throw fail('article 必须是正整数')
    if (seen.has(article)) throw fail(`article 重复：${article}`)
    seen.add(article)
    const text = readOptionalString(entry, 'text', fail)
    const source = readRecordedSource(entry, fail)
    checkRecordedSource(text, source, fail, `第${article}条`)
    return {
      article,
      ...readParagraphs(entry['paragraphs'], fail, article),
      topics: readEntryTopics(entry['topics'], fail, `第${article}条`),
      text,
      ...source,
    }
  })
}
