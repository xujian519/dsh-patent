/**
 * CNIPR（中国知识产权网）通道：在注入的 ego 会话上运行脚本，把收据映射成号码级结果。
 *
 * 通道只做三件事——可用性检查、脚本运行、收据映射；页面交互在 `cnipr-script.ts` 生成的
 * 脚本里，解析在 `cnipr-receipt.ts` 的纯函数里。号码级失败（某个号检索不到、解析不出
 * 申请号）按条目回报，不中断同批其余号；通道级失败（ego 不可用、启动失败、超时、
 * 脚本没回执、登录态失效、页面结构变化）抛 {@link CniprChannelError}，由调用方决定是否
 * 按号回退到别的通道。调用方取消不是通道失败，统一抛 `AbortError`。
 * @module @deepseek-ai/dsh-patent-data/cnipr-channel
 */

import { CNIPR_LEGAL_TAG, CNIPR_PDF_TAG, CNIPR_SEARCH_TAG, DEFAULT_CNIPR_PAGE_BUDGETS, buildCniprLegalScript, buildCniprPdfLinksScript, buildCniprSearchScript } from './cnipr-script.ts'
import { SerialQueue } from './serial-queue.ts'
import {
  alignCniprResults,
  planCniprLegalQueries,
  planCniprPdfRequests,
  planCniprSearchRequest,
  readCniprLegalPayload,
  readCniprPdfLinksPayload,
  readCniprSearchPayload,
} from './cnipr-receipt.ts'
import type {
  CniprCallOptions,
  CniprChannelOptions,
  CniprEgoSession,
  CniprFailureCode,
  CniprLegalStatusItem,
  CniprPageBudgets,
  CniprPdfLinkItem,
  CniprSearchOptions,
  CniprSearchResult,
} from './types.ts'

/** 脚本没有回传收据时附在原因里的输出长度（诊断用，避免把整段输出塞进错误）。 */
const OUTPUT_TAIL_LENGTH = 400

/** 一次脚本运行的会话结果；`CniprEgoSession.runScript` 的解析值。 */
type CniprScriptRun = Awaited<ReturnType<CniprEgoSession['runScript']>>

/** 请求过但脚本没有回报的号：按缺失处理，不静默丢弃。 */
function cniprPdfMissing(number: string): CniprPdfLinkItem {
  return { number, urls: [], unexamined: false, authorized: false, error: '脚本未回报该号' }
}

/** 请求过但脚本没有回报的号（法律状态）。 */
function cniprLegalMissing(number: string): CniprLegalStatusItem {
  return { number, appNumber: '', total: null, records: [], error: '脚本未回报该号' }
}

/**
 * CNIPR 通道的失败。分类让调用方按码路由（`login_required` 要用户去登录，`setup_required`
 * 要装 ego lite，`page_state`/`receipt_missing` 是站点或运行时变化），`detail` 保留原样原因。
 */
export class CniprChannelError extends Error {
  /** 失败分类。 */
  readonly code: CniprFailureCode
  /** 原样原因（脚本回报的消息或会话给出的原因）。 */
  readonly detail: string

  /**
   * @param code - 失败分类。
   * @param detail - 原样原因。
   * @param options - 原始原因（保留为 `cause`，供诊断启动失败这类被包装的错误）。
   */
  constructor(code: CniprFailureCode, detail: string, options: { cause?: unknown } = {}) {
    super(`CNIPR 通道失败（${code}）：${detail}`, options)
    this.name = 'CniprChannelError'
    this.code = code
    this.detail = detail
  }
}

/**
 * CNIPR 通道：按名复用同一个 ego 任务空间，因此登录态由 ego lite 提供、本通道不做登录。
 */
export class CniprChannel {
  private readonly session: CniprEgoSession
  private readonly queue: SerialQueue
  private readonly timeoutMs: number | undefined
  private readonly pageBudgets: CniprPageBudgets
  private readonly cwd: string

  /**
   * @param options - 注入的 ego 会话、共享串行队列、单次运行的期限、页面等待预算与工作目录。
   */
  constructor(options: CniprChannelOptions) {
    this.session = options.session
    this.queue = options.queue ?? new SerialQueue()
    this.timeoutMs = options.timeoutMs
    this.pageBudgets = { ...DEFAULT_CNIPR_PAGE_BUDGETS, ...options.pageBudgets }
    this.cwd = options.cwd ?? process.cwd()
  }

  /**
   * 按公开(公告)号取全文 PDF 直链。非公开号形态的号不发给脚本，按条目报错。
   * @param numbers - 公开(公告)号列表（调用方已归一去重）。
   * @param options - 本次调用的取消信号与期限覆盖。
   * @returns 与请求顺序一一对应的每条号结果。
   */
  async pdfLinks(numbers: readonly string[], options: CniprCallOptions = {}): Promise<CniprPdfLinkItem[]> {
    const { requested, unsupported } = planCniprPdfRequests(numbers)
    if (requested.length === 0) return alignCniprResults(numbers, unsupported, cniprPdfMissing)
    const payload = await this.run(buildCniprPdfLinksScript(requested, this.pageBudgets), CNIPR_PDF_TAG, options)
    const read = readCniprPdfLinksPayload(payload)
    if (read.failure !== undefined) throw new CniprChannelError(read.failure.code, read.failure.message)
    return alignCniprResults(numbers, [...read.items, ...unsupported], cniprPdfMissing)
  }

  /**
   * 查询 CN 号的法律状态：申请号直接查，公开(公告)号先解析申请号；非中国号形态的号
   * 不发给脚本，按条目报错。
   * @param numbers - 申请号或公开(公告)号列表（调用方已归一去重）。
   * @param options - 本次调用的取消信号与期限覆盖。
   * @returns 与请求顺序一一对应的每条号结果。
   */
  async legalStatus(numbers: readonly string[], options: CniprCallOptions = {}): Promise<CniprLegalStatusItem[]> {
    const { queries, unsupported } = planCniprLegalQueries(numbers)
    if (queries.length === 0) return alignCniprResults(numbers, unsupported, cniprLegalMissing)
    const payload = await this.run(buildCniprLegalScript(queries, this.pageBudgets), CNIPR_LEGAL_TAG, options)
    const read = readCniprLegalPayload(payload)
    if (read.failure !== undefined) throw new CniprChannelError(read.failure.code, read.failure.message)
    return alignCniprResults(numbers, [...read.items, ...unsupported], cniprLegalMissing)
  }

  /**
   * 关键词检索：结果页直接发布标题、申请人、公开日与摘要，故一次检索只做页面导航，
   * 不逐条取详情页。
   * @param query - 检索词（调用方已确认不含 Google 专有的字段语法）。
   * @param options - 期望条数、取消信号与期限覆盖。
   * @returns 总数与命中；条数按 {@link planCniprSearchRequest} 收敛后截断。
   */
  async search(query: string, options: CniprSearchOptions = {}): Promise<CniprSearchResult> {
    const request = planCniprSearchRequest(options.limit)
    const payload = await this.run(buildCniprSearchScript(query, request.pages, this.pageBudgets), CNIPR_SEARCH_TAG, options)
    const read = readCniprSearchPayload(payload)
    if (read.failure !== undefined) throw new CniprChannelError(read.failure.code, read.failure.message)
    // 检索结果不按请求号对齐，被丢弃的行不会出现在 hits 里；把它报成页面结构失败，
    // 否则结果会被当作完整命中集交给检索阶段。
    if (read.dropped > 0) {
      throw new CniprChannelError(
        'page_state',
        `CNIPR 检索结果页丢弃了 ${read.dropped} 行无法解析的结果：页面结构可能已变化`,
      )
    }
    if (read.total === null) {
      throw new CniprChannelError('page_state', 'CNIPR 检索结果页未给出「全部 N 件专利」总数：页面结构可能已变化')
    }
    return { total: read.total, hits: read.hits.slice(0, request.limit) }
  }

  /** 运行一个脚本并取回未校验的载荷；通道级失败在这里分类。 */
  private async run(script: string, tag: string, options: CniprCallOptions): Promise<unknown> {
    return this.queue.run(async () => {
      // 排队期间调用方可能已取消：拿到执行权后先检查，避免启动一个已作废的浏览器脚本。
      options.signal?.throwIfAborted()
      const availability = this.session.checkAvailability()
      if (!availability.ok) {
        throw new CniprChannelError('setup_required', availability.reason ?? 'ego-browser 不可用；请先安装 ego lite 并完成首次引导。')
      }
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      let result: CniprScriptRun
      try {
        result = await this.session.runScript(script, {
          cwd: this.cwd,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        // 取消优先于启动失败：它仍以 AbortError 传播；其余运行异常按通道错误码分类，
        // 否则按 code 路由的调用方只能读到一条没有分类的普通 Error。
        options.signal?.throwIfAborted()
        throw new CniprChannelError(
          'setup_required',
          error instanceof Error ? error.message : String(error),
          { cause: error },
        )
      }
      // 脚本启动后调用方可能才取消：运行结果已作废，先抛 AbortError，
      // 既不写回结果，也不把取消误报成超时或收据缺失。
      options.signal?.throwIfAborted()
      if (result.timedOut) {
        throw new CniprChannelError('timeout', `CNIPR 脚本超出期限（exit ${result.exitCode ?? 'null'}）`)
      }
      // 合并输出按头部截断，脚本的收据写在末尾时可能已被截掉；stderr 原样保留。
      const payload = this.session.extractTaggedJson(result.output, tag)
        ?? this.session.extractTaggedJson(result.stderr ?? '', tag)
      if (payload === null || payload === undefined) {
        throw new CniprChannelError(
          'receipt_missing',
          `脚本未回传 ${tag} 收据（exit ${result.exitCode ?? 'null'}）：${result.output.slice(-OUTPUT_TAIL_LENGTH)}`,
        )
      }
      return payload
    })
  }
}
