/**
 * 内置 Pipeline 原子聚合（按职责分域，公共 LLM 骨架见 llm.ts）。
 *
 * - search.ts：search（检索）/ keywords（关键词生成）
 * - extract.ts：extract（结构化抽取）/ merge（PFIE 融合）
 * - pfe.ts：pfe-consistency（PFIE 四元组结构一致性检查）
 * - compare.ts：compare（特征对比）/ novelty（逐特征新颖性）
 * - reason.ts：reasoning（自由推理）/ groundedness（原文依据过滤）
 * - draft.ts：draft-claims（权利要求草稿）
 * - claim-strategy.ts：claim-strategy（权利要求策略表：特征归属、锚点与从权树）
 * - gate.ts：approval-gate（人机审批门）
 * - chart.ts：claim-chart（要素级证据网格）
 * - notice.ts：oa-parse（通知书解析）/ grounds（程序法定理由识别）/ response-plan（答复计划骨架）
 * - coverage.ts：coverage（侵权全面覆盖与等同一致性核验）
 * - citation.ts：citation-check（结论引用与检索结果的一致性校验）
 * - time-baseline.ts：time-baseline（申请日/优先权日 → 现有技术截止日）
 * - prior-art-filter.ts：prior-art-filter（公开日 → 现有技术过滤 + A24 宽限期）
 * - conflicting-application.ts：conflicting-application（抵触申请时间关系与同样性判定）
 * - numeric-range.ts：numeric-range（权利要求数值范围与现有技术文本的重叠判定）
 * - problem-check.ts：problem-check（实际解决的技术问题合规检查）
 * - amendment-basis.ts：amendment-basis（A33 修改依据检查）
 * - evidence-check.ts：evidence-check（无效/复审证据形式、期限与关联性审查）
 * - adversary-model.ts：adversary-model（对立审查员模型：独立评估答复计划的薄弱环节）
 * - adversary-review.ts：adversary-review（换位重跑：从对立审查员视角评估最终意见陈述书）
 * - enablement-report.ts：enablement-report（充分公开 A26.3：逐独权特征锚点复核）
 * - claim-breadth.ts：claim-breadth（概括范围 A26.4：逐条上位概括锚点复核）
 * - quote-stage.ts：enablement-report / claim-breadth 共用的输入读取与模型解析
 *
 * 注：rule-lock 原子位于 @deepseek-ai/dsh-patent-law，由插件 effect 注册。
 */

export {
  searchAtom,
  SearchHandler,
  keywordsAtom,
  KeywordsHandler,
} from './search.ts'
export {
  extractAtom,
  ExtractHandler,
  mergeAtom,
  MergeHandler,
  type PFETriple,
  type ProblemInsightEntry,
} from './extract.ts'
export {
  pfeConsistencyAtom,
  PfeConsistencyHandler,
  PFE_CONSISTENCY_VIOLATION_IDS,
  checkPfeConsistency,
  type PfeConsistencyViolationId,
  type PfeConsistencyViolation,
} from './pfe.ts'
export {
  compareAtom,
  CompareHandler,
  noveltyAtom,
  NoveltyHandler,
  evidenceCoverage,
} from './compare.ts'
export {
  reasoningAtom,
  ReasoningHandler,
  groundednessAtom,
  GroundednessHandler,
  GROUNDEDNESS_THRESHOLD,
} from './reason.ts'
export { draftClaimsAtom, DraftClaimsHandler } from './draft.ts'
export {
  claimStrategyAtom,
  ClaimStrategyHandler,
  renderClaimStrategyReport,
  type ClaimFeatureKind,
  type ClaimStrategy,
  type ClaimStrategyFeature,
  type ClaimStrategyNode,
  type ConfirmedClaimStrategy,
  type ConfirmedFeature,
} from './claim-strategy.ts'
export { degraded, type DegradedOptions } from './llm.ts'
export {
  approvalGateAtom,
  ApprovalGateHandler,
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_NODES_KEY,
  APPROVAL_GRANTED_OUTPUT,
  isApprovalGateHandler,
  isGateApproved,
} from './gate.ts'
export { claimChartAtom, ClaimChartHandler, deriveOfficeActionTargets } from './chart.ts'
export {
  oaParseAtom,
  OaParseHandler,
  groundsAtom,
  GroundsHandler,
  responsePlanAtom,
  ResponsePlanHandler,
  GROUND_PROGRAMS,
  type GroundProgram,
} from './notice.ts'
export { coverageAtom, CoverageHandler } from './coverage.ts'
export {
  citationCheckAtom,
  CitationCheckHandler,
  DEFAULT_CITATION_REF_TEXT_KEYS,
  DEFAULT_CITATION_PRIOR_ART_KEY,
} from './citation.ts'
export { timeBaselineAtom, TimeBaselineHandler } from './time-baseline.ts'
export {
  disputeFramingAtom,
  DisputeFramingHandler,
  disputeFramingRefineAtom,
  DisputeFramingRefineHandler,
  frameDispute,
  refineDispute,
  scanClaimNumbers,
  scanDisputeText,
  type DisputeCandidate,
  type DisputeFraming,
  type RefinedDisputeCandidate,
} from './dispute-framing.ts'
export {
  priorArtFilterAtom,
  PriorArtFilterHandler,
  A24_EXCEPTION_LABELS,
  type A24Exception,
  DEFAULT_PRIOR_ART_PUBLICATION_DATE_KEY,
  DEFAULT_PRIOR_ART_A24_EXCEPTION_KEY,
} from './prior-art-filter.ts'
export {
  conflictingApplicationAtom,
  ConflictingApplicationHandler,
  DEFAULT_CONFLICTING_APPLICATIONS_KEY,
  DEFAULT_TARGET_DATE_KEY,
  DEFAULT_TARGET_FILING_DATE_KEY,
} from './conflicting-application.ts'
export {
  numericRangeAtom,
  NumericRangeHandler,
  DEFAULT_NUMERIC_RANGE_CLAIM_TEXT_KEYS,
  DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS,
  DEFAULT_NUMERIC_RANGE_PRIOR_ART_KEY,
} from './numeric-range.ts'
export {
  problemCheckAtom,
  ProblemCheckHandler,
  DEFAULT_PROBLEM_DIFF_TEXT_KEYS,
  DEFAULT_PROBLEM_FEATURE_KEYS,
  type ProblemCheckViolation,
} from './problem-check.ts'
export {
  amendmentBasisAtom,
  AmendmentBasisHandler,
  DEFAULT_AMENDMENT_AMENDED_TEXT_KEYS,
  DEFAULT_AMENDMENT_ORIGINAL_TEXT_KEYS,
  type AmendmentBasisViolation,
} from './amendment-basis.ts'
export {
  evidenceCheckAtom,
  EvidenceCheckHandler,
  DEFAULT_EVIDENCE_KEY,
  DEFAULT_EVIDENCE_DEADLINE_KEY,
  DEFAULT_EVIDENCE_REFERENCE_DATE_KEY,
  DEFAULT_EVIDENCE_FILING_DATE_KEY,
  DEFAULT_EVIDENCE_PRIORITY_DATE_KEY,
  type EvidenceCheckSeverity,
  type EvidenceCheckViolation,
  type EvidenceCheckPending,
} from './evidence-check.ts'
export {
  adversaryModelAtom,
  AdversaryModelHandler,
} from './adversary-model.ts'
export {
  adversaryReviewAtom,
  AdversaryReviewHandler,
} from './adversary-review.ts'
export {
  enablementReportAtom,
  EnablementReportHandler,
  type EnablementRecord,
  type EnablementResult,
} from './enablement-report.ts'
export {
  claimBreadthAtom,
  ClaimBreadthHandler,
  type ClaimBreadthDefect,
  type ClaimBreadthRecord,
  type ClaimBreadthResult,
} from './claim-breadth.ts'
