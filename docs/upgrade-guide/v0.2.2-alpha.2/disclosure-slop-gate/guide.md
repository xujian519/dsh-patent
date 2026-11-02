---
kind: upgrade-guide
description: "The disclosure chain's slop gate now scores the specification and reports failures; deterministic claims no longer rewind."
---

# The disclosure slop gate scores the specification

English | [中文](guide.zh.md)

## Change

`patent_disclosure_v1` no longer points `slop_clean` at `claims_draft`: the stage now runs with `params: { text_keys: ['specification'] }` and declares no `retry`. Previously a `需修订` result rewound to `draft_claims` once; the disclosure chain renders claims deterministically from the strategy table, so re-running that stage could not change the text or the score, and the second failure always produced `[WORKFLOW_RETRY_EXHAUSTED]`, making `completed` false.

Claim text has none of the dispute-opening prose or citation paragraphs an office-action response carries, so the answer-oriented directness/evidence dimensions cap it at 34 against a pass line of 35. The gate was therefore unsatisfiable for this chain by construction. It now scores the specification body; a failure appears in `slop_report` / `slop_score` without blocking delivery, and `degradedSteps` no longer lists `slop_clean`. Claim form and scope remain enforced by `claim_lint`, `claimCountViolations`, and the rubric dimensions.

Affected: callers running `patent_disclosure_v1`. This change kept the stage count at 26 and the model-backed count at 13; the later [draft-review guide](../disclosure-draft-review/guide.md) raises them to 27 and 14. Only `slop_clean`'s input and failure semantics change here.

## Migration

1. If a custom manifest copied the disclosure chain's `slop_clean` configuration, switch it to `text_keys: ['specification']` and drop `retry`. A gate over standard claim text cannot reach 35.
2. Tooling that treated a `slop_clean` degradation or `[WORKFLOW_RETRY_EXHAUSTED]` as a blocking signal should read `slop_report` and `slop_score`; `completed` no longer turns false for this stage.
3. Callers that need a hard block should read `slop_score` from the run record and decide there; neither `legal_gaps` nor `review_gate` consumes the key, so a custom manifest has to add that read itself.
4. Confirm: a specification scoring below 35 still completes 27/27 stages, leaves `degradedSteps` empty, and prints `需修订` in the `slop_clean` output.
