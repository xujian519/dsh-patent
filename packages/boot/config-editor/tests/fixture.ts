/** Real profile patches and Loader updates for ConfigEditor tests. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '../src/index.ts'

/** One booted profile with the editor mounted as a real `cordis:editor` row. */
export interface EditorFixture {
  ctx: Context
  profile: ProfileContext
  home: string
  /** Reboot the same profile after disposing `ctx`. */
  start: () => Promise<Context>
}

/** Build a profile whose bundle contributes the editor and two probe rows. */
export function configEditorFixture(options: {
  schema?: z
  apply?: (ctx: Context, config: unknown) => void
  hmr?: boolean
} = {}): Promise<EditorFixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'config-editor-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'first', name: 'cordis:probe', config: { ordinary: 'fixed', count: 1 } },
    { id: 'second', name: 'cordis:probe', config: { ordinary: 'second' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const Probe = {
    Config: options.schema ?? z.object({
      ordinary: z.string().required(),
      count: z.number().min(1).default(2).volatile(),
    }),
    apply: options.apply ?? (() => {}),
  }
  const start = async (): Promise<Context> => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, probe: Probe })
    })
    onTestFinished(async () => { await ctx.fiber.dispose() })
    if (options.hmr !== false) {
      // A stand-in for the HMR seam: ConfigEditor only needs runExclusive, and
      // the real plugin opens profile watchers that exhaust CI watch limits.
      ctx.provide('hmr', {
        calls: 0,
        async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
          this.calls += 1
          return operation()
        },
      })
    }
    return ctx
  }
  return start().then(ctx => ({ ctx, profile, home, start }))
}

/** The single Loader entry carrying `id`, failing loudly when the profile lacks it. */
export function entryOf(ctx: Context, id: string) {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`profile has no entry ${id}`)
  return entry
}

/** Effective config with volatile fields unwrapped to their current values. */
export function effectiveConfig(ctx: Context, id: string): Record<string, unknown> | undefined {
  const config = entryOf(ctx, id).fiber?.effectiveConfig as Record<string, unknown> | undefined
  if (config === undefined) return undefined
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key,
    typeof (value as { get?: unknown } | null)?.get === 'function'
      ? (value as { get: () => unknown }).get()
      : value]))
}
