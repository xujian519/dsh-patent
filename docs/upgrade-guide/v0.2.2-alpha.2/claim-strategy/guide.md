---
kind: upgrade-guide
description: "patent_disclosure_v1 gains an anchor-checked claim_strategy stage before draft_claims; draft_claims now renders claims deterministically from that table and refuses the old free-form path."
---

# Claim strategy before claim text

English | [中文](guide.zh.md)

## Change

`patent_disclosure_v1` now runs `claim_strategy` (atom `claim-strategy`) between `report` and `draft_claims`. The stage writes `claim_strategy` (JSON) and `claim_strategy_report`: an essential-feature list, an optional-feature list, a dependent-claim tree, and the closest-prior-art reference. Every feature carries a verbatim disclosure excerpt that the anchor verifier re-checks. A feature whose excerpt does not occur in the disclosure fails the stage, and so does a `prior_art_ref` that does not already appear in the novelty conclusion or the filtered prior art; neither case degrades into an empty table or a fabricated document number. A caller may inject `confirmed_features` into the state to supply the table directly; the stage then validates it through the same path and does not call the model.

`draft_claims` no longer asks the model for free-form claim text. It reads `claim_strategy`, renders the independent claim and the multi-branch dependent tree through the deterministic `draftClaims` engine, and keeps the rendered independent claim fixed. A dependent-claim specialist may only reorder or supplement dependent claims. Any `claim_lint` error vetoes the round, so `claims_draft` is never overwritten with a half-finished draft. `draft_claims_result` is now a JSON record (strategy ids, specialist status, formal violations, lint findings, claims); its `notes`-style prose no longer enters `claims_draft`.

`confirmed_features` accepts the model-output shape: `essential_features` and `optional_features` arrays (each item needs `id`, `text`, and an `anchor` copied from the disclosure), plus optional `dependent_tree` and `prior_art_ref` fields.

The stage writes `review_context` with the feature table, dependent tree, and claim draft, and the disclosure manifest's `review_gate` no longer sets a static `review_context` parameter. The manifest grows from 25 to 26 stages and from 12 to 13 model-calling stages; the default `workflowStageBudget` and `workflowLlmStageBudget` rise from 25/12 to 26/13.

The deterministic engine moved from `@deepseek-ai/dsh-patent-tools` to `@deepseek-ai/dsh-patent-core` (`draftClaims`, `validateClaims`, `claimCountViolations`, `DOMAIN_KEYWORDS`). The tool package re-exports the same names, and the model-facing `draft_claims` tool keeps its schema, output, and `invalid_tool_input` error for mutually exclusive inputs.

## Migration

1. If a deployment sets `workflowStageBudget` or `workflowLlmStageBudget` explicitly, raise them to at least 26 and 13, or plugin load rejects `patent_disclosure_v1`.
2. A custom manifest that runs `draft-claims` must place `claim-strategy` before it and wire `claim_strategy` into the state; the handler degrades without it.
3. Stop treating `draft_claims_result` as free-form model prose. Read the JSON record, or keep using `claims_draft` for the rendered claims.
4. Replace any caller that supplied claim text through the old `draft-claims` prompt inputs (`merge_result`, `novelty_conclusion`, `slop_revision_hint`). Supply `claim_strategy` instead, or inject `confirmed_features` and let `claim-strategy` build it.
5. Re-record snapshots that pin the `patent_workflow_run` or `patent_flexible_plan` tool descriptions, and review the new stage line in workflow run output.
