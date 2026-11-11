# Agent Note: Knowledge-database query core moves to dsh-knowledge-core

Status: implemented

English | [中文](2026-11-11-knowledge-core-shared-query-home.zh.md)

## Problem

The legal knowledge base and the patent knowledge base are separate engines over separate data, but they shared their retrieval mechanics: the FTS5 text preparation, the FTS-to-LIKE degradation ladder, the long-query keyword split, the result-cap normalization, the statute validity rule, and the install-time file operations. Those mechanics lived in `@deepseek-ai/dsh-patent-core`, so `packages/legal/legal-knowledge/package.json` declared `@deepseek-ai/dsh-patent-core` in `dependencies` and imported twelve symbols from it — functions that carry no patent meaning. A legal-domain release therefore followed the patent core package's release mechanics, and every patent-internal change was part of the legal knowledge base's dependency surface.

D19 aligned the two entry points on the shared cleaning and capping rules but kept the dependency, because moving the shared code into a neutral home is a structural change that needs its own decision. D20 is that change.

## Decision

**The shared retrieval mechanics get a domain-neutral home.** New package `@deepseek-ai/dsh-knowledge-core` (`packages/law/knowledge-core`) owns the six modules moved out of `patent-core/src/knowledge/` — FTS5 helpers, the search ladder, keyword splitting, result-cap normalization, the statute validity rule, and the install file operations — plus `resolveRealPath`, which moves out of `patent-core/src/paths.ts` so the moved modules have no inward dependency left.

**patent-core re-exports the moved surface.** Every symbol patent-core previously exported from the moved modules is re-exported from `@deepseek-ai/dsh-knowledge-core`, so the patent domain keeps one import surface and existing consumers (`patent-tools`) need no source change. The exported names are unchanged: the export list before and after the move is the same 578 names.

**Both knowledge packages consume the neutral package directly.** `legal-knowledge` and `patent-knowledge` import from `@deepseek-ai/dsh-knowledge-core`; `legal-knowledge`'s `dependencies` drop `@deepseek-ai/dsh-patent-core` entirely. The legal domain no longer depends on any patent package.

**The engines stay per domain.** Each engine keeps its own tables, filters, row mapping, messages, and backends. The patent side searches chunked documents, a knowledge graph, and wiki entries; the legal side searches four record kinds with an in-memory fallback. Merging them would require one table layout and one filter set, which the two corpora do not share.

## Alternatives considered

- **Keep the mechanics in patent-core and accept the dependency.** Rejected: it is the same boundary inversion that `dsh-law-core` removed for the citation rule in November 2026.
- **Move the mechanics into the legal domain.** Inverts the asymmetry instead of removing it; the patent domain would inherit the same problem.
- **Merge the two retrieval engines.** Rejected by the D19 query-behavior comparison: the two sides differ in tables, filter columns, hit fields, backends, and default result caps.
- **Extend `dsh-law-core` instead of adding a package.** Rejected: `law-core` is the statute-citation library, and the retrieval mechanics are a second concern with a different consumer set. A separate package keeps each one's contract readable.
- **Move only the query core and leave the install helpers in patent-core.** Rejected: `legal-knowledge/src/install.ts` imports five install helpers from patent-core, so the legal domain would keep the dependency and R-10 would stay open.

## Consequences

- `legal-knowledge` references `@deepseek-ai/dsh-patent-core` zero times, in source and in tests; the dependency is gone from its `package.json`.
- The `law/` package group now carries two domain-neutral libraries: statute citations (`dsh-law-core`) and knowledge-database retrieval (`dsh-knowledge-core`).
- The unit tests move with the modules into `packages/law/knowledge-core/tests/`. The new package's `src/**` is at 100% statement, branch, and function coverage.
- `resolveRealPath` is now a shared rule rather than a patent-domain path helper; the patent-domain containment check `resolveConfinedPath` stays in `patent-core/src/paths.ts` and imports it.
- The new package joins the Python SDK runtime closure, so the shipped `dsh` executable resolves the shared mechanics from the neutral package.
- A future knowledge-database domain imports `dsh-knowledge-core` and never a patent package.
