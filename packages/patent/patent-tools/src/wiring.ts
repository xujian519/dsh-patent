/**
 * Registration of the 38 patent tools on a Cordis context. `apply` in the package
 * entry delegates here; the exports in this module are the composition surface
 * that tools and tests build on directly.
 * @module @deepseek-ai/dsh-patent-tools/wiring
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Declaration merge only: makes ctx.get('approval') resolve to the approval service.
import type {} from '@deepseek-ai/dsh-user-approval'
import { createLlmModelPort, globalAtomRegistry, globalStageHandlerRegistry, registerBuiltinAtoms, validateSpecDraft, validateWorkflowBudget, validateWorkflowManifest } from '@deepseek-ai/dsh-patent-core'
import type { Atom, PatentModelPort, SpecDraft, StageHandler, StageProvider } from '@deepseek-ai/dsh-patent-core'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { PatentKnowledge } from '@deepseek-ai/dsh-patent-knowledge'
import { builtinPatentManifests, SHIPPED_GUIDELINE_REVISION } from '@deepseek-ai/dsh-patent-workflow'
import { candidateRuleDirs, createCheckerRuleEvaluator } from '@deepseek-ai/dsh-patent-rule'
import type { GenerateOptions, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveBrowserBackend } from '@deepseek-ai/dsh-browser-backend'
import { chemistryIndexStore, DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH } from './chemistry/index-store.ts'
import { figureIndexStore, DEFAULT_FIGURE_INDEX_RELATIVE_PATH } from './figure/index-store.ts'
import { DEFAULT_FIGURE_NUMERALS_RELATIVE_PATH, loadNumerals, mergeNumerals } from './figure/numeral-store.ts'
import { createTwoStepAnalysisEngine } from './figure/analysis-engine.ts'
import { resolveImageInputModalities } from './figure/image-capability.ts'
import { DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS } from './figure/graphviz-renderer.ts'
import { DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS, exportWithInkscape, findInkscape, outlineSvgText } from './figure/inkscape-renderer.ts'
import type { ExportFigurePort, OutlineTextPort } from './figure/inkscape-renderer.ts'
import { pickRenderer } from './figure/render-selector.ts'
import { PatentToolError } from './error.ts'
import { auditFilingDraft, renderFilingFormDenial } from './tool/internal/filing-form-audit.ts'
import { readStagePatterns, stageWritingSkills } from './tool/internal/stage-writing-skills.ts'
import { createPatentSearchTool } from './tool/patent-search.ts'
import { createPatentMetadataTool } from './tool/patent-metadata.ts'
import { createPatentLegalStatusTool } from './tool/patent-legal-status.ts'
import { createPatentCaseSearchTool } from './tool/patent-case-search.ts'
import { createLawSearchTool } from './tool/law-search.ts'
import { createPatentCorpusStatusTool } from './tool/patent-corpus-status.ts'
import { createPatentWikiSearchTool } from './tool/patent-wiki-search.ts'
import { createPatentKgQueryTool, type KgAdapter } from './tool/patent-kg-query.ts'
import { createPatentEvalTool } from './tool/patent-eval.ts'
import { createPatentAnalysisReportTool } from './tool/patent-analysis-report.ts'
import { createClaimChartBuildTool } from './tool/claim-chart-build.ts'
import { createTrizContradictionAnalysisTool } from './tool/triz-contradiction-analysis.ts'
import { createParseOfficeActionTool } from './tool/parse-office-action.ts'
import { createDraftClaimsTool } from './tool/draft-claims.ts'
import { createDraftSpecificationTool } from './tool/draft-specification.ts'
import { createValidateSpecificationTool } from './tool/validate-specification.ts'
import { createEvaluateEvidenceTool } from './tool/evaluate-evidence.ts'
import { createRuleCheckTool } from './tool/rule-check.ts'
import { createClaimLintTool } from './tool/claim-lint.ts'
import { createReviewPatentApplicationTool } from './tool/review-patent-application.ts'
import { createDomainCheckTool } from './tool/domain-check.ts'
import { createAnalyzePatentFigureTool } from './tool/analyze-patent-figure.ts'
import { createSearchPatentFigureTool } from './tool/search-patent-figure.ts'
import { createCheckPatentFigureConsistencyTool } from './tool/check-patent-figure-consistency.ts'
import { createCheckClaimFigureCoverageTool } from './tool/check-claim-figure-coverage.ts'
import { createComparePatentFigureAnalysisTool } from './tool/compare-patent-figure-analysis.ts'
import { createGeneratePatentFigureTool } from './tool/generate-patent-figure.ts'
import { createGenerateStructureFigureTool } from './tool/generate-structure-figure.ts'
import type { GenerateStructureFigureDeps } from './tool/generate-structure-figure.ts'
import { DEFAULT_FREECAD_RENDER_TIMEOUT_MS, renderSectionGeometry, renderSectionHatch, renderStructureViews } from './figure/freecad-renderer.ts'
import type { SectionSourcePorts } from './figure/section-source.ts'
import { createAddPatentFigureReferencesTool } from './tool/add-patent-figure-references.ts'
import { createVerifyPatentFigureTool } from './tool/verify-patent-figure.ts'
import { createMatterLogAppendTool } from './tool/matter-log-append.ts'
import { createPatentPdfDownloadTool, type RunEgo } from './tool/patent-pdf-download.ts'
import { createDownloadChannelRunner } from './tool/patent-pdf-download-channel.ts'
import { createRecognizeChemicalStructureTool } from './tool/recognize-chemical-structure.ts'
import { createFlexiblePlanTool } from './tool/patent-flexible-plan.ts'
import { createPatentWorkflowTool } from './tool/patent-workflow.ts'
import { createPatentWorkflowRunTool } from './tool/patent-workflow-run.ts'
import { createPatentPlanTaskTool } from './tool/patent-plan-task.ts'
import { createWorkbenchLinkPatentCaseTool } from './tool/workbench-link-patent-case.ts'
import { createPatentWorkerValidateTool } from './tool/patent-worker-validate.ts'
import { createKnowledgeNoteSaveTool } from './tool/knowledge-note-save.ts'
import { createNoteFileWriter } from './tool/knowledge-note-file-writer.ts'
import { slopGateAtom, SlopGateHandler } from './atoms/slop-gate.ts'
import { tightenAtom, TightenHandler } from './atoms/tighten.ts'
import { draftSpecificationAtom, DraftSpecificationHandler } from './atoms/draft-specification.ts'
import { figureAnalysisAtom, FigureAnalysisHandler } from './atoms/figure-analysis.ts'
import { specCheckAtom, SpecCheckHandler } from './atoms/spec-check.ts'
import { responseCheckAtom, ResponseCheckHandler } from './atoms/response-check.ts'
import { eligibilityAtom, EligibilityHandler } from './atoms/eligibility.ts'
import { legalGapsAtom, LegalGapsHandler } from './atoms/legal-gaps.ts'
import { admissibilityAtom, AdmissibilityHandler } from './atoms/admissibility.ts'


import { DEFAULT_WORKFLOW_LLM_STAGE_BUDGET, DEFAULT_WORKFLOW_STAGE_BUDGET } from './config.ts'
import type { Config } from './config.ts'
/**
 * 解析附图渲染预算：Config 覆盖优先，缺省取渲染器模块导出的默认值（默认值的唯一真源）。
 * @param config - 插件配置。
 * @returns dot 与 freecadcmd 的单次渲染超时（毫秒）。
 */
function resolveRenderBudgets(config: Config): {
  graphvizRenderTimeoutMs: number
  freecadRenderTimeoutMs: number
  inkscapeRenderTimeoutMs: number
} {
  return {
    graphvizRenderTimeoutMs: config.graphvizRenderTimeoutMs ?? DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS,
    freecadRenderTimeoutMs: config.freecadRenderTimeoutMs ?? DEFAULT_FREECAD_RENDER_TIMEOUT_MS,
    inkscapeRenderTimeoutMs: config.inkscapeRenderTimeoutMs ?? DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS,
  }
}

/** 从 Config 或部署默认路由解析 provider/model（agent-default-model 宿主服务）。 */
function resolveModelRoute(ctx: Context, config: Config): { provider: string; model: string } | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const defaults = ctx.get('agentDefaultModel') as { currentSelection: () => { provider: string; model: string } } | undefined
  const selection = defaults?.currentSelection()
  if (selection !== undefined && selection.provider !== '' && selection.model !== '') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** The harness llm streaming service, when mounted. */
function resolveLlm(ctx: Context): { stream: (o: GenerateOptions) => AsyncIterable<StreamChunk> } | undefined {
  return ctx.get('llm')
}

/**
 * Build a model port over the harness llm service for one resolved route.
 * @param llm - the llm service.
 * @param route - the provider/model route.
 * @param maxTokens - the configured cap, if any.
 * @returns the model port.
 */
function createRouteModelPort(
  llm: { stream: (o: GenerateOptions) => AsyncIterable<StreamChunk> },
  route: { provider: string; model: string },
  maxTokens: number | undefined,
): PatentModelPort {
  return createLlmModelPort(o => llm.stream(o), {
    provider: route.provider,
    model: route.model,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  })
}

/** Build a ModelPort from Config + ctx.llm, or a fail-loud stub when not configured. */
function buildModelPort(ctx: Context, config: Config): PatentModelPort {
  const route = resolveModelRoute(ctx, config)
  const llm = resolveLlm(ctx)
  if (route !== undefined && llm !== undefined) {
    return createRouteModelPort(llm, route, config.maxTokens)
  }
  return {
    // oxlint-disable-next-line typescript/require-await -- PatentModelPort.stream contract returns AsyncIterable
    stream: async function* () {
      throw new PatentToolError('setup_required', '未配置 LLM provider/model（Config.provider/model 或部署默认路由不可用），无法执行 LLM 工具。', {})
    },
  }
}

/**
 * Build the figure-model port the image analysis is sent on: same route the
 * image gate checks ({@link figureRoute}), so the gate verdict and the wire
 * route can never diverge. Undefined when the route or the llm service is
 * absent — the tool fails loud with setup guidance at execute.
 */
function buildFigureModelPort(ctx: Context, config: Config): PatentModelPort | undefined {
  const route = figureRoute(ctx, config)
  const llm = resolveLlm(ctx)
  if (route === undefined || llm === undefined) return undefined
  return createRouteModelPort(llm, route, config.maxTokens)
}

/** The harness attachment store (ctx 'attachments'), when mounted. */
function resolveAttachments(ctx: Context): { saveImage: (input: SaveImageAttachment) => Promise<ImageAttachmentRef> } | undefined {
  return ctx.get('attachments')
}

/** Resolve the Config figure-model route for the image gate: imageModel override, else provider/model, else the deployment default. */
function figureRoute(ctx: Context, config: Config): { provider: string; model: string } | undefined {
  const imageModel = config.imageModel
  if (imageModel !== undefined && imageModel.provider !== undefined && imageModel.model !== undefined) {
    return { provider: imageModel.provider, model: imageModel.model }
  }
  return resolveModelRoute(ctx, config)
}

/**
 * Build the image-gate capability resolver from ctx.llm.
 * @param ctx - registrant context carrying the llm service.
 * @returns the resolver, or `undefined` when no llm capability source exists.
 */
export function buildImageGateResolver(
  ctx: Context,
): ((provider: string, model: string) => Promise<readonly ModelModality[] | undefined>) | undefined {
  const llm = ctx.get('llm') as { resolveModelInfo?: (provider: string, model: string) => Promise<LlmResolvedModelInfo> } | undefined
  const resolveModelInfo = llm?.resolveModelInfo
  if (resolveModelInfo === undefined) return undefined
  return (provider, model) => resolveImageInputModalities(resolveModelInfo.bind(llm), provider, model)
}

/**
 * Absolute workspace root published by the deployment on `ctx.sandboxPolicy`.
 * The service's own cwd fallback is a deployment choice (`workspaceRoot` in
 * cordis.yml). This package does not read `process.cwd()` when that value is absent.
 * @param ctx - registrant context.
 * @returns the absolute root, or `undefined` when the service did not publish one.
 * @throws PatentToolError `setup_required` when the published root is not absolute.
 */
function deploymentWorkspaceRoot(ctx: Context): string | undefined {
  // sandbox-policy is outside this package's project references, so the key stays a string.
  const key: string = 'sandboxPolicy'
  const policy = ctx.get(key) as { readonly workspaceRoot?: string } | undefined
  const root = policy?.workspaceRoot
  if (typeof root !== 'string' || root === '') return undefined
  if (!isAbsolute(root)) {
    throw new PatentToolError(
      'setup_required',
      '工作区根必须是绝对路径（sandboxPolicy.workspaceRoot）。不会改用进程目录。',
      { workspaceRoot: root },
    )
  }
  return root
}

/**
 * Resolve one patent output path.
 * An absolute Config value is used as given. A relative value, and the default
 * when Config omits the field, join the deployment workspace root.
 * @param configured - Config value, when the deployment set one.
 * @param relative - path used when Config omits the field.
 * @param root - absolute workspace root, when the deployment published one.
 * @param label - Config field name named in the load error.
 * @returns the absolute output path.
 * @throws PatentToolError `setup_required` when the path is not absolute and no workspace root is published.
 */
function resolveOutputPath(
  configured: string | undefined,
  relative: string,
  root: string | undefined,
  label: string,
): string {
  if (configured !== undefined && isAbsolute(configured)) return configured
  if (root === undefined) {
    throw new PatentToolError(
      'setup_required',
      `未配置 ${label} 的绝对路径，且部署没有工作区根（sandboxPolicy.workspaceRoot）。不会写入进程目录。`,
      { path: label },
    )
  }
  return resolve(root, configured ?? relative)
}

/** True when any of the five output paths still needs the deployment workspace root. */
function outputPathsNeedWorkspace(config: Config): boolean {
  const pending = [config.noteDir, config.figureIndexFile, config.figureNumeralsFile, config.chemistryIndexFile]
  if (config.figureOutputDir !== undefined) pending.push(config.figureOutputDir)
  return pending.some(value => value === undefined || !isAbsolute(value))
}

/** CJK 文本检测（决定平台字体）。 */
function hasCjk(labels: readonly string[]): boolean {
  return labels.some(label => /[\u3400-\u9fff]/.test(label))
}

/** DOT 字体：Config.dotFont 覆盖；否则 CJK 时按平台候选，非 CJK 默认 Helvetica。 */
function resolveDotFont(config: Config, labels: readonly string[]): string {
  if (config.dotFont !== undefined && config.dotFont !== '') return config.dotFont
  if (!hasCjk(labels)) return 'Helvetica'
  switch (process.platform) {
    case 'darwin':
      return 'PingFang SC'
    case 'win32':
      return 'Microsoft YaHei'
    default:
      return 'Noto Sans CJK SC'
  }
}

/** Inputs for the patent PDF-download runner resolver. */
export type DownloadRunnerResolverOptions = {
  /** ego-browser batch runner (fail-loud stub when patent-data is not mounted). */
  runEgo: RunEgo
  /** Backend resolver (tests inject a fake; defaults to resolveBrowserBackend). */
  resolve?: typeof resolveBrowserBackend
}

/**
 * Build the download-runner resolver for patent_pdf_download. With the unified
 * ego stack the download channel resolves only the ego backend and always runs
 * the ego runner; browseros-neo / playwright / browser-use participate in the
 * probe matrix but never take a download (no intercept/extract execution).
 * @param options - the ego runner and an optional resolver.
 * @returns a resolver returning the ego runner.
 */
export function createDownloadRunnerResolver(options: DownloadRunnerResolverOptions): () => Promise<RunEgo> {
  const resolveBackend = options.resolve ?? resolveBrowserBackend
  return async () => {
    // 统一 ego 栈后下载通道只认 ego；browseros-neo / playwright / browser-use 参与探测矩阵但不参与下载。
    await resolveBackend({ exclude: ['browseros-neo', 'playwright', 'browser-use'] }).catch(() => {
      // No backend is detectable on this host. The caller explicitly wired the
      // ego channel (runEgo comes from ctx.patentData), so honor it rather than
      // failing the download with install guidance.
    })
    return options.runEgo
  }
}

/**
 * 把本包自有的 atom/handler 注册包装为 Cordis effect：插件 dispose 时撤销本次注册。
 *
 * patent-core 的内置 atom 由 `registerBuiltinAtoms()` 全局共享，归属核心而非单个插件，
 * 不在本 effect 内撤销。
 * @param ctx - 插件上下文。
 * @param pairs - 本包注册的 atom 与 handler。
 */
function registerPackageAtoms(
  ctx: Context,
  pairs: readonly { atom: Atom; handler: StageHandler }[],
): void {
  ctx.effect(
    () => {
      const disposers = pairs.flatMap(({ atom, handler }) => [
        globalAtomRegistry.register(atom),
        globalStageHandlerRegistry.register(handler),
      ])
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
    'patent-tools: workflow atoms',
  )
}

/**
 * Services and paths resolved once for every tool group.
 * Tool registration order is the model-visible order, so each group owns one
 * contiguous span and the groups run in that same order.
 */
interface PatentToolWiring {
  ctx: Context
  config: Config
  model: PatentModelPort
  gateModel: ReturnType<typeof figureRoute>
  imageModel: PatentModelPort | undefined
  attachments: ReturnType<typeof resolveAttachments>
  resolveImageInputModalitiesFor: ReturnType<typeof buildImageGateResolver>
  figureIndexFile: string
  figureNumeralsFile: string
  chemistryIndexFile: string
  figureOutputDir: string | undefined
  noteDir: string
  knowledge: PatentKnowledge | undefined
}

/**
 * Register search, metadata, legal-status, and knowledge tools.
 * @param wiring - services and paths resolved by {@link registerPatentTools}.
 */
function registerKnowledgeTools(wiring: PatentToolWiring): void {
  // Search / metadata / legal status: default to the nuo engine (no service needed).
  // All three add the CNIPR channel as a second channel for what the nuo engine could
  // not answer (a failed or zero-hit search, a failed or not-found China publication
  // number, an unanswered legal status); the lookup is late-bound because patent-data
  // declares inject:['subprocess'] and therefore activates one dependency hop after this
  // tools-only consumer. The channel is undefined while the deployment leaves
  // patent-data's cniprEnabled off.
  wiring.ctx.tools.register(createPatentSearchTool({
    cnipr: () => wiring.ctx.get('patentData')?.createCniprChannel(),
  }))
  wiring.ctx.tools.register(createPatentMetadataTool({
    cnipr: () => wiring.ctx.get('patentData')?.createCniprChannel(),
  }))
  wiring.ctx.tools.register(createPatentLegalStatusTool({
    cnipr: () => wiring.ctx.get('patentData')?.createCniprChannel(),
  }))

  // Knowledge tools: wire ctx.patentKnowledge when present, else fail loud at execute.
  const knowledge = wiring.knowledge
  if (knowledge !== undefined) {
    wiring.ctx.tools.register(createPatentCaseSearchTool({
      search: (q, o) => knowledge.caseLawSearch(q, o),
      dbPath: knowledge.paths.queryDbPath,
      corpusInfo: () => knowledge.corpusInfo(),
    }))
    // 规范原文检索：法规条文与《专利审查指南》全文同出一库（知识库 documents 的两类文档）。
    wiring.ctx.tools.register(createLawSearchTool({
      searchLaw: (q, o) => knowledge.legalSearch(q, o),
      searchGuideline: (q, o) => knowledge.guidelineSearch(q, o),
      dbPath: knowledge.paths.queryDbPath,
      corpusInfo: () => knowledge.corpusInfo(),
    }))
    wiring.ctx.tools.register(createPatentCorpusStatusTool({
      corpusInfo: () => knowledge.corpusInfo(),
      dbPath: knowledge.paths.queryDbPath,
    }))
    wiring.ctx.tools.register(createPatentWikiSearchTool({
      searchIn: (prefix, keyword, limit) => knowledge.wikiCardsIn(prefix, keyword, limit),
      formatAsContext: (id, maxChars) => knowledge.wikiContext(id, maxChars),
      wikiDir: knowledge.paths.wikiDir,
    }))
    if (existsSync(knowledge.paths.queryDbPath)) {
      // The service owns the one read-only knowledge-graph handle and closes it when
      // its fiber unloads; the tool queries that handle, so no second store with
      // its own cache opens over the same database.
      const adapter: KgAdapter = {
        getNode: id => knowledge.kgGetNode(id),
        searchRelevant: (query, options) => knowledge.kgSearch(query, options),
        getSimilarNodes: (id, limit) => knowledge.kgSimilarNodes(id, limit),
        getNeighbors: (id, relation, limit) => knowledge.kgNeighbors(id, relation, limit),
        listByType: (type, limit) => knowledge.kgListByType(type, limit),
      }
      wiring.ctx.tools.register(createPatentKgQueryTool({ adapter, dbPath: knowledge.paths.queryDbPath }))
    } else {
      wiring.ctx.tools.register(createPatentKgQueryTool({ dbPath: knowledge.paths.queryDbPath }))
    }
  } else {
    wiring.ctx.tools.register(createPatentCaseSearchTool({}))
    wiring.ctx.tools.register(createLawSearchTool({}))
    wiring.ctx.tools.register(createPatentCorpusStatusTool({}))
    wiring.ctx.tools.register(createPatentWikiSearchTool({}))
    wiring.ctx.tools.register(createPatentKgQueryTool({}))
  }
}

/**
 * Register the deterministic drafting tools, the workbench bridge, and the
 * workflow-run tools. They occupy one contiguous span of the tool list.
 * @param wiring - services and paths resolved by {@link registerPatentTools}.
 */
function registerWorkflowTools(wiring: PatentToolWiring): void {
  // Pure deterministic tools.
  wiring.ctx.tools.register(createPatentEvalTool())
  wiring.ctx.tools.register(createDraftClaimsTool())
  wiring.ctx.tools.register(createDraftSpecificationTool())
  wiring.ctx.tools.register(createValidateSpecificationTool())
  wiring.ctx.tools.register(createRuleCheckTool())
  wiring.ctx.tools.register(createClaimLintTool())
  wiring.ctx.tools.register(createReviewPatentApplicationTool())
  wiring.ctx.tools.register(createDomainCheckTool())
  wiring.ctx.tools.register(createParseOfficeActionTool())
  wiring.ctx.tools.register(createPatentWorkerValidateTool())
  wiring.ctx.tools.register(createPatentPlanTaskTool())
  // Workbench case bridge: talk to the personal-workbench plugin's loopback
  // HTTP API. Base URL: explicit config wins; otherwise the in-process
  // webServer port (web profile); absent → the tool fails loud at execute.
  // The service is read dynamically: this package's tsconfig does not
  // reference the host-webserver project, so no declaration merge is pulled in.
  const workbenchWebServer = wiring.ctx.get('webServer') as { port: number } | undefined
  const workbenchWebServerPort = workbenchWebServer?.port
  wiring.ctx.tools.register(createWorkbenchLinkPatentCaseTool({
    ...(wiring.config.workbenchBaseUrl === undefined && workbenchWebServerPort === undefined
      ? {}
      : { baseUrl: wiring.config.workbenchBaseUrl ?? `http://127.0.0.1:${workbenchWebServerPort}` }),
    caseRoot: wiring.config.workbenchCaseRoot ?? './patent-workspace',
  }))
  wiring.ctx.tools.register(createRecognizeChemicalStructureTool({
    // 识别引擎不可用（RDKit 未安装）时 usable 恒 false，该写入闭包不可达；
    // RDKit 接入并产出 usable 结果后移除 ignore（与 recognize 工具内注释呼应）。
    /* v8 ignore next -- dead until the chemistry engine produces a usable result. */
    upsertIndex: entry => chemistryIndexStore.upsert(wiring.chemistryIndexFile, entry),
  }))

  // LLM-consuming tools.
  wiring.ctx.tools.register(createPatentAnalysisReportTool({ model: wiring.model }))
  wiring.ctx.tools.register(createClaimChartBuildTool({
    model: wiring.model,
    // 证据源相对路径按部署的工作根解析；缺省时内核回落到进程 cwd，
    // 打包应用里那不是用户的案卷目录。
    ...(wiring.config.workbenchCaseRoot === undefined ? {} : { cwd: wiring.config.workbenchCaseRoot }),
  }))
  wiring.ctx.tools.register(createTrizContradictionAnalysisTool({ model: wiring.model }))
  // ctx.jobs backs `run_in_background`: read lazily, because the job registry
  // may load after this plugin; absent means the tool fails loud on that flag.
  // 图模式的规则门评估器在组合点注入：规则语料随 patent-rule 发布，
  // patent-core 只保留端口与引擎。
  const writingSkillsForStage = (stageId: string): string | undefined =>
    stageWritingSkills(readStagePatterns(wiring.ctx.get('writingPatterns')), stageId)
  // Resolve the search function per run through ctx.patentData: the service owns
  // the nuo search provider factory, and patent-data activates one hop after this
  // plugin, so load time is too early to read it.
  const searchProvider = (): StageProvider['search'] | undefined =>
    wiring.ctx.get('patentData')?.createSearchProvider().search
  wiring.ctx.tools.register(createPatentWorkflowRunTool({
    model: wiring.model,
    searchProvider,
    jobs: () => wiring.ctx.get('jobs'),
    approval: () => wiring.ctx.get('approval'),
    approveStageGates: wiring.config.approveStageGates === true,
    ruleEvaluator: createCheckerRuleEvaluator(),
    writingSkillsForStage,
    workflow: () => wiring.ctx.get('patentWorkflow'),
  }))
  wiring.ctx.tools.register(createFlexiblePlanTool({ model: wiring.model, searchProvider, writingSkillsForStage }))
}

/**
 * Register figure tools. `evaluate_evidence` stays here so the model-visible
 * registration order is unchanged.
 * @param wiring - services and paths resolved by {@link registerPatentTools}.
 */
function registerFigureTools(wiring: PatentToolWiring): void {
  const attachments = wiring.attachments
  wiring.ctx.tools.register(createAnalyzePatentFigureTool({
    ...(wiring.imageModel === undefined ? {} : { imageModel: wiring.imageModel }),
    ...(wiring.gateModel === undefined ? {} : { gateModel: wiring.gateModel }),
    ...(attachments === undefined ? {} : { saveImage: input => attachments.saveImage(input) }),
    ...(wiring.resolveImageInputModalitiesFor === undefined ? {} : { resolveImageInputModalities: wiring.resolveImageInputModalitiesFor }),
    upsertIndex: entry => figureIndexStore.upsert(wiring.figureIndexFile, entry),
    // 两步分析引擎在组合点按 Config 选择注入；缺省 single 由工具内部构造默认单步引擎。
    // 引擎按调用接收模型端口，故这里不需要（也不应）在组合点捕获模型。
    ...(wiring.config.figureAnalysisMode === 'two-step'
      ? { analysisEngine: createTwoStepAnalysisEngine() }
      : {}),
  }))

  // Evidence + rule-asset + recap + figure-index + notes.
  wiring.ctx.tools.register(createEvaluateEvidenceTool({ ruleDirs: candidateRuleDirs() }))
  wiring.ctx.tools.register(createPatentWorkflowTool({}))
  // Search figure index: analyze_patent_figure persists its results through
  // figureIndexStore.upsert into the configured figureIndexFile, which the
  // search tool loads on each call.
  wiring.ctx.tools.register(createSearchPatentFigureTool({
    loadIndex: () => figureIndexStore.load(wiring.figureIndexFile),
  }))

  // 跨图一致性：对多张附图的分析结果做确定性校验（同一标记跨图同名、图号连续、
  // 权利要求引用齐全）。纯函数、无模型调用；电学符号与网表不在范围。
  wiring.ctx.tools.register(createCheckPatentFigureConsistencyTool())

  // 权项要素覆盖：核对权利要求的技术特征能否在图面指认到标号。纯函数、无模型调用；
  // 只验指认的标号真实存在，不判断该标号是否在语义上体现了该特征。
  wiring.ctx.tools.register(createCheckClaimFigureCoverageTool())

  // 图文比对：把出图时声明的标号清单与 analyze_patent_figure 的识别结果对齐，闭合
  // 「生成 → 识图 → 比对」。确定性比对，不调用模型；连接关系暂不比对。
  wiring.ctx.tools.register(createComparePatentFigureAnalysisTool())

  // Figure generation: default renderer is the bundled WASM engine (SVG with no
  // system dependency); PNG/PDF and figureRenderer="cli" go through the dot CLI
  // via ctx.subprocess, failing loud with install guidance when absent.
  const subprocess = wiring.ctx.get('subprocess')
  const renderBudgets = resolveRenderBudgets(wiring.config)
  const renderDot = pickRenderer(wiring.config.figureRenderer, {
    ...(subprocess === undefined ? {} : { subprocess }),
    ...(wiring.config.graphvizExecutable === undefined ? {} : { graphvizExecutable: wiring.config.graphvizExecutable }),
    graphvizRenderTimeoutMs: renderBudgets.graphvizRenderTimeoutMs,
  })
  // 文字转路径（Config.figureTextToPath）是可选的导出加固：开启时注入端口，关闭时
  // 完全不接线。缺 subprocess 或 Inkscape 时 fail loud（setup_required），不静默
  // 交出仍有字体依赖的图。
  const outlineText: OutlineTextPort | undefined = wiring.config.figureTextToPath === true
    ? spec => (subprocess === undefined
      ? Promise.resolve({ ok: false as const, code: 'not_installed' as const, error: '文字转路径需要 subprocess 服务（宿主未挂载 @deepseek-ai/dsh-subprocess）。' })
      : outlineSvgText(subprocess, spec, {
        ...(wiring.config.inkscapeExecutable === undefined ? {} : { executable: wiring.config.inkscapeExecutable }),
        renderTimeoutMs: renderBudgets.inkscapeRenderTimeoutMs,
      }))
    : undefined
  // 格式导出端口：png/pdf 要落版就必须先出 SVG 再导出，故这一段取决于「本机有没有
  // Inkscape」。可用性在装载时解析一次（与 findFreeCadCmd 同序），工具层据此决定是走
  // 全链还是渲染器直接出图；没有端口时工具层给出「落版与复核未生效」的警告，不静默。
  const exportFigure: ExportFigurePort | undefined = subprocess !== undefined
    && findInkscape(wiring.config.inkscapeExecutable) !== undefined
    ? spec => exportWithInkscape(subprocess, spec, {
      ...(wiring.config.inkscapeExecutable === undefined ? {} : { executable: wiring.config.inkscapeExecutable }),
      renderTimeoutMs: renderBudgets.inkscapeRenderTimeoutMs,
    })
    : undefined
  // 剖切来源（剖视图的 sections.source）：与结构线稿共用同一段 FreeCAD 通道。宿主未挂载
  // subprocess 时不注入端口，工具层对 source 报 setup_required —— 需要 CAD 就 fail loud，
  // 不静默降级成手写轮廓的示意图。
  const sectionSource: SectionSourcePorts | undefined = subprocess === undefined
    ? undefined
    : {
      sectionGeometry: spec => renderSectionGeometry(subprocess, spec, {
        ...(wiring.config.freecadExecutable === undefined ? {} : { executable: wiring.config.freecadExecutable }),
        renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
      }),
      sectionHatch: spec => renderSectionHatch(subprocess, spec, {
        ...(wiring.config.freecadExecutable === undefined ? {} : { executable: wiring.config.freecadExecutable }),
        renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
      }),
    }
  wiring.ctx.tools.register(createGeneratePatentFigureTool({
    render: renderDot,
    ...(outlineText === undefined ? {} : { outlineText }),
    ...(exportFigure === undefined ? {} : { exportFigure }),
    ...(sectionSource === undefined ? {} : { sectionSource }),
    ...(wiring.figureOutputDir === undefined ? {} : { outputDir: wiring.figureOutputDir }),
    ...(wiring.config.workbenchCaseRoot === undefined ? {} : { workRoot: wiring.config.workbenchCaseRoot }),
    upsertIndex: entry => figureIndexStore.upsert(wiring.figureIndexFile, entry),
    loadIndex: async () => (await figureIndexStore.load(wiring.figureIndexFile)).entries,
    loadNumerals: scope => loadNumerals(wiring.figureNumeralsFile, scope),
    upsertNumerals: async (scope, items) =>
      (await mergeNumerals(wiring.figureNumeralsFile, scope, items)).conflicts,
    resolveFont: labels => resolveDotFont(wiring.config, labels),
    ...(wiring.config.figureRequireCuttingMarks === undefined ? {} : { requireCuttingMarks: wiring.config.figureRequireCuttingMarks }),
    ...(wiring.config.figureFailOnRenderFindings === undefined ? {} : { failOnRenderFindings: wiring.config.figureFailOnRenderFindings }),
    ...(wiring.config.figureMinSheetFillRatio === undefined ? {} : { minSheetFillRatio: wiring.config.figureMinSheetFillRatio }),
    ...(wiring.config.figureFontMm === undefined ? {} : { figureFontMm: wiring.config.figureFontMm }),
    ...(wiring.config.figurePageSize === undefined ? {} : { pageSize: wiring.config.figurePageSize }),
    ...(wiring.config.figureOrientation === undefined ? {} : { orientation: wiring.config.figureOrientation }),
    ...(wiring.config.figureDpi === undefined ? {} : { dpi: wiring.config.figureDpi }),
    ...(wiring.config.figureMargin === undefined ? {} : { marginCm: wiring.config.figureMargin }),
  }))
  wiring.ctx.tools.register(createAddPatentFigureReferencesTool({
    loadNumerals: scope => loadNumerals(wiring.figureNumeralsFile, scope),
    upsertNumerals: async (scope, items) =>
      (await mergeNumerals(wiring.figureNumeralsFile, scope, items)).conflicts,
  }))
  // 渲染复核:量测已生成的 SVG 附图(标号是否被线条贯穿、点划线是否被实线覆盖、相邻
  // 零件剖面线是否可区分、内容是否越出画布)。生成后的自动复核在生成工具内部完成,
  // 本工具供已交付/外部生成的 SVG 做交付前自检。
  wiring.ctx.tools.register(createVerifyPatentFigureTool(
    wiring.config.figureMinFontMm === undefined ? {} : { minFontMm: wiring.config.figureMinFontMm },
  ))

  // Structure line-art figure: an independent tool parallel to generate_patent_figure,
  // projecting STEP/IGES/BREP models through the host FreeCAD (TechDraw) via
  // ctx.subprocess. CAD-isolated and off by default (Config.structureFigureEnabled);
  // when the gate is closed or freecadcmd is missing it fails loud with setup
  // guidance at execute — it never silently degrades to a schematic.
  const structureSubprocess = subprocess
  // 注：返回对象字面量的 async 箭头不能直接作三元分支（TS 解析器缺陷），故先提升为具名常量。
  const structureNoSubprocess: GenerateStructureFigureDeps['render'] = () => Promise.resolve({
    ok: false,
    code: 'not_installed',
    error: 'generate_structure_figure 需要 subprocess 服务（宿主未挂载），无法调用 FreeCAD。',
  })
  const structureRender: GenerateStructureFigureDeps['render'] = structureSubprocess === undefined
    ? structureNoSubprocess
    : spec => renderStructureViews(structureSubprocess, spec, {
      ...(wiring.config.freecadExecutable === undefined ? {} : { executable: wiring.config.freecadExecutable }),
      renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
    })
  const structureViews = wiring.config.structureFigureViews
  wiring.ctx.tools.register(createGenerateStructureFigureTool({
    render: structureRender,
    ...(outlineText === undefined ? {} : { outlineText }),
    ...(wiring.config.structureFigureEnabled === undefined ? {} : { enabled: wiring.config.structureFigureEnabled }),
    ...(wiring.figureOutputDir === undefined ? {} : { outputDir: wiring.figureOutputDir }),
    ...(wiring.config.workbenchCaseRoot === undefined ? {} : { workRoot: wiring.config.workbenchCaseRoot }),
    upsertIndex: entry => figureIndexStore.upsert(wiring.figureIndexFile, entry),
    ...(wiring.config.structureFigureScale === undefined ? {} : { defaultScale: wiring.config.structureFigureScale }),
    ...(wiring.config.figureFailOnRenderFindings === undefined ? {} : { failOnRenderFindings: wiring.config.figureFailOnRenderFindings }),
    ...(wiring.config.figureMinSheetFillRatio === undefined ? {} : { minSheetFillRatio: wiring.config.figureMinSheetFillRatio }),
    ...(structureViews === undefined ? {} : { defaultViews: structureViews }),
  }))
}

/**
 * Register filing delivery tools: PDF download, knowledge notes, and the matter log.
 * @param wiring - services and paths resolved by {@link registerPatentTools}.
 */
function registerFilingTools(wiring: PatentToolWiring): void {
  // PDF download: the runner resolves ctx.patentData per call, because
  // patent-data declares inject:['subprocess'] and therefore activates after
  // this plugin (which injects ['tools'] only) — reading the service here would
  // freeze it as undefined in the shipped ordering. The unified ego stack routes
  // the download to ego-browser only; browseros-neo / playwright / browser-use
  // stay out of the download path, and a host without a usable browser falls
  // back to a browser-free scrape of the CDN link.
  const runEgo = createDownloadChannelRunner(() => wiring.ctx.get('patentData'))
  wiring.ctx.tools.register(createPatentPdfDownloadTool({
    runEgo,
    fetchImpl: globalThis.fetch,
    resolveRunner: createDownloadRunnerResolver({ runEgo }),
  }))

  // Notes land as files under the configured noteDir (default <cwd>/99-知识库):
  // no storage service dependency, works in headless and web compositions.
  wiring.ctx.tools.register(createKnowledgeNoteSaveTool({
    writeNote: createNoteFileWriter(wiring.noteDir),
  }))

  // 案卷留档的唯一写入口：交付前置门禁要求它先成功，交付件才允许落盘。
  wiring.ctx.tools.register(createMatterLogAppendTool())

  // 成文前形式预检：校验文本由 docx 通道同一份 contentFromDraft 映射产出，因此
  // 这次要成文的草案就是被校验的那一份。交付门禁只能按会话记账，证明不了同源。
  // 草案本身不合法时不在这里拦——结构错误由成文工具自己逐条报告。
  wiring.ctx.tools.guard((exec) => {
    if (exec.name !== 'build_patent_filing') return undefined
    const draft = readSpecDraftArgument(exec.arguments)
    if (draft === undefined) return undefined
    const violations = auditFilingDraft(draft)
    return violations.length === 0 ? undefined : renderFilingFormDenial(violations)
  })
}

/**
 * 从工具入参里取出已校验的草案。
 * @param args - 工具调用入参。
 * @returns 通过 `validateSpecDraft` 的草案；入参缺 draft 或草案本身不合法时为 undefined。
 */
function readSpecDraftArgument(args: unknown): SpecDraft | undefined {
  if (typeof args !== 'object' || args === null || !('draft' in args)) return undefined
  try {
    return validateSpecDraft(args.draft)
  } catch {
    // DraftValidationError：结构违规由 build_patent_filing 自己逐条报告，这里只管形式规则。
    return undefined
  }
}

/**
 * Register the 38 patent tools.
 * @param ctx - registrant context carrying the tool registry and optional services.
 * @param config - validated {@link Config}.
 */
export function registerPatentTools(ctx: Context, config: Config): void {
  // A manifest authored against another guideline revision would silently apply
  // stale law; fail the plugin load instead.
  const guidelineRevision = config.guidelineRevision ?? SHIPPED_GUIDELINE_REVISION
  for (const manifest of builtinPatentManifests) {
    validateWorkflowManifest(manifest, { guidelineRevision })
  }
  // 内置原子（契约 + 运行时）注册进全局注册表；幂等。不注册则 atom-bearing
  // manifest 在 runWorkflow 的 fail-fast 处抛错，工作流工具全部不可用。
  registerBuiltinAtoms()
  // slop-gate 依赖本包的 slop 引擎，tighten 依赖同一引擎的可见字符口径与
  // patent-core 的 LLM 骨架，spec-check 依赖本包的说明书校验器，
  // response-check 与 eligibility 复用 patent-rule 的规则资产，legal-gaps 汇总这些检查，
  // admissibility 复用 patent-deadline 的期限起算；均按依赖方向注册在 patent-core 内置之外。
  registerPackageAtoms(ctx, [
    { atom: slopGateAtom, handler: new SlopGateHandler() },
    { atom: tightenAtom, handler: new TightenHandler() },
    { atom: draftSpecificationAtom, handler: new DraftSpecificationHandler() },
    { atom: figureAnalysisAtom, handler: new FigureAnalysisHandler() },
    { atom: specCheckAtom, handler: new SpecCheckHandler() },
    { atom: responseCheckAtom, handler: new ResponseCheckHandler() },
    { atom: eligibilityAtom, handler: new EligibilityHandler() },
    { atom: legalGapsAtom, handler: new LegalGapsHandler() },
    { atom: admissibilityAtom, handler: new AdmissibilityHandler() },
  ])
  // Budgets are deployment configuration: a manifest that grows past them fails
  // the load instead of quietly multiplying model calls at run time.
  const budget = {
    maxStages: config.workflowStageBudget ?? DEFAULT_WORKFLOW_STAGE_BUDGET,
    maxLlmStages: config.workflowLlmStageBudget ?? DEFAULT_WORKFLOW_LLM_STAGE_BUDGET,
  }
  for (const manifest of builtinPatentManifests) {
    validateWorkflowBudget(manifest, budget, globalAtomRegistry)
  }
  const workspaceRoot = outputPathsNeedWorkspace(config) ? deploymentWorkspaceRoot(ctx) : undefined
  const wiring: PatentToolWiring = {
    ctx,
    config,
    model: buildModelPort(ctx, config),
    gateModel: figureRoute(ctx, config),
    imageModel: buildFigureModelPort(ctx, config),
    attachments: resolveAttachments(ctx),
    resolveImageInputModalitiesFor: buildImageGateResolver(ctx),
    figureIndexFile: resolveOutputPath(config.figureIndexFile, DEFAULT_FIGURE_INDEX_RELATIVE_PATH, workspaceRoot, 'figureIndexFile'),
    figureNumeralsFile: resolveOutputPath(config.figureNumeralsFile, DEFAULT_FIGURE_NUMERALS_RELATIVE_PATH, workspaceRoot, 'figureNumeralsFile'),
    chemistryIndexFile: resolveOutputPath(config.chemistryIndexFile, DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH, workspaceRoot, 'chemistryIndexFile'),
    figureOutputDir: config.figureOutputDir === undefined
      ? undefined
      : resolveOutputPath(config.figureOutputDir, config.figureOutputDir, workspaceRoot, 'figureOutputDir'),
    noteDir: resolveOutputPath(config.noteDir, '99-知识库', workspaceRoot, 'noteDir'),
    knowledge: ctx.get('patentKnowledge'),
  }
  registerKnowledgeTools(wiring)
  registerWorkflowTools(wiring)
  registerFigureTools(wiring)
  registerFilingTools(wiring)
}
