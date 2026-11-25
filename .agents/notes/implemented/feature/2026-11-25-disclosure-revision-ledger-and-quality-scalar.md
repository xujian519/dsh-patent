# Agent Note: Reconcile draft-review rounds and score the disclosure chain deterministically

Status: implemented

English | [中文](2026-11-25-disclosure-revision-ledger-and-quality-scalar.zh.md)

## Problem

`patent_disclosure_v1` ran its examiner pass (`draft_review`) with a rewind budget of two, but nothing recorded which disputes each round raised. The run kept only the last round's `draft_review_disputes`, so three different histories looked identical in the report: a dispute fixed on the second round, a dispute that was never addressed, and a new dispute the revision itself introduced. `legal_gaps` and the human reviewer at `review_gate` could see that the review failed, not what remained open.

The five drafting gates also had no shared reading. `spec_check`, `enablement_report`, `claim_breadth`, `legal_gaps`, and the review each write their own verdict key, and a caller either read them one at a time or asked `patent_eval`, whose rubric score mixes model judgement with the deterministic verdicts. A gate that never ran was indistinguishable from one that passed.

## Decision

`draft-review` appends each round's actionable disputes to `_revision_ledger_rounds` (`packages/patent/patent-core/src/draft-review/findings.ts`). The key is deliberately absent from `draftReviewAtom.outputSchema`: [rewind cleanup](../bug-fix/2026-09-20-rewind-clears-atom-output-keys.md) deletes stage-id keys and declared output keys only, so an undeclared key survives the rewind the same way `slop_revision_hint` does. The leading underscore also keeps the record out of the state text that reaches prompts.

Ids come in two layers. `RetrySignal.gapId` stays category-level (`draft-review:unity`) because `retry.routes` maps a category to a stage. A finding id adds the locator — `draft-review:enablement:claim1`, `feat-<id>`, or `doc` — and never the anchor, because the model re-quotes the offending sentence each round and a wording change would otherwise read as a new problem.

`revision-ledger` runs once, after the review loop converges. A round that emits a rewind signal returns before downstream stages execute, so by the time the ledger runs it sees every round of the loop. It reports each finding as resolved, persisting, or introduced by the revision, and its summary distinguishes a review that marked nothing from a ledger whose marks were all cleared.

`draft-quality-ledger` runs after `legal_gaps` and collapses the five verdicts into a matrix plus a 0–100 score over assessed rows. A missing or malformed signal is `unassessed` and is listed rather than counted, so an unrun gate cannot raise the score or read as a pass. `slop_score` is an information line: `slop-gate` keeps ownership of its pass threshold.

Neither new stage calls a model or declares `retry`; the model-calling budget stays 14 while the stage budget rises to 29. `draft_review.maxRetries` goes from 2 to 3 on the strength of the ledger — the extra round is worth its cost only because its outcome is checkable per finding.

## Alternatives considered

**Declare the ledger key in `outputSchema`.** Rejected: that puts it inside the rewind cleanup set and deletes exactly the cross-round evidence the stage exists to produce.

**Teach `clearStageOutputs` a keep-list.** Rejected: it changes shared rewind semantics for one consumer, and undeclared-key survival is already the documented mechanism other revision hints rely on. A keep-list would also have to be updated by every new atom that persists across a rewind.

**Route rewrites per finding instead of per category.** Rejected: the retry table maps a category to a stage, which is stable, while finding ids scale with model output. Per-finding signals would let one model response widen the retry surface.

**Ask the model which prior findings it resolved.** Rejected: the classification is a set difference over ids the harness already computed. A model call adds cost and can contradict the ids it was given.

**Extend the `patent_eval` rubric score.** Rejected: that score is model-judged; the drafting-chain figure has to be reproducible from the recorded stage outputs alone.

**Merge the two atoms into one stage.** Rejected: `legal_gaps` sits between them and owns a feedback rewind of its own, so the quality collapse has to rerun downstream of it while the ledger stays upstream of the review verdicts it reads.

## Consequences

A disclosure run reports which disputes it started with, which it cleared, and which the revision introduced, and the approval gate sees one quality line that says which gates were never assessed. The stage sequence and budgets changed, which [the upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.2/disclosure-ledger-quality-stages/guide.md) records; `patent_flexible_plan`'s atom catalog gained two entries, so recorded tool-schema expectations were re-rendered.

`revision_ledger` depends on `draft-review` having run: with no rounds recorded it reports that the review loop never ran rather than treating the absence as a pass. `draft-quality-ledger` likewise reports unassessed rows instead of a zero score.

## Testing

`packages/patent/patent-core/tests/draft-review-atom.spec.ts` pins that the ledger key is absent from `outputSchema`, that the first round records only actionable disputes, that a revision round appends a second entry and its prior findings reach the prompt, that the record truncates at 14 rounds, and that a degraded round appends nothing.

`packages/patent/patent-core/tests/revision-ledger.spec.ts` and `packages/patent/patent-core/tests/draft-quality-ledger.spec.ts` cover the reconciliations, the report text, and the malformed-signal degradations. `packages/patent/patent-workflow/tests/revision-ledger-loop.spec.ts` runs the real `draft-review` rewind loop over a stubbed drafting stage and asserts a downstream stage still reads both rounds after cleanup.
