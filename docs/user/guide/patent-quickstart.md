# Patent quick start

English | [中文](patent-quickstart.zh.md)

This guide takes a first patent task from a source checkout to a completed analysis, starting with the [Web UI](../../../README.md#run).

## Before you start

- Node.js >= 24.9 and pnpm 11.28.5 for the source build.
- A DeepSeek API key.
- A matter folder under the configurable work root, with disclosure documents and any reference material. A typical value of that root is `/Users/xujian/工作`.

## Start the Web UI

Run from the repository root:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

Fork capabilities are not part of the published upstream package, so this source build is required.

## Configure the model and workspace

1. Open **Settings → Models**, enter the DeepSeek API key, and save it.
2. Keep this repository as the workspace for every matter.

## Open a new matter

One repository holds many matters. Do not open a separate Cursor or git project for each matter. The decision is [ADR-001](../../adr/ADR-001-matter-folder-index.md).

1. Create the matter folder under the work root, for example `/Users/xujian/工作/<案号>/`, and put `_matter-log.md` in it. The work root is configurable. Do not create a separate `patent-workspace/<案号>` tree that ignores this root.
2. Scan the folder into the workbench ledger, the SQLite database under `~/.dsh/workbench`. The ledger row stores metadata and `workspace_path` only. Matter file bodies stay in the folder. They do not go to the cloud or into `knowledge.db`.
3. Open this same repository and select that matter. The workbench entry points at the matter folder.
4. Write in that folder. The matter directory and `_matter-log.md` are the truth source. A bridge may read projections. Writing back to the matter folder is not the ledger.

## Select the patent preset

Create a task and open the agent-preset picker. The patent preset is published as **专利模式** (Patent mode). The preset is fixed once the task starts, so choose it before sending the first message.

## Run a first task

Send a scoped request:

> Read the disclosure document in this workspace and list the technical problem, the inventive concept, the key technical features, and the technical effects.

The agent restates the scope and each key decision for confirmation before drafting, and it verifies statute citations before quoting them.

## What to expect

- Outputs are drafting assistance, not formal legal advice.
- Search reports name the data source, search expression, date, and coverage.
- Every factual assertion carries a source; assertions without a source are withdrawn.


## Approval gate (in-session card, no separate route)

When a patent workflow reaches the `approval-gate` stage, it does **not** open a dedicated Approvals page or sidebar route.

With the default foreground setup (`approveStageGates: true` on `@deepseek-ai/dsh-patent-tools` in the patent preset, and an `approval` / `@deepseek-ai/dsh-user-approval` service mounted):

1. An **approval card** appears in the same session (one-shot decision). The summary comes from the outputs listed in that gate's `review_keys`.
2. Allow continues the run; reject / cancel / unavailable / `never` policy pauses with the outcome name in the tool result.
3. Background runs (`run_in_background: true`) or deployments with the flag off may still use the older “pause then resume with `approveStageIds`” contract — see the upgrade guide; do not pass `approveStageIds` yourself when the foreground flag is on.

Smoke check: run a short manifest (for example `patent_workflow_run` with `manifestId: patent_novelty_v1`) to the gate, confirm the card, then allow and finish the chain.

Details: [`../../upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.md`](../../upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.md) (canonical text stays under `alpha.3`; `v0.2.2-rc.1` has a pointer only — see `docs/upgrade-guide/PATH-ALIGNMENT-NOTE.md`).

## Continue

- [Use the Web UI](index.md)
- [Configure models](providers.md)
- [Architecture overview](../../architecture.md)
- [Matter folder index (ADR-001)](../../adr/ADR-001-matter-folder-index.md)
