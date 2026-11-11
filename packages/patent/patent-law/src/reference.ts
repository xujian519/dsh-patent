/**
 * Law-reference parsing and formatting.
 *
 * Chinese patent citations arrive in mixed forms: decimal article numbers
 * (`专利法第22条第3款`), written numbers (`专利法第二十二条第三款`), the compact
 * examination form (`A22.3`), and guideline section paths
 * (`审查指南第二部分第四章3.2.1.1`). Everything downstream compares one
 * normalized reference, so the reference grammar lives here and nowhere else;
 * the numeral reader itself is shared with the patent-domain library.
 * @module @deepseek-ai/dsh-patent-law/reference
 */

import {
  collectReferences,
  formatArticleCitation,
  formatCnNumber,
  narrowed,
  normalizeCitationText,
  parseCnNumber,
  readArticleContinuations,
  readStatuteArticleCandidate,
  scanUnrecognizedReferences,
  stripBookMarks,
  trimPunctuation,
} from '@deepseek-ai/dsh-patent-core'
import type { LawReference, StatuteName } from './types.ts'

export { formatCnNumber, parseCnNumber }

/** Number written in Chinese numerals or Arabic digits. */
const NUMBER = '[〇零一二三四五六七八九十百0-9]{1,6}'

// The house style separates Chinese text from digits with spaces (专利法第 22 条第 3
// 款), and a source copied out of a PDF may use full-width digits. Both are
// normalized before matching, so the grammar below allows whitespace at every
// token joint and receives ASCII digits.
const STATUTE_PATTERN = new RegExp(
  '(?<law>中华人民共和国专利法实施细则|专利法实施细则|实施细则|中华人民共和国专利法|专利法|细则)'
  // A formal citation wraps the law name in 《》 and omits 第 (专利法第二十二条); the
  // compact one writes 专利法第22条. Both are accepted; the closing 》 is dropped
  // from the written form by stripBookMarks.
  + '\\s*》?\\s*第?\\s*(?<article>'
  + NUMBER
  + ')\\s*条'
  + `(?:\\s*第\\s*(?<paragraph>${NUMBER})\\s*款)?`
  // 项 is written 第二项 or 第（二）项; the parenthesized form is the one a
  // formal citation uses.
  + `(?:\\s*第\\s*(?:[（(]\\s*(?<itemParen>${NUMBER})\\s*[）)]|(?<item>${NUMBER}))\\s*项)?`,
  'g',
)

const GUIDELINE_PATTERN = new RegExp(
  '(?:专利审查指南|审查指南)'
  + '\\s*》?\\s*'
  + `第\\s*(?<part>${NUMBER})\\s*部分`
  + `(?:\\s*第\\s*(?<chapter>${NUMBER})\\s*章)?`
  + '(?:\\s*第?\\s*(?<tail>[0-9]+(?:\\.[0-9]+)*)\\s*节?)?',
  'g',
)

/**
 * Compact examination form, e.g. `A22.3`. A letter, a digit, or a CJK character
 * immediately after the number means it is another token (`A4纸`), not a
 * citation.
 */
const COMPACT_PATTERN = /(?<![0-9A-Za-z])A(?<article>[0-9]{1,3})(?:\.(?<paragraph>[0-9]{1,2}))?(?![0-9A-Za-z\u4e00-\u9fff])/g

const STATUTE_NAMES: Record<string, StatuteName> = {
  '专利法': '专利法',
  '中华人民共和国专利法': '专利法',
  '专利法实施细则': '专利法实施细则',
  '实施细则': '专利法实施细则',
  '细则': '专利法实施细则',
}

/** The groups {@link STATUTE_PATTERN} always captures, typed for direct use. */
type StatuteGroups = {
  law: string
  article: string
  paragraph?: string
  item?: string
  itemParen?: string
}

/** The groups {@link GUIDELINE_PATTERN} always captures, typed for direct use. */
type GuidelineGroups = { part: string; chapter?: string; tail?: string }

/** The groups {@link COMPACT_PATTERN} always captures, typed for direct use. */
type CompactGroups = { article: string; paragraph?: string }

/** One parsed candidate with its span in the scanned text. */
type Candidate = { start: number; end: number; reference: LawReference }

/**
 * Parse one reference standing alone in `text`.
 *
 * The whole text must be the reference, ignoring surrounding punctuation, so a
 * citation embedded in a sentence is found through {@link extractLawReferences}
 * instead.
 * @param text - the candidate reference text.
 * @returns the parsed reference, or null when the text is not exactly one.
 */
export function parseLawReference(text: string): LawReference | null {
  const trimmed = trimPunctuation(normalizeCitationText(text))
  if (trimmed === '') return null
  // A written reference keeps its closing book-title mark (专利法》第二十二条), which
  // the extracted form drops, so compare against the mark-free text.
  const comparable = stripBookMarks(trimmed)
  return extractLawReferences(trimmed).find(reference => reference.raw === comparable) ?? null
}

/**
 * Record one pattern match and the reference it resolved to, so every arm of the
 * extractor reports its span the same way.
 * @param candidates - the candidate list being built.
 * @param match - the pattern match.
 * @param reference - the reference the match resolved to.
 */
function addCandidate(candidates: Candidate[], match: RegExpExecArray, reference: LawReference): void {
  candidates.push({
    start: match.index,
    end: match.index + match[0].length,
    reference,
  })
}

/**
 * Resolve the references that follow `base` in the same sentence and inherit
 * its law, article, paragraph, or item.
 * @param text - the normalized text.
 * @param base - the base match whose context is inherited.
 * @param limit - the end of the gap to scan.
 * @returns the continuation candidates.
 */
function readContinuations(text: string, base: Candidate, limit: number): Candidate[] {
  if (base.reference.kind !== 'law-article') return []
  const articleBase = { start: base.start, end: base.end, reference: base.reference }
  return readArticleContinuations(text, articleBase, limit)
}

/**
 * Extract every law reference in `text`, in order of appearance and deduplicated
 * by the provision it resolves to. The three base patterns match disjoint spans,
 * so they only need ordering; a pass over the gap between two base matches then
 * resolves the references that inherit their context (`、第23条`, `、第3款`).
 * @param text - the text to scan.
 * @returns the parsed references.
 */
export function extractLawReferences(text: string): LawReference[] {
  const normalized = normalizeCitationText(text)
  const candidates: Candidate[] = []

  for (const match of normalized.matchAll(STATUTE_PATTERN)) {
    const groups = match.groups as StatuteGroups
    // A number the pattern allows but the numeral parser rejects, e.g. 第十十条.
    const candidate = readStatuteArticleCandidate(match, groups, STATUTE_NAMES[groups.law] as StatuteName)
    if (candidate !== null) candidates.push(candidate)
  }

  for (const match of normalized.matchAll(GUIDELINE_PATTERN)) {
    const groups = match.groups as GuidelineGroups
    const path = guidelinePath(groups.part, groups.chapter, groups.tail)
    if (path === null) continue
    addCandidate(candidates, match, {
      kind: 'guideline-section',
      law: '专利审查指南',
      path,
      raw: stripBookMarks(match[0]),
    })
  }

  for (const match of normalized.matchAll(COMPACT_PATTERN)) {
    const groups = match.groups as CompactGroups
    const fields = narrowed(groups.paragraph, undefined)
    // A22.0 names a paragraph the numeral reader rejects; do not keep the article alone.
    if (fields === null) continue
    addCandidate(candidates, match, {
      kind: 'law-article',
      law: '专利法',
      // The pattern captures one to three digits, so the parse is always safe.
      article: Number.parseInt(groups.article, 10),
      ...fields,
      raw: match[0],
    })
  }

  candidates.sort((a, b) => a.start - b.start)
  return collectReferences(
    candidates,
    normalized.length,
    (candidate, limit) => readContinuations(normalized, candidate, limit),
    referenceIdentity,
  )
}

/**
 * Stable identity of a resolved reference: the law plus the narrowest cited
 * article/paragraph/item, or the guideline path.
 * @param reference - the resolved reference.
 * @returns a string equal for two references to the same provision.
 */
function referenceIdentity(reference: LawReference): string {
  if (reference.kind === 'guideline-section') return `guideline:${reference.path}`
  return `article:${reference.law}:${reference.article}:${reference.paragraph ?? ''}:${reference.item ?? ''}`
}

/**
 * A fragment that looks like a citation but was not resolved: an article,
 * paragraph, or item number, or the compact examination form.
 */
const UNRECOGNIZED_PATTERN = new RegExp(
  `第\\s*${NUMBER}\\s*[条款项]`
  + `|第\\s*[（(]\\s*${NUMBER}\\s*[）)]\\s*项`
  + '|(?<![0-9A-Za-z])A[0-9]{1,3}(?:\\.[0-9]{1,2})?(?![0-9A-Za-z\\u4e00-\\u9fff])',
  'g',
)

/**
 * List the citation-like fragments in `text` that the parser did not resolve.
 *
 * The tool reports these instead of leaving them invisible: a text whose first
 * citation was recognized but whose later citation was not must not read as a
 * complete check. A fragment already carried by a recognized reference is not
 * reported.
 * @param text - the text that was scanned.
 * @param recognized - the references the parser resolved.
 * @returns the unresolved fragments, deduplicated and capped at ten.
 */
export function scanUnrecognizedCitations(text: string, recognized: readonly LawReference[]): string[] {
  return scanUnrecognizedReferences(text, recognized, UNRECOGNIZED_PATTERN)
}

/**
 * Render a reference the way a formal Chinese document writes it, e.g.
 * `《专利法》第二十二条第三款`.
 * @param reference - the reference to render.
 * @returns the rendered text.
 */
export function formatLawReference(reference: LawReference): string {
  if (reference.kind === 'guideline-section') return `《专利审查指南》${reference.path}`
  return formatArticleCitation(reference)
}

/** Normalize a guideline match into a section path, or null when the part is unreadable. */
function guidelinePath(part: string, chapter: string | undefined, tail: string | undefined): string | null {
  const partValue = parseCnNumber(part)
  if (partValue === null || partValue < 1) return null
  const chapterValue = chapter === undefined ? null : parseCnNumber(chapter)
  if (chapter !== undefined && (chapterValue === null || chapterValue < 1)) return null
  const chapterText = chapterValue === null ? '' : `第${formatCnNumber(chapterValue)}章`
  return `第${formatCnNumber(partValue)}部分${chapterText}${tail ?? ''}`
}
