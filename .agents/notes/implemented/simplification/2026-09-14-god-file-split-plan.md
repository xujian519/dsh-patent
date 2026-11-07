# Agent Note: Splitting the seven god files (Issue #86)

Status: implemented

English | [中文](2026-09-14-god-file-split-plan.zh.md)

## Problem

Issue #86 asks that the oversized files under `packages/` be split. Its inventory lists twelve files, with generated files already excluded by the issue itself, and orders them by size, largest first:

| File | Lines | Form | In this note |
| --- | --- | --- | --- |
| `packages/client/connection`'s `src/client/fixture.ts` | 2288 | Shipped browser-mode provider (not a test fixture) | yes |
| `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` | 693 | One ledger over the extracted row and inspector | yes |
| `packages/typert/generator/src/analyzer.ts` | 1253 | The package analyzer over the extracted type graph and Remote/RPC analyzer | yes — both slices landed |
| `packages/experimental/code-runtime-python/src/index.ts` | 364 | The plugin: registration, binding validation, staging | yes — both slices landed |
| `packages/core/session/src/index.ts` | 488 | The store: publication protocol, lifecycle, and fork path | yes |
| `packages/core/tool-executor-ptc/src/ptc.ts` | 372 | One tool factory over the extracted dispatch lane | yes |
| `packages/acp/acp/src/index.ts` | 503 | One 341-line `apply` | yes |
| `state.ts` (better-sidebar, removed) | 1900 | Clone center | no |
| `Sidebar.tsx` (better-sidebar, removed) | 1775 | Clone center | no |
| `packages/core/tools/src/index.ts` | 1913 | ToolRuntime plus five responsibilities | no |
| `packages/self-evolve/self-evolve-basic/src/index.ts` | 1857 | Flat since the audit | no |
| `packages/subagent/subagent/src/manager.ts` | 1475 | Upstream's managed-activation rewrite replaced this fork module | no — the issue closes it |

Five entries are outside this note, each for a stated reason rather than by omission. `continuation.ts` converged and the issue itself recommends closing it; the release then removed the file in its manager rewrite. `better-sidebar`'s `state.ts` and `Sidebar.tsx` are flagged by the issue as clone centers: their remedy is deduplication, and cutting two files that already mirror each other would turn one in-file clone into a cross-file one — that work belongs to the M1 dedup family, not here. `core/tools/src/index.ts` and `self-evolve-basic/src/index.ts` are at or below the size the issue recorded, and this note's own standard — every cut justified by a test that becomes possible, an interface that becomes explicit, or a method that becomes readable — has no answer for them yet; they stay open on the issue rather than entering a batch without a reason. Line counts are as measured when each extraction landed, most recently 2026-09-15: after the pilot, the session-folds extraction, the fixture RPC dispatch extraction, the ptc dispatch-pool extraction, the session-object extraction, the trajectory-row extraction, the analyzer type-graph extraction, the python config-gate extraction, the python child-supervisor extraction, and the analyzer Remote/RPC extraction.

A structural survey of the seven in scope found that size is not what makes them hard to split. Every one already has visible cuts — module-level pure functions, already-extracted helpers, section boundaries a reader can see. What none of them had was a settled answer to **where a cut boundary belongs**, and several carry explicit contracts that a naive split would break silently:

- `code-runtime-python` had two `/* jscpd:ignore-start */` blocks whose comments declare a shape parallel to its sibling worker-thread backend: the constructor/teardown/run shape and the timer/abort/live-set block. Measured 2026-09-15 by removing each block's markers in turn: the first still suppresses a real clone (without it, 24 lines and 88 tokens match the sibling's constructor and teardown), while the second suppresses nothing — the two backends' timers, abort listeners, and live-run records no longer match token for token. The second pair was retired when its region moved to `src/supervisor.ts`, leaving a comment that states the parallel; the first is unchanged and still load-bearing. `fixture.ts` carries no such block; the package's only one is in `fixture-projections.ts`, which mirrors host timing without importing a target implementation.
- `fixture.ts` deliberately re-implements host behavior rather than importing it, so a web client package does not acquire host dependencies. A split that "deduplicates" by importing would pull host packages into the client bundle — the exact regression the file was written to avoid.
- `code-runtime-python` has no `src/types.ts`, so the vocabulary its cut pieces would share has no home; giving it one collides with the exception already recorded for Issue #99. `ui-trajectory` had none either and gained one in its batch-1 cut, the same way `analyzer` did.
- Tests import internal symbols through source paths (`code-runtime-python/tests/runtime.spec.ts` from `../src/index.ts`; `ui-trajectory/tests/table.client.spec.tsx` from `../src/client/TrajectoryTable.tsx`), so a split has to keep the entry module re-exporting what it re-exports today.

Left unanswered, those four questions get re-litigated in each review, and the answers drift between files. The order by size also points the wrong way: the largest file is among the least safe to cut first.

## Decision

The four boundary questions are settled once and reused by every batch, and the batches are ordered by how much of a file's behavior a cut has to preserve.

### Four rules that hold across every batch

1. **A `jscpd:ignore` block is a two-sided contract.** Cutting one side requires the matching cut on the other side in the same change, or an explicit amendment of the comment explaining why the symmetry no longer holds. This applies to `code-runtime-python` ↔ `code-runtime-worker-thread` (constructor/teardown/run shape, and the timer/abort/live-set block) and to whichever sibling each remaining `jscpd:ignore` block names.
2. **`fixture.ts` mirrors, it does not import.** Cuts inside it extract *within* the file. Any change that would make it import a host package is out of scope, however much duplication it would remove.
3. **New shared vocabulary lands in `src/types.ts`.** Where a package lacks that file, creating it is part of the batch that first needs shared vocabulary, and the change cites the Issue #99 exception for runtime values living there. The entry module keeps re-exporting everything it exports today.
4. **A cut that cannot keep the entry module's export list stable is not a batch-1 cut.** Moving a symbol the entry re-exports is fine; dropping one is not.

### Batch 1 — the extraction that preserved behavior by construction

Each item moved code that was already self-contained: no instance state, no new interfaces, no behavior change. The entry module re-exports what moved.

| Package | Cut | Lines (estimated → landed) |
| --- | --- | --- |
| `code-runtime-python` | Byte-cost and truncation vocabulary → `src/cost.ts`; log ledger → `class OutputLedger` | ~200, ~270 → 131, 619 |
| `ui-trajectory` | Record projection layer → `trajectory-record-model.ts`; six presentation-helper families to their own files; the shared record vocabulary → a new `src/types.ts` | ~260, ~1050 → 248, 1045, plus a 94-line `types.ts` |
| `core/session` | Validators and header handling → `validation.ts` | ~365 → 345 |
| `analyzer` | Node-text helpers, `package.json` exports parsing, path utilities | ~250 each → 397, 111, 201, plus a 26-line `types.ts` |
| `acp` | Cursor codec cluster | ~56 → 75 |
| `ptc` | JSON presentation cluster; flavor table and resolver | ~90, ~107 → 103, 110 |

The pilot was `code-runtime-python`, because its ledger cut has the strongest single piece of evidence in the repository: the sibling backend `packages/code-runtime/code-runtime-worker-thread/src/index.ts` already had an extracted `OutputLedger`. The two could be compared for the same boundary cases, and the package exports only `.` while being `private: true`, so the published surface could not move. [The cost/ledger extraction note](../../implemented/simplification/2026-09-14-code-runtime-python-cost-and-ledger.md) records what the cut produced and what it cost.

### Batch 2 — cuts that needed an interface settled first

- `code-runtime-python`: the fd-3 frame reader [landed](../../implemented/simplification/2026-09-14-code-runtime-python-frame-reader.md) with a frame callback carrying only the rebuilt frame — no consumer reads a frame's raw byte length, so the protocol this bullet predicted it needed was not built; the ledger's contract with the `log` frame branch is two-way, because the branch reports back that truncation occurred.
- `ui-trajectory`: the inspector `<aside>` [landed](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md) as `RecordInspector` (~550 lines, about 10 values and 4 callbacks), with a `useResizeHandle` for its pointer-capture drag.
- `core/tools` `ptc.ts` and `acp/acp`: the remaining oversized-method bodies, once batch-1 extractions had shrunk them. `ptc.ts`'s became the batch-3 dispatch-pool cut below; `acp`'s `apply` remains 341 lines.
- `fixture.ts`: the history script `buildAlphaLog`, then the projection fold family, both [landed](../../implemented/simplification/2026-09-14-fixture-history-module-extraction.md). The in-memory file system [landed](../../implemented/simplification/2026-09-14-fixture-file-system-module-extraction.md) and settled this batch's interface question for that file: a cluster takes the world's values as parameters and owns the state it mutates. The three remote clusters that capture one world-state binding each [landed](../../implemented/simplification/2026-09-14-fixture-configuration-remotes-extraction.md) against that template, whose degenerate case is a zero-parameter factory. The `rpc` dispatch table [landed](../../implemented/simplification/2026-09-14-fixture-rpc-dispatch-extraction.md) behind a `FixtureRpcDeps` list declared where its member types live; `fixture.ts` is 2288 lines.

### Batch 3 — cuts that sit on semantics, each with its own evidence

Each of these landed only once it could show what it preserved.

- `ptc.ts` dispatch pool: the ordered commit lane, the exclusive barrier, backpressure, and the wakeup-order defense are all behavior, not structure. [Landed](../../implemented/simplification/2026-09-15-ptc-dispatch-pool-extraction.md) into `src/ptc-dispatch-pool.ts` — `DispatchPool` takes `{ maxParallel, isRunOver }`, the transport submits, tracks side work, and drains, and `tests/ptc-dispatch-pool.spec.ts` drives the lane through eight cases; `ptc.ts` is 372 lines.
- `core/session`: the three incremental folds [landed](../../implemented/simplification/2026-09-14-session-folds-extraction.md) into `src/folds.ts` — `SessionFolds` takes the log array by reference and the surface, `Session` keeps three one-line delegations, and `index.ts` is 904 lines. The `Session` class [landed](../../implemented/simplification/2026-09-15-session-object-extraction.md) into `src/session.ts` with the `attachments`/`SessionEntry` pair it must stay co-located with, and the two listener-dispatch helpers both publication paths call moved to `src/observers.ts`; the `@typert object` type string stays byte-identical in the store's registration, and `index.ts` is 488 lines.
- `code-runtime-python`: the config gates [landed](../../implemented/simplification/2026-09-15-python-config-gates-extraction.md) into `src/config.ts` — `Config`, the bounds the gates check, `resolveRuntimeConfig`, `resolveInterpreter`, `resolvePythonBin`, `hostFrameParseCeiling`, and `pythonEnvironment` — and the process supervisor [landed](../../implemented/simplification/2026-09-15-python-child-supervisor-extraction.md) into `src/supervisor.ts`: `superviseChildRun` takes one run's inputs through `ChildRunDeps` and owns the spawn, fd-3 frames, reply channel, timing and abort wiring, kill escalation, and settlement. `index.ts` is 364 lines, and the wiring block's `jscpd` markers were retired there on measurement (they suppressed no clone).
- `ui-trajectory`: the row renderer [landed](../../archived/simplification/2026-09-15-trajectory-row-extraction.md) as a memo `TrajectoryRow` whose selection, section, and timeline-focus markers are ledger-computed primitives, with three cases counting row renders to pin the boundary this bullet names as the risk. The module was removed by the 2026-11-04 upstream sync; rows now render inside `TrajectoryTable.tsx`.
- `analyzer`: the `Remote`/RPC analyzer and the type modeler rejoined batch 3 after a spell in batch 2, and the reading that moved them is the evidence they were missing. `allocateNodeId` mints `type:<file>:<line>:<column>#<ordinal>`, where the ordinal is a per-location counter incremented on every call, so an id is a function of **visit order at one source position** rather than of the type. Two sites make that order hard to predict: `resolvedRemoteCodecType` allocates inside its own `convert` closure against its own `completed`/`active` caches — one authored site yields `#1`, `#2`, `#3` by cache-miss order — and `convertType` allocates before recursing, so a union and its first member, which share `getStart()`, are ordered by call order rather than by structure. Both clusters write the same five maps (`nodes`, `declarations`, `declarationStates`, `crossFaceLinks`, `nodeOrdinals`), and `ensureDeclaration` re-enters across calls behind a `declarationStates` guard. `tests/__snapshots__/type-model.spec.ts.snap` records 578 occurrences of these ids, 282 of them distinct, so a reordered visit renames ids and arrives as a snapshot diff instead of a failure. The cut could not start until a test pinned `allocateNodeId`'s id stability against a reordering it must survive. [Pinned](../../implemented/testing/2026-09-15-node-id-stability.md): `tests/node-id-stability.spec.ts` pins every shared-start position in both fixtures by hand, with the type that took each ordinal. [Landed](../../implemented/simplification/2026-09-15-analyzer-type-graph-extraction.md): the type modeler is `src/type-graph.ts` (`class TypeGraph`, 875 lines), which owns `nodes`, `declarations`, `declarationStates`, and `nodeOrdinals` behind `declarationModels()`, `nodeModels()`, `setNode()`, and `setDeclaration()`, together with the id allocation and the two codec-side writes that used to reach those maps directly. [Landed](../../implemented/simplification/2026-09-15-analyzer-remote-analyzer-extraction.md): the Remote/RPC analyzer is `src/remote-analyzer.ts` (`class RemoteAnalyzer`, 1025 lines) behind `RemoteAnalyzerDeps` — the checker, the face program, the graph, `registrationForFile`, and the program's parsed source files — and `validateInvocationIdentity` is an exported function of the face and its analyzed packages, which is what made that check testable without a workspace; `analyzer.ts` is 1253 lines, and the three calls that leave the file for the graph's state are the codec's `allocateNodeId`, `setNode`, and `setDeclaration`.

## Alternatives considered

- **Follow Issue #86's order by size.** Rejected: the largest file carries the mirroring constraint that makes it one of the least safe first cuts, and the second-largest is a pure build-time library whose risk is snapshot drift rather than size. Order by how much behavior a cut must preserve instead.
- **Split `fixture.ts` by importing the host implementations it mirrors.** Rejected: it would add host package dependencies to a web client bundle, reversing the decision the file records in its own comments.
- **Cut only the `jscpd:ignore` blocks in one backend.** Rejected: those comments declare a symmetry with the sibling backend. Breaking it silently converts a documented contract into an undocumented difference.
- **Extract a large piece whenever a file exceeds a line threshold.** Rejected: size alone does not say which boundary is safe. `core/session` is not a persistence-mixing file — persistence already lives in its own packages — and splitting it as though it were would move the wrong pieces.
- **Introduce a translation context in `ui-trajectory` to shorten the prop lists.** Rejected: every component in the package takes `t` as an explicit prop today. Adding a second mechanism to make one split cheaper forks the package's style.
- **Do the whole batch 1 at once across six packages.** Rejected: the four rules above were the note's actual deliverable, and a pilot is what tests whether they hold. Six parallel changes would have put the rules into six reviews before any one of them was confirmed.

## Consequences

Every batch landed as its own pull request, the pilot alone before the rest of batch 1. Each one met the same bar: the touched package's entry module exports the same names it did before, no test needed a new import path, and the package's own tests, `pnpm run typecheck`, and the documentation gates passed. Batch 1 changed no behavior — no constant, default, or schema value moved. This note moved to `implemented/` when batch 3 landed, its last item being the analyzer's Remote/RPC slice.

- **Symmetry debt.** Every `jscpd:ignore` block touched without its counterpart would have left a declared contract unstated. The rules require the pair or an amended comment, and the one block that changed was retired on measurement; a reviewer still has to check the next one.
- **Performance regression behind a structural win.** The `ui-trajectory` row renderer is the clearest case: the split can look cleaner and cost frames. Three render-count cases pin the memo boundary it moved behind.
- **Snapshot drift.** No longer hypothetical for `analyzer.ts`: `type-model.spec.ts.snap` records 578 occurrences of `allocateNodeId`'s ids, and each id's ordinal comes from visit order at its source position. `tests/node-id-stability.spec.ts` now fails by name where the snapshot would only have shown a diff.
- **Vocabulary collisions with Issue #99.** Creating `src/types.ts` files resolves the missing-home problem but re-opens a settled question; each such change cites the existing exception rather than arguing it again.
- **Churn without benefit.** Splitting for its own sake moves lines without making anything easier to change. Each cut's justification — a test that became possible, an interface that became explicit, or a method that became readable — is recorded in that cut's own note.

## Related

- `.agents/audits/2026-09-11-tech-debt-issue-manifest.md` Issue #86
- `docs/TECH_DEBT.md` (M6, and the ledger entry that names the two files the audit missed)
- [Extracting the session's incremental folds](2026-09-14-session-folds-extraction.md) (batch 3's first landed cut)
- [Extracting the `run_code` sub-dispatch lane](2026-09-15-ptc-dispatch-pool-extraction.md) (batch 3's second landed cut)
- [Extracting the `Session` object and the publication observers](2026-09-15-session-object-extraction.md) (batch 3's third landed cut)
- [Extracting the trajectory ledger's row](../../archived/simplification/2026-09-15-trajectory-row-extraction.md) (batch 3's fourth landed cut)
- [Extracting the analyzer's type graph](2026-09-15-analyzer-type-graph-extraction.md) (batch 3's fifth landed cut)
- [Extracting the python backend's load-time gates](2026-09-15-python-config-gates-extraction.md) (batch 3's sixth landed cut)
- [Extracting the python backend's child supervisor](2026-09-15-python-child-supervisor-extraction.md) (batch 3's seventh landed cut)
- [Extracting the analyzer's Remote/RPC analyzer](2026-09-15-analyzer-remote-analyzer-extraction.md) (batch 3's eighth landed cut)
- `packages/code-runtime/code-runtime-worker-thread/src/index.ts` (the `OutputLedger` precedent)
- `packages/experimental/code-runtime-python/src/index.ts`, `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`
