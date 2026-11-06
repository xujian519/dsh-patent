# Agent Note: Extracting the trajectory ledger's row (Issue #86)

Status: implemented
Archived: 2026-11-07

English | [中文](2026-09-15-trajectory-row-extraction.zh.md)

## Problem

`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` was 921 lines, and 255 of them sat inside one `renderedRecords.map` callback: the row's per-record markers, its ARIA attributes, its eleven `data-*` attributes, its three input handlers, and the two cells it renders. Nothing else in the file read those values, and the ledger passed them through a `RecordPresentation` render prop that existed only so the row could compute its own display strings.

[The split plan](../../implemented/simplification/2026-09-14-god-file-split-plan.md) holds this cut in batch 3 and names the risk that keeps it there: the row captures the ledger's derivations and callbacks, passing them explicitly costs roughly 45 props, and a memo boundary handled carelessly re-renders every visible row on each parent render, giving back the virtualizer's benefit.

## Decision

`packages/client/ui-trajectory/src/client/trajectory-row.tsx` (344 lines) exports `TrajectoryRow`, a `memo` component, and `TrajectoryRowProps`; `TrajectoryTable.tsx` is 693 lines.

| Moved | Form in the new module |
| --- | --- |
| the `<tr>`, its `<td className={css.event}>`, and its `<td className={css.content}>` | `TrajectoryRow`'s returned element |
| `isCollapsedSummary`, `isRequestOnly`, `isInitialSystem` | local consts of the row render |
| `request`, `requestInfo`, `requestStatus`, `requestRunIndex`, `requestLabel`, `requestSelected` | local consts of the row render, reading the two request indexes as props |
| `sectionActive`, the selection comparisons, the timeline focus lookup | ledger-computed props (`sectionActive`, `selected`, `timelineFocus`) |
| `RequestBoundaryStyle` | the row module's private style type |
| `RecordPresentation`'s render-prop body | the row, which owns the wrapper |

### Props the ledger derives so the comparison can succeed

`selected`, `sectionActive`, and `timelineFocus` are booleans (or the focus literal) computed in the ledger's map, and `selectedRequestIdentity` replaces the `SelectedRequest` object. Every one of them is a value whose identity a shallow comparison can hold: a selection now re-renders the selected row and the rest of its turn, where the previous structure re-rendered every mounted row. `requestBoundaryRuns` travels to the row as its offset lookup.

### Callbacks that keep their identity

The row receives `onSelectRecord`, `onSelectRequest`, `onToggleTurn`, and `onToggleAssistant`. The first was already a `useCallback`; `selectRequest` and the `activateTab` it depends on became ones. `toggleTurn` and `toggleAssistant` live in `TrajectoryView.tsx` and were plain functions, recreated on every view render; both are `setState`-updater closures, so they take empty dependency lists.

Nothing else changed callback identity. `openRecordSummary`, `openCallSummary`, and `onClearSelection` keep their previous form: no row receives them, and the memo boundary already protects rows from them.

### Tests that become possible, so they were written

`RecordPresentation` is the row's only consumer, so a partial module mock that wraps it counts row renders without changing what the ledger shows.

| Case | Where | What it pins |
| --- | --- | --- |
| a re-render that changes no row input leaves every mounted row alone | `tests/table-row.client.spec.tsx` | the boundary compares equal for all six rows, while the parent really did re-render (the loading status appears) |
| a selection re-renders only the rows whose own inputs changed | `tests/table-row.client.spec.tsx` | exactly two of six rows re-render |
| the view re-renders around mounted rows | `tests/views.client.spec.tsx` | switching timeline mode re-renders the view and no row |

| Mutation | Cases that fail |
| --- | --- |
| `memo` becomes an identity function | all three |
| one row prop becomes an inline arrow | all three |
| `toggleTurn` loses its `useCallback` | the view case |
| `onClearSelection` becomes an inline arrow | none — a table-level prop that no row reads |

The last row is the boundary of this guard, recorded rather than papered over: the guard counts row renders, so a callback only the ledger itself consumes is outside it.

### Verification

| Check | Result |
| --- | --- |
| `pnpm exec vitest run packages/client/ui-trajectory` | 10 files / 152 passed (149 before, plus three new cases) |
| `apps/web/tests/trajectory-virtualization.e2e.ts` (keyless replay, real Chromium, built dist) | 1 passed: selection, prepend identity, mounted-row bound, and every scroll range |
| `pnpm exec tsc -b tsconfig.client.json` | exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory` | 0 warnings, 0 errors |
| coverage | not gated: `packages/client/ui-trajectory/src/*` is an existing `TODO(gui)` exemption, so this file needed no exemption of its own |

## Alternatives considered

- **Pass the ledger's derivations as individual props, as the plan estimated.** Rejected: the row needs `requestInfo`, `requestStatus`, and `requestLabel`, which are three lookups into `sessionRequestNumbers` per row; deriving them in the ledger's map would have traded a 20-entry prop list for a fatter map and the same work.
- **Memoize the row without stabilizing the view's fold callbacks.** Rejected: during streaming the view re-renders on every snapshot, so the two unstable callbacks would compare unequal each time and the boundary would never hold.
- **Stabilize every callback the ledger receives.** Rejected as unneeded: the mutation above shows rows are unaffected by the ones no row reads, so those edits would be unverified churn.
- **Assert the boundary through the DOM instead of a render count.** Rejected: React keeps the same DOM nodes across a re-render either way, so node identity cannot distinguish a skipped render from a repeated one.

## Consequences

`TrajectoryTable.tsx` loses 228 lines and `trajectory-row.tsx` is 344, so the net growth is the props interface, its JSDoc, and the module header. The ledger's row is now a unit with an explicit input list, and the memo boundary that the plan flagged as this cut's risk is pinned by three cases instead of being a comment. Batch 3's remaining items are `code-runtime-python`'s config gates and process supervisor, and `analyzer`, whose id-stability precondition has landed.

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.md) (the plan; this is batch 3's fourth landed cut)
- [Extracting the `Session` object and the publication observers](2026-09-15-session-object-extraction.md) (batch 3's third landed cut)
- [Extracting the record inspector](2026-09-14-trajectory-record-inspector-extraction.md) (batch 2's cut of this file: the `<aside>` panel and its resize drag)
- `packages/client/ui-trajectory/src/client/trajectory-row.tsx`, `packages/client/ui-trajectory/tests/table-row.client.spec.tsx`
