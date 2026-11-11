import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfinedPath } from '@deepseek-ai/dsh-patent-core'

const created: string[] = []

/** A fresh real directory under the platform temp root, removed after the test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function fail(message: string): Error {
  return new Error(message)
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveConfinedPath', () => {
  it('resolves a relative path inside the root', () => {
    const root = tempDir('dsh-confine-root-')
    expect(resolveConfinedPath('out/docs', root, '输出目录', fail)).toBe(join(root, 'out/docs'))
  })

  it('accepts an absolute path inside the root', () => {
    const root = tempDir('dsh-confine-root-')
    const inside = join(root, 'out')
    expect(resolveConfinedPath(inside, root, '输出目录', fail)).toBe(inside)
  })

  it('rejects a relative path that climbs out of the root', () => {
    const root = tempDir('dsh-confine-root-')
    expect(() => resolveConfinedPath(join('..', 'outside'), root, '输出目录', fail)).toThrow(/输出目录 越出工作目录/)
  })

  it('rejects an absolute path outside the root', () => {
    const root = tempDir('dsh-confine-root-')
    const outside = tempDir('dsh-confine-outside-')
    expect(() => resolveConfinedPath(outside, root, '输出目录', fail)).toThrow(/越出工作目录/)
  })

  it('rejects a symlink that points out of the root', () => {
    const root = tempDir('dsh-confine-root-')
    const outside = tempDir('dsh-confine-outside-')
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveConfinedPath(join('link', 'file.txt'), root, '输出目录', fail)).toThrow(/越出工作目录/)
  })

  it('rejects a not-yet-created path outside the root', () => {
    const outside = tempDir('dsh-confine-outside-')
    const root = tempDir('dsh-confine-root-')
    // The target does not exist yet, so containment reads the deepest existing ancestor.
    expect(() => resolveConfinedPath(join(outside, 'deep', 'new'), root, '输出目录', fail)).toThrow(/越出工作目录/)
  })
})
