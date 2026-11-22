import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { BrowserUseExtractor, type ScriptRun } from '@deepseek-ai/dsh-browser-backend'
import type { Connector } from '../src/protocol/types.ts'
import { ConnectorRegistry } from '../src/runtime/connector-registry.ts'
import { createPaperDownloadTool } from '../src/tool/paper-download.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

function pdfFetch(body = '%PDF-1.4 ' + 'x'.repeat(600)): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  })) as unknown as typeof fetch
}

function failingFetch(status: number): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    statusText: 'Forbidden',
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch
}

function registryWith(record: unknown): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  const connector: Connector = {
    id: 'fake',
    name: 'Fake',
    domain: 'literature',
    description: 'fake',
    search: async () => [],
    fetch: async () => record,
  }
  registry.register(connector)
  return registry
}

function extractorWith(run: ScriptRun): BrowserUseExtractor {
  return new BrowserUseExtractor({ run })
}

type ExecuteToolDeps = {
  registry: ConnectorRegistry
  fetchImpl?: typeof fetch
  extractor?: BrowserUseExtractor
  cwd?: string
  /** Override output-directory resolution (used to abort mid-call in cancellation tests). */
  resolveOutputDir?: (outputDir: string | undefined, cwd: string) => string
  /** Caller signal for this call (defaults to a never-aborted shared signal). */
  callSignal?: AbortSignal
}

async function executeTool(args: unknown, deps: ExecuteToolDeps) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createPaperDownloadTool(deps))
  return executeToolFixture(ctx, {
    signal: deps.callSignal ?? signal,
    callId: ToolCallId('pd-1'),
    name: 'paper_download',
    arguments: args,
  })
}

describe('paper_download', () => {
  it('downloads the direct link and reports ok with method direct', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' } }),
          fetchImpl: pdfFetch(),
          extractor: extractorWith(async () => { throw new Error('extractor must not run') }),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; method?: string; path?: string } }
      expect(value.result.status).toBe('ok')
      expect(value.result.method).toBe('direct')
      expect(value.result.path).toBe(join(dir, 'W123.pdf'))
      const saved = await readFile(join(dir, 'W123.pdf'), 'utf8')
      expect(saved.startsWith('%PDF-')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to browser extraction when the direct link fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      let calls = 0
      const fetchImpl = async (input: RequestInfo | URL) => {
        calls += 1
        if (calls === 1) {
          return failingFetch(403)(input)
        }
        return pdfFetch()(input)
      }
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' }, url: 'https://api.openalex.org/works/W123' }),
          fetchImpl,
          extractor: extractorWith(async () => ({ exitCode: 0, stdout: 'BU_EXTRACT:https://cdn.example/w123.pdf\n', stderr: '', timedOut: false })),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; method?: string; pdfUrl?: string } }
      expect(value.result.status).toBe('ok')
      expect(value.result.method).toBe('browser')
      expect(value.result.pdfUrl).toBe('https://cdn.example/w123.pdf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the direct link fails and the browser finds no PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' }, url: 'https://page.example/x' }),
          fetchImpl: failingFetch(403),
          extractor: extractorWith(async () => ({ exitCode: 0, stdout: 'BU_EXTRACT:\n', stderr: '', timedOut: false })),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('browser extraction failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when there is no record page for browser extraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' } }),
          fetchImpl: failingFetch(403),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('no record page')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the record carries no PDF link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { title: 'no pdf' } }) },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('no PDF link')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves a PDF link from a raw source record (arXiv pdf field, no extra)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      let fetched = ''
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        fetched = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return pdfFetch()(input)
      })
      // A real connector fetch returns the raw source record (arXiv puts the
      // PDF in `pdf`, OpenAlex in `pdf_url`, Semantic Scholar in
      // `openAccessPdf.url`) — not a ConnectorHit carrying `.extra`.
      const result = await executeTool(
        { db: 'fake', id: '1706.03762', outputDir: dir },
        { registry: registryWith({ id: 'http://arxiv.org/abs/1706.03762v7', pdf: 'http://arxiv.org/pdf/1706.03762v7' }), fetchImpl },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; method?: string } }
      expect(value.result.status).toBe('ok')
      expect(value.result.method).toBe('direct')
      expect(fetched).toBe('http://arxiv.org/pdf/1706.03762v7')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { field: 'extra.pdf_url', record: { extra: { pdf_url: 'https://pdf.example/a.pdf' } }, url: 'https://pdf.example/a.pdf' },
    { field: 'extra.pdf', record: { extra: { pdf: 'https://pdf.example/b.pdf' } }, url: 'https://pdf.example/b.pdf' },
    { field: 'pdf_url', record: { pdf_url: 'https://pdf.example/c.pdf' }, url: 'https://pdf.example/c.pdf' },
    { field: 'pdf', record: { pdf: 'https://pdf.example/d.pdf' }, url: 'https://pdf.example/d.pdf' },
    {
      field: 'best_oa_location.pdf_url',
      record: { best_oa_location: { pdf_url: 'https://pdf.example/e.pdf' } },
      url: 'https://pdf.example/e.pdf',
    },
    { field: 'open_access.oa_url', record: { open_access: { oa_url: 'https://pdf.example/f.pdf' } }, url: 'https://pdf.example/f.pdf' },
    {
      field: 'primary_location.pdf_url',
      record: { primary_location: { pdf_url: 'https://pdf.example/g.pdf' } },
      url: 'https://pdf.example/g.pdf',
    },
    { field: 'openAccessPdf.url', record: { openAccessPdf: { url: 'https://pdf.example/h.pdf' } }, url: 'https://pdf.example/h.pdf' },
  ])('downloads the direct link carried as $field', async ({ record, url }) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const fetchImpl = vi.fn(pdfFetch())
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith(record), fetchImpl },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; method?: string } }
      expect(value.result.status).toBe('ok')
      expect(value.result.method).toBe('direct')
      expect(fetchImpl).toHaveBeenCalledWith(url, expect.anything())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips an empty direct-link candidate and uses the next one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const fetchImpl = vi.fn(pdfFetch())
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ pdf_url: '', pdf: 'https://pdf.example/next.pdf' }), fetchImpl },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(fetchImpl).toHaveBeenCalledWith('https://pdf.example/next.pdf', expect.anything())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { field: 'url', record: { url: 'https://page.example/url' }, page: 'https://page.example/url' },
    { field: 'URL', record: { URL: 'https://page.example/upper' }, page: 'https://page.example/upper' },
    { field: 'landing_page_url', record: { landing_page_url: 'https://page.example/landing' }, page: 'https://page.example/landing' },
    {
      field: 'primary_location.landing_page_url',
      record: { primary_location: { landing_page_url: 'https://page.example/primary' } },
      page: 'https://page.example/primary',
    },
    {
      field: 'best_oa_location.landing_page_url',
      record: { best_oa_location: { landing_page_url: 'https://page.example/best' } },
      page: 'https://page.example/best',
    },
    { field: 'id', record: { id: 'https://page.example/id' }, page: 'https://page.example/id' },
  ])('browser-extracts the record page carried as $field', async ({ record, page }) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      let script = ''
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith(record),
          fetchImpl: pdfFetch(),
          extractor: extractorWith(async (input) => {
            script = input
            return { exitCode: 0, stdout: 'BU_EXTRACT:https://cdn.example/w123.pdf\n', stderr: '', timedOut: false }
          }),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; method?: string } }
      expect(value.result.status).toBe('ok')
      expect(value.result.method).toBe('browser')
      expect(script).toContain(JSON.stringify(page))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('honors the pdfUrl override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const fetchImpl = vi.fn(pdfFetch())
      const result = await executeTool(
        { db: 'fake', id: 'W123', pdfUrl: 'https://override.example/a.pdf', outputDir: dir },
        { registry: registryWith({ extra: {} }), fetchImpl },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(fetchImpl).toHaveBeenCalledWith('https://override.example/a.pdf', expect.anything())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a skipped fallback when a pdfUrl override fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', pdfUrl: 'https://override.example/a.pdf', outputDir: dir },
        { registry: registryWith({ url: 'https://page.example/x' }), fetchImpl: failingFetch(403) },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string; pdfUrl?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('record-page fallback skipped for the pdfUrl override')
      expect(value.result.pdfUrl).toBe('https://override.example/a.pdf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown db', async () => {
    const result = await executeTool({ db: 'nope', id: 'W123' }, { registry: registryWith({}) })
    expect(result.isError).toBe(true)
  })

  it('rejects an empty db or id', async () => {
    const result = await executeTool({ db: ' ', id: 'W123' }, { registry: registryWith({}) })
    expect(result.isError).toBe(true)
    const emptyId = await executeTool({ db: 'fake', id: '' }, { registry: registryWith({}) })
    expect(emptyId.isError).toBe(true)
  })

  it('rejects an out-of-range timeoutMs', async () => {
    const result = await executeTool({ db: 'fake', id: 'W123', timeoutMs: 0 }, { registry: registryWith({}) })
    expect(result.isError).toBe(true)
    const tooBig = await executeTool({ db: 'fake', id: 'W123', timeoutMs: 300001 }, { registry: registryWith({}) })
    expect(tooBig.isError).toBe(true)
    const fractional = await executeTool({ db: 'fake', id: 'W123', timeoutMs: 1.5 }, { registry: registryWith({}) })
    expect(fractional.isError).toBe(true)
  })

  it('rejects an HTML shell page from the direct link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const htmlFetch = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
        arrayBuffer: async () => new TextEncoder().encode('<html><body>shell</body></html>').buffer,
      })) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: htmlFetch },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('Content-Type')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a too-small direct response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const smallFetch = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => new TextEncoder().encode('tiny').buffer,
      })) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: smallFetch },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('too small')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a body without the PDF magic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const badMagic = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => new TextEncoder().encode('x'.repeat(600)).buffer,
      })) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: badMagic },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('magic')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the fetch throws a non-Error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const throwingFetch = (async () => { throw 'plain failure' }) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: throwingFetch },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('plain failure')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the global fetch when no fetchImpl is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    const globalFetch = globalThis.fetch
    try {
      globalThis.fetch = pdfFetch()
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }) },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string } }
      expect(value.result.status).toBe('ok')
    } finally {
      globalThis.fetch = globalFetch
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats a whitespace-only pdfUrl override as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', pdfUrl: '   ', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string } }
      expect(value.result.status).toBe('ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the browser extraction itself fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' }, url: 'https://page.example/x' }),
          fetchImpl: failingFetch(403),
          extractor: extractorWith(async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false })),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('browser extraction failed: browser-use exited 1: boom')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the browser-extracted link also fails to download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/w123.pdf' }, url: 'https://page.example/x' }),
          fetchImpl: failingFetch(403),
          extractor: extractorWith(async () => ({ exitCode: 0, stdout: 'BU_EXTRACT:https://cdn.example/w123.pdf\n', stderr: '', timedOut: false })),
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string; pdfUrl?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('HTTP 403')
      expect(value.result.pdfUrl).toBe('https://cdn.example/w123.pdf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders the retry link for a failed download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(createPaperDownloadTool({
        registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }),
        fetchImpl: failingFetch(403),
      }))
      const result = await executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('pd-2'),
        name: 'paper_download',
        arguments: { db: 'fake', id: 'W123', outputDir: dir },
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      expect(text).toContain('可手动重试')
      expect(text).toContain('https://pdf.example/x.pdf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names an empty catalog in the unknown-db error', async () => {
    const empty = new ConnectorRegistry()
    const result = await executeTool({ db: 'nope', id: 'W123' }, { registry: empty })
    expect(result.isError).toBe(true)
  })

  it('treats a null content-type header as not-html', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const nullType = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(600)).buffer,
      })) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: nullType },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string } }
      expect(value.result.status).toBe('ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces the timeoutMs cap on a hanging download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      // The mock fetch hangs until the abort signal fires (real fetch aborts on the same signal).
      const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'))
          })
        })
      }) as unknown as typeof fetch
      const result = await executeTool(
        { db: 'fake', id: 'W123', timeoutMs: 20, outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: hangingFetch },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toMatch(/time/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces the whole-call deadline while the connector record fetch hangs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'fake',
        name: 'Fake',
        domain: 'literature',
        description: 'fake',
        search: async () => [],
        fetch: async (_id, options) => new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => { reject(new Error('aborted by deadline')) })
        }),
      })
      const result = await executeTool(
        { db: 'fake', id: 'W123', timeoutMs: 20, outputDir: dir },
        { registry, fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toBe('paper_download timed out after 20ms')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces the whole-call deadline during browser extraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const extractor = extractorWith(async (_script, options) => {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => { resolve() })
        })
        return { exitCode: null, stdout: '', stderr: '', timedOut: true }
      })
      const result = await executeTool(
        { db: 'fake', id: 'W123', timeoutMs: 20, outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' }, url: 'https://record.example/x' }),
          fetchImpl: failingFetch(403),
          extractor,
        },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toBe('paper_download timed out after 20ms')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports failed when the connector has no fetch implementation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'nofetch',
        name: 'NoFetch',
        domain: 'literature',
        description: 'no fetch',
        search: async () => [],
      })
      const result = await executeTool(
        { db: 'nofetch', id: 'W123', outputDir: dir },
        { registry, fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { status: string; error?: string } }
      expect(value.result.status).toBe('failed')
      expect(value.result.error).toContain('no PDF link')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports an actionable rate-limit message when the connector fetch fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'arxiv',
        name: 'arXiv',
        domain: 'literature',
        description: 'arxiv',
        search: async () => [],
        fetch: async () => {
          throw new Error('HTTP 429 Too Many Requests')
        },
      })
      const result = await executeTool(
        { db: 'arxiv', id: '1706.03762', outputDir: dir },
        { registry, fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(true)
      const message = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      expect(message).toContain('rate limiting')
      expect(message).toContain('arXiv allows ~1 request every 3s')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a non-rate-limit connector failure with the source name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'fake',
        name: 'Fake',
        domain: 'literature',
        description: 'fake',
        search: async () => [],
        fetch: async () => {
          throw new Error('upstream exploded')
        },
      })
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry, fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(true)
      const message = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      expect(message).toContain('Fake returned an error: upstream exploded')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('propagates caller cancellation during the connector fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const controller = new AbortController()
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'fake',
        name: 'Fake',
        domain: 'literature',
        description: 'fake',
        search: async () => [],
        fetch: async () => {
          controller.abort(new Error('cancelled during record fetch'))
          throw new Error('cancelled during record fetch')
        },
      })
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        { registry, fetchImpl: pdfFetch(), callSignal: controller.signal },
      )
      expect(result.isError).toBe(true)
      expect(result.error?.message).toBe('cancelled during record fetch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('propagates a caller abort that lands before record resolution when the connector has no fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const controller = new AbortController()
      const registry = new ConnectorRegistry()
      registry.register({
        id: 'fake',
        name: 'Fake',
        domain: 'literature',
        description: 'fake',
        search: async () => [],
      })
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry,
          callSignal: controller.signal,
          resolveOutputDir: () => {
            controller.abort('cancelled before record lookup')
            return dir
          },
        },
      )
      expect(result.isError).toBe(true)
      expect(result.error?.message).toBe('request aborted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('propagates caller cancellation during the PDF fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const controller = new AbortController()
      const abortingFetch: typeof fetch = async () => {
        controller.abort(new Error('cancelled during pdf fetch'))
        throw new Error('cancelled during pdf fetch')
      }
      const result = await executeTool(
        { db: 'fake', id: 'W123', outputDir: dir },
        {
          registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }),
          fetchImpl: abortingFetch,
          callSignal: controller.signal,
        },
      )
      expect(result.isError).toBe(true)
      expect(result.error?.message).toBe('cancelled during pdf fetch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sanitizes slashes in the paper id used as the file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123/456', outputDir: dir },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: pdfFetch() },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { result: { path?: string } }
      expect(value.result.path).toBe(join(dir, 'W123_456.pdf'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('defaults the output dir to <cwd>/论文原文/YYYY-MM-DD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
    try {
      const result = await executeTool(
        { db: 'fake', id: 'W123' },
        { registry: registryWith({ extra: { pdf_url: 'https://pdf.example/x.pdf' } }), fetchImpl: pdfFetch(), cwd },
      )
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const value = result.value as { outputDir: string }
      expect(value.outputDir).toContain(join(cwd, '论文原文'))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
