/**
 * Errors thrown by the OpenViking HTTP client and tool surface.
 *
 * Every error carries the endpoint so a serving profile can be identified
 * from a single log line, and a stable `code` for the model to act on.
 * Credentials never appear in error text.
 * @module @deepseek-ai/dsh-openviking/errors
 */

/** Error categories exposed to callers and diagnostics. */
type OpenVikingErrorCode =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_JSON'
  | 'INVALID_ERROR_RESPONSE'
  | 'NOT_FOUND'
  | 'HTTP_ERROR'

/** An OpenViking service call failed. */
export class OpenVikingError extends Error {
  /** Stable error category callers and diagnostics key on. */
  readonly code: OpenVikingErrorCode
  /** The OpenViking service base URL that failed. */
  readonly endpoint: string
  /** HTTP status from the server, when the failure reached it. */
  readonly httpStatus?: number | undefined

  /**
   * @param endpoint - Base URL of the OpenViking HTTP service.
   * @param message - the failure message.
   * @param detail - the error category and optional HTTP status.
   */
  constructor(endpoint: string, message: string, detail: { code: OpenVikingErrorCode; httpStatus?: number }) {
    super(`${message} (${endpoint})`)
    this.name = 'OpenVikingError'
    this.code = detail.code
    this.endpoint = endpoint
    this.httpStatus = detail.httpStatus
  }
}

/** The request crossed the configured per-request deadline. */
export class OpenVikingTimeoutError extends OpenVikingError {
  /**
   * @param endpoint - Base URL of the OpenViking HTTP service.
   * @param timeoutMs - the crossed per-request deadline in milliseconds.
   */
  constructor(endpoint: string, timeoutMs: number) {
    super(endpoint, `request timed out after ${timeoutMs}ms`, { code: 'TIMEOUT' })
    this.name = 'OpenVikingTimeoutError'
  }
}

/** The caller's abort signal cancelled the request. */
export class OpenVikingAbortError extends Error {
  constructor() {
    super('The operation was aborted')
    this.name = 'OpenVikingAbortError'
  }
}
