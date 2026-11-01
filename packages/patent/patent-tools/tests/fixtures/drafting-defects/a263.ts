import type { DraftingDefectFixture } from './types.ts'

/** D01：独权特征只剩结构描述，说明书没有给出参数范围。 */
export const D01: DraftingDefectFixture = {
  id: 'D01',
  title: '独权特征缺参数范围',
  provision: 'A26.3',
  expected: 'failed',
  specification: [
    '本实施例提供一种加热装置。',
    '加热装置包括加热腔，加热腔用于加热液体，未给出加热温度范围。',
  ].join('\n'),
  claims: '1. 一种加热装置，其特征在于，包括加热腔，所述加热腔的加热温度为 80-120℃。',
  checks: ['enablement'],
  anchor_reason: 'exact',
  enablement: {
    records: [
      {
        feature_id: 'C1F1',
        quote: '加热装置包括加热腔',
        embodiment_id: '实施例1',
        parameter_or_effect: '加热腔用于容纳液体',
        enabled: true,
      },
      {
        feature_id: 'C1F2',
        quote: '加热腔用于加热液体',
        embodiment_id: '实施例1',
        parameter_or_effect: '未给出 80-120℃ 的温度范围',
        enabled: false,
      },
    ],
  },
}

/** D02：独权特征没有任何实施例，只有功能描述。 */
export const D02: DraftingDefectFixture = {
  id: 'D02',
  title: '独权特征无任何实施例',
  provision: 'A26.3',
  expected: 'failed',
  specification: '本申请提供一种过滤装置，能够高效过滤颗粒物。',
  claims: '1. 一种过滤装置，其特征在于，包括滤芯，所述滤芯的孔径为 0.2 μm。',
  checks: ['enablement'],
  enablement: {
    records: [
      {
        feature_id: 'C1F1',
        quote: '提供一种过滤装置',
        embodiment_id: '未记载',
        parameter_or_effect: '只有功能描述，没有实施例',
        enabled: false,
      },
      {
        feature_id: 'C1F2',
        quote: '',
        embodiment_id: '未记载',
        parameter_or_effect: '未记载孔径与过滤实施例',
        enabled: false,
      },
    ],
  },
}

/** D03：效果只有结论性断言，没有可验证现象或数据。 */
export const D03: DraftingDefectFixture = {
  id: 'D03',
  title: '效果只有断言、无可验证现象或数据',
  provision: 'A26.3',
  expected: 'failed',
  specification: '实施例1提供一种散热板，包括基板和微通道。该散热板具有优异的散热效果。',
  claims: '1. 一种散热板，其特征在于，包括基板，所述基板上设有微通道。',
  checks: ['enablement'],
  anchor_reason: 'exact',
  enablement: {
    records: [
      {
        feature_id: 'C1F1',
        quote: '散热板，包括基板和微通道',
        embodiment_id: '实施例1',
        parameter_or_effect: '实施例1给出基板与微通道结构',
        enabled: true,
      },
      {
        feature_id: 'C1F2',
        quote: '该散热板具有优异的散热效果',
        embodiment_id: '实施例1',
        parameter_or_effect: '仅有结论性效果断言，无温度数据或可验证现象',
        enabled: false,
      },
    ],
  },
}

/** D04：软件案缺模块划分与输入输出关联。 */
export const D04: DraftingDefectFixture = {
  id: 'D04',
  title: '软件案缺模块或输入输出关联',
  provision: 'A26.3',
  expected: 'failed',
  tech_domain: 'software',
  specification: '本实施例提供一种图像识别方法，能够提高识别准确率。识别模型用于识别图像中的目标。',
  claims: '1. 一种图像识别方法，其特征在于，包括获取图像，将所述图像输入识别模型，输出识别结果。',
  checks: ['enablement'],
  anchor_reason: 'exact',
  enablement: {
    records: [
      {
        feature_id: 'C1F1',
        quote: '提供一种图像识别方法',
        embodiment_id: '实施例1',
        parameter_or_effect: '未说明图像由哪个模块获取',
        enabled: false,
      },
      {
        feature_id: 'C1F2',
        quote: '识别模型用于识别图像中的目标',
        embodiment_id: '实施例1',
        parameter_or_effect: '未说明识别模型的模块划分与输入输出关联',
        enabled: false,
      },
      {
        feature_id: 'C1F3',
        quote: '提高识别准确率',
        embodiment_id: '实施例1',
        parameter_or_effect: '只有效果断言，没有输出步骤',
        enabled: false,
      },
    ],
  },
}

/** D05：化学案缺制备例与效果数据。 */
export const D05: DraftingDefectFixture = {
  id: 'D05',
  title: '化学案缺制备例',
  provision: 'A26.3',
  expected: 'failed',
  tech_domain: 'chemical',
  specification: '本实施例提供一种阻燃组合物，包括聚磷酸铵。聚磷酸铵与基体树脂混合后具有阻燃性能，未记载制备例与效果数据。',
  claims: '1. 一种阻燃组合物，其特征在于，包括聚磷酸铵，所述聚磷酸铵的质量份为 20-30 份。',
  checks: ['enablement'],
  anchor_reason: 'exact',
  enablement: {
    records: [
      {
        feature_id: 'C1F1',
        quote: '包括聚磷酸铵',
        embodiment_id: '未记载',
        parameter_or_effect: '缺少制备例',
        enabled: false,
      },
      {
        feature_id: 'C1F2',
        quote: '聚磷酸铵与基体树脂混合后具有阻燃性能',
        embodiment_id: '未记载',
        parameter_or_effect: '缺少配比、工艺条件与效果数据',
        enabled: false,
      },
    ],
  },
}

/** A26.3 种植缺陷夹具。 */
export const A263_FIXTURES: readonly DraftingDefectFixture[] = [D01, D02, D03, D04, D05]
