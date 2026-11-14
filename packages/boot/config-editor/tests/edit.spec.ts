/** ConfigEditor.edit: persistence, lifecycle guards, and reconciliation rollback. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { configEditorFixture, effectiveConfig, entryOf } from './fixture.ts'

it('persists a config, reapplies it to the same fiber, and restores it at restart', async () => {
  const { ctx, profile, start } = await configEditorFixture()
  const entry = entryOf(ctx, 'first')
  const fiber = entry.fiber
  await ctx.configEditor.edit(entry, (_current, inherited) => ({ ...inherited, count: 5 }))
  expect(entry.fiber).toBe(fiber)
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({
    id: 'first', name: 'cordis:probe', config: { ordinary: 'fixed', count: 5 },
  })
  expect(effectiveConfig(ctx, entry.options.id)).toEqual({ ordinary: 'fixed', count: 5 })
  await ctx.fiber.dispose()
  const restored = await start()
  expect(effectiveConfig(restored, 'first')).toEqual({ ordinary: 'fixed', count: 5 })
})

it('adds a row for an entry whose bundle layer carries no config', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'config-editor')
  await ctx.configEditor.edit(entry, () => ({ enabled: true }))
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({
    id: 'config-editor', name: 'cordis:editor', config: { enabled: true },
  })
})

it('removes a config that matches the inherited layer and drops an otherwise empty row', async () => {
  const { ctx, profile } = await configEditorFixture()
  writeFileSync(profile.patchPath, [
    '- id: first',
    '  name: cordis:probe',
    '  config:',
    '    ordinary: fixed',
    '    count: 9',
    '- insert:',
    '    - id: inserted',
    '      name: cordis:probe',
    '      config:',
    '        ordinary: inserted',
  ].join('\n'))
  const entry = entryOf(ctx, 'first')
  await ctx.configEditor.edit(entry, (_current, inherited) => ({ ...inherited }))
  // The matching row disappears while unrelated insert rows stay untouched.
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([{ insert: [
    { id: 'inserted', name: 'cordis:probe', config: { ordinary: 'inserted' } },
  ] }])
  expect(effectiveConfig(ctx, entry.options.id)).toEqual({ ordinary: 'fixed', count: 1 })
})

it('keeps row metadata when only the config is removed', async () => {
  const { ctx, profile } = await configEditorFixture()
  writeFileSync(profile.patchPath, '- id: first\n  name: cordis:probe\n  disabled: false\n  config:\n    ordinary: fixed\n    count: 9\n')
  const entry = entryOf(ctx, 'first')
  await ctx.configEditor.edit(entry, (_current, inherited) => ({ ...inherited }))
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([
    { id: 'first', name: 'cordis:probe', disabled: false },
  ])
})

it('preserves expressions in untouched rows', async () => {
  const { ctx, profile, start } = await configEditorFixture()
  writeFileSync(profile.patchPath, '- id: first\n  config:\n    ordinary: !!js "\'expression-value\'"\n    count: 3\n- id: second\n  config:\n    ordinary: !!js "\'untouched-expression\'"\n')
  const entry = entryOf(ctx, 'first')
  await ctx.configEditor.edit(entry, current => ({ ...current, count: 4 }))
  const saved = readFileSync(profile.patchPath, 'utf8')
  expect(saved).toContain('!!js')
  expect(saved).toContain('untouched-expression')
  expect(saved).toContain('count: 4')
  await ctx.fiber.dispose()
  const restored = await start()
  expect(effectiveConfig(restored, 'first')).toEqual({ ordinary: 'expression-value', count: 4 })
  expect(effectiveConfig(restored, 'second')).toEqual({ ordinary: 'untouched-expression', count: 2 })
})

it('rejects an entry that is already gone', async () => {
  const { ctx } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  entry.parent.remove(entry.options.id)
  await expect(ctx.configEditor.edit(entry, current => current)).rejects.toThrow('no longer available')
})

it('rejects an entry an external bundle edit removed before commit', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  const path = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const document = JSON.parse(readFileSync(path, 'utf8')) as Array<{ insert: Array<{ id: string }> }>
  document[0]!.insert = document[0]!.insert.filter(row => row.id !== 'first')
  writeFileSync(path, JSON.stringify(document))
  await expect(ctx.configEditor.edit(entry, current => current)).rejects.toThrow('changed during reload')
})

it('rejects an entry whose plugin was disabled', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  writeFileSync(profile.patchPath, '- id: first\n  disabled: true\n')
  await expect(ctx.configEditor.edit(entry, current => current)).rejects.toThrow('no longer active')
})

it('rejects an edit shadowed by a home patch without touching the profile', async () => {
  const { ctx, profile, home } = await configEditorFixture({ hmr: false })
  writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([
    { id: 'first', config: { ordinary: 'home', count: 9 } },
  ]))
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, (_current, inherited) => ({ ...inherited, count: 3 })))
    .rejects.toThrow('overridden')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('restores the patch and the runtime when the plugin refuses activation', async () => {
  const { ctx, profile } = await configEditorFixture({
    hmr: false,
    apply: (_ctx, config) => {
      if ((config as { ordinary: string }).ordinary === 'rejected') throw new Error('activation refused')
    },
  })
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, ordinary: 'rejected' })))
    .rejects.toThrow('activation refused')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(effectiveConfig(ctx, entry.options.id)).toEqual({ ordinary: 'fixed', count: 1 })
})

it('rejects a config the plugin schema does not accept and leaves the patch untouched', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'first')
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, current => ({ ...current, count: 0 }))).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(effectiveConfig(ctx, entry.options.id)).toEqual({ ordinary: 'fixed', count: 1 })
})

it('creates the patch file when it vanished after validation', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  rmSync(profile.patchPath)
  const entry = entryOf(ctx, 'first')
  await ctx.configEditor.edit(entry, current => ({ ...current, count: 6 }))
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toContainEqual({
    id: 'first', name: 'cordis:probe', config: { ordinary: 'fixed', count: 6 },
  })
})

it('clears a config back to nothing when the entry inherits no config', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  const entry = entryOf(ctx, 'config-editor')
  await ctx.configEditor.edit(entry, (_current, inherited) => ({ ...inherited }))
  // No profile row is needed for an entry that has nothing to override.
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([])
})

it('serializes concurrent edits instead of losing one', async () => {
  const { ctx, profile } = await configEditorFixture({ hmr: false })
  await Promise.all([
    ctx.configEditor.edit(entryOf(ctx, 'first'), current => ({ ...current, count: 5 })),
    ctx.configEditor.edit(entryOf(ctx, 'second'), current => ({ ...current, ordinary: 'concurrent' })),
  ])
  expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual(expect.arrayContaining([
    { id: 'first', name: 'cordis:probe', config: { ordinary: 'fixed', count: 5 } },
    { id: 'second', name: 'cordis:probe', config: { ordinary: 'concurrent' } },
  ]))
  expect(effectiveConfig(ctx, 'first')).toEqual({ ordinary: 'fixed', count: 5 })
  expect(effectiveConfig(ctx, 'second')).toMatchObject({ ordinary: 'concurrent' })
})
