---
kind: upgrade-guide
description: "Seven patent plugins make each configuration default exist once, so every defaulted field of their exported Config becomes required."
---

# Patent plugin `Config` fields with defaults become required

English | [中文](guide.zh.md)

## Change

`patent-teams`, `patent-rule`, `patent-data`, `patent-filing`, `writing-patterns`, `patent-knowledge`, and `patent-document` each applied configuration defaults twice: once in the package's `Config` schema and once again in `apply()` or a resolver. The schema is now the single source, so every field that has a default is required on the exported `Config` interface and the schema input type is `z<Partial<Config>, Config>`.

`cordis.yml` and the Loader are unaffected: those fields stay optional in configuration and are filled when the schema resolves them.

TypeScript code that builds a `Config` object or calls `apply()` with a partial literal no longer compiles. So do partial constructor calls such as `new PatentData(ctx, { maxOutputBytes: 1024 })`; use the package's `Config(...)` to fill the rest first.

`patent-knowledge` keeps its library entry: `resolveKnowledgePaths(config = {})` and `new PatentKnowledge(ctx)` still take no configuration and resolve the shipped defaults. Its schema only validates now, so `PatentKnowledge.Config({})` returns the fields as given instead of filling `knowledgeDir`, `sourceDbPath`, and `nodeCacheMaxEntries`; read `resolveKnowledgePaths()` for resolved paths.

`patent-document`'s `apply()` now always passes `outputRoot`, and the default `.dsh/documents` is the exported `DEFAULT_OUTPUT_DIR` rather than a second literal.

## Migration

1. Wrap every partial configuration in the package's schema: `apply(ctx, Config({ rulesDir }))`, `new PatentData(ctx, PatentData.Config({ maxOutputBytes: 1024 }))`.
2. Replace `PatentKnowledge.Config({})` reads of `knowledgeDir` and `sourceDbPath` with `resolveKnowledgePaths()`, and pass `nodeCacheMaxEntries` explicitly where its default (1024) was assumed.
3. Run `pnpm run typecheck`; any remaining error names a field whose default the schema now owns.
