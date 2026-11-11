import { describe, expect, it } from 'vitest'
import { clampLimit, fromInverted, decodeEntities, snippet, stripTags, formatAuthors, nonEmpty } from '../../../src/runtime/shared/text.ts'

describe('text helpers', () => {
  it('decodeEntities decodes named, hex, and decimal entities', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d &quot;q&quot; &apos;e&apos;')).toBe("a & b < c > d \"q\" 'e'")
    expect(decodeEntities('&#x41;&#66;&#67;')).toBe('ABC')
    expect(decodeEntities('&#65;&#98;')).toBe('Ab')
    expect(decodeEntities('&nbsp;')).toBe(' ')
  })

  it('decodeEntities drops out-of-range code points', () => {
    expect(decodeEntities('&#1114112;')).toBe('')
    expect(decodeEntities('&#x110000;')).toBe('')
  })

  it('decodeEntities leaves unknown entities untouched', () => {
    expect(decodeEntities('&unknown; &amp;')).toBe('&unknown; &')
  })

  it('stripTags removes JATS tags and collapses whitespace', () => {
    expect(stripTags('<jats:p>Attention is  all   you need</jats:p>')).toBe('Attention is all you need')
    expect(stripTags('<p>a &amp; b</p>')).toBe('a & b')
    expect(stripTags(undefined)).toBeUndefined()
    expect(stripTags('<p>  </p>')).toBeUndefined()
  })

  it('snippet truncates at word boundary with ellipsis', () => {
    const text = 'word '.repeat(100).trim()
    const out = snippet(text, 50)!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length <= 54).toBe(true)
  })

  it('snippet returns short text unchanged and undefined for empty', () => {
    expect(snippet('hello world')).toBe('hello world')
    expect(snippet(undefined)).toBeUndefined()
    expect(snippet('<b></b>')).toBeUndefined()
  })

  it('fromInverted rebuilds OpenAlex abstract from inverted index', () => {
    const index = { the: [0], quick: [1], brown: [2], fox: [3] }
    expect(fromInverted(index)).toBe('the quick brown fox')
  })

  it('fromInverted tolerates out-of-order positions and gaps', () => {
    const index = { fox: [3], quick: [1], the: [0] }
    expect(fromInverted(index)).toBe('the quick fox')
    expect(fromInverted({ a: [0], b: [5] })).toBe('a b')
  })

  it('fromInverted returns undefined for null/empty', () => {
    expect(fromInverted(undefined)).toBeUndefined()
    expect(fromInverted(null)).toBeUndefined()
    expect(fromInverted({})).toBeUndefined()
  })

  it('fromInverted skips nullish word entries and non-integer positions', () => {
    expect(fromInverted({ a: null, b: [0] })).toBe('b')
    expect(fromInverted({ a: [1.5] })).toBeUndefined()
    expect(fromInverted({ a: [-1] })).toBeUndefined()
  })

  it('fromInverted ignores a non-array position list instead of throwing', () => {
    expect(fromInverted({ a: 5, b: [0] })).toBe('b')
    expect(fromInverted({ a: '1', b: [0] })).toBe('b')
  })

  it('fromInverted keeps the last word for a repeated position', () => {
    expect(fromInverted({ a: [0, 0], b: [0] })).toBe('b')
    expect(fromInverted({ first: [1], second: [0], third: [0] })).toBe('third first')
  })

  it('fromInverted does not materialize the gap of a far position', () => {
    // A dense token array would have to visit 2^32-1 slots here; only the
    // number of index entries may drive the work.
    expect(fromInverted({ a: [2 ** 32 - 2] })).toBe('a')
  })

  it('formatAuthors returns undefined for no names and truncates past four', () => {
    expect(formatAuthors([])).toBeUndefined()
    expect(formatAuthors([undefined, 'x'])).toBe('x')
    expect(formatAuthors(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d et al.')
  })

  it('nonEmpty normalizes empty strings to undefined', () => {
    expect(nonEmpty('')).toBeUndefined()
    expect(nonEmpty('text')).toBe('text')
  })

  it('clampLimit truncates fractions and clamps to 1-50', () => {
    expect(clampLimit(undefined)).toBe(10)
    expect(clampLimit(7.9)).toBe(7)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-3)).toBe(1)
    expect(clampLimit(999)).toBe(50)
    expect(clampLimit(12)).toBe(12)
  })

  it('clampLimit falls back to the default for non-finite input', () => {
    expect(clampLimit(Number.NaN)).toBe(10)
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(10)
    expect(clampLimit(Number.NEGATIVE_INFINITY)).toBe(10)
  })
})
