import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRealPath } from '@deepseek-ai/dsh-knowledge-core'

const created: string[] = []

/** A fresh real directory under the platform temp root, removed after the test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveRealPath', () => {
  it('returns the real path of an existing file', () => {
    const root = tempDir('dsh-realpath-')
    const file = join(root, 'theme.json')
    writeFileSync(file, '{}')
    expect(resolveRealPath(file)).toBe(join(resolveRealPath(root), 'theme.json'))
  })

  it('keeps missing trailing segments while normalizing the existing ancestor', () => {
    const root = tempDir('dsh-realpath-')
    expect(resolveRealPath(join(root, 'a/b/c'))).toBe(join(resolveRealPath(root), 'a/b/c'))
  })
})
