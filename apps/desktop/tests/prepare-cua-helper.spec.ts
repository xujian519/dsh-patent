/** Desktop builds decide how to obtain the Computer Use helper before packing. */
import { expect, it } from 'vitest'
import { planCuaHelper } from '../scripts/prepare-cua-helper.ts'

const macOS = {
  platform: 'darwin' as const,
  shipsCuaBundle: true,
  receiptPresent: false,
  officialPayloadPresent: false,
  development: false,
}

it('leaves targets that do not run macOS untouched', () => {
  for (const platform of ['win32', 'linux'] as const) {
    expect(planCuaHelper({ ...macOS, platform, receiptPresent: true, officialPayloadPresent: true }))
      .toEqual({ kind: 'skip', reason: 'the target platform is not macOS' })
  }
  expect(planCuaHelper({ ...macOS, shipsCuaBundle: false }))
    .toEqual({ kind: 'skip', reason: 'the packed dsh does not ship Computer Use' })
})

it('reuses a helper the checkout already staged', () => {
  expect(planCuaHelper({ ...macOS, receiptPresent: true })).toEqual({ kind: 'present' })
  expect(planCuaHelper({ ...macOS, receiptPresent: true, officialPayloadPresent: true })).toEqual({ kind: 'present' })
})

it('requires a release build to stage the notarized artifact', () => {
  expect(planCuaHelper(macOS)).toEqual({ kind: 'unavailable' })
})

it('compiles the development variant only for a local artifact', () => {
  expect(planCuaHelper({ ...macOS, development: true })).toEqual({ kind: 'development' })
  expect(planCuaHelper({ ...macOS, development: true, receiptPresent: true })).toEqual({ kind: 'present' })
})
