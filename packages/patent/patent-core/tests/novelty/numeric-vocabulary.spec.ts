import { describe, expect, it } from 'vitest'
import {
  NUMERIC_ANY_UNIT_ALTERNATION,
  canonicalNumericUnit,
} from '../../src/novelty/index.ts'

describe('canonicalNumericUnit', () => {
  it('把同一单位的不同写法归到同一个键', () => {
    expect(canonicalNumericUnit('毫米')).toBe('mm')
    expect(canonicalNumericUnit('MM')).toBe('mm')
    expect(canonicalNumericUnit('℃')).toBe('°')
    expect(canonicalNumericUnit('°c')).toBe('°')
    expect(canonicalNumericUnit('度')).toBe('°')
    expect(canonicalNumericUnit('％')).toBe('%')
    expect(canonicalNumericUnit(' 千帕 ')).toBe('kpa')
  })

  it('不把大小不同的单位合并，表外写法原样返回', () => {
    expect(canonicalNumericUnit('米')).toBe('m')
    expect(canonicalNumericUnit('毫米')).toBe('mm')
    expect(canonicalNumericUnit('rpm')).toBe('rpm')
  })
})

describe('NUMERIC_ANY_UNIT_ALTERNATION', () => {
  it('同时接受中文与拉丁单位写法', () => {
    const pattern = new RegExp(`^(${NUMERIC_ANY_UNIT_ALTERNATION})$`)
    expect(pattern.test('毫米')).toBe(true)
    expect(pattern.test('mm')).toBe(true)
    expect(pattern.test('度')).toBe(true)
  })
})
