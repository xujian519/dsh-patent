/**
 * Type declarations for the knowledge.db query seam: deployment-varying
 * configuration, the install bootstrap options/result, and the resolved
 * on-disk paths.
 * @module @deepseek-ai/dsh-patent-knowledge/types
 */

/** Deployment-varying knowledge configuration. */
export interface Config {
  /**
   * Data directory for the trimmed query database and wiki cards. Defaults to
   * ~/.dsh/knowledge.
   */
  knowledgeDir?: string
  /**
   * Path to the source knowledge.db for the install command (and the read-only
   * direct-use fallback). Defaults to ~/.sati/knowledge/knowledge.db.
   */
  sourceDbPath?: string
  /**
   * Upper bound on cached knowledge-graph nodes, least-recently-used eviction.
   * A session that walks the graph can touch unbounded distinct node ids, so
   * the cache is bounded; raise it when a deployment queries wide subgraphs
   * repeatedly. Defaults to 1024.
   */
  nodeCacheMaxEntries?: number
}

/** Options for the patent-knowledge:install data bootstrap. */
export interface InstallKnowledgeDbOptions {
  /** Source database to trim. Defaults to the configured sourceDbPath. */
  sourceDbPath?: string | undefined
  /** Destination data directory. Defaults to the configured knowledgeDir. */
  knowledgeDir?: string | undefined
  /** Explicit output path. Defaults to <knowledgeDir>/knowledge-lite.db. */
  output?: string | undefined
  /** Compress chunks.content long bodies to gzip BLOBs (default true). */
  compressChunks?: boolean
  /** Keep the embeddings tables (default false: drop them, per P0.4). */
  keepEmbeddings?: boolean
  /** Drop the FTS5 indexes, degrading full-text search to LIKE (default false). */
  noFts?: boolean
  /** Skip the post-trim component verification (default false). */
  skipVerify?: boolean
  /**
   * Build `documents.search_prefix` (the first `searchPrefixChars` code points
   * of each document's longest chunk) so case-law short queries scan a compact
   * plaintext column instead of decompressing every chunk (default false).
   * Enabling it bounds case-law recall to those prefixes; the default keeps
   * full-body matching. Skipped when the source lacks `documents.id` or
   * `chunks(document_id, char_count)`; a column inherited from the source is
   * dropped when this is false.
   */
  searchPrefix?: boolean | undefined
  /** `search_prefix` length in code points (default 512, range 64–2048). */
  searchPrefixChars?: number | undefined
  /** Progress/log sink. Defaults to console.log. */
  log?: ((line: string) => void) | undefined
}

/** Result of one install run. */
export interface InstallResult {
  /** Source database path. */
  input: string
  /** Trimmed database path. */
  output: string
  /** Source size in bytes. */
  inputBytes: number
  /** Trimmed size in bytes. */
  outputBytes: number
  /** Dropped tables. */
  dropped: string[]
  /** Number of chunks compressed (0 when compression was disabled). */
  compressedChunks: number
}

/**
 * 本地知识库的语料新鲜度与规模。
 *
 * `lastIndexedAt` 是上游管线构建该索引的时间（`index_meta.last_indexed_at`），
 * `fileModifiedAt` 是本机这份副本的写入时间（安装/重建），两者不可互相替代：
 * 索引可能在几个月前构建、本周才装到本机。
 */
export interface CorpusInfo {
  /** 实际查询的数据库路径。 */
  dbPath: string
  /** 上游索引构建时间（ISO-8601）；源库未记录时省略。 */
  lastIndexedAt?: string
  /** 最新 version_history.version；库未记录时省略。 */
  version?: number
  /** 最新 version_history.created_at；库未记录时省略。 */
  versionCreatedAt?: string
  /** 文档数（index_meta 或最新 version_history 记录）；库未记录时省略。 */
  documents?: number
  /** 分块数（index_meta 或最新 version_history 记录）；库未记录时省略。 */
  chunks?: number
  /** 本机副本的修改时间（ISO-8601）。 */
  fileModifiedAt: string
}

/** Resolved on-disk knowledge paths. */
export interface KnowledgePaths {
  /** Data directory (the configured knowledgeDir). */
  dataDir: string
  /** Database the query engines open (fail-loud when absent). */
  queryDbPath: string
  /** Wiki-card directory (keyword table lookup only; no vector index in P1). */
  wikiDir: string
  /** Source database path used by the install command. */
  sourceDbPath: string
}
