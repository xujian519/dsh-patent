# Agent Note: Pinning the analyzer's node ids (Issue #86)

Status: implemented

English | [中文](2026-09-15-node-id-stability.zh.md)

## Problem

`WorkspaceAnalyzer` mints `type:<file>:<line>:<column>#<ordinal>`. `allocateNodeId` increments a counter held per start location, so an id is a function of the order the analyzer visits the nodes at one source position rather than of the type it names. Two sites make that order hard to predict:

- `convertType` allocates before it recurses, so a form and the node it wraps — which share `getStart()` — are ordered by call order, not by structure: a union and its first member, a conditional and its check type, `Payload['name']` and `Payload`, `string[]` and `string`.
- `resolvedRemoteCodecType` allocates inside its own `convert` closure against its own `completed`/`active` caches, so one authored Remote boundary mints one id per compiler type it converts through that node, ordered by cache miss.

`tests/__snapshots__/type-model.spec.ts.snap` records these ids — 578 occurrences, 282 of them distinct, across 18 shared-start positions in the type-model fixture alone — so a reordered visit renames them and arrives as a snapshot diff rather than as a failure. [The split plan](../../implemented/simplification/2026-09-14-god-file-split-plan.md) makes that the reason `analyzer.ts` sits in batch 3, and the reason its cut does not start until a test pins the order.

## Decision

`packages/typert/generator/tests/node-id-stability.spec.ts` pins every position where the model visits more than one node, as `<file>:<line>:<column>#<ordinal>:<kind>[:<name|literal text>]`:

| Fixture | Pinned | Shape |
| --- | --- | --- |
| `type-model` | 18 positions in `packages/host/src/models.ts` | the outer syntactic form holds the lower ordinal: `8:26#1:conditional,2:reference:T`, `119:10#1:array,2:keyword:string` |
| `remote-model` | 7 positions across `packages/domain` and `packages/remote` | one authored boundary mints up to six ordinals: `15:26#1:reference:AgentId,2:keyword:string,3:reference:AgentId,4:keyword:string,5:reference:AgentId,6:keyword:string` |

The tables are written by hand rather than snapshotted, and each row names the type that took the ordinal, not just its kind — so a moved allocation fails with the source position, the ordinal, and the visitor's destination, and it fails in the case that owns the position.

### What the existing batching test does not cover

`type-model.spec.ts` already compares `analyze()` against `analyzeInBatches(1)`, `analyzeInBatches(2)`, and a reversed package list. That is the other half of the property: it pins that ids do not depend on how the workspace is analyzed, but both sides of each comparison come from the same conversion order, so a reordered visit changes them together and the comparison still passes. The new file pins what the ids are; the two together cover the reorderings the analyzer must survive and the ones that must fail loudly.

### What the guard holds, and what it does not

Four mutations to `analyzer.ts` probe the guard:

| Mutation | Result |
| --- | --- |
| The union allocates after converting its members | caught — the syntactic table changes |
| The array's element is converted before the array's own id | caught — the syntactic table changes |
| The codec's object node allocates after its members | caught — the codec table changes |
| The codec closure allocates before it consults its `completed` cache | not caught — those authored sites never hit the cache, so the extra ids are the only difference and no id changes |

A fifth mutation — converting a union's members before the `add` that publishes the union — is also not caught, and that is the guard's boundary rather than a gap: `convertType` allocates at the top of the function, before any branch, so evaluation order inside a branch cannot move an id. The guard pins **allocation** order, which is what a module cut can change.

## Verification

| Check | Result |
| --- | --- |
| `pnpm exec vitest run packages/typert/generator` | 9 files / 203 passed (201 before, plus the 2 new cases) |
| `pnpm exec tsx scripts/run-oxlint.ts packages/typert/generator/tests/node-id-stability.spec.ts` | 0 warnings, 0 errors |
| the four mutations above, each applied and reverted | `analyzer.ts` byte-identical to its pre-mutation copy afterwards |
| `pnpm run typecheck` | exit 0 |
| `pnpm run test:docs` | 18/18 |
| `pnpm run doc-sync` | 33 passed / 3 failed — the pre-existing doc graphs, config catalog, and package paths failures |

The change adds one test file and no source line, so no coverage exemption moves and the per-file gate over `packages/typert/generator/src` is unchanged.

## Alternatives considered

- **Re-recording a smaller, id-focused snapshot.** Rejected: the plan's complaint is that a reordered visit arrives as a snapshot diff, and a smaller snapshot of the same mechanism has the same failure mode one indirection away — nothing forces a reader to ask why the ids moved.
- **Asserting only the ordinal counts per location, not the identities.** Rejected after mutation testing: counts alone do not distinguish which compiler type took `#1`, so a cut that reorders two conversions yielding the same kind sequence would pass.
- **Asserting that two analyses of the same workspace agree.** Rejected as the primary guard: a reordered conversion is deterministic, so both analyses agree and the assertion passes.
- **Starting the `analyzer.ts` cut in the same change.** Rejected: the plan makes this test the cut's precondition, and the test is only evidence if it exists and passes before the cut moves anything.

## Consequences

`analyzer.ts` is unchanged at 2806 lines. Batch 3's `analyzer` item now has its precondition: the split may start, and this file will fail if the cut reorders the conversion they both depend on. The remaining batch-3 items are `code-runtime-python`'s config gates and process supervisor and `ui-trajectory`'s row renderer.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan whose batch-3 item this unblocks)
- [Extracting the `Session` object and the publication observers](../../archived/simplification/2026-09-15-session-object-extraction.md) (batch 3's third landed cut)
- `packages/typert/generator/tests/node-id-stability.spec.ts`, `packages/typert/generator/tests/type-model.spec.ts`
