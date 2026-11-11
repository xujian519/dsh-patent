/**
 * Legal-law reference parsing and formatting.
 *
 * Chinese legal citations arrive in mixed forms: `民法典第143条`, `民法典第一百四十三条`,
 * `民事诉讼法第66条第2款`. Everything downstream compares one normalized reference,
 * so the reference grammar lives here and nowhere else; the numeral reader
 * and the citation text helpers are shared through `@deepseek-ai/dsh-law-core`.
 * @module @deepseek-ai/dsh-legal-law/reference
 */

import {
  articleReferenceIdentity,
  collectReferences,
  formatArticleCitation,
  formatCnNumber,
  normalizeCitationText,
  parseCnNumber,
  readArticleContinuations,
  readStatuteArticleCandidate,
  scanUnrecognizedReferences,
  stripBookMarks,
  trimPunctuation,
} from '@deepseek-ai/dsh-law-core'
import type { LegalLawName, LegalLawReference } from './types.ts'

export { formatCnNumber, parseCnNumber }

/** Number written in Chinese numerals or Arabic digits. */
const NUMBER = '[〇零一二三四五六七八九十百0-9]{1,6}'

// The house style separates Chinese text from digits with spaces (民法典第 143 条),
// and a source copied out of a PDF may use full-width digits. Both are
// normalized before matching.

/**
 * Known full-law-name → short-name pairs used by the statute regex.
 * Extended at load time when new baselines are discovered.
 */
const STATUTE_NAMES: Record<string, LegalLawName> = {
  '民法典': '民法典',
  '中华人民共和国民法典': '民法典',
  '劳动合同法': '劳动合同法',
  '中华人民共和国劳动合同法': '劳动合同法',
  '公司法': '公司法',
  '中华人民共和国公司法': '公司法',
  '民事诉讼法': '民事诉讼法',
  '中华人民共和国民事诉讼法': '民事诉讼法',
}

/**
 * Document titles → short law name for laws discovered at load time. A formal
 * citation writes 《中华人民共和国会计法》 while the index keys the entry by
 * `会计法`; this map lets the parser accept both forms.
 */
let statuteAliases: ReadonlyMap<string, LegalLawName> = new Map()

/**
 * Name alternatives one pattern carries. A single pattern listing every known
 * law costs seconds on reuse: V8 compiles a pattern this wide to native code
 * when it runs a second time. Bounded chunks keep each compilation small.
 */
const NAMES_PER_PATTERN = 500

/** The article grammar every name alternative is followed by. */
const STATUTE_SUFFIX = '\\s*》?\\s*第?\\s*(?<article>' + NUMBER + ')\\s*条'
  + `(?:\\s*第\\s*(?<paragraph>${NUMBER})\\s*款)?`
  + `(?:\\s*第\\s*(?:[（(]\\s*(?<itemParen>${NUMBER})\\s*[）)]|(?<item>${NUMBER}))\\s*项)?`

/**
 * Collect every name form the pattern accepts, longest first so a chunk
 * prefers the longer form of a name that is a suffix of another.
 * @param lawNames - short law names to include in the alternation.
 * @param aliases - document titles that resolve to a short law name.
 * @returns the name forms, longest first.
 */
function knownNameForms(
  lawNames: readonly string[],
  aliases: ReadonlyMap<string, LegalLawName>,
): string[] {
  const nameForms = new Set<string>()
  for (const [key] of Object.entries(STATUTE_NAMES)) {
    nameForms.add(key)
  }
  for (const name of lawNames) {
    nameForms.add(name)
  }
  for (const alias of aliases.keys()) {
    nameForms.add(alias)
  }
  return [...nameForms].sort((a, b) => b.length - a.length)
}

/**
 * Build one statute-matching regex over a list of name forms.
 * @param names - the name forms the pattern accepts.
 * @returns a global RegExp that captures the law name, article, paragraph, and item.
 */
function buildStatutePattern(names: readonly string[]): RegExp {
  return new RegExp(`(?<law>${names.map(escapeRegExp).join('|')})${STATUTE_SUFFIX}`, 'g')
}

/**
 * Build one pattern per name chunk.
 * @param lawNames - short law names to include in the alternation.
 * @param aliases - document titles that resolve to a short law name.
 * @returns the chunk patterns that together cover every known name.
 */
function buildStatutePatterns(
  lawNames: readonly string[],
  aliases: ReadonlyMap<string, LegalLawName> = new Map(),
): RegExp[] {
  const sorted = knownNameForms(lawNames, aliases)
  const patterns: RegExp[] = []
  for (let index = 0; index < sorted.length; index += NAMES_PER_PATTERN) {
    patterns.push(buildStatutePattern(sorted.slice(index, index + NAMES_PER_PATTERN)))
  }
  return patterns
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The initial set of law names used before baselines are loaded. */
const INITIAL_LAW_NAMES: readonly LegalLawName[] = ['民法典', '民事诉讼法', '劳动合同法', '公司法']

/** The active statute patterns; rebuilt when new baselines are loaded. */
let STATUTE_PATTERNS: readonly RegExp[] = buildStatutePatterns(INITIAL_LAW_NAMES)

/**
 * Rebuild the statute-matching patterns after new baselines have been loaded.
 * Called by {@link loadLegalLawBaselines} to keep the patterns in sync.
 * @param lawNames - all known short law names.
 * @param aliases - document titles that resolve to a short law name.
 */
export function rebuildStatutePattern(
  lawNames: readonly string[],
  aliases: ReadonlyMap<string, LegalLawName> = new Map(),
): void {
  statuteAliases = new Map(aliases)
  STATUTE_PATTERNS = buildStatutePatterns(lawNames, statuteAliases)
}

/** The groups each statute pattern always captures, typed for direct use. */
type StatuteGroups = {
  law: string
  article: string
  paragraph?: string
  item?: string
  itemParen?: string
}

/** One parsed candidate with its span in the scanned text. */
type Candidate = { start: number; end: number; reference: LegalLawReference }

/**
 * Parse one reference standing alone in `text`.
 * @param text - the candidate reference text.
 * @returns the parsed reference, or null when the text is not exactly one.
 */
export function parseLegalLawReference(text: string): LegalLawReference | null {
  const trimmed = trimPunctuation(normalizeCitationText(text))
  if (trimmed === '') return null
  const comparable = stripBookMarks(trimmed)
  return extractLegalLawReferences(trimmed).find(reference => reference.raw === comparable) ?? null
}

/**
 * Extract every legal-law reference in `text`, in order of appearance.
 * @param text - the text to scan.
 * @returns the parsed references.
 */
export function extractLegalLawReferences(text: string): LegalLawReference[] {
  const normalized = normalizeCitationText(text)
  const matches: RegExpExecArray[] = []
  // Each chunk scans the whole text on its own, so one name nested inside
  // another matches twice; the merge below restores one left-to-right scan.
  for (const pattern of STATUTE_PATTERNS) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(normalized); match !== null; match = pattern.exec(normalized)) {
      matches.push(match)
    }
  }
  // Chunks hold the longest names first, so the first match at a position is
  // the longest name there, as one alternation over every name would pick.
  matches.sort((left, right) => left.index - right.index)

  const candidates: Candidate[] = []
  let scanned = 0
  for (const match of matches) {
    // A name inside the span already consumed would not have matched a single
    // pattern that continues after each match.
    if (match.index < scanned) continue
    scanned = match.index + match[0].length
    const groups = match.groups as StatuteGroups
    // The four hand-indexed laws map a full name to a short name; loaded
    // document titles map through the alias table. A baseline's own `law`
    // field is already the short name, so it maps to itself.
    const lawName = STATUTE_NAMES[groups.law] ?? statuteAliases.get(groups.law) ?? groups.law
    const candidate = readStatuteArticleCandidate(match, groups, lawName)
    if (candidate !== null) candidates.push(candidate)
  }

  return collectReferences(
    candidates,
    normalized.length,
    (candidate, limit) => readArticleContinuations(normalized, candidate, limit),
    referenceIdentity,
  )
}

/**
 * Stable identity of a resolved reference.
 * @param reference - the resolved reference.
 * @returns a string equal for two references to the same provision.
 */
function referenceIdentity(reference: LegalLawReference): string {
  return articleReferenceIdentity(reference.law, reference.article, reference.paragraph, reference.item)
}

/**
 * A fragment that looks like a citation but was not resolved.
 */
const UNRECOGNIZED_PATTERN = new RegExp(
  `第\\s*${NUMBER}\\s*[条款项]|第\\s*[（(]\\s*${NUMBER}\\s*[）)]\\s*项`,
  'g',
)

/**
 * List the citation-like fragments in `text` that the parser did not resolve.
 * @param text - the text that was scanned.
 * @param recognized - the references the parser resolved.
 * @returns the unresolved fragments, deduplicated and capped at ten.
 */
export function scanUnrecognizedLegalCitations(text: string, recognized: readonly LegalLawReference[]): string[] {
  return scanUnrecognizedReferences(text, recognized, UNRECOGNIZED_PATTERN)
}

/**
 * Render a reference the way a formal Chinese document writes it.
 * @param reference - the reference to render.
 * @returns the rendered text.
 */
export function formatLegalLawReference(reference: LegalLawReference): string {
  return formatArticleCitation(reference)
}
