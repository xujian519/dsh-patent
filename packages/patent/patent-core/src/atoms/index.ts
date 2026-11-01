/**
 * src/atoms — Pipeline 原子操作 barrel。
 *
 * - atom.ts：Atom 声明式契约 + 注册表（纯声明，不参与执行）
 * - handler.ts：StageHandler 运行时 + PipelineState + 错误模型 + 注册表
 * - handlers/builtin/：29 个内置原子，按职责分域：
 *   search/keywords/extract/merge/compare/novelty/reasoning/groundedness/
 *   draft-claims/approval-gate/claim-chart 为模型或检索阶段；
 *   oa-parse/grounds/response-plan/coverage/pfe-consistency/citation-check/
 *   time-baseline/dispute-framing/dispute-framing-refine/prior-art-filter/
 *   conflicting-application/numeric-range/problem-check/amendment-basis/
 *   evidence-check 为不调用模型的确定性检查。
 *   adversary-model 为第一个 usesModel: true 的内置原子（对立审查员模型）。
 *   adversary-review 为换位重跑原子（评估最终意见陈述书）。
 *   enablement-report 为充分公开判定原子（独权特征逐条锚点复核）。
 *   @deepseek-ai/dsh-patent-tools 另以插件 effect 注册 6 个包内原子。
 *   @deepseek-ai/dsh-patent-law 以插件 effect 注册 rule-lock 原子。
 *
 * 使用：调用 registerBuiltinAtoms() 将内置原子注册进全局注册表；
 * workflow 执行时也可注入局部注册表（隔离测试 / 覆盖同名原子）。
 */

export {
  type Atom,
  type AtomCategory,
  AtomRegistry,
  AtomRegistryError,
  globalAtomRegistry,
  RegisterAtom,
  ListAtoms,
} from './atom.ts'

export {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  REVISION_SIGNALS_KEY,
  InterruptStageError,
  isInterruptStageError,
  StageCancelledError,
  isStageCancelledError,
  getStateString,
  getStateArray,
  StageHandlerRegistry,
  globalStageHandlerRegistry,
  LookupStageHandler,
} from './handler.ts'

export {
  searchAtom,
  SearchHandler,
  keywordsAtom,
  KeywordsHandler,
  extractAtom,
  ExtractHandler,
  mergeAtom,
  MergeHandler,
  compareAtom,
  CompareHandler,
  noveltyAtom,
  NoveltyHandler,
  evidenceCoverage,
  reasoningAtom,
  ReasoningHandler,
  groundednessAtom,
  GroundednessHandler,
  GROUNDEDNESS_THRESHOLD,
  draftClaimsAtom,
  DraftClaimsHandler,
  degraded,
  type DegradedOptions,
  approvalGateAtom,
  ApprovalGateHandler,
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_NODES_KEY,
  APPROVAL_GRANTED_OUTPUT,
  isApprovalGateHandler,
  isGateApproved,
  claimChartAtom,
  ClaimChartHandler,
  deriveOfficeActionTargets,
  oaParseAtom,
  OaParseHandler,
  groundsAtom,
  GroundsHandler,
  responsePlanAtom,
  ResponsePlanHandler,
  GROUND_PROGRAMS,
  type GroundProgram,
  coverageAtom,
  CoverageHandler,
  type PFETriple,
  type ProblemInsightEntry,
  pfeConsistencyAtom,
  PfeConsistencyHandler,
  PFE_CONSISTENCY_VIOLATION_IDS,
  checkPfeConsistency,
  type PfeConsistencyViolationId,
  type PfeConsistencyViolation,
  citationCheckAtom,
  CitationCheckHandler,
  DEFAULT_CITATION_REF_TEXT_KEYS,
  DEFAULT_CITATION_PRIOR_ART_KEY,
  timeBaselineAtom,
  TimeBaselineHandler,
  disputeFramingAtom,
  DisputeFramingHandler,
  disputeFramingRefineAtom,
  DisputeFramingRefineHandler,
  frameDispute,
  refineDispute,
  scanClaimNumbers,
  scanDisputeText,
  priorArtFilterAtom,
  PriorArtFilterHandler,
  A24_EXCEPTION_LABELS,
  type A24Exception,
  DEFAULT_PRIOR_ART_PUBLICATION_DATE_KEY,
  DEFAULT_PRIOR_ART_A24_EXCEPTION_KEY,
  conflictingApplicationAtom,
  ConflictingApplicationHandler,
  DEFAULT_CONFLICTING_APPLICATIONS_KEY,
  DEFAULT_TARGET_DATE_KEY,
  DEFAULT_TARGET_FILING_DATE_KEY,
  numericRangeAtom,
  NumericRangeHandler,
  DEFAULT_NUMERIC_RANGE_CLAIM_TEXT_KEYS,
  DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS,
  DEFAULT_NUMERIC_RANGE_PRIOR_ART_KEY,
  problemCheckAtom,
  ProblemCheckHandler,
  DEFAULT_PROBLEM_DIFF_TEXT_KEYS,
  DEFAULT_PROBLEM_FEATURE_KEYS,
  type ProblemCheckViolation,
  amendmentBasisAtom,
  AmendmentBasisHandler,
  DEFAULT_AMENDMENT_AMENDED_TEXT_KEYS,
  DEFAULT_AMENDMENT_ORIGINAL_TEXT_KEYS,
  type AmendmentBasisViolation,
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
  adversaryModelAtom,
  AdversaryModelHandler,
  adversaryReviewAtom,
  AdversaryReviewHandler,
  enablementReportAtom,
  EnablementReportHandler,
  type EnablementRecord,
  type EnablementResult,
} from './handlers/builtin/index.ts'

import { globalAtomRegistry } from './atom.ts'
import { globalStageHandlerRegistry } from './handler.ts'
import * as builtin from './handlers/builtin/index.ts'

/** 将 29 个内置原子（契约 + 运行时）注册进全局注册表。幂等：同名覆盖。 */
export function registerBuiltinAtoms(): void {
  globalAtomRegistry.register(builtin.searchAtom)
  globalAtomRegistry.register(builtin.extractAtom)
  globalAtomRegistry.register(builtin.compareAtom)
  globalAtomRegistry.register(builtin.reasoningAtom)
  globalAtomRegistry.register(builtin.groundednessAtom)
  globalAtomRegistry.register(builtin.keywordsAtom)
  globalAtomRegistry.register(builtin.noveltyAtom)
  globalAtomRegistry.register(builtin.mergeAtom)
  globalAtomRegistry.register(builtin.draftClaimsAtom)
  globalAtomRegistry.register(builtin.approvalGateAtom)
  globalAtomRegistry.register(builtin.claimChartAtom)
  globalAtomRegistry.register(builtin.oaParseAtom)
  globalAtomRegistry.register(builtin.groundsAtom)
  globalAtomRegistry.register(builtin.responsePlanAtom)
  globalAtomRegistry.register(builtin.coverageAtom)
  globalAtomRegistry.register(builtin.pfeConsistencyAtom)
  globalAtomRegistry.register(builtin.citationCheckAtom)
  globalAtomRegistry.register(builtin.timeBaselineAtom)
  globalAtomRegistry.register(builtin.disputeFramingAtom)
  globalAtomRegistry.register(builtin.disputeFramingRefineAtom)
  globalAtomRegistry.register(builtin.priorArtFilterAtom)
  globalAtomRegistry.register(builtin.conflictingApplicationAtom)
  globalAtomRegistry.register(builtin.numericRangeAtom)
  globalAtomRegistry.register(builtin.problemCheckAtom)
  globalAtomRegistry.register(builtin.amendmentBasisAtom)
  globalAtomRegistry.register(builtin.evidenceCheckAtom)
  globalAtomRegistry.register(builtin.adversaryModelAtom)
  globalAtomRegistry.register(builtin.adversaryReviewAtom)
  globalAtomRegistry.register(builtin.enablementReportAtom)

  globalStageHandlerRegistry.register(new builtin.SearchHandler())
  globalStageHandlerRegistry.register(new builtin.ExtractHandler())
  globalStageHandlerRegistry.register(new builtin.CompareHandler())
  globalStageHandlerRegistry.register(new builtin.ReasoningHandler())
  globalStageHandlerRegistry.register(new builtin.GroundednessHandler())
  globalStageHandlerRegistry.register(new builtin.KeywordsHandler())
  globalStageHandlerRegistry.register(new builtin.NoveltyHandler())
  globalStageHandlerRegistry.register(new builtin.MergeHandler())
  globalStageHandlerRegistry.register(new builtin.DraftClaimsHandler())
  globalStageHandlerRegistry.register(new builtin.ApprovalGateHandler())
  globalStageHandlerRegistry.register(new builtin.ClaimChartHandler())
  globalStageHandlerRegistry.register(new builtin.OaParseHandler())
  globalStageHandlerRegistry.register(new builtin.GroundsHandler())
  globalStageHandlerRegistry.register(new builtin.ResponsePlanHandler())
  globalStageHandlerRegistry.register(new builtin.CoverageHandler())
  globalStageHandlerRegistry.register(new builtin.PfeConsistencyHandler())
  globalStageHandlerRegistry.register(new builtin.CitationCheckHandler())
  globalStageHandlerRegistry.register(new builtin.TimeBaselineHandler())
  globalStageHandlerRegistry.register(new builtin.DisputeFramingHandler())
  globalStageHandlerRegistry.register(new builtin.DisputeFramingRefineHandler())
  globalStageHandlerRegistry.register(new builtin.PriorArtFilterHandler())
  globalStageHandlerRegistry.register(new builtin.ConflictingApplicationHandler())
  globalStageHandlerRegistry.register(new builtin.NumericRangeHandler())
  globalStageHandlerRegistry.register(new builtin.ProblemCheckHandler())
  globalStageHandlerRegistry.register(new builtin.AmendmentBasisHandler())
  globalStageHandlerRegistry.register(new builtin.EvidenceCheckHandler())
  globalStageHandlerRegistry.register(new builtin.AdversaryModelHandler())
  globalStageHandlerRegistry.register(new builtin.AdversaryReviewHandler())
  globalStageHandlerRegistry.register(new builtin.EnablementReportHandler())
}
