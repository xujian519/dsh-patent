# Agent Note: Extracting the trajectory ledger's record model and presentation helpers (Issue #86)

Status: implemented

English | [中文](2026-09-14-trajectory-ledger-module-extraction.zh.md)

## Problem

`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` reached 3208 lines and 110 top-level declarations. Only the last of those declarations is the view: `TrajectoryTable` and the three helpers it owns directly (`useStableVirtualRowStructure`, the resize-drag state, and the Overview section). Everything above it is module-level: the record projection that turns grouped turns into ledger rows, the vocabulary those rows are typed with, and six families of presentation helpers that map a record to its rendered parts.

The file had one visible ordering property working against it. Declarations are grouped by topic, not by who calls whom, so a reader changing how a request's failure text is displayed had to find `requestErrorMessage` among 3200 lines that also hold the virtualizer wiring and the pointer-capture drag. The six presentation families do not call each other; the projection layer does not call any of them.

[The split plan](../../implemented/simplification/2026-09-14-god-file-split-plan.md) names this cut as batch 1's `ui-trajectory` item. This note records what the cut produced.

## Decision

Eight modules now hold the file, and `src/client/TrajectoryTable.tsx` was 1768 lines when this cut landed. Every one of the 110 declarations kept its name and its body: the moved ranges are byte-identical to the code that left the entry, and the 38 declarations that stayed are byte-identical to what they were, apart from the import wiring the entry now needs.

| Module | Lines | Moved | Owns |
| --- | --- | --- | --- |
| `src/types.ts` | 136 | 94 | `TableRecord`, `DetailTab`, `RecordState`, `ParentRecords`, `TrajectoryRequestNumber`, `TrajectoryUsage`, `jsonTreeLabels`, `markdownLabels` |
| `src/client/trajectory-record-model.ts` | 363 | 248 | 16 declarations: the projection (`flattenRecords`, `filterRecords`), the request indexes (`requestKey`, `requestIdentity`, `indexRequestBoundaries`, `indexRequestNumbers`, `indexRequestBoundaryRuns`), the folds (`collapseTurnRecords`, `collapseAssistantRecords`), and the per-record readers (`stateOf`, `statusLabel`, `requestErrorMessage`, `sectionLabel`, `assistantToolCalls`) |
| `src/client/trajectory-usage-panel.tsx` | 115 | 102 | `TokenRows`, `inputTotal`, `UsageRows`, `RequestUsagePanel` |
| `src/client/trajectory-timing.tsx` | 154 | 132 | `formatDurationMs`, `formatStartedAt`, the `StartedAtValue` control, `totalTime`, `ttft`, `generationTime`, `throughput`, `AssistantTimingPanel`, `RecordTiming`, `RequestTiming`, `clickSelectsText` |
| `src/client/trajectory-record-presentation.tsx` | 220 | 193 | `messageSourceLabel`, `MessageSource`, `isMarkdownRecord`, `parentRecords`, `markdownSource`, `recordDisplayText`, `recordResultText`, `toolCallTextParts`, `isToolCallOnly`, `RecordPresentationValue`, `ToolCallTextParts`, `RecordPresentation`, `RecordListText` |
| `src/client/trajectory-markdown-content.tsx` | 291 | 270 | `MarkdownFragment`, `SourceBlocks`, `recordImages`, `MessageImages`, `AssistantToolCalls`, `MarkdownRecordContent` |
| `src/client/trajectory-prompt-diff.tsx` | 143 | 126 | `ToolGlyph`, `ToolCatalog`, `PromptDiffLine`, `promptDiffLines`, `PromptDiffSection`, `SystemPromptDiff` |
| `src/client/trajectory-record-payload.tsx` | 240 | 222 | `RequestOptions`, `ToolOutputBlocks`, `RecordPayload`, `RecordSchema`, `ParsedToolSchema`, `parseToolSchema`, `parseJsonContainer` |

### The cut is behavior-preserving by construction

The moved ranges were compared declaration by declaration against the original with the same span algorithm on both sides. All 110 declarations appear under their original names in the new tree; no declaration is missing and none was renamed. The 1387 moved lines are byte-identical, and so are the 38 entry-side declarations. No function body, constant, default, or schema value changed.

One comment travels with the code it describes and keeps its exact form: the three-line note in `trajectory-markdown-content.tsx` recording that the Raw view keeps model block order and granularity, unlike the aggregated record gallery the same file renders elsewhere. The plan's first rule does not apply here — `TrajectoryTable.tsx` contains no `/* jscpd:ignore-start */` block, and the plan's own list never named it.

### The three tab tables stayed in the entry

The first version of this cut moved `DetailTabItem`, `SYSTEM_PROMPT_TABS`, `SYSTEM_UPDATE_TABS`, and `REQUEST_TABS` into `trajectory-record-presentation.tsx` with `detailTabs`, which reads them. That was wrong, and the plan's own batch-1 rule is what caught it: **no constant moves in batch 1.** A `readonly DetailTabItem[]` table is a constant value, and `REQUEST_TABS` is additionally read by the entry's own tab-strip JSX, not only by `detailTabs`.

All five declarations are back in the entry. The check that settles it is mechanical: the three tables are referenced only by `detailTabs`, `detailTabs` is referenced only by `TrajectoryTable`, and `REQUEST_TABS` is referenced by `TrajectoryTable` directly. Nothing outside the entry names any of them, so keeping them costs no import edge, and moving them would have put a constant in a module named for presentation helpers.

Batch 2 moved all five into `trajectory-detail-tabs.ts`. The inspector's tab-strip JSX left the entry in that cut, so both readers of all three tables sit in the new module and batch 1's no-constant-moves rule no longer applies. [That note](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md) records the move.

### Why the shared vocabulary went to `src/types.ts`

`TableRecord`, `RecordState`, `ParentRecords`, and `DetailTab` are read by the projection layer, the presentation helpers, and the entry's own JSX. Keeping them in the entry while the projection module imports them would have made the import graph cyclic, because the entry imports the projection.

They moved to a new `src/types.ts`, where `packages/AGENTS.md` already places a package's seam vocabulary — "its types plus the runtime values that vocabulary defines." The two runtime values there, `jsonTreeLabels` and `markdownLabels`, are exactly that: constructors the vocabulary defines for the locale-derived label tables the record panels read. The file forwards no other module's runtime value, as that rule requires. The change cites the Issue #99 exception the plan's third rule names, the same way the analyzer's `types.ts` does.

The entry keeps all four of its exports, and they are module-level rather than package-level: `TrajectoryTable` and `TrajectoryTableProps` are consumed by `TrajectoryView.tsx` and by the table spec, and the two type names now leave through `export type { TrajectoryRequestNumber, TrajectoryUsage } from '../types.ts'`. Both consumers still import `./TrajectoryTable.tsx` by the path they used before. The package's `./client` subpath — `src/client/index.ts` — never named this module, so it needed no edit either.

### The export list is compared by name, not by line

The entry declared four exports before the cut and declares the same four now. A line-oriented `grep '^export'` reports "4 before, 3 after", because the old file declared `export type TrajectoryRequestNumber = …` and `export interface TrajectoryUsage` on two lines while the new one re-exports both through a single braced statement — a different line count for the same names. Extracting the names instead of counting lines yields `TrajectoryRequestNumber`, `TrajectoryTable`, `TrajectoryTableProps`, `TrajectoryUsage` on both sides.

### The JSDoc the move had to add

`verify-export-jsdoc` scans `packages/*/*/src/**/*.ts` and not `.tsx`. Two of the eight new modules are `.ts` (`types.ts`, `trajectory-record-model.ts`); the other six are `.tsx` and stay outside the gate, as they were when they lived in `TrajectoryTable.tsx`. The sixteen function exports of the two `.ts` modules gained `@param`/`@returns` blocks — 29 `@param` lines in total — and the six type exports gained a one-line description each. That JSDoc, plus module headers and imports, is the 275 lines the eight new files carry beyond the 1387 lines of moved code.

## Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --noEmit` | clean |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --emitDeclarationOnly` | clean |
| `pnpm exec vitest run packages/client/ui-trajectory` | 9 files / 149 passed — the count before the cut |
| `pnpm run typecheck` | passes, covering the cross-package consumers of the package's `./client` subpath |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory/src` | clean |
| `pnpm exec tsx scripts/verify-export-jsdoc.ts` | passes |
| `pnpm run duplication` | 0 clones across 2205 files |
| byte comparison | all 1387 moved lines and all 38 staying declarations identical; 110 of 110 declaration names present |
| export-name comparison | identical 4 names on both sides |

Batch 1's acceptance criteria hold: the entry exports the same names, no test needed a new import path (`tests/table.client.spec.tsx` still imports `../src/client/TrajectoryTable.tsx`), and no constant, default, or schema value moved.

The per-file coverage gate does not apply here: `vitest.config.ts` lists `packages/client/ui-trajectory/src/*`, whose test-exclude expansion covers the whole source subtree, so the reported coverage never contained this package's files and covering them is not part of this cut's evidence. The package README needed no edit: it describes the view's behavior and carries no module inventory, so no statement in it went stale.

## Alternatives considered

- **Moving the three tab tables into the presentation module.** Rejected and reverted: batch 1 prohibits moving constants, and `REQUEST_TABS` has an entry-side reader that the first version's caller analysis missed because it searched for the name only inside `detailTabs`.
- **Keeping the shared vocabulary in the entry and importing it from `trajectory-record-model.ts`.** Rejected: the entry imports the projection module, so this is the cycle the split exists to avoid.
- **A `trajectory-types.ts` module beside the other new files rather than `src/types.ts`.** Rejected: `packages/AGENTS.md` gives the package's seam vocabulary one home, and the analyzer's cut already established it. A second, differently-named home would make the next package's choice a matter of taste.
- **Splitting the entry's `TrajectoryTable` component in the same cut.** Rejected: the plan puts the inspector `<aside>` and the resize drag in batch 2, where the `RecordInspector` interface and a `useResizeHandle` have to be settled first. Cutting them here would have made that interface design a condition of this move.
- **Merging the six presentation families into fewer modules.** Rejected: they have no edge between them — the usage panel, the timing panel, the record presentation, the Markdown content, the prompt diff, and the record payload each read a record and render it, and none imports another. Merging any two would create an import that does not exist today.
- **Moving `detailTabs` with the tables but leaving the tables behind.** Rejected: `detailTabs` reads all three, and it is called from the entry's tab-strip JSX in two places, so it has to stay where its callers are.
- **Re-exporting the moved helpers from the entry.** Rejected: those the entry does not consume were not exported before, and exporting them now would widen the module's export list beyond the four names batch 1 requires it to keep.

## Consequences

`TrajectoryTable.tsx` came out 1440 lines shorter, and this cut left it holding the view plus the 38 declarations the view owns directly. The cost is the accounting: 1387 lines moved, 1662 lines in the eight new files, and ten lines of import wiring in the entry — nine imports and the two-name re-export — replacing the imports the entry no longer needs. The 275-line growth is module headers, imports, and the JSDoc `verify-export-jsdoc` requires of the two `.ts` modules' exports. Nothing was deleted or rewritten.

The move made the batch-2 cuts measurable. The inspector `<aside>` the plan wants as `RecordInspector` was then the only large JSX region left in the entry, and the six presentation modules it renders through were already separate files, so the interface that cut had to settle was visible without reading the virtualizer. That cut has landed: [the inspector extraction note](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md) records the 18-member `RecordInspectorProps` it settled and the `useResizeHandle` that replaced the drag.

One asymmetry the cut preserves rather than creates: `trajectory-record-presentation.tsx` holds both the record-to-text readers (`markdownSource`, `recordDisplayText`, `recordResultText`) and the React components that render them (`RecordPresentation`, `RecordListText`). Separating the readers into a `.ts` module would have triggered `verify-export-jsdoc` for them and made them importable without the components; that is a shape choice for a later cut, not a boundary this one had to settle.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan; this is its batch-1 `ui-trajectory` item)
- `2026-09-14-analyzer-module-extraction.md` (batch-1 sibling, landing as its own pull request; established the `src/types.ts` home this cut reuses)
- [Extracting the python runtime's cost and log-ledger modules](2026-09-14-code-runtime-python-cost-and-ledger.md) (the batch-1 pilot)
- `packages/AGENTS.md` (where a package's seam vocabulary lives)
