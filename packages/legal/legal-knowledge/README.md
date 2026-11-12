---
description: "Legal knowledge-base query seam for the DeepSeek Harness: case-law search, legal regulation search, judicial interpretation search, and guiding case lookup over SQLite FTS5 with an in-memory fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-knowledge

English | [中文](README.zh.md)

## Summary

Legal knowledge-base query seam for the DeepSeek Harness: case-law search, legal regulation search, judicial interpretation search, and guiding case lookup over SQLite FTS5 with an in-memory fallback, plus an optional `legal_knowledge_search` tool plugin.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Query surface](#query-surface)
- [Model-facing tool](#model-facing-tool)
- [Backends](#backends)
- [Install and configuration](#install-and-configuration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

Legal research needs to search decisions, regulations, and judicial interpretations without every consumer reimplementing full-text ranking, validity filtering, and the degrade path for a deployment with no database. This package provides one Cordis service, `ctx.legalKnowledge`, over four record families, so tools and skills share one query contract and one set of result fields. The service owns no model-facing surface: consumers own tool schemas and result rendering. The optional `./tool` subpath export is the one shipped consumer, kept as a separate plugin so a deployment that only needs the service mounts no tool.

<a id="query-surface"></a>
## Query surface

`caseLawSearch` queries case-law records with caps and `docType`, `court`, and `caseType` filters; `legalSearch` queries regulations with a level filter and validity options; `judicialInterpretationSearch` queries interpretations with a type filter and validity options; `guidingCaseSearch` queries guiding cases by keyword. `addCaseLawRecords`, `addLegalRegulationRecords`, `addJudicialInterpretationRecords`, and `addGuidingCaseRecords` populate the in-memory stores and only take effect when the engine is not using a database. Hits carry the record fields, a relevance score, and the channel that produced them; validity options filter by the regulation's effective and expiry dates as of a caller-supplied date. A NUL in a query is removed before matching, and a query that is empty afterwards returns no hits. An omitted or non-finite limit uses the method default, 5 for case law and 10 otherwise; any other limit is truncated to an integer from 1 up to that method's maximum, 50 for case law and the largest safe integer otherwise.

<a id="model-facing-tool"></a>
## Model-facing tool

`@deepseek-ai/dsh-legal-knowledge/tool` is a function plugin that injects `tools` and `legalKnowledge` and registers `legal_knowledge_search`. Its `scope` selects one family: `regulation` (the default), `case_law`, `judicial_interpretation`, or `guiding_case`. The tool forwards `limit`, `asOf`, `level`, `docType`, `court`, `caseType`, and `interpretationType` to the matching service method, clamps results to 1–20, and returns the hits plus a summary. A query that is empty after NUL removal is rejected as an empty query, and NUL is removed from the query text the tool echoes. The summary states that an empty result means this deployment's knowledge base did not match, not that the source does not exist. Mount it inside the same `isolate` realm as the service; the legal preset's `legal-knowledge-index` group does that.

<a id="backends"></a>
## Backends

When a query database exists and `useFts5` is true (the default), the engines open it, probe for FTS5, and search with BM25 ranking; a query that matches nothing through FTS5 falls back to `LIKE` containment, and a database that cannot serve the query degrades to the next rung instead of failing the call. With no database, or with `useFts5: false`, the engines serve the in-memory records added at runtime. Both backends search the same columns and apply the same filters, caps, and empty-result behavior: both split a multi-term query into terms and OR them across those columns, and both treat `court` as containment and `docType`, `caseType`, `level`, and `interpretationType` as exact values. The SQLite ladder still tries a full-text phrase before its OR rung, so a query whose terms appear as one phrase can narrow that backend's result; ranking and that phrase rung are the only differences. Case-law search matches case name, full text, and summary; regulation search matches regulation name and article text; interpretation search matches interpretation name, document number, and article text; guiding cases match number, name, key points, and full text. `sqliteHasFts5`, `escapeFtsPhrase`, `joinFtsOrTerms`, `FTS_MIN_RUNES`, and `runFtsSearch` are exported for consumers that build their own queries over the same tables.

<a id="install-and-configuration"></a>
## Install and configuration

`resolveLegalKnowledgePaths` resolves `knowledgeDir` (default `~/.dsh/legal-knowledge`) and `sourceDbPath` (default `~/.dsh/legal-knowledge/legal.db`), preferring `legal.db`, then `legal-lite.db`, then the source database. `installLegalKnowledgeDb` builds the query database from the source. The service is configured by `knowledgeDir`, `sourceDbPath`, and `useFts5`; an absent default database is the pre-install state, so the service starts in memory rather than failing a read-only open of a file that was never installed.

## Known Limitations and Deferred Work

- **The databases are not shipped.** Case-law and regulation corpora are deployment data resolved from the host; a fresh deployment has no records and every query returns an empty result until `installLegalKnowledgeDb` runs against a source database or a consumer adds in-memory records.
- **The in-memory fallback is keyword matching, not ranking.** It serves what the caller added at runtime; relevance scores and filters are applied over those records, so an empty add list means an empty search regardless of what the deployment's database holds. It orders by matched-term count where SQLite orders by BM25, so the same records can arrive in a different order; the matched set, filters, caps, and empty-result behavior are shared.
- **FTS5 availability depends on the Node runtime.** SQLite is available through `node:sqlite`; a runtime without FTS5 degrades to `LIKE` containment, which finds substrings but does not rank by BM25.
- **Validity filtering is date-based.** A regulation with no recorded effective or expiry date is treated as visible; the service does not consult external amendment tables, so a superseded text can stay visible until its dates are recorded.
- **The service registers no tool by itself.** `legal_knowledge_search` lives in the separate `./tool` plugin; the service still registers no prompt section or result text, and consumers own every schema and every rendered result.

### Dev Note

None.
