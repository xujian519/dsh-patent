# Agent Note: Extracting the `run_code` sub-dispatch lane (Issue #86)

Status: implemented

English | [中文](2026-09-15-ptc-dispatch-pool-extraction.zh.md)

## Problem

`packages/core/tool-executor-ptc/src/ptc.ts` was 492 lines, and 320 of them were `createRunCodeTool`'s `execute`. Most of that body scheduled rather than dispatched: the `PendingDispatch` interface, two queues with three bookkeeping collections, the one driver pass, the settlement drain, and the backpressure wait — 116 lines whose subject is when a sub-dispatch starts and commits, not what one is.

[The split plan](../../implemented/simplification/2026-09-14-god-file-split-plan.md) holds this cut in batch 3, the batch whose cuts sit on semantics and must each show what they preserve. It names the four behaviors at stake: the ordered commit lane, the exclusive barrier, backpressure, and the wakeup-order defense.

## Decision

`packages/core/tool-executor-ptc/src/ptc.ts` (176 lines) exports `class DispatchPool`; `packages/core/tool-executor-ptc/src/ptc.ts` is 372 lines.

| Moved | Form in the new module |
| --- | --- |
| `PendingDispatch` | `PooledDispatch`, whose classification is the existing `ToolExecutionMode['kind']` |
| `pendingQueue`, `commitQueue`, `inFlight`, `exclusiveActive`, `driving`, `driverRun`, `wake`, `wakeup`, `drive` | `DispatchPool`'s private state and its `drive()` |
| the `runController.signal.aborted` read that abandons queued entries | `DispatchPoolOptions.isRunOver` |
| `drainDispatches` | `DispatchPool.drain()` |
| `logWork` | the pool's `sideWork` ledger, filled by `track(work)` |

The lane's inputs are an entry carrying its own stages (`start`, `classify`, `abandon`, `commit`, `flight`, `settled`, `mode`), the overlap cap, and the run-over probe. Everything else it touches is one of those, so the transport keeps the registry, the execution, the agent, the session appends, and the `shapeDispatchLog` waterfall where they already were.

### Three placements that are not line-for-line moves

`runOver` is hoisted above the pool construction: the lane accepts it as `isRunOver`, and a `const` read during that construction would otherwise be in its temporal dead zone.

The backpressure wait moves out of the entry's `commit()` into the lane, which applies it after the head commit and before it releases the exclusive barrier. Both the wait and the release sit inside the same lane pass, and nothing outside the lane observes when `commit()` resolves, so no start order changes. Its rationale comment moves with it, and the ledger it reads becomes the pool's own.

The settle-event side work moves from a transport-local set into `pool.track(work)`, because the cap that bounds it is now the lane's: one ledger holds both the live bodies and the pending appends, so `drain()` and the cap cannot disagree about how much work the run owes.

### The entry keeps its export list

`RUN_CODE_NAME`, `CodeRunFailedError`, `RunCodeBridgeOptions`, and `createRunCodeTool` are unchanged, and `src/index.ts` needed no edit. The new module is not re-exported from the package entry (`exports` lists `.`, `./invariant`, `./types`, `./presentation`, `./src/*`), and it adds no runtime dependency: its only import is the `ToolExecutionMode` type.

### Tests that become possible, so they were written

`tests/ptc.spec.ts` keeps its nine scheduler cases — overlap, the exclusive call draining first, the cap, ordered pre-execute, the barrier covering post-execute, a commit draining after settlement, submission order under out-of-order completion, an abandoned queued call, and quiescence — and they pass unchanged, which is this cut's integration evidence. What they cannot do is drive a lane decision without a `run_code` program, a code runtime, and a tool registry around it.

`tests/ptc-dispatch-pool.spec.ts` drives the lane directly through eight cases: ordered commits under out-of-order settlement, the exclusive barrier across a commit, the overlap cap, abandonment, backpressure, work tracked during a commit holding `drain()` open, a submission after quiescence, and an idle drain. Six mutations to the extracted lane each fail at least one of them:

| Mutation to the extracted lane | Cases that fail |
| --- | --- |
| The commit cursor takes any settled entry instead of the head of the line | 1 |
| Capacity becomes unconditional, dropping the exclusive rule and the cap | 4 |
| The parallel capacity test is ignored | 3 |
| Queued-unstarted entries are never abandoned | 1 |
| The backpressure wait is removed | 1 |
| `drain()` returns without the tracked work | 1 |

`src/ptc-dispatch-pool.ts` is not in the root `vitest.config.ts` exemption list, so the per-file gate applies to it from the first commit: 100% statements, branches, functions, and lines, with no exemption written.

### Verification

| Check | Result |
| --- | --- |
| `pnpm exec vitest run packages/core/tools` | 13 files / 399 passed (12 / 391 before, plus the 8 new cases) |
| coverage for `src/ptc-dispatch-pool.ts` | 100% statements / branches / functions / lines |
| `pnpm run typecheck` | exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts` on the three changed files | 0 warnings, 0 errors |
| `pnpm run verify-export-jsdoc` | every exported name documented |
| `pnpm run duplication` | 0 clones |
| `pnpm run test:docs` | 18/18 |
| `pnpm run doc-sync` | 33 passed / 3 failed — the pre-existing doc graphs, config catalog, and package paths failures |

## Alternatives considered

- **Extract the binding factory with the lane, leaving `createRunCodeTool` the schema and the run call.** Rejected: the factory closes over the registry, the execution, the run controller, the agent, the sub-call ids, and the two durable event payloads. A module of its own would need a dependency list of roughly eight transport values, and it would move the `tool/ptc-dispatch` payloads into a file whose subject is scheduling.
- **Keep the side-work ledger in the transport and pass the lane only its cap.** Rejected: the cap bounds both live bodies and pending appends, so splitting the ledger from the rule that reads it would leave two owners for one bound.
- **Track the started classification in a lane-owned map instead of `PooledDispatch.mode`.** Rejected: it would keep a second structure keyed by entries for one field the interface already declares, and the entry outlives its visit to the lane.
- **Move the lane without a direct spec, relying on `ptc.spec.ts`.** Rejected on the plan's own terms: a batch-3 cut lands when it can show what it preserves, and a lane that no test can reach without a whole `run_code` program is what the extraction was for.

## Consequences

`ptc.ts` loses 120 lines and `ptc-dispatch-pool.ts` is 176, so the net growth is the interface, its JSDoc, and the module header. The package gained one test file and no coverage exemption; the lane's state is now reachable as a unit, so the next change to it can fail on a case about ordering rather than on a program's outcome. Batch 3's remaining items are `core/session`'s `Session` class, `code-runtime-python`'s config gates and process supervisor, `ui-trajectory`'s row renderer, and `analyzer`, which starts with an id-stability test.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan; this is batch 3's second landed cut)
- [Extracting the session's incremental folds](../../archived/simplification/2026-09-14-session-folds-extraction.md) (batch 3's first landed cut)
- [Extracting the `acp`/`ptc` clusters](2026-09-14-acp-ptc-cluster-extraction.md) (batch 1's cut of this file: the static spec, the flavor table, and the JSON presentation)
- `packages/core/tool-executor-ptc/src/ptc.ts`, `packages/core/tool-executor-ptc/tests/ptc.spec.ts`
