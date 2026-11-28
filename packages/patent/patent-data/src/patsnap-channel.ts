/**
 * PatSnap 通道：按公开号从 PatSnap Open Platform 的 P020 接口取 PDF 直链。
 *
 * 通道只做 HTTP 与期限管理：号码校验、错误码分类和响应对齐在 `patsnap-receipt.ts`
 * 的纯函数里。逐号失败（格式不对、没有记录、没有 PDF）按条目回报，不中断同批其余号；
 * 通道级失败（缺少 Key、鉴权、权限、余额、限流、超时、协议变化）抛
 * {@link PatsnapChannelError}，由调用方决定是否保留原有的失败原因。
 * 调用方取消不是通道失败，统一按 `AbortError` 传播。
 * @module @deepseek-ai/dsh-patent-data/patsnap-channel
 */

import {
  isPatsnapNumber,
  normalizePatsnapNumber,
  readPatsnapPdfPayload,
} from './patsnap-receipt.ts'
import type {
  PatsnapCallOptions,
  PatsnapChannelOptions,
  PatsnapFailureCode,
  PatsnapPdfLinkItem,
  PatsnapPdfLinksResult,
} from './types.ts'

/** 默认网关。 */
const DEFAULT_BASE_URL = 'https://connect.patsnap.com'
/** 单次请求默认期限。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 每次请求默认携带的号码数。 */
const DEFAULT_BATCH_SIZE = 20
/** 限流重试的一次等待上限。 */
const MAX_RETRY_DELAY_MS = 5_000

/**
 * PatSnap 通道的失败。`code` 供调用方路由（缺 Key、余额不足、限流各自处理），
 * `detail` 保留原样原因；错误消息不包含 Key 或带签名的下载地址。
 */
export class PatsnapChannelError extends Error {
  /** 失败分类。 */
  readonly code: PatsnapFailureCode
  /** 原样原因。 */
  readonly detail: string

  /**
   * @param code - 失败分类。
   * @param detail - 原样原因。
   * @param options - 原始原因（保留为 `cause`）。
   */
  constructor(code: PatsnapFailureCode, detail: string, options: { cause?: unknown } = {}) {
    super(`PatSnap 通道失败（${code}）：${detail}`, options)
    this.name = 'PatsnapChannelError'
    this.code = code
    this.detail = detail
  }
}

/** 一次批请求的原始结果。 */
interface BatchResponse {
  payload: unknown
  amount: number
}

/** 从响应头读计费量；缺头或非法值按 0。 */
function readAmount(headers: Headers): number {
  const raw = headers.get('x-openapi-amount')
  if (raw === null || raw.length === 0) return 0
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** 解析 `Retry-After`：秒数或 HTTP 日期；上限 {@link MAX_RETRY_DELAY_MS}。 */
function retryDelayMs(headers: Headers): number {
  const raw = headers.get('retry-after')
  if (raw === null) return 1_000
  const seconds = Number.parseFloat(raw)
  const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now()
  if (!Number.isFinite(value) || value <= 0) return 1_000
  return Math.min(value, MAX_RETRY_DELAY_MS)
}

/** 等待一段时间；调用方取消时立即结束（含进入等待前已中止）。 */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * PatSnap 通道：批量取 PDF 直链，按请求顺序返回逐号结果。
 */
export class PatsnapChannel {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly batchSize: number
  private readonly replaceByRelated: boolean
  private readonly fetchImpl: typeof fetch | undefined

  /**
   * @param options - Key、网关、期限、批量大小与同族替代开关。
   * @throws {PatsnapChannelError} Key 为空，或批量/期限不是正整数。
   */
  constructor(options: PatsnapChannelOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new PatsnapChannelError('missing_key', 'PatSnap API Key 为空')
    }
    if (!Number.isInteger(options.batchSize ?? DEFAULT_BATCH_SIZE) || (options.batchSize ?? DEFAULT_BATCH_SIZE) < 1) {
      throw new PatsnapChannelError('bad_request', `batchSize 必须是正整数，收到 ${String(options.batchSize)}`)
    }
    if (!Number.isInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1) {
      throw new PatsnapChannelError('bad_request', `timeoutMs 必须是正整数，收到 ${String(options.timeoutMs)}`)
    }
    this.apiKey = options.apiKey.trim()
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    this.replaceByRelated = options.replaceByRelated ?? true
    this.fetchImpl = options.fetchImpl
  }

  /**
   * 按公开号取 PDF 直链。形态不合法的号不发请求，直接按条目报错。
   * @param numbers - 公开(公告)号列表；重复号只请求一次，结果按原顺序回填。
   * @param options - 本次调用的期限覆盖与取消信号。
   * @returns 与请求顺序一一对应的逐号结果与服务端计费量。
   * @throws {PatsnapChannelError} 通道级失败（鉴权、权限、余额、限流、超时、协议变化）。
   */
  async pdfLinks(numbers: readonly string[], options: PatsnapCallOptions = {}): Promise<PatsnapPdfLinksResult> {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const raw of numbers) {
      const number = normalizePatsnapNumber(raw)
      if (number.length === 0 || seen.has(number)) continue
      seen.add(number)
      unique.push(number)
    }

    const results = new Map<string, PatsnapPdfLinkItem>()
    const requestable: string[] = []
    for (const number of unique) {
      if (isPatsnapNumber(number)) {
        requestable.push(number)
      } else {
        results.set(number, { number, code: 'invalid_number', error: '号码形态不是公开(公告)号' })
      }
    }

    let amount = 0
    for (let offset = 0; offset < requestable.length; offset += this.batchSize) {
      const batch = requestable.slice(offset, offset + this.batchSize)
      const response = await this.requestBatch(batch, options)
      amount += response.amount
      const read = readPatsnapPdfPayload(response.payload, batch)
      if (read.failure !== undefined) {
        throw new PatsnapChannelError(read.failure.code, read.failure.message)
      }
      for (const item of read.items) results.set(item.number, item)
    }

    const items = numbers.map((raw): PatsnapPdfLinkItem => {
      const number = normalizePatsnapNumber(raw)
      return results.get(number) ?? { number, code: 'not_found', error: 'PatSnap 未返回该号' }
    })
    return { items, amount }
  }

  /** 发送一批号码；429/503 按 `Retry-After` 重试一次。 */
  private async requestBatch(numbers: readonly string[], options: PatsnapCallOptions): Promise<BatchResponse> {
    const first = await this.requestOnce(numbers, options)
    if (first.retry === undefined) return { payload: first.payload, amount: first.amount }
    await sleep(first.retry, options.signal)
    options.signal?.throwIfAborted()
    const second = await this.requestOnce(numbers, options)
    if (second.retry !== undefined) {
      throw new PatsnapChannelError(
        second.status === 429 ? 'rate_limited' : 'upstream_error',
        `PatSnap 持续返回 HTTP ${second.status}`,
      )
    }
    return { payload: second.payload, amount: second.amount }
  }

  /** 发送一次请求；返回载荷、计费量或限流重试建议。 */
  private async requestOnce(
    numbers: readonly string[],
    options: PatsnapCallOptions,
  ): Promise<BatchResponse & { retry?: number; status?: number }> {
    const fetchFn = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new PatsnapChannelError('network_error', '当前运行时没有可用的 fetch')
    }
    // 逐调用只能收紧部署设定的上限：批次数由批量大小决定，放大单次期限会让一次
    // 50 篇兜底轻易越过工具的整腿预算。
    const timeoutMs = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const query = numbers.map(number => encodeURIComponent(number)).join(',')
    const url = `${this.baseUrl}/basic-patent-data/pdf-data?patent_number=${query}&replace_by_related=${this.replaceByRelated ? '1' : '0'}`
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal,
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (timeout.aborted) {
        throw new PatsnapChannelError('timeout', `PatSnap 请求超出期限（${timeoutMs}ms）`)
      }
      throw new PatsnapChannelError('network_error', error instanceof Error ? error.message : String(error), { cause: error })
    }

    const amount = readAmount(response.headers)
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel()
      return { payload: undefined, amount, retry: retryDelayMs(response.headers), status: response.status }
    }
    if (response.status === 401) {
      throw new PatsnapChannelError('auth_failed', 'PatSnap 拒绝该 API Key（HTTP 401）')
    }
    if (response.status === 403) {
      throw new PatsnapChannelError('permission_denied', '该 API Key 无权访问 P020（HTTP 403）')
    }
    if (!response.ok) {
      throw new PatsnapChannelError(
        response.status >= 500 ? 'upstream_error' : 'bad_request',
        `PatSnap 返回 HTTP ${response.status}`,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new PatsnapChannelError('invalid_response', 'PatSnap 响应不是合法 JSON', { cause: error })
    }
    return { payload, amount }
  }
}
