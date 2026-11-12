/**
 * The event-sourced `Session`: an append-only log of {@link SessionEvent}s, the
 * ordered surface over it, the three incremental folds it serves, and the store
 * attachment its publication path reads. A plain class, not a Service — live
 * instances come from `ctx.sessions`.
 *
 * @module @deepseek-ai/dsh-session/session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EntryLifecycle } from '@deepseek-ai/dsh-entry-lifecycle'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Message, ToolHistory } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from './types.ts'
import type { AppendOptions, EpochHeader, PluginRecord, PluginRecordMap, PluginRecordType, RequestContext, SessionEvent, SessionEventInput, SessionEventMap, SessionEventType, SessionHeader, SessionId, SessionSeedEventState, SurfaceIntent, SurfaceEventType } from './types.ts'
import { SurfaceManager, validateSessionEventData } from './surface.ts'
import type { SessionMessageProjection, SessionSurface } from './surface.ts'
import { SessionFolds } from './folds.ts'
import { ToolHistoryProjection } from './tool-history.ts'
import { assertSessionEventEnvelope, snapshotSessionHeader, validateRestoredSessionHeader } from './validation.ts'
import { collectSessionCallbacks, invokeContainedSessionObservers } from './observers.ts'
import type { SessionCallback } from './observers.ts'

/**
 * All mutable lifecycle state for one exact store entry. Exported for the store
 * that mints and reads it; not part of the package's public surface.
 */
export interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  readonly lifecycle: EntryLifecycle
  readonly detach: () => void
}

/**
 * Store attachment for the append path: the store writes it on `enter` and the
 * append path reads it, so it lives beside the {@link SessionEntry} it maps to
 * and stays off the package's public surface. A store-owned Session that is not
 * entered retains a null entry: independent Sessions have no key at all, and
 * store-owned ones stay read-only until their creation announcement completes.
 */
export const attachments = new WeakMap<Session, SessionEntry | null>()

/**
 * Grammar of a {@link PluginRecordType}: `plugin:` followed by
 * slash-separated segments of lowercase letters, digits, `.`, `_`, and `-`,
 * each segment starting with a letter or digit.
 */
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u

/**
 * Whether one event type name follows the plugin record grammar.
 * @param type - an event type name.
 * @returns whether the name is a {@link PluginRecordType}.
 */
function isPluginRecordType(type: string): type is PluginRecordType {
  return PLUGIN_RECORD_TYPE.test(type)
}

/**
 * Type one constructed plugin record as a log event after checking its type
 * against the plugin record grammar. A restored Session already holds events
 * whose types are outside `SessionEventMap` when they are marked ignorable;
 * a plugin record is such an event.
 * @param value - the frozen record envelope built by {@link Session}.
 * @throws when the record type is outside the plugin record grammar.
 */
function assertPluginRecordEvent(value: unknown): asserts value is SessionEvent {
  const { type } = value as { readonly type: string }
  if (!isPluginRecordType(type)) {
    throw new Error(`plugin record type "${type}" must be "plugin:" followed by lowercase slash-separated segments`)
  }
}

/** Module-private access to {@link Session}'s record commit, assigned once by its static block. */
let commitPluginRecord: (session: Session, type: PluginRecordType, data: unknown) => SessionSeq

/** Copy live append inputs before sequence assignment. */
function snapshotAppend(
  type: SessionEventType,
  data: SessionEventMap[SessionEventType] | undefined,
  opts: SurfaceIntent & AppendOptions | undefined,
  subject: string,
) {
  const surfaceOp = opts?.surfaceOp
  const sourceEventSeqs = opts?.sourceEventSeqs
  const dataSnapshot = snapshotJsonValue(data)
  if (dataSnapshot === undefined) throw new Error(`${subject} carries non-JSON-serializable data`)
  const surface = snapshotJsonValue({
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    ...surfaceOp === undefined ? {} : { surfaceOp },
  })
  if (surface === undefined) throw new Error(`${subject} carries non-JSON-serializable surface metadata`)
  return { type, data: dataSnapshot, surface, ignorable: opts?.ignorable === true }
}

/** Construct and validate one live event from detached inputs. */
function createAppendEvent(snapshot: ReturnType<typeof snapshotAppend>, seq: SessionSeq): SessionEvent {
  const { type, data, surface, ignorable } = snapshot
  const event = deepFreeze({
    type,
    seq,
    time: Date.now(),
    data,
    ...(ignorable ? { ignorable: true as const } : {}),
    ...surface,
  } as SessionEvent)
  validateSessionEventData(event, `session event "${type}" at seq ${seq}`)
  return event
}

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
export class Session {
  private log: SessionEvent[] = []
  private batchPublication: SessionEvent | undefined
  /** Cached historical tool definitions and updates for request projection. */
  private readonly toolHistoryProjection = new ToolHistoryProjection()
  /** Index of the next committed event not yet consumed by the tool-history fold. */
  private toolHistorySeq = 0
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager: SurfaceManager

  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface {
    return this.surfaceManager
  }

  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader

  /** Number of leading events inherited from this Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset

  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId {
    return this.header.id
  }

  /**
   * The constructor seed length (0 without one), before any marker appended
   * during construction. Seed events never publish on `session/event`. A
   * marker appended before the store attaches occupies this seq without
   * publishing either; otherwise this seq is available for the next append.
   *
   * This in-process offset is not persisted. A fork seed can already contain
   * the child's inherited marker and synthetic closers, so its child-owned
   * history starts at {@link inheritedEventCount}, before this offset. A
   * resumed Session's seed contains its full stored log, while its inherited
   * count keeps the durable fork cut. Consumers needing complete canonical
   * history start at seq 0.
   */
  readonly firstLiveSeq: SessionLogOffset

  /**
   * First event produced for this object lifecycle. A new fork includes its
   * child-owned seed marker and closers; a restored Session starts after its
   * complete stored prefix. This in-process capture offset is not persisted.
   */
  readonly firstLifecycleSeq: SessionLogOffset

  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length for a seeded header.
   * @param projections - pure interpreters for plugin-owned message changes.
   * @returns a detached session.
   * @throws when a seed event requires a missing message interpreter or fails validation.
   */
  static create(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    inheritedEventCount?: SessionLogOffset,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(id, seed, header, 'snapshot', inheritedEventCount, projections)
  }

  /**
   * Restore a detached session by adopting an independently owned or deeply frozen seed.
   * Runtime-required event fields, event envelopes, sequence continuity, surface
   * transitions, and header fields are validated without copying or freezing events.
   * Embedded Assistant streams remain opaque until a stream consumer or storage
   * verifier reads them.
   * @param id - restored session identity.
   * @param seed - independently owned or deeply frozen events.
   * @param header - independently owned storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length decoded from storage.
   * @param eventState - aliasing state carried from the operation that produced the seed.
   * @param projections - pure interpreters for plugin-owned message changes.
   * @returns a restored detached session.
   * @throws when a seed event requires a missing message interpreter or fails validation.
   */
  static fromRestore(
    id: SessionId,
    seed: readonly SessionEvent[],
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    eventState: SessionSeedEventState,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(
      id,
      seed,
      header,
      eventState,
      inheritedEventCount,
      projections,
    )
  }

  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | SessionSeedEventState = 'snapshot',
    suppliedInheritedEventCount?: SessionLogOffset,
    projections: readonly SessionMessageProjection[] = [],
  ) {
    this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections)
    // The folds read the surface by reference, so they are built here rather
    // than in a field initializer: the field order would run them before the
    // constructor assigned the surface manager.
    this.folds = new SessionFolds(this.log, this.surfaceManager)
    const restoredHeader = mode === 'snapshot' ? undefined : validateRestoredSessionHeader(id, header)
    if (seed !== undefined) {
      // Validate the seed to the SAME invariants `append` enforces, so a
      // replay/fork (`ctx.sessions.create(id, { seed })`) cannot construct a
      // live log that no persistence backend could store: each event's `data`
      // must be JSON-serializable, and `seq` must be contiguous from 0 (the
      // `seq = log.length` contract the whole system relies on). Without this,
      // a bad seed would surface only later as a backend rejection or a silent
      // divergence between the live log and disk.
      for (const [index, source] of seed.entries()) {
        // The seed is a persistence/replay boundary: validate and detach the
        // complete event in one lossless-JSON pass.
        const snapshot = mode === 'snapshot' ? snapshotJsonValue(source) : source
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // A seed is accepted incrementally through the same transition as a
        // live append and a full-log fold. The candidate is planned before it
        // enters `log`, so a failure cannot partially mutate the surface.
        try {
          this.surfaceManager.validateNext(snapshot)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        this.log.push(mode === 'snapshot' ? deepFreeze(snapshot) : snapshot)
      }
    }
    this.firstLiveSeq = SessionLogOffset(this.log.length)
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)
    if (this.header.isSeeded && seed === undefined) {
      throw new Error('seeded session requires an explicit constructor seed')
    }
    if (this.header.isSeeded && suppliedInheritedEventCount === undefined) {
      throw new Error('seeded session requires an inherited event count')
    }
    const inheritedEventCount = SessionLogOffset(suppliedInheritedEventCount ?? 0)
    if (!this.header.isSeeded && inheritedEventCount !== 0) {
      throw new Error('unseeded session inherited event count must be 0')
    }
    if (inheritedEventCount > this.log.length) {
      throw new Error('session inherited event count exceeds its event log')
    }
    const seedMarker = this.log[inheritedEventCount]
    const markedSeed = seedMarker?.type === 'session/end-seed' && seedMarker.data.inherited === true
    if (mode === 'snapshot' && this.header.isSeeded && inheritedEventCount !== this.log.length && !markedSeed) {
      throw new Error('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
    }
    if (markedSeed && this.log.slice(inheritedEventCount + 1).some(event => event.type === 'session/end-seed' && event.data.inherited === true)) {
      throw new Error('session inherited event count must identify the final inherited marker')
    }
    this.inheritedEventCount = inheritedEventCount
    this.firstLifecycleSeq = mode === 'snapshot' && this.header.isSeeded ? inheritedEventCount : this.firstLiveSeq
    // A fresh seeded child always owns one tagged marker at its inherited cut,
    // even when the copied prefix already ends in an ancestor marker. Restore
    // retains that durable marker and appends only the ordinary resume marker.
    if (seed !== undefined && mode === 'snapshot' && this.header.isSeeded && !markedSeed) {
      this.append('session/end-seed', { inherited: true })
    } else if (seed !== undefined && !(mode === 'snapshot' && this.header.isSeeded) && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})
    }
  }

  /** Cached immutable full snapshot of the private append-only log. */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * Return the immutable event stored at one exact sequence number.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @param seq - event sequence number.
   * @returns the accepted event, or undefined when the log does not contain it.
   */
  eventAt(seq: SessionSeq): SessionEvent | undefined {
    return this.log[seq]
  }

  /**
   * Materialize an immutable snapshot of a half-open event sequence range.
   * A full current snapshot is reused until the next append; every previously
   * returned snapshot remains stable after later appends.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @param fromSeq - non-negative inclusive sequence number; defaults to the log start.
   * @param toSeqExclusive - non-negative exclusive sequence number; defaults to the current end.
   * @returns a frozen array of the selected deeply frozen events.
   */
  snapshotEvents(
    fromSeq: SessionLogOffset = SessionLogOffset(0),
    toSeqExclusive: SessionLogOffset = this.seq,
  ): readonly SessionEvent[] {
    if (fromSeq === 0 && toSeqExclusive === this.log.length) {
      this.eventsSnapshot ??= Object.freeze([...this.log])
      return this.eventsSnapshot
    }
    return Object.freeze(this.log.slice(fromSeq, toSeqExclusive))
  }

  /**
   * Return this Session's events after its fork-inherited prefix.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @returns a fresh array containing child-owned events in log order.
   */
  ownEvents(): readonly SessionEvent[] {
    // oxlint-disable-next-line typescript/no-deprecated -- Deprecated reader delegates to the deprecated range read.
    return this.snapshotEvents(this.inheritedEventCount)
  }

  /**
   * Fold unseen committed events into capability-independent tool history.
   * Initial access reconstructs inherited history; later reads consume only new events.
   * @returns an immutable snapshot for LLM request projection, including historical addition definitions.
   */
  toolHistory(): ToolHistory {
    for (const event of this.log.slice(this.toolHistorySeq)) this.toolHistoryProjection.apply(event)
    this.toolHistorySeq = this.log.length
    return this.toolHistoryProjection.snapshot()
  }

  /**
   * Whether one existing event position is outside the fork-inherited prefix.
   * @param seq - event position in this Session.
   * @returns true when the event belongs to this Session rather than its parent.
   */
  isOwnSeq(seq: SessionSeq): boolean {
    return seq >= this.inheritedEventCount && seq < this.seq
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): SessionLogOffset {
    return SessionLogOffset(this.log.length)
  }

  /** Current event while synchronously notifying a batch's observers. */
  get currentBatchPublication(): SessionEvent | undefined {
    return this.batchPublication
  }

  /**
   * Append consecutive events together after validating every candidate and dispatch.
   * Observers read the complete committed log and final message surface.
   * Listener registration changes during publication take effect on the next append.
   * Persistence listeners retain their own durability rules.
   * @param inputs - event payloads and surface intents in commit order. An empty array records no events.
   * @returns immutable committed events in the same order.
   * @throws if the Session cannot accept writes, including an empty append, or any candidate or synchronous dispatch validation fails.
   */
  append(inputs: readonly SessionEventInput[]): readonly SessionEvent[]

  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   * Independent Sessions append without notifying store observers. Once a store
   * prepares or enters the instance, writes require a completed creation
   * announcement and remain disabled after removal.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface placement for {@link SurfaceEventType} events:
   *   `surfaceOp` controls how the event enters the ordered surface and
   *   `sourceEventSeqs` lists the seq numbers of earlier events it derives
   *   from, the sole source of derived model history. Surface options are
   *   REQUIRED for every message-producing event and rejected by the
   *   compiler for non-surface types like `turn/start` or `assistant/attempt`.
   *   A v2 `assistant/message` embeds its exact provider stream and cannot
   *   cite top-level source events (`sourceEventSeqs` is `never`). Non-surface
   *   events accept an optional {@link AppendOptions} carrying the `ignorable`
   *   skip marker for out-of-repo plugin telemetry.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if a store-owned Session is unentered or its creation announcement
   *   has not completed, or if `data` or surface
   *   metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   request-header empty-field or tool-error consistency rules, or the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One iterative pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : [opts?: AppendOptions]
  ): SessionEvent<T>
  append(
    type: SessionEventType | readonly SessionEventInput[],
    data?: SessionEventMap[SessionEventType],
    ...opts: [opts?: SurfaceIntent & AppendOptions]
  ): SessionEvent | readonly SessionEvent[] {
    if (typeof type !== 'string') return this.#appendEvents(type)
    // The conditional tuple types forbid mixing the option shapes at call
    // sites; the body reads both through one intersection view.
    // Payload getters can detach the Session while the snapshots are read.
    this.publicationEntry()
    const snapshot = snapshotAppend(type, data, opts[0], `session event "${type}"`)
    const entry = this.publicationEntry()
    const event = createAppendEvent(snapshot, SessionSeq(this.log.length))
    this.commit(event, entry)
    return event
  }

  /**
   * Validate and publish consecutive events together. Observers see the complete log.
   * @param inputs - event payloads and surface intents in commit order.
   * @returns immutable committed events in the same order.
   * @throws before changing the log if any candidate or synchronous dispatch validation fails.
   */
  #appendEvents(inputs: readonly SessionEventInput[]): readonly SessionEvent[] {
    this.publicationEntry()
    if (inputs.length === 0) return []
    const snapshots = Array.from({ length: inputs.length }, (_, index) => {
      const input = inputs.at(index)
      if (input === undefined) throw new Error(`session batch has an empty member at index ${index}`)
      const [type, data, surfaceOpts] = input
      return snapshotAppend(type, data, surfaceOpts, `session batch member ${index} ("${type}")`)
    })
    // Payload getters may append to or detach the Session.
    const entry = this.publicationEntry()
    const startSeq = this.log.length
    const events = snapshots.map((snapshot, index) => createAppendEvent(snapshot, SessionSeq(startSeq + index)))
    const acceptSurface = this.surfaceManager.prepareBatch(events)
    if (entry !== undefined) entry.lifecycle.beginDispatch()
    try {
      const publications = entry === undefined ? [] : events.map((event) => {
        const args: unknown[] = [this, event]
        const callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...args])
        return { event, args, callbacks }
      })
      for (const event of events) this.log.push(event)
      this.eventsSnapshot = undefined
      acceptSurface()
      if (entry !== undefined) {
        for (const { event, args, callbacks } of publications) {
          this.batchPublication = event
          invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, args, callbacks)
        }
      }
    } finally {
      this.batchPublication = undefined
      if (entry !== undefined && entry.lifecycle.endDispatch()) entry.detach()
    }
    return events
  }

  static {
    commitPluginRecord = (session, type, data) => session.#appendRecord(type, data)
  }

  /**
   * Commit one plugin record; {@link appendPluginRecord} is the only caller.
   * @param type - record type, checked against the plugin record grammar.
   * @param data - JSON payload, snapshotted before it enters the log.
   * @returns the record's sequence number.
   */
  #appendRecord(type: PluginRecordType, data: unknown): SessionSeq {
    this.publicationEntry()
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`plugin record "${type}" carries non-JSON-serializable data`)
    }
    const entry = this.publicationEntry()
    const record: unknown = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      ignorable: true,
    })
    assertPluginRecordEvent(record)
    this.commit(record, entry)
    return record.seq
  }

  /**
   * Read the store attachment for one append, refusing an append that
   * reenters while another append is being published.
   * @returns the attachment, or undefined for a detached Session.
   */
  private publicationEntry(): SessionEntry | undefined {
    const entry = attachments.get(this)
    if (entry === null) {
      throw new Error(`session "${this.id}" cannot append outside a SessionStore`)
    }
    if (entry !== undefined && !entry.lifecycle.isCreationComplete) {
      throw new Error(`session "${this.id}" cannot append before session/created completes`)
    }
    if (entry?.lifecycle.hasOpenDispatch) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    return entry
  }

  /**
   * Accept one frozen candidate at the next sequence number, enter it into the
   * log, and notify `session/event` observers with per-listener containment.
   * @param event - the candidate built at the current log length.
   * @param entry - the attachment read before the candidate was built.
   */
  private commit(event: SessionEvent, entry: SessionEntry | undefined): void {
    this.surfaceManager.validateNext(event)
    if (entry !== undefined) entry.lifecycle.beginDispatch()
    try {
      let callbacks: SessionCallback[] | undefined
      const callbackArgs: unknown[] = [this, event]
      if (entry !== undefined) {
        callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
      }
      this.log.push(event)
      this.eventsSnapshot = undefined
      if (callbacks !== undefined && entry !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
    } finally {
      if (entry !== undefined && entry.lifecycle.endDispatch()) entry.detach()
    }
  }

  /** The three incremental folds over this session's event log. */
  private readonly folds: SessionFolds

  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.snapshotEvents())`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined {
    return this.folds.requestHeader()
  }

  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined {
    return this.folds.requestContext()
  }

  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, with logged message projections applied
   * without changing node membership or message identity.
   *
   * CACHED: pure tail growth costs O(new nodes); a replacement or message projection
   * ({@link SessionSurface.contentGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Unchanged content reuses frozen event data; projected blocks are frozen
   * derived copies. Consumers cannot mutate the log through either form.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[] {
    return this.folds.deriveMessages()
  }

  /**
   * Project one event with all committed message projections applied.
   * The original durable event remains unchanged.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    return this.surfaceManager.deriveEventMessage(event)
  }
}

/**
 * Append one experimental plugin record: an event marked `ignorable` whose
 * type is declared in {@link PluginRecordMap}, outside {@link SessionEventMap}.
 * The plugin record catalog lists it separately from released event schemas.
 * A reader that does not recognize the type retains and skips the record, which never
 * enters the model-visible surface, and fork and resume carry it with the rest
 * of the log. A Session format migration retains records on a best-effort
 * basis, so a record holds plugin-owned state that its owner can lose without
 * changing how the rest of the log is interpreted.
 *
 * Only production source under `packages/experimental/` may call this
 * function; the `verify-plugin-record-callers` gate rejects any other
 * production caller in this repository. Read records back with
 * {@link pluginRecordOf}.
 * @param session - the Session whose log receives the record.
 * @param type - declared record name: `plugin:` followed by slash-separated
 *   segments of lowercase letters, digits, `.`, `_`, and `-`, each starting
 *   with a letter or digit.
 * @param data - JSON payload, snapshotted before it enters the log.
 * @returns the sequence number of the committed record.
 * @throws when `type` is outside that grammar, when `data` is not losslessly
 *   JSON-serializable, or when the call reenters another append's publication;
 *   a rejected record does not change the log.
 */
export function appendPluginRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): SessionSeq {
  return commitPluginRecord(session, type, data)
}

/**
 * Read one committed event as a plugin record. The V3-to-V4 format edge also
 * renames each unknown ignorable V3 event into the `plugin:` namespace, so an
 * owner names its records under its own package name and validates `data`.
 * @param event - any committed Session event, live or restored.
 * @returns the record, or undefined when the event is not an ignorable event
 *   whose type follows the plugin record grammar.
 */
export function pluginRecordOf(event: SessionEvent): PluginRecord | undefined {
  const type: string = event.type
  if (event.ignorable !== true || !isPluginRecordType(type)) return undefined
  return { type, seq: event.seq, time: event.time, data: event.data }
}
