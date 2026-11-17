/**
 * Durable stores that sit beside the project document: the in-flight task
 * journal that lets a restarted runtime resume provider work, and the budget
 * ledger the media tool appends every settled charge to. Both are validated
 * at read time because they cross the filesystem boundary.
 * @module @deepseek-ai/dsh-video-mode/store
 */

import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { withKeyLock } from './lock.ts'
import {
  MediaFailure,
  type MediaKind,
  type MediaLedgerEntry,
  type MediaRequest,
  type MediaTaskRecord,
  type MediaTaskRequest,
} from './types.ts'

/** Journal file name inside a production directory. */
export const TASK_JOURNAL_FILE = 'tasks.json'

/** Budget ledger file name inside a production directory. */
export const BUDGET_LEDGER_FILE = 'budget.json'

/** Store format version written by this package. */
export const STORE_SCHEMA_VERSION = 1 as const

/** Publication attempts before a concurrent writer is reported as a store conflict. */
const STORE_WRITE_ATTEMPTS = 3

const kindSchema = z.enum(['image', 'video', 'speech'])

const requestSchema = z.object({
  kind: kindSchema,
  model: z.string().min(1),
  prompt: z.string().min(1),
  durationSec: z.number().positive().optional(),
  aspectRatio: z.string().min(1).optional(),
  resolution: z.string().min(1).optional(),
}).strict()

const pendingTaskSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  kind: kindSchema,
  status: z.enum(['queued', 'submitted', 'running']),
}).strict()

/** One journal record; the task and request must describe the same generation. */
const recordSchema = z.object({
  task: pendingTaskSchema,
  submittedAt: z.number().int().nonnegative(),
  request: requestSchema,
  outputPath: z.string().min(1),
}).strict().refine(record => record.task.kind === record.request.kind, {
  message: 'task and request kinds must match',
}).refine(record => record.task.model === record.request.model, {
  message: 'task and request models must match',
})

/** The task journal document. */
const journalSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  tasks: z.array(recordSchema),
}).strict()

/** One settled charge; `costCny` is stored in yuan for direct budget arithmetic. */
const ledgerEntrySchema = z.object({
  taskId: z.string().min(1),
  kind: kindSchema,
  model: z.string().min(1),
  costCny: z.number().nonnegative(),
  at: z.string().min(1),
}).strict()

/** The budget ledger document. */
const ledgerSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  entries: z.array(ledgerEntrySchema),
}).strict()

/**
 * Resolve one store file beside a project document.
 * @param projectPath - project file path as supplied by the caller.
 * @param file - store file name.
 * @returns the sibling path, relative when the project path is relative.
 */
export function storePathOf(projectPath: string, file: string): string {
  return join(dirname(projectPath), file)
}

/**
 * Read the task journal for one production. A missing file is an empty journal.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns every in-flight record.
 * @throws {@link MediaFailure} `MEDIA_STORE_INVALID` when the file is unreadable or malformed.
 */
export async function readTaskRecords(
  ctx: Context,
  projectPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly MediaTaskRecord[]> {
  const journal = await readSnapshot(ctx, projectPath, TASK_JOURNAL_FILE, journalSchema, cwd, signal)
  return journal?.document.tasks ?? []
}

/**
 * Replace the task journal for one production.
 *
 * Replacement is the caller's intent: the given list wins over what is stored.
 * The write still carries the version it was based on, so a concurrent writer
 * between the snapshot and the publication forces a retry instead of a
 * half-written journal; callers that mean to add or remove one record use
 * {@link recordTask} / {@link forgetTask}, which merge with the stored list.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param records - complete record list to store.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @throws {@link MediaFailure} `MEDIA_STORE_INVALID` for a record the schema rejects.
 * @throws {@link MediaFailure} `MEDIA_STORE_CONFLICT` when the journal keeps changing.
 */
export async function writeTaskRecords(
  ctx: Context,
  projectPath: string,
  records: readonly MediaTaskRecord[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = journalSchema.safeParse({ schemaVersion: STORE_SCHEMA_VERSION, tasks: records })
  if (!parsed.success) {
    throw new MediaFailure(`invalid task journal record: ${issuesOf(parsed.error)}`, 'MEDIA_STORE_INVALID')
  }
  const path = storePathOf(projectPath, TASK_JOURNAL_FILE)
  await withKeyLock(`store:${path}`, () => publishWithRetry('task journal', async () => {
    // Replacement does not need the stored records, only the version it replaces.
    const version = await storeVersion(ctx, path, cwd, signal)
    await writeStoreDocument(ctx, path, parsed.data, version, cwd, signal)
  }))
}

/**
 * Apply one change to the task journal under the in-process lock, publishing it
 * against the version the change was computed from.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @param apply - next record list, or undefined to leave the journal unchanged.
 */
async function mutateJournal(
  ctx: Context,
  projectPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
  apply: (records: readonly MediaTaskRecord[]) => readonly MediaTaskRecord[] | undefined,
): Promise<void> {
  const path = storePathOf(projectPath, TASK_JOURNAL_FILE)
  await withKeyLock(`store:${path}`, () => publishWithRetry('task journal', async () => {
    const snapshot = await readSnapshot(ctx, projectPath, TASK_JOURNAL_FILE, journalSchema, cwd, signal)
    const next = apply(snapshot?.document.tasks ?? [])
    if (next === undefined) return
    const parsed = journalSchema.safeParse({ schemaVersion: STORE_SCHEMA_VERSION, tasks: next })
    if (!parsed.success) {
      throw new MediaFailure(`invalid task journal record: ${issuesOf(parsed.error)}`, 'MEDIA_STORE_INVALID')
    }
    await writeStoreDocument(ctx, path, parsed.data, snapshot?.version, cwd, signal)
  }))
}

/**
 * Insert or replace one in-flight record, keeping submission order.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param record - task snapshot to store.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 */
export async function recordTask(
  ctx: Context,
  projectPath: string,
  record: MediaTaskRecord,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  await mutateJournal(ctx, projectPath, cwd, signal, (records) => {
    const next = [...records.filter(entry => entry.task.id !== record.task.id), record]
    next.sort((left, right) => left.submittedAt - right.submittedAt)
    return next
  })
}

/**
 * Remove one task from the journal. Absence is not an error.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param taskId - task to forget.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 */
export async function forgetTask(
  ctx: Context,
  projectPath: string,
  taskId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  await mutateJournal(ctx, projectPath, cwd, signal, (records) => {
    const next = records.filter(entry => entry.task.id !== taskId)
    return next.length === records.length ? undefined : next
  })
}

/**
 * Find one in-flight record.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param taskId - task to find.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the record, or undefined when the journal has none.
 */
export async function findTaskRecord(
  ctx: Context,
  projectPath: string,
  taskId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<MediaTaskRecord | undefined> {
  const records = await readTaskRecords(ctx, projectPath, cwd, signal)
  return records.find(entry => entry.task.id === taskId)
}

/**
 * Read the budget ledger for one production. A missing file is an empty ledger.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns every settled charge.
 * @throws {@link MediaFailure} `MEDIA_STORE_INVALID` when the file is unreadable or malformed.
 */
export async function readLedger(
  ctx: Context,
  projectPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly MediaLedgerEntry[]> {
  const ledger = await readSnapshot(ctx, projectPath, BUDGET_LEDGER_FILE, ledgerSchema, cwd, signal)
  return ledger?.document.entries ?? []
}

/**
 * Append one charge. A task already present is ignored, so retrying a
 * settlement never double-bills the budget.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param entry - settled charge.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns whether the entry was added.
 */
export async function appendLedgerEntry(
  ctx: Context,
  projectPath: string,
  entry: MediaLedgerEntry,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const path = storePathOf(projectPath, BUDGET_LEDGER_FILE)
  return withKeyLock(`ledger:${path}`, () => publishWithRetry('budget ledger', async () => {
    const snapshot = await readSnapshot(ctx, projectPath, BUDGET_LEDGER_FILE, ledgerSchema, cwd, signal)
    const entries = snapshot?.document.entries ?? []
    if (entries.some(existing => existing.taskId === entry.taskId)) return false
    const parsed = ledgerSchema.safeParse({ schemaVersion: STORE_SCHEMA_VERSION, entries: [...entries, entry] })
    if (!parsed.success) {
      throw new MediaFailure(`invalid budget ledger entry: ${issuesOf(parsed.error)}`, 'MEDIA_STORE_INVALID')
    }
    await writeStoreDocument(ctx, path, parsed.data, snapshot?.version, cwd, signal)
    return true
  }))
}

/**
 * Sum the ledger charges in CNY, working in fen so repeated additions cannot
 * drift a budget comparison.
 * @param entries - ledger entries.
 * @returns accumulated cost in CNY.
 */
export function ledgerCost(entries: readonly MediaLedgerEntry[]): number {
  const fen = entries.reduce((sum, entry) => sum + Math.round(entry.costCny * 100), 0)
  return fen / 100
}

/**
 * Build the persisted request subset from a normalized request.
 * @param request - requested generation.
 * @param model - model id that served it.
 * @returns the fields a provider needs to resume.
 */
export function taskRequestOf(request: {
  readonly kind: MediaKind
  readonly prompt: string
  readonly durationSec?: number
  readonly aspectRatio?: string
  readonly resolution?: string
}, model: string): MediaTaskRequest {
  return requestFields({ kind: request.kind, model, prompt: request.prompt }, request)
}


/** Request fields with strict optionals, accepted by both request vocabularies. */
interface StrictRequest {
  /** Requested capability. */
  readonly kind: MediaKind
  /** Model id that served the request. */
  readonly model: string
  /** Positive prompt of the original request. */
  readonly prompt: string
  /** Requested duration. */
  readonly durationSec?: number
  /** Requested aspect ratio. */
  readonly aspectRatio?: string
  /** Requested resolution label. */
  readonly resolution?: string
}

/**
 * Build the request fields, omitting what the caller left unset.
 * @param base - identity and prompt every request carries.
 * @param source - optional generation fields.
 * @returns the strict request subset.
 */
function requestFields(
  base: { readonly kind: MediaKind; readonly model: string; readonly prompt: string },
  source: {
    readonly durationSec?: number | undefined
    readonly aspectRatio?: string | undefined
    readonly resolution?: string | undefined
  },
): StrictRequest {
  return {
    ...base,
    ...source.durationSec === undefined ? {} : { durationSec: source.durationSec },
    ...source.aspectRatio === undefined ? {} : { aspectRatio: source.aspectRatio },
    ...source.resolution === undefined ? {} : { resolution: source.resolution },
  }
}

/** A parsed store document together with the version it was read at. */
type StoreSnapshot<T> = {
  /** Freshness token the guarded write carries. */
  readonly version: FsVersion
  /** Validated document. */
  readonly document: T
}

/**
 * Whether a guarded write lost the race to another writer.
 * @param error - the write failure.
 * @returns whether the caller should re-read and retry.
 */
function isWriteConflict(error: unknown): boolean {
  return error instanceof FsError
    && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')
}

/**
 * Run one read-modify-publish attempt until it publishes or the attempt budget
 * runs out.
 *
 * Protocol constants fix the budget: a store that keeps changing under a
 * writer is a real conflict the caller must see, not something to spin on.
 * @param action - store name used in the failure message.
 * @param attempt - one guarded attempt; a stale publication throws.
 * @returns the attempt's value.
 * @throws {@link MediaFailure} `MEDIA_STORE_CONFLICT` when every attempt lost the race.
 */
async function publishWithRetry<T>(action: string, attempt: () => Promise<T>): Promise<T> {
  for (let index = 0; index < STORE_WRITE_ATTEMPTS; index += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (!isWriteConflict(error)) throw error
    }
  }
  throw new MediaFailure(
    `the video ${action} changed while it was being updated; retry the call`,
    'MEDIA_STORE_CONFLICT',
  )
}

/**
 * Read and validate one store document with the version it was read at.
 *
 * The version is observed before the text: a writer that replaces the file
 * between the two makes the guarded publication fail, which is the safe
 * direction — the caller re-reads instead of overwriting the newer text.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param file - store file name.
 * @param schema - document schema.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the snapshot, or undefined when the file is absent.
 */
async function readSnapshot<T>(
  ctx: Context,
  projectPath: string,
  file: string,
  schema: z.ZodType<T>,
  cwd: string,
  signal?: AbortSignal,
): Promise<StoreSnapshot<T> | undefined> {
  const target = await ctx.fs.resolve(storePathOf(projectPath, file), { cwd })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) return undefined
  let text: string
  try {
    text = await ctx.fs.readText(target, signal)
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
    throw error
  }
  return { version: info.version, document: parseStore(text, schema, file) }
}

/**
 * Project a persisted request back onto the normalized media request vocabulary.
 * @param request - persisted request subset.
 * @returns the request a provider and estimator accept.
 */
export function requestOfTask(request: MediaTaskRequest): MediaRequest {
  return requestFields({ kind: request.kind, model: request.model, prompt: request.prompt }, request)
}

/**
 * Write one store document as pretty JSON with a trailing newline.
 *
 * A snapshot guards replacement: the write fails with `FS_STALE_VERSION` unless
 * the file is still the one that was read. A missing version means the file was
 * absent, so the write is a guarded create and fails with `FS_NOT_OBSERVED` if
 * another writer created it first.
 * @param ctx - context providing `ctx.fs`.
 * @param path - store path.
 * @param document - validated document.
 * @param version - the read the write replaces, or undefined to create.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the resolved target.
 */
async function writeStoreDocument(
  ctx: Context,
  path: string,
  document: unknown,
  version: FsVersion | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<FsTarget> {
  const target = await ctx.fs.resolve(path, { cwd })
  const expected = version === undefined
    ? { kind: 'createIfAbsent' as const }
    : { kind: 'replaceIfVersion' as const, version }
  await ctx.fs.writeText(target, `${JSON.stringify(document, null, 2)}\n`, expected, signal)
  return target
}

/**
 * Observe the freshness token of a store file without parsing it.
 * @param ctx - context providing `ctx.fs`.
 * @param path - store path.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the version, or undefined when the file is absent.
 */
async function storeVersion(
  ctx: Context,
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<FsVersion | undefined> {
  const target = await ctx.fs.resolve(path, { cwd })
  return (await ctx.fs.stat(target, signal))?.version
}

/**
 * Parse and validate one store document.
 * @param text - file contents.
 * @param schema - document schema.
 * @param file - file name used in diagnostics.
 * @returns the validated document.
 * @throws {@link MediaFailure} `MEDIA_STORE_INVALID` for unreadable JSON or a schema failure.
 */
function parseStore<T>(text: string, schema: z.ZodType<T>, file: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new MediaFailure(`video store ${file} is not valid JSON: ${String(error)}`, 'MEDIA_STORE_INVALID', { cause: error })
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new MediaFailure(`invalid video store ${file}: ${issuesOf(result.error)}`, 'MEDIA_STORE_INVALID')
  }
  return result.data
}

/**
 * Render zod issues for one diagnostic line.
 * @param error - schema failure.
 * @returns semicolon-separated `path: message` pairs.
 */
function issuesOf(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}
