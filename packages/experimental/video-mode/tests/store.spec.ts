/**
 * Durable stores beside the project document: journal and ledger round-trips,
 * ordering, replacement, deduplication, path derivation, and rejection of
 * malformed files.
 */

import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  BUDGET_LEDGER_FILE,
  TASK_JOURNAL_FILE,
  appendLedgerEntry,
  findTaskRecord,
  forgetTask,
  ledgerCost,
  readLedger,
  readTaskRecords,
  recordTask,
  requestOfTask,
  storePathOf,
  taskRequestOf,
  writeTaskRecords,
  type MediaLedgerEntry,
  type MediaTaskRecord,
} from '../src/index.ts'

let root: string
let ctx: Context
let projectPath: string
let ledgerDir: string

/** Deployment workspace root the ledger must stay outside. */
class SandboxPolicyStub extends Service {
  readonly workspaceRoot: string

  /**
   * @param ctx - owning context.
   * @param config - published workspace root.
   */
  constructor(ctx: Context, config: { workspaceRoot: string }) {
    super(ctx, 'sandboxPolicy')
    this.workspaceRoot = config.workspaceRoot
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-store-')))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  projectPath = join(root, 'video', 'one', 'project.json')
  ledgerDir = join(root, '.host-ledgers')
  await mkdir(dirname(projectPath), { recursive: true })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** One in-flight video record. */
function record(overrides: Partial<MediaTaskRecord> = {}): MediaTaskRecord {
  return {
    task: {
      id: 'minimax-video-1',
      provider: 'minimax',
      model: 'MiniMax-H3',
      kind: 'video',
      status: 'running',
    },
    submittedAt: 1_000,
    request: { kind: 'video', model: 'MiniMax-H3', prompt: 'a lantern', durationSec: 4 },
    outputPath: 'shots/s01.mp4',
    ...overrides,
  }
}

/** One ledger entry. */
function entry(overrides: Partial<MediaLedgerEntry> = {}): MediaLedgerEntry {
  return {
    taskId: 'minimax-video-1',
    kind: 'video',
    model: 'MiniMax-H3',
    costCny: 2,
    at: '2026-10-31T00:00:00.000Z',
    ...overrides,
  }
}

describe('store paths', () => {
  it('places both stores beside the project document', () => {
    expect(storePathOf(projectPath, TASK_JOURNAL_FILE)).toBe(join(dirname(projectPath), 'tasks.json'))
    expect(storePathOf('video/one/project.json', BUDGET_LEDGER_FILE)).toBe('video/one/budget.json')
  })

  it('projects the persisted request without empty fields', () => {
    const persisted = taskRequestOf({ kind: 'video', prompt: 'x' }, 'm')
    expect(persisted).toEqual({ kind: 'video', model: 'm', prompt: 'x' })
    expect(requestOfTask({ ...persisted, durationSec: undefined, aspectRatio: undefined, resolution: undefined }))
      .toEqual({ kind: 'video', model: 'm', prompt: 'x' })
    expect(taskRequestOf(
      { kind: 'video', prompt: 'x', durationSec: 4, aspectRatio: '9:16', resolution: '768P' },
      'm',
    )).toEqual({ kind: 'video', model: 'm', prompt: 'x', durationSec: 4, aspectRatio: '9:16', resolution: '768P' })
  })
})

describe('task journal', () => {
  it('treats a missing journal as empty', async () => {
    expect(await readTaskRecords(ctx, projectPath, root)).toEqual([])
    expect(await findTaskRecord(ctx, projectPath, 'none', root)).toBeUndefined()
  })

  it('orders records by submission time and replaces one by task id', async () => {
    await recordTask(ctx, projectPath, record({ submittedAt: 2_000, task: { ...record().task, id: 'b' } }), root)
    await recordTask(ctx, projectPath, record({ submittedAt: 1_000 }), root)
    expect((await readTaskRecords(ctx, projectPath, root)).map(item => item.task.id)).toEqual([
      'minimax-video-1',
      'b',
    ])

    await recordTask(ctx, projectPath, record({ submittedAt: 3_000, task: { ...record().task, status: 'submitted' } }), root)
    const updated = await readTaskRecords(ctx, projectPath, root)
    expect(updated).toHaveLength(2)
    expect(updated.at(-1)?.task.status).toBe('submitted')
    expect((await findTaskRecord(ctx, projectPath, 'b', root))?.submittedAt).toBe(2_000)
  })

  it('forgets a task without creating the file when it is absent', async () => {
    await forgetTask(ctx, projectPath, 'none', root)
    await expect(stat(storePathOf(projectPath, TASK_JOURNAL_FILE))).rejects.toMatchObject({ code: 'ENOENT' })

    await recordTask(ctx, projectPath, record(), root)
    await forgetTask(ctx, projectPath, 'minimax-video-1', root)
    expect(await readTaskRecords(ctx, projectPath, root)).toEqual([])
  })

  it('propagates a transport failure that is not a missing file', async () => {
    await recordTask(ctx, projectPath, record(), root)
    const original = ctx.fs.readText.bind(ctx.fs)
    ctx.fs.readText = async () => { throw new Error('transport down') }
    await expect(readTaskRecords(ctx, projectPath, root)).rejects.toThrow('transport down')
    ctx.fs.readText = original
  })

  it('keeps a record another writer added while the journal write raced', async () => {
    await recordTask(ctx, projectPath, record({ task: { ...record().task, id: 'first' }, submittedAt: 1_000 }), root)
    const original = ctx.fs.writeText.bind(ctx.fs)
    let raced = false
    ctx.fs.writeText = async (target, content, expected, signal, policy) => {
      if (!raced && expected?.kind === 'replaceIfVersion') {
        raced = true
        const current = JSON.parse(await ctx.fs.readText(target)) as { tasks: MediaTaskRecord[] }
        const other = record({ task: { ...record().task, id: 'other' }, submittedAt: 500 })
        await original(target, `${JSON.stringify({ schemaVersion: 1, tasks: [...current.tasks, other] }, null, 2)}\n`)
        throw new FsError('stale', 'FS_STALE_VERSION')
      }
      return original(target, content, expected, signal, policy)
    }
    try {
      await recordTask(ctx, projectPath, record({ task: { ...record().task, id: 'mine' }, submittedAt: 2_000 }), root)
    } finally {
      ctx.fs.writeText = original
    }

    expect((await readTaskRecords(ctx, projectPath, root)).map(item => item.task.id))
      .toEqual(['other', 'first', 'mine'])
  })

  it('fails loud when the journal keeps changing under the write', async () => {
    const original = ctx.fs.writeText.bind(ctx.fs)
    ctx.fs.writeText = async () => { throw new FsError('stale', 'FS_STALE_VERSION') }
    try {
      await expect(recordTask(ctx, projectPath, record(), root))
        .rejects.toMatchObject({ code: 'MEDIA_STORE_CONFLICT' })
    } finally {
      ctx.fs.writeText = original
    }
  })

  it('replaces the journal with the given records', async () => {
    await recordTask(ctx, projectPath, record({ task: { ...record().task, id: 'old' } }), root)
    await writeTaskRecords(ctx, projectPath, [record({ task: { ...record().task, id: 'only' } })], root)

    expect((await readTaskRecords(ctx, projectPath, root)).map(item => item.task.id)).toEqual(['only'])
  })

  it('creates the journal when replacing an absent one', async () => {
    await writeTaskRecords(ctx, projectPath, [record()], root)

    expect((await readTaskRecords(ctx, projectPath, root)).map(item => item.task.id)).toEqual(['minimax-video-1'])
  })

  it('treats a journal deleted between the stat and the read as absent', async () => {
    await recordTask(ctx, projectPath, record(), root)
    const original = ctx.fs.readText.bind(ctx.fs)
    ctx.fs.readText = async () => { throw new FsError('gone', 'FS_NOT_FOUND') }
    try {
      expect(await readTaskRecords(ctx, projectPath, root)).toEqual([])
    } finally {
      ctx.fs.readText = original
    }
  })

  it('retries a guarded create that loses to a concurrent creator', async () => {
    const original = ctx.fs.writeText.bind(ctx.fs)
    let raced = false
    ctx.fs.writeText = async (target, content, expected, signal, policy) => {
      if (!raced && expected?.kind === 'createIfAbsent') {
        raced = true
        await original(target, `${JSON.stringify({ schemaVersion: 1, tasks: [] }, null, 2)}\n`)
        throw new FsError('exists', 'FS_NOT_OBSERVED')
      }
      return original(target, content, expected, signal, policy)
    }
    try {
      await writeTaskRecords(ctx, projectPath, [record()], root)
    } finally {
      ctx.fs.writeText = original
    }

    expect((await readTaskRecords(ctx, projectPath, root)).map(item => item.task.id)).toEqual(['minimax-video-1'])
  })

  it('rejects malformed JSON, a wrong version, and mismatched task fields', async () => {
    const path = storePathOf(projectPath, TASK_JOURNAL_FILE)
    await writeFile(path, '{', 'utf8')
    await expect(readTaskRecords(ctx, projectPath, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })

    await writeFile(path, JSON.stringify({ schemaVersion: 2, tasks: [] }), 'utf8')
    await expect(readTaskRecords(ctx, projectPath, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })

    await writeFile(path, JSON.stringify({ schemaVersion: 1, tasks: [{ ...record(), request: { ...record().request, kind: 'image' } }] }), 'utf8')
    await expect(readTaskRecords(ctx, projectPath, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })

    await writeFile(path, JSON.stringify({ schemaVersion: 1, tasks: [{ ...record(), request: { ...record().request, model: 'other' } }] }), 'utf8')
    await expect(readTaskRecords(ctx, projectPath, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('refuses to write a terminal or malformed record', async () => {
    await expect(writeTaskRecords(ctx, projectPath, [record({ task: { ...record().task, status: 'succeeded' } })], root))
      .rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
    await expect(recordTask(ctx, projectPath, record({ outputPath: '' }), root))
      .rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })
})

describe('budget ledger', () => {
  it('treats a missing ledger as empty and sums charges', async () => {
    expect(await readLedger(ctx, projectPath, ledgerDir, root)).toEqual([])
    expect(ledgerCost([])).toBe(0)
    expect(await appendLedgerEntry(ctx, projectPath, entry(), ledgerDir, root)).toBe(true)
    expect(await appendLedgerEntry(ctx, projectPath, entry({ taskId: 'other', costCny: 0.5 }), ledgerDir, root)).toBe(true)
    expect(ledgerCost(await readLedger(ctx, projectPath, ledgerDir, root))).toBe(2.5)
  })

  it('sums repeated charges in fen without float drift', () => {
    expect(ledgerCost([
      entry({ taskId: 'a', costCny: 0.1 }),
      entry({ taskId: 'b', costCny: 0.2 }),
    ])).toBe(0.3)
  })

  it('ignores a repeated charge for the same task', async () => {
    await appendLedgerEntry(ctx, projectPath, entry(), ledgerDir, root)
    expect(await appendLedgerEntry(ctx, projectPath, entry({ costCny: 9 }), ledgerDir, root)).toBe(false)
    expect(ledgerCost(await readLedger(ctx, projectPath, ledgerDir, root))).toBe(2)
  })

  it('keeps every charge when many append at once', async () => {
    const charges = Array.from({ length: 8 }, (_, index) => entry({ taskId: `task-${index}`, costCny: 0.5 }))

    const results = await Promise.all(
      charges.map(charge => appendLedgerEntry(ctx, projectPath, charge, ledgerDir, root)),
    )

    expect(results).toEqual(Array<boolean>(8).fill(true))
    const ledger = await readLedger(ctx, projectPath, ledgerDir, root)
    expect(ledger.map(item => item.taskId).sort()).toEqual(charges.map(item => item.taskId).sort())
    expect(ledgerCost(ledger)).toBe(4)
  })

  it('keeps every charge two file-system contexts write concurrently', async () => {
    // Two contexts hold independent file-system instances over one ledger, so
    // each read-modify-publish observes the file on its own; the retry branch
    // that reconciles them is pinned separately.
    const peer = new Context()
    await peer.plugin(LocalFileSystem, { cwd: root }).await()
    try {
      await Promise.all([
        appendLedgerEntry(ctx, projectPath, entry({ taskId: 'local-a' }), ledgerDir, root),
        appendLedgerEntry(peer, projectPath, entry({ taskId: 'peer-b' }), ledgerDir, root),
        appendLedgerEntry(ctx, projectPath, entry({ taskId: 'local-c' }), ledgerDir, root),
        appendLedgerEntry(peer, projectPath, entry({ taskId: 'peer-d' }), ledgerDir, root),
      ])

      const ledger = await readLedger(ctx, projectPath, ledgerDir, root)
      expect(ledger.map(item => item.taskId).sort()).toEqual(['local-a', 'local-c', 'peer-b', 'peer-d'])
      expect(ledgerCost(ledger)).toBe(8)
    } finally {
      await peer.fiber.dispose()
    }
  })

  it('keeps a charge another writer appended while the ledger write raced', async () => {
    await appendLedgerEntry(ctx, projectPath, entry({ taskId: 'a' }), ledgerDir, root)
    const original = ctx.fs.writeText.bind(ctx.fs)
    let raced = false
    ctx.fs.writeText = async (target, content, expected, signal, policy) => {
      if (!raced && expected?.kind === 'replaceIfVersion') {
        raced = true
        const current = JSON.parse(await ctx.fs.readText(target)) as { entries: MediaLedgerEntry[] }
        await original(target, `${JSON.stringify({
          schemaVersion: 1,
          entries: [...current.entries, entry({ taskId: 'b' })],
        }, null, 2)}\n`)
        throw new FsError('stale', 'FS_STALE_VERSION')
      }
      return original(target, content, expected, signal, policy)
    }
    try {
      expect(await appendLedgerEntry(ctx, projectPath, entry({ taskId: 'c' }), ledgerDir, root)).toBe(true)
    } finally {
      ctx.fs.writeText = original
    }

    expect((await readLedger(ctx, projectPath, ledgerDir, root)).map(item => item.taskId)).toEqual(['a', 'b', 'c'])
  })

  it('settles a task once when a racing writer charged it first', async () => {
    // The retry after a stale publication re-reads the ledger under the lock, so
    // a peer that settled this task in between turns our append into a no-op
    // instead of a second charge.
    await appendLedgerEntry(ctx, projectPath, entry({ taskId: 'seed' }), ledgerDir, root)
    const original = ctx.fs.writeText.bind(ctx.fs)
    let raced = false
    ctx.fs.writeText = async (target, content, expected, signal, policy) => {
      if (!raced && expected?.kind === 'replaceIfVersion') {
        raced = true
        const current = JSON.parse(await ctx.fs.readText(target)) as { entries: MediaLedgerEntry[] }
        await original(target, `${JSON.stringify({
          schemaVersion: 1,
          entries: [...current.entries, entry({ taskId: 'shared' })],
        }, null, 2)}\n`)
        throw new FsError('stale', 'FS_STALE_VERSION')
      }
      return original(target, content, expected, signal, policy)
    }
    try {
      expect(await appendLedgerEntry(ctx, projectPath, entry({ taskId: 'shared' }), ledgerDir, root)).toBe(false)
    } finally {
      ctx.fs.writeText = original
    }

    const ledger = await readLedger(ctx, projectPath, ledgerDir, root)
    expect(ledger.map(item => item.taskId)).toEqual(['seed', 'shared'])
    expect(ledgerCost(ledger)).toBe(4)
  })

  it('rejects malformed files and invalid new charges', async () => {
    const path = storePathOf(projectPath, BUDGET_LEDGER_FILE)
    await writeFile(path, '[]', 'utf8')
    await expect(readLedger(ctx, projectPath, ledgerDir, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })

    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [entry({ costCny: -1 })] }), 'utf8')
    await expect(readLedger(ctx, projectPath, ledgerDir, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })

    await rm(path)
    await expect(appendLedgerEntry(ctx, projectPath, entry({ costCny: Number.NaN }), ledgerDir, root))
      .rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('imports budget.json once and ignores a later rewrite', async () => {
    const path = storePathOf(projectPath, BUDGET_LEDGER_FILE)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [entry()] }), 'utf8')
    expect(ledgerCost(await readLedger(ctx, projectPath, ledgerDir, root))).toBe(2)

    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [] }), 'utf8')
    expect(ledgerCost(await readLedger(ctx, projectPath, ledgerDir, root))).toBe(2)
    expect(await readdir(ledgerDir)).toHaveLength(1)
  })

  it('rejects a rewritten host ledger', async () => {
    await appendLedgerEntry(ctx, projectPath, entry(), ledgerDir, root)
    const [file] = await readdir(ledgerDir)
    await writeFile(join(ledgerDir, file ?? ''), '[]', 'utf8')
    await expect(readLedger(ctx, projectPath, ledgerDir, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('rejects a relative ledger directory', async () => {
    await expect(readLedger(ctx, projectPath, 'ledgers', root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('rejects a ledger directory inside the session workspace', async () => {
    await ctx.plugin(SandboxPolicyStub, { workspaceRoot: root }).await()
    await expect(appendLedgerEntry(ctx, projectPath, entry(), ledgerDir, root))
      .rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
    await expect(appendLedgerEntry(ctx, projectPath, entry(), root, root))
      .rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('rejects a workspace root that is not absolute', async () => {
    await ctx.plugin(SandboxPolicyStub, { workspaceRoot: 'relative' }).await()
    await expect(readLedger(ctx, projectPath, ledgerDir, root)).rejects.toMatchObject({ code: 'MEDIA_STORE_INVALID' })
  })

  it('treats a blank workspace root as unpublished and writes outside it', async () => {
    await ctx.plugin(SandboxPolicyStub, { workspaceRoot: '' }).await()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-ledger-')))
    try {
      const policies: unknown[] = []
      const original = ctx.fs.writeText.bind(ctx.fs)
      ctx.fs.writeText = async (target, content, expected, signal, policy) => {
        policies.push(policy)
        return original(target, content, expected, signal, policy)
      }
      expect(await appendLedgerEntry(ctx, projectPath, entry(), outside, root)).toBe(true)
      expect(policies).toEqual([{ mode: 'workspace-write', workspaceRoot: outside }])
      await expect(stat(storePathOf(projectPath, BUDGET_LEDGER_FILE))).rejects.toThrow()
      expect(ledgerCost(await readLedger(ctx, projectPath, outside, root))).toBe(2)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('writes the host ledger outside the session workspace', async () => {
    await ctx.plugin(SandboxPolicyStub, { workspaceRoot: root }).await()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-ledger-')))
    try {
      expect(await appendLedgerEntry(ctx, projectPath, entry(), outside, root)).toBe(true)
      await writeFile(storePathOf(projectPath, BUDGET_LEDGER_FILE), JSON.stringify({
        schemaVersion: 1, entries: [],
      }), 'utf8')
      expect(ledgerCost(await readLedger(ctx, projectPath, outside, root))).toBe(2)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
