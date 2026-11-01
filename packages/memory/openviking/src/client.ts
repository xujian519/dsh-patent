/**
 * HTTP client for the OpenViking service wire surface (server >= 0.4.15).
 *
 * The client talks HTTP only; it never shells out to the `ov` CLI and never
 * starts a server. All methods unwrap the OpenViking `{status, result, error}`
 * envelope and throw {@link OpenVikingError} on failure, so a call that
 * returns never carries a fake success value.
 * @module @deepseek-ai/dsh-openviking/client
 */

import { isRecord } from '@deepseek-ai/dsh-value'
import { OpenVikingAbortError, OpenVikingError, OpenVikingTimeoutError } from './errors.ts'

/** OpenViking service identity headers. Empty values omit the header. */
export interface ClientCredentials {
  /** Base URL of the OpenViking HTTP service, e.g. `http://127.0.0.1:1934`. */
  readonly endpoint: string
  /** `X-API-Key` header value; empty omits the header. */
  readonly apiKey: string
  /** `X-OpenViking-Account` header value; empty omits the header. */
  readonly account: string
  /** `X-OpenViking-User` header value; empty omits the header. */
  readonly user: string
  /** `X-OpenViking-Agent` header value; empty omits the header. */
  readonly agentId: string
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
}

/** One search hit: a memory, resource, or skill with its L0 abstract. */
export interface SearchItem {
  readonly context_type: 'memory' | 'resource' | 'skill'
  readonly uri: string
  readonly level: number
  readonly score: number
  readonly abstract: string
}

/** Ranked search result with per-category buckets. */
export interface FindResult {
  readonly memories: readonly SearchItem[]
  readonly resources: readonly SearchItem[]
  readonly skills: readonly SearchItem[]
  readonly total: number
}

/** Fields shared by the `find` and `search` request bodies. */
export interface FindQuery {
  readonly query: string
  readonly targetUri: string
  readonly limit: number
  readonly scoreThreshold?: number
  readonly level?: readonly number[]
  readonly contextType?: readonly string[]
}

/** A `viking://` filesystem tree node from the server's agent output. */
export interface TreeNode {
  readonly name?: string | undefined
  readonly path: string
  readonly type: 'file' | 'dir'
  readonly size?: number
  readonly abstract?: string
  readonly children?: readonly TreeNode[]
}

/** Observer queue summary as reported by the server. */
interface QueueStatus {
  readonly name: string
  readonly is_healthy: boolean
  readonly has_errors: boolean
  readonly status: string
}

/** Memory-library statistics for the startup map. */
interface MemoryStats {
  readonly total_memories: number
  readonly by_category: Record<string, number>
}

/** Resolved config handed to the client; credentials are applied verbatim. */
interface RequestOptions {
  readonly body?: unknown
  readonly query?: Record<string, string | number | boolean | undefined>
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** A fetch-compatible function; injected so tests never touch the network. */
export type FetchLike = (input: string, init: {
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string | undefined
  readonly signal: AbortSignal
}) => Promise<ResponseLike>

/** The minimal `Response` surface the client reads. */
export interface ResponseLike {
  readonly status: number
  text(): Promise<string>
}

/** Extract the string code and message from the OpenViking or FastAPI error shape. */
function errorDetailsOf(body: unknown, httpStatus: number): { code: string; message: string } {
  const error = isRecord(body) ? body : {}
  const nested = isRecord(error.error) ? error.error : {}
  let message = `HTTP ${httpStatus}`
  if (typeof error.message === 'string') message = error.message
  else if (typeof nested.message === 'string') message = nested.message
  else if (typeof error.detail === 'string') message = error.detail
  let code = 'HTTP_ERROR'
  if (typeof error.code === 'string') code = error.code
  else if (typeof nested.code === 'string') code = nested.code
  else if (httpStatus === 404) code = 'NOT_FOUND'
  return { code, message }
}

/**
 * OpenViking HTTP client.
 *
 * One instance per plugin mount. Request-facing fields apply live through
 * {@link reconfigure} so a settings change takes effect without a restart.
 */
export class OpenVikingClient {
  /** Base URL of the OpenViking HTTP service (trailing slash trimmed). */
  endpoint: string
  private apiKey: string
  private account: string
  private user: string
  private agentId: string
  private timeoutMs: number
  private readonly fetchImpl: FetchLike

  /**
   * @param credentials - the credential slice to apply.
   * @param fetchImpl - optional fetch replacement for tests.
   */
  constructor(credentials: ClientCredentials, fetchImpl: FetchLike = (input, init) => fetch(input, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  })) {
    this.endpoint = credentials.endpoint.replace(/\/$/, '')
    this.apiKey = credentials.apiKey
    this.account = credentials.account
    this.user = credentials.user
    this.agentId = credentials.agentId
    this.timeoutMs = credentials.timeoutMs
    this.fetchImpl = fetchImpl
  }

  /** Apply a live credentials update (settings save).
   * @param credentials - the new credential slice.
   */
  reconfigure(credentials: ClientCredentials): void {
    this.endpoint = credentials.endpoint.replace(/\/$/, '')
    this.apiKey = credentials.apiKey
    this.account = credentials.account
    this.user = credentials.user
    this.agentId = credentials.agentId
    this.timeoutMs = credentials.timeoutMs
  }

  private headers(): Record<string, string> {
    const result: Record<string, string> = {}
    if (this.apiKey) result['x-api-key'] = this.apiKey
    if (this.account) result['x-openviking-account'] = this.account
    if (this.user) result['x-openviking-user'] = this.user
    if (this.agentId) result['x-openviking-agent'] = this.agentId
    return result
  }

  /** Service health: `GET /health`.
   * @param signal - cancellation signal for the request.
   * @returns the health payload.
   */
  async health(signal?: AbortSignal): Promise<{ status: string; version?: string }> {
    return this.request('GET', '/health', { signal })
  }

  /** Semantic retrieval without session context: `POST /api/v1/search/find`.
   * @param query - search parameters (text, target, limit, threshold).
   * @param options - request options (body, query, signal, timeout).
   * @returns the ranked buckets.
   */
  async find(query: FindQuery, options: RequestOptions = {}): Promise<FindResult> {
    return this.request('POST', '/api/v1/search/find', {
      ...options,
      body: {
        query: query.query,
        target_uri: query.targetUri,
        limit: query.limit,
        score_threshold: query.scoreThreshold,
        level: query.level,
        context_type: query.contextType,
      },
    })
  }

  /** Session-aware retrieval: `POST /api/v1/search/search` (mode `context` budgets server-side).
   * @param query - search parameters plus the session id.
   * @param options - request options.
   * @returns the server-rendered context result.
   */
  async searchContext(query: FindQuery & { readonly sessionId?: string }, options: RequestOptions = {}): Promise<unknown> {
    return this.request('POST', '/api/v1/search/search', {
      ...options,
      body: {
        query: query.query,
        target_uri: query.targetUri,
        session_id: query.sessionId,
        limit: query.limit,
        score_threshold: query.scoreThreshold,
        level: query.level,
        mode: 'context',
      },
    })
  }

  /** Read L0/L1/L2 content for one URI: `GET /api/v1/content/read`.
   * @param uri - the viking:// URI to read.
   * @param level - load tier: abstract, overview, read, or auto.
   * @param signal - cancellation signal for the request.
   * @returns the raw content text.
   */
  async read(uri: string, level: 'abstract' | 'overview' | 'read' | 'auto' = 'auto', signal?: AbortSignal): Promise<string> {
    return this.request('GET', '/api/v1/content/read', { query: { uri, level }, signal })
  }

  /** List a directory tree: `GET /api/v1/fs/tree`.
   * @param uri - the viking:// directory to list.
   * @param options - node and level limits plus cancellation.
   * @returns the tree nodes.
   */
  async tree(uri: string, options: {
    nodeLimit?: number
    levelLimit?: number
    signal?: AbortSignal | undefined
  } = {}): Promise<TreeNode[]> {
    return this.request('GET', '/api/v1/fs/tree', {
      query: { uri, node_limit: options.nodeLimit, level_limit: options.levelLimit },
      signal: options.signal,
    })
  }

  /** Stat one URI: `GET /api/v1/fs/stat`.
   * @param uri - the viking:// URI to stat.
   * @param signal - cancellation signal for the request.
   * @returns the stat payload.
   */
  async stat(uri: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', '/api/v1/fs/stat', { query: { uri }, signal })
  }

  /** Observer queue status: `GET /api/v1/observer/queue`.
   * @param signal - cancellation signal for the request.
   * @returns the queue status payload.
   */
  async queue(signal?: AbortSignal): Promise<QueueStatus> {
    return this.request('GET', '/api/v1/observer/queue', { signal })
  }

  /** Memory-library statistics: `GET /api/v1/stats/memories`.
   * @param signal - cancellation signal for the request.
   * @returns the library statistics payload.
   */
  async memoryStats(signal?: AbortSignal): Promise<MemoryStats> {
    return this.request('GET', '/api/v1/stats/memories', { signal })
  }

  /** Ensure a server-side session exists: `POST /api/v1/sessions`.
   * @param sessionId - OpenViking session id.
   * @param signal - cancellation signal for the request.
   * @returns the creation payload.
   */
  async createSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', '/api/v1/sessions', { body: { session_id: sessionId }, signal })
  }

  /** Read one session's metadata: `GET /api/v1/sessions/{id}`.
   * @param sessionId - OpenViking session id.
   * @param signal - cancellation signal for the request.
   * @returns the session metadata payload.
   */
  async getSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { signal })
  }

  /** Append one message with stable client-side id: `POST /api/v1/sessions/{id}/messages`.
   * @param sessionId - OpenViking session id.
   * @param message - one message to append.
   * @param signal - cancellation signal for the request.
   * @returns the append payload.
   */
  async addMessage(
    sessionId: string,
    message: { role: string; content?: string; parts?: unknown[]; source_message_ids?: string[]; message_kind?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, { body: message, signal })
  }

  /** Append up to 100 messages in one request: `POST /api/v1/sessions/{id}/messages/batch`.
   * @param sessionId - OpenViking session id.
   * @param messages - messages to append (max 100 per batch).
   * @param signal - cancellation signal for the request.
   * @returns the batch payload.
   */
  async addBatch(
    sessionId: string,
    messages: ReadonlyArray<{ role: string; content?: string; parts?: unknown[]; source_message_ids?: string[]; message_kind?: string }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, { body: { messages }, signal })
  }

  /** Commit (archive + extract) a session: `POST /api/v1/sessions/{id}/commit`.
   * @param sessionId - OpenViking session id.
   * @param options - keep count plus cancellation.
   * @returns the commit payload.
   */
  async commit(sessionId: string, options: { keepRecentCount?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      body: { keep_recent_count: options.keepRecentCount ?? 10 },
      signal: options.signal,
    })
  }

  /** Skill playbook by name: `GET /api/v1/skills/{name}`.
   * @param name - Playbook or skill name.
   * @param signal - cancellation signal for the request.
   * @returns the skill payload.
   */
  async getSkill(name: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', `/api/v1/skills/${encodeURIComponent(name)}`, { signal })
  }

  /** Replace a skill playbook: `PUT /api/v1/skills/{name}`.
   * @param name - Playbook or skill name.
   * @param body - the playbook body.
   * @param signal - cancellation signal for the request.
   * @returns the update payload.
   */
  async putSkill(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request('PUT', `/api/v1/skills/${encodeURIComponent(name)}`, { body, signal })
  }

  /** Create a skill playbook: `POST /api/v1/skills`.
   * @param body - OpenViking request body.
   * @param signal - cancellation signal for the request.
   * @returns the creation payload.
   */
  async createSkill(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', '/api/v1/skills', { body, signal })
  }

  /** Write or append text content: `POST /api/v1/content/write`.
   * @param uri - the viking:// target.
   * @param content - the text content to write.
   * @param options - write mode plus cancellation.
   * @returns the write payload.
   */
  async writeContent(uri: string, content: string, options: { mode?: 'replace' | 'append'; signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.request('POST', '/api/v1/content/write', {
      body: { uri, content, mode: options.mode ?? 'append', wait: true },
      signal: options.signal,
    })
  }

  /**
   * One request with timeout, cancellation forwarding, and envelope unwrapping.
   * @param method - the HTTP method.
   * @param path - the endpoint path.
   * @param options - body, query, signal, and per-request timeout.
   * @returns the unwrapped result.
   */
  private async request<T>(method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => { controller.abort('timeout') }, timeoutMs)
    const onAbort = (): void => { controller.abort('caller') }
    if (options.signal) {
      if (options.signal.aborted) controller.abort('caller')
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const url = new URL(`${this.endpoint}${path}`)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    const headers = { ...this.headers(), ...(options.body !== undefined ? JSON_HEADERS : {}) }

    try {
      const response = await Promise.race([
        this.fetchImpl(url.toString(), {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        }),
        abortedPromise(controller, this.endpoint, timeoutMs),
      ])
      const text = await response.text()
      if (controller.signal.aborted) {
        throw controller.signal.reason === 'timeout'
          ? new OpenVikingTimeoutError(this.endpoint, timeoutMs)
          : new OpenVikingAbortError()
      }
      if (response.status === 204) return {} as T
      const parsed: unknown = text.length === 0 ? null : this.parseJson(text, path, response.status)
      return this.unwrap(parsed, response.status, path) as T
    } catch (error) {
      if (error instanceof OpenVikingError) throw error
      if (options.signal?.aborted) throw new OpenVikingAbortError()
      throw new OpenVikingError(this.endpoint, this.networkMessage(error), { code: 'UNAVAILABLE' })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private parseJson(text: string, path: string, status: number): unknown {
    try {
      return JSON.parse(text) as unknown
    } catch {
      if (status >= 200 && status < 300) throw new OpenVikingError(this.endpoint, `invalid JSON response for ${path}`, { code: 'INVALID_JSON', httpStatus: status })
      throw new OpenVikingError(this.endpoint, `HTTP ${status}`, { code: 'INVALID_ERROR_RESPONSE', httpStatus: status })
    }
  }

  private unwrap(body: unknown, httpStatus: number, path: string): unknown {
    if (httpStatus < 200 || httpStatus >= 300) {
      const { code, message } = errorDetailsOf(body, httpStatus)
      throw new OpenVikingError(this.endpoint, message, { code: code as never, httpStatus })
    }
    if (body === null) return body
    if (!isRecord(body)) throw new OpenVikingError(this.endpoint, `invalid response shape for ${path}`, { code: 'INVALID_JSON', httpStatus })
    if (body.status === 'error') {
      const nested = isRecord(body.error) ? body.error : {}
      const message = typeof nested.message === 'string' ? nested.message : 'OpenViking service error'
      const code = typeof nested.code === 'string' ? nested.code : 'HTTP_ERROR'
      throw new OpenVikingError(this.endpoint, message, { code: code as never, httpStatus })
    }
    return body.result ?? body
  }

  private networkMessage(error: unknown): string {
    if (error instanceof Error) {
      return /Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|UND_ERR_CONNECT|network/i.test(error.message)
        ? `service unreachable (${error.message})`
        : error.message
    }
    return 'network error'
  }
}

/** A promise that rejects when the controller aborts, with the right error class.
 * @param controller - the abort source.
 * @param endpoint - the service endpoint for error messages.
 * @param timeoutMs - the deadline for timeout errors.
 * @returns a promise that never resolves.
 */
function abortedPromise(controller: AbortController, endpoint: string, timeoutMs: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(controller.signal.reason === 'timeout'
        ? new OpenVikingTimeoutError(endpoint, timeoutMs)
        : new OpenVikingAbortError())
    }, { once: true })
  })
}
