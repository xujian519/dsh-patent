/**
 * Session sync: mirror user/assistant turns into an OpenViking session and
 * commit them on a user-turn rhythm.
 *
 * Capture reads the session event stream (never a transcript scrape), keys
 * dedupe by the event's monotonic `seq`, and transport is at-least-once: a
 * crash between a successful server append and the state write may replay
 * one message, which the server dedupes through `source_message_ids`.
 * Plugin-injected context, runtime context, and tool results are never
 * mirrored. Library identity changes simply restart sync fresh.
 * @module @deepseek-ai/dsh-openviking/session-sync
 */

import type { Logger } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'

import { OpenVikingClient } from './client.ts'
import { OpenVikingError } from './errors.ts'
import type { AutoCommitConfig } from './config.ts'
import { textOf } from './messages.ts'
import { StateStore } from './state.ts'

/** OpenViking session id for one DSH session. Every subagent owns one.
 * @param dshSessionId - the DSH session id string.
 * @returns the OpenViking-side session id.
 */
export function openvikingSessionIdOf(dshSessionId: string): string {
  return `dsh-${dshSessionId}`
}

/** Config slice the session sync consumes. */
interface SessionSyncConfig {
  readonly autoCommit: AutoCommitConfig
  readonly stateFile: string
}

/** One queued message awaiting mirroring. */
interface QueuedMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Per-session runtime bookkeeping (crash-tolerant parts live in StateStore). */
interface AgentRuntime {
  readonly sessionId: string
  readonly openvikingSessionId: string
  queue: QueuedMessage[]
  pendingUserTurns: number
  countedThisTurn: boolean
  dirty: boolean
}

function isUserSource(source: { kind?: string }): boolean {
  return source.kind === 'user'
}

/**
 * Session mirror + commit scheduler.
 * @param client - OpenViking client.
 * @param store - durable bookkeeping.
 * @param config - resolved config thunk (settings changes apply between turns).
 * @param logger - diagnostics sink.
 */
export class SessionSync {
  private readonly runtimes = new Map<string, AgentRuntime>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private readonly client: OpenVikingClient
  private readonly store: StateStore
  private readonly config: () => SessionSyncConfig
  private readonly logger: Logger
  private readonly schedulerMs: number

  /**
 * @param client - OpenViking HTTP client.
 * @param store - Durable bookkeeping store.
 * @param config - Configuration snapshot for the operation.
 */
  constructor(client: OpenVikingClient, store: StateStore, config: () => SessionSyncConfig, logger: Logger, schedulerMs = 60_000) {
    this.client = client
    this.store = store
    this.config = config
    this.logger = logger
    this.schedulerMs = schedulerMs
  }

  /**
   * Adopt (or re-adopt) a session; existing queue and counts are kept.
   * @param session - The DSH session to adopt.
   * @returns the runtime record for the session (existing or fresh).
   */
  adopt(session: Session): AgentRuntime {
    const sessionId = String(session.id)
    const openvikingSessionId = openvikingSessionIdOf(sessionId)
    let runtime = this.runtimes.get(sessionId)
    if (runtime === undefined) {
      runtime = {
        sessionId,
        openvikingSessionId,
        queue: [],
        pendingUserTurns: this.store.session(openvikingSessionId)?.uncommittedUserTurns ?? 0,
        countedThisTurn: false,
        dirty: false,
      }
      this.runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  /**
   * Drop a disposed session; its queue is discarded (unflushed messages are lost).
   * @param session - The DSH session to forget.
   */
  forget(session: Session): void {
    this.runtimes.delete(String(session.id))
  }

  /**
   * Start the scheduler: every tick, flush queues and apply the interval fallback commit.
   * Overlapping ticks are skipped while a sweep is in flight so a slow server
   * cannot double-drain queues or race the commit's queue reset.
   */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      if (this.ticking !== undefined) return
      this.ticking = this.tick().finally(() => { this.ticking = undefined })
    }, this.schedulerMs)
  }

  /** One scheduler sweep. */
  async tick(): Promise<void> {
    for (const runtime of [...this.runtimes.values()]) {
      await this.flush(runtime.sessionId)
      const config = this.config().autoCommit
      if (!config.enabled) continue
      const state = this.store.session(runtime.openvikingSessionId)
      const turnDue = config.turns > 0 && runtime.pendingUserTurns >= config.turns
      const intervalDue = runtime.dirty && state !== null && state.lastCommitAt !== null
        && Date.now() - state.lastCommitAt >= config.intervalMinutes * 60_000
      if (runtime.dirty && (turnDue || intervalDue)) {
        await this.commit(runtime.sessionId)
      }
    }
  }

  /**
   * Handle one session event; capture-only, never blocks the loop.
   * @param session - The DSH session the event belongs to.
   * @param event - One session event.
   */
  capture(session: Session, event: SessionEvent): void {
    const runtime = this.runtimes.get(String(session.id))
    if (runtime === undefined) return
    switch (event.type) {
      case 'turn/start':
        runtime.countedThisTurn = false
        return
      case 'user/message': {
        const message = event.data
        if (!isUserSource(message.source)) return
        const content = textOf(message.content)
        if (content.length === 0) return
        runtime.queue.push({ seq: event.seq, role: 'user', content })
        runtime.dirty = true
        if (!runtime.countedThisTurn) {
          runtime.countedThisTurn = true
          runtime.pendingUserTurns += 1
          void this.store.setUncommittedTurns(runtime.openvikingSessionId, runtime.pendingUserTurns)
        }
        return
      }
      case 'assistant/message': {
        const message = (event.data as { message: AssistantMessage }).message
        const content = textOf(message.content)
        if (content.length === 0) return
        runtime.queue.push({ seq: event.seq, role: 'assistant', content })
        runtime.dirty = true
        return
      }
      case 'turn/end':
        this.maybeCommitOnTurnEnd(String(session.id))
        return
      default:
        return
    }
  }

  /**
   * Immediately commit when the turn threshold is crossed (called on turn/end).
   * @param sessionId - OpenViking session id.
   */
  maybeCommitOnTurnEnd(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    const autoCommit = this.config().autoCommit
    if (runtime === undefined || !autoCommit.enabled || autoCommit.turns === 0) return
    if (runtime.pendingUserTurns >= autoCommit.turns) {
      void this.commit(sessionId)
    }
  }

  /**
 * Drain the queue to the server; failures keep the queue for the next tick.
 * @param sessionId - OpenViking session id.
 */
  async flush(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (runtime === undefined || runtime.queue.length === 0) return
    const sent = await this.appendBatch(runtime)
    for (const message of sent) {
      await this.store.recordSent(runtime.openvikingSessionId, message.seq)
      runtime.queue.shift()
    }
  }

  /**
 * Commit the current session; no-ops when nothing is dirty.
 * @param sessionId - OpenViking session id.
 */
  async commit(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (runtime === undefined || !runtime.dirty) return
    await this.flush(sessionId)
    try {
      await this.client.commit(runtime.openvikingSessionId, { keepRecentCount: 10 })
      runtime.dirty = false
      runtime.pendingUserTurns = 0
      runtime.queue = []
      await this.store.recordCommit(runtime.openvikingSessionId, Date.now())
    } catch (error) {
      this.warnOnce(sessionId, error)
    }
  }

  /** Stop the scheduler and flush + commit once with a bounded deadline. */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    const enabled = this.config().autoCommit.enabled
    await Promise.allSettled([...this.runtimes.values()].map(async (runtime) => {
      await this.flush(runtime.sessionId)
      // Bounded: keep teardown inside the process grace window.
      if (enabled && runtime.dirty) await this.commitWithTimeout(runtime.sessionId, 3000)
    }))
  }

  private async commitWithTimeout(sessionId: string, timeoutMs: number): Promise<void> {
    await Promise.race([
      this.commit(sessionId),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref()
      }),
    ])
  }

  private async appendBatch(runtime: AgentRuntime): Promise<QueuedMessage[]> {
    const toPayload = (message: QueuedMessage): { role: string; content: string; message_kind: string; source_message_ids: string[] } => ({
      role: message.role,
      content: message.content,
      message_kind: message.role === 'user' ? 'user_query' : 'assistant_step',
      source_message_ids: [String(message.seq)],
    })
    const slice = runtime.queue.slice(0, 100)
    try {
      await this.client.addBatch(runtime.openvikingSessionId, slice.map(toPayload))
      return slice
    } catch (error) {
      if (!(error instanceof OpenVikingError) || (error.httpStatus !== 404 && error.httpStatus !== 405)) {
        this.warnOnce(runtime.sessionId, error)
        return []
      }
      // Older servers without the batch route: fall back to one-at-a-time.
      const sent: QueuedMessage[] = []
      for (const message of slice) {
        try {
          await this.client.addMessage(runtime.openvikingSessionId, toPayload(message))
          sent.push(message)
        } catch (fallbackError) {
          this.warnOnce(runtime.sessionId, fallbackError)
          break
        }
      }
      return sent
    }
  }

  private warned = new Set<string>()
  private warnOnce(sessionId: string, error: unknown): void {
    if (this.warned.has(sessionId)) return
    this.warned.add(sessionId)
    this.logger.warn(`openviking: session sync failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
