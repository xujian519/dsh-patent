/**
 * Function plugin registering the 36 model-facing patent tools ported from Sati:
 * search, metadata, legal status, case/wiki/kg knowledge queries, claim-chart,
 * office-action parsing, drafting, specification validation, evidence judgment,
 * rule check, claim-set lint, figure analysis + generation, PDF download, chemical recognition,
 * knowledge notes, the workflow/plan state machines, and the personal-workbench
 * case bridge. `render_patent_document` is owned by
 * @deepseek-ai/dsh-patent-document (its apply() registers it); this package
 * re-exports its factory but does not register it.
 * @module @deepseek-ai/dsh-patent-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { registerPatentTools } from './wiring.ts'

// ---- public library surface (factories + error + render_patent_document) ----
export { PatentToolError } from './error.ts'
export type { PatentToolErrorCode } from './error.ts'
export { checkImageCapability, resolveImageInputModalities } from './figure/image-capability.ts'
export type { ImageCapabilityDecision, ModelInfoQuery } from './figure/image-capability.ts'
export { createPatentSearchTool, baseNumber, dedupeByFamily } from './tool/patent-search.ts'
export type { PatentSearchInput, PatentSearchOutput, PatentSearchHitItem, PatentSearchDeps, CniprSearchLookup } from './tool/patent-search.ts'
export { createPatentMetadataTool } from './tool/patent-metadata.ts'
export type { PatentMetadataInput, PatentMetadataOutput, PatentMetadataDeps, CniprMetadataLookup } from './tool/patent-metadata.ts'
export { createPatentLegalStatusTool } from './tool/patent-legal-status.ts'
export type { PatentLegalStatusInput, PatentLegalStatusOutput, PatentLegalStatusItem, PatentLegalStatusDeps, CniprLegalStatusLookup } from './tool/patent-legal-status.ts'
export { createPatentCaseSearchTool } from './tool/patent-case-search.ts'
export { createLawSearchTool } from './tool/law-search.ts'
export type { LawSearchInput, LawSearchOutput, LawSearchScope, LawSearchDeps } from './tool/law-search.ts'
export type { PatentCaseSearchInput, PatentCaseSearchOutput, PatentCaseSearchDeps } from './tool/patent-case-search.ts'
export { createPatentWikiSearchTool, PATENT_WIKI_DIRS } from './tool/patent-wiki-search.ts'
export type { PatentWikiSearchInput, PatentWikiSearchOutput, PatentWikiSearchDeps, PatentWikiDir } from './tool/patent-wiki-search.ts'
export { createPatentKgQueryTool } from './tool/patent-kg-query.ts'
export type { PatentKgQueryInput, PatentKgQueryOutput, PatentKgHit, PatentKgNeighbor, PatentKgQueryDeps, KgAdapter } from './tool/patent-kg-query.ts'
export { createPatentEvalTool, evaluatePatentContent } from './tool/patent-eval.ts'
export type { PatentEvalInput, PatentEvalOutput, PatentEvalMode, PatentEvalDimension } from './tool/patent-eval.ts'
export { createPatentAnalysisReportTool } from './tool/patent-analysis-report.ts'
export type { PatentAnalysisReportInput, PatentAnalysisReportOutput, PatentAnalysisReportDeps } from './tool/patent-analysis-report.ts'
export { createClaimChartBuildTool } from './tool/claim-chart-build.ts'
export type { ClaimChartInput, ClaimChartOutput, ClaimChartTargetInput, ClaimChartBuildDeps } from './tool/claim-chart-build.ts'
export { createTrizContradictionAnalysisTool, renderTrizContradictionAnalysis } from './tool/triz-contradiction-analysis.ts'
export type { TrizContradictionAnalysisInput, TrizContradictionAnalysisDeps } from './tool/triz-contradiction-analysis.ts'
export { createParseOfficeActionTool } from './tool/parse-office-action.ts'
export type { ParseOfficeActionInput, ParseOfficeActionOutput } from './tool/parse-office-action.ts'
export { createDraftClaimsTool, draftClaims, DOMAIN_KEYWORDS } from './tool/draft-claims.ts'
export type { DraftClaimsInput, DraftClaimsOutput, DraftedClaim, ClaimViolation, TechDomain, PatentType } from './tool/draft-claims.ts'
export { createDraftSpecificationTool, draftSpecification } from './tool/draft-specification.ts'
export type { DraftSpecificationInput, DraftSpecificationOutput, SpecificationSection } from './tool/draft-specification.ts'
export { createValidateSpecificationTool } from './tool/validate-specification.ts'
export type { ValidateSpecificationInput, ValidateSpecificationOutput, ValidateSpecificationDeps } from './tool/spec-types.ts'
export { createEvaluateEvidenceTool } from './tool/evaluate-evidence.ts'
export type { EvaluateEvidenceInput, EvaluateEvidenceOutput, EvaluateEvidenceDeps } from './tool/evaluate-evidence.ts'
export { createRuleCheckTool } from './tool/rule-check.ts'
export type { RuleCheckInput, RuleCheckOutput, RuleViolationView, RuleCheckDeps } from './tool/rule-check.ts'
export { createClaimLintTool } from './tool/claim-lint.ts'
export type { ClaimLintFindingOutput, ClaimLintOutput } from './tool/claim-lint.ts'
export { createAnalyzePatentFigureTool, FIGURE_SPEC_GUIDE, resolveGateRoute } from './tool/analyze-patent-figure.ts'
export type { AnalyzePatentFigureInput, AnalyzePatentFigureDeps, FigureAnalysisResult, FigureComponent, FigureType } from './tool/analyze-patent-figure.ts'
export { createSearchPatentFigureTool, tokenizeFigureText } from './tool/search-patent-figure.ts'
export type { SearchPatentFigureInput, SearchPatentFigureOutput, SearchPatentFigureDeps } from './tool/search-patent-figure.ts'
export { createComparePatentFigureAnalysisTool } from './tool/compare-patent-figure-analysis.ts'
export type { ComparePatentFigureAnalysisInput } from './tool/compare-patent-figure-analysis.ts'
export { compareFigureAnalysis } from './figure/figure-comparison.ts'
export type { FigureComparisonFinding, FigureComparisonInput, FigureComparisonReport, FigureMark } from './figure/figure-comparison.ts'
export { createCheckPatentFigureConsistencyTool } from './tool/check-patent-figure-consistency.ts'
export type { CheckPatentFigureConsistencyInput } from './tool/check-patent-figure-consistency.ts'
export { checkFigureSetConsistency, extractClaimNumeralRefs, hasNumeralPrefix } from './figure/figure-set-consistency.ts'
export type { FigureSetEntry, FigureSetConflict, FigureSetReport } from './figure/figure-set-consistency.ts'
export { createGeneratePatentFigureTool } from './tool/generate-patent-figure.ts'
export { FIGURE_GENERATOR_MODEL_USED } from './tool/figure-input.ts'
export { expandSectionSource, SectionSourceError, SECTION_SOURCE_SIZE_TOLERANCE } from './figure/section-source.ts'
export type { SectionSourcePorts, SectionSourceOptions, SectionSourceExpansion, SectionSourceErrorCode } from './figure/section-source.ts'
export { createGenerateStructureFigureTool, STRUCTURE_FIGURE_MODEL_USED } from './tool/generate-structure-figure.ts'
export type {
  GenerateStructureFigureInput,
  GenerateStructureFigureOutput,
  GenerateStructureFigureDeps,
  StructureCalloutInput,
  StructureFigureView,
  StructureManifest,
  StructureManifestView,
  StructureManifestAnchor,
} from './tool/generate-structure-figure.ts'
export { findFreeCadCmd, probeFreeCad, renderStructureViews, freecadInstallMessage, FREECAD_CMD_CANDIDATES } from './figure/freecad-renderer.ts'
export type {
  FreeCadProbeResult,
  FreeCadProbeOptions,
  FreeCadRenderOptions,
  StructureRenderOutcome,
  StructureRenderSpec,
  StructureRenderErrorCode,
} from './figure/freecad-renderer.ts'
export { DEFAULT_FREECAD_RENDER_TIMEOUT_MS, DEFAULT_FREECAD_PROBE_TIMEOUT_MS } from './figure/freecad-renderer.ts'
export {
  buildStructureScript,
  STRUCTURE_VIEWS,
  DEFAULT_STRUCTURE_VIEWS,
  STRUCTURE_VIEW_DIRECTIONS,
  structureSvgFilename,
  STRUCTURE_MANIFEST_FILENAME,
} from './figure/freecad-structure-script.ts'
export type { StructureViewName, StructureCallout, StructureScriptParams } from './figure/freecad-structure-script.ts'
export type {
  GeneratePatentFigureInput,
  GeneratePatentFigureOutput,
  GeneratePatentFigureDeps,
  GeneratePatentFigureIndexEntry,
  GenerateFigureType,
  GeneratePatentFigurePanelInput,
  GeneratePatentFigurePanelOutput,
} from './tool/figure-input.ts'
export { createAddPatentFigureReferencesTool } from './tool/add-patent-figure-references.ts'
export { createVerifyPatentFigureTool } from './tool/verify-patent-figure.ts'
export type { VerifyPatentFigureInput, VerifyPatentFigureOutput, VerifyPatentFigureDeps } from './tool/verify-patent-figure.ts'
export { checkFigureRendering } from './figure/render-check.ts'
export type { RenderCheckFinding, RenderCheckKind, RenderCheckReport } from './figure/render-check.ts'
export type { AddPatentFigureReferencesInput, AddPatentFigureReferencesOutput, AddPatentFigureReferencesDeps } from './tool/add-patent-figure-references.ts'
export { figureIndexStore, FIGURE_INDEX_VERSION, DEFAULT_FIGURE_INDEX_RELATIVE_PATH } from './figure/index-store.ts'
export type { FigureIndexEntry, LoadFigureIndexResult } from './figure/index-store.ts'
export { findDot, probeGraphviz, renderWithGraphviz, sanitizeDotFilename, graphvizInstallMessage, DOT_CANDIDATES } from './figure/graphviz-renderer.ts'
export { findInkscape, outlineSvgText, exportWithInkscape, inkscapeInstallMessage, INKSCAPE_CANDIDATES, DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS } from './figure/inkscape-renderer.ts'
export type { ExportFigurePort, InkscapeExportFormat, InkscapeExportSpec, InkscapeOutlineOutcome, InkscapeOutlineSpec } from './figure/inkscape-renderer.ts'
export { createTwoStepAnalysisEngine } from './figure/analysis-engine.ts'
export type { FigureAnalysisEngine, FigureAnalysisRequest } from './figure/analysis-engine.ts'
export type {
  GraphvizProbeResult,
  GraphvizProbeOptions,
  GraphvizRenderOptions,
  GraphvizRenderOutcome,
  GraphvizRenderSpec,
  GraphvizRenderErrorCode,
} from './figure/graphviz-renderer.ts'
export { DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS, DEFAULT_GRAPHVIZ_PROBE_TIMEOUT_MS } from './figure/graphviz-renderer.ts'
export { renderWithVizWasm, vizLoadFailureMessage } from './figure/viz-wasm-renderer.ts'
export { pickRenderer } from './figure/render-selector.ts'
export type { FigureRendererMode } from './figure/render-selector.ts'
export { chemistryIndexStore, CHEMISTRY_INDEX_VERSION, DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH } from './chemistry/index-store.ts'
export type { ChemistryIndexEntry } from './chemistry/index-store.ts'
export { createPatentPdfDownloadTool } from './tool/patent-pdf-download.ts'
export type { PatentPdfDownloadInput, PatentPdfDownloadOutput, PatentPdfDownloadDeps, RunEgo, EgoDownloadItem, EgoDownloadRequest, EgoDownloadResult } from './tool/patent-pdf-download.ts'
export type { EgoSessionSeam } from './tool/patent-pdf-download-ego.ts'
export { createDownloadChannelRunner, createScrapeChannelRunner } from './tool/patent-pdf-download-channel.ts'
export type { DownloadChannelDeps, PatentDataLookup, PatentDataSeam, PatentScrape } from './tool/patent-pdf-download-channel.ts'
export { createRecognizeChemicalStructureTool, resolveChemicalSourceKey } from './tool/recognize-chemical-structure.ts'
export type { RecognizeChemicalStructureInput, RecognizeChemicalStructureDeps, ChemicalStructureResult, ChemicalSmilesCandidate } from './tool/recognize-chemical-structure.ts'
export { createFlexiblePlanTool, ATOM_PARAM_DESCRIPTION } from './tool/patent-flexible-plan.ts'
export type { FlexiblePlanToolInput, FlexiblePlanOutput, FlexiblePlanToolDeps, FlexiblePlanAction, FlexiblePlanStageInput } from './tool/patent-flexible-plan.ts'
export { createPatentWorkflowTool } from './tool/patent-workflow.ts'
export type { PatentWorkflowInput, PatentWorkflowOutput, PatentWorkflowToolDeps } from './tool/patent-workflow.ts'
export { createPatentWorkflowRunTool } from './tool/patent-workflow-run.ts'
export type { PatentWorkflowRunInput, PatentWorkflowRunOutput, PatentWorkflowRunDeps, PatentWorkflowRunGraph } from './tool/patent-workflow-run.ts'
export { createPatentPlanTaskTool } from './tool/patent-plan-task.ts'
export {
  createWorkbenchLinkPatentCaseTool,
  parseMatterLogStages,
  PATENT_TYPE_DICTIONARIES,
  STAGE_NAME,
  STAGE_TYPE_CODE,
  WORKBENCH_STAGES,
} from './tool/workbench-link-patent-case.ts'
export type {
  WorkbenchLinkPatentCaseDeps,
  WorkbenchLinkPatentCaseInput,
  WorkbenchLinkPatentCaseOutput,
  WorkbenchStage,
  WorkbenchTaskStatusCode,
} from './tool/workbench-link-patent-case.ts'
export type { PatentPlanTaskInput, PatentPlanTaskOutput, PatentPlanTaskAction } from './tool/patent-plan-task.ts'
export { createPatentWorkerValidateTool } from './tool/patent-worker-validate.ts'
export type { PatentWorkerValidateInput, PatentWorkerValidateOutput } from './tool/patent-worker-validate.ts'
export { createKnowledgeNoteSaveTool } from './tool/knowledge-note-save.ts'
export type { KnowledgeNoteSaveInput, KnowledgeNoteSaveOutput, KnowledgeNoteSaveDeps, KnowledgeNote } from './tool/knowledge-note-save.ts'
export { createNoteFileWriter } from './tool/knowledge-note-file-writer.ts'
export {
  createMatterLogAppendTool,
  matterLogDefects,
  matterStamps,
  parseMatterEntries,
  renderMatterEntry,
  MATTER_ACTIONS,
  MATTER_LOG_FILE,
} from './tool/matter-log-append.ts'
export type {
  MatterAction,
  MatterLogAppendResult,
  MatterLogDefect,
  MatterLogEntry,
  MatterLogRequest,
} from './tool/matter-log-append.ts'
export { slopGateAtom, SlopGateHandler, SLOP_GATE_PASS_THRESHOLD } from './atoms/slop-gate.ts'
export {
  tightenAtom,
  TightenHandler,
  DEFAULT_TIGHTEN_PLAN_KEY,
  DEFAULT_TIGHTEN_TEXT_KEY,
} from './atoms/tighten.ts'
export { draftSpecificationAtom, DraftSpecificationHandler } from './atoms/draft-specification.ts'
export { figureAnalysisAtom, FigureAnalysisHandler } from './atoms/figure-analysis.ts'
export { specCheckAtom, SpecCheckHandler, type SpecCheckMode } from './atoms/spec-check.ts'
export {
  responseCheckAtom,
  ResponseCheckHandler,
  COMPLIANCE_RULE_IDS,
  CONCISION_RULE_IDS,
  RESPONSE_CHECK_RULE_IDS,
  DEFAULT_RESPONSE_TEXT_KEYS,
  DEFAULT_OFFICE_ACTION_KEY,
  DEFAULT_NOTICE_TEXT_KEYS,
  loadResponseCheckRules,
  type ResponseCheckLoader,
  type ResponseRuleLoad,
} from './atoms/response-check.ts'
export {
  eligibilityAtom,
  EligibilityHandler,
  ELIGIBILITY_A5_RULE_ID,
  DEFAULT_ELIGIBILITY_CLAIMS_KEYS,
  DEFAULT_ELIGIBILITY_TEXT_KEYS,
  loadEligibilityRules,
  type EligibilityCategory,
  type EligibilityCheckLoader,
  type EligibilityPending,
  type EligibilityRuleLoad,
  type EligibilitySeverity,
  type EligibilityUnit,
  type EligibilityVerdict,
  type EligibilityViolation,
} from './atoms/eligibility.ts'
export {
  legalGapsAtom,
  LegalGapsHandler,
  LEGAL_GAP_PROFILES,
  LEGAL_GAP_CHECKS,
  type LegalGapCheckpoint,
  type LegalGapItem,
  type LegalGapProfile,
  type LegalGapSeverity,
  type LegalGapStatus,
} from './atoms/legal-gaps.ts'
export { buildSlopRevisionHint } from './internal/retry-hints.ts'
export type { EvaluatedText } from './internal/evaluated-input.ts'

// 篇幅口径只此一处：`slop-gate` 与 `tighten` 用它判预算，评测读数也用它，
// 否则「同一个 4000 字」在两处会算出不同的数。
export { visibleChars } from './internal/slop-engine.ts'

// 检索质量度量是纯算术库：语料与基线排序是测试资产，这里只发布指标函数。
export { meanReciprocalRank, ndcgAtK, rankOfFirstRelevant } from './eval/ir-metrics.ts'
export type { RankedQuery, RelevanceJudgments } from './eval/ir-metrics.ts'

// render_patent_document is owned by dsh-patent-document; re-export for library consumers.
export { createRenderPatentDocumentTool, renderDocumentResult } from '@deepseek-ai/dsh-patent-document'

export { Config, DEFAULT_WORKFLOW_STAGE_BUDGET, DEFAULT_WORKFLOW_LLM_STAGE_BUDGET } from './config.ts'
export type { ImageModelConfig } from './config.ts'
export { buildImageGateResolver, createDownloadRunnerResolver, registerPatentTools } from './wiring.ts'
export type { DownloadRunnerResolverOptions } from './wiring.ts'

/** Cordis plugin name. */
export const name = 'patent-tools'

/** Services the plugin requires before registration. */
export const inject = ['tools']

/**
 * Register the 36 patent tools and their workflow atoms.
 * @param ctx - registrant context carrying the tool registry and optional services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  registerPatentTools(ctx, config)
}
