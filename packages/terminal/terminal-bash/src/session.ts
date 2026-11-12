/** Persistent PTY session with bounded output, readiness, and terminal-protocol replies. */

import { Buffer } from 'node:buffer'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import { abortable } from '@deepseek-ai/dsh-timeout'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from './config.ts'
import { ReadinessPoller } from './readiness-poller.ts'
import { CONTROLLED_PROMPT, TerminalSanitizer } from './sanitize.ts'
import { SendLifecycle } from './send-lifecycle.ts'
import { TerminalProtocolQueue } from './terminal-protocol-queue.ts'

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

// Bound pending string fragments independently of deployment retention limits.
const COALESCED_CHUNK_UNITS = 4096

interface TextChunk {
  text: string
  start: number
  next: TextChunk | undefined
}

/** Retention work is amortized over appended text; reads assemble the retained chunks. */
class BoundedTextBuffer {
  private head: TextChunk | undefined
  private tail: TextChunk | undefined
  private bytes = 0
  private newlines = 0
  private lastCodeUnit = 0
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  get truncated(): boolean {
    return this.dropped
  }

  get isEmpty(): boolean {
    return this.head === undefined
  }

  append(text: string): void {
    if (text.length === 0) return
    // Sanitized text can be a slice retaining discarded controls; copy UTF-16 without replacing lone surrogates.
    text = Buffer.from(text, 'utf16le').toString('utf16le')
    this.bytes += Buffer.byteLength(text)
    const tail = this.tail
    if (tail !== undefined) {
      const last = this.lastCodeUnit
      const first = text.charCodeAt(0)
      // Concatenation can turn two three-byte lone surrogates into one four-byte code point.
      if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) this.bytes -= 2
    }
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      this.newlines += 1
    }
    this.lastCodeUnit = text.charCodeAt(text.length - 1)
    // The head never grows, so eviction never rescans a growing string.
    if (tail !== undefined && tail !== this.head && tail.text.length + text.length <= COALESCED_CHUNK_UNITS) {
      tail.text += text
    } else {
      if (tail !== undefined && tail.text.length <= COALESCED_CHUNK_UNITS) {
        // Copy coalesced fragments into one string; large tails already own their storage.
        tail.text = Buffer.from(tail.text, 'utf16le').toString('utf16le')
      }
      const chunk: TextChunk = { text, start: 0, next: undefined }
      if (tail === undefined) this.head = chunk
      else tail.next = chunk
      this.tail = chunk
    }

    while (this.head !== undefined
      && (this.bytes > this.maxBytes || (this.maxLines !== undefined && this.newlines >= this.maxLines))) {
      const head = this.head
      const first = head.text.charCodeAt(head.start)
      const second = head.start + 1 < head.text.length
        ? head.text.charCodeAt(head.start + 1)
        : head.next?.text.charCodeAt(0)
      const paired = first >= 0xd800 && first <= 0xdbff
        && second !== undefined && second >= 0xdc00 && second <= 0xdfff
      this.bytes -= paired ? 4 : first < 0x80 ? 1 : first < 0x800 ? 2 : 3
      if (first === 10) this.newlines -= 1
      this.advance(paired ? 2 : 1)
      this.dropped = true
    }
    const head = this.head
    if (head !== undefined && head.start >= head.text.length / 2) {
      // Copy UTF-16 verbatim so a small suffix cannot retain an oversized input's backing store.
      // Copying only after discarding at least half keeps this work amortized over discarded text.
      head.text = Buffer.from(head.text.slice(head.start), 'utf16le').toString('utf16le')
      head.start = 0
    }
  }

  private advance(units: number): void {
    while (units > 0 && this.head !== undefined) {
      const head = this.head
      const count = Math.min(units, head.text.length - head.start)
      head.start += count
      units -= count
      if (head.start === head.text.length) this.head = head.next
    }
    if (this.head === undefined) this.tail = undefined
  }

  consume(): TerminalSendRead {
    const { text: delta, truncated } = this.snapshot()
    this.head = undefined
    this.tail = undefined
    this.bytes = 0
    this.newlines = 0
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    const chunks: string[] = []
    for (let chunk = this.head; chunk !== undefined; chunk = chunk.next) {
      chunks.push(chunk.text.slice(chunk.start))
    }
    return { text: chunks.join(''), truncated: this.dropped }
  }
}

class LocalSendOperation implements TerminalSendOperation {
  private readonly output: BoundedTextBuffer
  private readonly promise: PromiseWithResolvers<TerminalSendResult>
  private finished = false
  private cancellationRequested = false
  private initialForegroundLeftWait: boolean
  private initialForegroundPgid: number | undefined

  constructor(
    maxBytes: number,
    readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = Promise.withResolvers<TerminalSendResult>()
    this.initialForegroundLeftWait = true
  }

  get done(): Promise<TerminalSendResult> {
    return this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: TerminalWaitReason, sessionStatus: TerminalSessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): TerminalSendRead {
    return this.output.consume()
  }

  setInitialForeground(foreground: SubprocessTerminalForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true
  }

  acceptsStdinWait(pgid: number, waiting: boolean): boolean {
    // The same group may still expose the wait that existed before terminal.write.
    // Observe every poll so a departure before the exact-settlement threshold
    // still makes a later return to that wait post-write evidence.
    if (pgid !== this.initialForegroundPgid) return waiting
    if (!waiting) this.initialForegroundLeftWait = true
    return waiting && this.initialForegroundLeftWait
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

/** Backend session wrapping one provider-owned terminal process. */
export class LocalPtySession implements TerminalBackendSession {
  motd = ''
  readonly pid: number
  private readonly decoder = new TextDecoder()
  /** Protocol state only; the sanitizer and bounded buffers own returned text. */
  private readonly protocol: TerminalProtocolQueue
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly lifecycle: SendLifecycle<LocalSendOperation>
  private readonly outputEnded = Promise.withResolvers<void>()
  private readonly completion: Promise<void>
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  private readonly readiness: ReadinessPoller<LocalSendOperation>
  // Readiness evidence: collected from terminal output, judged only by pollReadiness,
  // and cleared at the write boundary by resetReadinessEvidence. The README's readiness
  // model names which fields outlive that reset.
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  /**
   * A send settled before its prompt marker arrived, so that marker is still
   * outstanding. It completes the settled send's prompt and must not count as
   * the next send's evidence; it outlives `resetReadinessEvidence` for that
   * reason (the delayed-marker generation boundary in the README).
   */
  private promptOwed = false
  /**
   * Whether the controlled prompt has been rendered at least once. A stdin wait
   * observed before that first prompt belongs to the shell's own startup and says
   * nothing about a completed send; accepting it would publish a shell whose
   * prompt installation has not run, and the first command written into that
   * window can race the setup command's marker.
   */
  private promptEverSeen = false
  private shellPgid: number | undefined
  private initializing = false
  private lastOutputAt = Date.now()
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined

  constructor(
    private readonly terminal: SubprocessTerminalHandle,
    private readonly config: ResolvedConfig,
  ) {
    this.pid = terminal.pid
    this.lifecycle = new SendLifecycle(
      () => { this.readiness.cancel() },
      () => this.protocol.pending,
    )
    this.protocol = new TerminalProtocolQueue(
      data => terminal.write(data),
      config.cols,
      config.rows,
      () => { this.lifecycle.releaseSettled() },
      (error: unknown) => { if (!this.closing) this.onTransportFailure(error) },
    )
    this.readiness = new ReadinessPoller(
      config.pollIntervalMs,
      operation => this.pollReadiness(operation),
      operation => this.lifecycle.ownsSlot(operation),
      operation => this.lifecycle.isCurrent(operation),
    )
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    terminal.output.on('data', this.onTerminalData)
    terminal.output.once('end', this.onTerminalEnd)
    terminal.output.once('error', this.onTerminalError)
    this.completion = terminal.done.then(
      outcome => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
  }

  /**
   * Capture startup output through the same readiness contract as later sends.
   *
   * Cancellation rejects as soon as `signal` aborts rather than waiting for the
   * interrupted send to settle: a shell that reaches readiness after its caller
   * gave up must not be published, and the interrupted send can outlive the
   * decision by a whole foreground-signal round trip.
   * @param signal - optional cancellation while the shell reaches its first prompt.
   * @returns Resolves after startup readiness; rejects on exit, readiness timeout, or caller cancellation.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const operation = this.startSend({ text: '', submit: false, ...signal !== undefined ? { signal } : {} })
      const result = await abortable(operation.done, signal)
      if (result.waitReason === 'session_exit') throw new TerminalError('PTY shell exited during startup', 'STARTUP_EXITED')
      if (result.waitReason === 'timeout') throw new TerminalError('PTY shell did not reach readiness before startup timeout', 'STARTUP_TIMEOUT')
      this.motd = result.viewport
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new TerminalError('PTY session is closing', 'SESSION_CLOSING')
    if (this.statusValue.kind === 'exited') throw new TerminalError('PTY session has exited', 'SESSION_EXITED')
    if (this.lifecycle.current !== undefined) {
      const draining = this.lifecycle.writing
        ? ' or draining provider write'
        : this.lifecycle.interrupting
          ? ' or draining foreground interrupt'
          : ''
      throw new TerminalError(`PTY session already has an active send${draining}`, 'SEND_ACTIVE')
    }
    if (request.signal?.aborted === true) {
      // Named as a cancellation so the tool registry classifies it as the caller's abort.
      const aborted = new Error('PTY send aborted before write')
      aborted.name = 'AbortError'
      throw aborted
    }

    const operation = new LocalSendOperation(
      this.config.maxReadBytes,
      Date.now(),
      () => { this.interrupt(operation) },
    )
    this.lifecycle.admit(operation, {
      ...request.signal !== undefined ? { signal: request.signal } : {},
      timeoutMs: this.config.timeoutMs,
      onExpire: () => { this.settleActive('timeout', this.lifecycle.busy) },
    })
    this.resetReadinessEvidence()
    void this.beginSend(operation, request)
    return operation
  }

  private async beginSend(operation: LocalSendOperation, request: TerminalSendRequest): Promise<void> {
    let foreground: SubprocessTerminalForeground | undefined
    try {
      if (this.protocol.pending) await this.protocol.drain()
      const generation = this.protocol.generation
      foreground = await this.terminal.inspectForeground()
      if (this.protocol.changedSince(generation)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
    } catch (error: unknown) {
      if (this.protocol.pending) await this.protocol.drain()
      // A pre-write inspection failure while cancellation owns the slot must not
      // release it: interruptOnce's in-flight foreground signal could land on a
      // successor's foreground group. The interrupt path's post-signal tail
      // resumes polling, whose guarded catch propagates a persistent failure.
      // A retained settled operation implies that same in-flight interrupt, so
      // this guard admits only an unsettled active send.
      if (this.lifecycle.ownsSlot(operation) && !this.closing) {
        this.failActive(error)
      }
      return
    }
    try {
      if (!this.lifecycle.ownsSlot(operation) || this.closing) return
      operation.setInitialForeground(foreground)
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence()
        const write = this.terminal.write(input)
        this.lifecycle.beginWrite(write)
        try {
          await write
        } finally {
          this.lifecycle.endWrite()
        }
      }
      // Cancellation owns post-write signalling and reservation release.
      if (operation.cancelRequested) return
      if (this.lifecycle.isCurrent(operation) && operation.settled) {
        this.lifecycle.releaseSettled()
        return
      }
      // Closing can race the awaited provider write even though static analysis sees only local assignments.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- awaited provider writes can close the session.
      if (this.lifecycle.isCurrent(operation) && !this.closing) this.readiness.begin(operation)
    } catch (error: unknown) {
      if (this.lifecycle.isCurrent(operation) && !this.closing) {
        if (operation.settled) this.lifecycle.releaseSettled()
        else this.failActive(error)
      }
    }
  }

  /** Discard the marker and output evidence of any earlier send; called at admission and before a write carrying input. */
  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new TerminalError('PTY session is closing', 'SESSION_CLOSING')
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private readonly onTerminalData = (chunk: Buffer | Uint8Array | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const data = this.decoder.decode(bytes, { stream: true })
    this.protocol.accept(data)
    this.onData(data)
  }

  private readonly onTerminalEnd = (): void => {
    this.onData(this.decoder.decode())
    this.appendOutput(this.sanitizer.flush())
    this.protocol.close()
    this.outputEnded.resolve()
  }

  private readonly onTerminalError = (error: Error): void => {
    this.protocol.close()
    this.onTransportFailure(error)
    this.outputEnded.resolve()
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      this.promptEverSeen = true
      if (this.promptOwed) {
        // The marker a settled send left outstanding: it says the shell reached
        // that send's prompt, not that the current send's command ran.
        this.promptOwed = false
        this.lastOutputAt = Date.now()
      } else {
        this.promptSeen = true
        this.promptTail = ''
        this.lastOutputAt = Date.now()
      }
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length + 1 - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.protocol.close()
    this.failActive(failure)
    // The transport failure is already recorded and delivered to the caller; a
    // failed emulator teardown has no other observer.
    void this.terminal.terminate().catch(() => {})
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.lifecycle.current?.append(text)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      if (this.protocol.pending) await this.protocol.drain()
      const generation = this.protocol.generation
      let foreground = await this.terminal.inspectForeground()
      if (this.protocol.changedSince(generation)) {
        foreground = await this.inspectForegroundAfterProtocol()
      }
      if (!this.lifecycle.ownsSlot(operation) || this.closing) return
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId
      }
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs
        && foreground?.processGroupId === this.shellPgid) {
        this.settleActive('stdin_read')
        return
      }
      const elapsed = Date.now() - operation.startedAt
      const startupHasOutput = !this.initializing || !this.scrollback.isEmpty
      // Until the shell has rendered its controlled prompt, a stdin wait is the
      // shell's own startup read, not a completed send: the prompt function may
      // not be installed yet, and a command written now races that installation.
      const acceptsStdinWait = this.promptEverSeen && startupHasOutput && foreground !== undefined
        && operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting)
      if (elapsed >= this.config.exactProbeAfterMs && acceptsStdinWait) {
        this.settleActive('stdin_read')
        return
      }
      // A prompt candidate can race bash's foreground handoff, but an interactive
      // child also inherits PROMPT_COMMAND. Silence therefore remains the bound
      // on waiting for shell ownership instead of letting a child marker suppress
      // readiness until the absolute timeout.
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      // A seen marker whose printable tail has not arrived yet is the prompt function's own
      // evidence that the shell reached its prompt: the tail is written by the same render, so
      // its absence within the bound is a delivery delay rather than an absent prompt. The
      // configured tolerance holds the send on the exact path for that state alone: a tail that
      // arrived and was then invalidated by later output can no longer complete, so it keeps the
      // plain bound. Zero leaves the bound at `idleSilenceMs + handoffGraceMs`.
      const tailPending = this.promptSeen && !this.promptTextSeen && CONTROLLED_PROMPT.startsWith(this.promptTail)
      const tailGrace = tailPending ? this.config.promptTailGraceMs : 0
      if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace + tailGrace) {
        this.settleActive('inferred_idle')
      }
    } catch (error: unknown) {
      if (this.protocol.pending) await this.protocol.drain()
      if (this.lifecycle.ownsSlot(operation) && !this.closing) this.failActive(error)
    }
  }

  /** Sample foreground state only after protocol replies are quiet for the entire inspection. */
  private async inspectForegroundAfterProtocol(): Promise<SubprocessTerminalForeground | undefined> {
    for (;;) {
      if (this.protocol.pending) await this.protocol.drain()
      const generation = this.protocol.generation
      const foreground = await this.terminal.inspectForeground()
      if (!this.protocol.changedSince(generation)) return foreground
    }
  }

  private settleActive(waitReason: TerminalWaitReason, retainOwnership = false): void {
    const operation = this.lifecycle.current
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.truncated
    // The exact stdin-wait tier settles while the shell is returning to its
    // prompt, so its marker is still outstanding: it completes this send, and
    // the next send must not read it as its own evidence.
    if (waitReason === 'stdin_read' && !this.promptSeen) this.promptOwed = true
    if (retainOwnership) this.lifecycle.retain()
    else this.lifecycle.clear()
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private failActive(error: unknown): void {
    const operation = this.lifecycle.current
    if (operation === undefined) return
    this.lifecycle.clear()
    operation.fail(error)
  }

  private interrupt(operation: LocalSendOperation): void {
    if (!this.lifecycle.isCurrent(operation)) return
    this.lifecycle.beginInterrupt(operation)
    void this.interruptOnce(operation)
  }

  private async interruptOnce(operation: LocalSendOperation): Promise<void> {
    try {
      const write = this.lifecycle.writeOutcome
      if (write !== undefined && !await write) return
      await this.terminal.signalForeground('SIGINT')
    } catch (error: unknown) {
      if (this.lifecycle.isCurrent(operation) && !this.closing) this.onTransportFailure(error)
      return
    } finally {
      this.lifecycle.endInterrupt(operation)
    }
    if (this.lifecycle.isCurrent(operation) && operation.settled) {
      this.lifecycle.releaseSettled()
    } else if (this.lifecycle.isCurrent(operation) && !this.closing) {
      this.readiness.begin(operation, 0)
    }
  }

  private async closeOnce(reason: string): Promise<void> {
    // Stop readiness polling but retain the active operation: teardown settles
    // it as session_exit below, so an in-flight send is never mis-settled as
    // stdin_read/inferred_idle/timeout during the grace period.
    this.lifecycle.stopPolling()
    this.protocol.close()
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error })
    }
    // Quiescence is the active send's terminal outcome.
    this.settleActive('session_exit')
    await this.completion
    this.terminal.output.off('data', this.onTerminalData)
    this.terminal.output.off('end', this.onTerminalEnd)
    this.terminal.output.off('error', this.onTerminalError)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}
