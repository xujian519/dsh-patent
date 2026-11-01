/**
 * src/adversary — 对立审查员模型（adversary-model）模块 barrel。
 *
 * 五步处理流程：
 * 1. dispute.ts：独立争议定位（确定性）
 * 2. assessment.ts：独立证据评估（简化版，TODO 完整版需模型）
 * 3. （独立规则适用：当前合并到 dispute.ts，TODO 完整版需模型）
 * 4. divergence.ts：分歧检测（确定性）
 * 5. report.ts：报告生成
 *
 * 信息隔离：只读 office_action、claims、response_plan、response_plan_summary，
 * 不读 dispute_framing_report、claim_chart、draft 等己方中间推理。
 */

export type {
  AdversaryDispute,
  AdversaryOfficeAction,
  AdversaryPlanEntry,
  AdversaryReport,
} from './types.ts'
export { GROUND_TO_STATUTE, STATUTE_TO_GROUND } from './types.ts'

export { locateDisputesIndependent } from './dispute.ts'
export { assessEvidenceIndependent } from './assessment.ts'
export { computeOverallConfidence, detectDivergence } from './divergence.ts'
export { buildAdversaryReport, degradedSummary, renderAdversaryReport } from './report.ts'
export { buildAdversaryPrompt } from './prompt.ts'
export { type AdversaryModelOutput, parseAdversaryOutput } from './parse.ts'
export {
  type IsolationCheckResult,
  FORBIDDEN_KEYS,
  FORBIDDEN_OUTPUT_TERMS,
  checkInputIsolation,
  scanOutputForLeaks,
} from './isolation-check.ts'

// 换位重跑：从对立审查员视角评估最终意见陈述书（adversary-review）。
export type {
  AdversaryReviewReport,
  AdversaryReviewInput,
  AdversaryReviewOfficeAction,
} from './review.ts'
export {
  reviewFinalDraft,
  detectMissedRejections,
  detectEvidenceGaps,
  detectClaimsCoverage,
  identifyReviewDisputes,
  statuteForEvidenceGap,
  confidenceForEvidenceGap,
  assessArgumentStrength,
  computeReviewConfidence,
  buildReviewSummary,
  MISSED_REJECTION_HEURISTIC_CONFIDENCE,
  CITATION_GAP_HEURISTIC_CONFIDENCE,
  INVENTIVENESS_GAP_HEURISTIC_CONFIDENCE,
  CLAIMS_COVERAGE_GAP_HEURISTIC_CONFIDENCE,
} from './review.ts'
