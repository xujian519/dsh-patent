/**
 * src/patent/novelty — 新颖性领域的确定性判定 barrel。
 *
 * numeric-range.ts：数值范围重叠的确定性核验，与 LLM 语义轨并行并做一致性对照。
 * numeric-vocabulary.ts：数值范围连接符与单位的共享词表（规格校验侧同用）。
 */

export {
  NUMERIC_ANY_UNIT_ALTERNATION,
  NUMERIC_RANGE_SEPARATOR_CLASS,
  NUMERIC_UNIT_ALTERNATION,
  canonicalNumericUnit,
  normalizeNumericUnit,
} from './numeric-vocabulary.ts'

export {
  analyzeNumericRanges,
  crossCheckNumericVerdict,
  extractNumericFindings,
  extractNumericRanges,
  isNumericVerdict,
  readNumericVerdict,
  type NumericLlmAgreement,
  type NumericRangeAnalysis,
  type NumericRangeFinding,
  type NumericRangeIncomparablePair,
  type NumericRangeIncomparableReason,
  type NumericRangeInput,
  type NumericRangeOverlap,
  type NumericRangeVerdict,
} from './numeric-range.ts'
