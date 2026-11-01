/** The desktop composition overlay and the package set that must resolve it. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const overlay = join(appDir, 'config', 'desktop.cordis.patch.yml')
const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
  files: readonly string[]
  dependencies: Record<string, string>
}

describe('desktop composition overlay', () => {
  const inserted = loadOverlayPatches('dsh', overlay).flatMap(patch => patch.insert ?? [])
  const row = (id: string) => inserted.find(entry => entry.id === id)

  it('ships the overlay beside the Host entry', () => {
    expect(manifest.files).toContain('config/desktop.cordis.patch.yml')
  })

  it('mounts the shell provider that owns ctx.desktop and the macOS tools', () => {
    expect(row('desktop-shell')?.name).toBe('@deepseek-ai/dsh-desktop-shell')
    expect(row('macos-tools')?.name).toBe('@deepseek-ai/dsh-macos-tools')
  })

  // The overlay names packages outside the dsh CLI's dependency closure, which
  // is why the Host seeds the profile resolution table from its own manifest:
  // a mount this package does not declare would not resolve.
  it.each(['desktop-shell', 'macos-tools'])('declares %s for the resolution table', (id) => {
    expect(Object.keys(manifest.dependencies)).toContain(row(id)?.name)
  })

  it('gates the macOS tools to darwin', () => {
    // Entry `disabled` accepts `!!js`, which the loader defers to boot.
    expect(row('macos-tools')?.disabled).toMatchObject({ __jsExpr: "process.platform !== 'darwin'" })
  })

  it('does not mount the removed workspace sidebar package', () => {
    expect(row('better-sidebar')).toBeUndefined()
    expect(Object.keys(manifest.dependencies)).not.toContain('@deepseek-ai/dsh-better-sidebar')
  })
})
