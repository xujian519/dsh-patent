import { expect, it } from 'vitest'
import {
  deriveClaimRefs,
  parseClaimDocument,
  parseReferenceNumbers,
  referencedClosure,
  validateClaimRefs,
} from '@deepseek-ai/dsh-patent-core'

it('单引用的从属权项识别为 dependent 并给出所引权项', () => {
  const text = [
    '1. 一种换热装置，其特征在于，包括壳体。',
    '2. 根据权利要求1所述的换热装置，其特征在于，所述壳体为塑料。',
  ].join('\n')
  expect(deriveClaimRefs(text)).toEqual([
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  ])
})

it('自引用保留在引用关系中，由校验报告，而不是静默按独立权项处理', () => {
  const refs = deriveClaimRefs('1. 根据权利要求1所述的装置，其特征在于，包括壳体。')
  expect(refs).toEqual([{ claimNo: 1, claimType: 'dependent', refersTo: [1] }])
  expect(validateClaimRefs(refs)).toEqual([
    { kind: 'self-reference', claimNo: 1 },
    { kind: 'later-reference', claimNo: 1, refersTo: [1] },
  ])
})

it('如/按照 与多值、区间引用都识别', () => {
  const text = [
    '1. 一种装置，包括壳体。',
    '2. 如权利要求1所述的装置，其特征在于，还包括滤芯。',
    '3. 根据权利要求1或2所述的装置，其特征在于，所述滤芯可拆。',
    '4. 按照权利要求1至3中任一项所述的装置，其特征在于，所述壳体为金属。',
    '5. 根据权利要求1-3所述的装置，其特征在于，所述滤芯为折叠式。',
  ].join('\n')
  expect(deriveClaimRefs(text).map(ref => ref.refersTo)).toEqual([[], [1], [1, 2], [1, 2, 3], [1, 2, 3]])
})

it('编号表达式容忍空片段与非数字标记', () => {
  expect(parseReferenceNumbers('或1， 2')).toEqual([1, 2])
  expect(parseReferenceNumbers('1或X')).toEqual([1])
  expect(parseReferenceNumbers('1或2a')).toEqual([1, 2])
})

it('区间展开有跨度上限，超限只保留端点', () => {
  expect(parseReferenceNumbers('1-3')).toEqual([1, 2, 3])
  expect(parseReferenceNumbers('1-35')).toHaveLength(35)
  expect(parseReferenceNumbers('1-2000')).toEqual([1, 2000])
  expect(parseReferenceNumbers('1、2 或 4')).toEqual([1, 2, 4])
  expect(parseReferenceNumbers('7')).toEqual([7])
})

it('倒序与超限区间既展开又记入缺陷，不静默变成独立权项', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 根据权利要求1-35所述的装置，其特征在于，所述壳体为金属。',
    '3. 根据权利要求2-1所述的装置，其特征在于，所述壳体可拆。',
    '4. 根据权利要求1-2000所述的装置，其特征在于，所述壳体为塑料。',
  ].join('\n')
  const refs = deriveClaimRefs(text)
  expect(refs[1]).toEqual({ claimNo: 2, claimType: 'dependent', refersTo: Array.from({ length: 35 }, (_, i) => i + 1) })
  expect(refs[2]).toEqual({
    claimNo: 3,
    claimType: 'dependent',
    refersTo: [1, 2],
    referenceDefects: [{ kind: 'descending-range', raw: '2-1' }],
  })
  expect(refs[3]).toEqual({
    claimNo: 4,
    claimType: 'dependent',
    refersTo: [1, 2000],
    referenceDefects: [{ kind: 'oversized-range', raw: '1-2000' }],
  })
  expect(validateClaimRefs(refs)).toContainEqual({
    kind: 'reference-range',
    claimNo: 3,
    raw: '2-1',
    problem: 'descending-range',
  })
  expect(validateClaimRefs(refs)).toContainEqual({
    kind: 'reference-range',
    claimNo: 4,
    raw: '1-2000',
    problem: 'oversized-range',
  })
})

it('全角数字与「依」前缀在引用关系推导里同样识别', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 依权利要求１所述的装置，其特征在于，所述壳体为金属。',
  ].join('\n')
  expect(deriveClaimRefs(text)[1]).toEqual({ claimNo: 2, claimType: 'dependent', refersTo: [1] })
})

it('同一份权利要求书在两套解析里给出相同的独立／从属与引用号', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 如权利要求１所述的装置，其特征在于，还包括滤芯。',
    '3. 根据权利要求1-3所述的装置，其特征在于，所述滤芯可拆。',
    '4. 按照权利要求2至1所述的装置，其特征在于，所述壳体为金属。',
  ].join('\n')
  const derived = deriveClaimRefs(text)
  const parsed = parseClaimDocument(text).claims
  expect(parsed.map(claim => claim.independent)).toEqual(derived.map(ref => ref.claimType === 'independent'))
  expect(parsed.map(claim => claim.references)).toEqual(derived.map(ref => ref.refersTo))
})

it('无前缀引用语只在引言部分生效：正文中途转述不算本权项的引用', () => {
  const text = [
    '1. 一种装置，包括壳体。',
    '2. 一种制造权利要求1所述装置的方法，包括步骤：按权利要求1所述进行装配，其特征在于，温度为200℃。',
  ].join('\n')
  // 引用语在特征部分之前，仍是从属权项。
  expect(deriveClaimRefs(text)[1]?.refersTo).toEqual([1])

  const mid = [
    '1. 一种装置，包括壳体。',
    '2. 一种制造方法，其步骤包括加热、保温与冷却，其中加热按照本领域常规方式进行，冷却至室温，其特征在于，装配权利要求1所述的装置。',
  ].join('\n')
  expect(deriveClaimRefs(mid)[1]?.claimType).toBe('independent')
})

it('带前缀的引用语不受引言长度限制，落在特征部分也生效', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 一种用于高温高压环境下的换热装置，其包括壳体、设置于所述壳体内部的换热管以及用于连接所述换热管的集流管，其特征在于，根据权利要求1所述的换热装置，所述壳体为塑料。',
  ].join('\n')
  expect(deriveClaimRefs(text)[1]).toEqual({ claimNo: 2, claimType: 'dependent', refersTo: [1] })
})

it('概括引用展开为全部在前权项', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 一种装置，其特征在于，包括底座。',
    '3. 根据前述权利要求中任一项所述的装置，其特征在于，所述壳体为塑料。',
    '4. 根据上述权利要求之一所述的装置，其特征在于，所述壳体可拆。',
  ].join('\n')
  expect(deriveClaimRefs(text).map(ref => ref.refersTo)).toEqual([[], [], [1, 2], [1, 2, 3]])
})

it('第一条权项的概括引用没有在前权项可指，不臆造引用', () => {
  expect(deriveClaimRefs('1. 根据前述权利要求中任一项所述的装置，其特征在于，包括壳体。'))
    .toEqual([{ claimNo: 1, claimType: 'independent', refersTo: [] }])
})

it('多处引用语取出现位置最早的一条', () => {
  const text = [
    '1. 一种装置，包括壳体。',
    '2. 权利要求1所述的装置，其特征在于，根据权利要求3所述的装置，所述壳体为塑料。',
    '3. 一种装置，包括底座。',
  ].join('\n')
  expect(deriveClaimRefs(text)[1]?.refersTo).toEqual([1])
})

it('权项正文没有句末标点时引言取全文', () => {
  const text = [
    '1. 一种装置，其特征在于，包括壳体。',
    '2. 根据权利要求1所述的装置',
  ].join('\n')
  expect(deriveClaimRefs(text).map(ref => ref.refersTo)).toEqual([[], [1]])
})

it('无行首编号时返回空数组（引用关系未知，不臆造）', () => {
  expect(deriveClaimRefs('一种装置，其特征在于，包括壳体。')).toEqual([])
})

it('引用关系校验：自引用、引用不存在、引用编号不更小、成环', () => {
  expect(validateClaimRefs([
    { claimNo: 1, claimType: 'dependent', refersTo: [1] },
  ])).toEqual([
    { kind: 'self-reference', claimNo: 1 },
    { kind: 'later-reference', claimNo: 1, refersTo: [1] },
  ])

  expect(validateClaimRefs([
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [9] },
  ])).toEqual([
    { kind: 'missing-reference', claimNo: 2, refersTo: [9] },
  ])

  expect(validateClaimRefs([
    { claimNo: 1, claimType: 'dependent', refersTo: [2] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
  ])).toEqual([
    { kind: 'later-reference', claimNo: 1, refersTo: [2] },
    { kind: 'reference-cycle', claimNos: [1, 2] },
  ])

  expect(validateClaimRefs([
    { claimNo: 1, claimType: 'independent', refersTo: [] },
    { claimNo: 2, claimType: 'dependent', refersTo: [1] },
    { claimNo: 3, claimType: 'dependent', refersTo: [1, 2] },
  ])).toEqual([])
})

it('引用环检测沿全部引用边，而不是只看第一条', () => {
  expect(validateClaimRefs([
    { claimNo: 1, claimType: 'dependent', refersTo: [2, 3] },
    { claimNo: 2, claimType: 'independent', refersTo: [] },
    { claimNo: 3, claimType: 'dependent', refersTo: [1] },
  ])).toContainEqual({ kind: 'reference-cycle', claimNos: [1, 3] })
})

it('传递闭包取引用链并集，不含自身', () => {
  const refs = [
    { claimNo: 1, claimType: 'independent' as const, refersTo: [] },
    { claimNo: 2, claimType: 'dependent' as const, refersTo: [1] },
    { claimNo: 3, claimType: 'dependent' as const, refersTo: [2] },
    { claimNo: 4, claimType: 'dependent' as const, refersTo: [1, 3] },
  ]
  expect(referencedClosure(refs, 3)).toEqual([1, 2])
  expect(referencedClosure(refs, 4)).toEqual([1, 2, 3])
  expect(referencedClosure(refs, 1)).toEqual([])
  expect(referencedClosure(refs, 9)).toEqual([])
})
