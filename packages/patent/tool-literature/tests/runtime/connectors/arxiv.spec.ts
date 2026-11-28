import { describe, expect, it } from 'vitest'
import { createArxivConnector } from '../../../src/runtime/connectors/arxiv.ts'
import type { Connector } from '../../../src/protocol/types.ts'

/** Test injection: skip arXiv's 3s per-host rate limit to keep the suite fast. */
function makeConnector(fetchImpl: typeof fetch): Connector {
  return createArxivConnector({ fetchImpl, rateLimit: { minIntervalMs: 0 } })
}

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-07-19T15:24:00Z</updated>
    <published>2017-06-12T00:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2001.00001v1</id>
    <published>2020-01-01T00:00:00Z</published>
    <title>Second Paper</title>
    <author><name>Jane Doe</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.AI"/>
    <link title="pdf" href="http://arxiv.org/pdf/2001.00001v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`

const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#malformed</id>
    <title>Error</title>
    <summary>Query can not be processed.</summary>
  </entry>
</feed>`

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: all:zzzz</title>
</feed>`

function atomResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'content-type': 'application/atom+xml' } })
}

describe('arxiv connector', () => {
  it('parses Atom feed into normalized hits with pdf links', async () => {
    let url = ''
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return atomResponse(ATOM_FEED)
    })

    const hits = await connector.search('attention is all you need', { limit: 10 })

    expect(hits.length).toBe(2)
    const first = hits[0]!
    expect(first.id).toBe('1706.03762v7')
    expect(first.title).toBe('Attention Is All You Need')
    expect(first.url).toBe('http://arxiv.org/abs/1706.03762v7')
    expect(first.extra?.pdf).toBe('http://arxiv.org/pdf/1706.03762v7')
    expect(first.summary?.includes('dominant sequence')).toBe(true)
    expect(url.includes('search_query=all%3Aattention%20is%20all%20you%20need')).toBe(true)
    expect(url.includes('max_results=10')).toBe(true)
  })

  it('wraps bare queries in all: but passes fielded queries through', async () => {
    const urls: string[] = []
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return atomResponse(EMPTY_FEED)
    })

    await connector.search('ti:transformer AND cat:cs.LG')
    expect(urls[0]!.includes('search_query=ti%3Atransformer%20AND%20cat%3Acs.LG')).toBe(true)
    expect(urls[0]!.includes('all%3A')).toBe(false)

    await connector.search('quantum computing')
    expect(urls[1]!.includes('search_query=all%3Aquantum%20computing')).toBe(true)
  })

  it('clamps limit to 50', async () => {
    let url = ''
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return atomResponse(EMPTY_FEED)
    })

    await connector.search('anything', { limit: 100 })
    expect(url.includes('max_results=50')).toBe(true)
  })

  it('treats 200 + Error entry as an error, not a hit', async () => {
    const connector = makeConnector(async () => atomResponse(ERROR_FEED))
    await expect(connector.search('malformed query')).rejects.toThrow(/arXiv rejected the query/)
  })

  it('does not cache the 200+Error feed, so a retry reaches the network again', async () => {
    let calls = 0
    const connector = makeConnector(async () => {
      calls += 1
      return atomResponse(ERROR_FEED)
    })
    await expect(connector.search('malformed query')).rejects.toThrow(/arXiv rejected the query/)
    await expect(connector.search('malformed query')).rejects.toThrow(/arXiv rejected the query/)
    // 缓存住错误会把一次瞬时限流变成整个 TTL 内必然失败的查询。
    expect(calls).toBe(2)
  })

  it('rejects non-Atom bodies as source errors', async () => {
    const connector = makeConnector(async () => new Response('<html>rate limited</html>', { status: 200 }))
    await expect(connector.search('anything')).rejects.toThrow(/non-Atom response/)
  })

  it('returns empty array for genuine zero hits', async () => {
    const connector = makeConnector(async () => atomResponse(EMPTY_FEED))
    const hits = await connector.search('zzzz nonexistent')
    expect(hits).toEqual([])
  })

  it('fetch resolves a bare id via id_list', async () => {
    let url = ''
    const connector = makeConnector(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return atomResponse(ATOM_FEED)
    })
    const record = await connector.fetch!('1706.03762')
    expect((record as { id: string }).id.includes('1706.03762')).toBe(true)
    expect(url.includes('id_list=1706.03762&max_results=1')).toBe(true)
  })

  it('returns null when fetch finds no entry', async () => {
    const connector = makeConnector(async () => atomResponse(EMPTY_FEED))
    await expect(connector.fetch!('2002.99999')).resolves.toBeNull()
  })

  it('normalizes entries missing id or title defensively', async () => {
    const MINIMAL_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>No Id Paper</title>
    <summary>Has a title but no id.</summary>
    <author><name>Jane Doe</name></author>
    <link href="http://arxiv.org/abs/noid" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2002.00001v1</id>
    <summary>No title, id only.</summary>
  </entry>
</feed>`
    const connector = makeConnector(async () => atomResponse(MINIMAL_FEED))
    const hits = await connector.search('test')
    const [noId, noTitle] = hits
    expect(noId!.id).toBe('')
    expect(noId!.title).toBe('No Id Paper')
    expect(noId!.url).toBe('https://arxiv.org/abs/')
    expect(noId!.extra?.pdf).toBeUndefined()
    expect(noTitle!.title).toBe('2002.00001v1')
  })

  it('falls back to title or a fixed message for error entries without a summary', async () => {
    const NO_SUMMARY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#q</id>
    <title>Error</title>
  </entry>
</feed>`
    const connector = makeConnector(async () => atomResponse(NO_SUMMARY_FEED))
    await expect(connector.search('bad query')).rejects.toThrow(/arXiv rejected the query: Error/)

    const BARE_ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#q</id>
  </entry>
</feed>`
    const bare = makeConnector(async () => atomResponse(BARE_ERROR_FEED))
    await expect(bare.search('other bad query')).rejects.toThrow(/arXiv rejected the query: malformed request/)
  })
})
