---
kind: upgrade-guide
description: "The patent preset asks the approval service at each workflow approval gate and refuses self-declared approveStageIds on foreground runs."
---

# Patent workflow approval gates ask during the run

English | [中文](guide.zh.md)

## Change

The `patent` preset sets `approveStageGates: true` on `@deepseek-ai/dsh-patent-tools`. A foreground `patent_workflow_run` that reaches an `approval-gate` now asks the deployment's `approval` service instead of pausing for a later call. A granted decision continues the run; `rejected`, `cancelled`, `unavailable`, or a `never` policy pauses it and names the outcome in the tool result.

While the switch is on, a foreground call that passes `approveStageIds` fails with `invalid_tool_input`: that stage id would be a model-supplied grant. The approval question quotes bounded previews of the gate stage's `review_keys` deliverables, so the decision names the pending text.

Background runs (`run_in_background: true`) and deployments that leave the switch off keep the pause-and-`approveStageIds` contract. An opted-in deployment with no `approval` service mounted keeps it too.

Affected: patent-preset sessions, any deployment that turns the switch on, and scripts or prompts that resume a manifest with `approveStageIds`.

## Migration

1. Remove `approveStageIds` from foreground `patent_workflow_run` calls and let the gate ask the user.

   ```diff
   - {"manifestId": "patent_oa_response_v1", "approveStageIds": ["approval"]}
   + {"manifestId": "patent_oa_response_v1"}
   ```

2. Keep the parameter only for background runs, or for a deployment that leaves `approveStageGates` off.
3. Run one short manifest to its gate, for example `patent_workflow_run` with `manifestId: patent_novelty_v1`, and confirm the approval card names the pending deliverable and that allowing it completes the run.
