import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { globalAtomRegistry, globalStageHandlerRegistry } from '@deepseek-ai/dsh-patent-core'
import * as tool from '../src/index.ts'

/** Atoms this package owns; patent-core's built-ins are shared infrastructure. */
const PACKAGE_ATOMS = [
  'slop-gate',
  'draft-specification',
  'spec-check',
  'response-check',
  'eligibility',
  'legal-gaps',
]

describe('patent-tools atom effects', () => {
  it('dispose 后撤销本包注册的 atom 与 handler，保留 patent-core 内置', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const key: string = 'sandboxPolicy'
    ctx.provide(key, { workspaceRoot: process.cwd() })
    const fiber = await ctx.plugin(tool, {})
    try {
      for (const name of PACKAGE_ATOMS) {
        expect(globalAtomRegistry.lookup(name)).toBeDefined()
        expect(globalStageHandlerRegistry.lookup(name)).toBeDefined()
      }
    } finally {
      await fiber.dispose()
    }

    for (const name of PACKAGE_ATOMS) {
      expect(globalAtomRegistry.lookup(name)).toBeUndefined()
      expect(globalStageHandlerRegistry.lookup(name)).toBeUndefined()
    }
    expect(globalAtomRegistry.lookup('extract')).toBeDefined()
    expect(globalStageHandlerRegistry.lookup('extract')).toBeDefined()
  })
})
