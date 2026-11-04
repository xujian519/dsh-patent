import { describe, expect, it } from 'vitest'
import { resolveResultLimit, sanitizeSearchText } from '@deepseek-ai/dsh-patent-core'

describe('resolveResultLimit', () => {
  it('uses the fallback when the caller omitted the cap or sent a non-finite value', () => {
    expect(resolveResultLimit(undefined, 5, 10)).toBe(5)
    expect(resolveResultLimit(Number.NaN, 5, 10)).toBe(5)
    expect(resolveResultLimit(Number.POSITIVE_INFINITY, 5, 10)).toBe(5)
    expect(resolveResultLimit(Number.NEGATIVE_INFINITY, 7, 10)).toBe(7)
  })

  it('truncates fractions and clamps into the accepted range', () => {
    expect(resolveResultLimit(2.9, 5, 10)).toBe(2)
    expect(resolveResultLimit(2.5, 5, 10)).toBe(2)
    expect(resolveResultLimit(99, 5, 10)).toBe(10)
    expect(resolveResultLimit(0, 5, 10)).toBe(1)
    expect(resolveResultLimit(-3, 5, 10)).toBe(1)
    expect(resolveResultLimit(3, 5, 10)).toBe(3)
  })
})

describe('sanitizeSearchText', () => {
  it('drops NUL because SQLite terminates a query text there', () => {
    expect(sanitizeSearchText('创造性\u0000判断')).toBe('创造性判断')
    expect(sanitizeSearchText('\u0000\u0000')).toBe('')
    expect(sanitizeSearchText('创造性')).toBe('创造性')
  })
})
