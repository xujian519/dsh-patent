/**
 * Registration of the 35 patent tools on a Cordis context. `apply` in the package
 * entry delegates here; the exports in this module are the composition surface
 * that tools and tests build on directly.
 * @module @deepseek-ai/dsh-patent-tools/wiring
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createLlmModelPort, globalAtomRegistry, globalStageHandlerRegistry, registerBuiltinAtoms, validateWorkflowBudget, validateWorkflowManifest } from '@deepseek-ai/dsh-patent-core'
import type { Atom, PatentModelPort, StageHandler } from '@deepseek-ai/dsh-patent-core'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { KgStore, PatentKgAdapter, WikiCardLoader } from '@deepseek-ai/dsh-patent-knowledge'
import { builtinPatentManifests, SHIPPED_GUIDELINE_REVISION } from '@deepseek-ai/dsh-patent-workflow'
import { candidateRuleDirs, createCheckerRuleEvaluator } from '@deepseek-ai/dsh-patent-rule'
import type { GenerateOptions, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveBrowserBackend } from '@deepseek-ai/dsh-browser-backend'
import { chemistryIndexStore, DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH } from './chemistry/index-store.ts'
import { figureIndexStore, DEFAULT_FIGURE_INDEX_RELATIVE_PATH } from './figure/index-store.ts'
import { createTwoStepAnalysisEngine } from './figure/analysis-engine.ts'
import { resolveImageInputModalities } from './figure/image-capability.ts'
import { DEFAULT_GRAPHVIZ_RENDER_TIMEOUT_MS } from './figure/graphviz-renderer.ts'
import { DEFAULT_INKSCAPE_RENDER_TIMEOUT_MS, exportWithInkscape, findInkscape, outlineSvgText } from './figure/inkscape-renderer.ts'
import type { ExportFigurePort, OutlineTextPort } from './figure/inkscape-renderer.ts'
import { pickRenderer } from './figure/render-selector.ts'
import { PatentToolError } from './error.ts'
import { createPatentSearchTool } from './tool/patent-search.ts'
import { createPatentMetadataTool } from './tool/patent-metadata.ts'
import { createPatentLegalStatusTool } from './tool/patent-legal-status.ts'
import { createPatentCaseSearchTool } from './tool/patent-case-search.ts'
import { createLawSearchTool } from './tool/law-search.ts'
import { createPatentWikiSearchTool } from './tool/patent-wiki-search.ts'
import { createPatentKgQueryTool } from './tool/patent-kg-query.ts'
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
import { createAnalyzePatentFigureTool } from './tool/analyze-patent-figure.ts'
import { createSearchPatentFigureTool } from './tool/search-patent-figure.ts'
import { createCheckPatentFigureConsistencyTool } from './tool/check-patent-figure-consistency.ts'
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

/** Resolve the knowledge-note directory: Config.noteDir (absolute or relative to cwd), else <cwd>/99-知识库. */
function resolveNoteDir(config: Config): string {
  return config.noteDir !== undefined ? resolve(config.noteDir) : join(process.cwd(), '99-知识库')
}

/** Resolve the figure-index file: Config.figureIndexFile (absolute or relative to cwd), else <cwd>/.sati/figures-index.json. */
function resolveFigureIndexFile(config: Config): string {
  return config.figureIndexFile !== undefined
    ? resolve(config.figureIndexFile)
    : resolve(process.cwd(), DEFAULT_FIGURE_INDEX_RELATIVE_PATH)
}

/** Resolve the chemistry-index file: Config.chemistryIndexFile (absolute or relative to cwd), else <cwd>/.sati/chemistry-index.json. */
function resolveChemistryIndexFile(config: Config): string {
  return config.chemistryIndexFile !== undefined
    ? resolve(config.chemistryIndexFile)
    : resolve(process.cwd(), DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH)
}

/** Resolve the figure output directory: Config.figureOutputDir (absolute or relative to cwd), else <cwd>/patent/figures. */
function resolveFigureOutputDir(config: Config): string {
  return config.figureOutputDir !== undefined ? resolve(config.figureOutputDir) : resolve(process.cwd(), 'patent/figures')
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
 * Register the 35 patent tools.
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
  // response-check 与 eligibility 复用 patent-rule 的规则资产，legal-gaps 汇总这些检查；
  // 均按依赖方向注册在 patent-core 内置之外。
  registerPackageAtoms(ctx, [
    { atom: slopGateAtom, handler: new SlopGateHandler() },
    { atom: tightenAtom, handler: new TightenHandler() },
    { atom: draftSpecificationAtom, handler: new DraftSpecificationHandler() },
    { atom: figureAnalysisAtom, handler: new FigureAnalysisHandler() },
    { atom: specCheckAtom, handler: new SpecCheckHandler() },
    { atom: responseCheckAtom, handler: new ResponseCheckHandler() },
    { atom: eligibilityAtom, handler: new EligibilityHandler() },
    { atom: legalGapsAtom, handler: new LegalGapsHandler() },
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
  const model = buildModelPort(ctx, config)
  const gateModel = figureRoute(ctx, config)
  const imageModel = buildFigureModelPort(ctx, config)
  const attachments = resolveAttachments(ctx)
  const resolveImageInputModalitiesFor = buildImageGateResolver(ctx)
  const figureIndexFile = resolveFigureIndexFile(config)
  const chemistryIndexFile = resolveChemistryIndexFile(config)
  const knowledge = ctx.get('patentKnowledge')

  // Search / metadata / legal status: default to the nuo engine (no service needed).
  // All three add the CNIPR channel as a second channel for what the nuo engine could
  // not answer (a failed or zero-hit search, a failed or not-found China publication
  // number, an unanswered legal status); the lookup is late-bound because patent-data
  // declares inject:['subprocess'] and therefore activates one dependency hop after this
  // tools-only consumer. The channel is undefined while the deployment leaves
  // patent-data's cniprEnabled off.
  ctx.tools.register(createPatentSearchTool({
    cnipr: () => ctx.get('patentData')?.createCniprChannel(),
  }))
  ctx.tools.register(createPatentMetadataTool({
    cnipr: () => ctx.get('patentData')?.createCniprChannel(),
  }))
  ctx.tools.register(createPatentLegalStatusTool({
    cnipr: () => ctx.get('patentData')?.createCniprChannel(),
  }))

  // Knowledge tools: wire ctx.patentKnowledge when present, else fail loud at execute.
  if (knowledge !== undefined) {
    const wiki = new WikiCardLoader(knowledge.paths.wikiDir)
    ctx.tools.register(createPatentCaseSearchTool({
      search: (q, o) => knowledge.caseLawSearch(q, o),
      dbPath: knowledge.paths.queryDbPath,
    }))
    // 规范原文检索：法规条文与《专利审查指南》全文同出一库（知识库 documents 的两类文档）。
    ctx.tools.register(createLawSearchTool({
      searchLaw: (q, o) => knowledge.legalSearch(q, o),
      searchGuideline: (q, o) => knowledge.guidelineSearch(q, o),
      dbPath: knowledge.paths.queryDbPath,
    }))
    ctx.tools.register(createPatentWikiSearchTool({
      searchIn: (prefix, keyword, limit) => wiki.searchIn(prefix, keyword, limit),
      formatAsContext: (id, maxChars) => wiki.formatAsContext(id, maxChars),
      wikiDir: knowledge.paths.wikiDir,
    }))
    if (existsSync(knowledge.paths.queryDbPath)) {
      const adapter = new PatentKgAdapter(new KgStore(knowledge.paths.queryDbPath))
      // The adapter owns a read-only SQLite handle: close it on plugin dispose so an
      // HMR reload does not accumulate handles (the knowledge service holds its own).
      // The flag keeps a repeated teardown from closing the handle twice.
      let closed = false
      ctx.effect(() => () => {
        /* v8 ignore next -- ctx.effect runs a disposer at most once (its own latch), so a repeated teardown cannot reach the guard */
        if (closed) return
        closed = true
        adapter.close()
      }, 'patent-tools: knowledge graph store')
      ctx.tools.register(createPatentKgQueryTool({ adapter, dbPath: knowledge.paths.queryDbPath }))
    } else {
      ctx.tools.register(createPatentKgQueryTool({ dbPath: knowledge.paths.queryDbPath }))
    }
  } else {
    ctx.tools.register(createPatentCaseSearchTool({}))
    ctx.tools.register(createLawSearchTool({}))
    ctx.tools.register(createPatentWikiSearchTool({}))
    ctx.tools.register(createPatentKgQueryTool({}))
  }

  // Pure deterministic tools.
  ctx.tools.register(createPatentEvalTool())
  ctx.tools.register(createDraftClaimsTool())
  ctx.tools.register(createDraftSpecificationTool())
  ctx.tools.register(createValidateSpecificationTool())
  ctx.tools.register(createRuleCheckTool())
  ctx.tools.register(createClaimLintTool())
  ctx.tools.register(createParseOfficeActionTool())
  ctx.tools.register(createPatentWorkerValidateTool())
  ctx.tools.register(createPatentPlanTaskTool())
  // Workbench case bridge: talk to the personal-workbench plugin's loopback
  // HTTP API. Base URL: explicit config wins; otherwise the in-process
  // webServer port (web profile); absent → the tool fails loud at execute.
  // The service is read dynamically: this package's tsconfig does not
  // reference the host-webserver project, so no declaration merge is pulled in.
  const workbenchWebServer = ctx.get('webServer') as { port: number } | undefined
  const workbenchWebServerPort = workbenchWebServer?.port
  ctx.tools.register(createWorkbenchLinkPatentCaseTool({
    ...(config.workbenchBaseUrl === undefined && workbenchWebServerPort === undefined
      ? {}
      : { baseUrl: config.workbenchBaseUrl ?? `http://127.0.0.1:${workbenchWebServerPort}` }),
    caseRoot: config.workbenchCaseRoot ?? './patent-workspace',
  }))
  ctx.tools.register(createRecognizeChemicalStructureTool({
    // 识别引擎不可用（RDKit 未安装）时 usable 恒 false，该写入闭包不可达；
    // RDKit 接入并产出 usable 结果后移除 ignore（与 recognize 工具内注释呼应）。
    /* v8 ignore next -- dead until the chemistry engine produces a usable result. */
    upsertIndex: entry => chemistryIndexStore.upsert(chemistryIndexFile, entry),
  }))

  // LLM-consuming tools.
  ctx.tools.register(createPatentAnalysisReportTool({ model }))
  ctx.tools.register(createClaimChartBuildTool({ model }))
  ctx.tools.register(createTrizContradictionAnalysisTool({ model }))
  // ctx.jobs backs `run_in_background`: read lazily, because the job registry
  // may load after this plugin; absent means the tool fails loud on that flag.
  // 图模式的规则门评估器在组合点注入：规则语料随 patent-rule 发布，
  // patent-core 只保留端口与引擎。
  ctx.tools.register(createPatentWorkflowRunTool({
    model,
    jobs: () => ctx.get('jobs'),
    ruleEvaluator: createCheckerRuleEvaluator(),
  }))
  ctx.tools.register(createFlexiblePlanTool({ model }))
  ctx.tools.register(createAnalyzePatentFigureTool({
    ...(imageModel === undefined ? {} : { imageModel }),
    ...(gateModel === undefined ? {} : { gateModel }),
    ...(attachments === undefined ? {} : { saveImage: input => attachments.saveImage(input) }),
    ...(resolveImageInputModalitiesFor === undefined ? {} : { resolveImageInputModalities: resolveImageInputModalitiesFor }),
    upsertIndex: entry => figureIndexStore.upsert(figureIndexFile, entry),
    // 两步分析引擎在组合点按 Config 选择注入；缺省 single 由工具内部构造默认单步引擎。
    // 引擎按调用接收模型端口，故这里不需要（也不应）在组合点捕获模型。
    ...(config.figureAnalysisMode === 'two-step'
      ? { analysisEngine: createTwoStepAnalysisEngine() }
      : {}),
  }))

  // Evidence + rule-asset + recap + figure-index + notes.
  ctx.tools.register(createEvaluateEvidenceTool({ ruleDirs: candidateRuleDirs() }))
  ctx.tools.register(createPatentWorkflowTool({}))
  // Search figure index: analyze_patent_figure persists its results through
  // figureIndexStore.upsert into the configured figureIndexFile, which the
  // search tool loads on each call.
  ctx.tools.register(createSearchPatentFigureTool({
    loadIndex: () => figureIndexStore.load(figureIndexFile),
  }))

  // 跨图一致性：对多张附图的分析结果做确定性校验（同一标记跨图同名、图号连续、
  // 权利要求引用齐全）。纯函数、无模型调用；电学符号与网表不在范围。
  ctx.tools.register(createCheckPatentFigureConsistencyTool())

  // 图文比对：把出图时声明的标号清单与 analyze_patent_figure 的识别结果对齐，闭合
  // 「生成 → 识图 → 比对」。确定性比对，不调用模型；连接关系暂不比对。
  ctx.tools.register(createComparePatentFigureAnalysisTool())

  // Figure generation: default renderer is the bundled WASM engine (SVG with no
  // system dependency); PNG/PDF and figureRenderer="cli" go through the dot CLI
  // via ctx.subprocess, failing loud with install guidance when absent.
  const subprocess = ctx.get('subprocess')
  const renderBudgets = resolveRenderBudgets(config)
  const renderDot = pickRenderer(config.figureRenderer, {
    ...(subprocess === undefined ? {} : { subprocess }),
    ...(config.graphvizExecutable === undefined ? {} : { graphvizExecutable: config.graphvizExecutable }),
    graphvizRenderTimeoutMs: renderBudgets.graphvizRenderTimeoutMs,
  })
  // 文字转路径（Config.figureTextToPath）是可选的导出加固：开启时注入端口，关闭时
  // 完全不接线。缺 subprocess 或 Inkscape 时 fail loud（setup_required），不静默
  // 交出仍有字体依赖的图。
  const outlineText: OutlineTextPort | undefined = config.figureTextToPath === true
    ? spec => (subprocess === undefined
      ? Promise.resolve({ ok: false as const, code: 'not_installed' as const, error: '文字转路径需要 subprocess 服务（宿主未挂载 @deepseek-ai/dsh-subprocess）。' })
      : outlineSvgText(subprocess, spec, {
        ...(config.inkscapeExecutable === undefined ? {} : { executable: config.inkscapeExecutable }),
        renderTimeoutMs: renderBudgets.inkscapeRenderTimeoutMs,
      }))
    : undefined
  // 格式导出端口：png/pdf 要落版就必须先出 SVG 再导出，故这一段取决于「本机有没有
  // Inkscape」。可用性在装载时解析一次（与 findFreeCadCmd 同序），工具层据此决定是走
  // 全链还是渲染器直接出图；没有端口时工具层给出「落版与复核未生效」的警告，不静默。
  const exportFigure: ExportFigurePort | undefined = subprocess !== undefined && findInkscape(config.inkscapeExecutable) !== undefined
    ? spec => exportWithInkscape(subprocess, spec, {
      ...(config.inkscapeExecutable === undefined ? {} : { executable: config.inkscapeExecutable }),
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
        ...(config.freecadExecutable === undefined ? {} : { executable: config.freecadExecutable }),
        renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
      }),
      sectionHatch: spec => renderSectionHatch(subprocess, spec, {
        ...(config.freecadExecutable === undefined ? {} : { executable: config.freecadExecutable }),
        renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
      }),
    }
  ctx.tools.register(createGeneratePatentFigureTool({
    render: renderDot,
    ...(outlineText === undefined ? {} : { outlineText }),
    ...(exportFigure === undefined ? {} : { exportFigure }),
    ...(sectionSource === undefined ? {} : { sectionSource }),
    outputDir: resolveFigureOutputDir(config),
    upsertIndex: entry => figureIndexStore.upsert(figureIndexFile, entry),
    loadIndex: async () => (await figureIndexStore.load(figureIndexFile)).entries,
    resolveFont: labels => resolveDotFont(config, labels),
    ...(config.figureRequireCuttingMarks === undefined ? {} : { requireCuttingMarks: config.figureRequireCuttingMarks }),
    ...(config.figureFailOnRenderFindings === undefined ? {} : { failOnRenderFindings: config.figureFailOnRenderFindings }),
    ...(config.figureFontMm === undefined ? {} : { figureFontMm: config.figureFontMm }),
    ...(config.figurePageSize === undefined ? {} : { pageSize: config.figurePageSize }),
    ...(config.figureOrientation === undefined ? {} : { orientation: config.figureOrientation }),
    ...(config.figureDpi === undefined ? {} : { dpi: config.figureDpi }),
    ...(config.figureMargin === undefined ? {} : { marginCm: config.figureMargin }),
  }))
  ctx.tools.register(createAddPatentFigureReferencesTool({}))
  // 渲染复核:量测已生成的 SVG 附图(标号是否被线条贯穿、点划线是否被实线覆盖、相邻
  // 零件剖面线是否可区分、内容是否越出画布)。生成后的自动复核在生成工具内部完成,
  // 本工具供已交付/外部生成的 SVG 做交付前自检。
  ctx.tools.register(createVerifyPatentFigureTool(
    config.figureMinFontMm === undefined ? {} : { minFontMm: config.figureMinFontMm },
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
      ...(config.freecadExecutable === undefined ? {} : { executable: config.freecadExecutable }),
      renderTimeoutMs: renderBudgets.freecadRenderTimeoutMs,
    })
  const structureViews = config.structureFigureViews
  ctx.tools.register(createGenerateStructureFigureTool({
    render: structureRender,
    ...(outlineText === undefined ? {} : { outlineText }),
    ...(config.structureFigureEnabled === undefined ? {} : { enabled: config.structureFigureEnabled }),
    outputDir: resolveFigureOutputDir(config),
    upsertIndex: entry => figureIndexStore.upsert(figureIndexFile, entry),
    ...(config.structureFigureScale === undefined ? {} : { defaultScale: config.structureFigureScale }),
    ...(config.figureFailOnRenderFindings === undefined ? {} : { failOnRenderFindings: config.figureFailOnRenderFindings }),
    ...(structureViews === undefined ? {} : { defaultViews: structureViews }),
  }))

  // PDF download: the runner resolves ctx.patentData per call, because
  // patent-data declares inject:['subprocess'] and therefore activates after
  // this plugin (which injects ['tools'] only) — reading the service here would
  // freeze it as undefined in the shipped ordering. The unified ego stack routes
  // the download to ego-browser only; browseros-neo / playwright / browser-use
  // stay out of the download path, and a host without a usable browser falls
  // back to a browser-free scrape of the CDN link.
  const runEgo = createDownloadChannelRunner(() => ctx.get('patentData'))
  ctx.tools.register(createPatentPdfDownloadTool({
    runEgo,
    fetchImpl: globalThis.fetch,
    resolveRunner: createDownloadRunnerResolver({ runEgo }),
  }))

  // Notes land as files under the configured noteDir (default <cwd>/99-知识库):
  // no storage service dependency, works in headless and web compositions.
  ctx.tools.register(createKnowledgeNoteSaveTool({
    writeNote: createNoteFileWriter(resolveNoteDir(config)),
  }))

  // 案卷留档的唯一写入口：交付前置门禁要求它先成功，交付件才允许落盘。
  ctx.tools.register(createMatterLogAppendTool())
}
