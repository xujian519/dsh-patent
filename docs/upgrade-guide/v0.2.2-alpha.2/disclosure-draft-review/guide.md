---
kind: upgrade-guide
description: "The disclosure chain adds an examiner review stage that can rewind drafting twice before the approval gate."
---

# The disclosure chain reviews the draft before legal gaps

English | [中文](guide.zh.md)

## Change

`patent_disclosure_v1` now runs `draft_review` (atom `draft-review`) after `slop_clean` and before `legal_gaps`, raising the manifest from 26 to 27 stages and from 13 to 14 model-calling stages; the default budgets are now 27/14.

The stage reads only `specification`, `claims_draft`, `pfe_triples`/`features`, and `prior_art`. It writes `draft_review_report`, `draft_review_disputes`, and `draft_review_passed`, and emits one `RetrySignal` per dispute category: enablement, support, and amendment rewind to `draft_specification`; clarity rewinds to `draft_claims`; unity rewinds to `claim_strategy`. Two rewinds are allowed. A review that still finds a dispute on its third execution keeps `draft_review_passed: false` and advances through `legal_gaps` to `review_gate` instead of looping. `legal_gaps` reports the failure as a warn-level checkpoint with `revisionTarget: false`.

Affected: callers that run `patent_disclosure_v1`, read its stage list or `revisions`, or pin the stage and model-calling budgets.

## Migration

1. Raise a pinned workflow budget to at least 27 stages and 14 model-calling stages, or keep the new defaults.
2. If a custom manifest copies the disclosure chain, add the stage with `atom: draft-review` and this retry block: `whenRevisionRequested: true`, `rewindTo: draft_specification`, `maxRetries: 2`, and routes `draft-review:enablement`/`support`/`amendment` → `draft_specification`, `draft-review:clarity` → `draft_claims`, `draft-review:unity` → `claim_strategy`.
3. Tooling that reads `revisions` should expect up to two `applied` records and one final `exhausted` record for this stage; after exhaustion the stage keeps its output and is not marked degraded.
4. Confirm: a clean disclosure draft completes 27/27 stages with `draft_review_passed: true`; a draft with an enablement dispute rewinds at most twice and then reaches `review_gate`.
