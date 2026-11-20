/**
 * Pure TypeScript library (no ctx dependency) holding the patent-domain engines
 * ported from Sati: the atoms StageProvider/StageHandler vocabulary, the
 * ModelPort LLM adapter, the constitutional rule protocol types + text
 * utilities, the dual-track checker rule engine, the problem atomization
 * checks, the evidence closed-loop ledger/engine, the structured reasoning
 * primitives, the claim-chart engine, the claim-drafting self-checks (claim unity
 * and the claim-to-embodiment coverage matrix), the quote-anchor verifier for
 * model-authored specification excerpts, the controlled draft model
 * (SpecDraft/TemplateDraft) with its validators for the patent deliverable tools,
 * the IPC classifier/standards
 * lookup, and the persistence/path helpers.
 * @module @deepseek-ai/dsh-patent-core
 */

// Patent-domain model port contract + adapter.
export type {
  PatentModelEvent,
  PatentModelPort,
  PatentModelRequest,
  PatentModelUsage,
  StageProvider,
} from './types.ts'
export { collectPortText, createLlmModelPort } from './model-port.ts'

// LLM JSON tolerant parsing + the shared JSON-value narrowing guards.
export {
  asJsonArray,
  asJsonRecord,
  isJsonRecord,
  isNonEmptyStringArray,
  isNonNegativeInteger,
  readJsonNumber,
  readJsonString,
  readNonEmptyString,
  readOptionalNonEmptyString,
  tryParseJson,
} from './llm-json.ts'

// Controlled draft model + validation: the model submits structured drafts
// (no HTML); converters generate headings and tables from the structure.
export {
  SPEC_DRAFT_SCHEMA,
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  TEMPLATE_DRAFT_SCHEMA,
  formatTableCaption,
  numberedFigureDescriptions,
  validateSpecDraft,
  validateTemplateDraft,
} from './draft/index.ts'
export type {
  DraftBlock,
  DraftGroundItem,
  SpecDraft,
  TemplateDraft,
  TemplateDraftSchema,
  TemplateDraftSection,
  TemplateFieldSlot,
  TemplateSectionSlot,
} from './draft/index.ts'

// Prompt-injection isolation for untrusted text spliced into LLM prompts.
export { dataBlock } from './prompt-hygiene.ts'

// Constitutional rule engine protocol types + text utilities.
export type {
  CitationAnalysisCheck,
  ConstitutionalRule,
  EmptySectionCheck,
  KeywordBlocklistCheck,
  LoadedRuleSet,
  PatternAnalysisCheck,
  QuoteRepetitionCheck,
  RuleAction,
  RuleCheck,
  RuleCheckType,
  RuleEvaluation,
  RuleOutputGate,
  RuleOutputGateResult,
  RuleSet,
  RuleSetValidationIssue,
  RuleSeverity,
  RuleViolation,
  SentenceRepetitionCheck,
  StructuralAnalysisCheck,
  SynonymRequirement,
} from './rule/types.ts'
export {
  hasNegationContext,
  locateMatch,
  locationAt,
  runeSlice,
} from './rule/text-utils.ts'

// Statute-citation machinery lives in dsh-law-core. This entry re-exports only
// the names a patent package imports.
export {
  articleCitationFocus,
  CITATION_FINDING_DECISION_PROPERTIES,
  citationFindingSchema,
  citationInputProblem,
  citationReportLines,
  citationVerifyReport,
  citationVerifyToolOptions,
  countCitationDecisions,
  collectReferences,
  createOverlapIndex,
  decideArticleCitation,
  findCompetingEntries,
  formatArticleCitation,
  formatCnNumber,
  formatPercent,
  missingIndexReason,
  narrowed,
  normalizeCitationText,
  parseCnNumber,
  PROPOSITION_SUPPORT_DEFAULT,
  readArticleContinuations,
  readStatuteArticleCandidate,
  renderCitationDecisionRows,
  resolveCitationDecisionPolicy,
  scanUnrecognizedReferences,
  stripBookMarks,
  supportMismatchReason,
  textOverlap,
  topicOverlap,
  transcribedText,
  trimPunctuation,
  truncateProposition,
} from '@deepseek-ai/dsh-law-core'
export type {
  ComparableEntry,
  DecisionArticle,
  OverlapIndex,
} from '@deepseek-ai/dsh-law-core'

// Atoms: the StageProvider/StageHandler vocabulary and the builtin handlers.
export type {
  Atom,
  AtomCategory,
  PipelineState,
  StageExecuteInput,
  StageHandler,
  GroundProgram,
} from './atoms/index.ts'
export {
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_OUTPUT,
  ApprovalGateHandler,
  AtomRegistry,
  ClaimChartHandler,
  DEGRADED_CODE_KEY,
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  REVISION_SIGNALS_KEY,
  ExtractHandler,
  InterruptStageError,
  LookupStageHandler,
  StageCancelledError,
  StageHandlerRegistry,
  EnablementReportHandler,
  ClaimBreadthHandler,
  AdversaryModelHandler,
  OaParseHandler,
  ResponsePlanHandler,
  degraded,
  extractAtom,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  isApprovalGateHandler,
  isInterruptStageError,
  isStageCancelledError,
  registerBuiltinAtoms,
} from './atoms/index.ts'

// LLM stage helpers: the provider check / call / JSON-fallback skeleton shared by
// every model-backed handler. Exported so a downstream package (e.g. patent-tools'
// `tighten`) can implement a model stage with the same cancel and retry semantics
// instead of re-deriving them.
export { callLlm, parseLlmJson, requireLlm } from './atoms/handlers/builtin/llm.ts'

// Claim-chart engine (element validation / mapping / gap / pin-cite / store).
export type {
  InvalidityConclusion,
  ChartMode,
  ChartTarget,
  ClaimChart,
  // patent-tools invalidity JSON readback consumes these protocol types.
  ClaimAlternative,
  ClaimNoveltyCoverage,
  ClaimRefIssue,
  DependentClaimPathIssue,
} from './claim-chart/index.ts'
export {
  deriveClaimRefs,
  renderInvalidityConclusion,
  splitClaimSegments,
} from './claim-chart/index.ts'

// Claim-drafting self-checks: claim unity (A31.1) and the claim-to-embodiment coverage matrix.
export type { UnityClaim } from './claim-coverage/index.ts'
export {
  checkClaimUnity,
  checkEmbodimentCoverage,
} from './claim-coverage/index.ts'

// Deterministic claim drafting: feature table → independent claim → dependent
// tree, plus formal validation. Shared by the workflow atom and the tool layer.
export type {
  TechDomain,
  PatentType,
  DependentClaimNode,
  DraftClaimsInput,
  DraftedClaim,
  ClaimViolation,
  DraftClaimsOutput,
} from './claim-draft/index.ts'
export {
  CLAIM_SOURCE_EXCLUSIVE_MESSAGE,
  DOMAIN_KEYWORDS,
  PARENT_SCHEMA,
  draftClaims,
  renderParents,
  resolveDomain,
  validateClaims,
} from './claim-draft/index.ts'

// Claim-set formal lint: numbering, references, antecedent basis, subject names, wording.
export type {
  ClaimLintFinding,
  ClaimLintReport,
} from './claim-lint/index.ts'
export {
  lintClaimText,
  parseClaimDocument,
} from './claim-lint/index.ts'

// Quote anchoring: model-authored specification excerpts must occur in the
// source; the result carries the hit interval in original-text coordinates.
export { locateQuote } from './anchor/index.ts'
export type { AnchorReason } from './anchor/index.ts'

// Adversary model + review: opposing-examiner evaluation of plans and final drafts.
// Runtime values re-export only through the barrel so the duplication gate does not
// see a parallel list against adversary/index.ts.
export type { AdversaryDispute } from './adversary/index.ts'
export {
  GROUND_TO_STATUTE,
} from './adversary/index.ts'

// Draft-chain review: examiner-perspective disputes over the drafted specification
// and claims, with strict quote anchoring and per-category rewind routes.

// Patent analysis product contract + deterministic aggregator (Athena-inspired report).
export type {
  PatentAnalysisReport,
  QualityDomain,
  SearchStrategy,
} from './analysis-report/index.ts'
export {
  buildAnalysisReport,
} from './analysis-report/index.ts'

// Dual-track deterministic checker (novelty/inventiveness/infringement/...).
export type {
  CheckRule,
  RuleCheckResult,
  RuleEvaluator,
} from './checker/index.ts'
export {
  DIM_CLARITY,
  DIM_CONSISTENCY,
  DIM_ESSENTIAL,
  DIM_SUPPORT,
  DOMAIN_AMENDMENT,
  DOMAIN_CLAIMS,
  DOMAIN_DESIGN,
  DOMAIN_DISCLOSURE,
  DOMAIN_EXAMINATION,
  DOMAIN_INFRINGEMENT,
  DOMAIN_INVALIDATION,
  DOMAIN_INVENTIVENESS,
  DOMAIN_NOVELTY,
  DOMAIN_REEXAMINATION,
  DOMAIN_SPEC,
  LevelMust,
  LevelQuality,
  LevelShould,
  RuleEngine,
  SPEC_COMMERCIAL_BAN_PHRASES,
  SPEC_SCOPE_BAN_PHRASES,
  SPEC_SECTION_TERMS,
  TERM_CAN_USE,
  TERM_CLOSEST_PRIOR_ART,
  TERM_CLOSEST_PRIOR_ART_FULL,
  TERM_COMBINATION_HINT,
  TERM_COMBINATION_MOTIVATION,
  TERM_COMMON_KNOWLEDGE,
  TERM_DESIGN_PATENT,
  TERM_DIFF_FEATURES,
  TERM_DISTINGUISHING_FEATURES,
  TERM_ENABLE,
  TERM_ENABLEMENT,
  TERM_EXP_DATA,
  TERM_FILING_DATE,
  TERM_FUNCTIONAL_LIMIT,
  TERM_INTERNET_DISCLOSURE,
  TERM_INVENTIVENESS,
  TERM_MENTAL_ACTIVITY,
  TERM_NATURAL_LAW,
  TERM_NOVELTY,
  TERM_OBVIOUS,
  TERM_OVERALL_VISUAL,
  TERM_PERSON_SKILLED,
  TERM_PRIORITY,
  TERM_PRIORITY_DATE,
  TERM_PRIOR_ART,
  TERM_PRIOR_ART_DOC,
  TERM_PRODUCT_CATEGORY,
  TERM_PROTECTION_SCOPE,
  TERM_SCI_DISCOVERY,
  TERM_SUFFICIENT_DISCLOSURE,
  TERM_TECH_EFFECT,
  TERM_TECH_FEATURE,
  TERM_TECH_HINT,
  TERM_TECH_SOLUTION,
  TERM_USE_LIMIT,
  aggregate,
  matchKeyword,
} from './checker/index.ts'

// Atomic technical-problem checks (creative-analysis three-step step 2).
export {
  technicalProblemCheck,
} from './problem/index.ts'

// TRIZ contradiction analysis for the inventor side: disclosure gaps and
// candidate solution directions. Never a three-step-step-2 problem statement.
export type { TrizContradictionAnalysis } from './triz/index.ts'
export {
  buildTrizAnalysis,
  extractTrizContradictions,
} from './triz/index.ts'

// Evidence closed-loop: receipt ledger, spans, binding, conflict, judgment engine.
export type {
  EvidenceDirection,
  WorkflowEvidenceLedger,
  WorkflowEvidenceReceipt,
  EvidenceExternalInputs,
  EvidenceType,
} from './evidence/index.ts'
export {
  EvidenceEngine,
  buildWorkflowEvidenceLedger,
  contentHash,
  createSpan,
  isMonthOnlyDate,
  isWorkflowEvidenceSource,
  loadEvidenceRulesEngine,
  parseDateFlexible,
} from './evidence/index.ts'

// Structured reasoning primitives: fact blackboard + syllogism.
export type { ArticleJudgment } from './reasoning/index.ts'
export {
  FactBlackboard,
} from './reasoning/index.ts'

// Persistence + path helpers (single home). dsh-patent-data re-exports the four
// symbols its historical public surface carried (JsonFileStore, SAFE_ID_PATTERN,
// assertSafeId, atomicWriteJson); everything else is imported from here.
export {
  JsonFileStore,
  SAFE_ID_PATTERN,
  StoredRecordError,
  assertSafeId,
  atomicWriteJson,
  parseStoredJsonRecord,
} from './persist-utils.ts'

// Safety-name checks for path segments and deliverable file stems (single home).
export { assertDeliverableName, assertPathSegment } from './safe-path.ts'

export {
  CASE_OUTPUTS_REL,
  CASE_ROOT_REL,
  CASE_WORKFLOW_RUNS_REL,
  caseOutputsDir,
  caseWorkflowRunsDir,
  resolveConfinedPath,
  resolvePatentOutputDir,
} from './paths.ts'

// Subprocess deadline shared by the domain's four spawn sites.
export { startSpawnDeadline } from './subprocess-deadline.ts'
export type { SpawnDeadline } from './subprocess-deadline.ts'

// Shared conventions of the two PDF download tools (body verification + dated output dir).
export {
  inspectPdfBody,
  isHtmlContentType,
  resolveDatedOutputDir,
} from './pdf-download.ts'
export type { PdfBodyFault } from './pdf-download.ts'

// IPC classification + examination-standard lookup.
export {
  DEFAULT_IPC_CONFIDENCE,
  DEFAULT_IPC_SECTION,
  HIGH_CONFIDENCE_THRESHOLD,
  IPC_DETAIL_DOMAINS,
  IPC_DETAIL_MIN_CONFIDENCE,
  IPC_DOMAINS,
  classifyIpc,
  classifyIpcTop,
  getIpcDomain,
  isHighConfidence,
} from './ipc/ipc-classifier.ts'
export type { IpcDetailDomainMeta, IpcDomainMeta } from './ipc/ipc-classifier.ts'
export {
  formatStandardsAsContext,
  loadIpcStandards,
  queryByArticle,
  queryIpcDetail,
  queryIpcStandards,
  searchStandards,
} from './ipc/ipc-standards-loader.ts'
export type { IpcStandardsIndex } from './ipc/ipc-standards-loader.ts'
export type { IpcClassification, IpcStandardCard } from './ipc/types.ts'
// Graph engine (Pregel-style superstep) + the three patentability subgraphs.
export type {
  ManifestToGraphDeps,
  RuleGateState,
  DomainGraphName,
  GraphState,
  GraphCheckpoint,
  CheckpointStore,
} from './graph/index.ts'
export {
  CompiledGraph,
  DOMAIN_GRAPHS,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  grantApproval,
  manifestToGraph,
  ruleGateNode,
  runGraphWithCheckpoints,
} from './graph/index.ts'

// Deterministic numeric-range novelty check, run beside the LLM semantic track.
export {
  NUMERIC_RANGE_SEPARATOR_CLASS,
  NUMERIC_UNIT_ALTERNATION,
  extractNumericFindings,
  normalizeNumericUnit,
} from './novelty/index.ts'

// Deterministic parsers for procedure documents (office action, invalidation /
// reexamination / design grounds).
export type {
  NoticeRejectionGround,
  ParsedOfficeAction,
} from './notice/index.ts'
export {
  REJECTION_ORDER,
  REJECTION_SHORT_LABELS,
  formatOfficeActionSummary,
  parseOfficeAction,
} from './notice/index.ts'

// Deterministic infringement kernel: all-elements coverage, equivalence
// consistency, weighted risk grading.
export type {
  InfringementConclusionInput,
  AllElementsOutcome,
  EquivalenceContradictionKind,
  EquivalenceTriplet,
  DefenseViability,
} from './infringement/index.ts'
export {
  deriveInfringementConclusion,
} from './infringement/index.ts'

// The atoms barrel and the graph barrel both export these readers. This entry
// publishes the atoms copies.
export { getStateString, getStateArray } from './atoms/handler.ts'

// Stage-state text and key-list readers: the single home for how a handler reads
// another stage's text. Packages that register their own atoms import these
// instead of restating the semantics.
export {
  readStateText,
  resolveKeyList,
  resolveTrimmedKey,
} from './atoms/handlers/builtin/state-keys.ts'

// Knowledge-search primitives live in dsh-knowledge-core. This entry re-exports
// only resolveResultLimit, the helper a patent package imports.
export {
  resolveResultLimit,
} from '@deepseek-ai/dsh-knowledge-core'

// Workflow manifest contract, pre-positioned so the graph adapter (manifestToGraph)
// has no dependency on the P3.1 workflow executor. The runWorkflow executor and
// builtin manifests land in dsh-patent-workflow and re-import these from here.
export { validateWorkflowManifest } from './workflow/manifest.ts'
export { parseConsumeRef } from './workflow/consume-ref.ts'
export { countWorkflowLlmStages, validateWorkflowBudget } from './workflow/budget.ts'
export { compileSignal, digestText, parseRetrySignals, signalMatches } from './workflow/signal.ts'
export { clearStageOutputs } from './workflow/stage-outputs.ts'
export { WorkflowError, isWorkflowStrategy } from './workflow/types.ts'
export { validateRevisionLog } from './workflow/revision-log.ts'
export type {
  RetrySignal,
  RevisionRecord,
  StageExecutor,
  WorkflowContext,
  WorkflowInterrupt,
  WorkflowManifest,
  WorkflowRunOptions,
  WorkflowRunRecovery,
  WorkflowRunResult,
  WorkflowRunStore,
  WorkflowStage,
  WorkflowStageResult,
  WorkflowStrategy,
} from './workflow/types.ts'
