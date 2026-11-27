/**
 * Patent search/scrape result cache: LRU + TTL + in-flight merge. Only
 * cacheable (successful) results are stored; failures, timeouts, and empty
 * results pass through without poisoning the cache.
 * @module @deepseek-ai/dsh-patent-data/patent-cache
 */

import type { PatentSearchResult, ScrapeResult } from '@deepseek-ai/nuo-patent'
import type { CachedLookup, PatentCacheOptions } from './types.ts'

/** Default search/scrape cache TTL in milliseconds (10 minutes). */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000

/** Default search/scrape cache capacity in entries. */
const DEFAULT_CACHE_MAX_ENTRIES = 100

type CacheNode<T> = { value: T; expiresAt: number; retrievedAt: number }

/**
 * Generic async-result cache: LRU eviction, per-entry TTL, and in-flight merge.
 * Only a loader's resolved value is cached; rejections never are. Every lookup
 * reports whether the value came from a live entry and when the value was
 * originally fetched, so consumers can state retrieval time instead of call time.
 */
export class AsyncResultCache<T> {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly map = new Map<string, CacheNode<T>>()
  private readonly inflight = new Map<string, Promise<CachedLookup<T>>>()

  constructor(options: PatentCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES
  }

  /**
   * Return the cached value, or load (deduplicating concurrent callers) and cache it.
   * @param key - cache key.
   * @param loader - the underlying load to run on a miss.
   * @param shouldCache - optional predicate; false passes the value through without caching.
   * @returns the value with its cache-hit flag and original fetch time.
   */
  async getOrLoad(key: string, loader: () => Promise<T>, shouldCache?: (value: T) => boolean): Promise<CachedLookup<T>> {
    const pending = this.inflight.get(key)
    if (pending) return pending

    const node = this.map.get(key)
    if (node) {
      if (Date.now() < node.expiresAt) {
        this.map.delete(key)
        this.map.set(key, node)
        return { value: node.value, cached: true, retrievedAt: new Date(node.retrievedAt).toISOString() }
      }
      this.map.delete(key)
    }

    const promise = loader().then((value) => {
      const retrievedAt = Date.now()
      if (shouldCache === undefined || shouldCache(value)) {
        this.set(key, value, retrievedAt)
      }
      return { value, cached: false, retrievedAt: new Date(retrievedAt).toISOString() }
    })
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(key)
    }
  }

  private set(key: string, value: T, retrievedAt: number): void {
    const existing = this.map.get(key)
    if (existing) {
      this.map.delete(key)
    }
    while (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs, retrievedAt })
  }

  /** Clear the cache and the in-flight merge table (tests / explicit invalidation). */
  clear(): void {
    this.map.clear()
    this.inflight.clear()
  }

  /** Number of live entries in the cache. */
  get size(): number {
    return this.map.size
  }
}

/**
 * A search result is cacheable when it carries hits and no failure-class warning.
 * Empty results pass through uncached: the engine also reports parse degradation
 * as a non-fatal warning, and caching that zero-hit answer would keep the failure
 * visible for the whole TTL after the next query could have succeeded.
 * @param result - the search result to check.
 * @returns true when the result carries hits and no failure-class warning.
 */
export function isSearchResultCacheable(result: PatentSearchResult): boolean {
  return result.hits.length > 0
    && !result.warnings.some(w => /^(查询条件为空|检索超时|检索失败)/.test(w))
}

/**
 * A scrape result is cacheable only on success.
 * @param result - the scrape result to check.
 * @returns true when the scrape succeeded.
 */
export function isScrapeResultCacheable(result: ScrapeResult): boolean {
  return result.success
}

/**
 * Build the search cache key (query + limit).
 * @param query - the search query.
 * @param limit - the max-hits limit.
 * @returns the cache key.
 */
export function searchCacheKey(query: string, limit: number): string {
  return `search\u0000${query}\u0000${limit}`
}

/**
 * Build the scrape cache key (patent + content toggles).
 * @param patent - the patent number.
 * @param opts - the content toggles (abstract and legal status).
 * @returns the cache key.
 */
export function scrapeCacheKey(patent: string, opts: { returnAbstract: boolean; returnLegal: boolean }): string {
  return `scrape\u0000${patent}\u0000${opts.returnAbstract ? 1 : 0}${opts.returnLegal ? 1 : 0}`
}

/**
 * Wrap a search implementation with LRU cache + in-flight merge.
 * @param impl - the underlying search function.
 * @param options - optional cache tuning.
 * @returns the cached search function, whose lookups carry cache-hit and fetch-time facts.
 */
export function cachedSearchPatents(
  impl: (query: string, options?: { limit?: number }) => Promise<PatentSearchResult>,
  options: PatentCacheOptions = {},
): (query: string, options?: { limit?: number }) => Promise<CachedLookup<PatentSearchResult>> {
  const cache = new AsyncResultCache<PatentSearchResult>(options)
  return async (query, opts) => {
    const limit = opts?.limit ?? 10
    return cache.getOrLoad(searchCacheKey(query, limit), () => impl(query, { limit }), isSearchResultCacheable)
  }
}

/**
 * Wrap a scrape implementation with LRU cache + in-flight merge (success only).
 * @param impl - the underlying scrape function.
 * @param options - optional cache tuning.
 * @returns the cached scrape function, whose lookups carry cache-hit and fetch-time facts.
 */
export function cachedScrapePatent(
  impl: (patent: string, options?: { returnAbstract?: boolean; returnLegal?: boolean }) => Promise<ScrapeResult>,
  options: PatentCacheOptions = {},
): (patent: string, options?: { returnAbstract?: boolean; returnLegal?: boolean }) => Promise<CachedLookup<ScrapeResult>> {
  const cache = new AsyncResultCache<ScrapeResult>(options)
  return async (patent, opts) => {
    const returnAbstract = opts?.returnAbstract ?? true
    const returnLegal = opts?.returnLegal ?? true
    return cache.getOrLoad(
      scrapeCacheKey(patent, { returnAbstract, returnLegal }),
      () => impl(patent, { returnAbstract, returnLegal }),
      isScrapeResultCacheable,
    )
  }
}
