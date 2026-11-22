/** Plugin registration and the lazily parsed shipped index behind the tool. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, assertLegalLawIndexReadable, LegalLawBaselineError, type Config } from '../src/index.ts'
import { createLegalLawIndex } from '../src/baseline.ts'
import { createLegalLawVerifyTool, type LegalLawVerifyOutput } from '../src/tool/law-verify.ts'
import type { LegalCitationPolicySet, LegalLawBaseline, LegalLawName } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-law-plugin-'))
  tempDirs.push(dir)
  return dir
}

/** Manifest text for the given `[law, document, file]` rows. */
function manifestText(rows: Array<[string, string, string]>): string {
  return JSON.stringify({ laws: rows })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const POLICIES: LegalCitationPolicySet = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'warn',
  unverified: 'warn',
}

/** Plugin configuration with an optional index override. */
function config(baselineDir?: string): Config {
  const value: Config = {
    onMismatch: 'block',
    onUnmatched: 'warn',
    onOutOfRange: 'block',
    onNotIndexed: 'warn',
    onUnverified: 'warn',
    propositionSupport: 0.5,
  }
  if (baselineDir !== undefined) value.baselineDir = baselineDir
  return value
}

const INDEX_YAML = [
  'law: 民法典',
  'document: 中华人民共和国民法典',
  'maxArticle: 1260',
  'articles:',
  '  - article: 143',
  '    topics: [民事法律行为]',
  '    text: 具备下列条件的民事法律行为有效。',
  '    sourceDoc: 官方全文',
  '    verifiedOn: 2026-10-23',
].join('\n')

const MINIMAL_INDEX: Map<LegalLawName, LegalLawBaseline> = new Map([['民法典', {
  law: '民法典',
  document: '中华人民共和国民法典',
  revision: null,
  maxArticle: 1260,
  maxVerifiedOn: '2026-10-23',
  maxSource: 'fixture',
  articles: [{
    article: 143,
    topics: ['民事法律行为'],
    text: '具备下列条件的民事法律行为有效。',
    sourceDoc: '官方全文',
    verifiedOn: '2026-10-23',
  }],
}]])

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('legal-law-plugin'),
    name: 'legal_law_verify',
    arguments: args,
  })
}

describe('legal-law plugin', () => {
  it('registers the tool over an explicit index directory', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'civil-code.yaml'), INDEX_YAML)
    writeFileSync(join(dir, 'manifest.json'), manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]))
    const ctx = await host()
    apply(ctx, config(dir))
    const result = await execute(ctx, { references: ['民法典第143条'] })
    expect(result.isError).toBe(false)
    const value = result.value as LegalLawVerifyOutput
    expect(value.findings[0]?.decision).toBe('valid')
  })

  it('loads the packaged index on the first verification', async () => {
    const ctx = await host()
    apply(ctx, config())
    const result = await execute(ctx, { references: ['民法典第143条'] })
    expect(result.isError).toBe(false)
  })

  it('rejects an empty index directory at registration', async () => {
    const ctx = await host()
    expect(() => { apply(ctx, config(tempDir())) }).toThrow(LegalLawBaselineError)
  })

  it('rejects an index directory without a manifest at registration', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'civil-code.yaml'), INDEX_YAML)
    const ctx = await host()
    expect(() => { apply(ctx, config(dir)) }).toThrow('法条索引清单不可读')
  })

  it('rejects an unreadable index directory at registration', async () => {
    const ctx = await host()
    expect(() => { apply(ctx, config(join(tempDir(), 'missing'))) })
      .toThrow('法条索引目录不可读')
  })

  it('validates the packaged index without parsing it', () => {
    expect(() => { assertLegalLawIndexReadable() }).not.toThrow()
  })
})

describe('manifest-backed index', () => {
  it('parses each cited law once across tool calls', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'civil-code.yaml'), INDEX_YAML)
    writeFileSync(join(dir, 'manifest.json'), manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]))
    const ctx = await host()
    ctx.tools.register(createLegalLawVerifyTool({
      baselines: createLegalLawIndex(dir),
      policies: POLICIES,
      supportThreshold: 0.5,
    }))
    const first = await execute(ctx, { references: ['民法典第143条第2款第1项'], proposition: '条件' })
    expect(first.isError).toBe(false)
    const value = first.value as LegalLawVerifyOutput
    expect(value.findings[0]).toMatchObject({ article: 143, paragraph: 2, item: 1 })
    // A parsed law stays cached: dropping the file does not affect the next call.
    rmSync(join(dir, 'civil-code.yaml'))
    const second = await execute(ctx, { references: ['民法典第143条'] })
    expect(second.isError).toBe(false)
  })

  it('retries a failed law load on the next call', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'civil-code.yaml'), 'law: 民法典')
    writeFileSync(join(dir, 'manifest.json'), manifestText([['民法典', '中华人民共和国民法典', 'civil-code.yaml']]))
    const ctx = await host()
    ctx.tools.register(createLegalLawVerifyTool({
      baselines: createLegalLawIndex(dir),
      policies: POLICIES,
    }))
    const failed = await execute(ctx, { references: ['民法典第143条'] })
    expect(failed.isError).toBe(true)
    writeFileSync(join(dir, 'civil-code.yaml'), INDEX_YAML)
    const retried = await execute(ctx, { references: ['民法典第143条'] })
    expect(retried.isError).toBe(false)
  })

  it('reads a map-backed index on every call', async () => {
    const ctx = await host()
    ctx.tools.register(createLegalLawVerifyTool({ baselines: MINIMAL_INDEX, policies: POLICIES }))
    const result = await execute(ctx, { text: '民法典第143条' })
    expect(result.isError).toBe(false)
  })
})
