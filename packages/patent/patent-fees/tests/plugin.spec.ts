import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

async function install(overrides: Partial<Pkg.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(Pkg, {
    failOnUnverified: overrides.failOnUnverified ?? Pkg.DEFAULT_FEE_POLICY.failOnUnverified,
    ...(overrides.feeTablePath === undefined ? {} : { feeTablePath: overrides.feeTablePath }),
  })
  return { ctx, fiber }
}

describe('@deepseek-ai/dsh-patent-fees plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('patent-fees')
    expect(Pkg.inject).toEqual(['tools'])
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
    expect(Pkg.FEE_FILE_NAME).toBe('cn-fees.yaml')
  })

  it('exports the library API', () => {
    expect(typeof Pkg.loadFeeTable).toBe('function')
    expect(typeof Pkg.parseFeeTable).toBe('function')
    expect(typeof Pkg.computeFees).toBe('function')
    expect(typeof Pkg.createPatentFeesTool).toBe('function')
    expect(typeof Pkg.parseYuan).toBe('function')
    expect(typeof Pkg.formatFen).toBe('function')
    expect(typeof Pkg.applyPercent).toBe('function')
    expect(typeof Pkg.sumFen).toBe('function')
    expect(typeof Pkg.feeTablePath).toBe('function')
    expect(Pkg.FEE_TRIGGERS).toHaveLength(11)
    expect(Pkg.FEE_BASES).toHaveLength(6)
    expect(Pkg.PATENT_TYPES).toEqual(['invention', 'utility-model', 'design'])
    expect(Pkg.REDUCTION_KINDS).toEqual(['individual', 'enterprise'])
    expect(Pkg.DEFAULT_FEE_POLICY).toEqual({ failOnUnverified: true })
  })

  it('registers patent_fees and unregisters it on dispose (HMR-safety)', async () => {
    const { ctx, fiber } = await install()
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_fees')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_fees')).toBe(false)
  })

  it('defaults the total policy to the shipped one', () => {
    expect(Pkg.Config({} as Pkg.Config)).toEqual({ failOnUnverified: true })
  })

  it('withholds the total under the shipped policy and sums the verified part when turned off', async () => {
    const strict = await install()
    const withheld = await executeToolFixture(strict.ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-fees-strict'),
      name: 'patent_fees',
      arguments: { patentType: 'invention', triggers: ['filing'], specificationPages: 40 },
    })
    expect((withheld.value as { total: { amount?: string } }).total.amount).toBeUndefined()

    const relaxed = await install({ failOnUnverified: false })
    const reported = await executeToolFixture(relaxed.ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-fees-relaxed'),
      name: 'patent_fees',
      arguments: { patentType: 'invention', triggers: ['filing'], specificationPages: 40 },
    })
    // The application fee and the printing fee are priced; the specification
    // surcharge is not, so only the verified part may be summed.
    expect((reported.value as { total: { amount?: string } }).total.amount).toBe('950.00')
  })

  it('fails loud at load when the configured fee index is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { failOnUnverified: true, feeTablePath: '/nonexistent/fees.yaml' }))
      .rejects.toThrow(/费用索引不可读/)
  })
})
