/**
 * 专利申请文件评审的统一 findings 契约与纯汇总入口。
 * @module @deepseek-ai/dsh-patent-tools/review
 */

export type {
  ReviewFinding,
  ReviewLocator,
  ReviewLocatorView,
  ReviewReport,
  ReviewReportFinding,
  ReviewReportFindingView,
  ReviewReportView,
  ReviewSeverity,
  ReviewSource,
} from './types.ts'

export {
  aggregateReviewFindings,
  reviewFindingFromClaimLint,
  reviewFindingFromSpecViolation,
  type AggregateReviewInput,
  type AggregateReviewResult,
} from './aggregate.ts'

export { figureFormFindings } from './figure-findings.ts'
export type {
  FigureCheckEvidence,
  FigureFormEvidence,
  FigureFormFindingsInput,
} from './figure-findings.ts'

export { buildReviewReport, compareReviewFindings } from './report.ts'
