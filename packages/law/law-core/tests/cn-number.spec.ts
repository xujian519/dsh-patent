import { describe, expect, it } from 'vitest'
import { parseCnNumber } from '@deepseek-ai/dsh-law-core'

describe('parseCnNumber', () => {
  it('阿拉伯数字直接解析', () => {
    expect(parseCnNumber('82')).toBe(82)
    expect(parseCnNumber('0')).toBe(0)
    expect(parseCnNumber('99999999999999999999')).toBeNull()
  })

  it('〇 与零都读作 0', () => {
    expect(parseCnNumber('〇')).toBe(0)
    expect(parseCnNumber('零')).toBe(0)
  })

  it('X十Y 组合', () => {
    expect(parseCnNumber('二十二')).toBe(22)
    expect(parseCnNumber('十')).toBe(10)
    expect(parseCnNumber('一十')).toBe(10)
    expect(parseCnNumber('四十五')).toBe(45)
    expect(parseCnNumber('七十八')).toBe(78)
  })

  it('百位组合（含零占位）', () => {
    expect(parseCnNumber('一百零二')).toBe(102)
    expect(parseCnNumber('二百零五')).toBe(205)
    expect(parseCnNumber('一百二十')).toBe(120)
    expect(parseCnNumber('一百二十六')).toBe(126)
    expect(parseCnNumber('三百四十五')).toBe(345)
    expect(parseCnNumber('一百')).toBe(100)
  })

  it('千位组合', () => {
    expect(parseCnNumber('一千二百三十四')).toBe(1234)
    expect(parseCnNumber('一千零一')).toBe(1001)
  })

  it('非法输入返回 null', () => {
    expect(parseCnNumber('abc')).toBeNull()
    expect(parseCnNumber('十二abc')).toBeNull()
    expect(parseCnNumber('')).toBeNull()
    expect(parseCnNumber('十十')).toBeNull()
    expect(parseCnNumber('一百百')).toBeNull()
    expect(parseCnNumber('十二三')).toBeNull()
    expect(parseCnNumber('一二三')).toBeNull()
    expect(parseCnNumber('百')).toBeNull()
    expect(parseCnNumber('千')).toBeNull()
  })
})
