// Port of Sati tests/patent/data/nuo/patentCache.spec.ts: LRU + TTL +
// in-flight merge, cacheability predicates, and cached search/scrape wrappers.
import { describe, expect, it } from 'vitest'
import type { PatentSearchResult, ScrapeResult } from '@deepseek-ai/nuo-patent'
import {
  AsyncResultCache,
  cachedScrapePatent,
  cachedSearchPatents,
  isScrapeResultCacheable,
  isSearchResultCacheable,
  scrapeCacheKey,
} from '@deepseek-ai/dsh-patent-data'

function makeSearchResult(overrides: Partial<PatentSearchResult> = {}): PatentSearchResult {
  return {
    query: 'thermal',
    total: 1,
    hits: [
      {
        patent: 'US11452699B2',
        title: 'Thermal management system',
        assignee: 'Apple Inc.',
        publication_date: '2022-09-27',
        priority_date: '2019-12-31',
        abstract: 'A thermal management system.',
        url: 'https://patents.google.com/patent/US11452699B2',
      },
    ],
    warnings: [],
    ...overrides,
  }
}

function makeScrapeResult(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    success: true,
    patent: 'US11452699B2',
    url: 'https://patents.google.com/patent/US11452699B2',
    data: {
      title: 'Thermal management system',
      application_number: '17/000,000',
      inventor_name: '[{"inventor_name":"John"}]',
      assignee_name_orig: '[{"assignee_name":"Apple"}]',
      assignee_name_current: '',
      pub_date: '2022-09-27',
      filing_date: '2019-12-31',
      priority_date: '2019-12-31',
      grant_date: '',
      expiration_date: '',
      legal_status: '',
      ifi_status: '',
      estimated_expiration: '',
      pdf_url: 'https://patents.google.com/patent/US11452699B2/en?oq=US11452699B2',
      classifications: '["F28D"]',
      backward_cite_no_family: '[]',
      backward_cite_yes_family: '[]',
      forward_cite_no_family: '[]',
      forward_cite_yes_family: '[]',
      abstract_text: 'A thermal management system.',
    },
    errorCode: '',
    errorMessage: '',
    parseWarnings: [],
    ...overrides,
  }
}

describe('AsyncResultCache', () => {
  it('serves cache hits without re-running the loader', async () => {
    let calls = 0
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const loader = async () => {
      calls += 1
      return `v${calls}`
    }
    expect((await cache.getOrLoad('k', loader)).value).toBe('v1')
    expect((await cache.getOrLoad('k', loader)).value).toBe('v1')
    expect(calls).toBe(1)
  })

  it('reports cache hits with the original fetch time', async () => {
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const first = await cache.getOrLoad('k', async () => 'v1')
    const second = await cache.getOrLoad('k', async () => 'v2')
    expect(first).toMatchObject({ value: 'v1', cached: false })
    expect(second).toMatchObject({ value: 'v1', cached: true, retrievedAt: first.retrievedAt })
    expect(Number.isNaN(Date.parse(first.retrievedAt))).toBe(false)
  })

  it('deduplicates concurrent same-key loads', async () => {
    let calls = 0
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const loader = async () => {
      calls += 1
      await gate
      return 'done'
    }
    const p1 = cache.getOrLoad('k', loader)
    const p2 = cache.getOrLoad('k', loader)
    const p3 = cache.getOrLoad('k', loader)
    release()
    const settled = await Promise.all([p1, p2, p3])
    expect(settled.map(r => r.value)).toEqual(['done', 'done', 'done'])
    // Concurrent callers share one live fetch, so none of them is a cache hit.
    expect(settled.map(r => r.cached)).toEqual([false, false, false])
    expect(calls).toBe(1)
  })

  it('reloads after TTL expiry', async () => {
    let calls = 0
    const cache = new AsyncResultCache<string>({ ttlMs: 1 })
    const loader = async () => {
      calls += 1
      return `v${calls}`
    }
    expect((await cache.getOrLoad('k', loader)).value).toBe('v1')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await cache.getOrLoad('k', loader)).value).toBe('v2')
    expect(calls).toBe(2)
  })

  it('evicts the least-recently-used entry at capacity', async () => {
    const cache = new AsyncResultCache<string>({ maxEntries: 2 })
    let calls = 0
    const loader = async (n: string) => {
      calls += 1
      return `v${n}`
    }
    await cache.getOrLoad('a', () => loader('a'))
    await cache.getOrLoad('b', () => loader('b'))
    await cache.getOrLoad('a', () => loader('a'))
    await cache.getOrLoad('c', () => loader('c'))
    expect((await cache.getOrLoad('a', () => loader('a'))).value).toBe('va')
    expect((await cache.getOrLoad('b', () => loader('b'))).value).toBe('vb')
    expect(calls).toBe(4)
  })

  it('does not cache a rejected load', async () => {
    let calls = 0
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const loader = async () => {
      calls += 1
      if (calls === 1) throw new Error('network down')
      return 'ok'
    }
    await expect(cache.getOrLoad('k', loader)).rejects.toThrow(/network down/)
    expect((await cache.getOrLoad('k', loader)).value).toBe('ok')
    expect(calls).toBe(2)
  })

  it('passes through without caching when shouldCache returns false', async () => {
    let calls = 0
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const loader = async () => {
      calls += 1
      return 'transient'
    }
    expect((await cache.getOrLoad('k', loader, () => false)).value).toBe('transient')
    expect((await cache.getOrLoad('k', loader, () => false)).value).toBe('transient')
    expect(calls).toBe(2)
  })

  it('reports live entries and clears both cached and in-flight state', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const loading = cache.getOrLoad('k', async () => {
      await gate
      return 'v1'
    })
    expect(cache.size).toBe(0)
    release()
    expect((await loading).value).toBe('v1')
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect((await cache.getOrLoad('k', async () => 'v2')).value).toBe('v2')
  })

  it('lets a same-key store settle before the outer store when the loader re-enters', async () => {
    const cache = new AsyncResultCache<string>({ ttlMs: 60_000 })
    const outer = cache.getOrLoad('k', async () => {
      // The nested call runs before the outer loader's value is stored, so the
      // outer store must replace an entry that is already present.
      void cache.getOrLoad('k', async () => 'nested')
      return 'outer'
    })
    expect((await outer).value).toBe('outer')
    expect((await cache.getOrLoad('k', async () => 'again')).value).toBe('outer')
  })

  it('stops evicting when the cache holds no entries (zero-capacity config)', async () => {
    const cache = new AsyncResultCache<string>({ maxEntries: 0, ttlMs: 60_000 })
    expect((await cache.getOrLoad('k', async () => 'v')).value).toBe('v')
    expect(cache.size).toBe(1)
  })
})

describe('isSearchResultCacheable / isScrapeResultCacheable', () => {
  it('caches a successful search', () => {
    expect(isSearchResultCacheable(makeSearchResult())).toBe(true)
  })

  it('rejects failure/timeout/empty-query warnings', () => {
    expect(isSearchResultCacheable(makeSearchResult({ warnings: ['检索失败: network down'] }))).toBe(false)
    expect(isSearchResultCacheable(makeSearchResult({ warnings: ['检索超时 (30000ms)'] }))).toBe(false)
    expect(isSearchResultCacheable(makeSearchResult({ warnings: ['查询条件为空'] }))).toBe(false)
  })

  it('caches a parse-class warning (non-fatal)', () => {
    expect(isSearchResultCacheable(makeSearchResult({ warnings: ['搜索结果页未解析到任何结果'] }))).toBe(true)
  })

  it('does not cache an empty result, even without a failure warning', () => {
    // 解析降级会以非致命告警返回零命中；缓存它会把一次瞬时失败固定成整个 TTL 的答案。
    expect(isSearchResultCacheable(makeSearchResult({ hits: [], total: 0 }))).toBe(false)
    expect(isSearchResultCacheable(makeSearchResult({ hits: [], total: 0, warnings: ['搜索结果页未解析到任何结果'] }))).toBe(false)
  })

  it('caches a successful scrape only', () => {
    expect(isScrapeResultCacheable(makeScrapeResult())).toBe(true)
    expect(isScrapeResultCacheable(makeScrapeResult({ success: false, errorCode: 'NOT_FOUND' }))).toBe(false)
    expect(isScrapeResultCacheable(makeScrapeResult({ success: false, errorCode: 'TIMEOUT' }))).toBe(false)
  })
})

describe('cachedSearchPatents / cachedScrapePatent', () => {
  it('hits the search source once per query within TTL', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return makeSearchResult()
    }
    const wrapped = cachedSearchPatents(impl)
    await wrapped('thermal')
    await wrapped('thermal')
    await wrapped('thermal', { limit: 10 })
    expect(calls).toBe(1)
  })

  it('keys distinct limits separately', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return makeSearchResult()
    }
    const wrapped = cachedSearchPatents(impl)
    await wrapped('thermal', { limit: 5 })
    await wrapped('thermal', { limit: 10 })
    expect(calls).toBe(2)
  })

  it('does not cache a failed search', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return makeSearchResult({ hits: [], total: 0, warnings: ['检索失败: network down'] })
    }
    const wrapped = cachedSearchPatents(impl)
    await wrapped('thermal')
    await wrapped('thermal')
    expect(calls).toBe(2)
  })

  it('does not cache an empty search result', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return makeSearchResult({ hits: [], total: 0, warnings: ['搜索结果页未解析到任何结果'] })
    }
    const wrapped = cachedSearchPatents(impl)
    await wrapped('thermal')
    await wrapped('thermal')
    expect(calls).toBe(2)
  })

  it('does not cache NOT_FOUND and caches a later success', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return calls === 1
        ? makeScrapeResult({ success: false, errorCode: 'NOT_FOUND', errorMessage: 'not found' })
        : makeScrapeResult()
    }
    const wrapped = cachedScrapePatent(impl)
    expect((await wrapped('US11452699B2')).value.success).toBe(false)
    expect((await wrapped('US11452699B2')).value.success).toBe(true)
    expect(calls).toBe(2)
  })

  it('hits the scrape source once per patent within TTL', async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return makeScrapeResult()
    }
    const wrapped = cachedScrapePatent(impl)
    await wrapped('US11452699B2')
    await wrapped('US11452699B2')
    expect(calls).toBe(1)
  })

  it('encodes the abstract/legal toggles in scrape cache keys', () => {
    expect(scrapeCacheKey('US11452699B2', { returnAbstract: false, returnLegal: true })).toBe('scrape\u0000US11452699B2\u000001')
    expect(scrapeCacheKey('US11452699B2', { returnAbstract: true, returnLegal: false })).toBe('scrape\u0000US11452699B2\u000010')
  })

  it('forwards the per-call timeout and signal without caching them', async () => {
    const controller = new AbortController()
    const seen: Array<{ timeout?: number; signal?: AbortSignal }> = []
    const impl = async (_patent: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      seen.push(opts ?? {})
      return makeScrapeResult()
    }
    const wrapped = cachedScrapePatent(impl)
    await wrapped('US11452699B2', { timeout: 1_234, signal: controller.signal })
    await wrapped('US11452699B2')
    // Second call is a cache hit, so the engine saw the forwarded options once.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.timeout).toBe(1_234)
    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('forwards the per-call timeout and signal on the search cache too', async () => {
    const controller = new AbortController()
    const seen: Array<{ timeout?: number; signal?: AbortSignal }> = []
    const impl = async (_query: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      seen.push(opts ?? {})
      return makeSearchResult()
    }
    const wrapped = cachedSearchPatents(impl)
    await wrapped('thermal', { timeout: 999, signal: controller.signal })
    expect(seen[0]?.timeout).toBe(999)
    expect(seen[0]?.signal).toBe(controller.signal)
  })
})
