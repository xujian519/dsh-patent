/**
 * Line-framed JSON reader over one run's fd-3 bytes. It accumulates raw pipe
 * chunks into complete newline-delimited frames, hands each frame that
 * survives validation to the host as a rebuilt {@link ChildToHost}, and reports
 * a frame past the parse cap the host's heap admits so the host can settle the
 * run. It owns the unframed buffer and its byte and fragment-count bounds; the
 * host supplies the cap, the frame consumer, and the oversized-frame
 * settlement.
 * @module @deepseek-ai/dsh-experimental-ptc-runtime-python/src/frame-reader
 */

import { MAX_PENDING_CHUNKS, detachResidual } from './output-ledger.ts'
import type { ChildToHost } from './protocol.ts'
import { hasUnsafeIntegerToken, validateChildFrame } from './protocol.ts'

// Fatal UTF-8 decoder for fd-3 frames: `toString('utf8')` replaces illegal
// bytes with U+FFFD, which would silently corrupt a completion or binding
// payload a forged frame smuggled in; a fatal decode throws instead and the
// frame is dropped. Non-stream mode keeps it stateless across lines.
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true })

/** The host's wiring for one run's fd-3 frame reader. */
interface FrameReaderOptions {
  /**
   * Enforced ceiling for one newline-delimited frame. Checked against the held
   * unframed bytes before any join, and against the first frame's measured
   * length before the newline loop's join; either violation clears the buffers
   * and reports through {@link FrameReaderOptions.onOversized}.
   */
  readonly frameParseCapBytes: number
  /**
   * Receives every frame that survives validation. An illegal UTF-8 byte, an
   * unsafe integer token, malformed JSON, and a payload `validateChildFrame`
   * cannot rebuild are all dropped silently, so none of them reaches here.
   * @param frame - the rebuilt child-to-host frame.
   */
  readonly onFrame: (frame: ChildToHost) => void
  /**
   * Reports a frame that exceeded {@link FrameReaderOptions.frameParseCapBytes}.
   * Terminal: the reader has cleared its buffers and must not be fed again, and
   * the host settles the run.
   */
  readonly onOversized: () => void
}

/** A reader over one run's fd-3 stream. */
interface FrameReader {
  /**
   * Accumulate one fd-3 chunk and emit every complete frame it holds.
   * @param chunk - raw bytes as the pipe delivered them, split at any offset.
   */
  push(chunk: Buffer): void
}

/**
 * Create the frame reader for one run's fd-3 stream.
 * @param options - the parse cap, the frame consumer, and the oversized-frame settlement.
 * @returns the reader the host feeds each fd-3 chunk to.
 */
export function createFrameReader(options: FrameReaderOptions): FrameReader {
  // Line-framed JSON reader over fd 3. The unframed buffer is bounded: a
  // hostile program can loop `os.write(3, b"A"*4096)` with no newline to
  // exhaust HOST memory, which the child's RLIMIT_AS does not cover. It is
  // a memory-safety bound only: legitimate `call` frames may be large
  // (binding traffic has no seam byte cap), so it never keys off
  // maxValueBytes.
  // Buffered as raw chunks with a running byte counter: appending is O(1)
  // per chunk (a string `+=` accumulator would re-copy the whole prefix on
  // every pipe chunk — quadratic on a large frame), joins happen only when
  // a newline actually arrived, and the ceiling check reads the counter.
  let pendingChunks: Buffer[] = []
  // Fragments already merged into finished blocks. Kept separate from
  // `pendingChunks` so sealing never re-copies what earlier seals produced;
  // the two together are the unframed buffer, and `pendingBytes` counts both.
  let sealedBlocks: Buffer[] = []
  let pendingBytes = 0
  return {
    push(chunk: Buffer): void {
      pendingChunks.push(chunk)
      pendingBytes += chunk.length
      // Check the counter BEFORE the join, not the joined line afterwards:
      // Buffer.concat allocates a second copy of everything held, so a line
      // measured after the concat had already cost twice the ceiling — the
      // ceiling this check exists to enforce. The counter is exact and free,
      // and the retained chunks are released here so the rejected payload is
      // not still held while the run settles.
      //
      // The counter charges the whole unframed buffer, which over-counts by at
      // most the newline-bearing chunk's own length (one pipe read): the
      // residual carried in is always a partial line, so nothing but the
      // current line can be larger than that. That over-count is deliberate and
      // load-bounded on the OTHER side: the config cap is `parse-cap - envelope`,
      // and a legitimate near-cap frame plus a following chunk's leading bytes
      // could in principle nudge the counter over the cap for one read window
      // — but only when maxLogBytes/maxValueBytes is configured within one
      // pipe read of the 64 MiB cap, orders of magnitude past the 32/64 KiB
      // defaults.
      //
      // The cap is enforced ONLY when the held bytes are still a single
      // unframed line (this chunk carries no newline, and earlier
      // newline-bearing chunks were joined immediately): a frame past the cap
      // would otherwise be fully `Buffer.concat`-ed (a second copy of its
      // bytes) and only then dropped in the line loop — the peak-memory
      // doubling this pre-concat check exists to prevent. Dropping the
      // oversized unframed buffer before the join keeps the peak at one copy
      // of the wire bytes. When this chunk DOES carry a newline the buffer
      // holds several frames, so the FIRST-FRAME check below (not this
      // counter, which charges them all) decides.
      if (pendingBytes > options.frameParseCapBytes && !chunk.includes(0x0a)) {
        pendingChunks = []
        sealedBlocks = []
        pendingBytes = 0
        options.onOversized()
        return
      }
      // Bound the FRAGMENT COUNT as well as the byte total, but only AFTER the
      // ceiling check above: sealing first would `Buffer.concat` an already
      // over-ceiling payload and allocate a second copy of it before the
      // rejection ran, which is the peak-memory doubling that check exists to
      // prevent.
      //
      // Fragment count needs its own bound because the ceiling meters payload
      // bytes only, while each retained chunk is a separate Buffer with object
      // and backing-store overhead no byte count sees: 5000 single-byte
      // newline-free writes produced 5000 chunks holding 5031 bytes, so a
      // program pacing such writes could accumulate millions of objects inside
      // the wall budget and exhaust the host heap far below the ceiling.
      //
      // Sealing appends to a list of finished blocks instead of re-merging
      // everything held. Concatenating the whole buffer at each threshold
      // re-copied the entire accumulated prefix every time, so the cumulative
      // copy volume was quadratic, not the amortized O(1) an earlier revision
      // of this comment claimed: 10 MiB trickled a byte at a time copies
      // 53.7 GB that way, and 64 MiB copies 2.2 TB. Here each byte is copied
      // once into its block and never again, so the total stays linear, and the
      // block list is itself bounded — every block holds at least
      // `MAX_PENDING_CHUNKS - 1` bytes, so reaching the 64 MiB cap admits
      // at most a few hundred thousand of them.
      // Sealing runs ONLY on a newline-free chunk, and after the newline
      // branch below: a chunk carrying a newline must reach the join (and its
      // first-frame check) rather than being sealed into a block the check
      // would then not scan for newlines. That keeps the invariant
      // `sealedBlocks hold newline-free prefixes only` true, so the
      // first-frame scan below can charge each sealed block's whole length
      // toward the first frame without missing a newline inside it.
      if (chunk.includes(0x0a)) {
        // First-FRAME check before the join: measure the bytes up to the
        // first newline across the held chunks. The byte counter cannot
        // serve here — it charges the whole buffer, which legitimately
        // holds several frames each within the cap. A first frame past the
        // cap is dropped before the join (one copy of its wire bytes);
        // later frames in the same buffer are handled line by line in the
        // loop below.
        let firstFrameLen = 0
        let sawNewline = false
        // Sealed blocks hold newline-free prefixes only (see the sealing
        // gate below), so they are entirely part of the first frame.
        for (const b of sealedBlocks) firstFrameLen += b.length
        for (const c of pendingChunks) {
          const nl = c.indexOf(0x0a)
          if (nl >= 0) {
            firstFrameLen += nl
            sawNewline = true
            break
          }
          firstFrameLen += c.length
        }
        if (sawNewline && firstFrameLen > options.frameParseCapBytes) {
          pendingChunks = []
          sealedBlocks = []
          pendingBytes = 0
          options.onOversized()
          return
        }
        let buffered = Buffer.concat(sealedBlocks.length > 0 ? [...sealedBlocks, ...pendingChunks] : pendingChunks)
        sealedBlocks = []
        let newline: number
        while ((newline = buffered.indexOf(0x0a)) >= 0) {
          const line = buffered.subarray(0, newline)
          buffered = buffered.subarray(newline + 1)
          if (line.length === 0) continue
          // No per-line cap check here: the pre-join counter (single unframed
          // line) and the first-frame check (newline-bearing chunk) above
          // reject any frame past FRAME_PARSE_CAP_BYTES before this join, so
          // every line in this loop is within the cap by construction — a
          // per-line check would be dead code.
          // `toString('utf8')` would silently REPLACE illegal bytes with
          // U+FFFD, corrupting a completion or binding payload a forged
          // frame smuggled in (the honest child's lossless encoder never
          // emits non-UTF-8, so such a frame is hostile traffic). The fatal
          // decode throws on them and the frame is dropped — not accepted
          // with a mangled value — the same treatment as the unsafe-integer
          // check below.
          let text: string
          try {
            text = UTF8_FATAL.decode(line)
          } catch {
            continue
          }
          // JSON.parse would silently ROUND an integer token outside the
          // safe range before validation could see it, so a forged frame
          // could smuggle a corrupted value into a dispatch or completion.
          // An honest child never emits one (its validator rejects unsafe
          // ints), so such a frame is hostile traffic: drop it like any
          // other junk frame.
          if (hasUnsafeIntegerToken(text)) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(text) as unknown
          } catch {
            continue // Junk frames drop silently (hostile-peer stance).
          }
          const message = validateChildFrame(parsed)
          if (message) options.onFrame(message)
        }
        // Carry the residual forward as a fresh, right-sized copy, NOT the
        // `subarray` view: a view keeps the whole joined-frame allocation from
        // the `Buffer.concat` above alive, so a large frame followed by a tiny
        // trailing fragment would pin megabytes while `pendingBytes` reported
        // only the fragment's length. See {@link detachResidual}.
        pendingChunks = detachResidual(buffered)
        pendingBytes = buffered.length
      } else if (pendingChunks.length >= MAX_PENDING_CHUNKS) {
        // A newline-free run past the fragment-count bound: seal the held
        // chunks into one finished block (amortized O(1) per byte, see the
        // comment above the count bound) and keep accumulating. The gate on
        // `chunk.includes(0x0a)` is the ELSE half of the newline branch, so a
        // newline-bearing chunk never lands in a sealed block.
        sealedBlocks.push(Buffer.concat(pendingChunks))
        pendingChunks = []
      }
    },
  }
}
