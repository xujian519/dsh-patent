import type { DraftingDefectFixture } from './types.ts'

/** D10：完整且带锚点的对照例，两个判定都应通过。 */
export const D10: DraftingDefectFixture = {
  id: 'D10',
  title: '完整且带锚点的对照例',
  provision: 'A26.3+A26.4',
  expected: 'passed',
  specification: [
    '实施例1提供一种加热装置。',
    '加热装置包括壳体，壳体内设有螺旋形加热通道。',
    '加热通道的一端设有进液口，进液口的直径为 8 mm。',
    '加热通道的螺距为 12 mm，流量为 2 L/min，能够均匀加热液体。',
  ].join('\n'),
  claims: '1. 一种加热装置，其特征在于，包括壳体，所述壳体内设有螺旋形加热通道，所述加热通道的一端设有进液口。',
  checks: ['enablement', 'claim-support-breadth'],
  enablement: {
    notes: '实施例1 给出了结构、参数与效果。',
    records: [
      {
        feature_id: 'C1F1',
        quote: '包括壳体',
        embodiment_id: '实施例1',
        parameter_or_effect: '实施例1给出壳体结构',
        enabled: true,
      },
      {
        feature_id: 'C1F2',
        quote: '壳体内设有螺旋形加热通道',
        embodiment_id: '实施例1',
        parameter_or_effect: '螺距 12 mm，流量 2 L/min',
        enabled: true,
      },
      {
        feature_id: 'C1F3',
        quote: '加热通道的一端设有进液口',
        embodiment_id: '实施例1',
        parameter_or_effect: '进液口直径 8 mm',
        enabled: true,
      },
    ],
  },
  breadth: {
    notes: '上位概括有实施例支撑。',
    records: [
      {
        claim_no: 1,
        generalization: '螺旋形加热通道',
        quote: '壳体内设有螺旋形加热通道',
        parallel_lower_levels: ['螺旋形加热通道'],
        all_parallel_same_effect: true,
        defect: 'none',
        reason: '实施例1 公开了螺旋形通道、螺距与流量。',
      },
    ],
  },
  anchor_reason: 'exact',
}
