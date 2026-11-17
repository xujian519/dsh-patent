import { describe, expect, it } from 'vitest'
import {
  readJsonNumber,
  readNonEmptyString,
  readOptionalNonEmptyString,
  tryParseJson,
} from '@deepseek-ai/dsh-patent-core'
import {
  parseJsonRecordArray,
  parseJsonStringArray,
  parseOptionalJsonStringArray,
  stripCodeFence,
} from '../src/llm-json.ts'

describe('stripCodeFence', () => {
  it('strips a ```json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips a plain ``` fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('returns the raw string when no fence is present', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}')
  })
})

describe('tryParseJson', () => {
  it('parses a plain JSON object', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses a fenced JSON object', () => {
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('returns undefined for non-JSON', () => {
    expect(tryParseJson('这不是 JSON')).toBeUndefined()
  })

  it('returns undefined for arrays (object-shaped only)', () => {
    expect(tryParseJson('[1,2,3]')).toBeUndefined()
  })

  it('returns undefined for scalar values', () => {
    expect(tryParseJson('42')).toBeUndefined()
    expect(tryParseJson('"hi"')).toBeUndefined()
    expect(tryParseJson('null')).toBeUndefined()
  })
})

describe('readJsonNumber', () => {
  it('accepts numbers and rejects other shapes', () => {
    expect(readJsonNumber(3)).toBe(3)
    expect(readJsonNumber('3')).toBeUndefined()
    expect(readJsonNumber(null)).toBeUndefined()
  })
})

describe('readNonEmptyString', () => {
  it('returns the written value without trimming', () => {
    expect(readNonEmptyString({ id: ' a ' }, 'id')).toBe(' a ')
  })

  it('rejects missing, blank, and non-string fields', () => {
    expect(readNonEmptyString({}, 'id')).toBeUndefined()
    expect(readNonEmptyString({ id: '   ' }, 'id')).toBeUndefined()
    expect(readNonEmptyString({ id: 7 }, 'id')).toBeUndefined()
  })
})

describe('readOptionalNonEmptyString', () => {
  it('distinguishes a missing field from an invalid one', () => {
    expect(readOptionalNonEmptyString({}, 'note')).toBeUndefined()
    expect(readOptionalNonEmptyString({ note: 'n' }, 'note')).toBe('n')
    expect(readOptionalNonEmptyString({ note: '' }, 'note')).toBeNull()
    expect(readOptionalNonEmptyString({ note: 7 }, 'note')).toBeNull()
  })
})

describe('parseJsonStringArray', () => {
  it('keeps order and rejects non-string entries with an index', () => {
    expect(parseJsonStringArray(['a', 'b'], 'keywords')).toEqual({ ok: true, values: ['a', 'b'] })
    expect(parseJsonStringArray(['a', { x: 1 }], 'keywords')).toEqual({
      ok: false,
      reason: 'keywords 数组含非字符串项（下标 1）',
    })
    expect(parseJsonStringArray('a', 'keywords')).toEqual({ ok: false, reason: 'keywords 不是数组' })
  })
})

describe('parseOptionalJsonStringArray', () => {
  it('treats a missing field as empty and validates values that are present', () => {
    expect(parseOptionalJsonStringArray(undefined, 'effects')).toEqual({ ok: true, values: [] })
    expect(parseOptionalJsonStringArray(['e'], 'effects')).toEqual({ ok: true, values: ['e'] })
    expect(parseOptionalJsonStringArray([null], 'effects')).toEqual({
      ok: false,
      reason: 'effects 数组含非字符串项（下标 0）',
    })
  })
})

describe('parseJsonRecordArray', () => {
  it('keeps object entries and rejects null/scalar entries with an index', () => {
    expect(parseJsonRecordArray([{ a: 1 }], 'assessments')).toEqual({ ok: true, values: [{ a: 1 }] })
    expect(parseJsonRecordArray([{ a: 1 }, null], 'assessments')).toEqual({
      ok: false,
      reason: 'assessments 数组含非对象项（下标 1）',
    })
    expect(parseJsonRecordArray([], 'assessments')).toEqual({ ok: true, values: [] })
    expect(parseJsonRecordArray({}, 'assessments')).toEqual({ ok: false, reason: 'assessments 不是数组' })
  })
})
