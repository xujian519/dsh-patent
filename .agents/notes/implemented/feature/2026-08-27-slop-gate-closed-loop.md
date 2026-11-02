# Agent Note: Slop-gate closed loop

Status: implemented

English | [中文](2026-08-27-slop-gate-closed-loop.zh.md)

## Problem

The dsh patent domain ships a deterministic anti-slop engine (`patent_eval`, the inline `slop-engine`) but no gate over the drafting workflow: the `patent_disclosure_v1` manifest produces a `claims_draft` and moves on, so drafted claims and specifications can ship full of filler phrases and empty structure with nothing checking them. Sati closes this loop with a `slop-gate` atom plus a workflow `retry` that rewinds to the drafting stage on failure. The missing piece in dsh is the engineering wiring, with one hard constraint: the rewrite prompt must never receive score numbers. Telling the model which dimension scored lowest invites it to game the metric rather than improve the prose — the retry must carry only evidence the reviewer actually saw (matched phrases with suggested replacements, line-level structure issues).

## Decision

`patent-tools` now ships a `slop-gate` atom and handler. The handler lives here rather than in `patent-core` because it depends on this package's slop engine; `apply()` registers `slopGateAtom` and `SlopGateHandler` into the global registries (lines 283-284 of `src/index.ts`), on top of `registerBuiltinAtoms()`.

`slopGateAtom` declares `inputSchema: ['claims_draft', 'draft', 'draft_tightened', 'specification', 'text_keys', 'char_budget']` and `outputSchema: ['slop_report', 'slop_score']`. `SlopGateHandler` runs the deterministic `analyzeSlop` over the draft, writes `slop_report` (✅ 通过 / ⚠️ 需修订 with the total and pass line) and `slop_score` (the total), and — when the draft fails — also writes `slop_revision_hint` built by the new `buildSlopRevisionHint` (`src/internal/retry-hints.ts`). An empty or blank draft degrades (`degraded('slop-gate', '输入为空…')`) instead of throwing.

`buildSlopRevisionHint` enforces the secrecy contract by construction: it emits matched phrase changes (cap 8) and structure issues (cap 3) with a residual count, plus a fixed revision-direction line, and never a score number, the total, the pass line, or any checklist verdict. With nothing actionable it returns `undefined` and the handler writes no hint, so a failed-but-unactionable draft fails the gate without injecting empty-prompt noise.

The closed loop reuses the workflow `retry` mechanism that already exists: `patent_oa_response_v1` declares `retry: { whenOutputMatches: '需修订', rewindTo: 'draft', maxRetries: 1 }` on its `slop_gate` stage. Matching the fail signal rewinds stage outputs to `draft`; rewind removes stage-id state keys but keeps non-stage keys, so `slop_revision_hint` survives and the rewrite prompt receives it as「上一轮反套话评审意见（仅修订提示，不含评分）」. A second failure exhausts the retry and degrades to `[WORKFLOW_RETRY_EXHAUSTED]`, surfacing the「需修订」report instead of silently passing.

`patent_disclosure_v1`'s `slop_clean` stage keeps the same atom but declares no retry: the disclosure chain renders claims deterministically from the strategy table, so rewinding to `draft_claims` could not change the text or the score, and a second failure always exhausted into a non-completed run. It scores `specification` and reports a failing score through `slop_report` / `slop_score` without degrading.

`patent-core` now exports `degraded` through both atom barrels; the slop-gate handler is its first consumer. The pass line stays a fixed constant (`SLOP_GATE_PASS_THRESHOLD = 35`, exported) because it is the calibrated threshold of the ported slop engine, not a deployment-varying tunable.

## Alternatives considered

- **Put the gate in `patent-core`.** The gate needs the slop engine, and `patent-core` must not depend on `patent-tools` (the tools package is the consumer). Keeping the atom and handler in `patent-tools` preserves the dependency direction; `patent-workflow` — which does not depend on `patent-tools` — registers a contract stub in its manifest-validation test instead of importing the real atom.
- **Tell the model the failing dimension.** Feeding the lowest-scoring dimension or the total back into the rewrite prompt would invite the model to optimize the metric. The evidence-only hint (what the reviewer saw) keeps the rewrite honest and is what Sati's retry-hints port does.
- **Model-judged slop gate.** An LLM node scoring slop would reintroduce nondeterminism, latency, and cost into a check the deterministic engine already answers. The engine's structure issues and phrase rules are exact; only the gate wiring was missing.
- **Hand-rolled retry loop in the tool layer.** The workflow `retry` mechanism already implements splice-back rewinding and exhaustion degradation; a second loop would duplicate state rollback semantics and drift from the manifest contract.

## Consequences

- The answer body is gated: a sloppy draft is rewritten once with evidence-only guidance, and a still-failing draft degrades to an explicit 「需修订」report instead of silently passing — no artificial score ceiling for the model to chase. In the disclosure chain the same gate reports only: a failing specification scores below the line without blocking delivery.
- The model-visible surface carries only evidence (phrase → replacement, line → original → suggestion) plus a fixed revision-direction line; score numbers, the total, and the pass line never reach a model request. Because the hint is model-visible input, it is part of the drafting prompt and reconstructable from the session log (`Model-visible ⟺ logged`).
- The `slop_clean` stage adds one deterministic, LLM-free check to the disclosure manifest (cheap), and `patent_workflow_run` runs it without new configuration.
- `patent-workflow`'s manifest-validation tests now register a `slop-gate` contract stub, since that package cannot depend on `patent-tools`; the real atom is exercised by the `patent-tools` tests and `apply()`.

## Testing

`slop-gate.spec.ts` (patent-tools) covers the handler pass/fail/empty-degraded paths, the secrecy contract (the hint never contains score vocabulary), the no-evidence `undefined` case, cap truncation with the residual count, replacement-type rendering, and an issue without a suggestion. `atoms.spec.ts` (patent-core) covers `slop_revision_hint` injection into the drafting prompt (present and absent) and that the injected hint leaks no score. `workflow-retry.spec.ts` (patent-workflow) asserts the `slop_clean` stage declaration and ordering with a registered stub. `patent-workflow-run.spec.ts` (patent-tools) registers the real slop-gate atom and handler so the disclosure manifest validates and runs through the tool. The touched packages stay at 100% per-file statement/branch coverage.
