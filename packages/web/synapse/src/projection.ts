/**
 * Pure projection helpers for the Synapse session map: turning one committed
 * DSH session event into a canvas message card, plus the title/cwd heuristics
 * the store layers on top. No persistence and no plugin context here.
 * @module @deepseek-ai/dsh-host-synapse
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Loads tool-todo's SessionEventMap augmentation so 'todo/write' joins the union.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectedMessage, Thread, ToolProcessEntry, WorkspaceState } from './types.ts'

/** Projected message text cap: longer replies truncate with a marker pointing
 * at the detail view instead of silently cutting mid-sentence. */
const MAX_PROJECTION_LENGTH = 8_000
/** Folded tool-process field cap: one call's arguments or result is card detail
 * and both can carry a whole file or document; the detail view keeps the full text. */
export const MAX_PROCESS_FIELD_LENGTH = 1_000
/** Canvas card window per projected thread: older cards drop off once a session
 * exceeds it. The canvas is a derived summary of recent work, and the whole log
 * stays one `GET /synapse/api/sessions/<id>/history` away. */
export const MAX_THREAD_MESSAGES = 200
/** Canvas tool-fold window per thread: only the newest cards keep their folded
 * tool process. Process entries are append-only and dominate a long session's
 * payload, so folding them for every card a session ever had is what makes the
 * durable canvas outgrow the Host heap. */
export const MAX_THREAD_PROCESS_MESSAGES = 20
/** Marker appended to a truncated projection, pointing at the detail view. */
export const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'

/**
 * Truncate one projected display string to a canvas cap.
 * @param text The display text.
 * @param maxLength The cap in characters.
 * @returns The text, or its head followed by {@link PROJECTION_TRUNCATED_SUFFIX}.
 */
export function clampProjectedText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}${PROJECTION_TRUNCATED_SUFFIX}`
}
/** Topic palette cycling per thread, mirroring the canvas card colors. */
export const TOPIC_COLORS = ['#0f766e', '#2563eb', '#be123c', '#7c3aed', '#b45309'] as const

/** The runtime-context snapshot DSH injects as a user message is internal
 * agent state, never a human question; excluding it keeps one card per turn. */
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

/** Whether a text starts with DSH's pinned runtime-context snapshot.
 * @param text The candidate text.
 * @returns True when it is the runtime-context snapshot. */
export function isRuntimeContextText(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(RUNTIME_CONTEXT_PREFIX)
}

/** Whether a stored canvas message is the runtime-context snapshot.
 * @param message The projected message, if present.
 * @returns True when it is a user message carrying the runtime-context snapshot. */
export function isRuntimeContextMessage(message: { kind?: string; text?: unknown } | undefined): boolean {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}

/** Flatten ordered content blocks into one display string. Tool-call blocks
 * carry their call name and raw arguments, so an unfolded card shows what ran
 * without reading the session log. A tool result's blocks arrive as this
 * message's own content, so the fold needs no nested case.
 * @param content The event content blocks, if present.
 * @returns The flattened display string. */
export function contentText(content: readonly ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  return content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-call') return [block.name, block.arguments]
    return []
  }).filter(value => value.trim() !== '').join('\n')
}

function noteProjection(kind: ProjectedMessage['kind'], text: string): { kind: ProjectedMessage['kind']; text: string } | null {
  const normalized = text.trim()
  if (normalized === '') return null
  return { kind, text: clampProjectedText(normalized, MAX_PROJECTION_LENGTH) }
}

/** Project one event to a card payload, or null when the event is not
 * card-shaped (turn boundaries, chunks, tool process, …).
 * @param event The committed session event.
 * @returns The card-shaped { kind, text }, or null to skip it. */
export function projectableEvent(event: SessionEvent): { kind: ProjectedMessage['kind']; text: string } | null {
  switch (event.type) {
    case 'user/message': {
      // Only human prompts become question cards. DSH injects workspace
      // instructions, skill catalogs, and the runtime-context snapshot as
      // user-role messages with explicit non-human source kinds; a canvas
      // card per injection would bury the actual conversation. The persisted
      // log is a durable boundary: older logs may predate the source field,
      // so it stays optional here.
      const source = (event.data as unknown as { source?: { kind?: string } | null }).source
      if (source !== undefined && source !== null && source.kind !== 'user') return null
      const text = contentText(event.data.content)
      return isRuntimeContextText(text) ? null : noteProjection('user', text)
    }
    case 'assistant/message':
      return noteProjection('assistant', contentText(event.data.message.content))
    case 'todo/write':
      return noteProjection('todo', event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n'))
    case 'turn/end':
      return event.data.reason.kind === 'error' ? noteProjection('error', event.data.reason.error.message) : null
    default:
      return null
  }
}


/** One full-fidelity detail-view message: the whole text, folded tool
 * process, and injected context preserved with its own kind. */
interface DetailMessage {
  id: string
  kind: 'user' | 'assistant' | 'todo' | 'error' | 'context'
  text: string
  at: string
  sourceSeq?: number
  turn?: number
  step?: number
  process?: ToolProcessEntry[]
}

/** An assistant message that can host a folded tool process. */
interface ToolProcessHost {
  readonly kind: string
  readonly turn?: number
  readonly step?: number
  process?: ToolProcessEntry[]
}

/**
 * Fold one tool call or result into the closest assistant message of its
 * turn/step, keyed by `callId`, so a tool invocation never becomes a separate
 * canvas card. A legacy assistant message without `turn`/`step` is the
 * fallback target; an event with no such target is dropped.
 * @param messages - the message list to fold into (mutated in place).
 * @param event - the tool call or result session event.
 */
export function foldToolProcessInto(messages: readonly ToolProcessHost[], event: SessionEvent): void {
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return
  const target = [...messages].reverse().find(message =>
    message.kind === 'assistant'
    && (message.turn === event.data.turn && message.step === event.data.step
      || message.turn === undefined && message.step === undefined))
  if (target === undefined) return
  const process = target.process ??= []
  const callId = String(event.type === 'tool/call' ? event.data.callId : event.data.message.source.callId)
  const entry = process.find(item => item.callId === callId)
  if (event.type === 'tool/call') {
    if (entry === undefined) process.push({ callId, name: event.data.name, arguments: event.data.arguments, result: null, error: null })
    else {
      entry.name = event.data.name
      entry.arguments = event.data.arguments
    }
    return
  }
  const outcome = contentText(event.data.message.content)
  const error = event.data.error === undefined ? null : `${event.data.error.name}: ${event.data.error.code}`
  if (entry === undefined) process.push({ callId, name: '工具调用', arguments: null, result: outcome, error })
  else {
    entry.result = outcome
    entry.error = error
  }
}

/**
 * Apply the canvas retention window to one projected thread in place: keep the
 * newest {@link MAX_THREAD_MESSAGES} cards, drop the folded tool process of
 * cards older than the newest {@link MAX_THREAD_PROCESS_MESSAGES}, and clamp
 * every surviving process field to {@link MAX_PROCESS_FIELD_LENGTH}.
 *
 * This is the single home of the canvas payload bounds, so a file written
 * before the window existed is trimmed by the same rule as a live projection.
 * The window is idempotent: the same cards arrive in `seq` order on a replay,
 * and {@link canvasFloorSeq} keeps the dropped prefix dropped.
 * @param thread The canvas thread to trim.
 * @returns True when anything was dropped or clamped.
 */
export function retainCanvasCards(thread: Pick<Thread, 'messages'>): boolean {
  let changed = false
  if (thread.messages.length > MAX_THREAD_MESSAGES) {
    thread.messages = thread.messages.slice(-MAX_THREAD_MESSAGES)
    changed = true
  }
  const foldFrom = thread.messages.length - MAX_THREAD_PROCESS_MESSAGES
  for (let index = 0; index < thread.messages.length; index++) {
    const message = thread.messages[index]
    if (message === undefined || message.process === undefined) continue
    if (index < foldFrom) {
      delete message.process
      changed = true
      continue
    }
    for (const entry of message.process) {
      // Both fields are loose in data written before the canvas types were
      // strict: an absent one is nothing to clamp.
      if (typeof entry.arguments === 'string') {
        const clamped = clampProjectedText(entry.arguments, MAX_PROCESS_FIELD_LENGTH)
        if (clamped !== entry.arguments) {
          entry.arguments = clamped
          changed = true
        }
      }
      if (typeof entry.result === 'string') {
        const clamped = clampProjectedText(entry.result, MAX_PROCESS_FIELD_LENGTH)
        if (clamped !== entry.result) {
          entry.result = clamped
          changed = true
        }
      }
    }
  }
  return changed
}

/**
 * The lowest `seq` a replay may still project into a windowed thread: the
 * `seq` of its oldest retained card. A replay of the whole log would otherwise
 * re-add the dropped prefix on every pass and push the window forward.
 * @param thread The canvas thread to read.
 * @returns The floor `seq`, or undefined when the thread holds no source card.
 */
export function canvasFloorSeq(thread: Pick<Thread, 'messages'>): number | undefined {
  return thread.messages[0]?.sourceSeq
}

/**
 * Apply {@link retainCanvasCards} to every projected thread of a loaded state.
 *
 * Only `dsh` workspaces are trimmed: their cards are derived from session logs.
 * A manual board carries user-authored notes, which nothing can reconstruct.
 * @param state The loaded canvas state, trimmed in place.
 * @returns True when anything was dropped.
 */
export function retainCanvasState(state: WorkspaceState): boolean {
  let changed = false
  for (const workspace of state.workspaces) {
    if (workspace.kind !== 'dsh') continue
    for (const thread of workspace.threads) if (retainCanvasCards(thread)) changed = true
  }
  return changed
}

/** Options for paging the detail-view history. */
interface ProjectHistoryOptions {
  /** Keep only messages whose sourceSeq is strictly below this (exclusive). */
  beforeSeq?: number
  /** Return the most recent `limit` messages after filtering. */
  limit?: number
}

/** Project one committed log into the full detail-view message list.
 * Unlike the canvas projection, injected context stays visible (kind
 * 'context') and texts are never truncated. Paging happens after the full
 * projection so tool folding completes around the boundary; a page can never
 * orphan a tool process onto a missing turn.
 * @param events The committed session events.
 * @param options Paging: `beforeSeq` keeps only messages with `sourceSeq < it`
 * (exclusive), `limit` returns the most recent messages after filtering.
 * @returns The detail-view message list, optionally paged. */
export function projectHistory(events: readonly SessionEvent[], options: ProjectHistoryOptions = {}): DetailMessage[] {
  const messages = projectDetail(events)
  const { limit, beforeSeq } = options
  let filtered = messages
  if (beforeSeq !== undefined) filtered = filtered.filter(message => message.sourceSeq === undefined || message.sourceSeq < beforeSeq)
  return limit === undefined ? filtered : filtered.slice(-limit)
}

function projectDetail(events: readonly SessionEvent[]): DetailMessage[] {
  const messages: DetailMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = contentText(event.data.content)
      if (text.trim() === '') continue
      const source = (event.data as unknown as { source?: { kind?: string } | null }).source
      const human = source === undefined || source === null || source.kind === 'user'
      messages.push({
        id: `history-${event.seq}`,
        kind: human ? 'user' : 'context',
        text,
        at: new Date(event.time).toISOString(),
        sourceSeq: event.seq,
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText(event.data.message.content)
      if (text.trim() === '') continue
      messages.push({
        id: `history-${event.seq}`,
        kind: 'assistant',
        text,
        at: new Date(event.time).toISOString(),
        sourceSeq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        process: [],
      })
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      foldToolProcessInto(messages, event)
      continue
    }
    if (event.type === 'todo/write') {
      messages.push({
        id: `history-${event.seq}`,
        kind: 'todo',
        text: event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n'),
        at: new Date(event.time).toISOString(),
        sourceSeq: event.seq,
      })
      continue
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      messages.push({
        id: `history-${event.seq}`,
        kind: 'error',
        text: event.data.reason.error.message,
        at: new Date(event.time).toISOString(),
        sourceSeq: event.seq,
      })
    }
  }
  return messages
}

/** First-line title from a user question, matching the canvas card head.
 * @param text The question text.
 * @returns A single-line title truncated to the card head width. */
export function titleFromText(text: string): string {
  const line = text.replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话'
}

/** Read the title payload off one event when it is a session/title record.
 * @param event The session event.
 * @returns The title string, or null when the event carries none. */
export function sessionTitleOf(event: SessionEvent): string | null {
  // session/title is declared by the session-title package through declaration
  // merging; the core SessionEventMap does not know the type, so read the
  // loosely typed slot here and validate the payload at this boundary.
  if ((event.type as string) !== 'session/title') return null
  const title = (event.data as unknown as { title?: unknown }).title
  return typeof title === 'string' ? title : null
}

/** The session's current durable title: the last session/title event, or null.
 * @param events The session events.
 * @returns The most recent title, or null when none was recorded. */
export function sessionTitle(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event !== undefined && sessionTitleOf(event) !== null) return sessionTitleOf(event)
  }
  return null
}

/** A session is blank when no human question ever landed in its log.
 * @param events The session events.
 * @returns True when no user question was recorded. */
export function sessionIsBlank(events: readonly SessionEvent[]): boolean {
  return !events.some(event => event.type === 'user/message')
}

/** The first live seq of a persisted log: after the last seed-boundary marker.
 * @param events The session events.
 * @returns The seq one past the last `session/end-seed`, or 0 when none. */
export function sessionLiveStart(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'session/end-seed') return event.seq + 1
  }
  return 0
}

/** Canvas fallback label when the session carries no cwd. */
export const UNSPECIFIED_CWD = '未指定工作目录'

/** The projection workspace's cwd key: the session cwd, or a neutral sentinel.
 * @param session The session carrying a header cwd.
 * @returns The cwd string, or the unspecified-cwd sentinel when blank. */
export function sessionCwd(session: Pick<Session, 'header'>): string {
  const cwd = session.header.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : UNSPECIFIED_CWD
}

/** Workspace title from its cwd: the last path segment, or the fallback.
 * @param cwd The workspace cwd.
 * @param fallbackTitle The title when the cwd is the unspecified sentinel.
 * @returns The last path segment, or the fallback title. */
export function workspaceTitle(cwd: string, fallbackTitle: string): string {
  if (cwd === UNSPECIFIED_CWD) return fallbackTitle
  const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}
