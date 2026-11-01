/**
 * Persisted-schema migration for the Synapse canvas: v1–v3 files upgrade to
 * v4 on load, dropping runtime-context snapshots and folding standalone legacy
 * tool cards into their assistant turn. No runtime plugin code here.
 * @module @deepseek-ai/dsh-host-synapse
 */

import { randomUUID } from 'node:crypto'
import type { Position, ProjectedMessage, Thread, ToolProcessEntry, Workspace, WorkspaceState } from './types.ts'
import { TOPIC_COLORS, isRuntimeContextMessage } from './projection.ts'

/** The persisted-state shapes accepted by normalizeState (older schema versions). */
export interface LegacyWorkspaceRecord {
  version?: number
  updatedAt?: string
  hiddenSessionIds?: unknown
  workspaces?: unknown
}

/** A raw v2–v4 workspace row as persisted before the canvas types were strict. */
interface LegacyWorkspaceRow {
  id?: unknown
  kind?: unknown
  cwd?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  events?: unknown
  threads?: unknown
}

/** A raw thread row as persisted before the canvas types were strict. */
interface LegacyThreadRow {
  id?: unknown
  title?: unknown
  parentId?: unknown
  dshSessionId?: unknown
  dshSessionTitle?: unknown
  color?: unknown
  position?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  messages?: unknown
  notes?: unknown
}

/** Pick the next palette color; the fallback covers an empty table. */
function topicColor(index: number): string {
  return TOPIC_COLORS[index % TOPIC_COLORS.length] ?? '#3478f6'
}

function legacyPosition(row: LegacyThreadRow): Position {
  return typeof row.position === 'object' && row.position !== null
    ? { x: Number((row.position as { x?: unknown }).x), y: Number((row.position as { y?: unknown }).y) }
    : { x: 86, y: 82 }
}

function legacyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  return ''
}

function legacyIso(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Project the thread fields shared by the v1 (messages) and v2 (notes) legacy layouts. */
function projectThreadBase(row: LegacyThreadRow, now: string): Omit<Thread, 'messages'> {
  return {
    id: typeof row.id === 'string' ? row.id : randomUUID(),
    title: typeof row.title === 'string' ? row.title : 'DSH 会话',
    parentId: typeof row.parentId === 'string' ? row.parentId : null,
    sourceParentSessionId: null,
    sourceSeedLength: null,
    dshSessionId: typeof row.dshSessionId === 'string' ? row.dshSessionId : null,
    dshSessionTitle: typeof row.dshSessionTitle === 'string' ? row.dshSessionTitle : null,
    color: typeof row.color === 'string' ? row.color : topicColor(0),
    position: legacyPosition(row),
    createdAt: legacyIso(row.createdAt, now),
    updatedAt: legacyIso(row.updatedAt, now),
  }
}

function threadFromLegacy(row: LegacyThreadRow, cleanupNeeded: boolean): { thread: Thread; runtimeContextCleanup: boolean } {
  const now = new Date().toISOString()
  if (Array.isArray(row.messages)) {
    const messages = (row.messages as ProjectedMessage[]).filter(message => !isRuntimeContextMessage(message))
    return {
      runtimeContextCleanup: messages.length !== (row.messages as ProjectedMessage[]).length,
      thread: {
        ...projectThreadBase(row, now),
        messages,
      },
    }
  }
  // v2 stored notes instead of messages: fold them over as the thread body.
  const notes = Array.isArray(row.notes) ? row.notes as { text?: unknown; at?: unknown }[] : []
  return {
    runtimeContextCleanup: cleanupNeeded,
    thread: {
      ...projectThreadBase(row, now),
      messages: notes.map(note => ({ id: randomUUID(), text: legacyText(note.text), kind: 'user', at: legacyIso(note.at, now) })),
    },
  }
}

/** One v1 workspace body: a flat event list becomes a single thread. */
function workspaceFromLegacyV1(row: LegacyWorkspaceRow, index: number, now: string): Workspace {
  const events = Array.isArray(row.events) ? row.events as { id?: unknown; text?: unknown; at?: unknown }[] : []
  const workspaceNow = legacyIso(row.updatedAt, now)
  return {
    id: typeof row.id === 'string' ? row.id : randomUUID(),
    kind: 'manual',
    cwd: null,
    title: typeof row.title === 'string' && row.title.trim() ? row.title : '未命名工作空间',
    createdAt: legacyIso(row.createdAt, workspaceNow),
    updatedAt: workspaceNow,
    threads: events.length === 0 ? [] : [{
      id: randomUUID(),
      title: typeof row.title === 'string' && row.title.trim() ? row.title : '历史记录',
      parentId: null,
      sourceParentSessionId: null,
      sourceSeedLength: null,
      dshSessionId: null,
      dshSessionTitle: null,
      color: topicColor(index),
      position: { x: 86, y: 82 },
      createdAt: workspaceNow,
      updatedAt: workspaceNow,
      messages: events.map(event => ({
        id: typeof event.id === 'string' ? event.id : randomUUID(),
        text: legacyText(event.text),
        kind: 'user',
        at: legacyIso(event.at, workspaceNow),
      })),
    }],
  }
}

/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 * @param workspaces The canvas workspaces to migrate in place.
 * @returns True when any workspace was rewritten. */
function foldLegacyToolCards(workspaces: Workspace[]): boolean {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads) {
      const folded: ProjectedMessage[] = []
      let assistant: ProjectedMessage | null = null
      let pending: ToolProcessEntry[] = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if ((message as { kind?: string }).kind !== 'tool' && (message as { kind?: string }).kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        const process = assistant.process ??= []
        if ((message as { kind?: string }).kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = message.text.split('\n')
          const entry: ToolProcessEntry = { callId: `legacy-${process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan: ToolProcessEntry = { callId: `legacy-orphan-${process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

/** Upgrade a parsed older-schema file to the current v4 shape.
 * @param value The raw persisted record.
 * @returns The normalized v4 state and whether any migration ran. */
export function normalizeState(value: LegacyWorkspaceRecord): { state: WorkspaceState; migrated: boolean } {
  let migrated = false
  let version: number
  let hiddenSessionIds: string[]
  let workspaces: Workspace[]
  if ((value.version === 2 || value.version === 3 || value.version === 4) && Array.isArray(value.workspaces)) {
    hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter((item): item is string => typeof item === 'string') : []
    migrated = value.version < 3 || !Array.isArray(value.hiddenSessionIds)
    version = value.version
    workspaces = value.workspaces.map((row): Workspace => {
      const legacy = row as LegacyWorkspaceRow
      const threads = Array.isArray(legacy.threads)
        ? legacy.threads.map((thread) => {
          const { thread: normalized, runtimeContextCleanup } = threadFromLegacy(thread as LegacyThreadRow, true)
          if (runtimeContextCleanup) migrated = true
          return normalized
        })
        : []
      return {
        id: typeof legacy.id === 'string' ? legacy.id : randomUUID(),
        kind: legacy.kind === 'dsh' ? 'dsh' : 'manual',
        cwd: typeof legacy.cwd === 'string' ? legacy.cwd : null,
        title: typeof legacy.title === 'string' ? legacy.title : '未命名工作空间',
        createdAt: legacyIso(legacy.createdAt, new Date().toISOString()),
        updatedAt: legacyIso(legacy.updatedAt, new Date().toISOString()),
        threads,
      }
    })
  } else if (value.version === 1 && Array.isArray(value.workspaces)) {
    const now = legacyIso(value.updatedAt, new Date().toISOString())
    hiddenSessionIds = []
    version = 3
    workspaces = value.workspaces.map((row, index) => workspaceFromLegacyV1(row as LegacyWorkspaceRow, index, now))
    migrated = true
  } else {
    throw new Error('expected Synapse data version 1, 2, 3, or 4')
  }
  if (version !== 4) {
    if (foldLegacyToolCards(workspaces)) migrated = true
    version = 4
    migrated = true
  }
  return { state: { version: 4, hiddenSessionIds, workspaces }, migrated }
}
