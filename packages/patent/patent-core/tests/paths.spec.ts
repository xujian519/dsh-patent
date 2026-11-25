import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfinedPath, resolvePatentOutputDir } from '@deepseek-ai/dsh-patent-core'

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

const drafting = { layoutDir: '04-撰写' as const }

describe('resolvePatentOutputDir', () => {
  it('prefers an explicit directory and keeps it confined to cwd', () => {
    const root = tempDir('dsh-output-root-')
    expect(resolvePatentOutputDir({ outputDir: 'out/docs', caseId: 'ignored' }, root, drafting, fail))
      .toBe(join(root, 'out/docs'))
    expect(() => resolvePatentOutputDir({ outputDir: join('..', 'outside') }, root, drafting, fail))
      .toThrow(/输出目录 越出工作目录/)
  })

  it('writes inside the resolved matter directory when no output directory is passed', () => {
    const cwd = tempDir('dsh-output-cwd-')
    const workRoot = tempDir('dsh-output-work-')
    const matter = resolvePatentOutputDir(
      { caseId: '①张三_无效案' },
      cwd,
      { ...drafting, workRoot },
      fail,
    )
    expect(matter).toBe(join(workRoot, '①张三_无效案', '04-撰写'))
    expect(matter.startsWith(join(cwd, '.dsh'))).toBe(false)
    expect(matter.includes(join('data', 'cases'))).toBe(false)
  })

  it('treats a working directory that already holds the matter log as the matter directory', () => {
    const cwd = tempDir('dsh-output-matter-')
    writeFileSync(join(cwd, '_matter-log.md'), '# log\n')
    expect(resolvePatentOutputDir({}, cwd, drafting, fail)).toBe(join(cwd, '04-撰写'))
    expect(resolvePatentOutputDir({ caseId: basename(cwd) }, cwd, drafting, fail))
      .toBe(join(cwd, '04-撰写'))
  })

  it('still writes an explicitly passed old path at that old location', () => {
    const cwd = tempDir('dsh-output-cwd-')
    const workRoot = tempDir('dsh-output-work-')
    const root = { ...drafting, workRoot }
    expect(resolvePatentOutputDir({ outputDir: '.dsh/documents', caseId: 'A-1' }, cwd, root, fail))
      .toBe(join(cwd, '.dsh', 'documents'))
    expect(resolvePatentOutputDir(
      { outputDir: join('data', 'cases', 'A-1', 'outputs'), caseId: 'A-1' },
      cwd,
      root,
      fail,
    )).toBe(join(cwd, 'data', 'cases', 'A-1', 'outputs'))
  })

  it('fails when the matter directory cannot be resolved and no override is passed', () => {
    const cwd = tempDir('dsh-output-cwd-')
    expect(() => resolvePatentOutputDir({}, cwd, drafting, fail)).toThrow(/无法解析案卷目录/)
    expect(() => resolvePatentOutputDir({ caseId: 'A-1' }, cwd, drafting, fail)).toThrow(/无法解析案卷目录/)
    expect(() => resolvePatentOutputDir({ caseId: 'A-1' }, cwd, { ...drafting, outputRoot: '.dsh/documents' }, fail))
      .toThrow(/无法解析案卷目录/)
  })

  it('uses an explicit output root only when the caller did not name a matter', () => {
    const cwd = tempDir('dsh-output-cwd-')
    expect(resolvePatentOutputDir({}, cwd, { ...drafting, outputRoot: '.dsh/documents' }, fail))
      .toBe(join(cwd, '.dsh', 'documents'))
  })

  it('ignores a blank work root and a blank output root', () => {
    const cwd = tempDir('dsh-output-cwd-')
    writeFileSync(join(cwd, '_matter-log.md'), '# log\n')
    expect(() => resolvePatentOutputDir({ caseId: 'other-case' }, cwd, { ...drafting, workRoot: '   ' }, fail))
      .toThrow(/无法解析案卷目录/)
    const plain = tempDir('dsh-output-plain-')
    expect(() => resolvePatentOutputDir({}, plain, { ...drafting, outputRoot: '  ' }, fail))
      .toThrow(/无法解析案卷目录/)
  })

  it('does not treat a work root without a case id as a matter directory', () => {
    const cwd = tempDir('dsh-output-cwd-')
    const workRoot = tempDir('dsh-output-work-')
    expect(() => resolvePatentOutputDir({}, cwd, { ...drafting, workRoot }, fail)).toThrow(/无法解析案卷目录/)
  })

  it('rejects a caseId that is not a delivery name', () => {
    const cwd = tempDir('dsh-output-cwd-')
    const workRoot = tempDir('dsh-output-work-')
    expect(() => resolvePatentOutputDir({ caseId: '../escape' }, cwd, { ...drafting, workRoot }, fail))
      .toThrow(/案卷号 .* 不可用/)
  })

  it('keeps a resolved matter even when an output root is also configured', () => {
    const cwd = tempDir('dsh-output-cwd-')
    const workRoot = tempDir('dsh-output-work-')
    expect(resolvePatentOutputDir(
      { caseId: 'A-1' },
      cwd,
      { ...drafting, workRoot, outputRoot: '.dsh/documents' },
      fail,
    )).toBe(join(workRoot, 'A-1', '04-撰写'))
  })
})
