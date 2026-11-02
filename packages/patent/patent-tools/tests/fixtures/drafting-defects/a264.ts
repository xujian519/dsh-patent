import type { DraftingDefectFixture } from './types.ts'

/** D06：上位概括只有一种实施方式支撑。 */
export const D06: DraftingDefectFixture = {
  id: 'D06',
  title: '上位概括只有一种实施方式',
  provision: 'A26.4',
  expected: 'failed',
  specification: '实施例1中，加热通道为螺旋形通道，能够均匀加热液体。',
  claims: '1. 一种加热装置，其特征在于，包括任意形状的加热通道。',
  checks: ['claim-support-breadth'],
  anchor_reason: 'exact',
  breadth: {
    records: [
      {
        claim_no: 1,
        generalization: '任意形状的加热通道',
        quote: '加热通道为螺旋形通道',
        parallel_lower_levels: ['螺旋形通道'],
        all_parallel_same_effect: true,
        defect: 'no-embodiment-support',
        reason: '说明书只公开螺旋形通道，没有支撑任意形状。',
      },
    ],
  },
}

/** D07：并列下位之一达不到同一效果。 */
export const D07: DraftingDefectFixture = {
  id: 'D07',
  title: '并列下位之一达不到同一效果',
  provision: 'A26.4',
  expected: 'failed',
  specification: [
    '实施例1中，加热通道为螺旋形通道，加热均匀。',
    '对比例1中，加热通道为蛇形通道，未记载加热效果。',
  ].join('\n'),
  claims: '1. 一种加热装置，其特征在于，包括螺旋形通道和蛇形通道。',
  checks: ['claim-support-breadth'],
  anchor_reason: 'exact',
  breadth: {
    records: [
      {
        claim_no: 1,
        generalization: '加热通道',
        quote: '加热通道为螺旋形通道，加热均匀',
        parallel_lower_levels: ['螺旋形通道', '蛇形通道'],
        all_parallel_same_effect: false,
        defect: 'parallel-lower-level-gap',
        reason: '蛇形通道未记载达到均匀加热效果。',
      },
    ],
  },
}

/** D08：功能性限定没有实施方式。 */
export const D08: DraftingDefectFixture = {
  id: 'D08',
  title: '功能性限定无实施方式',
  provision: 'A26.4',
  expected: 'failed',
  specification: '实施例1中，加热装置包括控制单元，控制单元根据温度调节加热功率。',
  claims: '1. 一种加热装置，其特征在于，包括控制模块，所述控制模块用于根据温度调节加热功率。',
  checks: ['claim-support-breadth'],
  anchor_reason: 'exact',
  breadth: {
    records: [
      {
        claim_no: 1,
        generalization: '用于根据温度调节加热功率的控制模块',
        quote: '控制单元根据温度调节加热功率',
        parallel_lower_levels: ['控制单元'],
        all_parallel_same_effect: true,
        defect: 'functional-limitation-without-embodiment',
        reason: '说明书只有功能描述，没有给出控制模块的内部实施方式。',
      },
    ],
  },
}

/** D09：权要用语与说明书术语不一致。 */
export const D09: DraftingDefectFixture = {
  id: 'D09',
  title: '权要用语与说明书术语不一致',
  provision: 'A26.4',
  expected: 'failed',
  specification: '实施例1中，加热通道内设有螺旋形通道。',
  claims: '1. 一种加热装置，其特征在于，包括加热腔，所述加热腔内设有螺旋形通道。',
  checks: ['claim-support-breadth'],
  anchor_reason: 'exact',
  breadth: {
    records: [
      {
        claim_no: 1,
        generalization: '加热腔',
        quote: '加热通道内设有螺旋形通道',
        parallel_lower_levels: ['加热通道'],
        all_parallel_same_effect: true,
        defect: 'term-inconsistency',
        reason: '权利要求使用“加热腔”，说明书使用“加热通道”。',
      },
    ],
  },
}

/** D11：摘录与原文差一个字，证明锚点复核而不是模型判定拦下它。 */
export const D11: DraftingDefectFixture = {
  id: 'D11',
  title: '摘录与原文差一个字',
  provision: 'A26.4',
  expected: 'failed',
  specification: '实施例1中，加热通道为螺旋形通道，能够均匀加热液体。',
  claims: '1. 一种加热装置，其特征在于，包括螺旋形加热通道。',
  checks: ['claim-support-breadth'],
  anchor_reason: 'not-found',
  breadth: {
    records: [
      {
        claim_no: 1,
        generalization: '螺旋形加热通道',
        quote: '加热通道为螺旋型通道',
        parallel_lower_levels: ['螺旋形通道'],
        all_parallel_same_effect: true,
        defect: 'none',
        reason: '模型判定实施例1支持该概括。',
      },
    ],
  },
}

/** A26.4 种植缺陷夹具；D11 是锚点复核的单独探针。 */
export const A264_FIXTURES: readonly DraftingDefectFixture[] = [D06, D07, D08, D09, D11]
