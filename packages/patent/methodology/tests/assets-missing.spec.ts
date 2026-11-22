// A missing matrix asset must fail when the plugin loads, not when the model
// first calls triz. Mock the file read at the durable-asset boundary and boot
// the real plugin.
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as methodology from '../src/index.ts'
import { validateTrizAssets } from '../src/data.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0]) {
      if (String(path).endsWith('triz-matrix.json')) throw new Error('ENOENT: triz-matrix.json')
      return actual.readFileSync(path, 'utf8')
    },
  }
})

describe('missing TRIZ asset at plugin start', () => {
  it('validateTrizAssets surfaces the missing file', () => {
    expect(() => { validateTrizAssets() }).toThrow(/ENOENT: triz-matrix.json/)
  })

  it('refuses to load the plugin', async () => {
    const host = new Context()
    await host.plugin(SessionProjectionRegistry)
    await host.plugin(SystemPrompt)
    await host.plugin(ToolRuntime)
    await expect(host.plugin(methodology, {})).rejects.toThrow(/ENOENT: triz-matrix.json/)
    expect(host.tools.schemas().some(schema => schema.name === 'triz')).toBe(false)
  })
})
