import { describe, expect, it } from 'vitest'
import { pathBasename } from '../src/path-basename.ts'

describe('pathBasename', () => {
  it('returns the trailing segment for slash and backslash paths', () => {
    expect(pathBasename('a/b/c.txt')).toBe('c.txt')
    expect(pathBasename('a\\b\\c.txt')).toBe('c.txt')
    expect(pathBasename('c.txt')).toBe('c.txt')
    expect(pathBasename('')).toBe('')
  })
})
