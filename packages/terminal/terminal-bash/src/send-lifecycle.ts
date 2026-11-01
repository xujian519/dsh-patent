/** Ownership of the send that holds the terminal slot, and the state that ends it. */

/**
 * The send whose slot ownership this owner tracks, as far as it needs to see it.
 */
interface SlotOperation {
  /** Whether the send already settled, so its slot may be released. */
  readonly settled: boolean
  /** Request cancellation of the send; returns false once it settled. */
  cancel(): boolean
}

/** Deadline and cancellation options for admitting a send. */
interface AdmitOptions {
  /** Caller cancellation for this send. */
  signal?: AbortSignal
  /** Absolute bound on this send's wait. */
  timeoutMs: number
  /** Called when the bound expires while this send still owns the slot. */
  onExpire: () => void
}

/**
 * Owns which send holds the terminal slot, plus the deadline, cancellation
 * listener, foreground interrupt, and provider write that describe that send.
 *
 * Exactly one send may own the slot, and all four of those continuations end with
 * it. Holding them as separate session fields let each reader recombine a
 * different subset — a release test, a timeout callback, and an interrupt tail all
 * asked slightly different questions of the same state, and the answers drifted.
 * The session now asks this owner instead.
 *
 * @typeParam Operation - send object whose slot ownership this owner tracks.
 */
export class SendLifecycle<Operation extends SlotOperation> {
  private slot: Operation | undefined
  private expiryTimer: NodeJS.Timeout | undefined
  private stopAbortListener: (() => void) | undefined
  private interruptingSend: Operation | undefined
  private pendingWrite: Promise<boolean> | undefined

  /**
   * @param cancelPolling - stops readiness polling for the send that owns the slot.
   * @param isProtocolPending - whether a terminal-protocol write is outstanding.
   */
  constructor(
    private readonly cancelPolling: () => void,
    private readonly isProtocolPending: () => boolean,
  ) {}

  /** The send holding the slot, if one was admitted and not yet released. */
  get current(): Operation | undefined {
    return this.slot
  }

  /** Whether a provider write is in flight for the send holding the slot. */
  get writing(): boolean {
    return this.pendingWrite !== undefined
  }

  /** Whether cancellation took over the send holding the slot and has not finished. */
  get interrupting(): boolean {
    return this.interruptingSend !== undefined
  }

  /** Whether anything of the slot's send is still running: its write, its interrupt, or a protocol reply. */
  get busy(): boolean {
    return this.pendingWrite !== undefined || this.interruptingSend !== undefined || this.isProtocolPending()
  }

  /**
   * Whether `operation` still owns the slot: admitted, and not handed to cancellation.
   * @param operation - send to test.
   * @returns true while the send may still be polled and written to.
   */
  ownsSlot(operation: Operation): boolean {
    return this.slot === operation && this.interruptingSend !== operation
  }

  /**
   * Whether `operation` is the admitted send, regardless of a cancellation handoff.
   * @param operation - send to test.
   * @returns true while the send holds the slot, interrupted or not.
   */
  isCurrent(operation: Operation): boolean {
    return this.slot === operation
  }

  /**
   * Admit `operation` as the send that owns the slot and start its bounds.
   * @param operation - send to admit; the caller releases any previous slot first.
   * @param options - caller cancellation, the absolute bound, and the expiry callback.
   */
  admit(operation: Operation, options: AdmitOptions): void {
    this.slot = operation
    const signal = options.signal
    if (signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      signal.addEventListener('abort', onAbort, { once: true })
      this.stopAbortListener = () => { signal.removeEventListener('abort', onAbort) }
    }
    this.expiryTimer = setTimeout(() => { options.onExpire() }, options.timeoutMs)
  }

  /**
   * The provider write in flight for the current send.
   *
   * Callers await this exact promise, and register and clear it synchronously
   * around their own `await`, so reserving the slot neither reorders the write
   * against its own continuation nor adds a turn to it.
   * @returns the write's pending outcome, or undefined when no write is in flight.
   */
  get writeOutcome(): Promise<boolean> | undefined {
    return this.pendingWrite
  }

  /**
   * Register the provider write for the current send, so the slot stays reserved
   * until the write ends and no release test can read the write as already gone.
   * @param pending - the provider write whose outcome the caller awaits.
   */
  beginWrite(pending: Promise<void>): void {
    this.pendingWrite = pending.then(() => true, () => false)
  }

  /** Clear the write registration once the caller's `await` returned. */
  endWrite(): void {
    this.pendingWrite = undefined
  }

  /**
   * Release the slot once its send settled and every continuation drained: the
   * write finished, no cancellation is in flight, and no protocol reply is owed.
   */
  releaseSettled(): void {
    const operation = this.slot
    if (operation === undefined || !operation.settled || this.pendingWrite !== undefined
      || this.interruptingSend === operation || this.isProtocolPending()) return
    this.clear()
  }

  /** Stop readiness polling and cancel the absolute bound, keeping the slot. */
  stopPolling(): void {
    this.cancelPolling()
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  /**
   * Keep the slot after its send settled: stop polling and timing, and drop the
   * caller's cancellation listener, which can no longer cancel a settled send.
   */
  retain(): void {
    this.stopPolling()
    this.dropAbortListener()
  }

  /** Release the slot together with its timing, cancellation listener, and interrupt handoff. */
  clear(): void {
    const operation = this.slot
    this.stopPolling()
    this.dropAbortListener()
    if (this.interruptingSend === operation) this.interruptingSend = undefined
    this.slot = undefined
  }

  /**
   * Record that cancellation took over `operation` and stop polling for it; the
   * caller resumes readiness once the foreground signal is delivered.
   * @param operation - the send being cancelled.
   */
  beginInterrupt(operation: Operation): void {
    this.interruptingSend = operation
    this.cancelPolling()
  }

  /**
   * Drop the interrupt handoff for `operation` if it is still the one recorded.
   * @param operation - the send whose cancellation finished.
   */
  endInterrupt(operation: Operation): void {
    if (this.interruptingSend === operation) this.interruptingSend = undefined
  }

  private dropAbortListener(): void {
    this.stopAbortListener?.()
    this.stopAbortListener = undefined
  }
}
