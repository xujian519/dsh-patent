/**
 * Host-side byte ledger for one python run's captured output. It prices every
 * entry the run can return in `logs` against a shared `maxLogBytes` budget,
 * bills the child's stray stdout/stderr bytes — native prints, C-extension
 * writes — against that same budget, and funnels every truncation arm into one
 * marker. The fd-3 frame reader in `src/frame-reader.ts` shares the
 * fragment-accumulation primitives at the top of this file, so they live here
 * rather than inside either reader.
 * @module @deepseek-ai/dsh-experimental-ptc-runtime-python/src/output-ledger
 */

import { jsonStringCostUpTo } from './cost.ts'
import { logTruncationMarker } from './protocol.ts'

/**
 * Fragments an accumulating buffer may hold before they are coalesced into one
 * Buffer, bounding retained per-chunk overhead that the byte cap cannot see:
 * the cap meters payload bytes, while each chunk is a distinct Buffer with its
 * own object and backing store. A program writing single bytes without a
 * newline produced one chunk per write. 1024 keeps the overhead a small
 * constant factor of the payload while leaving normal pipe-sized reads (which
 * arrive in far fewer, much larger chunks) untouched. A framing invariant, not
 * a deployment choice.
 */
export const MAX_PENDING_CHUNKS = 1024

/**
 * Cross-chunk UTF-8 state for {@link accrueStrayCost}: `expected` continuation
 * bytes still needed to finish the in-progress sequence, its total `width`, and
 * `lowerFirst`/`upperFirst`, the valid range for the NEXT continuation byte
 * (only the first continuation of a 3- or 4-byte lead is range-restricted; once
 * consumed, later continuations accept the full 0x80–0xBF). All zero between
 * sequences. Carried on each {@link StrayBuffer} so a multibyte character split
 * across pipe `data` chunks is costed as one character.
 */
interface Utf8CostState { expected: number; width: number; lowerFirst: number; upperFirst: number }

/**
 * Accrue the serialized JSON cost of raw pipe bytes `buf`, decoding UTF-8 the way
 * `toString('utf8')` (WHATWG) would so a byte that renders as U+FFFD is charged
 * the three bytes that replacement character serializes to. A naive tally that
 * charged every byte 1 let a `b"\xff"` flood (every byte illegal → U+FFFD each)
 * grow the residual to a full budget's worth of raw bytes before flushing; near
 * a large `maxLogBytes` that retained ~256 MiB, then `flushStray`'s
 * `Buffer.concat` + `toString` expanded it to a ~1 GiB peak. Charging only the
 * structural width would leave the same gap for structurally-well-formed but
 * ILLEGAL sequences a flood produces just as cheaply — a CESU-8 surrogate
 * (`ED A0 80`) or an overlong (`E0 80 80`) decodes to THREE U+FFFD (cost 9), not
 * one width-3 character, so this validates each lead's first continuation range
 * (WHATWG: `E0`→A0-BF, `ED`→80-9F, `F0`→90-BF, `F4`→80-8F, others 80-BF) and
 * charges 3 per byte of any sequence that breaks. A control byte below 0x20
 * costs 6 (`\uXXXX`) or 2 (five short escapes); `"`/`\` cost 2; ASCII costs 1; a
 * fully valid multibyte sequence costs its byte width (2/3/4). `state` carries
 * the in-progress sequence across chunks; an unfinished tail at stream end is
 * decoded by the final `flushStray` and costed exactly there.
 * @param buf - raw bytes from a stdout/stderr pipe chunk.
 * @param state - the pipe's carried UTF-8 sequence state, mutated in place.
 * @returns the serialized cost accrued by the bytes that resolved in this call.
 */
function accrueStrayCost(buf: Buffer, state: Utf8CostState): number {
  let cost = 0
  let index = 0
  while (index < buf.length) {
    const byte = buf[index] as number
    if (state.expected > 0) {
      // The valid range for THIS continuation: the lead-specific range applies
      // to the first continuation only, then reverts to the full 0x80–0xBF.
      const consumed = state.width - state.expected
      const lower = consumed === 1 ? state.lowerFirst : 0x80
      const upper = consumed === 1 ? state.upperFirst : 0xbf
      if (byte >= lower && byte <= upper) {
        state.expected -= 1
        if (state.expected === 0) {
          cost += state.width
          state.width = 0
        }
        index += 1
        continue
      }
      // The sequence broke. WHATWG's maximal-subpart rule folds the bytes
      // consumed so far into ONE U+FFFD (cost 3), then reprocesses this byte as
      // a fresh start (no index advance). Charging per consumed byte would
      // over-count, which is memory-safe but wrong; folding to one is exact.
      cost += 3
      state.expected = 0
      state.width = 0
      continue
    }
    if (byte < 0x20) {
      cost += byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d ? 2 : 6
    } else if (byte === 0x22 || byte === 0x5c) {
      cost += 2
    } else if (byte < 0x80) {
      cost += 1
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      state.expected = 1
      state.width = 2
      state.lowerFirst = 0x80
      state.upperFirst = 0xbf
    } else if (byte >= 0xe0 && byte <= 0xef) {
      state.expected = 2
      state.width = 3
      // Exclude the overlong (E0 80-9F) and CESU-8 surrogate (ED A0-BF) ranges.
      state.lowerFirst = byte === 0xe0 ? 0xa0 : 0x80
      state.upperFirst = byte === 0xed ? 0x9f : 0xbf
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      state.expected = 3
      state.width = 4
      // Exclude the overlong (F0 80-8F) and out-of-range (F4 90-BF) leads.
      state.lowerFirst = byte === 0xf0 ? 0x90 : 0x80
      state.upperFirst = byte === 0xf4 ? 0x8f : 0xbf
    } else {
      // 0x80–0xc1 and 0xf5–0xff never begin a valid sequence: U+FFFD (3).
      cost += 3
    }
    index += 1
  }
  return cost
}

/**
 * Copy an fd-3 line residual into a fresh, right-sized Buffer so it no longer
 * shares the joined-frame allocation it was sliced from.
 *
 * After the newline loop over a `Buffer.concat` of the pending chunks, the
 * leftover partial line is a `subarray` VIEW onto that concat's backing store.
 * A view keeps the ENTIRE backing allocation alive for as long as it is
 * retained, so carrying the view forward as the next pending chunk would pin a
 * whole large frame's worth of memory behind a tiny trailing fragment — and the
 * `pendingBytes` counter, set to the fragment's own length, would no longer
 * measure the memory actually held. `Buffer.from` allocates exactly
 * `residual.length` bytes and copies, letting the concat allocation be
 * collected; an empty residual carries nothing forward.
 * @param residual - the leftover slice after the last newline (a view).
 * @returns the pending-chunk list to carry forward: `[copy]`, or `[]` when empty.
 */
export function detachResidual(residual: Buffer): Buffer[] {
  return residual.length > 0 ? [Buffer.from(residual)] : []
}

// Stray-byte capture: anything the child writes to its stdout/stderr (native
// prints, C-extension writes) still counts against the ledger.
//
// Output is admitted per LINE, not per transport chunk. `logs` entries are
// joined with `\n` downstream (PTC mode), so each entry must be one line:
// pushing a raw `data` chunk would turn every arbitrary pipe-read boundary into
// a model-visible newline, so a single 200 KiB native write split across pipe
// reads would read back with spurious line breaks. The child's own `log` frames
// are already line-granular; stray capture matches them by splitting on `\n`.
//
// Buffered as raw `Buffer` chunks with a running SERIALIZED-cost counter,
// exactly like the fd-3 reader in `src/frame-reader.ts` and for the same
// reasons: a string `+=` accumulator re-copies the whole residual on every
// pipe chunk (quadratic on a large newline-free write), and scanning it from
// index 0 each chunk is a second quadratic. Appending a chunk is O(1); the
// split happens only when a `\n` actually arrived. A newline never appears
// inside a UTF-8 multibyte sequence (continuation bytes are 0x80–0xBF), so
// splitting on the raw 0x0a byte and decoding each complete line is safe
// without a streaming decoder — a line's bytes are whole by construction.
//
// `chunks` also seals into `blocks` past {@link MAX_PENDING_CHUNKS}, mirroring
// the fd-3 reader in `src/frame-reader.ts`: without it a program pacing
// one-byte newline-free `os.write`s accumulates one Buffer object per write,
// and the object plus
// backing-store overhead — which no byte or cost count sees — exhausts the host
// heap far below the budget. Sealing bounds the live object count.
interface StrayBuffer { chunks: Buffer[]; blocks: Buffer[]; cost: number; utf8: Utf8CostState }

/** A fresh per-pipe accumulator: nothing buffered, no UTF-8 sequence in progress. */
function emptyStray(): StrayBuffer {
  return { chunks: [], blocks: [], cost: 0, utf8: { expected: 0, width: 0, lowerFirst: 0, upperFirst: 0 } }
}

/**
 * The byte ledger for one python run's captured output. Entries are admitted
 * against a budget that starts one byte below `maxLogBytes`, so a result that
 * exactly exhausts the ledger serializes to exactly the configured cap; the
 * first exhaustion appends the truncation marker, stops capture, and makes
 * every later admit a no-op. One instance per run, settled by the caller with
 * {@link OutputLedger.lines} after {@link OutputLedger.sealOpen} and the pipe
 * flushes have run.
 */
export class OutputLedger {
  /**
   * The admitted log entries, in arrival order. The caller reads this array
   * itself as the run result's `logs`; it is not copied.
   */
  readonly lines: string[] = []

  // An unterminated line flushed with the `open` flag: the next log frame
  // appends to it (no fake newline between entries), and sealOpen() pushes
  // the residual if the run ends with it still open. Held as a fragment
  // ARRAY, so k tiny open frames cost O(k) — re-joining and re-walking the
  // whole held text per frame would be O(k * budget).
  private openParts: string[] = []

  // Past MAX_PENDING_CHUNKS, the held fragments are coalesced into sealed
  // blocks (mirroring the fd-3 reader's `blocks` and the stray capture's
  // seal): each fragment is a distinct array slot plus string object
  // header — ~30x overhead the byte cap cannot see — so a budget-sized
  // single-character open flood would otherwise accumulate thousands of
  // slots. Sealing bounds the live fragment count exactly like the
  // sibling paths; the merge reads sealed + current fragments. A block
  // ARRAY (not one repeated string concat) matches the sibling shape and
  // avoids depending on V8 ConsString amortization.
  private openSealed: string[] = []

  // One host-side ledger covers normal frames, forged frames, and stray stdout
  // bytes. The budget starts one byte below maxLogBytes: each entry is charged
  // its JSON-string cost plus one separator byte, and the serialized outer logs
  // array adds one more byte of envelope (two brackets and n-1 commas over n
  // entries' separators), so a result that exactly exhausts the ledger
  // serializes to exactly maxLogBytes; WITHOUT the reserved byte it would
  // serialize to maxLogBytes + 1. Reserving that byte keeps an admitted result
  // within the configured cap; the truncation-marker entry is envelope, not
  // payload, and rides uncharged.
  private budget: number

  private truncated = false

  private readonly strayOut: StrayBuffer = emptyStray()
  private readonly strayErr: StrayBuffer = emptyStray()

  /**
   * @param maxLogBytes - the configured log cap; its own marker is charged as
   * envelope, and the payload budget reserves one byte below it.
   */
  constructor(private readonly maxLogBytes: number) {
    this.budget = maxLogBytes - 1
  }

  /**
   * Drop a pipe's buffered stray output wholesale: once the ledger has
   * truncated, every byte of it would be no-op'd by admit(), so retaining it
   * (and later Buffer.concat+decoding it in flushStray) would spend host memory
   * on output that can never be admitted. Called from every arm that marks the
   * ledger truncated — admit()'s two ceilings and the child-marker frame arm —
   * so the end-path flushStray sees empty buffers and exits.
   * @param stray - the pipe accumulator to blank.
   */
  private clearStray(stray: StrayBuffer): void {
    stray.chunks = []
    stray.blocks = []
    stray.cost = 0
    stray.utf8 = { expected: 0, width: 0, lowerFirst: 0, upperFirst: 0 }
  }

  /**
   * Every truncation arm funnels here: the committed open prefix was ALREADY
   * billed, so it is pushed BEFORE the marker — a flushed line is never lost
   * (only the marker stays last), and no ledger re-charge happens. openParts is
   * emptied here, so no later arm or sealOpen() sees it.
   */
  private truncateLogs(): void {
    this.truncated = true
    if (this.openSealed.length > 0 || this.openParts.length > 0) {
      this.lines.push(this.openSealed.join('') + this.openParts.join(''))
      this.openSealed = []
      this.openParts = []
    }
    this.lines.push(logTruncationMarker(this.maxLogBytes))
    this.clearStray(this.strayOut)
    this.clearStray(this.strayErr)
  }

  /**
   * Record that the CHILD's own ledger hit its cap, and stop host capture at
   * the same point. The frame's marker is the last log text there will be, so
   * admitting it as ordinary text left the host budget open, and later direct
   * `os.write(1, ...)` bytes were retained AFTER the marker with a host-side
   * exhaustion able to append a second one. Both ledgers are keyed to the same
   * `maxLogBytes`, so one marker describes the run. The host generates its OWN
   * marker, never the frame's text: `truncated` is attacker-reachable, so
   * trusting the text let a program write
   * `{"type":"log","truncated":true,"text":<1 MiB>}` and land all of it in
   * `logs` under a 64-byte `maxLogBytes` — measured, the whole megabyte was
   * retained, bypassing {@link admit} and its ceiling.
   */
  markChildTruncated(): void {
    if (!this.truncated) this.truncateLogs()
  }

  /**
   * Admit one `log` frame: a complete line, a fragment of an unterminated line
   * (`open`), or the closing frame of a held line.
   * @param text - the frame's text.
   * @param open - true when the frame flushes an unterminated line.
   */
  admitFrame(text: string, open: boolean): void {
    if (open) {
      this.admitOpen(text)
      return
    }
    if (this.openParts.length > 0) {
      this.closeOpen(text)
      return
    }
    this.admit(text)
  }

  /**
   * An explicit flush of an unterminated line: hold it so the next frame
   * appends to the SAME entry (print('a', end='', flush=True) followed by
   * print('b') reads back as one 'ab' entry, not a fake newline). Billed
   * INCREMENTALLY so k tiny frames cost O(k), not O(k * budget) (re-walking the
   * whole held text per frame): the first fragment is charged the full
   * JSON-string cost plus the separator (quotes + content + newline), each
   * continuation only its content (jsonStringCostUpTo includes the two quotes),
   * and the closing frame only its own content — the merged entry's wire cost
   * is billed exactly once, split across the fragments.
   * @param text - the fragment's text.
   */
  private admitOpen(text: string): void {
    if (this.truncated) return
    // Caps: the first fragment's exact-cost walk uses budget - 1 (the ledger's
    // reserved byte, matching admit), a continuation's budget + 2 (a
    // continuation is billed WITHOUT quotes, so its billed cost cost - 2 fits
    // exactly when the walk's cost is at most budget + 2).
    //
    // An EMPTY first open frame (openParts empty AND text '') bills
    // cost + 1 = 3 but establishes no hold (the push is skipped), so the next
    // frame is billed as a new first fragment. Not reachable from an honest
    // child (_LogStream.write('') returns early; flush_line pushes only
    // non-empty pending); for a forged frame it is a bounded over-charge in the
    // safe direction (a flood exhausts the ledger into truncation).
    const cap = this.openParts.length === 0 ? this.budget - 1 : this.budget + 2
    const cost = jsonStringCostUpTo(text, cap)
    if (cost === undefined) {
      this.truncateLogs()
      return
    }
    const bill = this.openParts.length === 0 ? cost + 1 : Math.max(cost - 2, 0)
    this.budget -= bill
    // A zero-content continuation (text '') bills 0; holding it would grow the
    // fragment array without touching the ledger, so a forged empty-open flood
    // could grow host memory — skip the push, the merge result is unchanged.
    if (text !== '') {
      if (this.openParts.length >= MAX_PENDING_CHUNKS) {
        this.openSealed.push(this.openParts.join(''))
        this.openParts = []
      }
      this.openParts.push(text)
    }
  }

  /**
   * The closing frame of a held line: the held fragments are already billed, so
   * only this frame's own content is billed (the quotes and separator ride on
   * the first fragment) and the merged entry is pushed once. The cap is
   * `budget + 2` for the same reason as a continuation.
   * @param text - the closing frame's text.
   */
  private closeOpen(text: string): void {
    /* v8 ignore next -- truncated is an invariant false here: an open
     * frame that would trip the ledger resets openParts, so a non-empty
     * hold implies the ledger never truncated. The guard is defensive. */
    if (!this.truncated) {
      const cost = jsonStringCostUpTo(text, this.budget + 2)
      if (cost === undefined) {
        this.truncateLogs()
      } else {
        this.budget -= Math.max(cost - 2, 0)
        this.lines.push(this.openSealed.join('') + this.openParts.join('') + text)
      }
    }
    this.openSealed = []
    this.openParts = []
  }

  /**
   * Admit one complete log entry against the ledger.
   * @param text - the entry's text.
   */
  private admit(text: string): void {
    // Post-truncation admits are no-ops: once the ledger has truncated, the
    // marker is the last entry. Reachable within one `data` callback — a
    // chunk carrying two newline-terminated lines where the first exhausts
    // the budget hits this on the second — so it is a measured branch.
    if (this.truncated) return
    // Each entry is charged its SERIALIZED cost — JSON.stringify's quotes
    // and escapes plus one separator byte — because the seam bounds the
    // serialized outer logs payload, and control characters expand
    // several-fold under JSON escaping (a "\x00" flood would otherwise
    // admit 6x its charge). The charge also puts a floor under an empty
    // entry (its two quotes plus separator), so a `while True: print()`
    // flood of zero-byte lines exhausts the ledger instead of growing the
    // retained array without ever touching the budget. The one fixed
    // truncation-marker entry is envelope, not payload, and rides
    // uncharged.
    //
    // Cheap lower bound FIRST, before the escaped copy exists: every
    // UTF-16 code unit costs at least one serialized byte (an ASCII
    // character is one byte; a control character is six as `\uXXXX`; a
    // non-ASCII BMP character is two or three; each half of a surrogate
    // pair contributes two of the four bytes its code point encodes to),
    // and the JSON form adds two quotes on top of the separator byte. So
    // `text.length + 3` never exceeds the true cost, and a forged `log`
    // frame carrying a control-heavy string anywhere below the 64 MiB
    // frame parse cap truncates here instead of allocating a
    // hundreds-of-megabytes escaped copy under a small maxLogBytes.
    if (text.length + 3 > this.budget) {
      // Release the buffered stray pipes: their bytes can never be
      // admitted now (see clearStray).
      this.truncateLogs()
      return
    }
    // Past the lower bound, measure the exact serialized cost without
    // allocating the escaped copy: `jsonStringCostUpTo` walks to the cap and
    // stops, so even a near-budget control-char-dense line never materializes
    // a sixfold-inflated `JSON.stringify` result. `+ 1` for the separator.
    const measured = jsonStringCostUpTo(text, this.budget - 1)
    if (measured === undefined) {
      this.truncateLogs()
      return
    }
    this.budget -= measured + 1
    this.lines.push(text)
  }

  /**
   * Capture one stdout pipe chunk into the ledger's stray buffer.
   * @param chunk - the bytes the child wrote to stdout.
   */
  captureStdout(chunk: Buffer): void {
    this.capture(this.strayOut, chunk)
  }

  /**
   * Capture one stderr pipe chunk into the ledger's stray buffer.
   * @param chunk - the bytes the child wrote to stderr.
   */
  captureStderr(chunk: Buffer): void {
    this.capture(this.strayErr, chunk)
  }

  /**
   * Flush stdout's stray residual into the entries, without retaining a partial
   * trailing UTF-8 sequence.
   */
  flushStdout(): void {
    this.flushStray(this.strayOut)
  }

  /**
   * Flush stderr's stray residual into the entries, without retaining a partial
   * trailing UTF-8 sequence.
   */
  flushStderr(): void {
    this.flushStray(this.strayErr)
  }

  /**
   * Append one pipe chunk to its accumulator, admitting every complete line it
   * completes and bounding the retained residual.
   * @param stray - the pipe accumulator.
   * @param chunk - the raw bytes from the pipe.
   */
  private capture(stray: StrayBuffer, chunk: Buffer): void {
    // Once the ledger has truncated, stop buffering: admit() is a no-op past
    // that point, so continuing to accumulate would retain host memory for
    // output that can never be admitted.
    if (this.truncated) return
    stray.chunks.push(chunk)
    // Track SERIALIZED cost, not raw bytes: a control-char-dense residual
    // (a NUL or illegal-UTF-8 flood) serializes several-fold, so a raw-byte
    // threshold would let it grow to the full budget's worth of RAW bytes
    // before flushing. `accrueStrayCost` decodes UTF-8 structurally across
    // chunks (via `stray.utf8`) so a byte that renders as U+FFFD is charged
    // its three serialized bytes, not one.
    stray.cost += accrueStrayCost(chunk, stray.utf8)
    // Bound the live fragment count (see the seal rationale above), before
    // any concat so an over-count payload is never copied whole first.
    if (stray.chunks.length >= MAX_PENDING_CHUNKS) {
      stray.blocks.push(Buffer.concat(stray.chunks))
      stray.chunks = []
    }
    if (chunk.includes(0x0a)) {
      let buffered = Buffer.concat(stray.blocks.length > 0 ? [...stray.blocks, ...stray.chunks] : stray.chunks)
      stray.blocks = []
      let newline: number
      while ((newline = buffered.indexOf(0x0a)) >= 0) {
        this.admit(buffered.subarray(0, newline).toString('utf8'))
        buffered = buffered.subarray(newline + 1)
      }
      // Carry the residual as a fresh right-sized copy, not the subarray view
      // (which would pin the whole concat allocation). See detachResidual.
      // The residual begins at a character boundary (a newline is never
      // inside a multibyte sequence), so its cost and UTF-8 state recompute
      // cleanly from a fresh walk.
      // A line admitted inside the loop may have exhausted the ledger and
      // cleared this pipe (see clearStray); the re-retain below must not
      // resurrect the doomed residual.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- admit() sets it.
      if (this.truncated) return
      stray.chunks = detachResidual(buffered)
      stray.utf8 = { expected: 0, width: 0, lowerFirst: 0, upperFirst: 0 }
      stray.cost = accrueStrayCost(buffered, stray.utf8)
    }
    // Newline-free residual is bounded by the ledger, not left to grow with
    // the stream: an `os.write(1, b"A"*N)` flood carrying no newline would
    // otherwise accumulate N bytes in host memory before `end`. The bound is
    // on the COMBINED pending cost of both pipes, not each alone: stdout and
    // stderr share one budget, so checking each against the full budget
    // independently would let both retain nearly a budget's worth at once —
    // ~2x peak, up to ~512 MiB near the ceiling — before either flushed.
    // When the sum would cross the budget, flush both now. admit() charges
    // the exact serialized cost, truncates, and marks the ledger, and the
    // truncation short-circuit above stops buffering on the next chunk.
    // `+ 3` covers the two quotes and one separator admit adds. The two
    // pipes are independent OS streams whose `data` events already interleave
    // nondeterministically with each other and with the child's own fd-3
    // `log` frames, so `lines` carries no cross-pipe ordering guarantee to
    // preserve here; a fixed drain order is as valid as any.
    // Flushing is NOT a stream end: a multibyte UTF-8 character can be split
    // across pipe `data` chunks, so the residual may end mid-sequence. A
    // budget-triggered flush must decode only the complete prefix and carry
    // the incomplete tail forward (≤3 bytes) on the same pipe's residual —
    // decoding it here would render a legal character as U+FFFD in a released
    // entry (see `flushStray`). This is unlike the `end`/closeDeadline paths
    // below, where a trailing incomplete sequence is genuinely truncated input
    // and U+FFFD is honest.
    if (this.strayOut.cost + this.strayErr.cost + 3 > this.budget) {
      this.flushStray(this.strayOut, true)
      this.flushStray(this.strayErr, true)
    }
  }

  /**
   * Flush a pipe's residual into `lines`, called on the combined-budget
   * threshold above, on the pipe's `end` (normal drain), and — for the
   * setsid-escapee path where destroy() forces settlement without an `end` —
   * explicitly in the closeDeadline handler. Idempotent: it clears what it
   * admits, so a later flush is a no-op, and it returns early on an empty
   * buffer so flushing the sibling that had nothing pending is a no-op. The
   * `chunks`/`blocks` guard is the only emptiness check needed — `data` never
   * emits a zero-length Buffer, so a non-empty fragment list always decodes to
   * a non-empty tail.
   *
   * `retainPartialTail` is true only on the budget-triggered path: there the
   * residual can end at an ARBITRARY pipe boundary, so if the incomplete
   * trailing bytes of a UTF-8 lead sequence are pending (`stray.utf8.expected
   * > 0`), they are withheld from the decode and re-carried on `chunks` for a
   * later chunk to complete — decoding them here would render a LEGAL,
   * un-finished character as U+FFFD in an admitted entry, and the next chunk's
   * bytes would then each independently break into more U+FFFD. The withheld
   * tail is `stray.utf8.width - stray.utf8.expected` bytes (the lead plus the
   * continuations consumed so far), at most 3; `stray.utf8` is reset and the
   * withheld tail re-accrued so the next chunk continues the walk correctly.
   * The `end`/closeDeadline paths pass `false`: there a trailing incomplete
   * sequence is real truncated input and the U+FFFD is the honest render.
   * @param stray - the pipe accumulator to drain.
   * @param retainPartialTail - withhold an in-progress trailing sequence.
   */
  private flushStray(stray: StrayBuffer, retainPartialTail?: boolean): void {
    if (stray.chunks.length === 0 && stray.blocks.length === 0) return
    // Concatenate the sealed blocks and the current-chunk residual together
    // unconditionally (no `blocks.length > 0` ternary): a flush can run with
    // either or both present, and a branch on their presence would need a
    // test that flushes exactly at a seal boundary.
    let full = Buffer.concat([...stray.blocks, ...stray.chunks])
    // A budget flush landing exactly between a lead byte and its
    // still-pending continuation requires the combined-cost threshold to trip
    // on a specific mid-multibyte pipe boundary — not deterministically
    // schedulable through the black-box seam, which observes only complete
    // entries. So the retention arm is v8-ignored (exercised by review
    // reasoning over the `stray.utf8` state, not by an in-tree test): it
    // withholds the lead-plus-consumed-continuations tail (≤3 bytes, via
    // `stray.utf8.width - stray.utf8.expected`) from the decode, re-carries it
    // for a later chunk, and re-accrues the pipe's cost/UTF-8 state over it;
    // decoding here would render a LEGAL, unfinished character as U+FFFD in an
    // admitted entry. Every retainPartialTail=false call (the `end`/closeDeadline
    // paths) and a budget flush with no partial tail in flight (`expected === 0`)
    // falls through with `keep` unset: the FULL residual is decoded — there a
    // trailing incomplete sequence is real truncated input and the U+FFFD is the
    // honest render.
    let keep: Buffer | undefined
    /* v8 ignore next 18 -- mid-sequence budget-flush boundary is not schedulable from a test. */
    if (retainPartialTail && stray.utf8.expected > 0) {
      const drop = Math.min(stray.utf8.width - stray.utf8.expected, full.length)
      keep = full.subarray(full.length - drop)
      full = full.subarray(0, full.length - drop)
      stray.chunks = detachResidual(keep)
      // Re-accrue the withheld tail from a FRESH state: `stray.utf8` still
      // holds the whole-pending state (`expected > 0`, i.e. the tail is
      // mid-sequence), so metering `keep` against it would charge the carried
      // LEAD byte as an illegal continuation. Reset, then walk `keep` so the
      // resumed sequence re-claims its own lead.
      stray.utf8 = { expected: 0, width: 0, lowerFirst: 0, upperFirst: 0 }
      stray.cost = accrueStrayCost(keep, stray.utf8)
      stray.blocks = []
      // Do not admit an EMPTY entry: when the whole residual is a single
      // unfinished multibyte sequence, `full` was drained into `keep` and no
      // complete byte stream remains to admit. `admit('')` would push a
      // model-visible bogus empty line (logs are joined with '\n' downstream).
      if (full.length > 0) this.admit(full.toString('utf8'))
    } else {
      stray.chunks = []
      stray.cost = 0
      stray.utf8 = { expected: 0, width: 0, lowerFirst: 0, upperFirst: 0 }
      stray.blocks = []
      this.admit(full.toString('utf8'))
    }
  }

  /**
   * Push an unterminated held line into the entries and clear the hold. An
   * unterminated flushed line never got a closing frame; it was billed
   * incrementally, so push it directly (admit would re-bill). A truncated
   * ledger implies the hold is already empty (truncateLogs committed and
   * cleared it), so the push is reachable only when the run ends with the hold
   * still open and untruncated.
   */
  sealOpen(): void {
    if (this.openSealed.length > 0 || this.openParts.length > 0) {
      this.lines.push(this.openSealed.join('') + this.openParts.join(''))
    }
    this.openSealed = []
    this.openParts = []
  }
}
