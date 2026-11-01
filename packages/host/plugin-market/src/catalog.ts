/**
 * Catalog client: fetch and validate a source manifest, then query a source's
 * `/v1/plugins` endpoint with only the parameters it supports. Every remote
 * payload passes through the wire schemas; entries carry the `source`
 * providerId of the source that served them.
 * @module @deepseek-ai/dsh-host-plugin-market/catalog
 */

import type { CatalogItem, CatalogPage, CatalogQuery, PluginMarketSource, SourceId } from './types.ts'
import { catalogProviderPageSchema, catalogSourceManifestSchema } from './catalog-schema.ts'
import { restrictedFetchJson, type RestrictedFetchOptions } from './restricted-fetch.ts'

/** The catalog endpoint path appended to a source's transport base URL. */
const CATALOG_PATH = '/v1/plugins'

/**
 * Fetch and validate a catalog source manifest. The returned id is
 * provisional (the provider's own id); registration replaces it with a
 * host-minted identity so the host id never mirrors a provider's claim.
 * @param manifestUrl - HTTPS URL of the source manifest.
 * @param options - fetch bounds.
 * @param resolve - DNS resolver override (tests).
 * @param fetchImpl - fetch override (tests).
 * @returns the registered source shape.
 */
export async function fetchSourceManifest(
  manifestUrl: string,
  options: RestrictedFetchOptions = {},
  resolve?: (host: string) => Promise<readonly string[]>,
  fetchImpl?: typeof fetch,
): Promise<PluginMarketSource> {
  const payload = await restrictedFetchJson(manifestUrl, options, resolve, fetchImpl)
  const parsed = catalogSourceManifestSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`catalog source manifest is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  }
  const manifest = parsed.data
  return {
    id: manifest.providerId as SourceId,
    providerId: manifest.providerId,
    name: manifest.name,
    ...manifest.description !== undefined ? { description: manifest.description } : {},
    ...manifest.homepage !== undefined ? { homepage: manifest.homepage } : {},
    attribution: manifest.attribution,
    endpoint: `${manifest.transport.baseUrl.replace(/\/$/, '')}${CATALOG_PATH}`,
    query: { supported: [...manifest.query.supported] },
  }
}

/** Query parameters the protocol defines, in a stable order. */
const PARAM_ORDER = ['q', 'category', 'capability', 'cursor', 'limit', 'sort', 'locale'] as const

/**
 * Query one source's catalog, sending only the parameters it supports.
 * @param source - the registered source.
 * @param query - the requested search parameters.
 * @param options - fetch bounds.
 * @param resolve - DNS resolver override (tests).
 * @param fetchImpl - fetch override (tests).
 * @returns one page of entries, each stamped with its `source` providerId.
 */
export async function searchCatalog(
  source: PluginMarketSource,
  query: CatalogQuery = {},
  options: RestrictedFetchOptions = {},
  resolve?: (host: string) => Promise<readonly string[]>,
  fetchImpl?: typeof fetch,
): Promise<CatalogPage> {
  const params = new URLSearchParams()
  const supported = new Set(source.query.supported)
  for (const key of PARAM_ORDER) {
    const value = query[key]
    if (value === undefined || !supported.has(key)) continue
    params.set(key, String(value))
  }
  const separator = source.endpoint.includes('?') ? '&' : '?'
  const payload = await restrictedFetchJson(`${source.endpoint}${separator}${params.toString()}`, options, resolve, fetchImpl)
  const parsed = catalogProviderPageSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`catalog page from ${source.providerId} is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  }
  const items: CatalogItem[] = parsed.data.items.map(item => ({
    id: item.id,
    name: item.name,
    ...item.description !== undefined ? { description: item.description } : {},
    package: item.package,
    version: item.version,
    ...item.category !== undefined ? { category: item.category } : {},
    ...item.capability !== undefined ? { capability: [...item.capability] } : {},
    ...item.homepage !== undefined ? { homepage: item.homepage } : {},
    ...item.license !== undefined ? { license: item.license } : {},
    source: source.providerId,
  }))
  return {
    items,
    ...parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {},
  }
}
