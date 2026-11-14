/**
 * ConfigEditor.entries / configuration: which rows the editor exposes, which
 * layer owns each value, and what the profile may safely edit.
 */
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { configEditorFixture } from './fixture.ts'

it('lists the entries the profile include owns, in composition order', async () => {
  const { ctx } = await configEditorFixture()
  // The editor is itself an include-owned row and must remain editable.
  expect(ctx.configEditor.entries().map(entry => entry.options.id))
    .toEqual(['config-editor', 'first', 'second'])
})

it('reports bundle values as inherited and leaves the profile override empty', async () => {
  const { ctx } = await configEditorFixture()
  const rows = ctx.configEditor.configuration()
  expect(rows.find(row => row.entry.options.id === 'first')).toMatchObject({
    inherited: { ordinary: 'fixed', count: 1 },
    override: {},
  })
  // A row whose bundle config omits a defaulted field inherits only what it sets.
  expect(rows.find(row => row.entry.options.id === 'second')?.inherited).toEqual({ ordinary: 'second' })
})

it('promotes a profile config key into the override layer', async () => {
  const { ctx, profile } = await configEditorFixture()
  writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'first', config: { ordinary: 'profile', count: 3 } },
  ]))
  const row = ctx.configEditor.configuration().find(candidate => candidate.entry.options.id === 'first')
  expect(row?.override).toEqual({ ordinary: 'profile', count: 3 })
  // Inherited values keep coming from the layer below the profile.
  expect(row?.inherited).toEqual({ ordinary: 'fixed', count: 1 })
})

it('keeps the editor row editable when it carries no config of its own', async () => {
  const { ctx } = await configEditorFixture()
  const row = ctx.configEditor.configuration().find(candidate => candidate.entry.options.id === 'config-editor')
  expect(row?.override).toEqual({})
  expect(row?.inherited).toEqual({})
})

it('flattens grouped insert rows into their own editable entries', async () => {
  const { ctx, profile, start } = await configEditorFixture()
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [{
    id: 'grouped',
    name: 'cordis:group',
    group: true,
    config: [{ id: 'nested', name: 'cordis:probe', config: { ordinary: 'nested' } }],
  }] }]))
  await ctx.fiber.dispose()
  const reloaded = await start()
  const rows = reloaded.configEditor.configuration()
  expect(rows.find(row => row.entry.options.id === 'nested')?.inherited).toEqual({ ordinary: 'nested' })
  expect(rows.find(row => row.entry.options.id === 'nested')?.override).toEqual({})
})

it('falls back to per-entry inheritance when every entry is overridden', async () => {
  const { ctx, profile } = await configEditorFixture()
  writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'config-editor', config: {} },
    { id: 'first', config: { ordinary: 'profile', count: 3 } },
    { id: 'second', config: { ordinary: 'profile-second' } },
  ]))
  const rows = ctx.configEditor.configuration()
  // Composition is skipped, so each layer is recomputed below its own override.
  expect(rows.find(row => row.entry.options.id === 'first')?.inherited).toEqual({ ordinary: 'fixed', count: 1 })
  expect(rows.find(row => row.entry.options.id === 'second')?.inherited).toEqual({ ordinary: 'second' })
})

it('keeps the first composed row when an insert reuses an entry id', async () => {
  const { ctx, profile } = await configEditorFixture()
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'second', name: 'cordis:probe', config: { ordinary: 'inserted' } },
  ] }]))
  const row = ctx.configEditor.configuration().find(candidate => candidate.entry.options.id === 'second')
  // The bundle row comes first in composition order, so the insert cannot shadow it.
  expect(row?.inherited).toEqual({ ordinary: 'second' })
})
