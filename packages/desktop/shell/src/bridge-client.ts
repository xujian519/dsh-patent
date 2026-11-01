/**
 * JSON-RPC 2.0 client over a local Unix domain socket / Windows named pipe.
 * The desktop shell provider uses this to reach the Electron main process.
 * @module @deepseek-ai/dsh-desktop-shell/bridge-client
 */

import { createConnection, type Socket } from 'node:net'

/** Outgoing JSON-RPC request. */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** Incoming JSON-RPC response. */
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/** Incoming JSON-RPC notification (server push). */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** The JSON-RPC server returned an error response. */
export class BridgeRpcError extends Error {
  /**
   * @param code - JSON-RPC error code from the server.
   * @param message - server-supplied error description.
   */
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'BridgeRpcError'
  }
}

/** Lifecycle callbacks for the bridge client. */
interface BridgeClientOptions {
  /** Local socket path (Unix) or pipe name (Windows). */
  path: string
  /** A server-pushed notification arrived. */
  onNotification: (notification: JsonRpcNotification) => void
  /** The socket closed. */
  onClose: () => void
  /** Reconnection policy and hook, when the client should recover an unexpected close. */
  reconnect?: {
    /** How many reconnection attempts before giving up (default 10). */
    retries?: number
    /** Base backoff delay between attempts (default 500ms). */
    baseDelayMs?: number
    /** Maximum backoff delay (default 5000ms). */
    maxDelayMs?: number
  }
  /** A reconnection succeeded after an unexpected close. */
  onReconnect?: () => void
}

/** One pending request keyed by JSON-RPC id. */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** Caller signal the pending call waits on, when one was passed. */
  signal?: AbortSignal
  /** Abort listener bound to `signal`; removed when the request settles. */
  onAbort?: () => void
}

/**
 * Line-delimited JSON-RPC client. Methods return promises; notifications are
 * forwarded through {@link BridgeClientOptions.onNotification}. An unexpected
 * close schedules reconnection with exponential backoff while the client is
 * not disposed; pending calls reject at the close, and the caller decides
 * whether to retry its own work after {@link BridgeClientOptions.onReconnect}.
 */
export class BridgeClient {
  private socket: Socket | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private disposed = false
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: BridgeClientOptions) {
    this.connect(true)
  }

  /**
   * Create a socket and promote it to the live bridge once it connects.
   * Pre-connection failures stay local to the attempt: the client-level
   * close/reconnect handling only ever runs for an established connection.
   * @param initial - whether this is the first connection (no replay hook).
   */
  private connect(initial: boolean): void {
    const socket = createConnection(this.options.path)
    socket.setEncoding('utf8')
    const promote = (): void => {
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      this.socket = socket
      this.reconnectAttempts = 0
      socket.on('data', (chunk: string) => { this.onData(chunk) })
      socket.on('close', () => { this.onClose() })
      socket.on('error', (error) => { this.onError(error) })
      if (!initial) this.options.onReconnect?.()
    }
    const onError = (): void => { socket.destroy() }
    const onClose = (): void => {
      socket.destroy()
      if (initial) {
        // A first-connect failure is a genuine bridge outage: the socket Main
        // promised never came up. Report it like any other loss, then let the
        // backoff retry recover a Main that was still starting at plugin load.
        this.onClose()
      } else {
        this.scheduleReconnect()
      }
    }
    socket.once('connect', promote)
    socket.once('error', onError)
    socket.once('close', onClose)
  }

  /** True if the socket is currently connected. */
  get connected(): boolean {
    return this.socket?.readyState === 'open'
  }

  /**
   * Call a method on the Electron main bridge and await its result.
   * @param method - JSON-RPC method name.
   * @param params - method parameters.
   * @param signal - caller lifetime; abort rejects the pending call and
   * discards any later server response.
   * @returns the method result.
   * @throws {BridgeRpcError} when the server returns a JSON-RPC error.
   * @throws {Error} when the socket is closed or disposed.
   * @throws {DOMException} `AbortError` when `signal` aborts.
   */
  call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('bridge client is disposed'))
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 'open') return Promise.reject(new Error('bridge socket is not connected'))
    const id = this.nextId++
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      const pending: PendingRequest = { resolve, reject }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(new DOMException('aborted', 'AbortError'))
        }
        pending.signal = signal
        pending.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, pending)
      try {
        socket.write(JSON.stringify(request) + '\n')
      } catch (error) {
        // A synchronous write failure (the main process died between the
        // readyState check and the write) must settle the entry, or the call
        // hangs until an abort that may never come.
        this.settle(id, pending, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  /**
   * Send a one-way notification to the Electron main bridge.
   * @param method - JSON-RPC method name.
   * @param params - notification parameters.
   */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 'open') return
    const notification = { jsonrpc: '2.0', method, params }
    socket.write(JSON.stringify(notification) + '\n')
  }

  private settle(id: number, pending: PendingRequest, error: Error | null, result?: unknown): void {
    this.pending.delete(id)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    if (error === null) {
      pending.resolve(result)
    } else {
      pending.reject(error)
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.settle(id, pending, error)
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    /* v8 ignore next -- split('\n') always yields at least one element, so pop() is never nullish */
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      this.onFrame(line)
    }
  }

  private onFrame(line: string): void {
    let frame: JsonRpcResponse | JsonRpcNotification
    try {
      frame = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification
    } catch {
      // Ignore a malformed frame: the peer is our own Main process, and one
      // bad line must not kill the bridge.
      return
    }
    if ('id' in frame && typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      if (frame.error !== undefined) {
        this.settle(frame.id, pending, new BridgeRpcError(frame.error.code, frame.error.message))
      } else {
        this.settle(frame.id, pending, null, frame.result)
      }
    } else if ('method' in frame) {
      this.options.onNotification(frame)
    }
  }

  private onClose(): void {
    // Dispose closes the socket itself; that close must not surface as a
    // bridge loss to listeners.
    if (this.disposed) return
    this.rejectAllPending(new Error('bridge socket closed'))
    this.options.onClose()
    this.scheduleReconnect()
  }

  private onError(error: Error): void {
    this.rejectAllPending(error)
  }

  /**
   * Backoff delay for the next reconnect attempt (exponential, capped).
   *
   * The defaults in `options.reconnect` below are the request/default spec of an
   * existing optional surface: `desktop/shell` is the only construction site and
   * takes them unchanged, so the reconnection policy belongs to the deployment
   * that builds the client rather than to a plugin `Config` field.
   */
  private reconnectDelay(): number {
    const base = this.options.reconnect?.baseDelayMs ?? 500
    const max = this.options.reconnect?.maxDelayMs ?? 5_000
    return Math.min(base * 2 ** this.reconnectAttempts, max)
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const retries = this.options.reconnect?.retries ?? 10
    if (this.reconnectAttempts >= retries) return
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      /* v8 ignore next -- dispose clears the timer, so the callback cannot observe it */
      if (this.disposed) return
      this.connect(false)
    }, this.reconnectDelay())
  }

  /** Close the bridge socket and reject any pending requests. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.rejectAllPending(new Error('bridge client disposed'))
    this.socket?.end()
  }
}
