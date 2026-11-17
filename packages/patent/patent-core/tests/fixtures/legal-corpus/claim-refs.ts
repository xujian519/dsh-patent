import type { ClaimRef, ClaimRefIssue } from '../../../src/claim-chart/protocol/types.ts'

/** 金标语料：权利要求书原文推出的独立／从属关系与引用缺陷。 */
export type ClaimRefsCase = {
  engine: 'claim-refs'
  id: string
  title: string
  /** 带行首编号的权利要求书原文。 */
  text: string
  expected: readonly ClaimRef[]
  expectedIssues: readonly ClaimRefIssue[]
}

/** 权利要求引用关系金标语料（当前行为已符合预期的情形）。 */
export const CLAIM_REFS_CASES: readonly ClaimRefsCase[] = [
  {
    engine: 'claim-refs',
    id: 'REF-001',
    title: '独立权项与单项、多项从属权项',
    text: [
      '1. 一种换热装置，其特征在于，包括壳体。',
      '2. 根据权利要求1所述的换热装置，其特征在于，所述壳体为塑料。',
      '3. 根据权利要求1或2所述的换热装置，其特征在于，所述壳体可拆。',
    ].join('\n'),
    expected: [
      { claimNo: 1, claimType: 'independent', refersTo: [] },
      { claimNo: 2, claimType: 'dependent', refersTo: [1] },
      { claimNo: 3, claimType: 'dependent', refersTo: [1, 2] },
    ],
    expectedIssues: [],
  },
  {
    engine: 'claim-refs',
    id: 'REF-002',
    title: '引用不存在权项、引用在后权项与成环同时报告',
    text: [
      '1. 一种装置，其特征在于，包括壳体。',
      '2. 根据权利要求9所述的装置，其特征在于，所述壳体为金属。',
      '3. 根据权利要求4所述的装置，其特征在于，所述壳体为塑料。',
      '4. 根据权利要求3所述的装置，其特征在于，所述壳体可拆。',
    ].join('\n'),
    expected: [
      { claimNo: 1, claimType: 'independent', refersTo: [] },
      { claimNo: 2, claimType: 'dependent', refersTo: [9] },
      { claimNo: 3, claimType: 'dependent', refersTo: [4] },
      { claimNo: 4, claimType: 'dependent', refersTo: [3] },
    ],
    expectedIssues: [
      { kind: 'missing-reference', claimNo: 2, refersTo: [9] },
      { kind: 'later-reference', claimNo: 3, refersTo: [4] },
      { kind: 'reference-cycle', claimNos: [3, 4] },
    ],
  },
  {
    engine: 'claim-refs',
    id: 'REF-003',
    title: '无行首编号时引用关系未知，不臆造独立权项',
    text: '一种装置，其特征在于，包括壳体。',
    expected: [],
    expectedIssues: [],
  },
  {
    engine: 'claim-refs',
    id: 'REF-004',
    title: '长引言且引用语落在特征部分时仍识别为从属权项',
    text: [
      '1. 一种装置，其特征在于，包括壳体。',
      '2. 一种用于高温高压环境下的换热装置，其包括壳体、设置于所述壳体内部的换热管以及用于连接所述换热管的集流管，其特征在于，根据权利要求1所述的换热装置，所述壳体为塑料。',
    ].join('\n'),
    expected: [
      { claimNo: 1, claimType: 'independent', refersTo: [] },
      { claimNo: 2, claimType: 'dependent', refersTo: [1] },
    ],
    expectedIssues: [],
  },
  {
    engine: 'claim-refs',
    id: 'REF-005',
    title: '概括引用展开为全部在前权项',
    text: [
      '1. 一种装置，其特征在于，包括壳体。',
      '2. 根据权利要求1所述的装置，其特征在于，所述壳体为塑料。',
      '3. 根据前述权利要求中任一项所述的装置，其特征在于，所述壳体可拆。',
    ].join('\n'),
    expected: [
      { claimNo: 1, claimType: 'independent', refersTo: [] },
      { claimNo: 2, claimType: 'dependent', refersTo: [1] },
      { claimNo: 3, claimType: 'dependent', refersTo: [1, 2] },
    ],
    expectedIssues: [],
  },
]
