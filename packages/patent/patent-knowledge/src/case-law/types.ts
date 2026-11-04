/**
 * Case-law full-text search contract.
 *
 * The data source is the external knowledge.db (documents/chunks/docs_fts
 * tables): documents holds case metadata (doc_type=case invalidation decisions /
 * judgment patent rulings), chunks holds the full-text fragments (docs_fts rowid
 * equals chunks.id, so a contentless FTS table must JOIN chunks for the body).
 * @module @deepseek-ai/dsh-patent-knowledge/case-law/types
 */

/** Case-law document kind: case=invalidation decision, judgment=patent ruling. */
export type CaseLawDocType = 'case' | 'judgment'

/** Case-law metadata (one documents row). */
export type CaseLawRecord = {
  documentId: string
  docType: string
  title: string
  /** Invalidation decision number (e.g. 566693); usually present only on case rows. */
  decisionNumber?: string | undefined
  /** Case number (e.g. 008073341); usually present only on case rows. */
  caseNumber?: string | undefined
  /** Adjudicating court; usually present only on judgment rows. */
  court?: string | undefined
  source?: string | undefined
  module?: string | undefined
  charCount: number
}

/** One case-law hit with its matched fragment and the path that produced it. */
export type CaseLawHit = CaseLawRecord & {
  chunkIndex: number
  /** Matched chunk body fragment (the tool layer truncates). */
  snippet: string
  /** FTS5 BM25 score (negative; lower is more relevant; only on the fts path). */
  ftsRank?: number | null
  /** Hit path: fts=FTS5 BM25 match, like=LIKE degraded match. */
  via: 'fts' | 'like'
}

/** One case-law full-text fragment (fetched by documents.id, outside search). */
export type CaseLawChunk = {
  documentId: string
  chunkIndex: number
  /** Fragment body. */
  content: string
}

/** Case-law search request options. */
export type CaseLawSearchOptions = {
  /**
   * Result cap (default 5, engine maximum 50). A fractional value is truncated
   * and a non-finite value falls back to the default rather than reaching SQLite.
   */
  limit?: number
  /** Filter by document kind. */
  docType?: CaseLawDocType
  /** Filter by court substring (judgment rows). */
  court?: string
  /** Exclude documents from one source (e.g. "wiki" to keep only raw rulings). */
  excludeSource?: string
}
