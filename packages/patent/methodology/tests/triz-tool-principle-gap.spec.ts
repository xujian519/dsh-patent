// The shipped matrix only contains principle numbers 1-40 and every one of
// those resolves, so the tool's undefined-principle guard is unreachable
// through real data. Mock the data seam to prove the guard drops an unknown
// principle id instead of rendering a broken entry.
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as methodology from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

vi.mock('../src/data.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data.ts')>()
  return {
    ...actual,
    lookupMatrixCell: vi.fn(() => [999]),
    principleById: vi.fn(() => undefined),
  }
})

const testToolSignal = new AbortController().signal

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function execute(host: Context, name: string, args: unknown, callLabel: string) {
  return executeToolFixture(host, { signal: testToolSignal, callId: ToolCallId(callLabel), name, arguments: args })
}

async function setupPlugin(config: Record<string, unknown> = {}): Promise<Context> {
  const host = new Context()
  await host.plugin(SessionProjectionRegistry)
  await host.plugin(SystemPrompt)
  await host.plugin(ToolRuntime)
  await host.plugin(methodology, config)
  return host
}

describe('triz tool with an unresolvable principle id from the data seam', () => {
  it('drops the unknown id from the recommended list', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 14, worsening: 1 }, 'unknown-principle')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected triz success')
    const value = result.value as {
      mode: string
      improving: { number: number; label: string }
      worsening: { number: number; label: string }
      recommended: unknown[]
    }
    expect(value.mode).toBe('lookup')
    expect(value.improving).toEqual({ number: 14, label: '强度' })
    expect(value.worsening).toEqual({ number: 1, label: '运动物体重量' })
    expect(value.recommended).toEqual([])
    expect(text(result)).toContain('Recommended principles: none.')
  })
})
