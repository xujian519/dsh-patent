/**
 * Geometry guards for the generated brand icons. The Dock scales every icon
 * into the same square, so a full-bleed tile reads about a quarter larger than
 * its neighbours; the macOS canvas must keep Apple's transparent template
 * margin, while platforms that mask their own canvas stay full-bleed.
 */

import { describe, expect, it } from 'vitest'
import {
  MACOS_ICON_CANVAS_INSET,
  brandJobs,
  icnsEntries,
  tileGeometry,
} from './generate-brand-icons.ts'

const PALETTE = { from: '#FFFFFF', to: '#EEF2FA', ink: '#0F1115', accent: '#4D6BFE' }

describe('macOS app icon geometry', () => {
  it('insets the background box to the 824px Apple template on a 1024px canvas', () => {
    const geometry = tileGeometry({
      ...PALETTE,
      size: 1024,
      inset: 0.115,
      canvasInset: MACOS_ICON_CANVAS_INSET,
    })
    expect(geometry.canvasInset).toBeCloseTo(100, 6)
    expect(geometry.box).toBeCloseTo(824, 6)
    expect(geometry.radius / geometry.box).toBeCloseTo(0.2237, 6)
  })

  it('keeps tiles that mask their own canvas full-bleed', () => {
    const geometry = tileGeometry({ ...PALETTE, size: 512, inset: 0.21, canvasInset: 0 })
    expect(geometry.canvasInset).toBe(0)
    expect(geometry.box).toBe(512)
  })

  it('renders the desktop source PNG with the template margin', () => {
    const job = brandJobs().find(candidate => candidate.out === 'icon.png' && candidate.width === 1024)
    expect(job).toBeDefined()
    expect(job?.svg).toContain('x="100" y="100" width="824" height="824"')
  })

  it('emits every ICNS representation, including 1024px and the @2x pairs', () => {
    const entries = icnsEntries()
    expect(Math.max(...entries.map(entry => entry.pixels))).toBe(1024)
    expect(new Set(entries.map(entry => entry.pixels))).toEqual(
      new Set([16, 32, 64, 128, 256, 512, 1024]),
    )
    for (const entry of entries) expect(entry.file).toMatch(/^icon_\d+x\d+(@2x)?\.png$/u)
  })
})
