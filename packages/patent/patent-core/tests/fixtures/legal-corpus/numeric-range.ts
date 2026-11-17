import type { NumericRangeVerdict } from '../../../src/novelty/numeric-range.ts'

/** 金标语料：数值范围确定性判定的一则法律情形。 */
export type NumericRangeCase = {
  engine: 'numeric-range'
  /** 稳定用例编号，供后续修复 PR 引用。 */
  id: string
  /** 法律情形说明。 */
  title: string
  /** 权利要求侧原文。 */
  claim: string
  /** 对比文件侧原文与标号。 */
  priorArt: readonly { docId: string; text: string }[]
  /** 依据审查指南第二部分第三章应得的结论。 */
  expected: NumericRangeVerdict
}

/** 数值范围金标语料（当前行为已符合预期的情形）。 */
export const NUMERIC_RANGE_CASES: readonly NumericRangeCase[] = [
  {
    engine: 'numeric-range',
    id: 'NUM-001',
    title: '区间重叠破坏新颖性',
    claim: '温度为 50-80℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 60-90℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-002',
    title: '数值点落在对比文件范围内部且无共同端点，不破坏新颖性',
    claim: '温度为 70℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 60-90℃' }],
    expected: 'inside_without_endpoint',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-003',
    title: '数值点与对比文件范围共有端点，破坏新颖性',
    claim: '温度为 60℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 60-90℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-004',
    title: '同单位区间不相交',
    claim: '温度为 50-80℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 100-200℃' }],
    expected: 'no_overlap',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-005',
    title: '任一侧缺少带单位表述时无法判定',
    claim: '温度为 50-80',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 60-90℃' }],
    expected: 'inconclusive',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-006',
    title: '单边下界与对比文件区间相交',
    claim: '温度不低于 70℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 100-200℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-007',
    title: '百分比数值点落在对比文件范围内',
    claim: '湿度为 70%',
    priorArt: [{ docId: 'D1', text: 'D1 公开湿度为 50-90%' }],
    expected: 'inside_without_endpoint',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-008',
    title: '同一表外单位仍可比对',
    claim: '粘度为 5-10cps',
    priorArt: [{ docId: 'D1', text: 'D1 公开粘度为 8-12cps' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-009',
    title: '区间仅在连接符前写单位时沿用该单位',
    claim: '温度为 20℃至90',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 60-80℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-010',
    title: '负值区间重叠破坏新颖性',
    claim: '温度为-5至-10℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为-8至-6℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-011',
    title: '负值数值点落入对比文件范围内部',
    claim: '温度为-5℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为-10至-1℃' }],
    expected: 'inside_without_endpoint',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-012',
    title: '同量纲不同单位换算后区间重叠',
    claim: '加入量为 5-10mg',
    priorArt: [{ docId: 'D1', text: 'D1 公开加入量为 0.005-0.01g' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-013',
    title: '量纲不同的单位不可比时无法判定',
    claim: '加入量为 5-10mg',
    priorArt: [{ docId: 'D1', text: 'D1 公开加热时间为 5-10s' }],
    expected: 'inconclusive',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-014',
    title: '后缀式下界与对比文件区间相交',
    claim: '温度在 70℃以上',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为 100-200℃' }],
    expected: 'overlapped',
  },
  {
    engine: 'numeric-range',
    id: 'NUM-015',
    title: 'Unicode 负号与 ASCII 负号同义',
    claim: '温度为−5至−10℃',
    priorArt: [{ docId: 'D1', text: 'D1 公开温度为-8至-6℃' }],
    expected: 'overlapped',
  },
]
