/**
 * The child supervisor: one Python process, from spawn to settlement.
 *
 * `superviseChildRun` takes one validated run — its staging path, the validated
 * binding namespaces, and the caps the plugin resolved — and owns everything
 * below the seam: the spawn, the fd-3 frame reader and its dispatch, the reply
 * channel with its backpressure and backlog caps, the wall timer and abort
 * listener, and the SIGTERM → grace → SIGKILL escalation whose result settles on
 * the process group being reaped. The runtime supplies the inputs and the set of
 * in-flight runs; nothing else in the package reaches into a child.
 * @module @deepseek-ai/dsh-experimental-ptc-runtime-python/src/supervisor
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import type { PtcBindingErrorClass, PtcBindingFunction, PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { assertNever, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { errorMessage } from '@deepseek-ai/dsh-value'
import { CLOSE_REAP_MARGIN_MS, pythonEnvironment } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { capMessage } from './cost.ts'
import { createFrameReader } from './frame-reader.ts'
import { OutputLedger } from './output-ledger.ts'
import type { BootMessage, ChildToHost, ReplyMessage } from './protocol.ts'
import { checkDoneValue, encodeJsonPlain } from './protocol.ts'

/** One namespace after seam validation: its callables plus the optional typed-rejection contract. */
export interface ValidatedNamespace {
  functions: Record<string, PtcBindingFunction>
  errorClass?: PtcBindingErrorClass
}

/**
 * One in-flight run's host-side state, tracked for disposal so teardown can
 * fail every live run as `abort` and AWAIT each child's exit.
 */
export interface LiveRun {
  kill(sig: NodeJS.Signals): void
  settle(failure: PtcRunFailure): void
  finished: Promise<void>
}

/**
 * Everything one supervised run reads from the runtime that owns it.
 */
interface ChildRunDeps {
  /** The absolute interpreter path the plugin resolved and probed at load. */
  readonly pythonBin: string
  /** The gates' resolved values: every cap this run enforces. */
  readonly config: ResolvedConfig
  /** This instance's effective fd-3 frame parse cap; see `hostFrameParseCeiling`. */
  readonly frameParseCapBytes: number
  /** The program text to run in the child. */
  readonly program: string
  /** Absolute working directory the child is spawned in; the provider resolved it at `resolve`. */
  readonly cwd: string
  /** The request's abort signal, if it carried one. */
  readonly signal: AbortSignal | undefined
  /** The validated namespaces the child may call back into, by injected global. */
  readonly bindings: Map<string, ValidatedNamespace>
  /** The staged entry script this run spawns and removes at settlement. */
  readonly bootstrapPath: string
  /**
   * The runtime's in-flight runs. The supervisor adds this run before the
   * spawn returns and removes it once the process group is empty, which is what
   * makes a concurrent teardown settle and await it.
   */
  readonly liveRuns: Set<LiveRun>
}

/**
 * Replies the host retains before fd 3 accepts them. The drain loop writes one
 * reply per iteration and waits for `drain` when the pipe is full; a child
 * that never reads its replies (hostile or wedged) leaves the pipe full, so
 * every call frame it keeps sending adds a reply the drain cannot write, and
 * the backlog would grow without bound until the wall clock. 1024 keeps
 * legitimate concurrent gathers (measured queue depths reach 11) far below
 * the ceiling while bounding the hostile backlog; the run settles as a
 * worker-exit past it, like the frame cap settles an oversized frame. A
 * framing invariant, not a deployment choice.
 */
const MAX_PENDING_REPLIES = 1024

/**
 * Interval between process-group liveness probes while settlement waits for an
 * escalated SIGKILL to empty the group (see the `killing` branch in this
 * module's settle). A poll rather than an event
 * because the group members are the model's own descendants, which the host does
 * not `wait()` for and gets no exit signal from; the probe is a signal-0
 * `process.kill(-pid, 0)`, so the interval only bounds how promptly a now-empty
 * group is noticed, capped by `graceMs + CLOSE_REAP_MARGIN_MS`.
 */
const GROUP_REAP_POLL_MS = 50

/**
 * A process's start time, as the identity half of (pid, started).
 *
 * A pid is reusable the moment the kernel reaps it, so signalling one that a
 * later process inherited would terminate an unrelated process group. Start
 * time is what distinguishes the original from its replacement: `kill(pid, 0)`
 * answers "does this number exist", which is true for both.
 *
 * Linux reads field 22 of `/proc/<pid>/stat` (starttime in clock ticks); the
 * field is positional after the comm field's closing parenthesis, which is
 * parsed from the LAST such character because a process name may contain one.
 * Darwin has no `/proc`, so the caller gets `undefined` there and `killGroup`
 * signals the pgid without the identity re-check rather than paying a `ps`
 * fork on a teardown path. Any read failure is `undefined` for the same
 * reason: this
 * hardens a narrow race and must never be the thing that breaks teardown.
 * @param pid - the process to read.
 * @returns its start time, or undefined when unavailable.
 */
export function readProcessStart(pid: number): string | undefined {
  /* v8 ignore next -- one arm per platform: the Linux coverage lane always takes the read path, and Darwin always this one. */
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // Field 22 overall; the slice above dropped pid and comm, so it is index 19.
    return fields[19]
  } catch {
    return undefined
  }
}

/**
 * Spawn the child for one validated run and drive it to settlement.
 *
 * Resolves with the run's outcome per the seam contract; it rejects only for
 * seam misuse, which the caller has already validated away.
 * @param deps - the run's inputs and the runtime state it registers in.
 * @returns the run's outcome, its logs metered by the output ledger.
 */
export function superviseChildRun(deps: ChildRunDeps): Promise<PtcRunResult> {
  const { pythonBin, config, frameParseCapBytes, program, cwd, signal, bindings, bootstrapPath, liveRuns } = deps
  // This run's own staging directory, removed at settlement.
  const bootstrapDir = dirname(bootstrapPath)
  // Explicit pipe count of 4 puts the framed-JSON channel at fd 3 in the child.
  // The constructor resolved and validated the interpreter once; runs keep that
  // exact path even if the host later changes PATH.
  // `spawn` can throw SYNCHRONOUSLY — a descriptor-exhausted host (EMFILE) or a
  // libuv-level failure surfaces here, before the Promise executor and its
  // settlement path exist. Left uncaught it would REJECT run() (the seam
  // permits rejection only for misuse) and strand this run's staging directory,
  // which only settle() removes. Catch it, unlink the directory, and resolve a
  // `worker-exit` — the same class as the async ENOENT `error` event below.
  let child: ChildProcessWithoutNullStreams
  let proto: Duplex | null
  try {
    // `-u` keeps the interpreter's own stdout/stderr UNBUFFERED: a program
    // that writes through `sys.__stdout__`/`sys.__stderr__` (or C-stdio
    // layered on the same fds) must have those bytes visible to the host's
    // stray capture immediately — a block-buffered wrapper would otherwise
    // hold them until an explicit flush, and the host SIGTERMs the child
    // right after the done frame, before any finalization-time flush could
    // run. The `_LogStream` replacement of `sys.stdout`/`sys.stderr` is
    // unaffected (it is a Python object, not the C-level stdio buffer).
    child = spawn(pythonBin, ['-u', '-I', bootstrapPath], {
      cwd,
      // Preserve only the platform temp directory. macOS system Python emits a
      // startup warning when TMPDIR is absent; ambient credentials, PATH, HOME,
      // and other host state remain unavailable to model code.
      env: pythonEnvironment(),
      detached: true, // Own process group — kill(-pid, sig) reaches subprocesses the model program spawns.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    // Fd 3 is a duplex pipe carrying protocol frames. Node types extra stdio
    // entries as `Stream | null`; the runtime shape with `'pipe'` is a duplex,
    // so we narrow at the boundary rather than smearing casts below. Stdout
    // and stderr are guaranteed non-null under `'pipe'` and typed as such.
    proto = child.stdio[3] as Duplex | null
    /* v8 ignore next 3 -- `'pipe'` stdio always populates fd 3; guarding Node's `Stream | null` typing widening. */
    if (proto === null) {
      throw new Error('dsh-ptc-runtime-python: python subprocess spawned without a fd-3 pipe')
    }
    // Close the host's stdin write handle immediately: the program is an
    // async body that reads nothing from fd 0, and a live pipe here would
    // hold a host-side handle open past the run — a setsid-escaped descendant
    // inheriting fd 0 would keep the host process from exiting even after the
    // closeDeadline forced settlement. The child (and any descendant) reads
    // EOF on fd 0 instead, and no host handle survives.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the boot-write-failure fake child has no stdin.
    child.stdin?.destroy()
  } catch (error: unknown) {
    try {
      rmSync(bootstrapDir, { recursive: true, force: true })
    } catch {
      // Same swallow as settle()'s removal: `force` already absorbs a missing
      // directory, so only a filesystem-level refusal reaches here, and the
      // staging copy holds nothing but two checked-in scripts.
    }
    return Promise.resolve({ logs: [], error: { kind: 'worker-exit' as const, message: `python spawn error: ${errorMessage(error)}` } })
  }

  return new Promise<PtcRunResult>((resolve) => {
    let settled = false
    // One ledger per run: it holds the `logs` this promise resolves with, the
    // shared byte budget every log entry and stray byte is billed against, and
    // the truncation state the `log` frame arm and the finish paths funnel
    // into.
    const ledger = new OutputLedger(config.maxLogBytes)
    child.stdout.on('data', (chunk: Buffer) => { ledger.captureStdout(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { ledger.captureStderr(chunk) })
    child.stdout.on('end', () => { ledger.flushStdout() })
    child.stderr.on('end', () => { ledger.flushStderr() })

    // The reader owns the unframed buffer and its byte and fragment-count
    // bounds; both callbacks are arrow wrappers because `handleFrame` and
    // `finish` are `const`s declared later in this executor — passing them by
    // reference here would read them before initialization.
    const reader = createFrameReader({
      frameParseCapBytes: frameParseCapBytes,
      onFrame: (frame) => { handleFrame(frame) },
      onOversized: () => {
        finish({ error: { kind: 'worker-exit', message: `protocol frame exceeded ${frameParseCapBytes} bytes on fd 3` } })
      },
    })
    proto.on('data', (chunk: Buffer) => {
      // Once settled, stop accumulating: a hostile child that keeps flooding
      // fd 3 between finish() and close must not regrow the host buffer.
      /* v8 ignore next -- post-settlement data needs the child to outrace close after we decided. */
      if (settled) return
      // Schedule ONE post-batch outstanding-call check per macrotask. The
      // check must see the TRUE count — the live count is inflated by this
      // batch's own frames (the finallys run on the microtask queue, which
      // drains only when the macrotask ends), and a per-event snapshot is
      // stale when flowing mode fires several 'data' events within one
      // macrotask before any microtask drains. setImmediate runs after the
      // current macrotask's microtasks, so the count is exact; the flag
      // dedupes the check across the events of one macrotask. The threshold
      // is STRICT: exactly MAX_PENDING_REPLIES outstanding calls are allowed,
      // so a program that returns with calls it never awaited still
      // completes (the done frame settles the run; the check no-ops on
      // `settled`).
      if (!postBatchCheckPending) {
        postBatchCheckPending = true
        setImmediate(() => {
          postBatchCheckPending = false
          /* v8 ignore next -- the done frame can settle the run between the schedule and this callback. */
          if (settled) return
          if (pendingCalls > MAX_PENDING_REPLIES) {
            finish({ error: { kind: 'worker-exit', message: `call backlog exceeded ${MAX_PENDING_REPLIES} in-flight binding calls (a binding never settled)` } })
          }
        })
      }
      reader.push(chunk)
    })

    // Duplicate-call suppression against the honest child's id SEQUENCE, not
    // a set of every id seen. `dispatch` sends consecutive ids from 0 with no
    // gaps — it advances its counter only after the write succeeds, so a call
    // rejected before reaching the wire consumes nothing — which makes the
    // next legitimate id exactly `nextCallId`.
    //
    // Retaining a set instead let a program write an unbounded run of unique
    // forged ids, each below the 64 MiB per-frame parse cap so nothing
    // rejected them, and grow host memory for the whole run. Accepting any
    // id above a high-water mark would have been just as wrong in the other
    // direction: one forged `{"id": 9999}` would starve every honest call
    // after it. The exact successor is the only test that both bounds the
    // retained state to one number and cannot be poisoned by a forgery.
    let nextCallId = 0

    // Set by run() when the boot frame is written; the fd-3 handler calls it
    // on boot-ack to send the run frame (see the seam's boot->boot-ack->run
    // order). scoped per run. An object holder so the cross-closure
    // assignment is a property write (eslint's prefer-const cannot see the
    // reassignment through the closure).
    const bootAckGate: { run?: () => void } = {}
    const handleFrame = (message: ChildToHost): void => {
      /* v8 ignore next -- late frame after settlement; defensive against forged post-settlement traffic. */
      if (settled) return
      switch (message.type) {
        case 'boot-ack':
          // The child accepted the boot frame (namespaces built); the run
          // frame goes out now, not with the boot frame.
          bootAckGate.run?.()
          return
        case 'log':
          if (message.truncated === true) {
            ledger.markChildTruncated()
            return
          }
          ledger.admitFrame(message.text, message.open === true)
          return
        case 'done': {
          // The call-backlog cap must also hold when the child finishes in
          // the SAME batch as its flood: the post-macrotask check no-ops once
          // this done frame settles the run, so a done arriving right after
          // more than MAX_PENDING_REPLIES call frames in one data event would
          // otherwise complete successfully with the outstanding closures
          // left behind (a single sub-64 KiB write can carry 1025 compact
          // calls plus a done). The strict threshold lets exactly
          // MAX_PENDING_REPLIES outstanding calls — a program that returned
          // without awaiting its calls — complete normally.
          if (pendingCalls > MAX_PENDING_REPLIES) {
            finish({ error: { kind: 'worker-exit', message: `call backlog exceeded ${MAX_PENDING_REPLIES} in-flight binding calls (a binding never settled)` } })
            return
          }
          if (message.error) {
            finish({ error: { kind: message.error.kind, message: capMessage(message.error.message, config.maxValueBytes) } })
            return
          }
          if (message.value === undefined) {
            finish({})
            return
          }
          // Re-enforce the completion budget and number losslessness
          // host-side: a forged done frame bypasses the Python-side
          // _done_with_value check, and validateChildFrame no longer scans
          // the value (an unbounded scan would push every member of a wide
          // forgery before any cap ran). checkDoneValue folds both jobs into
          // one bounded, iterative traversal — iterative because the seam's
          // PtcJsonValue has no depth limit and an honest deep-but-small
          // completion must cross intact rather than dying on stringify
          // recursion; bounded because it stops at the cap without
          // materializing the encoding, rejecting a forged value anywhere
          // below the 64 MiB frame parse cap before it forces host-side copies.
          // The seam forbids substituting a rendered/truncated value, so an
          // oversized value fails the run as output-limit and a non-lossless
          // number as invalid-output. The value is JSON-plain by construction
          // (it came from JSON.parse of the frame), the traversal's precondition.
          const check = checkDoneValue(message.value, config.maxValueBytes)
          if (!check.ok) {
            finish(check.reason === 'over-budget'
              ? { error: { kind: 'output-limit', message: `completion value exceeded ${config.maxValueBytes} bytes` } }
              : { error: { kind: 'invalid-output', message: 'completion value contained a non-lossless number' } })
            return
          }
          finish({ value: message.value as PtcJsonValue })
          return
        }
        case 'call': {
          if (message.id !== nextCallId) return
          nextCallId += 1
          const record = bindings.get(message.global)?.functions
          const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
          if (typeof fn !== 'function') {
            // `call.global` and `call.name` are attacker-controlled strings
            // with no byte cap of their own — only the 64 MiB fd-3 frame
            // parse cap — so each is sliced to `maxValueBytes` CODE UNITS
            // BEFORE it reaches the template. Interpolating them whole would
            // copy them into the message, `JSON.stringify` would copy the
            // escaped form, `encodeJsonPlain` the frame, and the pipe write
            // again: four full-size host allocations off one below-ceiling
            // forgery, past every hostile-peer bound the log and done-error
            // paths apply. Nothing past the first `maxValueBytes` code units
            // of either field can survive the byte cap anyway, so the slices
            // lose only text `capMessage` would drop, and that final cap
            // gives this reply the same budget and marker as a forged done
            // error.
            const cap = config.maxValueBytes
            const target = `${message.global.slice(0, cap)}.${message.name.slice(0, cap)}`
            // JSON.stringify on the WHOLE capped target would still allocate
            // the escaped form — up to ~6x under control-heavy input, a
            // multi-hundred-MB spike near the maxValueBytes ceiling that no
            // hostile-peer bound would have admitted. The message only needs
            // to identify the binding, so the escaped form is built from a
            // 1 KiB prefix; capMessage then enforces the reply budget.
            const preview = JSON.stringify(target.slice(0, 1024))
            sendReply({ type: 'reply', id: message.id, ok: false, message: capMessage(`unknown binding ${preview}`, cap) })
            return
          }
          // Count the outstanding binding call before dispatch and release the
          // slot in the async body's finally. The CAP CHECK runs in the data
          // handler's post-macrotask pass (where the finallys have drained),
          // not here: a per-frame check would see every frame of one event as
          // in-flight and false-positive on a legitimate gather of more than
          // MAX_PENDING_REPLIES instant calls.
          pendingCalls += 1
          void (async () => {
            try {
              const resolved = await fn(message.args)
              // Drop a reply the run no longer needs BEFORE snapshotting it.
              // `sendReply` also checks `settled`, but only after this value has
              // been walked and copied: a binding that resolves a wide value
              // after `maxWallMs`, an abort, or dispose already settled the run
              // would spend host heap on a frame that is then discarded, and
              // binding resolution carries no seam-level byte cap to bound it.
              // oxlint-disable-next-line typescript/no-unnecessary-condition -- the run can settle while this binding is awaited.
              if (settled) return
              // The seam requires a lossy resolution to REJECT descriptively,
              // not silently coerce: a raw JSON.stringify would turn NaN/
              // Infinity into null and drop undefined fields. Snapshot through
              // the same lossless-JSON boundary the Node backend uses (also
              // iterative, so a deeply nested value cannot overflow the stack).
              const value = snapshotJsonValue(resolved)
              if (value === undefined) {
                sendReply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
                return
              }
              sendReply({ type: 'reply', id: message.id, ok: true, value })
            } catch (error: unknown) {
              // Check `settled` before formatting the error: a rejection that
              // arrives after `maxWallMs`, an abort, or dispose has already
              // settled the run, and `errorMessage(error)` runs hostile getters
              // before `sendReply` peeks at `settled`. Dropping the framed
              // reply early spares the host heap and time for a run whose
              // outcome is already fixed.
              // (oxlint block-disable so both `v8 ignore next` and the rule
              // suppression land on the `if`: `settled` flips true mid-wait,
              // invisible to the type-aware lint, which narrows it to false.)
              /* oxlint-disable typescript/no-unnecessary-condition */
              /* v8 ignore next -- a rejection arriving after settlement is not schedulable from a test. */
              if (settled) return
              /* oxlint-enable typescript/no-unnecessary-condition */
              sendReply({ type: 'reply', id: message.id, ok: false, message: errorMessage(error) })
            } finally {
              // Release the in-flight slot on every exit — reply written,
              // resolution rejected, or the run settling mid-wait (the
              // `settled` early returns above). Without this, a binding that
              // never resolves would leak its slot past the cap check and the
              // flood bound would erode.
              pendingCalls -= 1
            }
          })()
          return
        }
        /* v8 ignore next -- closed-union backstop; the compiler rejects a new child frame here. */
        default:
          assertNever(message, 'python runtime child frame')
      }
    }

    // Write one reply frame with the iterative encoder: a binding
    // resolution has no seam-level depth or byte cap, so a deeply nested
    // value must not die on JSON.stringify's recursion. The payload is
    // JSON-plain by construction (snapshotJsonValue output, or literal
    // strings/numbers), which is encodeJsonPlain's precondition. A closed
    // pipe (child already gone) is swallowed since the close path settles
    // the run.
    //
    // Replies are encoded and written ONE AT A TIME, waiting for `drain`
    // whenever fd 3's buffer is full. Binding resolution carries no
    // seam-level byte cap, so a program that resolves several large values in
    // one `asyncio.gather` round would otherwise encode them all in the same
    // turn and queue every frame in the writable stream's buffer -- measured
    // to exhaust a 256 MiB Node heap, which kills the whole host process
    // rather than failing this one run. Pacing changes no model-visible
    // behavior: the child matches each reply to its `call` by id from a pump
    // that reads fd 3 continuously, so arrival order was never observable,
    // and the bindings themselves still run concurrently. Only the host's peak
    // memory and the flush timing change.
    const replyQueue: ReplyMessage[] = []
    // Replies queued but not yet written, tracked separately from
    // `replyQueue.length`: the drain loop clears consumed slots to `undefined`
    // but does not shrink the array until it finishes, so `length` counts
    // consumed frames too. The counter is what the cap in `sendReply` reads.
    let pendingReplies = 0
    // Binding calls dispatched but not yet settled (the async body below
    // still awaits the binding's promise). The reply backlog cap only counts
    // RESOLVED calls — `pendingReplies` grows after the await — so a child
    // flooding calls against a binding that never settles would accumulate
    // one async closure per frame until the wall clock without tripping it.
    // Counted here before dispatch and released in the body's finally; the
    // data handler schedules a post-macrotask check (see there) that settles
    // the run as worker-exit when the true outstanding count passes
    // MAX_PENDING_REPLIES.
    let pendingCalls = 0
    // Dedupes the post-batch outstanding-call check across the 'data' events
    // of one macrotask (see the data handler).
    let postBatchCheckPending = false
    let draining = false
    // Resolve when fd 3 can take another frame, OR when it is gone: a pipe
    // destroyed under the drain (child exited, close-deadline teardown) never
    // emits 'drain' again, so waiting on that event alone would hang the
    // drain forever — `draining` stays true and the unconsumed queue is
    // pinned with the closure. `once` plus the manual detach removes every
    // listener whichever event wins, so a long backpressure wait leaves none
    // behind.
    const waitForDrain = (): Promise<void> => new Promise<void>((resolvePromise) => {
      const finish = (): void => {
        proto.off('drain', finish)
        proto.off('close', finish)
        proto.off('error', finish)
        resolvePromise()
      }
      proto.once('drain', finish)
      proto.once('close', finish)
      proto.once('error', finish)
    })
    const drainReplies = async (): Promise<void> => {
      if (draining) return
      draining = true
      let head = 0
      try {
        while (head < replyQueue.length) {
          // Needs the run to settle between two queued frames. Measured queue
          // depths reach 11 without the wall clock landing inside that window.
          /* v8 ignore next -- see above; not schedulable from a test. */
          if (settled) break
          // A pipe destroyed under us (child exited, close deadline) will
          // never emit 'drain' again; short-circuit before the write so the
          // remaining frames are dropped by the `finally` below.
          if (proto.destroyed) break
          // Read by index, not `shift()`: a large `asyncio.gather` of wide
          // bindings awaiting fd 3's `drain` can queue many frames, and each
          // `shift()` re-slices the remaining array (O(n) per pop, O(n²) over
          // the whole drain). A head cursor keeps the cost linear; the `finally`
          // below discards everything consumed once the drain ends. The consumed
          // slot is CLEARED here (not just advanced past) so a wide payload the
          // pipe has already taken is released immediately: under sustained
          // backpressure the drain loop can live across many `await drain`
          // ticks, and leaving the slot set would pin the written value's bytes
          // in `replyQueue` for the whole busy period, making host memory grow
          // with cumulative processing rather than the current backlog.
          const payload = replyQueue[head] as ReplyMessage
          replyQueue[head] = undefined as unknown as ReplyMessage
          head += 1
          pendingReplies -= 1
          // Compact the consumed prefix once it reaches the backlog bound:
          // the array never shrinks until the drain finishes, and a child
          // that reads replies just fast enough to keep the drain alive but
          // never empty would otherwise grow the backing store linearly with
          // cumulative throughput (consumed slots are undefined, but `length`
          // keeps counting them). The splice is O(head) once per
          // MAX_PENDING_REPLIES consumed frames — amortized O(1) per reply.
          if (head >= MAX_PENDING_REPLIES) {
            replyQueue.splice(0, head)
            head = 0
          }
          // Encode inside the loop, not up front: a queued reply the run no
          // longer needs is dropped by the `settled` check above without ever
          // being serialized.
          if (!proto.write(`${encodeJsonPlain(payload)}\n`)) {
            await waitForDrain()
          }
        }
      } catch {
        // Pipe closed under us (child exited), or `drain` never arrives because
        // the child died. The close path settles the run either way.
      } finally {
        draining = false
        pendingReplies = 0
        replyQueue.length = 0
      }
    }
    const sendReply = (payload: ReplyMessage): void => {
      /* v8 ignore next -- `settled` covers a race where the child exits between decision and write. */
      if (settled) return
      // A child that stops reading fd 3 leaves the drain loop blocked on
      // `drain` forever while its call frames keep resolving into replies:
      // the backlog would grow without bound until the wall clock, pinning
      // every binding result the child provokes. Cap the retained backlog and
      // settle the run as a worker-exit, the same hostile-peer bound the
      // frame cap applies to inbound bytes.
      if (pendingReplies >= MAX_PENDING_REPLIES) {
        finish({ error: { kind: 'worker-exit', message: `reply queue exceeded ${MAX_PENDING_REPLIES} pending frames on fd 3 (the child stopped consuming its replies)` } })
        return
      }
      pendingReplies += 1
      replyQueue.push(payload)
      void drainReplies()
    }

    // Escalate SIGTERM → grace → SIGKILL on the entire process group. Idempotent
    // via `killing`.
    let killing = false
    let graceTimer: NodeJS.Timeout | undefined
    // A backstop for the one case `close` cannot cover: model code that starts
    // a descendant with `os.setsid()`/`start_new_session=True` moves it into a
    // fresh process group, so the SIGTERM/SIGKILL aimed at the child's group
    // (`kill(-pid)`) never reaches it. If that orphan inherited stdout/stderr/
    // fd 3 and outlives the run, those pipes stay open and `close` never fires
    // — leaving run() (and a teardown awaiting `finished`) hung indefinitely.
    // finish() arms this deadline; when it fires we detach our stream handles
    // and settle on the already-decided result regardless of the orphan.
    let closeDeadline: NodeJS.Timeout | undefined
    // The leader's start time, read once while it is certainly alive. `child.pid`
    // keeps its numeric value after the leader is reaped (Node clears the
    // internal handle, not the field), and `close` can trail `exit` by seconds
    // while a pipe-holding descendant keeps the streams open. Signalling
    // `-child.pid` in that window is a RAW syscall -- `child.kill()` would
    // refuse, having dropped its handle, but `process.kill` has no such guard --
    // so a recycled pgid would receive this run's SIGTERM and armed SIGKILL.
    // `groupEmpty()` cannot cover it: it reports whether the group has members,
    // not whether they are OURS, and it runs only after the first signal.
    // The repository already takes this position in
    // packages/subprocess/subprocess-local (`ProcessIdentity`, "preventing
    // teardown escalation after PID reuse"); this is the same guard, kept local
    // because a dependency on that package would be a new architectural edge.
    const leaderStarted = child.pid === undefined ? undefined : readProcessStart(child.pid)
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        /* v8 ignore next -- undefined pid means spawn never produced a process; finish() short-circuits before reaching kill(). */
        if (child.pid === undefined) return
        // A pid alone cannot answer this: `process.kill(pid, 0)` succeeds just
        // as well for a REPLACEMENT process holding the recycled number. Only
        // the start time distinguishes the two, so a reading that DISAGREES
        // means the number now belongs to another process and must not be
        // signalled.
        //
        // An ABSENT reading is the ordinary case, not a mismatch: once the
        // leader is reaped its `/proc/<pid>/stat` is gone, while the group it
        // led can still hold survivors that this teardown exists to reap. So
        // only a present-and-different reading blocks the signal; undefined
        // falls through, which is also the behavior on platforms with no
        // `/proc` to read.
        const nowStarted = readProcessStart(child.pid)
        // The refusal arm needs a real pid recycled into a new group leader
        // between spawn and teardown, which no test can schedule; the reader
        // itself is covered directly by the process-identity test.
        /* v8 ignore next -- unreachable without real pid reuse; see above. */
        if (leaderStarted !== undefined && nowStarted !== undefined && nowStarted !== leaderStarted) return
        process.kill(-child.pid, sig)
      } catch {
        // ESRCH — the process already died. Nothing to do.
      }
    }
    const kill = (): void => {
      /* v8 ignore next -- kill() is idempotent; tests do not double-invoke it. */
      if (killing) return
      killing = true
      killGroup('SIGTERM')
      // Escalate to SIGKILL after the grace window. The timer is `unref`'d so a
      // pending SIGKILL never keeps the host process alive on its own; the
      // guarantee that a same-group survivor is actually reaped before the fiber
      // goes quiescent is enforced by settle() awaiting the group's death (see
      // there), NOT by this timer firing during host lifetime. A setsid-escaped
      // orphan in a FRESH group is the different case `closeDeadline` in finish()
      // covers, since `close` never fires there.
      graceTimer = setTimeout(() => { killGroup('SIGKILL') }, config.graceMs)
      graceTimer.unref()
    }
    // True once the group has no members left: a signal-0 probe to the whole
    // group (`kill(-pid, 0)`) throws ESRCH when empty (EPERM would still mean a
    // member exists). Only meaningful once a spawn produced a pid.
    const groupEmpty = (): boolean => {
      /* v8 ignore next -- pid is always defined once escalation runs; the guard narrows the type. */
      if (child.pid === undefined) return true
      try {
        process.kill(-child.pid, 0)
        return false
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }

    let finishResolve!: () => void
    const finished = new Promise<void>((done) => { finishResolve = done })
    let resolved = false
    // The decided terminal result for a live child, recorded by finish() and
    // read by the `close` handler that settles it once the pipes have drained.
    let decided: Omit<PtcRunResult, 'logs'>

    // The single settlement point: resolve run() with the decided result and
    // mark the fiber quiescent. Idempotent — the first call wins, so a later
    // `close` after done/timeout/abort is absorbed as a no-op.
    const settle = (result: Omit<PtcRunResult, 'logs'>): void => {
      if (resolved) return
      resolved = true
      if (closeDeadline !== undefined) clearTimeout(closeDeadline)
      // The child has exited by now (settle runs on `close`, or on a spawn
      // that produced no pid), so its staging directory is no longer read and
      // this run's copy goes away with it. Removed SYNCHRONOUSLY, before
      // `resolve` below: a fire-and-forget removal left the directory on disk
      // when `run()` resolved, so a caller could not observe the "gone by
      // settlement" contract at all. Two files cost nothing to unlink here.
      try {
        rmSync(bootstrapDir, { recursive: true, force: true })
      } catch {
        // Swallows only a failure to remove this run's staging directory —
        // `force` already absorbs a missing one, so what remains is a
        // filesystem-level refusal. The run's own outcome is already decided
        // and must still be delivered; the directory holds no secret, only a
        // copy of two checked-in scripts. teardown deliberately does not
        // sweep staging (its staging is cleared inside each run's settle), so
        // a removal failure here is the one case the "gone by settlement"
        // contract degrades on.
      }
      resolve({ ...result, logs: ledger.lines })
      // Mark the fiber quiescent for THIS run: drop it from the runtime's live
      // runs and resolve `finished` (what teardown awaits). Deferred until the
      // process group is actually empty — dropping it before then would let a
      // `dispose()` that races a just-resolved run() snapshot an empty set and
      // return while a same-group survivor is still alive, making teardown's
      // "no SAME-GROUP subprocess outlives the fiber" guarantee false for that
      // window (a setsid escapee is the documented exception — see the plugin's
      // teardown JSDoc). Keeping the run registered until the group is reaped is
      // exactly what makes a concurrent teardown await it.
      const finalize = (): void => {
        liveRuns.delete(live)
        finishResolve()
      }
      // `finished` is what teardown awaits to honor "no same-group subprocess
      // outlives the fiber". When no escalation ran (normal completion, no
      // kill) or the group is already empty, cancel the pending SIGKILL and
      // finalize now. Clearing it is what bounds the PID-reuse hazard: an armed
      // `kill(-pid)` left to fire up to graceMs later could hit a RECYCLED pgid
      // once the kernel reused the leader's pid, SIGKILLing an unrelated group.
      // So the timer stays armed only while a real survivor exists — a
      // same-group descendant that ignored SIGTERM but released the pipes,
      // still alive here because its `close` is what got us to settle. In that
      // case withhold finalize and poll the group on REF'd timers (a
      // short-lived host would otherwise exit before the unref'd SIGKILL fired,
      // reparenting the survivor to init), clearing the timer the moment the
      // group empties. The wait is bounded by `graceMs + CLOSE_REAP_MARGIN_MS`
      // in the normal case; if the host event loop was blocked past both timers
      // the deadline branch below sends SIGKILL itself and grants ONE more reap
      // margin, so the outer bound is `graceMs + 2 * CLOSE_REAP_MARGIN_MS`.
      if (!killing || groupEmpty()) {
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        finalize()
        return
      }
      const deadline = Date.now() + config.graceMs + CLOSE_REAP_MARGIN_MS
      // Once the deadline forces us to send SIGKILL ourselves, allow one more
      // reap window for the kernel to tear the group down before giving up:
      // SIGKILL is asynchronous, so the group is not gone the instant it is
      // sent. `finalize` only runs on a confirmed-empty group, except at this
      // final hard bound where nothing more can be done.
      let hardDeadline = 0
      const pollGroup = (): void => {
        if (groupEmpty()) {
          // The group is gone; the grace SIGKILL is moot. Cancel it (it may not
          // have fired yet) and finalize. graceTimer is always defined here:
          // pollGroup runs only when `killing` is set, and kill() armed it.
          clearTimeout(graceTimer)
          finalize()
          return
        }
        if (hardDeadline === 0 && Date.now() >= deadline) {
          // Deadline reached with the group still non-empty. This is reachable
          // when the host event loop was blocked past both timers: Node runs
          // this poll before the grace SIGKILL timer, so that SIGKILL may never
          // have fired. Send it HERE (idempotent if the timer already ran) and
          // keep polling for the group to actually empty — finalizing on mere
          // signal delivery would declare quiescence while the group is still
          // dying. Bound the extra wait by one more reap margin.
          killGroup('SIGKILL')
          clearTimeout(graceTimer)
          hardDeadline = Date.now() + CLOSE_REAP_MARGIN_MS
        }
        // Hard bound: the self-sent SIGKILL delivered but `groupEmpty()` still
        // reports the group non-empty for a full extra reap margin. This is
        // reachable, not a kernel quirk: a SIGKILL'd same-group survivor
        // lingers as a ZOMBIE until its parent `wait()`s it, and in a
        // container whose PID 1 does not reap orphans the survivor is
        // reparented to init and never waited, so the signal-0 probe keeps
        // succeeding — the same environment dependence the Agent Note's
        // rejected "assert the reap with process.kill(pid, 0)" alternative
        // documents. The ignore stays because that container cannot be built
        // deterministically across CI platforms, not because the branch is
        // unreachable; finalizing here bounds the wait so such a deployment
        // still goes quiescent within `graceMs + 2 * CLOSE_REAP_MARGIN_MS`.
        /* v8 ignore next 4 -- reachable only in a PID-1-doesn't-reap container (zombie survivor); not deterministically buildable. */
        if (hardDeadline !== 0 && Date.now() >= hardDeadline) {
          finalize()
          return
        }
        setTimeout(pollGroup, GROUP_REAP_POLL_MS)
      }
      pollGroup()
    }

    const finish = (result: Omit<PtcRunResult, 'logs'>): void => {
      if (settled) return
      settled = true
      decided = result
      clearTimeout(wallTimer)
      signal?.removeEventListener('abort', onAbort)
      // A spawn failure (ENOENT, EACCES) never produced a pid, so there is no
      // process to kill: settle now. Its `close` still fires later and reaches
      // the idempotent settle() again as a no-op.
      ledger.sealOpen()
      if (child.pid === undefined) {
        settle(result)
        return
      }
      // Live child: SIGTERM→grace→SIGKILL, then let `close` (below) settle the
      // run so any `done` frame buffered on fd 3 is handled first and the
      // process is fully reaped before the fiber goes quiescent.
      kill()
      // `close` awaits every stdio stream draining, which a setsid-escaped
      // orphan holding our inherited pipes can prevent forever. Bound that
      // wait: after SIGKILL has had the grace window plus a margin to reap the
      // child itself, force settlement on the decided result. Flush any
      // newline-free stray residual FIRST — a leader that wrote a diagnostic
      // with `os.write(1, ...)` and exited leaves it buffered, and destroying
      // the stream below drops it before an `end`/`close` flush could run, so
      // the diagnostic would be lost from `logs`. Detaching the stream handles
      // then lets `close` land as a no-op if it ever arrives, and stops the
      // orphan's stray output from being accounted against a run that already
      // finished. `unref` so the deadline never keeps the host process alive.
      closeDeadline = setTimeout(() => {
        ledger.flushStdout()
        ledger.flushStderr()
        proto.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        settle(result)
      }, config.graceMs + CLOSE_REAP_MARGIN_MS)
      closeDeadline.unref()
    }

    child.on('error', (error: Error) => {
      finish({ error: { kind: 'worker-exit', message: `python spawn error: ${error.message}` } })
    })
    // `close` (not `exit`) is the settlement trigger: it fires only after the
    // process exits AND every stdio stream — including the fd-3 protocol pipe —
    // has drained, so a `done` frame the child wrote just before exiting is
    // always handled before we settle. macOS can deliver `exit` before that
    // final fd-3 data; keying off `close` makes the ordering irrelevant.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // If done/timeout/abort already decided the result, finish() is a no-op
      // and `decided` holds it — a SIGXCPU that arrives after a decision does
      // not override it. Otherwise the child closed before completing: a
      // SIGXCPU close is the kernel's own CPU meter firing — the RLIMIT_CPU
      // soft limit, or the bootstrap's post-settlement getrusage check
      // re-delivering SIGXCPU when a program trapped the soft limit and
      // returned inside the soft-to-hard gap. That kernel-authoritative
      // signal is the ONLY basis for the timeout classification: wall time
      // is not evidence of CPU burn (a sleeping child SIGKILLed by a cgroup
      // OOM killer, an operator, or itself consumed none), so every other
      // signal or code — including an unsolicited SIGKILL, even the
      // hard-limit one — reports as an opaque worker exit.
      //
      // The message names `cpuSeconds` as the CONFIGURED ceiling, not "the
      // budget that fired": the child clamps RLIMIT_CPU to the stricter of
      // `cpuSeconds` and any inherited soft limit, so under a tighter inherited
      // cap SIGXCPU arrives before `cpuSeconds` — the host cannot see the
      // effective value, so it states the ceiling it set rather than a second
      // count it cannot guarantee.
      finish(signal === 'SIGXCPU'
        ? { error: { kind: 'timeout', message: `CPU time exhausted (limit at most the configured ${config.cpuSeconds}s; a stricter inherited RLIMIT_CPU can fire sooner)` } }
        : { error: { kind: 'worker-exit', message: `python exited (code=${String(code)}, signal=${String(signal)}) before completing` } })
      settle(decided)
    })

    // Fd-3 and the stdout/stderr pipes emit `error` on early child death
    // (ECONNRESET/EPIPE); swallow them so they do not become uncaught. The
    // authoritative failure signal is `child.on('close')` above.
    const silenceStreamError = (): void => {}
    proto.on('error', silenceStreamError)
    child.stdout.on('error', silenceStreamError)
    child.stderr.on('error', silenceStreamError)

    // The wall-timer, abort, and live-run wiring deliberately parallels the
    // Node backend's, which is why both sides get the same review; the clone
    // detector reports no match here, so the parallel is stated in prose rather
    // than suppressed with a marker.
    const wallTimer = setTimeout(() => {
      finish({ error: { kind: 'timeout', message: `wall-clock ceiling reached (${config.maxWallMs}ms)` } })
    }, config.maxWallMs)

    const onAbort = (): void => {
      finish({ error: { kind: 'abort', message: errorMessage(signal?.reason) } })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const live: LiveRun = {
      kill,
      finished,
      settle: (failure: PtcRunFailure) => { finish({ error: failure }) },
    }
    liveRuns.add(live)

    // Send the boot frame once fd 3 is writable. This runs LAST in run()'s
    // synchronous setup: its failure path calls finish(), which reads
    // wallTimer/onAbort and (through settle) live, so those bindings must
    // already be initialized — issuing the write earlier hit their
    // temporal dead zone and threw a ReferenceError that rejected run()
    // instead of resolving the worker-exit it constructs here.
    const boot: BootMessage = {
      type: 'boot',
      cpuSeconds: config.cpuSeconds,
      addressSpaceBytes: config.addressSpaceMb * 1024 * 1024,
      maxLogBytes: config.maxLogBytes,
      maxValueBytes: config.maxValueBytes,
      namespaces: [...bindings].map(([global, namespace]) => ({
        global,
        names: Object.keys(namespace.functions),
        ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
      })),
    }
    // The run frame is sent only after the child's boot-ack: the seam
    // contract puts `run` after `boot-ack` (the ack confirms the namespaces
    // were accepted), and sending it earlier would let a boot failure race
    // the run frame. The ack handler below writes it.
    let runSent = false
    try {
      proto.write(`${JSON.stringify(boot)}\n`)
    } catch (error: unknown) {
      finish({ error: { kind: 'worker-exit', message: `failed to boot python subprocess: ${errorMessage(error)}` } })
      return
    }
    // Register the ack gate with the frame handler before any data arrives.
    bootAckGate.run = (): void => {
      if (runSent) return
      runSent = true
      try {
        proto.write(`${JSON.stringify({ type: 'run', program: program })}\n`)
      } catch (error: unknown) {
        /* v8 ignore next -- the child exited between its ack and this write; the run settles as worker-exit. */
        finish({ error: { kind: 'worker-exit', message: `failed to boot python subprocess: ${errorMessage(error)}` } })
      }
    }
  })
}
