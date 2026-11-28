/**
 * src/patent/analysis-report — barrel。
 *
 * 导出分析产物契约、确定性特征抽取与聚合器，供工具层（dsh-patent-tools）组装
 * pid/model-facing 分析报告。
 */

// Package root only publishes buildAnalysisReport plus the PatentAnalysisReport,
// QualityDomain, and SearchStrategy contracts; other build/extract primitives are
// imported from their source modules by internal callers and tests.
export type {
  PatentAnalysisReport,
  QualityDomain,
  SearchStrategy,
} from './types.ts'
export { buildAnalysisReport } from './build.ts'
