import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'
import { ConnectorRegistry } from '../src/runtime/connector-registry.ts'
import { createArxivConnector } from '../src/runtime/connectors/arxiv.ts'
import { createOpenAlexConnector } from '../src/runtime/connectors/openalex.ts'
import { createSemanticScholarConnector } from '../src/runtime/connectors/semantic-scholar.ts'
import { createCrossrefConnector } from '../src/runtime/connectors/crossref.ts'
import { createPaperSearchTool } from '../src/tool/paper-search.ts'
import { createPaperListSourcesTool } from '../src/tool/paper-list-sources.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const testToolSignal = new AbortController().signal

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T00:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
</feed>`

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>none</title></feed>`

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

function execute(ctx: Context, name: string, args: unknown, callLabel: string) {
  return executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId(callLabel), name, arguments: args })
}

async function setupPlugin(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, {})
  return ctx
}

/** Test injection: skip arXiv/S2 per-host rate limits and retry backoff to keep the suite fast. */
function makeRegistry(fetchImpl: typeof fetch): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  registry.register(createArxivConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 }, retry: { maxRetries: 0 } }))
  registry.register(createOpenAlexConnector({ fetchImpl }))
  registry.register(createSemanticScholarConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 }, retry: { maxRetries: 0 } }))
  registry.register(createCrossrefConnector({ fetchImpl }))
  return registry
}

async function setupRegistry(registry: ConnectorRegistry): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createPaperSearchTool(registry))
  ctx.tools.register(createPaperListSourcesTool(registry))
  return ctx
}

async function withFetch(fetchImpl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

describe('dsh-tool-literature (plugin-registered tools)', () => {
  it('registers paper_search and paper_list_sources', async () => {
    const ctx = await setupPlugin()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('paper_search')
    expect(names).toContain('paper_list_sources')
  })

  it('paper_list_sources lists every source with no network', async () => {
    const ctx = await setupPlugin()
    const result = await execute(ctx, 'paper_list_sources', {}, 'list-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected paper_list_sources success')
    const value = result.value as { sources: { id: string }[]; domains: string[] }
    expect(value.sources.map(s => s.id)).toEqual(['arxiv', 'openalex', 'semantic-scholar', 'crossref'])
    expect(value.domains).toEqual(['literature'])
    const t = text(result)
    for (const id of ['arxiv', 'openalex', 'semantic-scholar', 'crossref']) {
      expect(t).toContain(`**${id}**`)
    }
  })

  it('paper_search searches arxiv with a patched globalThis.fetch', async () => {
    const ctx = await setupPlugin()
    await withFetch(async () => new Response(ATOM_FEED, { status: 200 }), async () => {
      const result = await execute(ctx, 'paper_search', { db: 'arxiv', query: 'attention is all you need' }, 'search-1')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected paper_search success')
      const value = result.value as { db: string; query: string; hits: unknown[] }
      expect(value.db).toBe('arxiv')
      expect(value.query).toBe('attention is all you need')
      expect(value.hits.length).toBe(1)
      const t = text(result)
      expect(t).toContain('Attention Is All You Need')
      expect(t).toContain('1706.03762v7')
    })
  })

  it('unregisters the tools when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, {})
    expect(ctx.tools.schemas().some(s => s.name === 'paper_search')).toBe(true)
    expect(ctx.tools.schemas().some(s => s.name === 'paper_list_sources')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'paper_search')).toBe(false)
    expect(ctx.tools.schemas().some(s => s.name === 'paper_list_sources')).toBe(false)
  })
})

describe('paper_search over an injected-fetchImpl registry', () => {
  it('returns an unknown-db error with available sources', async () => {
    const registry = makeRegistry(async () => new Response('', { status: 200 }))
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'nope', query: 'anything' }, 'unknown-db')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Available: arxiv, openalex, semantic-scholar, crossref')
  })

  it('rejects a blank query before reaching the source', async () => {
    let calls = 0
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => {
        calls += 1
        return []
      },
    })
    const ctx = await setupRegistry(registry)
    for (const query of ['', '   ', '\n\t']) {
      const result = await execute(ctx, 'paper_search', { db: 'stub', query }, `blank-${JSON.stringify(query)}`)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('query must be non-empty')
    }
    expect(calls).toBe(0)
  })

  it('trims the query it searches and echoes', async () => {
    let searched = ''
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async (query) => {
        searched = query
        return []
      },
    })
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'stub', query: '  attention  ' }, 'trimmed')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected paper_search success')
    expect(searched).toBe('attention')
    expect((result.value as { query: string }).query).toBe('attention')
  })

  it('surfaces rate-limit source errors with actionable guidance', async () => {
    const registry = makeRegistry(async () => new Response('rate limited', { status: 429 }))
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'arxiv', query: 'attention' }, 'rate-limit')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rate limiting')
    expect(text(result)).toContain('arXiv allows ~1 request every 3s')
  })

  it('returns empty result for genuine zero hits (not an error)', async () => {
    const registry = makeRegistry(async () => new Response(EMPTY_FEED, { status: 200 }))
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'arxiv', query: 'zzzz nonexistent' }, 'empty')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { hits: unknown[] }).hits).toEqual([])
    expect(text(result)).toContain('No results')
  })

  it('renders hits with pdf links', async () => {
    const registry = makeRegistry(async () => new Response(ATOM_FEED, { status: 200 }))
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'arxiv', query: 'attention is all you need' }, 'pdf')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { hits: unknown[] }).hits.length).toBe(1)
    const t = text(result)
    expect(t).toContain('## Attention Is All You Need')
    expect(t).toContain('**id**: 1706.03762v7')
    expect(t).toContain('**pdf**: http://arxiv.org/pdf/1706.03762v7')
    expect(t).toContain('**url**: http://arxiv.org/abs/1706.03762v7')
  })

  it('renders the pdf link that connectors publish as extra.pdf_url', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => [
        { id: 'h1', title: 'Open Access Paper', extra: { pdf_url: 'https://pdf.example/h1.pdf' } },
      ],
    })
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'stub', query: 'q' }, 'stub-pdf')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected paper_search success')
    expect(text(result)).toContain('**pdf**: https://pdf.example/h1.pdf')
  })

  it('clamps limit to 50', async () => {
    let url = ''
    const registry = makeRegistry(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return new Response(ATOM_FEED, { status: 200 })
    })
    const ctx = await setupRegistry(registry)
    await execute(ctx, 'paper_search', { db: 'arxiv', query: 'attention', limit: 999 }, 'clamp')
    expect(url.includes('max_results=50')).toBe(true)
  })

  it('renders hits with and without optional score/url/summary fields', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => [
        { id: 'h1', title: 'Scored Hit', score: 0.9, summary: 'summary text' },
        { id: 'h2', title: 'Bare Hit' },
      ],
    })
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'stub', query: 'q' }, 'stub')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected paper_search success')
    const t = text(result)
    expect(t).toContain('## Scored Hit')
    expect(t).toContain('· score: 0.9')
    expect(t).toContain('## Bare Hit')
    expect(t).not.toContain('**url**')
    expect(t).not.toContain('**pdf**')
  })

  it('surfaces non-rate-limited source errors with the raw message', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => {
        throw 'boom-string'
      },
    })
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'stub', query: 'q' }, 'non-rate')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Stub returned an error: boom-string')
  })

  it('detects rate limiting by message on non-arxiv sources', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => {
        throw new Error('rate limit exceeded')
      },
    })
    const ctx = await setupRegistry(registry)
    const result = await execute(ctx, 'paper_search', { db: 'stub', query: 'q' }, 'rate-msg')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Stub is rate limiting requests')
    expect(text(result)).not.toContain('arXiv')
  })

  it('propagates the original error when the caller signal aborts mid-search', async () => {
    const controller = new AbortController()
    const registry = new ConnectorRegistry()
    registry.register({
      id: 'stub',
      name: 'Stub',
      domain: 'literature',
      description: 'stub source',
      search: async () => {
        controller.abort()
        throw new Error('request aborted')
      },
    })
    const ctx = await setupRegistry(registry)
    const result = await executeToolFixture(ctx, {
      signal: controller.signal,
      callId: ToolCallId('abort'),
      name: 'paper_search',
      arguments: { db: 'stub', query: 'q' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('request aborted')
    expect(text(result)).not.toContain('returned an error')
  })

  it('names the fallback when an unknown db is queried on an empty registry', async () => {
    const ctx = await setupRegistry(new ConnectorRegistry())
    const result = await execute(ctx, 'paper_search', { db: 'nope', query: 'x' }, 'empty-unknown')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Available: (none registered)')
  })

  it('paper_list_sources filters by domain and renders empty registries', async () => {
    const registry = makeRegistry(async () => new Response('', { status: 200 }))
    const ctx = await setupRegistry(registry)

    const filtered = await execute(ctx, 'paper_list_sources', { domain: 'literature' }, 'list-domain')
    expect(filtered.isError).toBe(false)
    if (filtered.isError) throw new Error('expected paper_list_sources success')
    expect((filtered.value as { sources: unknown[] }).sources.length).toBe(4)

    const none = await execute(ctx, 'paper_list_sources', { domain: 'chemistry' }, 'list-domain-none')
    expect(none.isError).toBe(false)
    if (none.isError) throw new Error('expected paper_list_sources success')
    expect(text(none)).toContain('No literature sources registered for domain "chemistry".')

    const emptyCtx = await setupRegistry(new ConnectorRegistry())
    const empty = await execute(emptyCtx, 'paper_list_sources', {}, 'list-empty')
    expect(empty.isError).toBe(false)
    if (empty.isError) throw new Error('expected paper_list_sources success')
    expect(text(empty)).toContain('No literature sources are registered.')
  })
})
