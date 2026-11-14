/**
 * 法条引用的判定：索引状态、款号窄化，以及命题是否被条目支撑。
 *
 * 专利表与法律表各自的索引结构不同，但一条法条引用能得到的判定是同一组：
 * 未索引、超出上限、未转录、款号不符、命题有支撑、命题在别处、无法判定。
 * 判定与理由文案收拢在这里，两个域只负责取出本域的条目和渲染自己的 finding。
 * @module @deepseek-ai/dsh-law-core/article-decision
 */

import { parseCnNumber } from './cn-number.ts'
import {
  createOverlapIndex,
  PROPOSITION_SUPPORT_DEFAULT,
  textOverlap,
  topicOverlap,
  type ComparableEntry,
  type OverlapIndex,
} from './text-overlap.ts'

/** One indexed article the citation decision reads. */
export type DecisionArticle = {
  /** Article number. */
  article: number
  /** Paragraph numbers the entry knows to exist; omitted when not yet verified. */
  paragraphs?: number[]
  /** Topic keywords a proposition can name. */
  topics: string[]
  /** Article text, or null while it has not been transcribed. */
  text: string | null
  /** Official source the text was taken from, or null while unverified. */
  sourceDoc: string | null
  /** Date the entry's text was checked against `sourceDoc`, or null. */
  verifiedOn: string | null
}

/** The law fields the article decision reads. */
export type ArticleBaseline = {
  /** Law name, as the reasons name it. */
  law: string
  /** Highest article number the index records, or null while unverified. */
  maxArticle: number | null
  /** Date the article ceiling was verified, or null while unverified. */
  maxVerifiedOn: string | null
}

/** What a citation is offered in support of. */
export type ArticleProposition = {
  /** The proposition the citation is offered in support of, when the caller has one. */
  proposition?: string
  /** Overlap a proposition must reach before an entry's text supports it. */
  supportThreshold?: number
}

/** Decisions an article citation can reach. */
export type ArticleDecision =
  | 'valid'
  | 'mismatch'
  | 'unmatched'
  | 'out-of-range'
  | 'not-indexed'
  | 'unverified'

/** One article verdict, with the entry it used when one was found. */
export type ArticleVerdict<TEntry> = {
  /** What the citation resolves to. */
  decision: ArticleDecision
  /** Why the decision was reached, in the model's language. */
  reason: string
  /** The indexed entry the decision used, when one was found. */
  entry?: TEntry
}

/**
 * The text a proposition may be matched against. An entry whose source or
 * verification date is missing is not transcribed for matching, even when it
 * carries text, so a hand-built baseline cannot make it support a proposition.
 * @param entry - the article or section entry.
 * @returns its text when the transcription record is complete, otherwise null.
 */
export function transcribedText(entry: {
  text: string | null
  sourceDoc: string | null
  verifiedOn: string | null
}): string | null {
  return entry.text !== null && entry.sourceDoc !== null && entry.verifiedOn !== null ? entry.text : null
}

/**
 * Render a 0–1 score as a whole percentage for a reason line.
 * @param value - the 0–1 score.
 * @returns the rounded percentage.
 */
export function formatPercent(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/**
 * Truncate a proposition for a report line.
 * @param value - the proposition text.
 * @returns the text, truncated at 40 characters.
 */
export function truncateProposition(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`
}

/**
 * The reason a citation reports when another entry of the law carries the proposition.
 * @param law - the cited law name.
 * @param proposition - the proposition the citation supports.
 * @param elsewhere - the law entries that carry the proposition instead.
 * @returns the mismatch reason line.
 */
export function supportMismatchReason(law: string, proposition: string, elsewhere: readonly string[]): string {
  return `所引条目未被该命题支撑：《${law}》${elsewhere.join('、')}更贴近命题「${truncateProposition(proposition)}」`
}

/**
 * List every article of a law as a proposition candidate.
 * @param articles - the law's indexed articles.
 * @returns the entries the support decision compares a proposition against.
 */
export function articleComparableEntries(articles: readonly DecisionArticle[]): ComparableEntry[] {
  return articles.map(article => ({
    label: `第 ${article.article} 条`,
    topics: article.topics,
    text: transcribedText(article),
  }))
}

/** Overlap indices of the baselines already decided, so each text list is indexed once. */
const articleIndices = new WeakMap<object, OverlapIndex>()

/**
 * Get the overlap index of one baseline's articles.
 * @param baseline - the loaded baseline, used as the cache key.
 * @param entries - its articles as proposition candidates.
 * @returns the index, built on first use.
 */
function articleIndex(baseline: object, entries: readonly ComparableEntry[]): OverlapIndex {
  const cached = articleIndices.get(baseline)
  if (cached !== undefined) return cached
  const built = createOverlapIndex(entries)
  articleIndices.set(baseline, built)
  return built
}

/**
 * Find the entries of the cited entry's law that carry the proposition instead.
 * @param entries - the law's entries as proposition candidates.
 * @param index - the overlap index of those entries.
 * @param proposition - the claim the citation is offered in support of.
 * @param threshold - overlap at which transcribed text counts as support.
 * @param cited - the cited entry's label, which is excluded.
 * @param covered - labels the citation already covers, e.g. the subsections of a cited section.
 * @returns the labels of the entries that carry the proposition, at most three.
 */
export function findCompetingLabels(
  entries: readonly ComparableEntry[],
  index: OverlapIndex,
  proposition: string,
  threshold: number,
  cited: string,
  covered?: (label: string) => boolean,
): string[] {
  return entries
    .filter(entry => entry.label !== cited)
    .filter(entry => covered === undefined || !covered(entry.label))
    .filter(entry => topicOverlap(entry.topics, proposition)
      || (entry.text !== null && textOverlap(index, proposition, entry.text) >= threshold))
    .map(entry => entry.label)
    .slice(0, 3)
}

/** One paragraph of an article, with the item lines that belong to it. */
type ParagraphSpan = {
  paragraph: number
  text: string
  items: { item: number; text: string }[]
}

/** A proposition match limited to the cited paragraph or item. */
export type ArticleCitationFocus = {
  /** The text the proposition is matched against. */
  text: string
  /** True when that text is the named paragraph or item, not the whole article. */
  narrowed: boolean
  /** Other paragraphs or items of the same article the proposition might belong to. */
  siblings: { label: string; text: string }[]
  /** Set when the citation names an item the transcribed text does not contain. */
  missingItem: string | null
}

const ITEM_LINE = /^[（(]\s*([〇零一二三四五六七八九十百0-9]+)\s*[）)]/

/**
 * Read the item number at the start of a line, or null when the line is not an item.
 * @param line - one trimmed line of an article.
 * @returns the item, or null.
 */
function readItemLine(line: string): { item: number; text: string } | null {
  const match = ITEM_LINE.exec(line)
  const raw = match?.[1]
  if (raw === undefined) return null
  const item = parseCnNumber(raw)
  if (item === null) return null
  return { item, text: line }
}

/**
 * Split transcribed article text into paragraphs.
 *
 * A line that does not open with an item marker starts a paragraph. An item
 * line belongs to the paragraph before it; an article that opens with an item
 * keeps that item on the first paragraph.
 * @param text - the article text.
 * @returns the paragraphs, in order.
 */
function paragraphSpans(text: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = []
  let current: ParagraphSpan | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const item = readItemLine(line)
    if (item !== null) {
      if (current === null) {
        current = { paragraph: spans.length + 1, text: line, items: [item] }
        spans.push(current)
      } else {
        current.items.push(item)
        current.text = `${current.text}\n${line}`
      }
      continue
    }
    current = { paragraph: spans.length + 1, text: line, items: [] }
    spans.push(current)
  }
  return spans
}

/**
 * The text a paragraph- or item-level citation is decided against.
 *
 * Paragraph existence still comes from the entry's `paragraphs` list: a listed
 * paragraph is isolated only when the text has one span per listed paragraph,
 * in order. An item is isolated only when the host paragraph's text marks items.
 * Otherwise the whole article stays the match text, which is the behavior of an
 * entry that has not recorded its paragraphs.
 * @param entry - the indexed article.
 * @param reference - the cited paragraph and item, when the citation names them.
 * @returns the match text, the sibling spans, and a missing-item reason.
 */
export function articleCitationFocus(
  entry: { article: number; paragraphs?: number[]; text: string },
  reference: { paragraph?: number; item?: number },
): ArticleCitationFocus {
  const spans = paragraphSpans(entry.text)
  const listed = entry.paragraphs
  const aligned = listed !== undefined
    && spans.length === listed.length
    && listed.every((number, index) => number === index + 1)
  const citedParagraph = reference.paragraph
  const span = citedParagraph !== undefined && aligned ? spans[citedParagraph - 1] : undefined
  const host = span ?? (reference.item !== undefined && spans.length === 1 ? spans[0] : undefined)
  const whole = { text: entry.text, narrowed: false, siblings: [], missingItem: null }
  if (host === undefined) return whole
  const paragraphLabel = citedParagraph === undefined ? '' : `第 ${citedParagraph} 款`
  if (reference.item !== undefined && host.items.length > 0) {
    const item = host.items.find(candidate => candidate.item === reference.item)
    if (item === undefined) {
      return {
        text: host.text,
        narrowed: false,
        siblings: [],
        missingItem: `第 ${entry.article} 条${paragraphLabel}的正文不含第 ${reference.item} 项`,
      }
    }
    const siblings = host.items
      .filter(candidate => candidate.item !== item.item)
      .map(candidate => ({
        label: `第 ${entry.article} 条${paragraphLabel}第 ${candidate.item} 项`,
        text: candidate.text,
      }))
    return { text: item.text, narrowed: true, siblings, missingItem: null }
  }
  if (span === undefined) return whole
  return {
    text: span.text,
    narrowed: true,
    siblings: spans
      .filter(candidate => candidate.paragraph !== span.paragraph)
      .map(candidate => ({
        label: `第 ${entry.article} 条第 ${candidate.paragraph} 款`,
        text: candidate.text,
      })),
    missingItem: null,
  }
}

/** Report a cited paragraph the entry knows to be absent, or null when it is consistent. */
function checkNarrowing(reference: { article: number; paragraph?: number }, entry: DecisionArticle): string | null {
  if (reference.paragraph === undefined || entry.paragraphs === undefined) return null
  if (entry.paragraphs.includes(reference.paragraph)) return null
  return `第 ${entry.article} 条索引载明共 ${entry.paragraphs.length} 款，不含第 ${reference.paragraph} 款`
}

/**
 * Decide an article whose entry is transcribed, against the proposition the
 * citation is offered in support of.
 *
 * The entry itself must carry the proposition first, by its topic keywords or by
 * its own transcribed wording. Only when it does not, and another entry of the
 * same law does, is the citation reported as a mismatch — so a proposition
 * reworded around a synonym this index cannot see is reported as undecided
 * rather than as a contradiction.
 * @param reference - the parsed reference.
 * @param entry - the indexed entry the reference resolved to.
 * @param text - the entry's transcribed text, which the caller has established is present.
 * @param sourceDoc - the recorded source, which the caller has established is present.
 * @param baseline - the law's baseline, whose other entries are the competing homes.
 * @param options - the proposition and the support threshold.
 * @returns the verdict, with the reason and the entry it used.
 */
function decideTranscribed<TEntry extends DecisionArticle>(
  reference: { article: number; paragraph?: number; item?: number },
  entry: TEntry,
  text: string,
  sourceDoc: string,
  baseline: ArticleBaseline & { articles: readonly TEntry[] },
  options: ArticleProposition,
  focus: ArticleCitationFocus,
): ArticleVerdict<TEntry> {
  const paragraph = focus.narrowed && reference.paragraph !== undefined ? `第 ${reference.paragraph} 款` : ''
  const item = focus.narrowed && reference.item !== undefined ? `第 ${reference.item} 项` : ''
  const validReason = `与《${baseline.law}》第 ${reference.article} 条${paragraph}${item}一致（来源：${sourceDoc}）`
  const proposition = options.proposition?.trim()
  if (proposition === undefined || proposition === '') return { decision: 'valid', reason: validReason, entry }
  const threshold = options.supportThreshold ?? PROPOSITION_SUPPORT_DEFAULT
  const entries = articleComparableEntries(baseline.articles)
  const index = articleIndex(baseline, entries)
  const overlap = textOverlap(index, proposition, text)
  // A citation narrowed to a paragraph or item is supported only by that text.
  // The article's topic keywords name the whole article, so they must not make
  // another paragraph's proposition pass.
  if ((!focus.narrowed && topicOverlap(entry.topics, proposition)) || overlap >= threshold) {
    return { decision: 'valid', reason: validReason, entry }
  }
  const sibling = focus.siblings.find(candidate => textOverlap(index, proposition, candidate.text) >= threshold)
  if (sibling !== undefined) {
    return { decision: 'mismatch', reason: supportMismatchReason(baseline.law, proposition, [sibling.label]), entry }
  }
  const elsewhere = findCompetingLabels(entries, index, proposition, threshold, `第 ${entry.article} 条`)
  if (elsewhere.length > 0) {
    return { decision: 'mismatch', reason: supportMismatchReason(baseline.law, proposition, elsewhere), entry }
  }
  return {
    decision: 'unmatched',
    reason: `所引条目的文本与命题「${truncateProposition(proposition)}」的字面重合 ${formatPercent(overlap)}，低于支撑阈值 ${formatPercent(threshold)}，且本索引中没有条目支撑该命题——请核对条号或改写命题`,
    entry,
  }
}

/**
 * Decide an article the index does not hold. Only a verified article ceiling
 * proves a number does not exist; beyond an unverified ceiling the answer is
 * that nothing here can say.
 * @param reference - the parsed reference.
 * @param baseline - the law's baseline.
 * @returns the verdict, without an entry.
 */
function articleGap(
  reference: { article: number },
  baseline: ArticleBaseline,
): ArticleVerdict<never> {
  if (baseline.maxArticle !== null && baseline.maxVerifiedOn !== null && reference.article > baseline.maxArticle) {
    return {
      decision: 'out-of-range',
      reason: `《${baseline.law}》共 ${baseline.maxArticle} 条，第 ${reference.article} 条不存在`,
    }
  }
  if (baseline.maxArticle !== null && reference.article > baseline.maxArticle) {
    return {
      decision: 'unverified',
      reason: `第 ${reference.article} 条超出索引声明的上限 ${baseline.maxArticle} 条，但该上限本身尚未核验`,
    }
  }
  return { decision: 'not-indexed', reason: `《${baseline.law}》第 ${reference.article} 条不在索引中` }
}

/**
 * Decide one statute-article citation against its law's baseline.
 * @param reference - the parsed reference.
 * @param baseline - the law's baseline.
 * @param entry - the indexed entry the reference resolved to, or undefined.
 * @param options - the proposition and the support threshold.
 * @returns the verdict, with the entry it used when one was found.
 */
export function decideArticleCitation<TEntry extends DecisionArticle>(
  reference: { article: number; paragraph?: number; item?: number },
  baseline: ArticleBaseline & { articles: readonly TEntry[] },
  entry: TEntry | undefined,
  options: ArticleProposition,
): ArticleVerdict<TEntry> {
  if (entry === undefined) return articleGap(reference, baseline)
  if (entry.verifiedOn === null || entry.text === null || entry.sourceDoc === null) {
    return {
      decision: 'unverified',
      reason: `《${baseline.law}》第 ${reference.article} 条已索引，但条文尚未转录核验（条目主题：${entry.topics.join('、')}）`,
      entry,
    }
  }
  const narrowing = checkNarrowing(reference, entry)
  if (narrowing !== null) return { decision: 'mismatch', reason: narrowing, entry }
  const text = entry.text
  const focus = articleCitationFocus({
    article: entry.article,
    ...(entry.paragraphs === undefined ? {} : { paragraphs: entry.paragraphs }),
    text,
  }, reference)
  if (focus.missingItem !== null) return { decision: 'mismatch', reason: focus.missingItem, entry }
  return decideTranscribed(reference, entry, focus.text, entry.sourceDoc, baseline, options, focus)
}
