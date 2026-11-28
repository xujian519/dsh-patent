/**
 * src/atoms — Pipeline 原子操作 barrel。
 *
 * - atom.ts：Atom 声明式契约 + 注册表（纯声明，不参与执行）
 * - handler.ts：StageHandler 运行时 + PipelineState + 错误模型 + 注册表
 * - handlers/builtin/：34 个内置原子，按职责分域：
 *   search/keywords/extract/merge/compare/novelty/reasoning/groundedness/
 *   draft-claims/approval-gate/claim-chart 为模型或检索阶段；
 *   claim-strategy 为成文前的权利要求策略阶段（特征归属、锚点与从权树）；
 *   oa-parse/grounds/response-plan/coverage/pfe-consistency/citation-check/
 *   time-baseline/dispute-framing/dispute-framing-refine/prior-art-filter/
 *   conflicting-application/numeric-range/problem-check/amendment-basis/
 *   evidence-check 为不调用模型的确定性检查。
 *   adversary-model 为第一个 usesModel: true 的内置原子（对立审查员模型）。
 *   adversary-review 为换位重跑原子（评估最终意见陈述书）。
 *   enablement-report 为充分公开判定原子（独权特征逐条锚点复核）。
 *   claim-breadth 为概括范围判定原子（上位概括逐条锚点复核）。
 *   draft-review 为撰写链审查员回合（按类别回退到说明书、权利要求或策略阶段）。
 *   revision-ledger 为修订逐条对账（销账/仍存在/新增，不调用模型）。
 *   draft-quality-ledger 为稿件质量账本（五门判定矩阵与标量，不调用模型）。
 *   @deepseek-ai/dsh-patent-tools 另以插件 effect 注册 9 个包内原子：
 *   slop-gate、tighten、draft-specification、figure-analysis、spec-check、response-check、eligibility、legal-gaps、admissibility。
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
  DEGRADED_CODE_KEY,
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

// 只转发生成注册表之外仍有消费者的符号；其余原子与类型经
// `builtin` namespace 注册或由测试直接从源模块导入。
export {
  extractAtom,
  ExtractHandler,
  degraded,
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_NODES_KEY,
  APPROVAL_GRANTED_OUTPUT,
  ApprovalGateHandler,
  isApprovalGateHandler,
  isGateApproved,
  ClaimChartHandler,
  OaParseHandler,
  ResponsePlanHandler,
  type GroundProgram,
  AdversaryModelHandler,
  EnablementReportHandler,
  ClaimBreadthHandler,
} from './handlers/builtin/index.ts'

import { globalAtomRegistry } from './atom.ts'
import { globalStageHandlerRegistry } from './handler.ts'
import * as builtin from './handlers/builtin/index.ts'

/**
 * 将 34 个内置原子（契约 + 运行时）注册进全局注册表。幂等：同名覆盖。
 *
 * 随包的 8 个 manifest 引用其中 32 个；`compare` 与 `reasoning` 是通用扩展原子，
 * 供经 `ctx.patentWorkflow.runWorkflow` 传入自定义 manifest 的调用方使用。
 */
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
  globalAtomRegistry.register(builtin.claimStrategyAtom)
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
  globalAtomRegistry.register(builtin.claimBreadthAtom)
  globalAtomRegistry.register(builtin.draftReviewAtom)
  globalAtomRegistry.register(builtin.revisionLedgerAtom)
  globalAtomRegistry.register(builtin.draftQualityLedgerAtom)

  globalStageHandlerRegistry.register(new builtin.SearchHandler())
  globalStageHandlerRegistry.register(new builtin.ExtractHandler())
  globalStageHandlerRegistry.register(new builtin.CompareHandler())
  globalStageHandlerRegistry.register(new builtin.ReasoningHandler())
  globalStageHandlerRegistry.register(new builtin.GroundednessHandler())
  globalStageHandlerRegistry.register(new builtin.KeywordsHandler())
  globalStageHandlerRegistry.register(new builtin.NoveltyHandler())
  globalStageHandlerRegistry.register(new builtin.MergeHandler())
  globalStageHandlerRegistry.register(new builtin.DraftClaimsHandler())
  globalStageHandlerRegistry.register(new builtin.ClaimStrategyHandler())
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
  globalStageHandlerRegistry.register(new builtin.ClaimBreadthHandler())
  globalStageHandlerRegistry.register(new builtin.DraftReviewHandler())
  globalStageHandlerRegistry.register(new builtin.RevisionLedgerHandler())
  globalStageHandlerRegistry.register(new builtin.DraftQualityLedgerHandler())
}
