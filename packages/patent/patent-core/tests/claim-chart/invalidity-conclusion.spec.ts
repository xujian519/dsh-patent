import { expect, it } from 'vitest'
import {
  DRAFT_NOTICE,
  deriveInvalidityConclusion,
  renderInvalidityConclusion,
} from '@deepseek-ai/dsh-patent-core'
import type { ChartMode, ChartRow, ChartTarget, ClaimChart, ClaimElement, ClaimRef, Mapping } from '@deepseek-ai/dsh-patent-core'

const ELEMENTS: ClaimElement[] = [
  { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
  { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
  { id: '2a', claimNo: 2, text: '根据权利要求1所述的装置', kind: 'preamble' },
  { id: '2b', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
]

const CHAIN: ClaimRef[] = [
  { claimNo: 1, claimType: 'independent', refersTo: [] },
  { claimNo: 2, claimType: 'dependent', refersTo: [1] },
]

const D1: ChartTarget = { id: 'D1', kind: 'prior-art', title: '对比文件1' }
const D2: ChartTarget = { id: 'D2', kind: 'prior-art' }

const row = (elementId: string, targetId: string, mapping: Mapping): ChartRow => ({
  elementId,
  targetId,
  quote: '',
  pinCite: '',
  mapping,
  state: mapping,
  verified: false,
})

function chart(rows: ChartRow[], targets: ChartTarget[] = [D1], mode: ChartMode = 'invalidity'): ClaimChart {
  return {
    chartId: `chart-${mode}`,
    mode,
    caseId: '',
    elements: ELEMENTS,
    claimNos: [1, 2],
    claims: CHAIN,
    targets,
    rows,
    gaps: [],
    draftNotice: DRAFT_NOTICE,
  }
}

it('逐对比文件给出逐权项的单篇全覆盖判定，主对比文件取首个对比文件', () => {
  const conclusion = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
    row('1a', 'D2', 'literal'),
    row('1b', 'D2', 'literal'),
    row('2a', 'D2', 'literal'),
    row('2b', 'D2', 'literal'),
  ], [D1, D2]))

  expect(conclusion.primaryTargetId).toBe('D1')
  expect(conclusion.novelty.map(entry => entry.targetId)).toEqual(['D1', 'D2'])
  expect(conclusion.novelty[0]?.title).toBe('对比文件1')
  expect(conclusion.novelty[0]?.claims).toEqual([
    { claimNo: 1, covered: false, missing: ['1b'], includesReferredClaims: false, referredClaimNos: [] },
    { claimNo: 2, covered: false, missing: ['1b'], includesReferredClaims: true, referredClaimNos: [1] },
  ])
  // D2 单篇覆盖全部权项（权 2 已并入权 1 的要素）
  expect(conclusion.novelty[1]?.claims.every(entry => entry.covered)).toBe(true)
})

it('主对比文件可显式指定，指定不存在的目标时不计区别特征', () => {
  const rows = [row('1a', 'D2', 'literal'), row('1b', 'D2', 'not-found'), row('1a', 'D1', 'literal')]
  const explicit = deriveInvalidityConclusion(chart(rows, [D1, D2]), { primaryTargetId: 'D2' })
  expect(explicit.primaryTargetId).toBe('D2')
  // 从属权项的区别特征在同一并集上取补集：权 2 含权 1 的 1b，且 2a/2b 在 D2 上无映射行（未覆盖）。
  expect(explicit.distinguishing).toEqual([
    { claimNo: 1, elementIds: ['1b'] },
    { claimNo: 2, elementIds: ['1b', '2a', '2b'] },
  ])
  const unknown = deriveInvalidityConclusion(chart(rows, [D1, D2]), { primaryTargetId: 'D9' })
  expect(unknown.primaryTargetId).toBeUndefined()
  expect(unknown.distinguishing).toEqual([])
})

it('被控产品目标不参与判定（侵权侧口径不同）', () => {
  const product: ChartTarget = { id: '产品A', kind: 'accused-product' }
  const conclusion = deriveInvalidityConclusion(chart([row('1a', '产品A', 'literal')], [product]))
  expect(conclusion.novelty).toEqual([])
  expect(conclusion.primaryTargetId).toBeUndefined()
  expect(conclusion.distinguishing).toEqual([])
})

it('检出从属权项"仅附加特征被覆盖"的形态并给出法条路径说明', () => {
  // 权 2 自身要素（2a/2b）被 D1 覆盖，但所引权 1 的 1b 未覆盖。
  const conclusion = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
  ]))
  expect(conclusion.dependentClaimIssues).toHaveLength(1)
  const issue = conclusion.dependentClaimIssues[0]
  expect(issue?.kind).toBe('additional-features-only')
  expect(issue?.claimNo).toBe(2)
  expect(issue?.referredClaimNo).toBe(1)
  expect(issue?.targetId).toBe('D1')
  expect(issue?.detail).toContain('缺 1b')
  expect(issue?.detail).toContain('不得仅以附加技术特征被 D1 公开为由')
  expect(issue?.detail).toContain('A22.3')
})

it('所引权项同样被全覆盖时不报路径问题', () => {
  const conclusion = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'literal'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
  ]))
  expect(conclusion.dependentClaimIssues).toEqual([])
})

it('多项从属权项：一条替代路径全覆盖时不再报路径问题，并按路径给出区别特征', () => {
  const multi = chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'literal'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'not-found'),
    row('3a', 'D1', 'literal'),
  ])
  multi.elements = [
    { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
    { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
    { id: '2a', claimNo: 2, text: '根据权利要求1所述的装置', kind: 'preamble' },
    { id: '2b', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' },
    { id: '3a', claimNo: 3, text: '所述壳体为塑料', kind: 'limitation' },
  ]
  multi.claimNos = [1, 2, 3]
  multi.claims = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
    { claimNo: 3, claimType: 'dependent', refersTo: [1, 2] },
  ]
  const conclusion = deriveInvalidityConclusion(multi)
  const third = conclusion.novelty[0]?.claims.find(claim => claim.claimNo === 3)
  expect(third?.covered).toBe(true)
  expect(third?.alternatives?.map(alternative => alternative.covered)).toEqual([true, false])
  expect(conclusion.dependentClaimIssues).toEqual([])
  expect(conclusion.distinguishing.find(entry => entry.claimNo === 3)?.alternatives).toEqual([
    { referredClaimNos: [1], elementIds: [] },
    { referredClaimNos: [1, 2], elementIds: ['2b'] },
  ])
  const rendered = renderInvalidityConclusion(conclusion, multi)
  expect(rendered).toContain('替代方案（引用 1）: 单篇全覆盖成立')
  expect(rendered).toContain('替代方案（引用 1、2）: 未全覆盖，缺 2b')
  expect(rendered).toContain('引用 1、2: 2b')
})

it('从属权项自身要素未全覆盖时不报路径问题（形态不成立）', () => {
  const conclusion = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'not-found'),
  ]))
  expect(conclusion.dependentClaimIssues).toEqual([])
})

it('引用关系缺陷随结论输出', () => {
  const broken = chart([])
  broken.claims = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [7] },
  ]
  expect(deriveInvalidityConclusion(broken).claimRefIssues).toEqual([
    { kind: 'missing-reference', claimNo: 2, refersTo: [7] },
  ])
})

it('引用到没有要素的权项时不报附加特征问题', () => {
  const c = chart([row('1a', 'D1', 'literal'), row('1b', 'D1', 'literal')])
  c.claims = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
    { claimNo: 3, claimType: 'dependent', refersTo: [1] },
  ]
  c.elements = ELEMENTS.filter(element => element.claimNo !== 2)
  const conclusion = deriveInvalidityConclusion(c)
  expect(conclusion.dependentClaimIssues).toEqual([])
})

it('引用链中部分权项已覆盖时跳过该权项', () => {
  const c = chart([
    row('1a', 'D1', 'not-found'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
    row('3a', 'D1', 'literal'),
    row('3b', 'D1', 'literal'),
  ])
  c.elements = [
    ...ELEMENTS,
    { id: '3a', claimNo: 3, text: '根据权利要求2所述的装置', kind: 'preamble' },
    { id: '3b', claimNo: 3, text: '所述壳体为金属', kind: 'limitation' },
  ]
  c.claims = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [3] },
    { claimNo: 3, claimType: 'dependent', refersTo: [1] },
  ]
  const issues = deriveInvalidityConclusion(c).dependentClaimIssues
  expect(issues.map(issue => issue.referredClaimNo)).toEqual([1, 1])
})

it('渲染无标题的对比文件目标', () => {
  const c = chart([row('1a', 'D2', 'literal')], [D2])
  const rendered = renderInvalidityConclusion(deriveInvalidityConclusion(c), c)
  expect(rendered).toContain('### D2')
  expect(rendered).not.toContain('### D2（')
})

it('渲染四类引用关系缺陷', () => {
  const self = chart([])
  self.claims = [{ claimNo: 1, claimType: 'dependent', refersTo: [1] }]
  expect(renderInvalidityConclusion(deriveInvalidityConclusion(self), self)).toContain('权利要求引用了自身')

  const missing = chart([])
  missing.claims = [
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [7] },
  ]
  expect(renderInvalidityConclusion(deriveInvalidityConclusion(missing), missing)).toContain('所引用的权利要求不存在')

  const cycle = chart([])
  cycle.claims = [
    { claimNo: 1, claimType: 'dependent', refersTo: [2] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  ]
  const cycleReport = renderInvalidityConclusion(deriveInvalidityConclusion(cycle), cycle)
  expect(cycleReport).toContain('从属权利要求只能引用在前的权利要求')
  expect(cycleReport).toContain('引用关系成环')
})

it('渲染：逐权项结论、区别特征、路径问题与引用关系未知三分支', () => {
  const covered = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'literal'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
  ]))
  const rendered = renderInvalidityConclusion(covered, chart([]))
  expect(rendered).toContain('主对比文件: D1')
  expect(rendered).toContain('- 权利要求 1: 单篇全覆盖成立')
  expect(rendered).toContain('- 权利要求 2: 单篇全覆盖成立（已并入所引用权利要求 1 的全部要素）')
  expect(rendered).toContain('- 权利要求 1: 无区别特征（主对比文件已覆盖全部要素）')
  expect(rendered).toContain('- 未检出"仅附加特征被覆盖"形态')
  expect(rendered).toContain('- 未检出')

  const gapped = deriveInvalidityConclusion(chart([
    row('1a', 'D1', 'literal'),
    row('1b', 'D1', 'not-found'),
    row('2a', 'D1', 'literal'),
    row('2b', 'D1', 'literal'),
  ]))
  const gappedText = renderInvalidityConclusion(gapped, chart([]))
  expect(gappedText).toContain('- 权利要求 1: 未全覆盖，缺 1b')
  expect(gappedText).toContain('- 权利要求 1: 1b')
  expect(gappedText).toContain('从属权利要求法条路径问题（1 条）')
  expect(gappedText).toContain('权利要求 2 → 权利要求 1（D1）')

  const unknownRefs = renderInvalidityConclusion(covered, chart([]))
  expect(unknownRefs).not.toContain('引用关系未知')

  const noRefs = chart([])
  noRefs.claims = []
  expect(renderInvalidityConclusion(deriveInvalidityConclusion(noRefs), noRefs)).toContain('引用关系未知')

  const noPriorArt = chart([], [{ id: '产品A', kind: 'accused-product' }])
  const noPriorArtText = renderInvalidityConclusion(deriveInvalidityConclusion(noPriorArt), noPriorArt)
  expect(noPriorArtText).toContain('主对比文件: （无对比文件目标）')
  expect(noPriorArtText).toContain('- 未计算（图表无对比文件目标）')

  const noElements = chart([])
  noElements.elements = []
  noElements.claimNos = []
  expect(renderInvalidityConclusion(deriveInvalidityConclusion(noElements), noElements)).toContain('（无）')
})

it('无要素时不产生逐权项判定', () => {
  const empty = chart([])
  empty.elements = []
  empty.claimNos = []
  expect(deriveInvalidityConclusion(empty).novelty[0]?.claims).toEqual([])
})

it('所引权项没有要素时不写已并入全部要素', () => {
  const partial = chart([row('2a', 'D1', 'literal')])
  partial.elements = [{ id: '2a', claimNo: 2, text: '所述滤芯为折叠式', kind: 'limitation' }]
  partial.claimNos = [2]
  const conclusion = deriveInvalidityConclusion(partial)
  expect(conclusion.novelty[0]?.claims[0]).toMatchObject({
    claimNo: 2,
    covered: false,
    missing: [],
    missingReferredClaims: [1],
  })
  const text = renderInvalidityConclusion(conclusion, partial)
  expect(text).toContain('所引权利要求 1 没有要素，不能并入')
  expect(text).not.toContain('已并入所引用权利要求 1 的全部要素')
})
