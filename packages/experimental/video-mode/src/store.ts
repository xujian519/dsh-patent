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
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
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
  const journal = await readDocument(ctx, projectPath, TASK_JOURNAL_FILE, journalSchema, cwd, signal)
  return journal?.tasks ?? []
}

/**
 * Replace the task journal for one production.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param records - complete record list to store.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @throws {@link MediaFailure} `MEDIA_STORE_INVALID` for a record the schema rejects.
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
  await writeStoreText(ctx, storePathOf(projectPath, TASK_JOURNAL_FILE), parsed.data, cwd, signal)
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
  const path = storePathOf(projectPath, TASK_JOURNAL_FILE)
  await withKeyLock(`store:${path}`, async () => {
    const records = await readTaskRecords(ctx, projectPath, cwd, signal)
    const next = [...records.filter(entry => entry.task.id !== record.task.id), record]
    next.sort((left, right) => left.submittedAt - right.submittedAt)
    await writeTaskRecords(ctx, projectPath, next, cwd, signal)
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
  const path = storePathOf(projectPath, TASK_JOURNAL_FILE)
  await withKeyLock(`store:${path}`, async () => {
    const records = await readTaskRecords(ctx, projectPath, cwd, signal)
    const next = records.filter(entry => entry.task.id !== taskId)
    if (next.length === records.length) return
    await writeTaskRecords(ctx, projectPath, next, cwd, signal)
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
  const ledger = await readDocument(ctx, projectPath, BUDGET_LEDGER_FILE, ledgerSchema, cwd, signal)
  return ledger?.entries ?? []
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
  return withKeyLock(`ledger:${path}`, async () => {
    const entries = await readLedger(ctx, projectPath, cwd, signal)
    if (entries.some(existing => existing.taskId === entry.taskId)) return false
    const next = [...entries, entry]
    const parsed = ledgerSchema.safeParse({ schemaVersion: STORE_SCHEMA_VERSION, entries: next })
    if (!parsed.success) {
      throw new MediaFailure(`invalid budget ledger entry: ${issuesOf(parsed.error)}`, 'MEDIA_STORE_INVALID')
    }
    await writeStoreText(ctx, path, parsed.data, cwd, signal)
    return true
  })
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

/**
 * Read and validate one store document.
 * @param ctx - context providing `ctx.fs`.
 * @param projectPath - project file path.
 * @param file - store file name.
 * @param schema - document schema.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the validated document, or undefined when the file is absent.
 */
async function readDocument<T>(
  ctx: Context,
  projectPath: string,
  file: string,
  schema: z.ZodType<T>,
  cwd: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const text = await readStoreText(ctx, storePathOf(projectPath, file), cwd, signal)
  return text === undefined ? undefined : parseStore(text, schema, file)
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
 * Read one store file.
 * @param ctx - context providing `ctx.fs`.
 * @param path - store path.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the text, or undefined when the file is absent.
 */
async function readStoreText(
  ctx: Context,
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const target = await ctx.fs.resolve(path, { cwd })
  try {
    return await ctx.fs.readText(target, signal)
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Write one store document as pretty JSON with a trailing newline.
 * @param ctx - context providing `ctx.fs`.
 * @param path - store path.
 * @param document - validated document.
 * @param cwd - Session working directory for relative resolution.
 * @param signal - caller cancellation.
 * @returns the resolved target.
 */
async function writeStoreText(
  ctx: Context,
  path: string,
  document: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<FsTarget> {
  const target = await ctx.fs.resolve(path, { cwd })
  await ctx.fs.writeText(target, `${JSON.stringify(document, null, 2)}\n`, undefined, signal)
  return target
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
