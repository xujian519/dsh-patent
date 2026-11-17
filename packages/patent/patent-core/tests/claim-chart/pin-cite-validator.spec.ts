import { expect, it } from 'vitest'
import { validatePinCite, verifyQuoteInSource } from '../../src/claim-chart/runtime/pin-cite-validator.ts'

const SOURCE = [
  '说明书',
  '[0032]',
  '本实施例的壳体由不锈钢制成，滤芯含有活性炭。',
  '[0033]',
  '滤芯可拆卸地安装于壳体内。',
  '[0034]',
  '壳体上设有进水口。',
].join('\n')

/** Google Patents 一类的转存文本：有 "段落" 语义但没有 `[xxxx]` 标记可核对。 */
const PLAIN_SOURCE = [
  '说明书',
  '本实施例的壳体由不锈钢制成，滤芯含有活性炭。',
  '滤芯可拆卸地安装于壳体内。',
].join('\n')

it('合法 pin-cite 且段号存在通过', () => {
  expect(validatePinCite('[D1 段[0032] 图3]', SOURCE)).toEqual({ ok: true })
  expect(validatePinCite('[D1 段[0033]]', SOURCE)).toEqual({ ok: true })
})

it('文档 id 含空格仍可解析并核对段号', () => {
  expect(validatePinCite('[产品 A 段[0032]]', SOURCE)).toEqual({ ok: true })
  expect(validatePinCite('[对比文件 1 段[0033] 图3]', SOURCE)).toEqual({ ok: true })
  expect(validatePinCite('[产品 A 段[0001]]', PLAIN_SOURCE)).toEqual({ ok: true })
})

it('“图”前后空白任选，多图以顿号或逗号分隔', () => {
  for (const cite of [
    '[D1 段[0032] 图 3]',
    '[D1 段[0032] 图3、图4]',
    '[D1 段[0032] 图3,图4]',
    '[D1 段[0032] 图3，4]',
  ]) {
    expect(validatePinCite(cite, PLAIN_SOURCE), cite).toEqual({ ok: true })
  }
})

it('段号范围核对两端', () => {
  expect(validatePinCite('[D1 段[0032]-[0034]]', SOURCE)).toEqual({ ok: true })
  const missingEnd = validatePinCite('[D1 段[0032]-[0099]]', SOURCE)
  expect(missingEnd.ok).toBe(false)
  if (!missingEnd.ok) expect(missingEnd.reason.includes('[0099]')).toBe(true)
})

it('源文没有 [xxxx] 段号标记时段号存在性不核对（而不是判失败）', () => {
  expect(validatePinCite('[D1 段[0032]]', PLAIN_SOURCE)).toEqual({ ok: true })
  expect(validatePinCite('[D1 段[0032] 图3]', PLAIN_SOURCE)).toEqual({ ok: true })
  // 有标记的源文仍照常核对，未标记者不得借"跳过"混过。
  expect(validatePinCite('[D1 段[0099]]', SOURCE).ok).toBe(false)
})

it('格式非法报错并给出正确写法示例', () => {
  const res = validatePinCite('D1 段 0032', SOURCE)
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.reason.includes('格式非法')).toBeTruthy()
    expect(res.reason.includes('[D1 段[0032] 图3]')).toBeTruthy()
  }
  expect(validatePinCite('D1 ¶0023', PLAIN_SOURCE).ok).toBe(false)
})

it('段号不存在报错（防幻觉引用）', () => {
  const res = validatePinCite('[D1 段[0099]]', SOURCE)
  expect(res.ok).toBe(false)
  if (!res.ok) expect(res.reason.includes('不存在')).toBeTruthy()
})

it('quote 必须是源文子串（归一化空白后）', () => {
  expect(verifyQuoteInSource('壳体由不锈钢制成，滤芯含有活性炭', SOURCE).ok).toBe(true)
  expect(verifyQuoteInSource('壳体由 不锈钢\n制成', SOURCE).ok).toBe(true)
  const bad = verifyQuoteInSource('壳体由钛合金制成', SOURCE)
  expect(bad.ok).toBe(false)
  expect(bad.reason.includes('不存在')).toBeTruthy()
})

it('空引用放行（not-found 行允许空证据）', () => {
  expect(verifyQuoteInSource('', SOURCE).ok).toBe(true)
})
