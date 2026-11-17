import { describe, expect, it } from 'vitest'
import {
  jsonPreview,
  isDataRecord,
  dataList,
  listOrEmpty,
  namedLabel,
  numberList,
  recordChild,
  recordDisplay,
  recordEntries,
  recordFlag,
  recordList,
  recordNumberOr,
  recordString,
  recordText,
  textOrEmpty,
  recordValue,
  textList,
} from '../src/tool/internal/json-read.ts'

describe('json field readers', () => {
  const row = { name: '权利要求', count: 2, ok: true, nested: { id: 'a' }, tags: ['x', 1], empty: null }

  it('reads records and treats other JSON values as empty', () => {
    expect(isDataRecord(row)).toBe(true)
    expect(isDataRecord([row])).toBe(false)
    expect(isDataRecord(null)).toBe(false)
    expect(isDataRecord('row')).toBe(false)
    expect(recordEntries(row)).toEqual(expect.arrayContaining([['name', '权利要求']]))
    expect(recordEntries('row')).toEqual([])
    expect(recordValue(row, 'name')).toBe('权利要求')
    expect(recordValue(row, 'missing')).toBeUndefined()
    expect(recordValue('row', 'name')).toBeUndefined()
    expect(recordString(row, 'name')).toBe('权利要求')
    expect(recordString(row, 'count')).toBeUndefined()
    expect(recordText(row, 'missing')).toBe('')
    expect(textOrEmpty(undefined)).toBe('')
    expect(textOrEmpty('a')).toBe('a')
    expect(recordDisplay(row, 'count')).toBe('2')
    expect(recordDisplay(row, 'name')).toBe('权利要求')
    expect(recordDisplay(row, 'ok')).toBe('')
    expect(recordNumberOr(row, 'count', 0)).toBe(2)
    expect(recordNumberOr(row, 'name', 0)).toBe(0)
    expect(recordNumberOr({ n: Number.NaN }, 'n', 4)).toBe(4)
    expect(recordFlag(row, 'ok')).toBe(true)
    expect(recordFlag(row, 'name')).toBe(false)
    expect(recordChild(row, 'nested')).toEqual({ id: 'a' })
    expect(recordChild(row, 'name')).toBeUndefined()
    expect(recordList(row, 'tags')).toEqual(['x', 1])
    expect(recordList(row, 'name')).toEqual([])
    expect(dataList(['a'])).toEqual(['a'])
    expect(dataList('a')).toEqual([])
  })

  it('keeps only string and finite number elements', () => {
    expect(listOrEmpty(undefined)).toEqual([])
    expect(listOrEmpty(['a'])).toEqual(['a'])
    expect(textList(['a', 1, 'b'])).toEqual(['a', 'b'])
    expect(textList({ a: 'b' })).toEqual([])
    expect(numberList([1, '2', Number.NaN, 3])).toEqual([1, 3])
    expect(numberList('1,2')).toEqual([])
  })

  it('resolves a label map', () => {
    const labels = { literal: '全部要素字面覆盖' }
    expect(jsonPreview('权利要求')).toBe('权利要求')
    expect(jsonPreview(undefined)).toBe('')
    expect(jsonPreview({ a: 1 })).toBe('{"a":1}')
    expect(namedLabel(labels, 'literal')).toBe('全部要素字面覆盖')
    expect(namedLabel(labels, 'other')).toBe('other')
    expect(namedLabel(labels, 1)).toBe('')
    expect(namedLabel({ literal: 1 }, 'literal')).toBe('literal')
    expect(namedLabel([], 'literal')).toBe('literal')
  })
})
