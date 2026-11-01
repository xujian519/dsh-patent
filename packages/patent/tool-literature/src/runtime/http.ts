/**
 * 学术文献连接器共享 HTTP 层（在核心 networkFetch 之上包装）。
 *
 * 核心网络层已提供超时/重试/退避/Retry-After/结构化错误。文献场景在此之上
 * 补充三件事（设计引入自 OpenScience connectors/http.ts）：
 *   - per-host 礼貌限速：arXiv 要求 ≤1 req/3s、keyless Semantic Scholar ~1s。
 *     按 URL host 排队，多库并发 fan-out 不会被过度串行化。
 *   - 进程内 GET 短 TTL 缓存 + `looksValid` 谓词：空 body 或非预期格式
 *     （HTML 错误页）不缓存，防污染。
 *   - Accept 内容协商：默认 "* / *"（arXiv Atom、PubMed EFetch 等 XML 源），
 *     JSON 连接器经 `getJSON` 显式声明。
 *
 * 本层服务的全部是免费、公开、无 API key 的数据源；需要鉴权的源应在连接器
 * 内显式叠加，不写在这里。
 */
import { networkFetch, type NetworkRetryOptions } from '../network-fetch.ts'

/** per-host 礼貌限速（最小间隔与最大并发）。 */
export interface LiteratureRateLimit {
  /** 同一 host 两次请求开始之间的最小间隔（ms）。 */
  minIntervalMs?: number
  /** 同一 host 最大并发在途请求数。 */
  maxConcurrent?: number
}

/** LiteratureHttpClient 请求选项（超时、缓存、限速、重试等）。 */
export interface LiteratureFetchOptions {
  /** 请求超时（默认 30s）。 */
  timeoutMs?: number
  /** 外部取消信号；已中止的信号在发起网络请求前即拒绝。 */
  signal?: AbortSignal
  /** GET 缓存 TTL（ms）；0 禁用（默认 5 分钟）。 */
  cacheTtlMs?: number
  /**
   * 缓存门：返回 `false` 阻止 2xx body 进缓存（如源返回了 HTML/空内容而非
   * 预期负载）。空 body 一律不缓存。
   */
  looksValid?: (body: string) => boolean
  /** 内容协商 Accept 头（默认 "* / *"）。 */
  accept?: string
  /** 额外请求头（如 Semantic Scholar 的 x-api-key）。 */
  headers?: Record<string, string>
  /** 可选 per-host 礼貌限速。 */
  rateLimit?: LiteratureRateLimit
  /** 重试配置（默认 3 次指数退避）。 */
  retry?: NetworkRetryOptions
  /** 覆盖 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
}

/** 文献 HTTP 响应（ok、状态码、body）。 */
interface LiteratureResponse {
  ok: boolean
  status: number
  body: string
}

/** 非 2xx 终态响应（重试耗尽后）；`status` + 截断 body 供调用方诊断。 */
class LiteratureHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LiteratureHttpError'
  }
}

const USER_AGENT = 'dsh-tool-literature/0.1 (+https://github.com/deepseek-ai/deepseek-harness)'

/** 单次文献请求的超时默认值（ms）。 */
export const DEFAULT_TIMEOUT_MS = 30_000
/** GET 进程内缓存的 TTL 默认值（ms）。 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000
/** 重试预算默认值：3 次重试、1s 起指数退避、单次退避上限 15s。 */
export const DEFAULT_RETRY: Required<Pick<NetworkRetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
}
/** 缓存条目上限：超限按 LRU 淘汰最久未访问项，防止长时间运行（分页检索等）无限增长。 */
const MAX_CACHE_ENTRIES = 500

/** Whether a body parses as JSON, used to keep non-JSON 200 responses out of the GET cache. */
function isJsonBody(body: string): boolean {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/**
 * 部署网络预算（超时/缓存/重试）。连接器构造选项与本插件的 `Config` 都以此
 * 承载同一组值：随部署改变的部分（代理、内网镜像、离线或限流环境）由
 * `Config` 出口决定，未配置时落回上面的 `DEFAULT_*`。
 */
export interface LiteratureBudgetOptions {
  /** 单次请求超时（ms）；省略用 {@link DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** GET 缓存 TTL（ms）；0 禁用；省略用 {@link DEFAULT_CACHE_TTL_MS}。 */
  cacheTtlMs?: number
  /** 重试预算；省略用 {@link DEFAULT_RETRY}。 */
  retry?: NetworkRetryOptions
}

/** 一条 GET 缓存条目。 */
interface CacheEntry {
  expires: number
  body: string
}

/** 等待 per-host 并发槽位的请求。 */
interface HostWaiter {
  resolve: () => void
  cleanup: () => void
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * 中止原因：调用方给出的 `Error` 原样透传，其余归一为 `Error`。
 * @param reason - `AbortSignal.reason`（可能是任意值）。
 * @returns 可安全作为 `throw` 参数与 `error.message` 读取的 `Error`。
 */
export function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('request aborted')
}

/** 可取消的睡眠：`signal` 中止时以中止原因拒绝并清掉定时器。 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal === undefined) return new Promise((resolve) => { setTimeout(resolve, ms) })
  const aborting = signal
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(aborting.reason))
    }
    const timer = setTimeout(() => {
      aborting.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    aborting.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 一个文献 HTTP 客户端：拥有 per-host 限速/并发状态与 GET 缓存。
 *
 * 一个 registry 创建一个实例并注入其全部连接器，因此限速与缓存按部署共享，
 * 而不是按模块全局共享；独立实例之间互不影响（测试可各自持有）。
 */
export class LiteratureHttpClient {
  /** 每个 host 下一次允许开始的时间戳（ms）。 */
  private readonly nextStart = new Map<string, number>()
  /** 每个 host 当前在途请求计数；对象身份同时充当 `release` 持有的槽位句柄。 */
  private readonly active = new Map<string, { count: number }>()
  /** 每个 host 等待并发槽位的队列。 */
  private readonly waiters = new Map<string, Set<HostWaiter>>()
  /** GET 缓存：键含方法与 Accept 头，值带过期时间。 */
  private readonly cache = new Map<string, CacheEntry>()

  /**
   * 执行一次带超时/重试/限速/缓存的 HTTP 请求。
   *
   * 网络层错误（DNS/超时/连接）以 `NetworkFetchError` 上抛；HTTP 非 2xx 在
   * 重试耗尽后原样返回（`ok: false`），由 `getText`/`getJSON` 转为
   * `LiteratureHttpError`。空 body 或未通过 `looksValid` 的 2xx body 不缓存。
   * 调用方中止会取消排队和 pacing 等待，并以中止原因拒绝。GET 缓存命中
   * 返回 `ok: true` 与 `status: 200`，不保留原始 2xx 状态码。
   *
   * 已知边界：pace 门控的是本次请求的"开始"；`networkFetch` 内部的指数退避
   * 重试不再过闸（重试间隔由退避/Retry-After 决定，可能短于 minIntervalMs）。
   * 因此 pace 保证的是外部调用方的请求节奏，不覆盖单次请求内部的重试风暴——
   * 源返回 429 时 networkFetch 尊重 Retry-After，无该头时按退避间隔重试。
   * @param url - 请求 URL。
   * @param opts - 请求选项（超时、取消、缓存、限速、重试等）。
   * @returns 响应结果（ok、状态码、body）。
   */
  async request(url: string, opts: LiteratureFetchOptions = {}): Promise<LiteratureResponse> {
    const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    // 缓存键并入 Accept（getText 与 getJSON 对同一 URL 的结果不可互换），
    // 避免内容协商结果互相污染。
    const cacheKey = ttl > 0 ? `GET ${opts.accept ?? '*/*'} ${url}` : undefined
    if (cacheKey) {
      const hit = this.cache.get(cacheKey)
      if (hit && hit.expires > Date.now()) {
        // 刷新 LRU 顺序（重新插入到尾部）
        this.cache.delete(cacheKey)
        this.cache.set(cacheKey, hit)
        return { ok: true, status: 200, body: hit.body }
      }
      if (hit) this.cache.delete(cacheKey)
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: opts.accept ?? '*/*',
      ...(opts.headers ?? {}),
    }

    const done = await this.throttle(url, opts.rateLimit, opts.signal)
    try {
      const res = await networkFetch(
        url,
        { headers, signal: opts.signal },
        {
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: opts.signal,
          fetchImpl: opts.fetchImpl,
          retry: opts.retry ?? DEFAULT_RETRY,
        },
      )
      const body = await res.text()
      // 只缓存健康的 2xx 响应；空 body / looksValid 拒绝的 body 一律不缓存。
      const valid = res.ok && body.trim().length > 0 && (opts.looksValid?.(body) ?? true)
      if (cacheKey && valid) this.cacheSet(cacheKey, { expires: Date.now() + ttl, body })
      return { ok: res.ok, status: res.status, body }
    } finally {
      done()
    }
  }

  /**
   * GET + 文本。非 2xx 抛 `LiteratureHttpError`。
   * @param url - 请求 URL。
   * @param opts - 可选请求选项。
   * @returns 响应文本。
   */
  async getText(url: string, opts?: LiteratureFetchOptions): Promise<string> {
    const res = await this.request(url, opts)
    if (!res.ok) {
      throw new LiteratureHttpError(res.status, `HTTP ${res.status} for ${url}: ${res.body.slice(0, 500)}`)
    }
    return res.body
  }

  /**
   * GET + JSON（默认 Accept: application/json）。
   * @param url - 请求 URL。
   * @param opts - 可选请求选项。
   * @returns 解析出的 JSON 值。
   */
  async getJSON<T = unknown>(url: string, opts?: LiteratureFetchOptions): Promise<T> {
    const looksValid = opts?.looksValid
    const res = await this.request(url, {
      ...opts,
      accept: opts?.accept ?? 'application/json',
      // `request` caches the raw body before this method parses it, so an HTML
      // error page with status 200 would otherwise be served from cache for the
      // whole TTL and keep failing as "Non-JSON response".
      looksValid: body => isJsonBody(body) && (looksValid?.(body) ?? true),
    })
    if (!res.ok) {
      throw new LiteratureHttpError(res.status, `HTTP ${res.status} for ${url}: ${res.body.slice(0, 500)}`)
    }
    try {
      return JSON.parse(res.body) as T
    } catch (error) {
      throw new Error(`Non-JSON response from ${url}: ${res.body.slice(0, 500)}`, { cause: error })
    }
  }

  /** 占用 pacing 与并发闸门；返回完成后调用的 `release`。 */
  private async throttle(
    url: string,
    limit: LiteratureRateLimit | undefined,
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    const host = hostOf(url)
    if (!host || !limit) return () => {}
    if (signal?.aborted) throw abortReason(signal.reason)
    if (limit.minIntervalMs !== undefined && limit.minIntervalMs > 0) {
      await this.pace(host, limit.minIntervalMs, signal)
    }
    if (limit.maxConcurrent !== undefined && limit.maxConcurrent > 0) {
      return this.acquire(host, limit.maxConcurrent, signal)
    }
    return () => {}
  }

  /**
   * 预约该 host 的下一次开始时间并等待到点。空闲窗口中的首个请求立即返回；
   * 其后的每个请求保持到上一个请求开始 `minIntervalMs` 之后。
   */
  private async pace(host: string, minIntervalMs: number, signal: AbortSignal | undefined): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, this.nextStart.get(host) ?? 0)
    this.nextStart.set(host, start + minIntervalMs)
    await sleep(start - now, signal)
  }

  /** 占用一个在途槽位并返回释放函数；达 `maxConcurrent` 则排队等待，中止时退出队列。 */
  private async acquire(host: string, maxConcurrent: number, signal: AbortSignal | undefined): Promise<() => void> {
    const state = this.active.get(host) ?? { count: 0 }
    this.active.set(host, state)
    if (state.count < maxConcurrent) {
      state.count += 1
      return () => {
        this.release(host, state)
      }
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(host) ?? new Set<HostWaiter>()
      this.waiters.set(host, queue)
      if (signal === undefined) {
        queue.add({ resolve, cleanup: () => {} })
        return
      }
      const aborting = signal
      const waiter: HostWaiter = {
        resolve,
        cleanup: () => {
          aborting.removeEventListener('abort', onAbort)
        },
      }
      const onAbort = (): void => {
        queue.delete(waiter)
        reject(abortReason(aborting.reason))
      }
      aborting.addEventListener('abort', onAbort, { once: true })
      queue.add(waiter)
    })
    // 槽位由上一个持有者直接移交，计数保持不变。
    return () => {
      this.release(host, state)
    }
  }

  /** 释放一个在途槽位，直接转交给下一个等待者（如有）。 */
  private release(host: string, state: { count: number }): void {
    const queue = this.waiters.get(host)
    if (queue !== undefined) {
      const next = queue.values().next()
      if (!next.done) {
        queue.delete(next.value)
        next.value.cleanup()
        next.value.resolve()
        return
      }
    }
    state.count -= 1
  }

  /** 写入缓存并维护 LRU 顺序（Map 插入序 = 最近访问序）。 */
  private cacheSet(key: string, value: CacheEntry): void {
    this.cache.delete(key)
    this.cache.set(key, value)
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      // size > MAX_CACHE_ENTRIES 时 map 非空，迭代器必然产出首个键。
      const oldest = this.cache.keys().next() as IteratorYieldResult<string>
      this.cache.delete(oldest.value)
    }
  }
}
