/** Edits share the HMR exclusive section so a reload cannot interleave a write. */
import { expect, it } from 'vitest'
import { configEditorFixture, effectiveConfig, entryOf } from './fixture.ts'

it('runs the whole edit inside runExclusive when an HMR seam is present', async () => {
  const { ctx } = await configEditorFixture()
  const hmr = ctx.get('hmr') as unknown as { calls: number }
  expect(hmr.calls).toBe(0)
  await ctx.configEditor.edit(entryOf(ctx, 'first'), current => ({ ...current, count: 5 }))
  expect(hmr.calls).toBe(1)
  expect(effectiveConfig(ctx, 'first')).toEqual({ ordinary: 'fixed', count: 5 })
})

it('edits directly when the profile runs without HMR', async () => {
  const { ctx } = await configEditorFixture({ hmr: false })
  expect(ctx.get('hmr')).toBeUndefined()
  await ctx.configEditor.edit(entryOf(ctx, 'first'), current => ({ ...current, count: 5 }))
  expect(effectiveConfig(ctx, 'first')).toEqual({ ordinary: 'fixed', count: 5 })
})
