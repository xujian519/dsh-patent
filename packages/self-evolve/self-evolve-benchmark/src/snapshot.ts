/**
 * Whole-state snapshot versioning for candidate rounds (C3).
 *
 * Before each optimize round the engine packs the agent-state directory into
 * `v<version>.tar.gz` under `<baseDir>/snapshots/`, excluding secrets such as
 * `.vault.toml` — a secret never enters a snapshot. Versions only ever
 * increase and are never reused: every round mints a fresh version, and a
 * rejected round's snapshot stays on disk so its number cannot be recycled.
 * The archive is produced with the platform `tar`, which macOS and Linux
 * provide; tests run against real temporary directories.
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark/snapshot
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const execFileAsync = promisify(execFile)

/** Directory name of the snapshot root under the data root. */
export const SNAPSHOT_ROOT = 'snapshots'

/** Filename prefix of a versioned snapshot. */
export const SNAPSHOT_PREFIX = 'v'

/** Filename extension of a versioned snapshot archive. */
export const SNAPSHOT_EXT = '.tar.gz'

/** Paths excluded from every snapshot archive; a secret never enters a snapshot. */
export const EXCLUDED_SNAPSHOT_PATHS = ['.vault.toml']

/**
 * Marker file whose presence proves a directory is a benchmark agent-state dir
 * rather than the caller's working tree. The provider's constructor and the
 * restore path both require it.
 */
export const AGENT_STATE_MARKER = '.self-evolve-benchmark'

/**
 * Paths {@link restoreSnapshot} keeps in the target even though the archive
 * does not carry them: the secret exclusion and the directory marker.
 */
const RESTORE_PRESERVED = [AGENT_STATE_MARKER, ...EXCLUDED_SNAPSHOT_PATHS]

/**
 * Absolute path of the snapshot root under a data root.
 *
 * @param baseDir Data root for snapshots.
 * @returns Absolute path of the snapshot root.
 */
export function snapshotsDir(baseDir: string): string {
  return join(baseDir, SNAPSHOT_ROOT)
}

/**
 * Absolute path of one version's snapshot archive.
 *
 * @param baseDir Data root for snapshots.
 * @param version Snapshot version.
 * @returns Absolute path of the version's archive.
 */
export function snapshotPath(baseDir: string, version: number): string {
  return join(snapshotsDir(baseDir), `${SNAPSHOT_PREFIX}${version}${SNAPSHOT_EXT}`)
}

/**
 * Parse `v<number>.tar.gz`; non-matching names return `null`.
 *
 * @param filename Snapshot file name.
 * @returns The version number, or `null` when the name does not match.
 */
export function parseSnapshotVersion(filename: string): number | null {
  const match = /^v(\d+)\.tar\.gz$/.exec(filename)
  return match === null ? null : Number(match[1])
}

/**
 * List snapshot versions in ascending order; a missing snapshot root lists none.
 *
 * @param baseDir Data root for snapshots.
 * @returns Existing versions in ascending order.
 */
export async function listSnapshotVersions(baseDir: string): Promise<number[]> {
  let entries
  try {
    entries = await readdir(snapshotsDir(baseDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .map(parseSnapshotVersion)
    .filter((version): version is number => version !== null)
    .sort((a, b) => a - b)
}

/**
 * The next version to mint: one past the highest existing snapshot, so versions
 * only ever increase.
 *
 * @param baseDir Data root for snapshots.
 * @returns The next version number.
 */
export async function nextVersion(baseDir: string): Promise<number> {
  const versions = await listSnapshotVersions(baseDir)
  return versions.reduce((highest, version) => Math.max(highest, version), 0) + 1
}

/**
 * Pack the agent-state directory into `v<version>.tar.gz`, excluding
 * {@link EXCLUDED_SNAPSHOT_PATHS}.
 *
 * @param baseDir Data root for snapshots.
 * @param version Snapshot version.
 * @param sourceDir Agent-state directory to pack.
 * @returns Absolute path of the created archive.
 */
export async function createSnapshot(baseDir: string, version: number, sourceDir: string): Promise<string> {
  const archive = snapshotPath(baseDir, version)
  await mkdir(snapshotsDir(baseDir), { recursive: true })
  const excludeArgs = EXCLUDED_SNAPSHOT_PATHS.flatMap(path => ['--exclude', path])
  await execFileAsync('tar', ['-czf', archive, ...excludeArgs, '-C', sourceDir, '.'])
  return archive
}

/**
 * Mint the next snapshot version and pack the source directory inside one
 * benchmark-level lock, so two concurrent optimize loops cannot both read the
 * same highest version and overwrite each other's archive.
 *
 * @param baseDir Data root for snapshots.
 * @param sourceDir Agent-state directory to pack.
 * @returns The minted version and the absolute path of its archive.
 */
export async function createNextSnapshot(baseDir: string, sourceDir: string): Promise<{ version: number; archive: string }> {
  await mkdir(snapshotsDir(baseDir), { recursive: true })
  // The lock file lives in the snapshot root; its parent always exists here.
  return withFileLock(join(snapshotsDir(baseDir), '.snapshot'), async () => {
    const version = await nextVersion(baseDir)
    const archive = await createSnapshot(baseDir, version, sourceDir)
    return { version, archive }
  }, { waitMs: 60_000 })
}

/**
 * Digest the agent-state directory: every entry's relative path plus each
 * file's bytes, and each symlink's target.
 *
 * The apply seam digests the directory before and after it writes the
 * candidate's files, so a round cannot proceed unless the content actually
 * changed. Content, not size or modification time, is the signal: rewriting a
 * file with identical bytes must still count as unchanged.
 *
 * @param dir Agent-state directory to digest.
 * @returns Hex digest of the directory's current entries.
 */
export async function fingerprintAgentState(dir: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(dir, relative), { withFileTypes: true })
    const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of ordered) {
      const path = relative === '' ? entry.name : join(relative, entry.name)
      const absolute = join(dir, path)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        hash.update(`l\0${path}\0${await readlink(absolute)}\0`)
      } else if (info.isDirectory()) {
        hash.update(`d\0${path}\0`)
        await walk(path)
      } else {
        hash.update(`f\0${path}\0`)
        hash.update(await readFile(absolute))
        hash.update('\0')
      }
    }
  }
  await walk('')
  return hash.digest('hex')
}

/**
 * Whether a relative path could write outside the directory that owns it: an
 * absolute path, a `..` segment, a home-relative path, or a drive-letter
 * prefix. Both the archive restore and the applier's file list are checked
 * with this one rule.
 *
 * @param entry A relative path from an archive listing or an applier.
 * @returns Whether writing to the path could escape the owning directory.
 */
export function isUnsafeRelativePath(entry: string): boolean {
  const parts = entry.split('/').filter(part => part.length > 0 && part !== '.')
  return entry.startsWith('/')
    || entry.startsWith('~')
    || /^[A-Za-z]:/.test(entry)
    || parts.includes('..')
}

/**
 * Reject any archive entry that could write outside the restore target: an
 * absolute path, a `..` segment, or a drive-letter prefix. A malicious or
 * corrupted archive must never escape the agent-state directory.
 *
 * @param entry One `tar -tzf` listing entry.
 * @throws when the entry is not a safe relative path inside the target.
 */
export function assertSafeArchiveEntry(entry: string): void {
  if (isUnsafeRelativePath(entry)) {
    throw new Error(`snapshot: refusing archive entry outside the restore target: ${entry}`)
  }
}

/** List the entries of a snapshot archive; fails loud when the archive is unreadable. */
async function listArchiveEntries(archive: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive])
  return stdout.split('\n').filter(line => line.trim().length > 0)
}

/**
 * Restore a snapshot archive into `targetDir` as an exact replacement.
 *
 * A rejected candidate may have added files the accepted state never had; a
 * plain extract would leave them behind and the "restored" state would still
 * carry the rejected change. Restore therefore lists the archive, refuses any
 * entry that escapes the target, deletes every target entry the archive does
 * not carry (keeping the marker and the excluded secret), and only then
 * extracts.
 *
 * @param baseDir Data root for snapshots.
 * @param version Snapshot version.
 * @param targetDir Directory to restore into.
 * @throws when the archive contains an unsafe entry or cannot be listed.
 */
export async function restoreSnapshot(baseDir: string, version: number, targetDir: string): Promise<void> {
  const archive = snapshotPath(baseDir, version)
  const entries = await listArchiveEntries(archive)
  for (const entry of entries) assertSafeArchiveEntry(entry)
  await mkdir(targetDir, { recursive: true })
  const archived = new Set(entries.map(entry => entry.replace(/^\.\//, '').split('/')[0] as string))
  for (const name of await readdir(targetDir)) {
    if (RESTORE_PRESERVED.includes(name)) continue
    if (archived.has(name)) continue
    await rm(join(targetDir, name), { recursive: true, force: true })
  }
  await execFileAsync('tar', ['-xzf', archive, '-C', targetDir])
}
