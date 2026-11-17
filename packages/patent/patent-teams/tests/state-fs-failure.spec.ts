// Failure-injection coverage for the fs-backed state helpers: the temp-file
// cleanup swallow in atomicWriteText and the archive restore AggregateError
// need fs/promises failures that real-fs tests cannot arrange deterministically
// on POSIX, so the module under test is loaded against a delegating mock of
// `node:fs/promises` (the real functions still run unless a test overrides).
import { mkdtemp, open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMailbox, createMessage } from '../src/mailbox.ts'
import { archiveTeamDir, createTeamDir, writeTeam } from '../src/state.ts'
import { renameWithRetry } from '../src/team-lock.ts'
import type { TeamState } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn((...args: Parameters<typeof actual.open>) => actual.open(...args)),
    rm: vi.fn((...args: Parameters<typeof actual.rm>) => actual.rm(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  }
})

// The mocked bindings; the module under test calls these same wrappers.
const { rm, rename } = await import('node:fs/promises')
const openMock = vi.mocked(open)
const rmMock = vi.mocked(rm)
const renameMock = vi.mocked(rename)

const tmpRoots: string[] = []

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'patent-teams-fs-fail-'))
  tmpRoots.push(root)
  return root
}

function makeState(id = 'alpha'): TeamState {
  return {
    name: 'Alpha',
    id,
    captainSessionId: 'captain-1',
    createdAt: 1000,
    members: [],
    tasks: [],
    taskSeq: 0,
  }
}

afterEach(() => {
  // Clear call history only; the vi.fn(impl) wrappers keep delegating to the
  // real fs/promises functions for every test that does not inject a failure.
  openMock.mockClear()
  rmMock.mockClear()
  renameMock.mockClear()
})

describe('fs failure injection', () => {
  it('swallows a temp-file cleanup failure while surfacing the write error', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    rmMock.mockRejectedValueOnce(new Error('rm exploded'))
    // The temp write fails (missing team dir); the cleanup rm fails too.
    await expect(writeTeam(join(root, 'missing'), makeState())).rejects.toThrow()
    expect(rmMock).toHaveBeenCalled()
  })

  it('propagates a non-ENOENT mailbox open failure', async () => {
    const root = await tmpRoot()
    openMock.mockRejectedValueOnce(new Error('permission denied'))
    await expect(
      appendMailbox(root, 'alpha', 'captain', createMessage('alice', 'captain', 'hello')),
    ).rejects.toThrow('permission denied')
    expect(openMock).toHaveBeenCalled()
  })

  it('reports an AggregateError when restoring the displaced archive also fails', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    await createTeamDir(root, makeState())
    // Call 1 (displacement target → previous) succeeds; call 2 (live team →
    // target) and call 3 (restore previous → target) fail, so the combined
    // failure surfaces as an AggregateError.
    renameMock
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('source move failed') })
      .mockImplementationOnce(async () => { throw new Error('restore failed') })
    await expect(archiveTeamDir(root, 'alpha')).rejects.toThrow(AggregateError)
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('still archives normally when the rename mock is not engaged', async () => {
    const root = await tmpRoot()
    await createTeamDir(root, makeState())
    await archiveTeamDir(root, 'alpha')
    const archived = JSON.parse(await readFile(join(root, 'archive', 'alpha', 'team.json'), 'utf8')) as { id: string }
    expect(archived.id).toBe('alpha')
  })

  it('treats a thrown non-Error rename failure as non-retryable', async () => {
    renameMock.mockRejectedValueOnce('rename-boom')
    await expect(renameWithRetry('from', 'to')).rejects.toBe('rename-boom')
    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('treats an absent rename error code as non-retryable', async () => {
    renameMock.mockRejectedValueOnce(Object.assign(new Error('no code'), { code: undefined }))
    await expect(renameWithRetry('from', 'to')).rejects.toThrow('no code')
    expect(renameMock).toHaveBeenCalledTimes(1)
  })
})
