import { expect, it } from 'vitest'
import {
  deriveDistinguishingFeatures,
  deriveNoveltyCoverage,
  deriveNoveltyCoverageByClaim,
  validateRowMapping,
} from '@deepseek-ai/dsh-patent-core'
import type { ChartRow, ChartTarget, ClaimElement, ClaimRef } from '@deepseek-ai/dsh-patent-core'

const ELEMENTS: ClaimElement[] = [
  { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
  { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
  { id: '1c', claimNo: 1, text: '所述滤芯含有活性炭', kind: 'limitation' },
]

const D1: ChartTarget = { id: 'D1', kind: 'prior-art' }
const PRODUCT: ChartTarget = { id: '产品A', kind: 'accused-product' }

function row(elementId: string, targetId: string, mapping: ChartRow['mapping']): ChartRow {
  return { elementId, targetId, quote: '', pinCite: '', mapping, state: mapping, verified: false }
}

it('anticipation/obviousness-combination 仅限 prior-art 目标', () => {
  expect(validateRowMapping(row('1a', '产品A', 'anticipation'), PRODUCT, 'infringement')).toEqual([
    '行 [1a→产品A] 的 mapping "anticipation" 仅适用于 prior-art 目标',
  ])
  expect(validateRowMapping(row('1a', 'D1', 'anticipation'), D1, 'invalidity')).toEqual([])
})

it('doe 仅限侵权模式', () => {
  expect(validateRowMapping(row('1a', '产品A', 'doe'), PRODUCT, 'invalidity').length).toBe(1)
  expect(validateRowMapping(row('1a', '产品A', 'doe'), PRODUCT, 'infringement')).toEqual([])
})

it('新颖性单篇全覆盖推导：有缺口时不覆盖', () => {
  const rows = [row('1a', 'D1', 'literal'), row('1b', 'D1', 'literal'), row('1c', 'D1', 'not-found')]
  const res = deriveNoveltyCoverage(rows, 'D1', ELEMENTS)
  expect(res.covered).toBe(false)
  expect(res.missing).toEqual(['1c'])
})

it('新颖性单篇全覆盖推导：anticipation 计入覆盖', () => {
  const rows = [
    row('1a', 'D1', 'anticipation'),
    row('1b', 'D1', 'literal'),
    row('1c', 'D1', 'literal-construction-dependent'),
  ]
  const res = deriveNoveltyCoverage(rows, 'D1', ELEMENTS)
  expect(res.covered).toBe(true)
  expect(res.missing).toEqual([])
})

it('区别特征 = 主目标上 not-found/needs-evidence 的要素', () => {
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('1c', 'D1', 'needs-evidence'),
    row('1c', 'D2', 'literal'),
  ]
  expect(deriveDistinguishingFeatures(rows, 'D1', ELEMENTS)).toEqual(['1b', '1c'])
})

// ── 逐权项单篇全覆盖（从属权项并入引用链） ──────────────────────────────────

const TWO_CLAIMS: ClaimElement[] = [
  { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
  { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
  { id: '2a', claimNo: 2, text: '根据权利要求1所述的装置', kind: 'preamble' },
  { id: '2b', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
  { id: '3a', claimNo: 3, text: '根据权利要求2所述的装置', kind: 'preamble' },
  { id: '3b', claimNo: 3, text: '所述壳体为塑料', kind: 'limitation' },
]

const CHAIN: ClaimRef[] = [
  { claimNo: 1, claimType: 'independent', refersTo: [] },
  { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  { claimNo: 3, claimType: 'dependent', refersTo: [2] },
]

it('逐权项覆盖：独立权项只看自身要素', () => {
  const rows = [row('1a', 'D1', 'literal'), row('1b', 'D1', 'literal')]
  const [first] = deriveNoveltyCoverageByClaim(rows, 'D1', TWO_CLAIMS, CHAIN)
  expect(first).toEqual({
    claimNo: 1,
    covered: true,
    missing: [],
    includesReferredClaims: false,
    referredClaimNos: [],
  })
})

it('逐权项覆盖：从属权项并入所引用权项的全部要素（传递闭包）', () => {
  // 权 2 的附加特征被 D1 公开，但权 1 的 1b 未公开 —— 权 2 同样未全覆盖。
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
  ]
  const coverage = deriveNoveltyCoverageByClaim(rows, 'D1', TWO_CLAIMS, CHAIN)
  const second = coverage.find(entry => entry.claimNo === 2)
  expect(second?.covered).toBe(false)
  expect(second?.missing).toEqual(['1b'])
  expect(second?.includesReferredClaims).toBe(true)
  expect(second?.referredClaimNos).toEqual([1])
})

it('逐权项覆盖：多级从属取引用链的并集', () => {
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'literal'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
    row('3a', 'D1', 'literal'),
    row('3b', 'D1', 'not-found'),
  ]
  const third = deriveNoveltyCoverageByClaim(rows, 'D1', TWO_CLAIMS, CHAIN).find(entry => entry.claimNo === 3)
  expect(third?.referredClaimNos).toEqual([1, 2])
  expect(third?.missing).toEqual(['3b'])
})

it('逐权项覆盖：缺引用关系时按独立权项处理（不臆造引用）', () => {
  const rows = [row('2a', 'D1', 'literal'), row('2b', 'D1', 'literal')]
  const second = deriveNoveltyCoverageByClaim(rows, 'D1', TWO_CLAIMS, []).find(entry => entry.claimNo === 2)
  expect(second?.covered).toBe(true)
  expect(second?.includesReferredClaims).toBe(false)
})

// ── 多项从属权项：择一引用，不是合取 ────────────────────────────────────────

const MULTI_ELEMENTS: ClaimElement[] = [
  { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
  { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
  { id: '2a', claimNo: 2, text: '根据权利要求1所述的装置', kind: 'preamble' },
  { id: '2b', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
  { id: '3a', claimNo: 3, text: '所述壳体为塑料', kind: 'limitation' },
]

const MULTI: ClaimRef[] = [
  { claimNo: 1, claimType: 'independent', refersTo: [] },
  { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  { claimNo: 3, claimType: 'dependent', refersTo: [1, 2] },
]

it('逐权项覆盖：多项从属权项任一替代方案全覆盖即为覆盖', () => {
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'literal'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'not-found'),
    row('3a', 'D1', 'literal'),
  ]
  const third = deriveNoveltyCoverageByClaim(rows, 'D1', MULTI_ELEMENTS, MULTI).find(entry => entry.claimNo === 3)
  expect(third?.covered).toBe(true)
  expect(third?.missing).toEqual([])
  expect(third?.referredClaimNos).toEqual([1, 2])
  expect(third?.alternatives).toEqual([
    { referredClaimNos: [1], covered: true, missing: [] },
    { referredClaimNos: [1, 2], covered: false, missing: ['2b'] },
  ])
})

it('逐权项覆盖：后一替代方案缺口更少时选用后者', () => {
  const elements: ClaimElement[] = [
    { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
    { id: '3a', claimNo: 3, text: '包括滤芯', kind: 'limitation' },
    { id: '4a', claimNo: 4, text: '所述壳体为金属', kind: 'limitation' },
  ]
  const refs: ClaimRef[] = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 3, claimType: 'independent', refersTo: [] },
    { claimNo: 4, claimType: 'dependent', refersTo: [1, 3] },
  ]
  const rows = [row('1a', 'D1', 'not-found'), row('3a', 'D1', 'literal'), row('4a', 'D1', 'literal')]
  const fourth = deriveNoveltyCoverageByClaim(rows, 'D1', elements, refs).find(entry => entry.claimNo === 4)
  expect(fourth?.covered).toBe(true)
  expect(fourth?.missing).toEqual([])
  expect(fourth?.alternatives?.map(alternative => alternative.missing)).toEqual([['1a'], []])
})

it('逐权项覆盖：替代方案缺口数相同时保留先出现的一条', () => {
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
    row('3a', 'D1', 'literal'),
  ]
  const third = deriveNoveltyCoverageByClaim(rows, 'D1', MULTI_ELEMENTS, MULTI).find(entry => entry.claimNo === 3)
  expect(third?.missing).toEqual(['1b'])
  expect(third?.alternatives?.map(alternative => alternative.missing)).toEqual([['1b'], ['1b']])
})

it('逐权项覆盖：多项从属权项全部替代方案都有缺口时，摘要取缺口最少的一条', () => {
  const rows = [
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'not-found'),
    row('3a', 'D1', 'literal'),
  ]
  const third = deriveNoveltyCoverageByClaim(rows, 'D1', MULTI_ELEMENTS, MULTI).find(entry => entry.claimNo === 3)
  expect(third?.covered).toBe(false)
  expect(third?.missing).toEqual(['1b'])
  expect(third?.alternatives?.map(alternative => alternative.missing)).toEqual([['1b'], ['1b', '2b']])
})

it('逐权项覆盖：所引权项没有要素时不判全覆盖', () => {
  const elements: ClaimElement[] = [{ id: '2a', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' }]
  const refs: ClaimRef[] = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  ]
  const [second] = deriveNoveltyCoverageByClaim([row('2a', 'D1', 'literal')], 'D1', elements, refs)
  expect(second).toMatchObject({
    claimNo: 2,
    covered: false,
    missing: [],
    includesReferredClaims: true,
    missingReferredClaims: [1],
  })
})

it('逐权项覆盖：引用链上多个权项没有要素时按权项号列出', () => {
  const elements: ClaimElement[] = [{ id: '4a', claimNo: 4, text: '所述滤芯为圆柱形', kind: 'limitation' }]
  const refs: ClaimRef[] = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
    { claimNo: 4, claimType: 'dependent', refersTo: [2] },
  ]
  const [fourth] = deriveNoveltyCoverageByClaim([row('4a', 'D1', 'literal')], 'D1', elements, refs)
  expect(fourth).toMatchObject({ claimNo: 4, covered: false, missingReferredClaims: [1, 2] })
})

it('逐权项覆盖：先出现的完整替代路径优先保留', () => {
  const elements: ClaimElement[] = [
    { id: '2a', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
    { id: '4a', claimNo: 4, text: '所述滤芯为圆柱形', kind: 'limitation' },
  ]
  const refs: ClaimRef[] = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'independent', refersTo: [] },
    { claimNo: 4, claimType: 'dependent', refersTo: [2, 1] },
  ]
  const rows = [row('2a', 'D1', 'literal'), row('4a', 'D1', 'literal')]
  const fourth = deriveNoveltyCoverageByClaim(rows, 'D1', elements, refs).find(entry => entry.claimNo === 4)
  expect(fourth?.covered).toBe(true)
  expect(fourth?.missingReferredClaims).toBeUndefined()
  expect(fourth?.alternatives?.map(alternative => alternative.missingReferredClaims)).toEqual([undefined, [1]])
})

it('逐权项覆盖：多项从属优先选择引用权项都有要素的路径', () => {
  const elements: ClaimElement[] = [
    { id: '2a', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
    { id: '3a', claimNo: 3, text: '所述壳体为金属', kind: 'limitation' },
    { id: '4a', claimNo: 4, text: '所述滤芯为圆柱形', kind: 'limitation' },
  ]
  const refs: ClaimRef[] = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'independent', refersTo: [] },
    { claimNo: 3, claimType: 'independent', refersTo: [] },
    { claimNo: 4, claimType: 'dependent', refersTo: [1, 2] },
  ]
  const rows = [row('2a', 'D1', 'literal'), row('3a', 'D1', 'literal'), row('4a', 'D1', 'literal')]
  const fourth = deriveNoveltyCoverageByClaim(rows, 'D1', elements, refs).find(entry => entry.claimNo === 4)
  expect(fourth?.covered).toBe(true)
  expect(fourth?.missingReferredClaims).toBeUndefined()
  expect(fourth?.alternatives?.map(alternative => alternative.missingReferredClaims)).toEqual([[1], undefined])
})
