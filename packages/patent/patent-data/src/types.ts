/**
 * Type declarations for the patent data seam: the nuo search-provider factory
 * options, the structured patent metadata mapping, the cache tuning options,
 * and the ego-browser session/subprocess vocabulary.
 * @module @deepseek-ai/dsh-patent-data/types
 */

import type { Citation, PatentSearchResult } from '@deepseek-ai/nuo-patent'
import type { SerialQueue } from './serial-queue.ts'

/**
 * The channel nuo requests travel over. `native` uses the plain fetch, `browser`
 * the ego-browser path, `fallback` the plain fetch with the ego-browser path as
 * a connection-failure fallback, and `auto` nuo's own availability probe.
 */
export const NUO_REQUEST_CHANNELS = ['auto', 'native', 'browser', 'fallback'] as const

/** One nuo request channel: see {@link NUO_REQUEST_CHANNELS}. */
export type NuoRequestChannel = (typeof NUO_REQUEST_CHANNELS)[number]

/** Options for the nuo search-provider factory. */
export interface CreateNuoSearchProviderOptions {
  /** Injected search function; defaults to the LRU-cached nuo `searchPatents`. */
  search?: (query: string, options?: { limit?: number }) => Promise<PatentSearchResult>
}

/** Structured patent metadata: the nuo JSON-string fields parsed into arrays. */
export interface StructuredPatentData {
  patent: string
  url: string
  title: string
  applicationNumber: string
  inventors: string[]
  assigneesOriginal: string[]
  assigneesCurrent: string[]
  pubDate: string
  filingDate: string
  priorityDate: string
  grantDate: string
  expirationDate: string
  legalStatus: string
  ifiStatus: string
  estimatedExpiration: string
  pdfUrl: string
  classifications: string[]
  backwardCites: Citation[]
  forwardCites: Citation[]
  abstractText: string
}

/** Cache tuning options for the search and scrape result caches. */
export interface PatentCacheOptions {
  /** Entry TTL in milliseconds (default 10 minutes). */
  ttlMs?: number
  /** Maximum LRU entries (default 100). */
  maxEntries?: number
}

/**
 * CNIPR 通道的失败分类。`setup_required`（含脚本启动失败）、`timeout`、`receipt_missing`
 * 与畸形收据的 `page_state` 由通道判定；`login_required` 与脚本自报的 `page_state` 由脚本
 * 回传。调用方取消不属于通道失败：它按 `AbortError` 传播，不占用这里的分类码。
 */
export const CNIPR_FAILURE_CODES = ['setup_required', 'timeout', 'receipt_missing', 'login_required', 'page_state'] as const

/** One CNIPR channel failure: see {@link CNIPR_FAILURE_CODES}. */
export type CniprFailureCode = (typeof CNIPR_FAILURE_CODES)[number]

/** 脚本自身能回传的两类失败（其余由通道侧判定）。 */
export type CniprScriptFailureCode = Extract<CniprFailureCode, 'login_required' | 'page_state'>

/** 脚本回传的失败：分类 + 可读原因。 */
export interface CniprScriptFailure {
  code: CniprScriptFailureCode
  message: string
}

/** 一条号码的全文 PDF 直链结果（CNIPR 检索通道）。 */
export interface CniprPdfLinkItem {
  /** 请求里原样的号。 */
  number: string
  /** 已归一化为 `http://` 的全文 PDF 直链（去重后）；`pic.cnipr.com` 仅 HTTP 可达。 */
  urls: string[]
  /** 该号在 CNIPR 是否属发明申请公布。 */
  unexamined: boolean
  /** 该号在 CNIPR 是否属发明授权公告。 */
  authorized: boolean
  /** 该号单条失败的原因（不中断同批其余号）。 */
  error?: string
}

/** CNIPR 法律状态结果页里的一条记录。 */
export interface CniprLegalRecord {
  app_number: string
  announce_date: string
  status: string
  status_info: string
}

/** 一条号码的法律状态结果。 */
export interface CniprLegalStatusItem {
  number: string
  /** 实际查询用的申请号（由公开(公告)号查询时经结果页解析得出）。 */
  appNumber: string
  /** 由公开(公告)号解析出申请号时，记录原公开(公告)号。 */
  resolvedFrom?: string
  /** 页面上的「共 N 条记录」；零命中的结果页不输出该标记，此时为 null。 */
  total: number | null
  records: CniprLegalRecord[]
  /** 该号单条失败的原因（不中断同批其余号）。 */
  error?: string
}

/** 一次法律状态查询的目标：申请号或公开(公告)号，由调用方按号形态给出。 */
export interface CniprLegalQuery {
  /** 请求里原样的号（结果里回填）。 */
  number: string
  /** 申请号（`app` 形态时给出）。 */
  appNumber?: string
  /** 公开(公告)号（`pub` 形态时给出）；脚本先按它检索出申请号。 */
  pubNumber?: string
}

/** CNIPR 检索结果页里的一条命中；字段值域与页面发布的内容一致。 */
export interface CniprSearchHit {
  /** 公开(公告)号；结果行以 `pnm` 属性发布，缺失时回退到行内「公开(公告)号：」字段。 */
  patent: string
  /** 标题；取自结果行标题元素的 `title` 属性，不含序号与关键词高亮。 */
  title: string
  /** 申请(专利权)人；联合申请按页面原样给出。 */
  assignee: string
  /** 公开(公告)日，已由页面写法 `YYYY.MM.DD` 归一为 `YYYY-MM-DD`。 */
  publicationDate: string
  /** 摘要原文（页面的关键词高亮是标记，取文本时已消失）。 */
  abstract: string
}

/** 一次 CNIPR 关键词检索的结果。 */
export interface CniprSearchResult {
  /** 页面分类导航给出的「全部 N 件专利」；零命中页输出 0，故 0 是真实零命中。 */
  total: number
  hits: CniprSearchHit[]
}

/** 一次检索请求的执行计划：归一后的条数与要读取的结果页数。 */
export interface CniprSearchRequest {
  /** 归一后的期望条数（1..30）。 */
  limit: number
  /** 要读取的结果页数（1..3）。 */
  pages: number
}

/** 一次 CNIPR 检索调用的可选项。 */
export interface CniprSearchOptions extends CniprCallOptions {
  /** 期望命中条数；通道按每页 10 条翻页取满，单次上限 30。 */
  limit?: number
}

/** CNIPR 通道消费的 ego 会话面；`EgoBrowserSession` 结构性满足它。 */
export interface CniprEgoSession {
  /** 可用性检查；非 ok 时通道以 setup_required 失败。 */
  checkAvailability: () => { ok: boolean; reason?: string }
  /** 以 stdin 运行一个脚本并收集输出；`stderr` 原样保留，供合并输出被截断时找回收据。 */
  runScript: (script: string, options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<{
    output: string
    stderr?: string
    exitCode: number | null
    timedOut: boolean
  }>
  /** 取输出里第一条 `EGO_<tag>:<json>` 载荷。 */
  extractTaggedJson: (output: string, tag: string) => unknown
}

/**
 * CNIPR 生成脚本的页面等待预算。站点响应速度、登录态刷新节奏与部署网络都会改变这些
 * 等待的合理取值，故每一项都由部署配置；默认值是通道落地时的站点实测值。
 */
export interface CniprPageBudgets {
  /** 登录态轮询间隔（毫秒）。 */
  loginPollMs: number
  /** 每轮登录态轮询次数。 */
  loginAttempts: number
  /** 登录态轮询轮数；除最后一轮外，每轮结束 reload 首页。 */
  loginRounds: number
  /** 页面导航期限（首页 goto/reload、检索结果页 URL）。 */
  navigationTimeoutMs: number
  /** 点击与表单提交期限。 */
  actionTimeoutMs: number
  /** 结果页结构出现期限（详情检索表单、法律状态表单与结果 URL、翻页标记）。 */
  resultTimeoutMs: number
  /** 结果内容渲染期限（结果行、申请号、法律状态结果标题）。 */
  renderTimeoutMs: number
  /** 详情检索接口的响应期限。 */
  detailTimeoutMs: number
}

/** 构造一个 CNIPR 通道的选项。 */
export interface CniprChannelOptions {
  /** 注入的 ego 会话（生产：`ctx.patentData.createEgoSession()`）。 */
  session: CniprEgoSession
  /**
   * 驱动同一任务空间的通道共用的串行队列。服务传入自己的实例；
   * 直接构造通道时缺省为本通道私有队列，多个通道之间不串行。
   */
  queue?: SerialQueue
  /** 单次脚本运行的期限（毫秒）；缺省取会话自己的默认期限，并受其硬上限约束。 */
  timeoutMs?: number
  /**
   * 页面等待预算；未给出的字段沿用通道默认值，服务创建通道时传入自己解析的完整预算。
   * 它只调单步等待，不改变脚本整体期限（`timeoutMs`）。
   */
  pageBudgets?: Partial<CniprPageBudgets>
  /** 脚本运行的工作目录（默认 `process.cwd()`）；脚本不落盘，它只作子进程 cwd。 */
  cwd?: string
}

/** 构造 CNIPR 通道时可覆盖的字段；服务拥有会话与串行队列。 */
export type CniprChannelOverrides = Omit<CniprChannelOptions, 'session' | 'queue'>

/** 一次 CNIPR 通道调用的可选项。 */
export interface CniprCallOptions {
  /**
   * 取消信号；获得执行权后立即检查，已取消则不启动脚本。
   * 排队等待期间不占用脚本期限，取消要等到前一个脚本结束才返回。
   */
  signal?: AbortSignal
  /** 覆盖本次运行的期限（毫秒），缺省取通道的 `timeoutMs`。 */
  timeoutMs?: number
}

/** One collected ego-browser run: merged/truncated output plus stream and exit facts. */
export interface EgoScriptResult {
  /** stdout+stderr merged and truncated to the session's output cap. */
  output: string
  /** Raw collected stdout. */
  stdout: string
  /** Raw collected stderr. */
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

/** Ego-browser availability: ready, unavailable on this platform, or setup required. */
export type EgoAvailability = { ok: true } | { ok: false; code: 'unavailable' | 'setup_required'; reason: string }

/** Options for one ego-browser script run. */
export interface EgoRunOptions {
  cwd: string
  /** Whole-run timeout; defaults to the session's defaultTimeoutMs. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

/** Options for constructing an ego-browser session. */
export interface EgoSessionOptions {
  /** CLI command name (default "ego-browser"). */
  commandName?: string
  /** Connection-probe timeout in milliseconds (default 8_000). */
  probeTimeoutMs?: number
  /** Default run timeout in milliseconds (default 90_000). */
  defaultTimeoutMs?: number
  /** Hard cap for per-run timeoutMs (default 300_000). */
  maxTimeoutMs?: number
  /** Home directory used to locate `~/.local/bin` (default os.homedir()). */
  homeDir?: string
  /** Extra PATH directories for the spawn env and the availability probe (default `[<home>/.local/bin]`). */
  pathEntries?: string[]
  /** Soft cap in bytes for the merged output; truncation keeps whole UTF-8 characters (default 500_000). */
  maxOutputBytes?: number
  /** Platform override (default process.platform). */
  platform?: NodeJS.Platform
  /** Environment override for the probe, availability check, and script runs (default process.env). */
  env?: NodeJS.ProcessEnv
  /** Spawn runner seam (defaults to the subprocess-backed runner). */
  runner?: EgoSpawnRunner
}

/** One fully-specified ego-browser spawn request. */
export interface EgoSpawnSpec {
  /** Executable and arguments; argv[0] is the program. */
  argv: readonly string[]
  /** Script text to write to stdin (absent for argument-only invocations). */
  stdinData?: string
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

/** One settled ego-browser spawn result. */
export interface EgoSpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/** The spawn-capable seam the ego-session runner consumes. */
export interface EgoSpawnRunner {
  /**
   * Run one argv+stdin spawn and collect its settled result.
   * @param spec - executable, arguments, stdin, directory, environment, deadline, and cancellation.
   * @returns the settled exit, output, timeout, and duration facts.
   */
  spawn(spec: EgoSpawnSpec): Promise<EgoSpawnResult>
}
