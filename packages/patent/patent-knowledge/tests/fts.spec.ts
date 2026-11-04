import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { escapeFtsPhrase, joinFtsOrTerms, sanitizeSearchText, sqliteHasFts5 } from '@deepseek-ai/dsh-patent-knowledge/src/shared/fts.ts'

describe('fts helpers', () => {
  it('detects FTS5 support on a real database', () => {
    const db = new DatabaseSync(':memory:')
    expect(sqliteHasFts5(db)).toBe(true)
    db.close()
  })

  it('treats a failing compile-option probe as no FTS5 support', () => {
    const failing = {
      prepare: () => {
        throw new Error('probe unavailable')
      },
    } as unknown as DatabaseSync
    expect(sqliteHasFts5(failing)).toBe(false)
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
  })
})
