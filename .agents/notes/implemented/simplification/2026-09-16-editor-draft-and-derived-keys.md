# Agent Note: Keep the sidebar editor's live text out of React and derive per-row keys once

Status: implemented

English | [中文](2026-09-16-editor-draft-and-derived-keys.zh.md)

## Problem

Three client surfaces recomputed work per event when only the first event of its kind needed it.

**The sidebar editor copied its whole document into React state on every keystroke.** `TextEditor`'s CodeMirror update listener ran `setDraft(update.state.doc.toString())` on every document change, so typing in an N-byte file paid an O(N) string copy plus a component re-render per keystroke, and the same listener's popup bookkeeping wrote an already-hidden popup. `previewText` was worse: `rewriteLocalImageUrls` (five regex passes plus a mask array over the whole document) sat outside `useMemo`, so it ran on every render — including edit mode, where the preview that consumes it is `display: none`.

**The Chat snapshot builder derived sort keys per comparison.** `orderedVisibleChatNodes` called `presentationPosition` twice inside its comparator, allocating two position records and repeating the turn-presentation lookup on every one of the O(R log R) comparisons; `turnProcessPresentations` copied a turn's record (`{ ...current, field }`) once per node it folded; and the structural-change check compared Locations by building a `kind:turn:step` string on both sides.

**The file tree tested its row state by scanning arrays.** Every rendered row ran `expanded.includes(path)` and `revealed.includes(path)`, making the row pass O(rows × expanded) string comparisons on a deep tree.

## Decision

- **The editor owns its live text.** `draftRef` holds the document while dirty, `dirty` stays React state because the host toolbar reads it, and the preview derives `mdText` from that ref when it next renders. Only the clean→dirty transition commits, and `save()` still writes `view.state.doc.toString()`.
- `previewText` moved into a `useMemo` that computes the rewritten source only for a preview render and falls back to the raw source otherwise, matching the `mdBlocks` and `htmlInfo` memos beside it.
- `hidePopup` returns early when no popup is shown, so CodeMirror's per-update hide no longer writes a same-value state.
- `orderedVisibleChatNodes` derives each node's position once per call into `{ node, position }` entries, sorts those, and maps back to nodes; the `key.localeCompare` tiebreak stays.
- `turnProcessPresentations` folds one mutable record per turn, created on first use. `TurnProcessPresentation`'s fields lost `readonly` for that fold; the returned map is still `ReadonlyMap`, and the record's only consumer returns the same result for an empty record as for a missing one.
- The structural-change check compares Locations field by field (`sameLocation`) instead of building a key string to compare it once.
- `FileTree` memoises membership Sets for its per-row checks while its props stay arrays.

## Alternatives considered

- **Keep the draft in state and stop the re-render with `useSyncExternalStore` or a subscription.** Rejected: the editor already owns the document for the save path, so the ref is the existing source of truth rather than a new store.
- **Keep per-keystroke `setDraft` and rely on `setDraft(previous => previous ?? text)` to bail out.** Rejected: the bailout compares state after the update, so the listener would still copy the whole document on every keystroke.
- **Publish the draft only when the mode flips, from an effect.** Rejected: the effect runs after the preview's first paint, so the preview would show one frame of the pre-edit document.
- **Return a `Map<string, PresentationPosition>` keyed by node key instead of sort entries.** Rejected: the comparator would need a lookup it cannot prove present, while the entry array states the pairing in the type.
- **Convert the `FileTree` props themselves to Sets.** Rejected: the mount effect that loads every expanded directory depends on the prop's identity, so the conversion would push new churn onto a caller to save nothing here.
- **Keep the string key in the structural check.** Rejected: the key existed only to be compared immediately, and its `?? ''` fallbacks made two undefined coordinates equal to the empty string rather than to each other.

## Consequences

Measured, and smaller than the audit that prompted this work estimated.

- `TextEditor`: the new spec pins one React commit for a seventeen-character typing run and zero preview-source rewrites in edit mode. With the per-keystroke state write and the unmemoised source restored, the same spec reports one commit and one rewrite per keystroke (nineteen commits and twenty rewrites against three and two).
- `ChatSnapshotBuilder`: the required fold benchmark does not move — `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/conversation-fold` reports 7.2 ms / 5.8 ms for its two windows without this change and 8.2 ms / 6.2 ms with it. The reordering path is not a measurable share of that fold, so the honest claim is the arithmetic: O(R log R) position records and turn lookups become O(R), with the same order.
- `FileTree`: the row pass becomes O(rows) membership tests instead of O(rows × expanded) array scans. Not separately measured.

The editor's draft is now invisible to React between keystrokes, so a render caused by anything else (a scheme flip, a popup) also sees the live text through the ref rather than the text as of the first keystroke.

## Testing

- `packages/client/better-sidebar/tests/text-editor-draft.client.spec.tsx` (new, jsdom) mounts the real editor, reaches its `EditorView` through `EditorView.findFromDOM`, and counts React commits with a `Profiler`: a seventeen-character typing run adds one commit and calls no preview rewrite; the preview renders the latest text when the mode returns; a save writes the editor's document and clears the host's dirty flag. The rewrite count comes from a `vi.mock` of `markdown-images.ts`.
- Negative control, run and reverted: restoring the per-keystroke `setDraft` and the unmemoised `previewText` fails the first two cases (19 commits, 20 rewrites) while the save case still passes.
- `pnpm exec vitest run packages/client/better-sidebar packages/client/ui-chat packages/client/ui-conversation packages/client/ui-trajectory` — 2687 passed, 5 skipped across 229 files; the Chat ordering and identity assertions in `chat-view.client.spec.tsx` and `conversation-node-definitions.client.spec.ts` are unchanged and still pass, which is the contract this rewrite must preserve.
- `pnpm exec vitest run packages/client apps/web` — 7328 passed, 5 skipped, with the one unrelated `ui-sidebar-documentpreview` packed-artifact failure described in the [target-claim-lifetime note](../architecture/2026-09-16-conversation-target-claim-lifetime.md).
- `pnpm run lint` and both TypeScript faces clean.

## Related

- [This fork removes better-sidebar](../architecture/2026-11-01-fork-removes-better-sidebar.md) — the former owner of the editor draft and file-tree toolbar contract; the draft/key rules in this note still apply wherever that UI lives.
- [ui-chat](../../../../packages/client/ui-chat/README.md) — the target that owns the transcript ordering these sort keys feed.
