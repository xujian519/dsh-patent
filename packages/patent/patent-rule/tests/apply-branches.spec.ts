/** Rule-loading branches of the plugin entry: no manifest, extra domains, and a manifest override. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentRule from '../src/index.ts'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-rule-apply-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MECHANICAL_DOMAIN = join(import.meta.dirname, '..', 'assets', 'rules', 'domains', 'mechanical')

async function mount(config: PatentRule.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PatentRule, config)
  return ctx
}

describe('patent-rule apply rule loading', () => {
  it('loads the default pack plus extra domains and skips a missing domain', async () => {
    const broken = tempDir()
    writeFileSync(join(broken, 'broken.yaml'), 'rules: not-an-array\n')
    const ctx = await mount({
      additionalRuleDomains: [MECHANICAL_DOMAIN, broken, join(tempDir(), 'missing')],
    })
    expect(ctx.get('patentRuleGate')).toBeDefined()
  })

  it('loads a manifest without a rules directory', async () => {
    const ctx = await mount({ manifestPath: join(tempDir(), 'missing.yaml') })
    expect(ctx.get('patentRuleGate')).toBeDefined()
  })

  it('warns when an additional domain rule shadows a base rule id', async () => {
    const domain = tempDir()
    writeFileSync(
      join(domain, 'shadow.yaml'),
      [
        'rules:',
        '  shadowed:',
        '    id: PAT-ABS-001',
        '    name: 域内同 id 覆盖',
        '    severity: minor',
        '    action: warn',
        '    check: { type: keyword_blocklist, keywords: ["DUPWORD"] }',
      ].join('\n'),
    )
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(PatentRule, { additionalRuleDomains: [domain] })
    const logged = warnSpy.mock.calls.map(([message]) => String(message))
    warnSpy.mockRestore()
    expect(logged.some(message => message.includes('PAT-ABS-001') && message.includes('重复'))).toBe(true)
  })

  it('loads a manifest with a rules directory', async () => {
    const ctx = await mount({
      manifestPath: join(tempDir(), 'missing.yaml'),
      rulesDir: join(import.meta.dirname, '..', 'assets', 'rules'),
    })
    expect(ctx.get('patentRuleGate')).toBeDefined()
  })
})
