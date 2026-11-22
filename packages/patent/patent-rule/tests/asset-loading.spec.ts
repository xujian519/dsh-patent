import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentRule from '@deepseek-ai/dsh-patent-rule'
import { loadPatentComplianceRuleSet, resolveRuleAsset } from '@deepseek-ai/dsh-patent-rule'

async function mount(config: Partial<PatentRule.Config>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PatentRule, config)
  return ctx
}

describe('asset loading', () => {
  it('loadPatentComplianceRuleSet finds the packaged assets', () => {
    const loaded = loadPatentComplianceRuleSet()
    expect(loaded.source).not.toBeNull()
    expect(loaded.ruleSet.rules.length).toBe(4)
  })

  it('loadPatentComplianceRuleSet fails loud when the base asset is missing', () => {
    expect(() => loadPatentComplianceRuleSet('/nonexistent/rules-root'))
      .toThrow(PatentRule.PatentRuleAssetError)
    expect(() => loadPatentComplianceRuleSet('/nonexistent/rules-root'))
      .toThrow(/未找到可解析的专利合规规则资产/)
  })

  it('resolveRuleAsset locates a packaged asset and returns null on a miss', () => {
    const hit = resolveRuleAsset('compliance.yaml')
    expect(hit).not.toBeNull()
    expect(hit).toMatch(/compliance\.yaml$/)
    expect(resolveRuleAsset('no-such-asset-file.yaml')).toBeNull()
  })
})

describe('Config validation', () => {
  it('mounts with defaults when config is empty', async () => {
    await expect(mount({})).resolves.toBeTruthy()
  })

  it('mounts with an explicit rulesDir and approvalDisabled', async () => {
    await expect(mount({ approvalDisabled: true })).resolves.toBeTruthy()
  })

  it('rejects a non-array gateToolNames at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(PatentRule, { gateToolNames: 42 as never })).rejects.toThrow()
  })

  it('keeps name/inject/Config/apply and has no default export', () => {
    expect('default' in PatentRule).toBe(false)
    expect(PatentRule.name).toBe('patent-rule')
    expect(PatentRule.inject).toEqual(['tools'])
    expect(PatentRule.Config).toBeDefined()
    expect(typeof PatentRule.apply).toBe('function')
  })
})
