import { describe, expect, it } from 'vitest'
import { readStateText, resolveKeyList, resolveTrimmedKey } from '../src/index.ts'

describe('stage-state readers', () => {
  it('trims a configured key and falls back only when the param is absent', () => {
    expect(resolveTrimmedKey({ key_name: ' draft ' }, 'key_name', 'fallback')).toBe('draft')
    expect(resolveTrimmedKey({}, 'key_name', ' fallback ')).toBe('fallback')
    expect(resolveTrimmedKey({ key_name: '  ' }, 'key_name', 'fallback')).toBeUndefined()
  })

  it('resolves a key list from the default, keeps entries verbatim, and rejects invalid params', () => {
    expect(resolveKeyList({}, 'keys', ['a'])).toEqual(['a'])
    expect(resolveKeyList({ keys: [' draft '] }, 'keys', ['a'])).toEqual([' draft '])
    expect(resolveKeyList({ keys: [] }, 'keys', ['a'])).toBeUndefined()
    expect(resolveKeyList({ keys: ['a', 1] }, 'keys', ['a'])).toBeUndefined()
    expect(resolveKeyList({ keys: ['  '] }, 'keys', ['a'])).toBeUndefined()
    expect(resolveKeyList({ keys: 'a' }, 'keys', ['a'])).toBeUndefined()
  })

  it('reads trimmed text from a string key and treats every other value as absent', () => {
    expect(readStateText({ text: '  正文  ' }, 'text')).toBe('正文')
    expect(readStateText({ text: '   ' }, 'text')).toBeUndefined()
    expect(readStateText({}, 'text')).toBeUndefined()
    expect(readStateText({ text: 42 }, 'text')).toBeUndefined()
    expect(readStateText({ text: ['第一段', '第二段'] }, 'text')).toBeUndefined()
  })
})
