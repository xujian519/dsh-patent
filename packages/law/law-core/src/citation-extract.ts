/**
 * 引用候选的构造与汇总（领域无关步骤）。
 *
 * 专利域与法律域各自提供法条正则，但「把一个正则匹配构造成候选」「按出现
 * 位置排序、展开续指、按条文身份去重」「报告未识别的引用片段」这三步相同，
 * 收拢在这里，让两个域的 `reference` 模块只保留各自的语法。
 * @module @deepseek-ai/dsh-law-core/citation-extract
 */

import { parseCnNumber } from './cn-number.ts'
import type { ArticleCandidate } from './continuation.ts'
import {
  compactCitation,
  narrowed,
  normalizeCitationText,
  stripBookMarks,
} from './citation-text.ts'

/** The statute-pattern groups one law-article match captures. */
export type StatuteArticleGroups = {
  article: string
  paragraph?: string
  item?: string
  itemParen?: string
}

/**
 * Build the candidate of one statute-pattern match.
 * @param match - the pattern match, which supplies the span and the raw text.
 * @param groups - the match groups the statute pattern captures.
 * @param law - the statute the citation names.
 * @returns the candidate, or null when the numeral parser rejects the article number.
 */
export function readStatuteArticleCandidate<TLaw extends string>(
  match: RegExpExecArray,
  groups: StatuteArticleGroups,
  law: TLaw,
): ArticleCandidate<TLaw> | null {
  const article = parseCnNumber(groups.article)
  // A number the pattern allows but the numeral parser rejects, e.g. 第十十条.
  if (article === null || article < 1) return null
  return {
    start: match.index,
    end: match.index + match[0].length,
    reference: {
      kind: 'law-article',
      law,
      article,
      ...narrowed(groups.paragraph, groups.itemParen ?? groups.item),
      raw: stripBookMarks(match[0]),
    },
  }
}

/**
 * Collect the references of one scanned text: order the base matches, resolve
 * the references that follow them in the same sentence, and keep one reference
 * per provision.
 *
 * Continuation tokens share their written form (`第4款` under two articles), so
 * the deduplication compares the provision a candidate resolves to, not its
 * text as written.
 * @param candidates - the base matches, in the order the patterns found them.
 * @param limit - the end of the scanned text.
 * @param continuation - resolves the references that follow one base match.
 * @param identity - stable identity of a resolved reference.
 * @returns the deduplicated references, in text order.
 */
export function collectReferences<
  TCandidate extends { start: number; end: number; reference: TReference },
  TReference,
>(
  candidates: readonly TCandidate[],
  limit: number,
  continuation: (candidate: TCandidate, limit: number) => TCandidate[],
  identity: (reference: TReference) => string,
): TReference[] {
  const ordered = [...candidates].sort((a, b) => a.start - b.start)
  const expanded = [...ordered]
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index] as TCandidate
    expanded.push(...continuation(candidate, ordered[index + 1]?.start ?? limit))
  }
  expanded.sort((a, b) => a.start - b.start)

  const seen = new Set<string>()
  const references: TReference[] = []
  for (const candidate of expanded) {
    const key = identity(candidate.reference)
    if (seen.has(key)) continue
    seen.add(key)
    references.push(candidate.reference)
  }
  return references
}

/**
 * List the citation-like fragments in `text` that the parser did not resolve.
 *
 * A fragment already carried by a recognized reference is not reported, so a
 * text whose first citation was recognized but whose later citation was not
 * still names the unresolved remainder.
 * @param text - the text that was scanned.
 * @param recognized - the references the parser resolved.
 * @param pattern - the domain's fragment pattern.
 * @returns the unresolved fragments, deduplicated and capped at ten.
 */
export function scanUnrecognizedReferences(
  text: string,
  recognized: readonly { raw: string }[],
  pattern: RegExp,
): string[] {
  const raws = recognized.map(reference => compactCitation(normalizeCitationText(reference.raw)))
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of normalizeCitationText(text).matchAll(pattern)) {
    const token = match[0]
    const key = compactCitation(token)
    if (raws.some(raw => raw.includes(key))) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(token)
    if (out.length === 10) break
  }
  return out
}
