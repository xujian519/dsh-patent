---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-tools refuses approveStageIds on every run when approveStageGates is on, including background runs."
---

# Background workflow runs no longer accept self-declared approvals

English | [中文](guide.zh.md)

## Change

With `approveStageGates: true`, `patent_workflow_run` now rejects a non-empty `approveStageIds` on every run. A background run used to keep the pause-and-`approveStageIds` contract; it now pauses at the approval gate like a foreground run without an answerer, so a model cannot self-approve a gate by switching to `run_in_background: true`. Deployments with `approveStageGates` off keep the existing contract.

Affected: callers that start a background workflow and continue it with `approveStageIds` in a deployment that asks the approval service.

## Migration

1. Remove `approveStageIds` from background calls. The run pauses at the `approval-gate` stage and reports the stage id.

2. Rerun the workflow in the foreground so the gate asks the deployment's approval service; grant or refuse there.

3. If the deployment intentionally has no human approval step, set `approveStageGates: false` in its `patent-tools` config; `approveStageIds` is accepted again.

4. Confirm with a background call that omits `approveStageIds`: it pauses instead of completing, and the error for a self-declared list names `approveStageIds 不再作为放行依据`.
