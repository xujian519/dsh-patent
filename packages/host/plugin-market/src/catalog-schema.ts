/**
 * Zod wire schemas for the catalog protocol: the source manifest, the query
 * contract, the provider page, and the normalized snapshot entry. Remote
 * catalog payloads are untrusted input; every field is bounded and unknown
 * keys are rejected. The JSON Schema twins live in docs/schemas for
 * non-Node providers.
 * @module @deepseek-ai/dsh-host-plugin-market/catalog-schema
 */

import { z } from 'zod'

/** Protocol version this package accepts from a source manifest. */
const CATALOG_MANIFEST_VERSION = '1.0.0' as const

/** The query parameters the protocol defines; a source declares its subset. */
const CATALOG_QUERY_PARAMS = ['q', 'category', 'capability', 'cursor', 'limit', 'sort', 'locale'] as const

const urlSchema = z.string().max(2048).refine((value) => {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}, 'expected an absolute URL')

/** Source manifest as served by a catalog provider (docs/schemas/catalog-source.schema.json). */
export const catalogSourceManifestSchema = z.object({
  manifestVersion: z.literal(CATALOG_MANIFEST_VERSION),
  providerId: z.string().min(3).max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  homepage: urlSchema.optional(),
  attribution: z.object({
    name: z.string().min(1).max(120),
    url: urlSchema,
  }),
  transport: z.object({
    // HTTPS-only is enforced by the restricted fetch layer, not just here.
    baseUrl: urlSchema,
  }),
  query: z.object({
    supported: z.array(z.enum(CATALOG_QUERY_PARAMS)).min(1).max(CATALOG_QUERY_PARAMS.length),
  }),
}).strict()

/** Fields shared by provider-page items and normalized snapshot entries. */
const catalogEntryFields = {
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  package: z.string().min(1).max(214).regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/),
  version: z.string().min(1).max(64),
  category: z.string().max(64).optional(),
  capability: z.array(z.string().min(1).max(64)).max(32).optional(),
  homepage: urlSchema.optional(),
  license: z.string().max(64).optional(),
} as const

/** A catalog provider page (docs/schemas/catalog-provider-page.schema.json). */
export const catalogProviderPageSchema = z.object({
  items: z.array(z.object(catalogEntryFields).strict()).max(200),
  nextCursor: z.string().max(256).optional(),
}).strict()
