# 法律（Legal）

[English](legal.md) | 中文

法律子系统沿用专利域使用的 harness 接缝来承载法律域能力：`@deepseek-ai/dsh-legal-knowledge` 提供 `ctx.legalKnowledge` 查询服务，覆盖案例、法规、司法解释与指导案例（SQLite FTS5，并以内存检索降级）；`@deepseek-ai/dsh-legal-law`、`@deepseek-ai/dsh-legal-evidence` 与可选的 `@deepseek-ai/dsh-legal-knowledge/tool` 插件分别注册面向模型的 `legal_law_verify`、`evaluate_legal_evidence` 与 `legal_knowledge_search` 工具。这些包位于 [packages/legal](../../packages/legal/README.zh.md)；[legal preset](../../packages/bundle/web-app/presets/legal.patch.yml) 把它们与法律文书交付工具一起挂载。

法条索引与证据规则都作为包资产随包分发，因此尚未转录条文的部署会报 `未核验`，而不是放行该引用；缺失的证据字段按未回答处理，而不是推断。两个工具都不调用模型：引用判定与证据评分都是确定性的，并且可以从收到的记录重建。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlegalknowledge--legalknowledge"></a>

### `ctx.legalKnowledge` — `LegalKnowledge`

LegalKnowledge service: the legal knowledge-base query seam (ctx.legalKnowledge).

Lazily initializes search engines for case-law, legal regulations, and judicial interpretations. When useFts5 is true (default) and a database is available at the resolved query path, engines use SQLite FTS5 full-text search with BM25 ranking and LIKE fallback; otherwise they use in-memory keyword matching populated via addRecords().

```ts cordis-catalog
/**
 * Case-law full-text search (SQLite FTS5 with LIKE fallback, or in-memory).
 * NUL is removed before matching. An empty remainder returns no hits.
 * An omitted or non-finite cap uses 5. Any other cap is an integer in `[1, 50]`.
 * @param query - the search text.
 * @param options - result cap, docType, court, and caseType filters.
 * @returns matching hits sorted by relevance.
 */
caseLawSearch(query: string, options?: CaseLawSearchOptions): CaseLawHit[]

/**
 * Legal regulation full-text search (SQLite FTS5 with LIKE fallback, or in-memory).
 * NUL is removed before matching. An empty remainder returns no hits.
 * An omitted or non-finite cap uses 10. Any other cap is an integer of at least 1.
 * @param query - the search text.
 * @param options - result cap, level filter, and validity options.
 * @returns matching hits sorted by relevance.
 */
legalSearch(query: string, options?: LegalSearchOptions): LegalRegulationHit[]

/**
 * Judicial interpretation full-text search (SQLite FTS5 with LIKE fallback, or in-memory).
 * NUL is removed before matching. An empty remainder returns no hits.
 * An omitted or non-finite cap uses 10. Any other cap is an integer of at least 1.
 * @param query - the search text.
 * @param options - result cap, type filter, and validity options.
 * @returns matching hits sorted by relevance.
 */
judicialInterpretationSearch( query: string, options?: JudicialInterpretationSearchOptions, ): JudicialInterpretationHit[]

/**
 * Guiding case search (SQLite LIKE or in-memory keyword matching).
 * NUL is removed before matching. An empty remainder returns no hits.
 * An omitted or non-finite cap uses 10. Any other cap is an integer of at least 1.
 * @param query - the search text.
 * @param limit - result cap.
 * @returns matching guiding case hits sorted by relevance.
 */
guidingCaseSearch(query: string, limit?: number): GuidingCaseHit[]

/**
 * Add case-law records to the in-memory store.
 * Only effective when the engine is not using a SQLite database.
 * @param records - records to add.
 */
addCaseLawRecords(records: CaseLawRecord[]): void

/**
 * Add legal regulation records to the in-memory store.
 * Only effective when the engine is not using a SQLite database.
 * @param records - records to add.
 */
addLegalRegulationRecords(records: LegalRegulationRecord[]): void

/**
 * Add judicial interpretation records to the in-memory store.
 * Only effective when the engine is not using a SQLite database.
 * @param records - records to add.
 */
addJudicialInterpretationRecords(records: JudicialInterpretationRecord[]): void

/**
 * Add guiding case records to the in-memory store.
 * Only effective when the engine is not using a SQLite database.
 * @param records - records to add.
 */
addGuidingCaseRecords(records: GuidingCaseRecord[]): void
```

Source: [`packages/legal/legal-knowledge/src/index.ts`](../../packages/legal/legal-knowledge/src/index.ts)
<!-- END GENERATED cordis-surface -->
