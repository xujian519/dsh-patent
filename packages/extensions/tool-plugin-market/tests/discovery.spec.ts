/**
 * Tests for the model-facing plugin-market tools: the apply() registration of
 * the system-prompt section and the three read-only tools, plus the tool
 * bodies' source resolution (bundled default, explicit id, first fallback,
 * empty) and their require-agent guard. The bundled catalog is queried in
 * memory; the npm preview goes through a stubbed registry fetch.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PluginMarketSource } from '@deepseek-ai/dsh-host-plugin-market'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ToolPluginMarket from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34' }],
}))

const testToolSignal = new AbortController().signal

let dir: string
let callCounter = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tool-plugin-market-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A source with no description and no builtin flag (a minimal registered catalog). */
function bareSource(providerId: string): PluginMarketSource {
  return {
    id: providerId as PluginMarketSource['id'],
    providerId,
    name: providerId,
    attribution: { name: providerId, url: `https://${providerId}` },
    endpoint: `https://catalog.${providerId}`,
    query: { supported: ['q'] },
  }
}

/** A fetch stub resolving the npm registry into a verified, non-deprecated release. */
function stubRegistry(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('https://registry.npmjs.org/')) {
      return new Response(JSON.stringify({
        name: '@deepseek-ai/dsh-tool-bash',
        version: '0.1.2-alpha.1',
        engines: { node: '>=22' },
        dist: { tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh-tool-bash/-/dsh-tool-bash-0.1.2-alpha.1.tgz', integrity: 'sha512-abc' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
}

/** Boot a Context with system prompt, tool runtime, a read-only plugin market, and the tools. */
async function setup(): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const { apply } = await import('../../../host/plugin-market/src/provider.ts')
  await ctx.plugin(apply, { sourceFile: join(dir, 'sources.json') })
  const fiber = await ctx.plugin(ToolPluginMarket)
  stubRegistry()
  return { ctx, fiber }
}

/** A minimal Agent-backed identity the tools require; the tool bodies only assert it exists. */
function fakeAgent(ctx: Context): Agent {
  const scopeFiber = ctx.plugin(() => {})
  return {
    id: 'sess-tool-market',
    ctx: scopeFiber.ctx,
    inject: () => undefined,
    session: { id: 'sess-tool-market', header: { version: 0, id: 'sess-tool-market', createdAt: 0 } },
  } as unknown as Agent
}

function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-plugin-market registration', () => {
  it('registers the three read-only tools and a prompt section', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual(['market_plugin_preview', 'market_plugin_search', 'market_source_list'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).toContain('tool:plugin-market')
    const section = assembly.sections.find(candidate => candidate.name === 'tool:plugin-market')
    expect(section?.text).toContain('Plugin Catalog Discovery')
  })

  it('removes tools and the prompt section when the plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).not.toContain('tool:plugin-market')
  })
})

describe('tool-plugin-market tool bodies', () => {
  it('market_source_list reports the bundled catalog as a builtin source', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_source_list', {}, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    const value = result.value as Array<Record<string, unknown>>
    expect(value[0]).toMatchObject({ providerId: 'builtin-deepseek', builtin: true })
  })

  it('market_source_list maps a source without description and builtin flag', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.pluginCatalog, 'listSources').mockResolvedValue([bareSource('bare.dev')])
    const result = await call(ctx, 'market_source_list', {}, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    const value = result.value as Array<Record<string, unknown>>
    const entry = value[0]!
    expect(entry).toMatchObject({ providerId: 'bare.dev', builtin: false, query: { supported: ['q'] } })
    expect('description' in entry).toBe(false)
  })

  it('market_plugin_search queries the bundled catalog by default', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_search', { q: 'bash' }, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    const value = result.value as { sourceId: string; items: Array<{ package: string }> }
    expect(value.sourceId).toBe('builtin-deepseek')
    expect(value.items[0]).toMatchObject({ package: '@deepseek-ai/dsh-tool-bash' })
  })

  it('market_plugin_search honors an explicit bundled source id', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_search', { sourceId: 'builtin-deepseek', q: 'planning' }, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    expect((result.value as { sourceId: string }).sourceId).toBe('builtin-deepseek')
  })

  it('market_plugin_search accepts every filter and the limit', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_search', { category: 'tool', capability: 'planning', limit: 1 }, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    expect(Array.isArray((result.value as { items: unknown[] }).items)).toBe(true)
  })

  it('market_plugin_search returns an unlocked page when no filter is supplied', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_search', {}, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    expect((result.value as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  it('market_plugin_search rejects an unknown source id loud', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_search', { sourceId: 'nope' }, fakeAgent(ctx))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no catalog source "nope"')
  })

  it('market_plugin_search picks the first source when nothing is bundled', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.pluginCatalog, 'listSources').mockResolvedValue([bareSource('custom.dev')])
    vi.spyOn(ctx.pluginCatalog, 'search').mockResolvedValue({ items: [] })
    const result = await call(ctx, 'market_plugin_search', {}, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    expect((result.value as { sourceId: string }).sourceId).toBe('custom.dev')
  })

  it('market_plugin_search fails loud when no source is available', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.pluginCatalog, 'listSources').mockResolvedValue([])
    const result = await call(ctx, 'market_plugin_search', {}, fakeAgent(ctx))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no catalog source registered')
  })

  it('market_plugin_preview resolves a package reference against the registry', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_plugin_preview', { ref: '@deepseek-ai/dsh-tool-bash@0.1.2-alpha.1' }, fakeAgent(ctx))
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ package: '@deepseek-ai/dsh-tool-bash', verified: true })
  })

  it('requires an agent-backed session for every tool', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'market_source_list', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('plugin-market tools require an Agent-backed session')
  })
})
