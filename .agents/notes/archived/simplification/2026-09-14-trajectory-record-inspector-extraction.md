# Agent Note: Extracting the trajectory ledger's record inspector and resize handle (Issue #86)

Status: implemented
Archived: 2026-11-07

English | [中文](2026-09-14-trajectory-record-inspector-extraction.zh.md)

## Problem

After batch 1, `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` was 1768 lines. The view itself — the virtualizer wiring, the table, the scroll and follow effects — occupied the first two thirds. The last third was one JSX region: the inspector `<aside>` at 552 lines, whose opening condition asked whether a record or a request was selected.

That region was not self-contained. Every value it rendered was computed in the enclosing `TrajectoryTable` body, mixed with values the table also needs: 27 derivations from `selected`, `selectedRequestInfo`, and `allRecords` sat between the row rendering and the JSX that consumed them, because the component body is one scope. The separator's pointer-capture drag made this worse in a different way: 67 lines of `onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel`/`onKeyDown`/`onDoubleClick` were written as JSX attributes, between the `<aside>` opening tag and the header it renders above.

The plan names this cut as batch 2's `ui-trajectory` item: the inspector as `RecordInspector`, plus a `useResizeHandle` for the drag. Unlike batch 1, it needs an interface settled first, because the boundary between the two components is exactly the set of values the entry computes and the inspector reads.

## Decision

Four modules now hold the inspector and the vocabulary it shares with the entry. `src/client/TrajectoryTable.tsx` is 921 lines.

| Module | Lines | Owns |
| --- | --- | --- |
| `src/client/trajectory-record-inspector.tsx` | 732 | `SelectedRequest`, `RecordInspectorProps`, `RecordInspector`, and the private `OverviewSection` |
| `src/client/trajectory-resize-handle.ts` | 159 | `DetailsResizeHandlers`, `DetailsResizeHandle`, `useResizeHandle`, the nine resize constants, `clampDetailsWidth`, `defaultToolRequestWidth` |
| `src/client/trajectory-kind.tsx` | 96 | `KIND_LABEL_KEY`, `KIND_ICON`, `ToolWrenchIcon`, `InformationIcon`, `CompactedIcon` |
| `src/client/trajectory-detail-tabs.ts` | 80 | `DetailTabItem`, `SYSTEM_PROMPT_TABS`, `SYSTEM_UPDATE_TABS`, `REQUEST_TABS`, `detailTabs`, `requestDetailTabs` |

### The inspector computes its own derivations

The first interface design passed the values down: the entry keeps its 27 derivations and hands the inspector the ones it renders. That is about 23 values plus 6 callbacks, and it leaves the entry computing values nothing else in it reads — the same coupling as before, now spelled out as a prop list.

`RecordInspectorProps` has 18 members instead: 12 values and 6 callbacks. The values are inputs, not derivations — `allRecords`, `currentRecord`, `requestNumbers`, `sessionRequestNumbers`, `selected`, `selectedRequest`, plus `activeTab`, `thinkingExpanded`, `detailsWidth`, `resizeHandlers`, `t`, and `renderImages`. Every one of the 27 derivations moved into the inspector body, unchanged, and so did the private `OverviewSection` it renders them through. The entry keeps three of them — `selectedRequestInfo`, `activeTurn`, `activeSection` — plus `splitStyle`.

`activeSection` is the one derivation the move had to rewrite rather than relocate. The entry computed it as `selectedRequestRecords[0]?.section`, and `selectedRequestRecords` no longer exists there. It is now `allRecords.find(record => record.turn === selectedRequestInfo.turn && record.group === selectedRequestInfo.group)?.section`, which is the same element: `selectedRequestRecords` is `allRecords.filter(…).map(currentRecord)` over that same predicate, and `currentRecord` replaces only the `cell` field, never `section`.

### The resize drag becomes a hook with a return type

`useResizeHandle` owns the two `useState` values (`detailsWidth`, `toolRequestOffset`) and the drag `useRef`, and returns them with a `handlers` object. Both state values had exactly one writer and no reader outside the drag before this cut, so they are fully internal to the hook; the entry reads `toolRequestOffset` to build `splitStyle`, and the inspector reads `detailsWidth` for its width.

The separator element spreads `{...resizeHandlers}` instead of naming six attributes. The handlers read the separator's ancestors — its parent is the inspector, whose width they resize, and its grandparent is the split container that bounds it — so the hook needs no element argument and the JSX keeps its structure.

### The shared vocabulary had to leave the entry

The entry imports the inspector, so the inspector cannot import the entry: `detailTabs`, `DetailTabItem`, and `KIND_LABEL_KEY` are read on both sides and had to land in modules neither of them owns. `trajectory-detail-tabs.ts` takes the tab vocabulary; `trajectory-kind.tsx` takes `KIND_LABEL_KEY` beside `KIND_ICON`, which only the entry reads but which is built from the same three icon glyphs and belongs with them.

`requestDetailTabs(hasOptions)` is new, and it is the entry's old inline expression lifted into a named function: `REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)`. The three tab tables stay module-private in `trajectory-detail-tabs.ts`; only the two functions that read them are exported.

### Constants moved in this cut, unlike batch 1

[The batch-1 note](2026-09-14-trajectory-ledger-module-extraction.md) records that the three tab tables stayed in the entry, because batch 1's acceptance criterion is that no constant moves. That rule is batch 1's, and this cut is batch 2: the nine resize constants moved with the only code that reads them, and the tab tables moved with `detailTabs` and `requestDetailTabs`.

The reason the batch-1 note gave for keeping the tables also expired. It rested on `REQUEST_TABS` having a direct entry-side reader in the tab-strip JSX. That JSX is inside the inspector now, so both readers of all three tables are in the new module.

### The move is behavior-preserving, and checked mechanically

The `<aside>` region and the 27 derivations were extracted as text, then compared against the original with a normalized diff. Names that the inspector's props rename — `activateTab` → `onActivateTab`, `clearInspectorSelection` → `onClearSelection`, `openRecordSummary` → `onOpenRecordSummary`, `openCallSummary` → `onOpenCallSummary`, `selectRequest` → `onSelectRequest`, `setThinkingExpanded` → `onThinkingExpandedChange` — were mapped back before comparing, and the resize-handler attribute block that the hook replaces was excluded. The result is 0 differing lines on the JSX region and 2 expected differences on the derivations: the two entry-side lines (`activeTurn`, `activeSection`) that stayed behind, and a type annotation on `selectedTabs`.

That annotation is the only edit inside the moved text: `selectedTabs: readonly DetailTabItem[]`, because `requestDetailTabs` returns a named type where the inline `filter` inferred an anonymous array type.

## Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --noEmit` | clean |
| `pnpm exec vitest run packages/client/ui-trajectory` | 9 files / 149 passed — the count before the cut |
| `pnpm exec vitest run packages/client` | 531 files / 7150 passed, 5 skipped |
| `pnpm exec tsc -b tsconfig.client.json` | exit 0, no diagnostics |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory/src` | clean |
| `pnpm exec tsx scripts/verify-export-jsdoc.ts` | passes |
| `pnpm run duplication` | 0 clones across 2205 files |
| `pnpm run test:docs` | 18 passed, 0 failed |
| normalized diff of the `<aside>` region | 0 differing lines |
| normalized diff of the 27 derivations | 2 expected differences, both outside the moved text |

Batch 2's acceptance criteria hold. The entry exports the same four names — `TrajectoryTable`, `TrajectoryTableProps`, `TrajectoryRequestNumber`, `TrajectoryUsage` — and `tests/table.client.spec.tsx` still imports `../src/client/TrajectoryTable.tsx`. The package's `./client` subpath never named this module.

`verify-export-jsdoc` scans `packages/*/*/src/**/*.ts` and not `.tsx`. Two of the four new modules are `.ts` (`trajectory-detail-tabs.ts`, `trajectory-resize-handle.ts`); their seven exports gained the required JSDoc, as did the interface members with a non-obvious contract. The other two are `.tsx` and stay outside the gate, as the entry they came from did.

The per-file coverage gate does not apply here, for the reason the batch-1 note records: `vitest.config.ts` lists `packages/client/ui-trajectory/src/*`, whose test-exclude expansion covers the whole source subtree, so the reported coverage never contained this package's files. The package README needed no edit — it describes the view's behavior and the inspector's contents in one sentence, with no module inventory.

## Alternatives considered

- **Passing the derivations down as props.** Rejected: it makes the prop list carry what the inspector can compute from data it already has, and it leaves 23 single-reader derivations in the entry. The chosen split moves the derivations with their only reader and keeps the prop list at 18.
- **Keeping `SelectedRequest` in the entry and importing it from the inspector.** Rejected: this is the cycle the cut exists to avoid — the entry imports the inspector for `RecordInspector`, and the inspector would import the entry for the type.
- **A `trajectory-inspector-types.ts` for the shared vocabulary instead of two topic modules.** Rejected: the shared names are not one vocabulary. `detailTabs` and its tables are tab selection; `KIND_LABEL_KEY` and `KIND_ICON` are cell presentation. One module for both would be named for neither.
- **Leaving the three tab tables in the entry and exporting them to the inspector.** Rejected: `SYSTEM_PROMPT_TABS` and `SYSTEM_UPDATE_TABS` have no entry-side reader, and exporting the tables would widen the entry's export list past the four names batch 2 requires it to keep.
- **Keeping `KIND_ICON` in the entry and moving only `KIND_LABEL_KEY`.** Rejected: both are keyed by the same `TrajectoryCellKind` and `KIND_ICON` is built from the three glyph components that have no other reader. Splitting one map from the other would have left three glyph components in the entry with a single consumer that lives elsewhere.
- **Splitting the CSS module so the inspector stops importing `TrajectoryTable.module.css`.** Rejected: it would move class-name ownership in the same cut that moves JSX, and the stylesheet is not what made the file hard to read. A later cut can settle where the inspector's class names live.
- **Folding the inspector's early return into a wrapper component.** Rejected: the guard was the entry's JSX conditional, and a wrapper would add a component whose only job is to re-check a condition the inspector already has the inputs for. It is an early return after the `useMemo`, which is where the hooks rule puts it.

## Consequences

The entry loses 884 lines and gains 37 — imports, the `useResizeHandle` call, the three staying derivations, and the `<RecordInspector>` element — for a net 847. The four new modules total 1067 lines. Nothing was deleted: every moved line is present under its original name, apart from the six renamed callbacks and the one type annotation.

The interface that this cut had to settle is now declared: `RecordInspectorProps` names the 18 inputs the panel needs, and `DetailsResizeHandle` names what the separator owns. Both were previously implicit in a 1768-line closure. That is this cut's justification under the plan's standard — not a test that becomes possible, but an interface that becomes explicit.

The inspector is the largest module in the package now, at 732 lines of JSX. It is still one component with one early return; splitting its tab panels into components would settle where the class names and the `t` seat live, which this cut left alone.

Two asymmetries the cut preserves rather than creates. `trajectory-detail-tabs.ts` is a `.ts` module that imports `isMarkdownRecord` from a `.tsx` module, because `detailTabs` branches on whether a record renders as Markdown; the alternative was duplicating that predicate. And `trajectory-kind.tsx` exports a record of React nodes, so it is `.tsx` while its neighbour is `.ts` — the two files hold the two halves of one vocabulary, one pure and one rendering.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan; this is its batch-2 `ui-trajectory` inspector item)
- [Extracting the trajectory ledger's record model and presentation helpers](2026-09-14-trajectory-ledger-module-extraction.md) (batch-1 sibling; settled `src/types.ts` as the package's vocabulary home, and kept the tab tables in the entry under batch 1's no-constant-moves rule)
- [Extracting the python runtime's cost and log-ledger modules](2026-09-14-code-runtime-python-cost-and-ledger.md) (the batch-1 pilot)
- `packages/AGENTS.md` (where a package's seam vocabulary lives)
