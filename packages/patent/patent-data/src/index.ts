/**
 * Service Definition for the patent data seam (ctx.patentData): the nuo search
 * provider factory (LRU-cached over the vendored @deepseek-ai/nuo-patent engine),
 * the patent result cache, the structured metadata mapper, the ego-browser
 * anti-crawl session runner over the injected subprocess service, and the
 * persistence/path helpers ported from Sati.
 * @module @deepseek-ai/dsh-patent-data
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { StageProvider } from '@deepseek-ai/dsh-patent-core'
import { createNuoSearchProvider } from './search-provider.ts'
import {
  DEFAULT_EGO_COMMAND_NAME,
  DEFAULT_EGO_MAX_OUTPUT_BYTES,
  DEFAULT_EGO_MAX_TIMEOUT_MS,
  DEFAULT_EGO_PROBE_TIMEOUT_MS,
  DEFAULT_EGO_TIMEOUT_MS,
  EgoBrowserSession,
} from './ego-session.ts'
import { SubprocessEgoSpawnRunner } from './subprocess-runner.ts'
import { applyNuoRequestChannel } from './nuo-channel.ts'
import { CniprChannel } from './cnipr-channel.ts'
import { DEFAULT_CNIPR_PAGE_BUDGETS } from './cnipr-script.ts'
import { SerialQueue } from './serial-queue.ts'
import { NUO_REQUEST_CHANNELS } from './types.ts'
import type { CniprChannelOverrides, CniprPageBudgets, CreateNuoSearchProviderOptions, EgoSessionOptions, NuoRequestChannel } from './types.ts'

export { createNuoSearchProvider } from './search-provider.ts'
export {
  AsyncResultCache,
  cachedScrapePatent,
  cachedSearchPatents,
  isScrapeResultCacheable,
  isSearchResultCacheable,
  scrapeCacheKey,
  searchCacheKey,
} from './patent-cache.ts'
export { mapPatentData, parseJsonArray } from './mapper.ts'
export { EGO_HEREDOC_MARKER, EgoBrowserSession, normalizePatentNumber } from './ego-session.ts'
export {
  DEFAULT_EGO_COMMAND_NAME,
  DEFAULT_EGO_MAX_OUTPUT_BYTES,
  DEFAULT_EGO_MAX_TIMEOUT_MS,
  DEFAULT_EGO_PROBE_TIMEOUT_MS,
  DEFAULT_EGO_TIMEOUT_MS,
} from './ego-session.ts'
export { SubprocessEgoSpawnRunner } from './subprocess-runner.ts'
export { applyNuoRequestChannel, NUO_EGO_BROWSER_ENV } from './nuo-channel.ts'
export { CniprChannel, CniprChannelError } from './cnipr-channel.ts'
export { SerialQueue } from './serial-queue.ts'
export {
  CNIPR_LEGAL_TAG,
  CNIPR_PDF_TAG,
  CNIPR_SEARCH_TAG,
  CNIPR_TASK_SPACE,
  DEFAULT_CNIPR_PAGE_BUDGETS,
  buildCniprLegalScript,
  buildCniprPdfLinksScript,
  buildCniprSearchScript,
} from './cnipr-script.ts'
export {
  CNIPR_BASE_URL,
  CNIPR_LOGIN_HINT_PATTERN,
  CNIPR_NUMBER_KINDS,
  CNIPR_PDF_URL_PATTERN,
  CNIPR_RESULT_APP_NUMBER_PATTERN,
  CNIPR_SEARCH_MAX_HITS,
  CNIPR_SEARCH_PAGE_SIZE,
  alignCniprResults,
  classifyCniprNumber,
  normalizeCniprAppNumber,
  normalizeCniprDate,
  normalizeCniprPdfUrls,
  parseCniprLegalRecords,
  parseCniprSearchTotal,
  planCniprLegalQueries,
  planCniprPdfRequests,
  planCniprSearchRequest,
  readCniprLegalPayload,
  readCniprPdfLinksPayload,
  readCniprSearchPayload,
  readCniprScriptFailure,
} from './cnipr-receipt.ts'
export type { CniprNumberKind } from './cnipr-receipt.ts'
export { CNIPR_FAILURE_CODES, NUO_REQUEST_CHANNELS } from './types.ts'
// Persistence/path helpers live in dsh-patent-core (single home); re-exported
// here so the data seam keeps its historical public surface.
export { JsonFileStore, SAFE_ID_PATTERN, assertSafeId, atomicWriteJson } from '@deepseek-ai/dsh-patent-core'
export {
  CASE_OUTPUTS_REL,
  CASE_ROOT_REL,
  CASE_WORKFLOW_RUNS_REL,
  caseOutputsDir,
  caseWorkflowRunsDir,
} from '@deepseek-ai/dsh-patent-core'
export type {
  CniprCallOptions,
  CniprChannelOptions,
  CniprChannelOverrides,
  CniprEgoSession,
  CniprFailureCode,
  CniprLegalQuery,
  CniprLegalRecord,
  CniprLegalStatusItem,
  CniprPageBudgets,
  CniprPdfLinkItem,
  CniprScriptFailure,
  CniprScriptFailureCode,
  CniprSearchHit,
  CniprSearchOptions,
  CniprSearchRequest,
  CniprSearchResult,
  CreateNuoSearchProviderOptions,
  EgoAvailability,
  EgoRunOptions,
  EgoScriptResult,
  EgoSessionOptions,
  EgoSpawnResult,
  EgoSpawnRunner,
  EgoSpawnSpec,
  NuoRequestChannel,
  PatentCacheOptions,
  StructuredPatentData,
} from './types.ts'

/**
 * Deployment-varying patent-data configuration. The ego-browser command, its
 * probe and run deadlines, and the output cap differ between hosts (a wrapper
 * on the PATH, a slower machine, a larger scrape), so each is a validated
 * field here; every default is the value the seam shipped before it was
 * configurable, and a per-call option still overrides it. The CNIPR page waits
 * are the same kind of value: site latency, login-state refresh, and network
 * conditions decide them per deployment, so every step the generated scripts
 * wait on is a field rather than a literal.
 */
export interface Config {
  /** ego-browser CLI command name (default `ego-browser`). */
  commandName: string
  /** Connection-probe timeout in milliseconds (default 8000). */
  probeTimeoutMs: number
  /** Default ego-browser run timeout in milliseconds (default 90000). */
  defaultTimeoutMs: number
  /** Hard cap applied to a per-run timeout in milliseconds (default 300000). */
  maxTimeoutMs: number
  /** Soft cap in bytes for the merged run output (default 500000). */
  maxOutputBytes: number
  /**
   * Channel the nuo engine's requests travel over (default `auto`). `native`
   * forces the plain fetch, `browser` the ego-browser path, and `fallback` keeps
   * the plain fetch first while retrying connection failures through the browser.
   * Because nuo reads the choice from a process environment variable, setting an
   * explicit value writes `NUO_PATENT_EGO_BROWSER` for the whole process — every
   * consumer of the vendored engine in it, not just this service.
   */
  nuoRequestChannel: NuoRequestChannel
  /**
   * 是否让本部署经 CNIPR（search.cnipr.com）取中国专利全文与法律状态（默认 false）。
   * 通道复用 ego lite 的 CNIPR 登录态，因此没有该登录态的部署打开它只会得到
   * `login_required`；关闭时 {@link PatentData.createCniprChannel} 返回 undefined，
   * 消费方据此按号回退到 nuo 引擎，并在结果里点名实际服务的通道。
   */
  cniprEnabled: boolean
  /** CNIPR 登录态轮询间隔（毫秒，默认 1000）。 */
  cniprLoginPollMs: number
  /** 每轮 CNIPR 登录态轮询次数（默认 10）。 */
  cniprLoginAttempts: number
  /** CNIPR 登录态轮询轮数；除最后一轮外每轮结束 reload 首页（默认 2）。 */
  cniprLoginRounds: number
  /** CNIPR 页面导航期限（毫秒，默认 45000）：首页 goto/reload 与检索结果页 URL。 */
  cniprNavigationTimeoutMs: number
  /** CNIPR 点击与表单提交期限（毫秒，默认 15000）。 */
  cniprActionTimeoutMs: number
  /** CNIPR 结果页结构出现期限（毫秒，默认 30000）：详情表单、法律状态表单与结果 URL、翻页标记。 */
  cniprResultTimeoutMs: number
  /** CNIPR 结果内容渲染期限（毫秒，默认 20000）：结果行、申请号、法律状态结果标题。 */
  cniprRenderTimeoutMs: number
  /** CNIPR 详情检索接口的响应期限（毫秒，默认 20000）。 */
  cniprDetailTimeoutMs: number
}

/**
 * The ego-browser defaults one deployment resolved: every field filled by
 * {@link PatentData.Config}, which materializes each default once.
 */
type ResolvedEgoDefaults = Required<Pick<EgoSessionOptions, 'commandName' | 'probeTimeoutMs' | 'defaultTimeoutMs' | 'maxTimeoutMs' | 'maxOutputBytes'>>

/**
 * PatentData service: the patent data seam (ctx.patentData). It exposes the nuo
 * search provider factory and the ego-browser session runner over the injected
 * subprocess service.
 */
export class PatentData extends Service {
  static inject = ['subprocess']

  /** Schemastery configuration for the sessions and runners this service builds. */
  static Config: z<Partial<Config>, Config> = z.object({
    commandName: z.string().min(1).default(DEFAULT_EGO_COMMAND_NAME),
    probeTimeoutMs: z.natural().min(1).default(DEFAULT_EGO_PROBE_TIMEOUT_MS),
    defaultTimeoutMs: z.natural().min(1).default(DEFAULT_EGO_TIMEOUT_MS),
    maxTimeoutMs: z.natural().min(1).default(DEFAULT_EGO_MAX_TIMEOUT_MS),
    maxOutputBytes: z.natural().min(1).default(DEFAULT_EGO_MAX_OUTPUT_BYTES),
    nuoRequestChannel: z.union(NUO_REQUEST_CHANNELS).default('auto'),
    cniprEnabled: z.boolean().default(false),
    cniprLoginPollMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.loginPollMs),
    cniprLoginAttempts: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.loginAttempts),
    cniprLoginRounds: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.loginRounds),
    cniprNavigationTimeoutMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.navigationTimeoutMs),
    cniprActionTimeoutMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.actionTimeoutMs),
    cniprResultTimeoutMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.resultTimeoutMs),
    cniprRenderTimeoutMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.renderTimeoutMs),
    cniprDetailTimeoutMs: z.natural().min(1).default(DEFAULT_CNIPR_PAGE_BUDGETS.detailTimeoutMs),
  })

  private readonly egoDefaults: ResolvedEgoDefaults
  private readonly cniprBudgets: CniprPageBudgets
  private readonly cniprRuns = new SerialQueue()
  private readonly cniprEnabled: boolean

  constructor(ctx: Context, config: Config = PatentData.Config({})) {
    // Resolve and validate before super() registers the service: an invalid
    // mount must fail without leaving a half-registered ctx.patentData behind.
    const egoDefaults = resolveEgoDefaults(config)
    const cniprBudgets = resolveCniprBudgets(config)
    super(ctx, 'patentData')
    this.egoDefaults = egoDefaults
    this.cniprBudgets = cniprBudgets
    this.cniprEnabled = config.cniprEnabled
    const restoreNuoChannel = applyNuoRequestChannel(config.nuoRequestChannel)
    if (restoreNuoChannel !== undefined) {
      ctx.effect(() => restoreNuoChannel, 'patent-data: nuo request channel')
    }
  }

  /**
   * Build a nuo-backed search provider (default: LRU-cached nuo searchPatents).
   * @param options - optional search-function injection.
   * @returns the provider for the workflow atoms' search stage.
   */
  createSearchProvider(options?: CreateNuoSearchProviderOptions): StageProvider {
    return createNuoSearchProvider(options)
  }

  /**
   * Build an ego-browser session runner backed by the injected subprocess service.
   * @param options - session options; each one overrides the same-named Config field, and a runner overrides the subprocess-backed default.
   * @returns the ego-browser session.
   */
  createEgoSession(options?: EgoSessionOptions): EgoBrowserSession {
    return new EgoBrowserSession({
      ...this.egoDefaults,
      ...options,
      runner: options?.runner ?? new SubprocessEgoSpawnRunner(this.ctx.subprocess, {
        maxOutputBytes: this.egoDefaults.maxOutputBytes,
      }),
    })
  }

  /**
   * Build a CNIPR channel over an ego-browser session, or nothing when this deployment
   * has not enabled the channel (`Config.cniprEnabled`, default false).
   * @param options - optional per-channel overrides; a channel option replaces the same-named field
   * the service resolved, and a `pageBudgets` entry replaces only that wait.
   * @returns the channel, or undefined while CNIPR is disabled.
   */
  createCniprChannel(options: CniprChannelOverrides = {}): CniprChannel | undefined {
    if (!this.cniprEnabled) return undefined
    const { pageBudgets, ...rest } = options
    return new CniprChannel({
      session: this.createEgoSession(),
      queue: this.cniprRuns,
      pageBudgets: { ...this.cniprBudgets, ...pageBudgets },
      ...rest,
    })
  }
}

/**
 * Resolve the ego-browser defaults from the validated Config fields.
 *
 * The checks repeat the schema's constraints because a caller may construct the
 * service directly with a hand-built Config; a zero or inverted deadline would
 * otherwise turn every run into an immediate timeout instead of failing at load.
 * @param config - the service's validated configuration.
 * @returns the ego-browser defaults the service builds every session over.
 * @throws when a value is not a positive integer or the run default exceeds its cap.
 */
function resolveEgoDefaults(config: Config): ResolvedEgoDefaults {
  const resolved: ResolvedEgoDefaults = {
    commandName: config.commandName,
    probeTimeoutMs: positiveInteger('probeTimeoutMs', config.probeTimeoutMs),
    defaultTimeoutMs: positiveInteger('defaultTimeoutMs', config.defaultTimeoutMs),
    maxTimeoutMs: positiveInteger('maxTimeoutMs', config.maxTimeoutMs),
    maxOutputBytes: positiveInteger('maxOutputBytes', config.maxOutputBytes),
  }
  if (resolved.commandName.length === 0) {
    throw new Error('patent-data Config: commandName must not be empty')
  }
  if (resolved.defaultTimeoutMs > resolved.maxTimeoutMs) {
    throw new Error(
      `patent-data Config: defaultTimeoutMs (${resolved.defaultTimeoutMs}) must not exceed maxTimeoutMs (${resolved.maxTimeoutMs})`,
    )
  }
  return resolved
}

/**
 * Resolve the CNIPR page budgets from the validated Config fields.
 *
 * The checks repeat the schema's constraints because a caller may construct the
 * service directly with a hand-built Config; a zero deadline would otherwise turn
 * every page wait into an immediate timeout instead of failing at load.
 * @param config - the service's validated configuration.
 * @returns the page budgets every channel the service creates starts from.
 * @throws when a value is not a positive integer.
 */
function resolveCniprBudgets(config: Config): CniprPageBudgets {
  return {
    loginPollMs: positiveInteger('cniprLoginPollMs', config.cniprLoginPollMs),
    loginAttempts: positiveInteger('cniprLoginAttempts', config.cniprLoginAttempts),
    loginRounds: positiveInteger('cniprLoginRounds', config.cniprLoginRounds),
    navigationTimeoutMs: positiveInteger(
      'cniprNavigationTimeoutMs',
      config.cniprNavigationTimeoutMs,
    ),
    actionTimeoutMs: positiveInteger('cniprActionTimeoutMs', config.cniprActionTimeoutMs),
    resultTimeoutMs: positiveInteger('cniprResultTimeoutMs', config.cniprResultTimeoutMs),
    renderTimeoutMs: positiveInteger('cniprRenderTimeoutMs', config.cniprRenderTimeoutMs),
    detailTimeoutMs: positiveInteger('cniprDetailTimeoutMs', config.cniprDetailTimeoutMs),
  }
}

/**
 * Require a positive integer configuration value.
 * @param name - the Config field name used in the error message.
 * @param value - the value to check.
 * @returns the value unchanged.
 * @throws when the value is not an integer of at least 1.
 */
function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`patent-data Config: ${name} must be a positive integer, got ${String(value)}`)
  }
  return value
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    patentData: PatentData
  }
}

export default PatentData
