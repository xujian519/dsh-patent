// Proves the plugin is real, Loader-composed config: `crossref: false` in a booted
// cordis.yml narrows the source catalog, and paper_search runs over a stubbed
// globalThis.fetch (the only external service mocked).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolLiterature from '@deepseek-ai/dsh-tool-literature'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-literature-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-literature'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-literature', ToolLiterature],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Run one arXiv search through the booted plugin. */
function searchArxiv(ctx: Context, query: string) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('search'),
    name: 'paper_search',
    arguments: { db: 'arxiv', query },
  })
}

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

describe('tool-literature real Loader composition through cordis.yml', () => {
  it('boots with a config block and executes paper_list_sources', async () => {
    const ctx = await boot(['    crossref: false'])
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('paper_list_sources')
    expect(names).toContain('paper_search')

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('list-sources'),
      name: 'paper_list_sources',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected paper_list_sources success')
    const ids = (result.value as { sources: { id: string }[] }).sources.map(s => s.id)
    expect(ids).toEqual(['arxiv', 'openalex', 'semantic-scholar'])
    expect(ids).not.toContain('crossref')
  }, 30_000)

  it('paper_search returns hits with globalThis.fetch stubbed', async () => {
    const ctx = await boot([])
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(ATOM_FEED, { status: 200 }))
    try {
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('search'),
        name: 'paper_search',
        arguments: { db: 'arxiv', query: 'attention is all you need' },
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected paper_search success')
      expect((result.value as { hits: unknown[] }).hits.length).toBe(1)
      expect(resultText(result)).toContain('Attention Is All You Need')
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it('serves a repeated search from the GET cache under the default TTL', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response(ATOM_FEED, { status: 200 })
    }
    try {
      const ctx = await boot([])
      expect((await searchArxiv(ctx, 'attention')).isError).toBe(false)
      expect((await searchArxiv(ctx, 'attention')).isError).toBe(false)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it('fetches every time when cacheTtlMs is 0', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response(ATOM_FEED, { status: 200 })
    }
    try {
      const ctx = await boot(['    cacheTtlMs: 0'])
      expect((await searchArxiv(ctx, 'attention')).isError).toBe(false)
      expect((await searchArxiv(ctx, 'attention')).isError).toBe(false)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it('stops after the first attempt when the retry budget is zero', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response('upstream failure', { status: 500 })
    }
    try {
      const ctx = await boot(['    retry:', '      maxRetries: 0'])
      const result = await searchArxiv(ctx, 'attention')
      expect(result.isError).toBe(true)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it('times out a hanging request at the configured timeoutMs', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) {
        reject(new Error('expected the request to carry an abort signal'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      })
    })
    try {
      const ctx = await boot(['    timeoutMs: 7'])
      const result = await searchArxiv(ctx, 'attention')
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('timed out after 7ms')
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)
})
