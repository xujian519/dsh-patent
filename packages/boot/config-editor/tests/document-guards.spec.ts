/** Edits must never leave a partially written or unparseable patch behind. */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { configEditorFixture, entryOf } from './fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile) }
})

it('rejects a read failure other than ENOENT and keeps the patch', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, count: 6 }))).rejects.toThrow('denied')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('rejects a document corrupted after validation', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  vi.mocked(readFile).mockResolvedValueOnce('- id: [\n')
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, count: 6 }))).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('rejects a document that is not a top-level sequence', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  vi.mocked(readFile).mockResolvedValueOnce('{ id: first }\n')
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, count: 6 })))
    .rejects.toThrow('must be a YAML sequence')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})
