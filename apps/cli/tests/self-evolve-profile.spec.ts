/**
 * The shipped `self-evolve` profile: the opt-in bundle layer composes exactly
 * once on top of dsh-base + dsh-headless, and the tools it contributes reach
 * the agent tool catalog.
 *
 * The spec loads the REAL template through the launcher's own profile loader,
 * composes the REAL bundle patch layers through the boot's patch algorithm,
 * then mounts the composed `tool-self-evolve` row against a real ToolRuntime
 * and SystemPrompt so the "self_evolve_now is visible to the model" claim is
 * checked against the registry the model reads rather than a fixture.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  composeEntries, initProfile, loadProfile, PROFILE_TEMPLATES, PROFILES_DIR,
} from '@deepseek-ai/dsh-app-boot'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as toolSelfEvolve from '@deepseek-ai/dsh-tool-self-evolve'

const TOOL_ROW_ID = 'tool-self-evolve'
const PROVIDER_ROW_ID = 'self-evolve-basic'
const TOOL_PACKAGE = '@deepseek-ai/dsh-tool-self-evolve'
const PROVIDER_PACKAGE = '@deepseek-ai/dsh-self-evolve-basic'

describe('the shipped self-evolve profile', () => {
  let home: string
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })
  // The app installation anchor, mirroring profile-boot.ts: the bundle layers
  // resolve from the REAL bundle packages through it.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))

  function composeProfile(): {
    rows: ReturnType<typeof composeEntries>
    warnings: string[]
    skipped: string[]
  } {
    home = mkdtempSync(join(tmpdir(), 'dsh-self-evolve-home-'))
    const template = PROFILE_TEMPLATES['self-evolve']
    if (template === undefined) throw new TypeError('the self-evolve template must ship')
    initProfile(join(home, PROFILES_DIR, 'self-evolve'), template.bundles)
    const profile = loadProfile('dsh', 'self-evolve', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(profile.layers.map(layer => layer.patches), message => warnings.push(message))
    return { rows, warnings, skipped: profile.skippedBundles.map(bundle => bundle.packageName) }
  }

  it('loads from the template and composes both self-evolve rows exactly once', () => {
    const { rows, warnings, skipped } = composeProfile()
    // A skipped bundle silently drops its rows; the profile must resolve all three.
    expect(skipped).toEqual([])
    expect(warnings).toEqual([])
    const providers = rows.filter(row => row.id === PROVIDER_ROW_ID)
    const tools = rows.filter(row => row.id === TOOL_ROW_ID)
    expect(providers).toHaveLength(1)
    expect(tools).toHaveLength(1)
    expect(providers[0]?.name).toBe(PROVIDER_PACKAGE)
    expect(tools[0]?.name).toBe(TOOL_PACKAGE)
    // No second copy of either package arrives under another row id.
    for (const row of rows) {
      if (row.id === PROVIDER_ROW_ID || row.id === TOOL_ROW_ID) continue
      expect(row.name, `row ${row.id}`).not.toBe(TOOL_PACKAGE)
      expect(row.name, `row ${row.id}`).not.toBe(PROVIDER_PACKAGE)
    }
  })

  it('carries the base and headless layers the profile is built on', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-self-evolve-home-'))
    const profile = loadProfile('dsh', 'self-evolve', anchor, home)
    // Auto-initialized from the template: the manifest lists the shipped tuple,
    // headless keeps the profile non-interactive, and the self-evolve layer is
    // applied last so its rows win any later overlay.
    expect(PROFILE_TEMPLATES['self-evolve']?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-self-evolve-app',
    ])
    expect(profile.layers.map(layer => layer.packageName)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-self-evolve-app',
    ])
  })

  it('makes the self-evolve tools visible in the agent tool catalog', async () => {
    const { rows } = composeProfile()
    const row = rows.find(entry => entry.id === TOOL_ROW_ID)
    if (row?.name !== TOOL_PACKAGE) throw new TypeError(`profile must mount ${TOOL_PACKAGE}`)
    const ctx = new Context()
    // The two capabilities the tool row injects but does not own: the seam it
    // queues through and the agent directory it resolves the caller from.
    ctx.provide('selfEvolve', { readPatterns: async () => [], requestEvolve: () => ({ requestId: 'r', status: 'queued', queuePosition: 1 }) } as never)
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(toolSelfEvolve)
    // The registry the model reads: both tools resolve in the global view, and
    // the prompt section that advertises them is assembled too.
    expect(ctx.tools.get('self_evolve_now')).toBeDefined()
    expect(ctx.tools.get('self_evolve_inspect_patterns')).toBeDefined()
    expect(ctx.tools.get('self_evolve_now')?.description).toContain('idle boundary')
    const assembly = await ctx.systemPrompt.assemble()
    // The tool row owns exactly one section, and the visible schema roster
    // carries both tools — the same two surfaces the model reads.
    expect(assembly.sections.filter(section => section.name === 'tool:self-evolve')).toHaveLength(1)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['self_evolve_inspect_patterns', 'self_evolve_now'])
    await ctx.fiber.dispose()
  })
})
