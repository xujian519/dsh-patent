/**
 * src/patent/graph — 图引擎 barrel。
 *
 * 导出契约（types）、状态工具（state）、降级标记（degradation）、
 * 确定性合并（merge）、节点策略（node-policy）、执行引擎（engine）、
 * 检查点（checkpoint）、适配层（adapter：handler/WorkflowManifest → 图）。
 * 领域子图在阶段 3 追加（domains/）。
 */

export * from './types.ts'
export { cloneState, getStateString, getStateArray } from './state.ts'
export {
  DEGRADATION_SUFFIX,
  markDegraded,
  absorbHandlerDegradation,
  isDegraded,
  getDegradationMark,
  degradationSummary,
} from './degradation.ts'
export { mergeWithSchema, GraphMergeError, type MergeSchema } from './merge.ts'
export { runNodeWithPolicy } from './node-policy.ts'
export { GraphBuilder, CompiledGraph, type CompiledGraphDef, type ResumePoint } from './engine.ts'
export {
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  runGraphWithCheckpoints,
  grantApproval,
  type CheckpointedRunOptions,
  type CheckpointedRunResult,
} from './checkpoint.ts'
export {
  runStageHandler,
  manifestToGraph,
  type ManifestToGraphDeps,
} from './adapter.ts'

export {
  buildNoveltyGraph,
  type BuildNoveltyGraphOptions,
  buildInventivenessGraph,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
  buildEnablementGraph,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
  PATENT_NUMBER_RE,
  buildCitationCheckGraph,
  checkCitations,
  extractCitationCheckResult,
  extractCitationIds,
  extractDocIds,
  type BuildCitationCheckGraphOptions,
  evaluateRuleGate,
  handlerNode,
  llmNode,
  requireRuleEvaluator,
  ruleGateNode,
  collectStateText,
  resolveInput,
  type LlmNodeOptions,
  type RuleGateOptions,
  type RuleGateState,
  DOMAIN_GRAPHS,
  type DomainGraphName,
} from './domains/index.ts'
