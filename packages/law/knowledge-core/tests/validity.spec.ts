import { describe, expect, it } from 'vitest'
import {
  isLawVisible,
  resolveAsOf,
  resolveLawValidity,
  todayIsoDate,
} from '@deepseek-ai/dsh-knowledge-core'

describe('法规时间效力判定', () => {
  it('显式废止标记优先于日期', () => {
    expect(resolveLawValidity({ expired: 1, validFrom: '2020-01-01', validTo: '2099-01-01' }, '2026-01-01'))
      .toBe('expired')
  })

  it('失效日早于判定日 → 已废止', () => {
    expect(resolveLawValidity({ validTo: '2025-12-31', expired: 0 }, '2026-01-01')).toBe('expired')
  })

  it('施行日晚于判定日 → 尚未生效', () => {
    expect(resolveLawValidity({ validFrom: '2026-02-01', expired: 0 }, '2026-01-01')).toBe('not-yet-effective')
  })

  it('施行日已到且无失效日 → 在效', () => {
    expect(resolveLawValidity({ validFrom: '2020-01-01', expired: 0 }, '2026-01-01')).toBe('in-force')
  })

  it('只有显式未废止标记也算在效（时间列可另行核验）', () => {
    expect(resolveLawValidity({ expired: 0 }, '2026-01-01')).toBe('in-force')
  })

  it('三列全缺失 → 未核验，不把不知道当作有效', () => {
    expect(resolveLawValidity({}, '2026-01-01')).toBe('unverified')
    expect(resolveLawValidity({ validFrom: null, validTo: null, expired: null }, '2026-01-01')).toBe('unverified')
  })

  it('非法或越界日期按时间列缺失处理，不能当成在效', () => {
    expect(resolveLawValidity({ validTo: 'not-a-date' }, '2026-01-01')).toBe('unverified')
    expect(resolveLawValidity({ validFrom: '2026-02-30' }, '2026-01-01')).toBe('unverified')
    expect(resolveLawValidity({ validFrom: '2026-1-1' }, '2026-01-01')).toBe('unverified')
    // 显式未废止标记仍是可核验的断言。
    expect(resolveLawValidity({ validTo: 'not-a-date', expired: 0 }, '2026-01-01')).toBe('in-force')
    // 合法日期照常参与比较。
    expect(resolveLawValidity({ validFrom: '2020-01-01', validTo: '2025-12-31' }, '2026-01-01')).toBe('expired')
  })

  it('已废止/尚未生效不可见，未核验按开关决定', () => {
    expect(isLawVisible('in-force', false)).toBe(true)
    expect(isLawVisible('expired', true)).toBe(false)
    expect(isLawVisible('not-yet-effective', true)).toBe(false)
    expect(isLawVisible('unverified', true)).toBe(true)
    expect(isLawVisible('unverified', false)).toBe(false)
  })

  it('asOf 缺省为今天，非法日期抛错', () => {
    expect(resolveAsOf(undefined)).toBe(todayIsoDate())
    expect(resolveAsOf('2026-01-01')).toBe('2026-01-01')
    expect(resolveAsOf('  2026-01-01  ')).toBe('2026-01-01')
    expect(() => resolveAsOf('2026-02-30')).toThrow(/asOf/)
    expect(() => resolveAsOf('2026/01/01')).toThrow(/asOf/)
  })
})
