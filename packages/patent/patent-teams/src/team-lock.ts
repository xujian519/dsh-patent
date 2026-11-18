/**
 * The team state file layout: lock, atomic writes, and path-safe keys.
 *
 * Every durable team mutation runs through {@link withTeamLock} so a read-modify-write
 * stays serial within the process, and lands through {@link atomicWriteText} so a reader
 * never observes a half-written file. {@link sanitizeKey} turns a caller-supplied name
 * into the single path segment that names that team's or member's file.
 * @module dsh-patent-teams/team-lock
 */

import { createHash } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** In-process mutation queues (promise chains), keyed by mutation scope. */
const queues = new Map<string, Promise<unknown>>()

/** Operations that have entered a scope and not yet left, including waiters. */
const entrants = new Map<string, number>()

/**
 * Adjust the entered-operation count for one scope.
 * @param key - the mutation scope.
 * @param delta - 1 when an operation enters, -1 when it leaves.
 */
function bumpEntrants(key: string, delta: number): void {
  const next = (entrants.get(key) ?? 0) + delta
  if (next <= 0) entrants.delete(key)
  else entrants.set(key, next)
}

/**
 * Serialize one asynchronous operation against a key across the whole process.
 *
 * The operation starts only after the previous holder of the same key settles,
 * and the queue entry is removed when the last waiter finishes so a long-lived
 * process does not retain one promise per scope forever.
 * @param key - the mutation scope.
 * @param fn - the operation to run exclusively.
 * @returns the operation's result.
 */
export async function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  queues.set(key, tail)
  bumpEntrants(key, 1)
  try {
    await previous
    return await fn()
  } finally {
    release()
    bumpEntrants(key, -1)
    if (queues.get(key) === tail) queues.delete(key)
  }
}

/**
 * How many operations have entered this scope and not yet left.
 * A value above 1 means a later caller is waiting on the current holder.
 * Exported for callers outside this package; this package's tests are the only
 * in-repo consumers.
 * @public
 * @param key - the mutation scope.
 * @returns the number of entered operations.
 */
export function teamLockEntrants(key: string): number {
  return entrants.get(key) ?? 0
}

/**
 * Serialize mutations of one team across the whole process.
 * @param key - the team id (or any mutation scope).
 * @param fn - the mutation to run exclusively.
 * @returns the mutation's result.
 */
export async function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return serialize(key, fn)
}

/**
 * Resolve the absolute state root directory.
 * @param workspace - the team's workspace directory.
 * @param stateDir - configured state directory, relative to the workspace.
 * @returns the resolved absolute state root directory.
 */
export function stateRootOf(workspace: string, stateDir: string): string {
  return join(workspace, stateDir)
}

/**
 * Process-local lock key scoping one team's mutations.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @returns the lock key.
 */
export function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

/**
 * Remove the optional UTF-8 BOM some editors prepend to JSON text.
 * @param value - JSON text that may open with a BOM.
 * @returns the text without a leading BOM.
 */
export function stripLeadingBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else — spaces, punctuation, path
 * separators, control characters — folds to `-`. An ASCII-only whitelist
 * mapped *every* non-Latin name onto one shared fallback, which silently
 * merged their mailboxes and rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a
 * long prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  // oxlint-disable-next-line typescript/no-misused-spread -- code-point decomposition is intentional: CJK/emoji truncation
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}

/** Rename attempts before falling back to a direct overwrite. */
const ATOMIC_RENAME_RETRIES = 3
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50
/**
 * Rename error codes worth retrying before the direct-write fallback. On
 * Windows, replacing an existing file whose target is momentarily held open
 * without FILE_SHARE_DELETE surfaces as EPERM (or EACCES/EBUSY variants);
 * EEXIST/ENOTEMPTY cover other "target busy" edge shapes.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

function isRetryableRenameError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Atomically replace one UTF-8 state file through the shared writer.
 *
 * The parent directory must already exist: the state layer creates the team
 * tree first, and requiring it keeps a mistyped path from creating a second
 * tree. The Windows direct-write fallback stays enabled for the reason the
 * shared option documents — a target briefly held open by an editor or indexer
 * would otherwise stall every team mutation.
 * @param file - the target file to replace.
 * @param content - the full replacement content.
 */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, {
    mode: 0o644,
    createParentDirectories: false,
    directWriteFallback: true,
  })
}

/**
 * `rename` with the same transient retry policy as the state-file atomic
 * write, for paths (like archiving a whole team directory) where there is no
 * content-equivalent direct-write degradation on Windows. A short-lived
 * delete-sharing lock on any file below the renamed path is retried a few
 * times before the error propagates.
 * @param from - source path.
 * @param to - destination path.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < ATOMIC_RENAME_RETRIES) {
        await sleep(ATOMIC_RENAME_RETRY_DELAY_MS)
        continue
      }
      throw error
    }
  }
}
