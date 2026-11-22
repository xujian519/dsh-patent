import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '../src/index.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a temporary rules directory holding one file. */
function rulesDir(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-legal-evidence-plugin-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'legal-evidence-rules.yaml'), content)
  return dir
}

/** Install the plugin over a fresh tool runtime. */
async function install(config: Pkg.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(Pkg, config)
  return { ctx, fiber }
}

describe('@deepseek-ai/dsh-legal-evidence plugin surface', () => {
  it('registers evaluate_legal_evidence and withdraws it on dispose', async () => {
    const { ctx, fiber } = await install()
    expect(ctx.tools.schemas().some(schema => schema.name === 'evaluate_legal_evidence')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'evaluate_legal_evidence')).toBe(false)
  })

  it('fails loud when the configured rules directory has no rules file', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { rulesDir: '/nonexistent/legal-evidence-rules' }))
      .rejects.toThrow(Pkg.LegalEvidenceRuleAssetError)
  })

  it('fails loud when the rules file cannot be parsed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { rulesDir: rulesDir('invalid: yaml: content:') }))
      .rejects.toThrow(Pkg.LegalEvidenceRuleAssetError)
  })
})
