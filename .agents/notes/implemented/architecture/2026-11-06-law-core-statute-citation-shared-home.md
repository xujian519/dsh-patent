# Agent Note: Statute-citation decision rule moves to dsh-law-core

Status: implemented

English | [中文](2026-11-06-law-core-statute-citation-shared-home.zh.md)

## Problem

Issue #739: the legal-law citation verifier and the patent-law citation verifier share one decision rule, but that rule lived in `@deepseek-ai/dsh-patent-core`, so the legal domain's build and release followed the patent core package and every patent-internal change became part of legal verification's dependency surface. `packages/legal/legal-law/package.json` declared `@deepseek-ai/dsh-patent-core` in `dependencies`.

## Decision

**The shared machinery gets a domain-neutral home.** New package `@deepseek-ai/dsh-law-core` (`packages/law/law-core`) owns the six citation modules moved out of patent-core — citation text, reference extraction, continuations, proposition overlap, the per-article decision, and the citation-verify tool scaffolding — plus `parseCnNumber`, which moves out of patent-core's `rule/text-utils.ts` so the moved modules have no inward dependency left.

**patent-core re-exports the moved surface.** Every symbol patent-core previously exported from the moved modules is re-exported from `@deepseek-ai/dsh-law-core`, so patent-domain consumers (`patent-law`, `patent-document`, `patent-rule`, `patent-tools`) keep one import surface and need no source change.

**legal-law consumes law-core directly.** Its four importing modules (`verify.ts`, `reference.ts`, `support.ts`, `tool/law-verify.ts`) now import from `@deepseek-ai/dsh-law-core`, and its `dependencies` declare `dsh-law-core` instead of `dsh-patent-core`.

**One sample set runs on both sides.** `packages/law/law-core/tests/fixtures/citation-samples.ts` defines the citation samples, the shared baseline content, and the expected decision labels once. `legal-law` and `patent-law` each run every sample through their own verify path in their `citation-conformance.spec.ts`; the only intentional per-side difference is domain data (the law name and baseline document title), commented at the adapter.

## Alternatives considered

- **Keep the rule in patent-core and accept the dependency.** Rejected by the issue: the dependency direction made legal releases follow patent internals.
- **Move the rule into the legal domain.** Inverts the asymmetry instead of removing it; the patent domain would inherit the same problem.
- **Merge the per-domain verify/baseline/reference scaffolding too.** Rejected with the 2026-10-31 duplication note: those files are per-domain structures over the shared rule, and the conformance samples now guard exactly the boundary where sharing is required.

## Consequences

- The legal↔patent cross-domain clone pair `legal-law/src/types.ts ↔ patent-core/src/knowledge/article-decision.ts` disappears from the duplication baseline (13 accepted cross-domain pairs remain).
- `parseCnNumber`'s unit tests move with it to `packages/law/law-core/tests/cn-number.spec.ts`; patent-core keeps the re-export for its existing consumers.
- A future statute-citation domain imports `dsh-law-core` and never a patent package.
