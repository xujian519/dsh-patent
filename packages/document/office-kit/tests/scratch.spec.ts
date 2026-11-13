/** Startup removal of scratch directories left by a previous process. */
import { mkdir, mkdtemp, lstat, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { sweepScratchDirectories } from '../src/scratch.ts'

const fault = vi.hoisted(() => ({ path: undefined as string | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      if (fault.path !== undefined && args[0] === fault.path) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return actual.lstat(...args)
    },
  }
})

const past = new Date(Date.now() - 60_000)
let root: string

afterEach(async () => {
  fault.path = undefined
  await rm(root, { recursive: true, force: true })
})

it('removes an expired scratch directory and leaves fresh directories, links, and other names', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-office-kit-sweep-'))
  const expired = join(root, 'dsh-office-kit-abc123')
  const fresh = join(root, 'dsh-office-kit-def456')
  const other = join(root, 'dsh-office-kit-outputs-aaaaaa')
  const file = join(root, 'dsh-office-kit-ffffff')
  await mkdir(expired)
  await writeFile(join(expired, 'source.docx'), 'old')
  await utimes(expired, past, past)
  await mkdir(fresh)
  await mkdir(other)
  await utimes(other, past, past)
  await writeFile(file, 'not-a-directory')
  await utimes(file, past, past)
  const external = join(root, 'external')
  await mkdir(external)
  await writeFile(join(external, 'kept.txt'), 'kept')
  const link = join(root, 'dsh-office-kit-aaaaaa')
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  await utimes(link, past, past)
  const warn = vi.fn()
  await sweepScratchDirectories(root, 30_000, warn)
  await expect(lstat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await lstat(fresh)).isDirectory()).toBe(true)
  expect((await lstat(other)).isDirectory()).toBe(true)
  expect((await lstat(file)).isFile()).toBe(true)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await import('node:fs/promises').then(fs => fs.readFile(join(external, 'kept.txt'), 'utf8'))).toBe('kept')
  expect(warn).not.toHaveBeenCalled()
})

it('reports a scratch directory that disappears before it can be removed', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-office-kit-sweep-'))
  const expired = join(root, 'dsh-office-kit-abc123')
  await mkdir(expired)
  await utimes(expired, past, past)
  fault.path = expired
  const warn = vi.fn()
  await sweepScratchDirectories(root, 30_000, warn)
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]?.[0]).toContain(expired)
  fault.path = undefined
  expect((await lstat(expired)).isDirectory()).toBe(true)
})

it('ignores a missing scratch root', async () => {
  root = join(tmpdir(), 'dsh-office-kit-sweep-missing')
  const warn = vi.fn()
  await sweepScratchDirectories(join(root, 'absent'), 30_000, warn)
  expect(warn).not.toHaveBeenCalled()
})
