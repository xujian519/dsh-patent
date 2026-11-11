/**
 * Academic literature metadata text helpers, ported from the Sati literature layer.
 *
 * Covers the routine text needs of academic APIs: XML/HTML entity decoding, JATS tag
 * stripping, abstract snippet truncation, and OpenAlex inverted-abstract rebuild. All
 * defensive: malformed input returns `undefined` / empty arrays rather than throwing.
 * @module @deepseek-ai/dsh-tool-literature/runtime/shared/text
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
}

/**
 * Decode the few XML/HTML entities that appear in academic metadata (incl. numeric/hex refs).
 * @param input - the text with entities.
 * @returns the entity-decoded text.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, m => ENTITIES[m] ?? m)
}

function safeCodePoint(code: number): string {
  // The entity regexes only yield integers; rejecting non-integers here keeps
  // the guard total for fromCodePoint (which throws otherwise), so no try/catch.
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
  return String.fromCodePoint(code)
}

/**
 * Strip XML/HTML tags (e.g. JATS `<jats:p>` abstracts) and collapse whitespace.
 * @param input - the tagged text (optional).
 * @returns the tag-stripped text, or undefined when empty or absent.
 */
export function stripTags(input?: string): string | undefined {
  if (!input) return undefined
  const text = decodeEntities(input.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return text.length ? text : undefined
}

/**
 * Truncate to a readable length without hard-splitting words.
 * @param input - the text to truncate (optional).
 * @param max - maximum length (default 600).
 * @returns the truncated text, or undefined when empty or absent.
 */
export function snippet(input?: string, max = 600): string | undefined {
  const text = stripTags(input)
  if (!text) return undefined
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

/**
 * Format an author list for display, truncating past four names with "et al.".
 * @param names - author names (falsy entries dropped).
 * @returns the joined names, or undefined when no name remains.
 */
export function formatAuthors(names: Array<string | undefined>): string | undefined {
  const present = names.filter((n): n is string => !!n)
  if (present.length === 0) return undefined
  return present.length > 4 ? `${present.slice(0, 4).join(', ')} et al.` : present.join(', ')
}

/**
 * Clamp a requested result limit to the 1-50 range (default 10). A fractional
 * request truncates; a non-finite one (NaN/Infinity, e.g. from model JSON) falls
 * back to the default rather than propagating an unusable value.
 * @param limit - requested result limit (optional).
 * @returns the clamped limit.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10
  return Math.min(Math.max(Math.trunc(limit), 1), 50)
}

/**
 * Normalize an empty string to undefined (empty metadata fallbacks mean absent).
 * @param value - the string to normalize.
 * @returns the string, or undefined when empty.
 */
export function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined
}


/**
 * Pass through a source API record verbatim as an opaque `extra` payload.
 * @param value - the source API record.
 * @returns the record as an opaque object.
 */
export function raw(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/**
 * Rebuild plain-text abstract from OpenAlex's `abstract_inverted_index` (word → positions).
 *
 * Positions are sparse offsets, not a dense token array: gaps collapse and a
 * repeated position keeps the last word written. A response can name any
 * integer position, so the work is proportional to the number of positions
 * rather than to the largest offset.
 * @param index - the inverted index (word → positions), optional.
 * @returns the rebuilt abstract text, or undefined when empty or absent.
 */
export function fromInverted(index?: Record<string, number[]> | null): string | undefined {
  if (!index) return undefined
  const words = new Map<number, string>()
  for (const word of Object.keys(index)) {
    const positions: unknown = index[word]
    if (!Array.isArray(positions)) continue
    for (const pos of positions) {
      if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0) words.set(pos, word)
    }
  }
  const text = [...words]
    .sort(([left], [right]) => left - right)
    .map(([, word]) => word)
    .join(' ')
    .trim()
  return text.length ? text : undefined
}
