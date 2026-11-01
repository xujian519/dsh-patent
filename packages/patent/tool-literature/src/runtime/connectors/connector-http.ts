/**
 * 连接器共享的 HTTP 装配：一个共享客户端 + 其请求预算（超时/缓存/重试/限速）。
 *
 * registry 注入同一个客户端时，各连接器共用 per-host 限速与 GET 缓存；单独
 * 构造连接器时各自持有。调用方给 `rateLimit` 时覆盖该连接器的默认限速。
 * @module @deepseek-ai/dsh-tool-literature/runtime/connectors/connector-http
 */

import {
  LiteratureHttpClient,
  type LiteratureBudgetOptions,
  type LiteratureFetchOptions,
  type LiteratureRateLimit,
} from '../http.ts'

/** 连接器工厂共有的 HTTP 注入项：共享客户端与部署预算。 */
export interface ConnectorHttpOptions extends LiteratureBudgetOptions {
  /** 覆盖 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 覆盖该连接器的默认 per-host 限速（测试注入小值/0）。 */
  rateLimit?: LiteratureRateLimit
  /** 共享 HTTP 客户端（registry 注入；省略时连接器自建）。 */
  client?: LiteratureHttpClient
}

/** 连接器工厂需要的客户端与其请求选项。 */
interface ConnectorHttp {
  client: LiteratureHttpClient
  http: LiteratureFetchOptions
}

/**
 * 装配一个连接器的 HTTP 客户端与请求选项。
 * @param options - 连接器工厂收到的注入项。
 * @param defaultRateLimit - 该连接器未配置 `rateLimit` 时使用的默认限速。
 * @returns 共享（或新建）的客户端与请求选项。
 */
export function connectorHttp(options: ConnectorHttpOptions, defaultRateLimit?: LiteratureRateLimit): ConnectorHttp {
  return {
    client: options.client ?? new LiteratureHttpClient(),
    http: {
      fetchImpl: options.fetchImpl,
      rateLimit: options.rateLimit ?? defaultRateLimit,
      timeoutMs: options.timeoutMs,
      cacheTtlMs: options.cacheTtlMs,
      retry: options.retry,
    },
  }
}
