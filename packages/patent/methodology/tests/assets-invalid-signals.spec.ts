// A separation signal that is not text cannot be rendered as tool output, so a
// malformed asset must fail the plugin load instead of the first diagonal
// lookup. Mock the file read at the durable-asset boundary and boot the real
// plugin.
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as methodology from '../src/index.ts'
import { validateTrizAssets } from '../src/data.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0]) {
      if (String(path).endsWith('triz-separations.json')) {
        return JSON.stringify([{ id: 'space', name: 'Separation in space', description: 'x', signals: [1] }])
      }
      return actual.readFileSync(path, 'utf8')
    },
  }
})

describe('TRIZ separation signals that are not text', () => {
  it('validateTrizAssets names the offending signal', () => {
    expect(() => { validateTrizAssets() }).toThrow(/separation "space" signal 1 is empty or not a string/)
  })

  it('refuses to load the plugin', async () => {
    const host = new Context()
    await host.plugin(SystemPrompt)
    await host.plugin(ToolRuntime)
    await expect(host.plugin(methodology, {})).rejects.toThrow(/separation "space" signal 1 is empty or not a string/)
    expect(host.tools.schemas().some(schema => schema.name === 'triz')).toBe(false)
  })
})
