/**
 * Real cross-process budget-ledger publication through built lib. Each child
 * stops after its initial read and before its first guarded write; releasing
 * both forces one create to lose and retry against the other process's file.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MediaLedgerEntry } from '../src/index.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const writerPath = fileURLToPath(new URL('./fixtures/ledger-writer.mjs', import.meta.url))
const built = [
  join(packageRoot, 'lib/index.js'),
  join(packageRoot, '../../fs/fs-local/lib/index.js'),
].every(path => existsSync(path))

let root: string
let projectPath: string
let ledgerDir: string

/** Start one built ledger writer over the current test root. */
function launchWriter(taskId: string) {
  return execa(process.execPath, [writerPath, root, projectPath, ledgerDir, taskId], {
    cwd: packageRoot,
    env: { NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined },
    stdin: 'ignore',
    ipc: true,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
}

/** Run two writers from the same pre-publication state and await their clean exit. */
async function runRace(taskIds: readonly [string, string]): Promise<boolean[]> {
  const writers: ReturnType<typeof launchWriter>[] = []
  try {
    for (const taskId of taskIds) writers.push(launchWriter(taskId))
    expect(await Promise.all(writers.map(writer => writer.getOneMessage())))
      .toEqual(['before-write', 'before-write'])
    await Promise.all(writers.map(writer => writer.sendMessage('release')))
    const results = await Promise.all(writers)
    for (const result of results) {
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    }
    return results.map(result => (JSON.parse(result.stdout) as { appended: boolean }).appended)
  } finally {
    for (const writer of writers) writer.kill('SIGKILL')
    await Promise.all(writers)
  }
}

/** Read the one host ledger without using the implementation under test. */
async function readPersistedEntries(): Promise<MediaLedgerEntry[]> {
  const files = await readdir(ledgerDir)
  expect(files).toHaveLength(1)
  const document = JSON.parse(await readFile(join(ledgerDir, files[0]!), 'utf8')) as {
    schemaVersion: number
    entries: MediaLedgerEntry[]
  }
  expect(document.schemaVersion).toBe(1)
  return document.entries
}

describe.skipIf(!built)('budget ledger across operating-system processes (built lib)', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-ledger-2proc-')))
    projectPath = join(root, 'video', 'one', 'project.json')
    ledgerDir = join(root, '.host-ledgers')
    await mkdir(dirname(projectPath), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps charges from both processes when their task ids differ', { retry: 0 }, async () => {
    expect(await runRace(['process-a', 'process-b'])).toEqual([true, true])

    const entries = await readPersistedEntries()
    expect(entries.map(entry => entry.taskId).sort()).toEqual(['process-a', 'process-b'])
    expect(entries.reduce((sum, entry) => sum + entry.costCny, 0)).toBe(4)
  })

  it('settles a task once when both processes race to charge it', { retry: 0 }, async () => {
    const appended = await runRace(['shared-task', 'shared-task'])
    expect(appended.filter(Boolean)).toHaveLength(1)

    const entries = await readPersistedEntries()
    expect(entries.map(entry => entry.taskId)).toEqual(['shared-task'])
    expect(entries[0]?.costCny).toBe(2)
  })
})
