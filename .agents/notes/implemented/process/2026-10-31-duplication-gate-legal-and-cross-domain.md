# Agent Note: Duplication gate covers the legal domain and cross-domain clones

Status: implemented

English | [中文](2026-10-31-duplication-gate-legal-and-cross-domain.zh.md)

## Problem

The tightened duplication pass scanned one domain per jscpd invocation, and `packages/legal` was not among them. jscpd only compares files inside the roots of one invocation, so a clone whose two files sat in different tightened domains could not be reported at all. The repo-wide 60-token floor hid every pair the issue measured (largest 58 tokens). Legal therefore had no CI signal, and the legal/patent split — two domains that share `patent-core` and `patent-index-asset` — could grow two implementations of one semantic unnoticed.

## Decision

**`packages/legal` joins the tightened domains.** `TIGHTENED_DOMAINS` lists `packages/patent`, `packages/legal`, and `packages/document`. Each still runs as its own jscpd root, so the 91 accepted intra-domain pairs keep stable paths.

**A second pass scans all three domains at once.** `crossDomainPairs` keeps only the pairs whose two paths resolve to different `packages/<group>` values. `pnpm run duplication` fails when this pass reports a pair the baseline does not accept, and when an accepted pair stops being reported.

**The baseline separates the two classes.** `scripts/duplication-baseline.json` holds `pairs` and `crossDomainPairs`. `readBaseline` rejects a file that lacks either list: an absent list is a broken baseline, not an empty acceptance list.

## Accepted pairs

The 15 legal-internal pairs sit in the baseline without extra rationale: they are parallel evaluators, search modules, and type declarations inside one domain, the same shape the patent and document domains already accepted.

The 14 cross-domain pairs are accepted for three reasons:

| Pair | Why accepted |
|---|---|
| `legal-evidence/src/engine.ts` ↔ `patent-core/src/evidence/engine.ts`; `legal-evidence/src/rule-set.ts` ↔ `patent-core/src/evidence/rule-set.ts` | Parallel domain engines. The legal engine judges 关联性/合法性/真实性 while the patent engine adds type-specific dimensions, proof standards, and burden allocation. Sharing a module would make one domain import the other's vocabulary. |
| `legal-evidence/src/rule-set.ts` ↔ `patent-rule/src/runtime/args-match.ts` | Argument-normalization helpers only. |
| `legal-evidence/src/tool/evaluate-evidence.ts` ↔ `patent-teams/src/tools.ts`, `patent-tools/src/tool/analyze-patent-figure.ts`, `patent-tools/src/tool/parse-office-action.ts`, `tool-literature/src/tool/paper-download.ts` | Tool declaration scaffolding — input schema, description, registration — not domain logic. |
| `legal-knowledge/src/types.ts` ↔ `patent-knowledge/src/types.ts` | Both declare a data directory and search result types; the stores, paths, and record fields differ. |
| `legal-law/src/{asset-location,baseline,index,verify,types,tool/law-verify}.ts` ↔ `patent-law/src/{asset-location,baseline,index,verify,types,tool/law-verify}.ts`; `legal-law/src/types.ts` ↔ `patent-core/src/knowledge/article-decision.ts` | Mirrored seam scaffolding over different corpora. Legal-law reads a 7,910-file corpus through a manifest and parses only the laws a citation names; patent-law runs a fixed baseline. The shared lines are directory resolution, error construction, and tool registration. |

2026-11-06 update: the `legal-law/src/types.ts` ↔ `patent-core/src/knowledge/article-decision.ts` pair dissolved when the citation decision rule moved to `@deepseek-ai/dsh-law-core` (see the law-core note); the cross-domain list now carries 13 pairs.

## Alternatives considered

**Extract shared modules for the legal-law/patent-law mirror.** Rejected: the two seams already diverge in corpus access, verification decisions, and types (427 vs 236 lines in `baseline.ts`, 196 vs 487 in `verify.ts`). A shared package would have to carry both policies, coupling a 7,910-law lazy index to a fixed patent baseline for about 200 lines of scaffolding.

**Add only `packages/legal` and leave the cross-domain pass out.** Rejected: the issue's main finding is that legal↔patent clones are invisible, and the 60-token repo-wide floor cannot see them. Domain-internal coverage alone would not catch a new copy of `patent-law` inside `legal-law`.

**Replace the per-domain passes with the combined three-root pass.** Rejected: one combined invocation omits three patent-internal pairs that the single-root pass reports, so the baseline would go stale on pairs that never changed. The combined pass is used only to classify cross-domain pairs.

## Consequences

The gate runs one extra jscpd invocation over the three domains; `pnpm run duplication` takes about six seconds locally. A new legal clone, and a new legal↔patent clone, now fail CI instead of waiting for review.

The 14 accepted cross-domain pairs are fixed scaffolding. A future change that makes one of them larger will fail the gate and ask for either a smaller clone or an explicit baseline update.
