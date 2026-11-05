/**
 * Text-level comparison between a proposition and the entry a citation points at.
 *
 * A citation "supports a proposition" in two independent ways. The entry's
 * transcribed text can carry the proposition's own wording, which is what a
 * quotation does, and it is scored by the share of the proposition's character
 * pairs that occur in that text, weighted so that pairs the law repeats across
 * many entries count for less: 「国务院专利行政部门」 appears in dozens of
 * articles and therefore establishes nothing about which one is meant. The
 * entry's topic keywords can name the subject, which is what a paraphrase does.
 *
 * Both signals are deliberately lexical. A proposition reworded around a synonym
 * neither signal lists reaches neither, and the caller reports that as an
 * undecided citation rather than as a contradiction.
 * @module @deepseek-ai/dsh-law-core/text-overlap
 */

/** One entry a proposition can be matched against, with the label a reason names it by. */
export type ComparableEntry = {
  /** How the entry is named in a reason, e.g. `第 71 条` or `第四部分第三章4.4.1`. */
  label: string
  /** Topic keywords the entry declares. */
  topics: string[]
  /** Transcribed entry text, or null while it has not been transcribed. */
  text: string | null
}

/**
 * Default share of a proposition's weighted character pairs that an entry's text
 * must carry before that text counts as support. Measured against the transcribed
 * 《专利法实施细则》 entries: a proposition quoting the entry's own wording scores
 * 0.78–1.00, a proposition naming another entry's subject scores 0.15–0.67.
 */
export const PROPOSITION_SUPPORT_DEFAULT = 0.75

/** Weighted character pairs of one baseline's transcribed entries, built once per loaded baseline. */
export type OverlapIndex = {
  /** Number of entries carrying transcribed text. */
  documents: number
  /** How many entries contain each character pair. */
  frequencies: Map<string, number>
  /** The character pairs of each transcribed text, so one text is split once. */
  texts: Map<string, Set<string>>
}

/**
 * Build the character-pair frequencies of the entries that have transcribed text.
 * @param entries - the entries to index.
 * @returns the index used by {@link textOverlap}.
 */
export function createOverlapIndex(entries: readonly ComparableEntry[]): OverlapIndex {
  const frequencies = new Map<string, number>()
  const texts = new Map<string, Set<string>>()
  let documents = 0
  for (const entry of entries) {
    if (entry.text === null) continue
    documents += 1
    const pairs = grams(normalize(entry.text))
    texts.set(entry.text, pairs)
    for (const gram of pairs) frequencies.set(gram, (frequencies.get(gram) ?? 0) + 1)
  }
  return { documents, frequencies, texts }
}

/**
 * Score how far an entry's text carries a proposition.
 * @param index - the frequencies of the baseline the entry belongs to.
 * @param proposition - the claim the citation is offered in support of.
 * @param text - the entry's transcribed text.
 * @returns the share of the proposition's weighted character pairs the text carries, from 0 to 1, or 0 for an empty proposition.
 */
export function textOverlap(index: OverlapIndex, proposition: string, text: string): number {
  const needle = grams(normalize(proposition))
  if (needle.size === 0) return 0
  const haystack = index.texts.get(text) ?? grams(normalize(text))
  let carried = 0
  let total = 0
  for (const gram of needle) {
    // A pair no entry carries weighs like a pair only one entry carries: the
    // proposition's own wording establishes nothing either way.
    const frequency = Math.max(index.frequencies.get(gram) ?? 0, 1)
    const weight = Math.log(1 + (index.documents + 1) / frequency)
    total += weight
    if (haystack.has(gram)) carried += weight
  }
  return carried / total
}

/**
 * Decide whether the entry's topic keywords carry the proposition.
 * @param topics - the entry's declared topics.
 * @param proposition - the claim the citation is offered in support of.
 * @returns true when a topic appears in the proposition or the proposition in a topic.
 */
export function topicOverlap(topics: readonly string[], proposition: string): boolean {
  const needle = proposition.trim()
  if (needle === '') return false
  return topics.some(topic => needle.includes(topic) || topic.includes(needle))
}

/**
 * Strip what should not separate two spellings of the same sentence: layout
 * whitespace, punctuation, and the full-width forms a text copied out of a PDF
 * carries.
 * @param value - the text to normalize.
 * @returns the comparable characters only.
 */
function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{Letter}\p{Number}]/gu, '')
}

/**
 * Character pairs of a normalized text, so a proposition is matched on word-sized
 * units rather than on single characters that any Chinese sentence repeats.
 * @param value - normalized text.
 * @returns the distinct pairs, or the single character of a one-character text.
 */
function grams(value: string): Set<string> {
  const out = new Set<string>()
  if (value.length < 2) {
    if (value.length === 1) out.add(value)
    return out
  }
  for (let index = 0; index + 1 < value.length; index += 1) out.add(value.slice(index, index + 2))
  return out
}
