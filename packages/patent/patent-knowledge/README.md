---
description: "Service Definition for the knowledge.db query seam (`ctx.patentKnowledge`): case-law full-text search, legal full-text search, wiki-card keyword lookup, IPC classification, and knowledge-graph queries over `node:sqlite`, plus the `patent-knowledge:install` data bootstrap ported from Sati. Consumers own every model-facing surface; this package resolves and serves read-only knowledge queries."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-knowledge

English | [中文](README.zh.md)

## Summary

Service Definition for the knowledge.db query seam (`ctx.patentKnowledge`): case-law full-text search, legal full-text search, wiki-card keyword lookup, IPC classification, and knowledge-graph queries over `node:sqlite`, plus the `patent-knowledge:install` data bootstrap ported from Sati. Consumers own every model-facing surface; this package resolves and serves read-only knowledge queries.

## Table of Contents

- [Service](#service)
- [Configuration](#configuration)
- [patent-knowledge:install](#patent-knowledgeinstall)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Service

The `PatentKnowledge` service opens the resolved `knowledge.db` read-only (fail-loud via `KnowledgeDbVersionError` on a missing or version-mismatched database) and delegates to the ported engines. Engines are opened lazily and closed when the owning fiber unloads.

### caseLawSearch(query, options?)

Full-text search over the `documents`/`chunks`/`docs_fts` tables (FTS5 BM25 first, LIKE fallback for short queries, a missing FTS index, or an FTS error). A 3+ rune query that the trigram index answers with no hits returns nothing instead of scanning every chunk through LIKE. Returns `CaseLawHit[]`; options filter by `docType`, `court`, and `excludeSource`. When `documents.search_prefix` exists (written by install with `--search-prefix`), the LIKE fallback scans each document's title and plaintext prefix instead of decompressing every chunk; a database without that column keeps the full decompression path for those queries.

### legalSearch(query, options?)

Full-text search over the `law_article` documents of `knowledge.db` via `KnowledgeLawSearch`. Returns `LawSearchResult[]`; options filter by `level` and by point-in-time validity (`asOf`, plus `includeUnverified`). Each hit carries `filename` — the document's `file_path` — as the citation's source, and `validity` (`in-force` / `expired` / `not-yet-effective` / `unverified`) computed from nullable `valid_from` / `valid_to` / `expired` columns. Expired and not-yet-effective rows are not returned. A row with no time columns is `unverified` and is returned by default, rather than being silently reported as in force; `includeUnverified: false` excludes it. `installKnowledgeDb` adds the nullable `valid_from`, `valid_to`, and `validity_source` columns to its output database without writing an in-force default; existing rows stay `unverified` until a deployment backfills them.

### guidelineSearch(query, options?)

Full-text search over the `guideline_rule` documents of `knowledge.db` (the 《专利审查指南》 chapters), through a second `KnowledgeLawSearch` scoped with `docTypes: ['guideline_rule']`. The engine indexes whichever normative document types it is constructed with (`law_article` by default), so the statute corpus and the guideline corpus stay separate while sharing one query path; a database whose `documents` table predates the `file_path` column still searches, and then reports no source path.

### wikiCards(query, limit?) / wikiCardsIn(prefix, keyword, limit?)

Keyword lookup over the wiki-card directory (title/concept/domain), either across every directory or under one prefix; in the prefix form an empty keyword lists that directory. Keyword-only in P1: the semantic/vector wiki index is deferred, so an absent wiki directory degrades to an empty result.

### wikiContext(id, maxChars?)

Renders one card's body fragment for model context, truncated at `maxChars`, or an empty string when the card is absent.

### ipcClassify(text)

IPC classification of a patent-domain text via the ported keyword classifier. Returns `IpcClassification[]` in confidence order.

### kgSearch / kgGetNode / kgListByType / kgSimilarNodes / kgNeighbors

Knowledge-graph keyword search with relation expansion, node lookup by id, node listing by type, similar-node lookup, and outgoing-neighbor lookup over the `kg_nodes`/`kg_edges` tables (unified schema, with legacy `nodes`/`edges` fallback). Whole-phrase matches use the bundled trigram `kg_nodes_fts` index (which includes node content) when its row count matches `kg_nodes`; short queries and legacy unicode61 schemas fall back to LIKE, and a row-count mismatch disables the fast path.

### ipcStandards / ipcStandardsByArticle / ipcStandardsSearch

Examination-standard card queries over the shipped `ipc-standards.yaml` (by IPC section, by law article, and by keyword).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `knowledgeDir` | `~/.dsh/knowledge` | Data directory for the query database and wiki cards. |
| `sourceDbPath` | `~/.sati/knowledge/knowledge.db` | Source database for `patent-knowledge:install`, and the read-only direct-use fallback. |
| `nodeCacheMaxEntries` | `1024` | Upper bound on cached knowledge-graph nodes, least-recently-used eviction; raise it when a deployment queries wide subgraphs repeatedly. |

The query database resolves as `knowledgeDir/knowledge.db`, then `knowledgeDir/knowledge-lite.db`, then `sourceDbPath`.

## patent-knowledge:install

The install logic is an exported `installKnowledgeDb(options)` function plus the `patent-knowledge-install` bin; it never runs on plugin load. It trims the local source `knowledge.db` into `knowledgeDir/knowledge-lite.db` by vacuuming into a fresh copy, gzip-compressing `chunks.content` long bodies (readers decompress transparently), and dropping the embeddings tables. It also writes `documents.search_prefix` when you pass `--search-prefix`: the first 512 code points (configurable) of each document's longest chunk, stored as plaintext. The prefix makes two-character case-law queries scan a compact column instead of decompressing all 81K documents, at the cost of bounding recall to those prefixes; it adds about 120 MB for the bundled corpus. The default keeps full-body matching, and an install without the option drops a column inherited from a prefixed lite source. Run it once to prepare the data:

```sh
pnpm --filter @deepseek-ai/dsh-patent-knowledge exec patent-knowledge-install
# or with an explicit source database:
patent-knowledge-install --from /path/to/knowledge.db --output ~/.dsh/knowledge/knowledge-lite.db
```

Flags: `--from <path>` (source db), `--output <path>`, `--no-compress-chunks`, `--keep-embeddings`, `--no-fts`, `--search-prefix`, `--search-prefix-chars <n>` (64–2048, default 512), `--skip-verify`, `-h/--help`.

## Model Experience

None, as the knowledge seam resolves and serves read-only knowledge queries to the tool layer; dsh-patent-tools owns every model-facing schema and result.

#### KV Cache effect

Independent; the knowledge seam registers no prompt, tool schema, or result of its own.

## Known Limitations and Deferred Work

- **No vector or semantic retrieval in P1** — the embedding/vector paths (`knowledge-embeddings`, `wiki-card-vector-index`, the three memory providers) are not ported; wiki-card lookup is keyword-only, and case-law/legal/knowledge-graph search is FTS5/LIKE only.
- **Knowledge-graph index freshness is assumed** — the trigram fast path treats a row-aligned `kg_nodes_fts` as complete and skips the LIKE fallback; rebuild the index after editing node content in place.
- **Case-law LIKE fallback stops at FTS misses** — a 3+ rune query that the trigram index misses does not trigger the whole-table decompressing LIKE scan (about 4.6 s on the current corpus), so a chunk absent from `docs_fts` is reachable only through a shorter query or with `--search-prefix`; rebuild the index after installing content.
- **Case-law prefix recall is bounded when enabled** — with `--search-prefix`, the short-query LIKE path matches only the first `searchPrefixChars` code points of each document's longest chunk; matches further into the body are not returned. The default install keeps full-body matching.
- **Source database is not bundled** — the data must be prepared locally via `patent-knowledge:install` or pointed at directly through `sourceDbPath`/`knowledgeDir`; no public download is provided.
- **`node:sqlite` is experimental** — the engines run on Node's built-in SQLite, which is experimental in the supported Node line and may change between releases.

### Dev Note

None.
