/**
 * JSON persistence for the Synapse workspace graph. The canvas is derived
 * state: DSH remains the source of session truth, and this store only keeps
 * the projection (the layout, fork anchors, and folded cards) plus manual
 * boards a user drew without a DSH session.
 * @module @deepseek-ai/dsh-host-synapse
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Position, ProjectedMessage, Thread, Workspace, WorkspaceState, WorkspaceSummary } from './types.ts'
import {
  TOPIC_COLORS,
  canvasFloorSeq,
  foldToolProcessInto,
  projectableEvent,
  retainCanvasCards,
  retainCanvasState,
  sessionCwd,
  sessionTitle,
  sessionTitleOf,
  titleFromText,
  workspaceTitle,
} from './projection.ts'
import { normalizeState, type LegacyWorkspaceRecord } from './migration.ts'

/** Pick the next palette color; the fallback covers an empty table. */
function topicColor(index: number): string {
  return TOPIC_COLORS[index % TOPIC_COLORS.length] ?? '#3478f6'
}

/**
 * Write the canvas state as JSON, one workspace at a time.
 *
 * The document is the whole canvas, and a heavy one is hundreds of megabytes:
 * serializing it in a single `JSON.stringify` holds the state, its complete
 * JSON text, and that text's UTF-8 buffer in the Host heap at once, which is
 * what a long-lived desktop session runs out of. Chunking keeps the largest
 * transient at one workspace, and the bytes written stay identical to
 * `JSON.stringify(state)`.
 * @param path Destination file.
 * @param state The canvas state to write.
 */
async function writeState(path: string, state: WorkspaceState): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.write(`{"version":${String(state.version)},"hiddenSessionIds":${JSON.stringify(state.hiddenSessionIds)},"workspaces":[`)
    for (const [index, workspace] of state.workspaces.entries()) {
      await handle.write(`${index === 0 ? '' : ','}${JSON.stringify(workspace)}`)
    }
    await handle.write(']}\n')
  } finally {
    await handle.close()
  }
}

/** Longest allowed canvas title (session, thread, or workspace). */
export const MAX_TITLE_LENGTH = 120
/** Longest allowed manual canvas note. */
const MAX_NOTE_LENGTH = 4_000
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800

/** One DSH session summary row delivered by the browser for canvas sync. */
export interface SessionRow {
  id: string
  /** Session cwd; absent rows are skipped by syncSessions. */
  cwd: string
  title?: string
  parentId?: string
  blank?: boolean
}

/** The minimal session facts the canvas projection needs: a listed row from
 * the browser, or a live `Session` folded by the caller. */
interface ThreadSource {
  id: string
  title?: string | null | undefined
  parentId?: string | undefined
  header?: { seedLength?: number | undefined; parentSession?: string | undefined } | undefined
}

interface CreateThreadInput {
  title?: string | undefined
  parentId?: string | undefined
  dshSessionId?: string | undefined
  dshSessionTitle?: string | undefined
  position?: Position | undefined
  color?: string | undefined
}

interface BranchInput {
  title?: string | undefined
  dshSessionId?: string | undefined
  dshSessionTitle?: string | undefined
  position?: Position | undefined
  color?: string | undefined
}

/** Fold a live Session into the minimal facts the canvas projection needs. */
function threadSource(session: Session): ThreadSource {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const title = sessionTitle(session.snapshotEvents())
  return {
    id: session.id,
    ...(title === null ? {} : { title }),
    ...(session.header.parentSession === undefined ? {} : { parentId: session.header.parentSession }),
    header: {
      ...(session.header.isSeeded ? { seedLength: session.inheritedEventCount } : {}),
      ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
    },
  }
}

/** JSON persistence for the Synapse workspace graph. */
export class WorkspaceStore {
  constructor(dataFile: string) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) {
      throw new Error('synapse: config.dataFile must be a non-empty path')
    }
    this.dataFile = dataFile
    this.serial = Promise.resolve()
    this.ready = this.load()
  }

  /** Persistence path for the canvas graph. */
  readonly dataFile: string
  private state!: WorkspaceState
  private serial: Promise<unknown>
  /** Resolves once the store has loaded or created the on-disk state. */
  readonly ready: Promise<void>
  private lastKnownMtime: number | null = null
  private externalModWarned = false
  private lockWarned = false
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  /** Summaries of every canvas workspace, newest first.
   * @returns The workspace summaries. */
  async list(): Promise<WorkspaceSummary[]> {
    await this.ready
    return this.state.workspaces.map(workspace => this.summary(workspace))
  }

  /** A deep clone of one workspace.
   * @param workspaceId The workspace id.
   * @returns The workspace, or NotFoundError when absent. */
  async get(workspaceId: string): Promise<Workspace> {
    await this.ready
    const workspace = this.workspace(workspaceId)
    return structuredClone(workspace)
  }

  /** Create a blank manual workspace.
   * @param title The workspace title.
   * @returns The new workspace summary. */
  async create(title: string): Promise<WorkspaceSummary> {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace: Workspace = {
        id: randomUUID(),
        kind: 'manual',
        cwd: null,
        title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
        createdAt: now,
        updatedAt: now,
        threads: [],
      }
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    })
  }

  /** Add a thread to a workspace; a branch requires its parent to already exist.
   * @param workspaceId The target workspace.
   * @param input The thread fields.
   * @returns The new thread, or InputError/NotFoundError. */
  async createThread(workspaceId: string, input: CreateThreadInput): Promise<Thread> {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input.title,
        parentId: input.parentId,
        dshSessionId: input.dshSessionId,
        dshSessionTitle: input.dshSessionTitle,
        position: input.position,
        color: input.color,
        now,
        order: workspace.threads.length,
      })
      if (thread.parentId !== null && !workspace.threads.some(item => item.id === thread.parentId)) {
        throw new InputError('分支来源不存在')
      }
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /** Fork a thread from a parent; a DSH fork race resolves to the one node.
   * @param threadId The parent thread id.
   * @param input The branch fields.
   * @returns The branch thread, or the existing node when a DSH fork already arrived. */
  async branch(threadId: string, input: BranchInput): Promise<Thread> {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null
      // A DSH fork emits session/created while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.threads.find(item => item.dshSessionId === sessionId)
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input.title === 'string' && input.title.trim() !== '') {
            existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          }
          if (typeof input.dshSessionTitle === 'string') {
            existing.dshSessionTitle = input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH)
          }
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input.title,
        parentId: parent.id,
        dshSessionId: input.dshSessionId,
        dshSessionTitle: input.dshSessionTitle,
        position: input.position ?? { x: parent.position.x + 420, y: parent.position.y + siblings.length * 248 },
        color: input.color ?? parent.color,
        now,
        order: workspace.threads.length,
      })
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /** Keep only the browser-reported sessions on the canvas; DSH remains the source of session truth.
   * @param sessions The rows the browser currently lists.
   * @param removedSessionIds Session ids the browser no longer lists.
   * @returns The surviving workspace summaries. */
  async syncSessions(sessions: SessionRow[], removedSessionIds: string[] = []): Promise<WorkspaceSummary[]> {
    return this.mutate(() => {
      if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
      if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) {
        throw new InputError('removedSessionIds 必须是字符串数组')
      }
      const blankIds = new Set(sessions.filter(item => item.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'dsh') continue
        workspace.threads = workspace.threads.filter(thread => !blankIds.has(thread.dshSessionId ?? '') && !removedIds.has(thread.dshSessionId ?? ''))
      }
      this.state.workspaces = this.state.workspaces.filter(workspace => workspace.kind !== 'dsh' || workspace.threads.length > 0)
      for (const item of sessions) {
        if (typeof item.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal DSH list refresh
        // must not recreate a session the user deliberately archived.
        if (this.state.hiddenSessionIds.includes(item.id)) continue
        const workspace = this.dshWorkspace(item.cwd, 'DSH 任务')
        const source = this.dshThread(workspace, { id: item.id, title: item.title, parentId: item.parentId })
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          source.title = item.title.slice(0, MAX_TITLE_LENGTH)
          source.dshSessionTitle = source.title
        }
      }
      return this.list()
    }, { deferred: true })
  }

  /** Append a manual user note to a thread.
   * @param threadId The target thread id.
   * @param text The note text.
   * @returns The updated thread. */
  async addMessage(threadId: string, text: string): Promise<Thread> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const at = new Date().toISOString()
      thread.messages.push({
        id: randomUUID(),
        text: requiredText(text, MAX_NOTE_LENGTH, 'text'),
        kind: 'user',
        at,
      })
      thread.updatedAt = at
      workspace.updatedAt = at
      return structuredClone(thread)
    })
  }

  /** Rename or reposition a thread.
   * @param threadId The target thread id.
   * @param input The fields to update.
   * @returns The updated thread. */
  async updateThread(threadId: string, input: { title?: string | undefined; position?: Position | undefined }): Promise<Thread> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input.position !== undefined) thread.position = positionOf(input.position)
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    })
  }

  /** Remove a thread and its descendants; the underlying DSH session is preserved.
   * @param threadId The target thread id.
   * @returns The number of removed nodes. */
  async removeThread(threadId: string): Promise<{ removed: number }> {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.threads) {
          if (item.parentId !== null && removal.has(item.parentId) && !removal.has(item.id)) {
            removal.add(item.id)
            changed = true
          }
        }
      }
      for (const item of workspace.threads) {
        if (removal.has(item.id) && item.dshSessionId !== null && !this.state.hiddenSessionIds.includes(item.dshSessionId)) {
          this.state.hiddenSessionIds.push(item.dshSessionId)
        }
      }
      workspace.threads = workspace.threads.filter(item => !removal.has(item.id))
      workspace.updatedAt = new Date().toISOString()
      if (workspace.threads.length === 0) this.state.workspaces = this.state.workspaces.filter(item => item.id !== workspace.id)
      return { removed: removal.size }
    })
  }

  /** Hide every known session and drop all canvas workspaces (legacy reset).
   * @param sessions The session ids (or live sessions) to mark hidden.
   * @returns The reset confirmation. */
  async clearLegacy(sessions: string[] | readonly Session[]): Promise<{ cleared: true }> {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) {
        for (const thread of workspace.threads) if (thread.dshSessionId !== null) hidden.add(thread.dshSessionId)
      }
      for (const session of sessions) hidden.add(typeof session === 'string' ? session : session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true }
    })
  }

  /** Replay one live DSH session into the dedicated projection workspace.
   * @param session The live session to project.
   * @param replayFrom First event seq to project (forks skip their seed prefix).
   * @param workspaceTitleFallback Title for sessions without a cwd.
   * @returns The projected thread, or null when the session was archived. */
  async projectSession(session: Session, replayFrom = 0, workspaceTitleFallback = 'DSH 任务'): Promise<Thread | null> {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return this.projectPersisted(threadSource(session), sessionCwd(session), session.snapshotEvents(), replayFrom, workspaceTitleFallback)
  }

  /** Replay a persisted session log (cold restore or a live snapshot).
   * @param source The minimal session facts.
   * @param cwd The session cwd key.
   * @param events The committed session events.
   * @param replayFrom First event seq to project.
   * @param workspaceTitleFallback Title for sessions without a cwd.
   * @returns The projected thread, or null when the session was archived. */
  async projectPersisted(
    source: ThreadSource,
    cwd: string,
    events: readonly SessionEvent[],
    replayFrom = 0,
    workspaceTitleFallback = 'DSH 任务',
  ): Promise<Thread | null> {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(source.id)) return null
      const workspace = this.dshWorkspace(cwd, workspaceTitleFallback)
      const thread = this.dshThread(workspace, source)
      for (const event of events) {
        if (event.seq >= replayFrom) this.projectEventInto(workspace, thread, event)
      }
      retainCanvasCards(thread)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed DSH session event. Repeated sequence numbers are ignored.
   * @param session The live session the event belongs to.
   * @param event The committed session event.
   * @param workspaceTitleFallback Title for sessions without a cwd.
   * @returns The projected thread, or null when the session was archived. */
  async projectEvent(session: Session, event: SessionEvent, workspaceTitleFallback = 'DSH 任务'): Promise<Thread | null> {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitleFallback)
      const thread = this.dshThread(workspace, threadSource(session))
      this.projectEventInto(workspace, thread, event)
      retainCanvasCards(thread)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project a batch of committed events for one session in a single write.
   * @param session The live session the events belong to.
   * @param events The committed session events.
   * @param workspaceTitleFallback Title for sessions without a cwd.
   * @returns The projected thread, or null when the session was archived. */
  async projectEvents(session: Session, events: readonly SessionEvent[], workspaceTitleFallback = 'DSH 任务'): Promise<Thread | null> {
    if (events.length === 0) return null
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitleFallback)
      const thread = this.dshThread(workspace, threadSource(session))
      for (const event of events) this.projectEventInto(workspace, thread, event)
      retainCanvasCards(thread)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Load the canvas graph from disk, creating an empty state on first run.
   * A file written before the retention window existed is trimmed once here,
   * so an already-oversized canvas comes back inside the window.
   * @returns The loaded (or freshly created) state promise. */
  async load(): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8')) as LegacyWorkspaceRecord
      const { state, migrated } = normalizeState(parsed)
      this.state = state
      const retained = retainCanvasState(state)
      this.lastKnownMtime = await this.fileMtime()
      if (migrated || retained) await this.save()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`synapse: cannot read ${this.dataFile}: ${(error as Error).message}`)
      }
      this.state = { version: 4, hiddenSessionIds: [], workspaces: [] }
      await this.save()
    }
  }

  /**
   * Run a state mutation serialized after prior ones and persist it.
   * @param action The mutation to run.
   * @param options `deferred` writes in the debounced window instead of immediately.
   * @returns The mutation result.
   */
  async mutate<T>(action: () => T, options: { deferred?: boolean } = {}): Promise<T> {
    const { deferred = false } = options
    await this.ready
    const task = this.serial.then(async () => {
      const result = action()
      if (deferred) this.markDirty()
      else await this.save()
      return result
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty(): void {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Cancel a pending debounced write. Every deferred mutation is projection-derived and
   * rebuilds from session logs, so the owner drops the write on disposal instead of
   * letting it land in a torn-down workspace.
   */
  dispose(): void {
    if (this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /** Persist the current state when dirty, ordered after in-flight mutations.
   * @returns The save promise, or a no-op when not dirty. */
  flush(): Promise<unknown> {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(() => this.save())
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Persist the canvas state, adopting a second writer's on-disk state instead of clobbering it. */
  async save(): Promise<void> {
    // Two dsh web instances sharing one profile can write the same canvas
    // state. A write by another instance is never clobbered: the file mtime
    // moving since our last read means a second writer, so this save adopts
    // the disk state and drops the local delta (projection rebuilds from
    // session logs; manual layout is the loss). The cross-process lock still
    // serializes the writers that do race in the same instant.
    const before = await this.fileMtime()
    if (this.lastKnownMtime !== null && before !== null && before !== this.lastKnownMtime) {
      try {
        const parsed = JSON.parse(await readFile(this.dataFile, 'utf8')) as LegacyWorkspaceRecord
        const { state } = normalizeState(parsed)
        this.state = state
      } catch (error) {
        process.stderr.write(`synapse: 无法重载 ${this.dataFile}（${(error as Error).message}），保持当前状态\
`)
      }
      this.lastKnownMtime = before
      if (!this.externalModWarned) {
        this.externalModWarned = true
        process.stderr.write('synapse: workspaces.json 已被另一个 dsh web 实例修改；本实例已重载磁盘状态，未保存的本地画布变更已放弃——请只运行一个实例\n')
      }
      return
    }
    await this.acquireLock()
    try {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      await writeState(temporaryFile, this.state)
      await rename(temporaryFile, this.dataFile)
      this.lastKnownMtime = (await stat(this.dataFile)).mtimeMs
    } finally {
      await this.releaseLock()
    }
  }

  /** The file's last-modified timestamp, or null when absent.
   * @returns The mtime in milliseconds, or null. */
  async fileMtime(): Promise<number | null> {
    try { return (await stat(this.dataFile)).mtimeMs } catch { return null }
  }

  /** Take an exclusive cross-process lock, breaking a stale one; warn when a live process holds it. */
  async acquireLock(): Promise<void> {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      // Breaking a stale lock is best-effort; tryAcquire() below reports whether
      // the lock was taken.
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    if (!this.lockWarned) {
      this.lockWarned = true
      process.stderr.write('synapse: 另一个 dsh web 实例正在写入 workspaces.json——请只运行一个实例，否则画布数据可能互相覆盖\n')
    }
  }

  /** Try to create the exclusive lock file.
   * @param lockFile The lock path.
   * @returns True when the lock was acquired. */
  async tryAcquire(lockFile: string): Promise<boolean> {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window.
   * @param lockFile The lock path.
   * @returns True when the existing lock can be broken. */
  async lockIsStale(lockFile: string): Promise<boolean> {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  /** Delete the exclusive cross-process lock. */
  async releaseLock(): Promise<void> {
    await unlink(`${this.dataFile}.lock`).catch(() => {})
  }

  private workspace(workspaceId: string): Workspace {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  private locateThread(threadId: string): { workspace: Workspace; thread: Thread } {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  private dshWorkspace(cwd: string, fallbackTitle: string): Workspace {
    let workspace = this.state.workspaces.find(item => item.kind === 'dsh' && item.cwd === cwd)
    if (workspace !== undefined) return workspace
    const now = new Date().toISOString()
    workspace = {
      id: randomUUID(),
      kind: 'dsh',
      cwd,
      title: workspaceTitle(cwd, fallbackTitle),
      createdAt: now,
      updatedAt: now,
      threads: [],
    }
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  /** Resolve the canvas thread for a session: existing node, or a fresh one
   * anchored on the durable fork lineage. */
  private dshThread(workspace: Workspace, source: ThreadSource): Thread {
    const sessionId = source.id
    const titleOverride = source.title ?? null
    let thread = workspace.threads.find(item => item.dshSessionId === sessionId)
    if (thread !== undefined) {
      if (typeof titleOverride === 'string' && titleOverride.trim() !== '') {
        const title = titleOverride.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `sourceSeedLength` is DSH's durable fork cut. Keep it even after the
      // session has been restored, when its in-process `firstLiveSeq` moves.
      const seedLength = source.header?.seedLength
      if (Number.isSafeInteger(seedLength) && seedLength !== undefined && seedLength >= 0) thread.sourceSeedLength = seedLength
      return thread
    }
    const parentSessionId = source.parentId ?? source.header?.parentSession ?? null
    const parent = parentSessionId === null ? undefined : workspace.threads.find(item => item.dshSessionId === parentSessionId)
    const now = new Date().toISOString()
    thread = {
      id: randomUUID(),
      title: typeof titleOverride === 'string' && titleOverride.trim() !== ''
        ? titleOverride.slice(0, MAX_TITLE_LENGTH)
        : (parent === undefined ? 'DSH 会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionId: parentSessionId,
      sourceSeedLength: Number.isSafeInteger(source.header?.seedLength) ? (source.header?.seedLength ?? null) : null,
      dshSessionId: sessionId,
      dshSessionTitle: typeof titleOverride === 'string' ? titleOverride.slice(0, MAX_TITLE_LENGTH) : null,
      color: topicColor(workspace.threads.length),
      // DSH projection stores only a neutral semantic anchor. The visual map
      // lays out visible cards from the current conversation graph each render,
      // so old/archived session counts must never leak into future coordinates.
      position: parent === undefined ? { x: 86, y: 82 } : { x: parent.position.x + 400, y: parent.position.y },
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    workspace.threads.push(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionId === sessionId && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  private projectEventInto(workspace: Workspace, thread: Thread, event: SessionEvent): void {
    // A replay that starts below the retained window would re-add the cards the
    // window dropped and push the window forward on every pass.
    const floor = canvasFloorSeq(thread)
    if (floor !== undefined && event.seq < floor) return
    const title = sessionTitleOf(event)
    if (title !== null) {
      thread.title = title.slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
      thread.updatedAt = new Date(event.time).toISOString()
      workspace.updatedAt = thread.updatedAt
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      this.foldToolProcess(thread, event)
      workspace.updatedAt = thread.updatedAt
      return
    }
    const projection = projectableEvent(event)
    if (projection === null || thread.messages.some(message => message.sourceSeq === event.seq)) return
    const at = new Date(event.time).toISOString()
    const message: ProjectedMessage = {
      id: randomUUID(),
      text: projection.text,
      kind: projection.kind,
      sourceSeq: event.seq,
      at,
    }
    if (projection.kind === 'assistant' && event.type === 'assistant/message') {
      message.turn = event.data.turn
      message.step = event.data.step
      message.process = []
    }
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user') {
      thread.title = titleFromText(projection.text)
      thread.dshSessionTitle = thread.title
    }
  }

  /** Fold one tool call or result into the assistant message of its own
   * turn/step, keyed by `callId`, so a tool invocation never becomes a
   * separate canvas card, then stamp the thread as touched. */
  private foldToolProcess(thread: Thread, event: SessionEvent): void {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    foldToolProcessInto(thread.messages, event)
    thread.updatedAt = new Date(event.time).toISOString()
  }

  private thread(input: {
    title: string | undefined
    parentId: string | undefined
    dshSessionId: string | undefined
    dshSessionTitle: string | undefined
    position: Position | undefined
    color: string | undefined
    now: string
    order: number
  }): Thread {
    return {
      id: randomUUID(),
      title: requiredText(input.title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof input.parentId === 'string' && input.parentId.length > 0 ? input.parentId : null,
      dshSessionId: typeof input.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null,
      dshSessionTitle: typeof input.dshSessionTitle === 'string' ? input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      color: (TOPIC_COLORS as readonly string[]).includes(input.color ?? '') ? (input.color ?? '') : topicColor(input.order),
      position: positionOf(input.position ?? { x: 86 + (input.order % 3) * 410, y: 82 + Math.floor(input.order / 3) * 260 }),
      createdAt: input.now,
      updatedAt: input.now,
      messages: [],
      sourceParentSessionId: null,
      sourceSeedLength: null,
    }
  }

  private summary(workspace: Workspace): WorkspaceSummary {
    return {
      id: workspace.id,
      kind: workspace.kind,
      cwd: workspace.cwd,
      title: workspace.title,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      threadCount: workspace.threads.length,
    }
  }
}

/** A request-level validation failure, mapped to a 400 response. */
export class InputError extends Error {}
/** A missing referent, mapped to a 404 response. */
export class NotFoundError extends Error {}

function positionOf(value: Position | undefined): Position {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

function requiredText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}
