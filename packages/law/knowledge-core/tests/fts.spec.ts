import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  escapeFtsPhrase,
  FTS_MIN_RUNES,
  joinFtsOrTerms,
  sanitizeSearchText,
  sqliteHasFts5,
} from '@deepseek-ai/dsh-knowledge-core'

describe('fts helpers', () => {
  it('detects FTS5 support on a real database', () => {
    const db = new DatabaseSync(':memory:')
    expect(sqliteHasFts5(db)).toBe(true)
    db.close()
  })

  it('treats a failing compile-option probe as no FTS5 support', () => {
    const closed = new DatabaseSync(':memory:')
    closed.close()
    expect(sqliteHasFts5(closed)).toBe(false)
  })

  it('wraps a phrase in a quoted FTS expression and doubles embedded quotes', () => {
    expect(escapeFtsPhrase('创造性')).toBe('"创造性"')
    expect(escapeFtsPhrase('a"b')).toBe('"a""b"')
  })

  it('joins multiple terms as quoted OR expressions', () => {
    expect(joinFtsOrTerms(['创造性', '新颖性'])).toBe('"创造性" OR "新颖性"')
  })

  it('drops the NUL that would terminate an FTS phrase', () => {
    expect(sanitizeSearchText('创造性\u0000判断')).toBe('创造性判断')
    expect(sanitizeSearchText('\u0000\u0000')).toBe('')
    expect(sanitizeSearchText('创造性')).toBe('创造性')
  })

  it('keeps the trigram tokenizer minimum', () => {
    expect(FTS_MIN_RUNES).toBe(3)
  })
})
