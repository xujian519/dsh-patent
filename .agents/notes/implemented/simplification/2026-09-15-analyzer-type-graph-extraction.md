# Agent Note: Extracting the analyzer's type graph (Issue #86)

Status: implemented

English | [中文](2026-09-15-analyzer-type-graph-extraction.zh.md)

## Problem

`packages/typert/generator/src/analyzer.ts` was 2806 lines and held two clusters in one `FaceAnalyzer` class: the Remote/RPC analyzer (markers, gateways, boundaries, codec types, invocations, and the type-meta lookup declarations) and the type modeler (`convertType`, `members`, `signature`, `ensureDeclaration`, `targetForReference`, and the id allocation under them). Both wrote the same four private maps — `nodes`, `declarations`, `declarationStates`, and `nodeOrdinals` — and the remote cluster reached them directly at two sites with ids it minted itself (`#remote-codec:`), so neither side owned the state.

[The split plan](../../implemented/simplification/2026-09-14-god-file-split-plan.md) holds this cut in batch 3 and names what makes it hard: `allocateNodeId` mints `type:<file>:<line>:<column>#<ordinal>`, so an id is a function of visit order at one source position, and the cut could not start until a test pinned that order. That test [landed first](../../implemented/testing/2026-09-15-node-id-stability.md).

## Decision

`packages/typert/generator/src/type-graph.ts` (875 lines) exports `class TypeGraph` and `TypeGraphDeps`; `analyzer.ts` is 2206 lines; `src/types.ts` gains the vocabulary the two modules share.

| Moved | Form in the new module |
| --- | --- |
| `nodes`, `declarations`, `declarationStates`, `nodeOrdinals` | `TypeGraph`'s private state, read through `declarationModels()` and `nodeModels()` |
| `allocateNodeId`, `addNode`, `referenceNode` | `TypeGraph` methods; the two codec-side writes became `setNode(id, model)` and `setDeclaration(id, model)` |
| `convertType`, `members`, `memberBase`, `memberIdentity`, `signature`, `typeParameters`, `mergeTypeParameters`, `requiredType`, `inferType`, `enumMembers`, `heritage`, `convertHeritage`, `ensureDeclaration`, `targetForReference` | `TypeGraph` methods, moved verbatim |
| `location`, `locationKey`, `fail`, `symbolId`, `resolveSymbol`, `symbolAtType`, `packageNameForFile`, `isTypeMetaSymbol` | `TypeGraph` methods; `isTypeMetaSymbol` leaves the remote cluster because only `members` reads it |
| `AnalysisMode`, `ParsedConfig`, `PackageRegistration`, `SourceEdit`, `PackageImport`, `SourceEditQueued` | `src/types.ts`, re-exported from `analyzer.ts` where they were public before |

### The dependency list is the seam

`TypeGraphDeps` carries ten values: the root, the face, the checker, `allRegistrations`, the mode, `queueEdit`, and four callbacks into the package analyzer — `registrationForFile`, `packageExportName`, `packageImportOf`, and `recordCrossFaceLink`. A measurement of the moved set's outgoing calls found those four callbacks and nothing else, so the graph never reaches back into the analyzer for another reason.

`analyzer.ts` keeps thirteen same-named one-line delegations — `fail`, `location`, `symbolId`, `resolveSymbol`, `symbolAtType`, `isTypeMetaSymbol`, `allocateNodeId`, `convertType`, `addNode`, `referenceNode`, `ensureDeclaration`, `requiredType`, and `signature` — the pattern the session store's folds cut used: 120 call sites stay unchanged, and the graph's public surface is what its consumers ask for.

### What the id-stability test bought

`tests/node-id-stability.spec.ts` pins every shared-start position in both fixtures by hand, with the type that took each ordinal. With it in place the move is checkable: `tests/__snapshots__/type-model.spec.ts.snap` records 578 occurrences of these ids, and the suite compares byte-for-byte, so a reordered visit would arrive as a snapshot diff rather than passing silently. No id, ordinal, declaration, or node changed.

### Verification

| Check | Result |
| --- | --- |
| `pnpm exec vitest run packages/typert/generator` | 9 files / 203 passed, snapshots byte-identical |
| `pnpm exec tsc -p packages/typert/generator/tsconfig.json --noEmit` | exit 0 |
| `pnpm run typecheck` | host lib build plus the client face: exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/typert/generator` | 0 warnings, 0 errors |
| coverage | not gated: `packages/typert/*/src/**` is an existing exemption |

## Alternatives considered

- **Leave the four maps in `FaceAnalyzer` and hand the graph the analyzer.** Rejected: the graph would hold a whole analyzer to reach four maps and the checker, and the ownership question — who may mint an id, and in which namespace — would stay unanswered.
- **Extract the Remote/RPC cluster first.** Rejected on measurement: from inside its own body it calls thirteen of the graph's methods (`convertType`, `addNode`, `requiredType`, and `allocateNodeId` among them) against three call sites of its own elsewhere, so extracting it first would have rewritten the same seam twice.
- **Split the two clusters with no shared owner.** Rejected: both write the same four maps, and the codec path already mints ids in a namespace of its own; two owners would make that duplication permanent.
- **Put the shared vocabulary in a new module rather than `types.ts`.** Rejected: `types.ts` already holds the vocabulary the split modules read (`TypertAnalysisError`, `ModuleIdentity`, `ReferenceSite`, `EMPTY_DOCUMENTATION`) and says so in its module comment; a second home for one role would split the answer.

## Consequences

`analyzer.ts` loses 600 lines and `type-graph.ts` is 875, so the net growth is the deps interface, the accessors, the delegations, and their JSDoc. The state both clusters write has one owner and a documented id-allocation rule, and the second cluster's cut is now measured at three external call sites. Batch 3's remaining item is `code-runtime-python`'s config gates and process supervisor, whose `jscpd:ignore` symmetry with the worker-thread backend has to be decided before either side moves.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan; this is batch 3's fifth landed cut)
- [Pinning the analyzer's node ids](../testing/2026-09-15-node-id-stability.md) (this cut's precondition)
- [Extracting the `Session` object and the publication observers](../../archived/simplification/2026-09-15-session-object-extraction.md) (batch 3's third landed cut)
- `packages/typert/generator/src/type-graph.ts`, `packages/typert/generator/tests/node-id-stability.spec.ts`
