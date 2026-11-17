import type { NoticeRejectionType } from '../../../src/notice/office-action.ts'

/** 金标语料：审查意见通知书的确定性解析。 */
export type OfficeActionCase = {
  engine: 'office-action'
  id: string
  title: string
  /** 通知书正文。 */
  text: string
  expected: {
    /** 检索到的驳回类型（按首现顺序）。 */
    types: readonly NoticeRejectionType[]
    /** 受影响权项（升序）。 */
    claims: readonly number[]
    /** 引用文献号（按首现顺序）。 */
    documentNumbers: readonly string[]
    /** 引用文献及其同句权项。 */
    citations: readonly { documentNumber: string; claimsAffected: readonly number[] }[]
    /** 标注冲突条数。 */
    conflictCount: number
  }
}

/** 审查意见解析金标语料（当前行为已符合预期的情形）。 */
export const OFFICE_ACTION_CASES: readonly OfficeActionCase[] = [
  {
    engine: 'office-action',
    id: 'OA-001',
    title: '创造性驳回的权项区间与同句引用文献',
    text: [
      '审查员认为第1-3项权利要求不具备创造性，不符合专利法22条第3款的规定。',
      '对比文件CN101234567A（X类）公开了区别技术特征，权利要求1-3相对于该对比文件不具备创造性。',
    ].join('\n'),
    expected: {
      types: ['inventiveness'],
      claims: [1, 2, 3],
      documentNumbers: ['CN101234567A'],
      citations: [{ documentNumber: 'CN101234567A', claimsAffected: [1, 2, 3] }],
      conflictCount: 0,
    },
  },
  {
    engine: 'office-action',
    id: 'OA-002',
    title: '本申请自身公开号不作为对比文件',
    text: '本申请公开号CN117000000A，对比文件CN112345678A公开了权利要求1的特征。',
    expected: {
      types: [],
      claims: [1],
      documentNumbers: ['CN112345678A'],
      citations: [{ documentNumber: 'CN112345678A', claimsAffected: [1] }],
      conflictCount: 0,
    },
  },
  {
    engine: 'office-action',
    id: 'OA-003',
    title: '同一文献两处相关性标注不一致时记录冲突',
    text: '对比文件CN112345678A（X类）公开了权利要求1的前序特征；'
      + '对比文件CN112345678A（A类）属于一般背景技术。',
    expected: {
      types: [],
      claims: [1],
      documentNumbers: ['CN112345678A'],
      citations: [{ documentNumber: 'CN112345678A', claimsAffected: [1] }],
      conflictCount: 1,
    },
  },
  {
    engine: 'office-action',
    id: 'OA-004',
    title: '无关文本不产出驳回类型、权项或文献',
    text: '本通知书随文送达，请核实。',
    expected: {
      types: [],
      claims: [],
      documentNumbers: [],
      citations: [],
      conflictCount: 0,
    },
  },
  {
    engine: 'office-action',
    id: 'OA-005',
    title: '全角括号内的本申请号是自身指代，不是对比文件',
    text: '本申请（申请号CN117000000A）与对比文件CN112345678A的区别在于加热结构。',
    expected: {
      types: [],
      claims: [],
      documentNumbers: ['CN112345678A'],
      citations: [{ documentNumber: 'CN112345678A', claimsAffected: [] }],
      conflictCount: 0,
    },
  },
  {
    engine: 'office-action',
    id: 'OA-006',
    title: '并列枚举的权项号全部计入同句引用',
    text: '对比文件CN101234567A公开了权利要求1、2和3的技术方案。',
    expected: {
      types: [],
      claims: [1, 2, 3],
      documentNumbers: ['CN101234567A'],
      citations: [{ documentNumber: 'CN101234567A', claimsAffected: [1, 2, 3] }],
      conflictCount: 0,
    },
  },
]
