/**
 * 法条引用续指的解析（条 → 款 → 项）。
 *
 * 一段文字里的后续引用会继承前面的上下文：`专利法第22条、第23条`、
 * `第22条第2款、第3款`、或者链式的 `、第26条第4款`。识别规则与领域无关，
 * 专利表与法律表共用；调用方只提供基准匹配与扫描边界。
 * @module @deepseek-ai/dsh-law-core/continuation
 */

import { parseCnNumber } from './cn-number.ts'

/** Number written in Chinese numerals or Arabic digits. */
const NUMBER = '[〇零一二三四五六七八九十百0-9]{1,6}'

/**
 * One reference that follows another in the same sentence and inherits its
 * context. The leading coordinator is required, so a citation in the next
 * sentence is not folded into the previous one.
 */
export const ARTICLE_CONTINUATION_PATTERN = new RegExp(
  '\\s*[、，,和及与或]\\s*第\\s*'
  + `(?:[（(]\\s*(?<n1p>${NUMBER})\\s*[）)]|(?<n1>${NUMBER}))`
  + '\\s*(?<u1>条|款|项)'
  + `(?:\\s*第\\s*(?:[（(]\\s*(?<n2p>${NUMBER})\\s*[）)]|(?<n2>${NUMBER}))\\s*(?<u2>款|项))?`
  + `(?:\\s*第\\s*(?:[（(]\\s*(?<n3p>${NUMBER})\\s*[）)]|(?<n3>${NUMBER}))\\s*项)?`,
  'y',
)

/** The groups {@link ARTICLE_CONTINUATION_PATTERN} captures, typed for direct use. */
type ContinuationGroups = {
  n1: string
  n1p?: string
  u1: string
  n2?: string
  n2p?: string
  u2?: string
  n3?: string
  n3p?: string
}

/** A statute-article reference, structurally compatible with each domain's own type. */
export type ArticleReferenceLike<TLaw extends string = string> = {
  kind: 'law-article'
  law: TLaw
  article: number
  paragraph?: number
  item?: number
  raw: string
}

/** One parsed reference with its span in the scanned text. */
export type ArticleCandidate<TLaw extends string = string> = {
  start: number
  end: number
  reference: ArticleReferenceLike<TLaw>
}

/** One unit of a continuation reference: its kind and parsed number. */
type ContinuationUnit = { unit: string; value: number }

/**
 * Parse one unit of a continuation reference.
 * @param value - the number text.
 * @param unit - 条, 款, or 项.
 * @param parenthesized - whether the number was written as 第（二）项.
 * @returns the unit, or null when the number or the wrapping is invalid.
 */
function readContinuationUnit(value: string, unit: string, parenthesized: boolean): ContinuationUnit | null {
  // A parenthesized number is an item (第（二）项), never a 条 or 款.
  if (parenthesized && unit !== '项') return null
  const parsed = parseCnNumber(value)
  if (parsed === null || parsed < 1) return null
  return { unit, value: parsed }
}

/**
 * Whether the units narrow in the only order a citation uses: 条, then 款,
 * then 项, each at most once.
 * @param units - the units of one continuation.
 * @returns true when the order is 条 → 款 → 项 without repeats.
 */
function narrowingUnits(units: readonly ContinuationUnit[]): boolean {
  let previous = -1
  for (const { unit } of units) {
    const rank = unit === '条' ? 0 : unit === '款' ? 1 : 2
    if (rank <= previous) return false
    previous = rank
  }
  return true
}

/**
 * Resolve the references that follow `base` in the same sentence and inherit
 * its law, article, paragraph, or item.
 *
 * Only the gap before the next base match is scanned, and the first token must
 * begin with a coordinator, so `专利法第22条。第23条` stays two separate
 * sentences. The returned raw is the token alone (`第23条`), since the inherited
 * law is not written there.
 * @param text - the normalized text.
 * @param base - the base match whose context is inherited.
 * @param limit - the end of the gap to scan.
 * @returns the continuation candidates.
 */
export function readArticleContinuations<TLaw extends string>(
  text: string,
  base: ArticleCandidate<TLaw>,
  limit: number,
): ArticleCandidate<TLaw>[] {
  const reference = base.reference
  // Scan only the gap before the next base match, so a continuation can never
  // absorb a citation that the base patterns already own.
  const gap = text.slice(base.end, limit)
  const out: ArticleCandidate<TLaw>[] = []
  let cursor = 0
  // Each continuation inherits from the previous one, not from the base: in
  // 专利法第22条、第23条第2款、第3款 the last 款 belongs to 第23条.
  let article = reference.article
  let paragraph = reference.paragraph
  let item = reference.item
  while (cursor < gap.length) {
    ARTICLE_CONTINUATION_PATTERN.lastIndex = cursor
    const match = ARTICLE_CONTINUATION_PATTERN.exec(gap)
    if (match === null) break
    const groups = match.groups as ContinuationGroups
    const units: ContinuationUnit[] = []
    const first = readContinuationUnit(groups.n1p ?? groups.n1, groups.u1, groups.n1p !== undefined)
    if (first === null) break
    units.push(first)
    if (groups.u2 !== undefined) {
      const second = readContinuationUnit(
        (groups.n2p ?? groups.n2) as string,
        groups.u2,
        groups.n2p !== undefined,
      )
      if (second === null) break
      units.push(second)
    }
    if (groups.n3 !== undefined || groups.n3p !== undefined) {
      const third = readContinuationUnit(
        (groups.n3p ?? groups.n3) as string,
        '项',
        groups.n3p !== undefined,
      )
      if (third === null) break
      units.push(third)
    }
    // 条 → 款 → 项 is the only narrowing order; a 款 after an item, or a
    // repeated unit, is not a reference this parser can attribute.
    if (!narrowingUnits(units)) break
    for (const { unit, value } of units) {
      if (unit === '条') {
        article = value
        paragraph = undefined
        item = undefined
      } else if (unit === '款') {
        paragraph = value
        item = undefined
      } else {
        item = value
      }
    }
    // The match always starts with the coordinator and then 第, so the raw
    // reference begins at that 第 and excludes the coordinator.
    const startInGap = match.index + match[0].indexOf('第')
    const endInGap = match.index + match[0].length
    out.push({
      start: base.end + startInGap,
      end: base.end + endInGap,
      reference: {
        kind: 'law-article',
        law: reference.law,
        article,
        ...(paragraph === undefined ? {} : { paragraph }),
        ...(item === undefined ? {} : { item }),
        raw: gap.slice(startInGap, endInGap),
      },
    })
    cursor = endInGap
  }
  return out
}
