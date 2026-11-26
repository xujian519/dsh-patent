---
kind: upgrade-guide
description: "Retrieval tools report retrieval time, cache state, and consulted channels; patent_search rows are lean unless abstracts are requested."
---

# Retrieval tools state when and from where their facts came

English | [中文](guide.zh.md)

## Change

`patent_search` and `patent_metadata` now return `retrievedAt` (the serving channel's fetch time, which stays the original fetch time on a cache hit) and `cached`, and every retrieval tool returns `channelsConsulted` — one entry per channel with `served`, `empty`, `failed`, or `skipped` and the reason. `patent_legal_status` returns `retrievedAt` and `channelsConsulted`; `patent_pdf_download` returns `retrievedAt` per downloaded item (the manifest time for resumed files).

`patent_search` rows are lean by default: the `abstract` field is empty unless the call passes `includeAbstract: true`. A 50-hit page therefore carries no abstracts.

`law_search` and `patent_case_search` return a `corpus` block with the upstream index build time (`lastIndexedAt`), schema `version`, document/chunk counts, and the local copy's `fileModifiedAt`. A new `patent_corpus_status` tool reports the same facts without running a query, so `@deepseek-ai/dsh-patent-tools` registers 38 tools.

`patent-knowledge:install` keeps `index_meta` (it records the corpus build time and size) and drops only `embeddings` and `ivf_index`.

Affected: callers that read abstracts from `patent_search` without `includeAbstract`, recorded tool schemas that embed the changed parameter and output fields, anyone asserting the patent-tools tool count, and knowledge-lite databases built by an earlier install.

## Migration

1. Pass `includeAbstract: true` to `patent_search` wherever the abstract is needed to triage hits; omitting it now returns lean rows.
2. Refresh recorded tool schemas with no key: `pnpm run test:snapshot:refresh` rewrites each scenario's expected outputs, including `tool-schemas.expected.json`.
3. Re-run `patent-knowledge-install` to rebuild `knowledge-lite.db` with `index_meta`; until then `patent_corpus_status` falls back to `version_history` or the file modification time and omits `lastIndexedAt`.
4. Confirm: a `patent_search` result names its channel set and retrieval time, and `patent_corpus_status` reports `lastIndexedAt` after the reinstall.
