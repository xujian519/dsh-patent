import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_STATE_MARKER,
  EXCLUDED_SNAPSHOT_PATHS,
  SNAPSHOT_EXT,
  SNAPSHOT_PREFIX,
  SNAPSHOT_ROOT,
  assertSafeArchiveEntry,
  createNextSnapshot,
  createSnapshot,
  fingerprintAgentState,
  listSnapshotVersions,
  nextVersion,
  parseSnapshotVersion,
  restoreSnapshot,
  snapshotPath,
  snapshotsDir,
} from '../src/snapshot.ts'

const execFileAsync = promisify(execFile)

describe('snapshot path and version helpers', () => {
  it('builds snapshot paths under the data root', () => {
    const base = '/root'
    expect(snapshotsDir(base)).toBe(join(base, SNAPSHOT_ROOT))
    expect(snapshotPath(base, 3)).toBe(join(base, SNAPSHOT_ROOT, `${SNAPSHOT_PREFIX}3${SNAPSHOT_EXT}`))
  })

  it('parses v<number>.tar.gz names and rejects everything else', () => {
    expect(parseSnapshotVersion('v1.tar.gz')).toBe(1)
    expect(parseSnapshotVersion('v0.tar.gz')).toBe(0)
    expect(parseSnapshotVersion('v2.tar')).toBeNull()
    expect(parseSnapshotVersion('archive.tar.gz')).toBeNull()
    expect(parseSnapshotVersion('v1x.tar.gz')).toBeNull()
  })

  it('excludes vault secrets from every snapshot', () => {
    expect(EXCLUDED_SNAPSHOT_PATHS).toContain('.vault.toml')
  })
})

describe('fingerprintAgentState', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-fingerprint-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stays equal while the directory is untouched', async () => {
    await writeFile(join(dir, 'guidance.md'), 'v1\n')
    expect(await fingerprintAgentState(dir)).toBe(await fingerprintAgentState(dir))
  })

  it('changes when a file is written, removed, or rewritten', async () => {
    await writeFile(join(dir, 'guidance.md'), 'v1\n')
    const first = await fingerprintAgentState(dir)

    await writeFile(join(dir, 'guidance.md'), 'v2 with more text\n')
    const second = await fingerprintAgentState(dir)
    expect(second).not.toBe(first)

    await writeFile(join(dir, 'extra.md'), 'new file\n')
    const third = await fingerprintAgentState(dir)
    expect(third).not.toBe(second)

    await rm(join(dir, 'guidance.md'))
    expect(await fingerprintAgentState(dir)).not.toBe(third)
  })

  it('covers nested directories', async () => {
    await mkdir(join(dir, 'notes'))
    await writeFile(join(dir, 'notes', 'a.md'), 'a\n')
    const initial = await fingerprintAgentState(dir)

    await writeFile(join(dir, 'notes', 'a.md'), 'ab\n')
    expect(await fingerprintAgentState(dir)).not.toBe(initial)
  })
})

describe('snapshot persistence', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'))
    source = await mkdtemp(join(tmpdir(), 'dsh-snapshot-src-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  })

  it('lists no versions for a missing snapshot root and computes version 1', async () => {
    await expect(listSnapshotVersions(dir)).resolves.toEqual([])
    await expect(nextVersion(dir)).resolves.toBe(1)
  })

  it('fails loud when the snapshot root cannot be listed for a non-missing reason', async () => {
    await writeFile(join(dir, SNAPSHOT_ROOT), 'not a directory', 'utf8')
    await expect(listSnapshotVersions(dir)).rejects.toThrow()
  })

  it('lists existing versions ascending and mints the next strictly-higher number', async () => {
    await mkdir(snapshotsDir(dir), { recursive: true })
    await writeFile(snapshotPath(dir, 3), 'x', 'utf8')
    await writeFile(snapshotPath(dir, 1), 'x', 'utf8')
    await writeFile(join(snapshotsDir(dir), 'README'), 'ignored', 'utf8')
    await writeFile(snapshotPath(dir, 2), 'x', 'utf8')

    await expect(listSnapshotVersions(dir)).resolves.toEqual([1, 2, 3])
    await expect(nextVersion(dir)).resolves.toBe(4)
  })

  it('packs the source directory excluding vault secrets', async () => {
    await writeFile(join(source, 'agent.js'), 'console.log(1)', 'utf8')
    await writeFile(join(source, '.vault.toml'), 'secret = true', 'utf8')

    const archive = await createSnapshot(dir, 1, source)
    expect(archive).toBe(snapshotPath(dir, 1))

    const { stdout } = await execFileAsync('tar', ['-tzf', archive])
    expect(stdout).toContain('agent.js')
    expect(stdout).not.toContain('.vault.toml')
  })

  it('restores a snapshot archive into a fresh target directory', async () => {
    await writeFile(join(source, 'agent.js'), 'console.log(1)', 'utf8')
    await createSnapshot(dir, 1, source)

    const target = join(dir, 'restored')
    await restoreSnapshot(dir, 1, target)
    await expect(readFile(join(target, 'agent.js'), 'utf8')).resolves.toBe('console.log(1)')
  })

  it('fails loud when tar cannot pack a missing source directory', async () => {
    await expect(createSnapshot(dir, 1, join(dir, 'nope'))).rejects.toThrow()
  })

  it('fails loud when restoring a missing snapshot archive', async () => {
    await expect(restoreSnapshot(dir, 1, join(dir, 'target'))).rejects.toThrow()
  })

  it('removes target entries the archive never carried, keeping the marker and secret', async () => {
    await writeFile(join(source, 'agent.js'), 'kept', 'utf8')
    await createSnapshot(dir, 1, source)

    const target = join(dir, 'restored')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'agent.js'), 'stale', 'utf8')
    await writeFile(join(target, 'rejected-round.js'), 'left behind', 'utf8')
    await mkdir(join(target, 'rejected-dir'), { recursive: true })
    await writeFile(join(target, 'rejected-dir', 'x.js'), 'x', 'utf8')
    await writeFile(join(target, AGENT_STATE_MARKER), '', 'utf8')
    await writeFile(join(target, '.vault.toml'), 'secret = true', 'utf8')
    await restoreSnapshot(dir, 1, target)

    await expect(readFile(join(target, 'agent.js'), 'utf8')).resolves.toBe('kept')
    // A rejected candidate's extra files must not survive the rollback.
    await expect(readFile(join(target, 'rejected-round.js'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(target, 'rejected-dir', 'x.js'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(target, AGENT_STATE_MARKER), 'utf8')).resolves.toBe('')
    await expect(readFile(join(target, '.vault.toml'), 'utf8')).resolves.toBe('secret = true')
  })

  it('refuses archive entries that escape the restore target', () => {
    expect(() => { assertSafeArchiveEntry('agent.js') }).not.toThrow()
    expect(() => { assertSafeArchiveEntry('./nested/agent.js') }).not.toThrow()
    expect(() => { assertSafeArchiveEntry('../escape.js') }).toThrow(/outside the restore target/)
    expect(() => { assertSafeArchiveEntry('/etc/passwd') }).toThrow(/outside the restore target/)
    expect(() => { assertSafeArchiveEntry('a/../../b') }).toThrow(/outside the restore target/)
    expect(() => { assertSafeArchiveEntry('C:/Windows') }).toThrow(/outside the restore target/)
  })

  it('mints the next version and packs the source under one lock', async () => {
    await writeFile(join(source, 'agent.js'), 'x', 'utf8')
    const first = await createNextSnapshot(dir, source)
    const second = await createNextSnapshot(dir, source)
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(first.archive).toBe(snapshotPath(dir, 1))
    await expect(readFile(second.archive)).resolves.toBeDefined()
  })
})
