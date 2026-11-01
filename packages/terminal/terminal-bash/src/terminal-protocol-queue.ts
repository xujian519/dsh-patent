/** Serialized terminal-protocol replies for one PTY session. */

import type { IDisposable, Terminal as HeadlessTerminalType } from '@xterm/headless'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireHeadless = createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)

/** Write generations sampled before an awaited provider inspection. */
interface ProtocolGeneration {
  /** Emulator-input write chain, replaced when a new batch is queued. */
  readonly emulator: Promise<void>
  /** Provider reply write chain, replaced when a new reply is queued. */
  readonly response: Promise<void>
}

/**
 * Owns the emulator and the reply writes it produces.
 *
 * A send may not judge readiness from foreground state that a reply is about to
 * invalidate, and a later send may not publish before an earlier reply reached the
 * provider. Both properties need one owner for the write chains and the pending
 * count they are judged by, so the queue is drained and re-checked as a unit.
 */
export class TerminalProtocolQueue {
  private readonly emulator: HeadlessTerminalType
  private readonly emulatorData: IDisposable
  private emulatorWrites: Promise<void> = Promise.resolve()
  private emulatorWriteDone: (() => void) | undefined
  private emulatorBuffer = ''
  private emulatorWriting = false
  private responseWrites: Promise<void> = Promise.resolve()
  private pendingResponseWrites = 0
  private closed = false

  /**
   * @param writeReply - sends one emulator reply to the provider.
   * @param cols - initial emulator width.
   * @param rows - initial emulator height.
   * @param onQuiescent - called after a protocol write finishes, so a settled send can release its slot.
   * @param onFailure - called for a reply-write failure no other observer has recorded.
   */
  constructor(
    private readonly writeReply: (data: string) => Promise<void>,
    cols: number,
    rows: number,
    private readonly onQuiescent: () => void,
    private readonly onFailure: (error: unknown) => void,
  ) {
    const { Terminal: HeadlessTerminal } = requireHeadless()
    this.emulator = new HeadlessTerminal({ cols, rows, scrollback: 0 })
    this.emulatorData = this.emulator.onData((data) => { this.queueResponse(data) })
  }

  /** Whether any protocol write is outstanding. */
  get pending(): boolean {
    return this.emulatorWriteDone !== undefined || this.pendingResponseWrites > 0
  }

  /** Current write generations, for detecting activity across an awaited inspection. */
  get generation(): ProtocolGeneration {
    return { emulator: this.emulatorWrites, response: this.responseWrites }
  }

  /**
   * Compare the current write generations against an earlier sample.
   * @param generation - generations sampled before the awaited inspection.
   * @returns Whether any protocol write began, or remains outstanding, since then.
   */
  changedSince(generation: ProtocolGeneration): boolean {
    return generation.emulator !== this.emulatorWrites || generation.response !== this.responseWrites
      || this.pending
  }

  /**
   * Queue decoded provider output for the emulator to interpret.
   * @param data - decoded provider output to interpret; the emulator's replies are written back in order.
   */
  accept(data: string): void {
    if (this.closed) return
    this.emulatorBuffer += data
    if (this.emulatorWriteDone === undefined) {
      const idle = Promise.withResolvers<undefined>()
      this.emulatorWrites = idle.promise
      this.emulatorWriteDone = () => { idle.resolve(undefined) }
    }
    this.pumpEmulator()
  }

  /** Resolve once no protocol write remains pending and none started during the drain. */
  async drain(): Promise<void> {
    for (;;) {
      const emulatorWrites = this.emulatorWrites
      await emulatorWrites
      const responseWrites = this.responseWrites
      await responseWrites
      if (emulatorWrites === this.emulatorWrites && responseWrites === this.responseWrites
        && !this.pending) return
    }
  }

  /** Stop accepting output and release the emulator. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emulatorBuffer = ''
    this.emulatorWriting = false
    const done = this.emulatorWriteDone
    this.emulatorWriteDone = undefined
    done?.()
    this.emulatorData.dispose()
    this.emulator.dispose()
  }

  private queueResponse(data: string): void {
    this.pendingResponseWrites += 1
    const response = this.responseWrites.then(async () => { await this.writeReply(data) })
    this.responseWrites = response.then(
      () => { this.finishResponseWrite() },
      (error: unknown) => {
        this.finishResponseWrite()
        if (!this.closed) this.onFailure(error)
      },
    )
  }

  private pumpEmulator(): void {
    if (this.emulatorWriting || this.closed) return
    if (this.emulatorBuffer.length === 0) {
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.onQuiescent()
      return
    }
    const data = this.emulatorBuffer
    this.emulatorBuffer = ''
    this.emulatorWriting = true
    try {
      this.emulator.write(data, () => {
        this.emulatorWriting = false
        this.pumpEmulator()
      })
    } catch (error: unknown) {
      this.emulatorWriting = false
      this.emulatorBuffer = ''
      const done = this.emulatorWriteDone
      this.emulatorWriteDone = undefined
      done?.()
      this.onQuiescent()
      // A closed queue returns before it writes, so this parse failure always reaches
      // the session, which drops it once closing has started.
      this.onFailure(error)
    }
  }

  private finishResponseWrite(): void {
    this.pendingResponseWrites -= 1
    this.onQuiescent()
  }
}
