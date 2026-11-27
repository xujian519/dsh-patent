/**
 * Service Definition for the knowledge.db query seam (ctx.patentKnowledge):
 * case-law full-text search, legal full-text search, wiki-card keyword lookup,
 * IPC classification, and knowledge-graph queries over node:sqlite, plus the
 * patent-knowledge:install data bootstrap (exported, never auto-run).
 *
 * The service owns no model-facing surface; consumers own tool schemas and
 * result rendering. All engines open the resolved knowledge.db read-only and
 * fail loud (KnowledgeDbVersionError) when the database is absent or its
 * version does not match.
 * @module @deepseek-ai/dsh-patent-knowledge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveKnowledgePaths } from './config.ts'
import { CaseLawSearchEngine } from './case-law/case-law-search.ts'
import { KnowledgeLawSearch } from './legal/knowledge-law-search.ts'
import { WikiCardLoader } from './patent/wiki-card-loader.ts'
import { classifyIpc, queryByArticle, queryIpcStandards, searchStandards } from '@deepseek-ai/dsh-patent-core'
import { KgStore } from './shared/kg-store.ts'
import { PatentKgAdapter } from './patent/patent-kg-adapter.ts'
import { readCorpusInfo } from './shared/corpus-info.ts'
import type { Config, CorpusInfo, KnowledgePaths } from './types.ts'
import { DEFAULT_NODE_CACHE_MAX_ENTRIES } from './shared/kg-store.ts'
import type { CaseLawHit, CaseLawSearchOptions } from './case-law/types.ts'
import type { LawSearchResult } from './legal/types.ts'
import type { KnowledgeLawSearchOptions } from './legal/knowledge-law-search.ts'
import type { WikiCardMeta } from './patent/wiki-card-loader.ts'
import type { IpcClassification, IpcStandardCard } from '@deepseek-ai/dsh-patent-core'
import type { KgNode } from './patent/types.ts'
import type { PatentKgSearchOptions, RelevantHit } from './patent/patent-kg-adapter.ts'

// Data-bootstrap command (exported; the bin wraps it; it never runs on load).
export { installKnowledgeDb } from './install.ts'

// Path/config surface.
export { DEFAULT_KNOWLEDGE_DIR, DEFAULT_SOURCE_DB_PATH, resolveKnowledgePaths } from './config.ts'
export type { Config, CorpusInfo, InstallKnowledgeDbOptions, InstallResult, KnowledgePaths } from './types.ts'

// Database open protocol and schema versions.
export { KnowledgeDbVersionError, openKnowledgeDb } from './shared/db-version.ts'
export type { KnowledgeDbKind, OpenKnowledgeDbOptions, OpenKnowledgeDbResult, OpenKnowledgeDbSpec } from './shared/db-version.ts'
export { KNOWLEDGE_DB, LAWS_DB, VECTORS_DB } from './shared/schema-versions.ts'

// Shared query helpers.
export { FTS_MIN_RUNES, escapeFtsPhrase, joinFtsOrTerms, sqliteHasFts5 } from './shared/fts.ts'
export { MIN_COMPRESS_CHARS, compressChunk, compressIfSmaller, decompressChunk, registerChunkUncompress, shouldCompress } from './shared/chunk-compression.ts'
export { KnowledgeRuntimeStats } from './shared/knowledge-stats.ts'
export type { KnowledgeRuntimeStatsSnapshot } from './shared/knowledge-stats.ts'

// Case-law surface.
export { CaseLawSearchEngine } from './case-law/case-law-search.ts'
export type { CaseLawSearchEngineOptions } from './case-law/case-law-search.ts'
export type { CaseLawChunk, CaseLawDocType, CaseLawHit, CaseLawRecord, CaseLawSearchOptions } from './case-law/types.ts'

// Legal surface.
export { KnowledgeLawSearch } from './legal/knowledge-law-search.ts'
export {
  KNOWLEDGE_DOC_TYPES,
  type KnowledgeDocType,
} from './legal/knowledge-law-search.ts'
export type { KnowledgeLawSearchEngineOptions, KnowledgeLawSearchOptions } from './legal/knowledge-law-search.ts'
export { extractLawKeywords } from './legal/keywords.ts'
export { toRecord, toSearchResult } from './legal/row-mapper.ts'
export type { LawRow } from './legal/row-mapper.ts'
export type { LawCategory, LawLevel, LawRecord, LawSearchResult, LegalSearchSource } from './legal/types.ts'
export { isLawVisible, resolveAsOf, resolveLawValidity, todayIsoDate } from './legal/validity.ts'
export type { LawValidity, LawValidityInput } from './legal/validity.ts'

// Knowledge-graph surface.
export { KgStore } from './shared/kg-store.ts'
export type { KgSearchOptions } from './shared/kg-store.ts'
export { GraphTraversal } from './shared/kg/graph-traversal.ts'
export type { KgNeighbor } from './shared/kg/graph-traversal.ts'
export { introspectKgStore } from './shared/kg/schema-introspector.ts'
export type { KgSchema, KgStoreIntrospection, KgStoreStatements } from './shared/kg/schema-introspector.ts'
export { parseLawRefsCount, toNode } from './shared/kg/row-mapper.ts'
export type { FtsHit, NodeRow } from './shared/kg/row-mapper.ts'
export { PatentKgAdapter, resolveNodeTypes } from './patent/patent-kg-adapter.ts'
export type { PatentKgSearchOptions, RelevantHit } from './patent/patent-kg-adapter.ts'

// Patent IPC / wiki surface.
export { WikiCardLoader } from './patent/wiki-card-loader.ts'
export type { WikiCardContent, WikiCardLoaderOptions, WikiCardMeta } from './patent/wiki-card-loader.ts'
export {
  DEFAULT_IPC_CONFIDENCE,
  DEFAULT_IPC_SECTION,
  HIGH_CONFIDENCE_THRESHOLD,
  IPC_DETAIL_DOMAINS,
  IPC_DETAIL_MIN_CONFIDENCE,
  IPC_DOMAINS,
  classifyIpc,
  classifyIpcTop,
  getIpcDomain,
  isHighConfidence,
} from '@deepseek-ai/dsh-patent-core'
export type { IpcDetailDomainMeta, IpcDomainMeta } from '@deepseek-ai/dsh-patent-core'
export {
  formatStandardsAsContext,
  loadIpcStandards,
  queryByArticle,
  queryIpcDetail,
  queryIpcStandards,
  searchStandards,
} from '@deepseek-ai/dsh-patent-core'
export type { IpcStandardsIndex } from '@deepseek-ai/dsh-patent-core'
export type { IpcClassification, IpcStandardCard } from '@deepseek-ai/dsh-patent-core'
export type { KgEdge, KgNode, KgNodeType } from './patent/types.ts'

/**
 * PatentKnowledge service: the knowledge.db query seam (ctx.patentKnowledge).
 * It lazily opens the resolved knowledge.db read-only and delegates to the
 * ported engines; the engines close when the owning fiber unloads. `ipcClassify`
 * and the `ipcStandards*` lookups read the shipped classification and standard
 * tables instead of the database, and serve plugins that hold only the service
 * reference; code with a package import uses the same-named pure exports.
 */
export class PatentKnowledge extends Service {
  /** Schema validates field types and bounds; {@link resolveKnowledgePaths} materializes every default once. */
  static Config: z<Config> = z.object({
    knowledgeDir: z.string(),
    sourceDbPath: z.string(),
    nodeCacheMaxEntries: z.number().min(1),
  })

  /** Resolved on-disk paths (query db, wiki dir, install source). */
  readonly paths: KnowledgePaths

  /** Resolved node-cache bound (Config `nodeCacheMaxEntries`). */
  private readonly nodeCacheMaxEntries: number

  private caseLawEngine?: CaseLawSearchEngine | undefined
  private lawEngine?: KnowledgeLawSearch | undefined
  private guidelineEngine?: KnowledgeLawSearch | undefined
  private kg?: KgStore | undefined
  private readonly wiki: WikiCardLoader

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'patentKnowledge')
    this.paths = resolveKnowledgePaths(config)
    this.nodeCacheMaxEntries = config.nodeCacheMaxEntries ?? DEFAULT_NODE_CACHE_MAX_ENTRIES
    this.wiki = new WikiCardLoader(this.paths.wikiDir)
    this.ctx.effect(() => () => { this.close() }, 'patent-knowledge: engines')
  }

  /**
   * Case-law full-text search over documents/chunks/docs_fts (FTS5 BM25 first,
   * LIKE fallback for short queries or a missing FTS index).
   * @param query - the search text.
   * @param options - result cap and doc_type/court/excludeSource filters.
   * @returns the de-duplicated hits in rank order.
   */
  caseLawSearch(query: string, options?: CaseLawSearchOptions): CaseLawHit[] {
    return this.caseLaw().search(query, options)
  }

  /**
   * Legal full-text search over the law_article documents of knowledge.db.
   * @param query - the search text.
   * @param options - result cap, level filter, and point-in-time validity (`asOf`, `includeUnverified`).
   * @returns the de-duplicated hits in rank order.
   */
  legalSearch(query: string, options?: KnowledgeLawSearchOptions): LawSearchResult[] {
    return this.law().search(query, options)
  }

  /**
   * Guideline full-text search over the guideline_rule documents of knowledge.db
   * (the 《专利审查指南》 chapters). Same engine and options as the law search,
   * scoped to that document type.
   * @param query - the search text.
   * @param options - result cap, level filter, and point-in-time validity (`asOf`, `includeUnverified`).
   * @returns the de-duplicated hits in rank order, each with its `filename` (file_path) for citation.
   */
  guidelineSearch(query: string, options?: KnowledgeLawSearchOptions): LawSearchResult[] {
    return this.guideline().search(query, options)
  }

  /**
   * Read the resolved corpus's freshness and size (upstream index build time,
   * schema version, document/chunk counts, local copy time).
   * @returns the corpus facts; fields the database does not record are omitted.
   */
  corpusInfo(): CorpusInfo {
    return readCorpusInfo(this.paths.queryDbPath)
  }

  /**
   * Keyword lookup over the wiki-card directory (title/concept/domain).
   * @param query - the keyword.
   * @param limit - result cap.
   * @returns matching card metadata.
   */
  wikiCards(query: string, limit: number = 10): WikiCardMeta[] {
    return this.wiki.search(query, limit)
  }

  /**
   * Wiki-card lookup under one directory prefix. An empty keyword lists the
   * prefix, which serves directory browsing.
   * @param prefix - directory prefix relative to the wiki root; empty searches all.
   * @param keyword - the keyword; empty lists the prefix.
   * @param limit - result cap.
   * @returns matching card metadata.
   */
  wikiCardsIn(prefix: string, keyword: string, limit: number = 10): WikiCardMeta[] {
    return this.wiki.searchIn(prefix, keyword, limit)
  }

  /**
   * Render one wiki card's body fragment for model context.
   * @param id - card id (relative path without `.md`).
   * @param maxChars - body cap before truncation.
   * @returns the rendered fragment, or an empty string when the card is absent.
   */
  wikiContext(id: string, maxChars: number = 1200): string {
    return this.wiki.formatAsContext(id, maxChars)
  }

  /**
   * IPC classification of a patent-domain text.
   * @param text - the patent-domain text to classify.
   * @returns classification results in confidence order.
   */
  ipcClassify(text: string): IpcClassification[] {
    return classifyIpc(text)
  }

  /**
   * Knowledge-graph keyword search with relation expansion.
   * @param query - the keyword.
   * @param options - keyword/expand limits and phrase-or-OR match mode.
   * @returns keyword hits plus expanded neighbors.
   */
  kgSearch(query: string, options?: PatentKgSearchOptions): RelevantHit[] {
    return this.kgAdapter().searchRelevant(query, options)
  }

  /**
   * Knowledge-graph node lookup by id.
   * @param id - the node id.
   * @returns the node, or undefined when absent.
   */
  kgGetNode(id: string): KgNode | undefined {
    return this.kgStore().getNode(id)
  }

  /**
   * Knowledge-graph nodes by type.
   * @param nodeType - the node type to list.
   * @param limit - result cap.
   * @returns the matching nodes.
   */
  kgListByType(nodeType: string, limit: number = 50): KgNode[] {
    return this.kgStore().listByType(nodeType, limit)
  }

  /**
   * Knowledge-graph similar nodes of one node (similarity relations).
   * @param id - the node id.
   * @param limit - result cap.
   * @returns the neighbor nodes with their relation.
   */
  kgSimilarNodes(id: string, limit: number = 10): Array<{ node: KgNode; relation: string }> {
    return this.kgAdapter().getSimilarNodes(id, limit)
  }

  /**
   * Knowledge-graph outgoing neighbors of one node.
   * @param id - the node id.
   * @param relation - optional relation filter.
   * @param limit - result cap.
   * @returns the outgoing neighbors.
   */
  kgNeighbors(id: string, relation?: string, limit: number = 20): Array<{ targetId: string; relation: string }> {
    return this.kgAdapter().getNeighbors(id, relation, limit)
  }

  /**
   * IPC examination-standard cards for one section.
   * @param section - the IPC section (A-H).
   * @returns the matching cards.
   */
  ipcStandards(section: string): IpcStandardCard[] {
    return queryIpcStandards(section)
  }

  /**
   * IPC examination-standard cards for one law article.
   * @param article - the law article id (e.g. patent-law-a22.3).
   * @returns the matching cards.
   */
  ipcStandardsByArticle(article: string): IpcStandardCard[] {
    return queryByArticle(article)
  }

  /**
   * Keyword search over the shipped IPC examination-standard cards.
   * @param keyword - the search keyword.
   * @param limit - result cap.
   * @returns the matching cards.
   */
  ipcStandardsSearch(keyword: string, limit: number = 10): IpcStandardCard[] {
    return searchStandards(keyword, limit)
  }

  /** Lazy case-law engine (opens the resolved db read-only, fail-loud). */
  private caseLaw(): CaseLawSearchEngine {
    return (this.caseLawEngine ??= new CaseLawSearchEngine(this.paths.queryDbPath))
  }

  /** Lazy legal engine over knowledge.db law_article documents. */
  private law(): KnowledgeLawSearch {
    return (this.lawEngine ??= new KnowledgeLawSearch(this.paths.queryDbPath))
  }

  /** Lazy guideline engine over knowledge.db guideline_rule documents (审查指南全文). */
  private guideline(): KnowledgeLawSearch {
    return (this.guidelineEngine ??= new KnowledgeLawSearch(this.paths.queryDbPath, { docTypes: ['guideline_rule'] }))
  }

  /** Lazy knowledge-graph store. */
  private kgStore(): KgStore {
    return (this.kg ??= new KgStore(this.paths.queryDbPath, { nodeCacheMaxEntries: this.nodeCacheMaxEntries }))
  }

  /** Lazy knowledge-graph adapter over the store. */
  private kgAdapter(): PatentKgAdapter {
    return new PatentKgAdapter(this.kgStore())
  }

  /** Close every opened engine handle. */
  private close(): void {
    this.caseLawEngine?.close()
    this.caseLawEngine = undefined
    this.lawEngine?.close()
    this.lawEngine = undefined
    this.guidelineEngine?.close()
    this.guidelineEngine = undefined
    this.kg?.close()
    this.kg = undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    patentKnowledge: PatentKnowledge
  }
}

export default PatentKnowledge
