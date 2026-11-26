---
kind: upgrade-guide
description: "The disclosure chain adds two deterministic ledger stages and allows a third draft-review rewind, raising the default workflow stage budget to 29."
---

# The disclosure chain reconciles review rounds and scores the draft

English | [中文](guide.zh.md)

## Change

`patent_disclosure_v1` runs two new deterministic stages: `revision_ledger` (atom `revision-ledger`) right after `draft_review`, and `draft_quality` (atom `draft-quality-ledger`) after `legal_gaps` and before `review_gate`. The manifest goes from 27 to 29 stages while model-calling stages stay 14, so the plugin's config defaults become `workflowStageBudget: 29` (was 27) and `workflowLlmStageBudget: 14` (unchanged). Plugin load fails when a pinned budget is lower.

`draft_review` now allows three rewinds instead of two (`retry.maxRetries: 3`); a review that still finds a dispute on its fourth execution keeps `draft_review_passed: false` and advances.

Each `draft_review` execution appends that round's actionable disputes to `_revision_ledger_rounds`, a state key no atom `outputSchema` declares, so rewind cleanup leaves it in place. `revision-ledger` folds the rounds into `revision_ledger_summary`, `revision_ledger_report`, and `revision_ledger_reconciliation`, classifying every finding id as resolved, persisting, or introduced by the revision. `draft-quality-ledger` writes `draft_quality_summary`, `draft_quality_report`, and `draft_quality_matrix` over the `spec_check`, `enablement-report`, `claim-breadth`, revision-ledger, and `legal-gaps` verdicts: the 0–100 score divides passed rows by assessed rows, and a gate that did not run is listed as unassessed instead of counted as passed. `slop_score` appears as an information line; `slop-gate` keeps ownership of its threshold.

`patent_flexible_plan` lists `revision-ledger` and `draft-quality-ledger` among the selectable atoms, so a recorded tool-schema expectation that embeds that parameter description is stale after this change.

Affected: callers that run `patent_disclosure_v1`, pin its budgets, read its stage ids or `revisions`, or compare recorded tool schemas.

## Migration

1. Where a deployment pins `workflowStageBudget` under `@deepseek-ai/dsh-patent-tools`, raise it to at least 29; `workflowLlmStageBudget` stays 14. Omitting both keeps the new defaults.
2. In a custom manifest copied from the disclosure chain, add `{ id: revision_ledger, atom: revision-ledger }` after the review stage and `{ id: draft_quality, atom: draft-quality-ledger }` after `legal_gaps`, and set `draft_review` retry `maxRetries: 3` to match. Neither new stage declares `retry`: rewind ownership stays with `draft_review`'s category signals.
3. Tooling that reads `revisions` should expect up to three `applied` records plus one `exhausted` for `draft_review`.
4. Refresh the embedded atom catalog with no key: `pnpm run test:snapshot:refresh` replays committed recordings and rewrites each scenario's expected outputs, including `tool-schemas.expected.json`. To refresh one scenario, run `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t <scenario>`. Then `pnpm run test:snapshot` confirms the pin.
5. Confirm: a clean draft completes 29/29 stages, `revision_ledger_summary` states that no marked finding is unresolved, and `draft_quality_report` lists five verdict rows.
