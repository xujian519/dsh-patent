import { describe, expect, it, vi } from 'vitest'
import { createSemanticScholarConnector } from '../../../src/runtime/connectors/semantic-scholar.ts'
import { LiteratureHttpClient } from '../../../src/runtime/http.ts'
import type { Connector } from '../../../src/protocol/types.ts'

/** Test injection: skip the keyless 1s per-host rate limit to keep the suite fast. */
function makeConnector(fetchImpl: typeof fetch, options: { apiKey?: string } = {}): Connector {
  return createSemanticScholarConnector({ ...options, fetchImpl, rateLimit: { minIntervalMs: 0 } })
}

const SEARCH_RESPONSE = {
  total: 1,
  data: [
    {
      paperId: '204e3073870fae3d05bcbc2f6a8e263d9b72e776',
      title: 'Attention Is All You Need',
      abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
      url: 'https://www.semanticscholar.org/paper/Attention-Is-All-You-Need-204e3073870fae3d05bcbc2f6a8e263d9b72e776',
      year: 2017,
      venue: 'NeurIPS',
      citationCount: 120000,
      externalIds: { ArXiv: '1706.03762' },
      authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
    },
  ],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('semantic scholar connector', () => {
  it('normalizes hits with citation score', async () => {
    const connector = makeConnector(async () => jsonResponse(SEARCH_RESPONSE))
    const hits = await connector.search('attention is all you need')

    expect(hits.length).toBe(1)
    const hit = hits[0]!
    expect(hit.id).toBe('204e3073870fae3d05bcbc2f6a8e263d9b72e776')
    expect(hit.title).toBe('Attention Is All You Need')
    expect(hit.score).toBe(120000)
    expect(hit.summary).toBe('The dominant sequence transduction models are based on complex recurrent networks.')
  })

  it('forwards the clamped result limit', async () => {
    let url = ''
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return jsonResponse({ data: [] })
    })

    await connector.search('attention', { limit: 999 })
    expect(url.includes('limit=50')).toBe(true)
  })

  it('sends no x-api-key header on keyless tier', async () => {
    let headers: Record<string, string> | undefined
    const connector = makeConnector(async (_input, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return jsonResponse({ data: [] })
    })

    await connector.search('attention')
    expect(headers?.['x-api-key']).toBeUndefined()
  })

  it('sends x-api-key header when key configured', async () => {
    let headers: Record<string, string> | undefined
    const connector = makeConnector(
      async (_input, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>
        return jsonResponse({ data: [] })
      },
      { apiKey: 's2-test-key' },
    )

    await connector.search('transformer')
    expect(headers?.['x-api-key']).toBe('s2-test-key')
  })

  it('normalizes sparse papers defensively', async () => {
    const connector = makeConnector(async () => jsonResponse({
      total: 2,
      data: [
        { paperId: 'abc123' },
        {},
      ],
    }))
    const hits = await connector.search('edge')
    const [idOnly, bare] = hits
    expect(idOnly!.id).toBe('abc123')
    expect(idOnly!.title).toBe('abc123')
    expect(idOnly!.url).toBe('https://www.semanticscholar.org/paper/abc123')
    expect(idOnly!.score).toBeUndefined()
    expect(idOnly!.summary).toBeUndefined()
    expect(bare!.id).toBe('')
    expect(bare!.title).toBe('Untitled')
    expect(bare!.url).toBeUndefined()
    expect(bare!.summary).toBeUndefined()
  })

  it('returns [] when data is absent', async () => {
    const connector = makeConnector(async () => jsonResponse({ total: 0 }))
    await expect(connector.search('none')).resolves.toEqual([])
  })

  it('fetch resolves papers and null records, preserving external id segments', async () => {
    let url = ''
    let calls = 0
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls += 1
      return jsonResponse(calls === 1 ? { paperId: 'p1', title: 'T' } : null)
    })

    const paper = await connector.fetch!('DOI:10.1111/test')
    expect((paper as { paperId: string }).paperId).toBe('p1')
    expect(url.includes('/paper/DOI:10.1111/test?fields=')).toBe(true)

    await expect(connector.fetch!('ARXIV:1706.03762')).resolves.toBeNull()
  })

  it('applies the default keyless rate limit when none configured', async () => {
    const client = new LiteratureHttpClient()
    const getJSON = vi.spyOn(client, 'getJSON').mockResolvedValue({ data: [] })
    const connector = createSemanticScholarConnector({ client, fetchImpl: async () => jsonResponse({ data: [] }) })
    await connector.search('default rate limit probe')
    expect(getJSON.mock.calls[0]?.[1]?.rateLimit).toEqual({ minIntervalMs: 1000 })
  })

  it('exposes the open-access pdf link in extra.pdf_url', async () => {
    const connector = createSemanticScholarConnector({
      rateLimit: { minIntervalMs: 0 },
      retry: { maxRetries: 0 },
      fetchImpl: async () => jsonResponse({ data: [{ paperId: 'p1', title: 'T', openAccessPdf: { url: 'https://pdf.example/a.pdf' } }] }),
    })
    const [hit] = await connector.search('t', { limit: 5 })
    expect((hit?.extra as { pdf_url?: string }).pdf_url).toBe('https://pdf.example/a.pdf')
  })

  it('omits pdf_url when the record has no open-access pdf', async () => {
    const connector = createSemanticScholarConnector({
      rateLimit: { minIntervalMs: 0 },
      retry: { maxRetries: 0 },
      fetchImpl: async () => jsonResponse({ data: [{ paperId: 'p1', title: 'T' }] }),
    })
    const [hit] = await connector.search('t', { limit: 5 })
    expect((hit?.extra as { pdf_url?: string }).pdf_url).toBeUndefined()
  })
})
