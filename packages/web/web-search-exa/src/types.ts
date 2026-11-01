/**
 * Wire types for the Exa search API (`POST https://api.exa.ai/search`). Types
 * only — no runtime code. Exa returns a flat `results[]`; each entry carries a
 * URL, optional title, optional `publishedDate`, and (when highlights are
 * requested) a `highlights[]` array of salient sentences.
 *
 * @module @deepseek-ai/dsh-web-search-exa/types
 */

/** One entry of Exa's flat `results[]`. */
export interface ExaResult {
  url: string
  title?: string | null
  publishedDate?: string | null
  highlights?: string[]
}

/** Exa's search response envelope. */
export interface ExaSearchResponse {
  results?: ExaResult[]
}

/** Exa's error response envelope (best-effort; fields vary by failure). */
export interface ExaError {
  error?: string
  message?: string
}
