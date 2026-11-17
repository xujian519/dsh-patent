---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-core no longer exports root-barrel names that no other package imports."
---

# Patent core drops unused root-barrel exports

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-patent-core` used to re-export internal helpers and types from its root entry, including names no other package imported. The root entry now exports a name only when a file outside `packages/patent/patent-core` imports it. Helpers such as `matchKeywordsAll`, `renderClaimStrategyReport`, `describeCitation`, and `readJsonStringArray` stay in the modules that define them and are no longer importable from the package entry. Citation and search helpers that no patent package imported are no longer re-exported from this package; import those from `@deepseek-ai/dsh-law-core` or `@deepseek-ai/dsh-knowledge-core`. `resolveResultLimit` stays on this package. The engines, registries, and tools behave as before.

Anyone importing a removed name from `@deepseek-ai/dsh-patent-core` is affected.

## Migration

1. Rebuild against `@deepseek-ai/dsh-patent-core`. A missing name was removed from `packages/patent/patent-core/src/index.ts`.
2. Import a citation or search helper that this package no longer re-exports from `@deepseek-ai/dsh-law-core` or `@deepseek-ai/dsh-knowledge-core`. Keep importing `resolveResultLimit` from this package.
3. For a helper such as `matchKeywordsAll`, `renderClaimStrategyReport`, `describeCitation`, or `readJsonStringArray`, call the exported engine or tool that already uses it (`registerBuiltinAtoms`, and the claim-chart, checker, and notice functions this package still exports). The package does not export a `./src/*` subpath.
4. Run `pnpm run verify-patent-core-exports`. A new root-barrel name needs an importer outside the package, or a comment containing `@public` on that specifier.
