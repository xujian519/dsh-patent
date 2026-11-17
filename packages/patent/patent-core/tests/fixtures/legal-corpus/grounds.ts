import type { GroundFinding, InvalidationGround } from '../../../src/notice/grounds.ts'

/** 金标语料：无效请求书中理由的否定判定。 */
export type GroundsCase = {
  engine: 'grounds'
  id: string
  title: string
  /** 无效宣告请求书正文。 */
  text: string
  /** 期望的理由与否定判定，按无效理由表序。 */
  expected: readonly Pick<GroundFinding<InvalidationGround>, 'ground' | 'negated'>[]
}

/** 理由否定判定金标语料。 */
export const GROUNDS_CASES: readonly GroundsCase[] = [
  {
    engine: 'grounds',
    id: 'GRD-001',
    title: '否认新颖性但主张创造性：只把转述的否定命中标为否定',
    text: '请求人未主张权利要求1不具备新颖性，但主张权利要求1不具备创造性。',
    expected: [
      { ground: 'novelty', negated: true },
      { ground: 'inventiveness', negated: false },
    ],
  },
  {
    engine: 'grounds',
    id: 'GRD-002',
    title: '并非公开不充分：否定句式内的命中仍输出但标为否定',
    text: '说明书并非公开不充分，权利要求1也不具备新颖性。',
    expected: [
      { ground: 'novelty', negated: false },
      { ground: 'disclosure', negated: true },
    ],
  },
  {
    engine: 'grounds',
    id: 'GRD-003',
    title: '缺陷表述中的未/不不是元否定',
    text: '说明书未充分公开，权利要求1不具备新颖性。',
    expected: [
      { ground: 'novelty', negated: false },
      { ground: 'disclosure', negated: false },
    ],
  },
]
