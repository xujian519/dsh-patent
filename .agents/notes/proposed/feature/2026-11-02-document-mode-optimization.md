# Agent Note: Document mode preview and scale optimization

Status: proposed

English | [中文](2026-11-02-document-mode-optimization.zh.md)

## Problem

The document preset serves a delivery pipeline whose intermediate work is invisible until the final file is registered: brief → outline → chapter writing → render → quality gate → `document_deliver` → `turn/end`. The studio tab (`ui-document-studio`) already folds `write`, `edit`, and mutable `str_replace_editor` mutations into its deliverables list, so working drafts enter that list as soon as they are written; the gap is that the user cannot see or follow them while generation runs. Separately, the render tool returns the entire document to the model on every write, and long reports have no per-chapter files at all.

Four gaps, ordered by impact:

| Gap | Evidence | Consequence |
|---|---|---|
| Working drafts are invisible during generation | Auto-switch only reacts to a successful `document_deliver` (`auto-switch.ts`, `hasDeliverRegistration`); the studio reads the selected file once per selection (`StudioView.tsx`, `selectedPath` effect) and has no file-version dependency | The user sees nothing until delivery, and a rewritten file keeps showing stale bytes |
| One template render returns the whole document to the model | `writeRenderedDocument` keeps `content` and `markdown` in the tool result even when `output_path` is set; `.docx` additionally carries base64 (`render-doc-template.ts`) | A 20,000-character report costs another 20,000 characters in every later request of the session |
| Long documents have no chapter-level artifacts | `document-report` instructs chapter-by-chapter writing but persists one `report.md` plus one `report.html` | No per-chapter file to view, follow, or complete; the model rewrites the whole final document |
| Preview stops at a text head plus an HTML iframe | `.md` renders as plain text; `.html` reads the default 2 MiB byte window, so larger pages render truncated; `.docx` / `.pptx` / `.pdf` only hand off to the sidebar | A 5 MB Markdown file shows only its opening, and a large HTML page renders as a half page |

The research document dated 2026-11-02 proposed fixing the first three through sidebar watch productization, compaction changes, and a new session event. Current code shows a different set of owners: the sidebar already refreshes on file-resource metadata changes, spill already sits under the base bundle, and preview already reads the disk rather than pruned tool results. The correction matters because an artifact protocol would add a new package while path conventions and existing tool calls already carry the needed facts.

### Audit scope and inputs

This note was checked against the current repository, not only against the research document. External product mechanisms (OpenHands mutation counters, Claude Code in-place URL updates, Quarto save → re-render, Milkdown progressive markdown, AI SDK same-ID reconciliation, Continue artifact upload) follow the research document's retrieval record and are not re-verified here; where a claim conflicts with this repository's code, the code wins and the disagreement appears under "Alternatives considered".

Read surfaces:

- `packages/client/ui-document-studio/` — studio view, deliverables fold, auto-switch, preview reads
- `packages/client/ui-sidebar-documentpreview/` — sidebar preview, `autoRefresh`, Markdown / HTML / Office / PDF rendering
- `packages/api/workspace-files/` — bounded reads, paging, `changes` file observation, the `file` Resource
- `packages/document/doc-template/` — `render_doc_template` write path and result rendering
- `packages/document/document-deliver/` — registration, deterministic verification, result metadata
- `packages/bundle/web-app/presets/document.patch.yml` and `packages/bundle/web-app/skills/document/*`
- `packages/compaction/compaction-tool-result-pruner/`, `packages/spill/*`
- [document delivery studio](../../implemented/feature/2026-08-23-document-delivery-studio.md), [document mode workbench](2026-08-23-document-mode-workbench.md)

### Delivery timeline today

```text
User request
  └─ document preset starts
      ├─ document-brief        → writes brief.md (if the skill follows through)
      ├─ outline               → usually only in chat, not written
      ├─ writing               → one write produces report.md (or index.html)
      ├─ rendering             → render_doc_template, or hand-written HTML
      ├─ document-quality-gate → model self-check
      ├─ document_deliver      → registers files, format, P0/P1, machine verification
      └─ turn/end
            └─ ui-document-studio sees a successful registration → setActiveView('document')
```

Established facts:

- The deliverables fold already includes `write` / `edit` / mutable `str_replace_editor` paths through `mutationPath` in `document-deliverables.ts`. `brief.md` and `report.md` enter the studio list the moment they are written.
- Auto-switch fires on a successful `document_deliver` result only. The switch can happen while the final reply is still streaming.
- The studio preview reads once when `selectedPath` changes; it subscribes to no file version and calls no Resource.
- The sidebar preview is driven by `file` Resource metadata changes (`TextPreview.tsx`); the studio does not consume that path.
- File observation exists in `workspace-files` (`changes.ts`), and the `file` Resource already shares subscriptions, reconnects, keeps watching missing files, and normalizes absolute paths.
- Spill is mounted in the base bundle; the pruner runs only under compaction pressure. Neither addresses a render result that stays below the spill threshold but returns the full document anyway.
- Preview reads `workspaceFiles.readBytes` from disk, so a pruned tool result never becomes preview content.

### Code evidence

| Fact | Location | Effect |
|---|---|---|
| Deliverables come from mutations plus registrations | `ui-document-studio/src/client/document-deliverables.ts` (`mutationPath`, `producedFromTimeline`) | Working drafts are listed before delivery; the problem is visibility and refresh |
| Auto-switch only accepts `document_deliver` | `ui-document-studio/src/client/auto-switch.ts` (`hasDeliverRegistration`) | The studio does not take over before the quality gate |
| The switch runs on the registration result | `ui-document-studio/src/client/index.ts` (`preset auto-switch`) | The user can be switched away before reading the delivery summary |
| Preview reads one default 2 MiB byte window | `ui-document-studio/src/client/file-reads.ts` | A large HTML file enters the iframe truncated |
| Preview depends only on `selectedPath` | `ui-document-studio/src/client/StudioView.tsx` | A rewritten file does not refresh |
| Selection is pinned to `produced[0]` | `ui-document-studio/src/client/StudioView.tsx` | A newly written chapter never becomes the preview |
| Markdown renders as plain text | `ui-document-studio/src/client/StudioView.tsx` (`isTextPreviewable`) | Working drafts are hard to read |
| `render_doc_template` returns the full text after writing | `doc-template/src/tool/render-doc-template.ts` (`renderDocumentResult`, `writeRenderedDocument`) | One call adds the whole document to every later request |
| `.docx` base64 exists only in the result value | Same file; `skills/document/document-word/SKILL.md` step 4 | The skill tells the model to decode `content`, but the model only sees the rendered markdown |
| The empty-state probe recognizes final extensions only | `ui-document-studio/src/client/workspace-probe.ts` (`DELIVERABLE_EXTENSIONS`, `MAX_DEPTH`) | `chapters/*.md` still list as working drafts; the probe does not own chapter progress |
| The `file` Resource exposes live metadata | `workspace-files/README.md` § client file resources | The studio can consume version changes without a second watch stream |

## Proposal

Four user-visible outcomes, delivered in three phases:

1. **Written means visible.** Any working draft that reaches disk appears in the studio list without waiting for registration.
2. **Written means refreshed.** A rewritten selected file updates the preview within one second without re-selection.
3. **The preview follows the current chapter.** A newly written chapter file becomes the selection; the user can pause following.
4. **Readable before delivery.** Markdown renders as typeset text, HTML renders completely or explicitly hands off, and binary formats hand off to the sidebar.

Principles:

- **The disk is the content authority.** The session log records who wrote what and what was declared; preview always reads current bytes from disk.
- **The log is the declaration authority.** Chapters, deliverables, and gate state derive from recorded `tool/call` and `tool/result`; a new model-visible input prefers a tool call over a new session event type.
- **Preview and compaction stay separate.** A pruned tool result is never a preview source.
- **Explicit over implicit.** Write paths, formats, and length budgets come from the caller; no hidden defaults inside `run()`.
- **Failures stay visible.** Missing files, oversized previews, read failures, and paused following each produce a localized notice instead of a silent fallback.
- **No full-text generation stream.** Chapter files plus file observation cover watching a document being written; token-level document streaming is out of scope.

### Mechanism selection

| Mechanism | Use | Decision |
|---|---|---|
| `file` watch / `file` Resource | Studio preview refreshes from disk; the sidebar already uses it | Primary |
| Deliverables fold | Studio list, chapter grouping, progress | Primary |
| Logged tool calls | Chapter state, delivery registration | Use when needed; no new events |
| Custom SSE | Tool results are already structured events | Not used |
| Chat tokens | Summaries, progress, choice prompts only | Kept |
| CRDT | A single-user generation pipeline has no concurrent edits to reconcile | Not used |
| Virtualization | Very large Markdown previews | P2 |

External mechanisms map onto existing machinery: the `file` Resource version replaces a mutation counter; the artifact path is its own identity, so preview never changes address; a chapter file written to disk triggers a re-read of that file, not a document recompile; the same file rewritten multiple times stays one row (dedup by host-normalized path), matching same-ID reconciliation.

### Target data flow

```text
Model ──write/edit──▶ disk (brief.md / outline.md / chapters/NN.md / report.md / report.html)
  │                        │
  │ tool/call + result     │ file Resource (stat + version)
  ▼                        ▼
Session log ──client fold──▶ studio list (working drafts / deliverables) ──▶ preview (readBytes / paged read)
  │
  └─ document_deliver ──▶ gate badges, machine verification
```

### P0: preview on write

P0 changes no protocol and adds no package.

#### P0-1: The render tool returns only the path after writing

`render_doc_template` currently returns `content` (the full document) and `markdown` (the body) even when `output_path` is passed, and `renderDocumentResult` splices `--- document ---` plus the full text into the model-visible result. A `.docx` result value additionally carries base64.

Changes:

1. Make `content` and `markdown` optional in `RenderDocTemplateOutput`. After a write, `writeRenderedDocument` strips both and returns `{ template, format, fileName, mimeType, encoding, residual, warnings, path, bytes }`.
2. Split `renderDocumentResult` in two:
   - With `path`: report the header, `Written to <path> (<bytes> bytes)`, residual placeholders, warnings, and a line saying the body is on disk and should be read with `read` when it needs review. Drop the `--- document ---` block.
   - Without `path`: keep today's behavior for text formats, but fail for `docx` and require `output_path`. The model never sees the result-value base64, so the skill's decode instruction is not executable.
3. Update the tool description: delivery files always pass `output_path`; a written result returns path, byte count, residual placeholders, and warnings.
4. Remove the base64 fallback from the `document-word` skill; writing without `output_path` fails.
5. Require `output_path` in the `legal` preset's delivery skill, which currently only says to render a `.docx`.

Result contract:

| Call | Result |
|---|---|
| `format: markdown/html` + `output_path` | No `content` / `markdown`; `path` and `bytes` present |
| `format: docx` + `output_path` | Same; the package is written only and never enters the result |
| `format: markdown/html` without `output_path` | `content` / `markdown` still returned (explicit choice for small documents) |
| `format: docx` without `output_path` | Fails and asks for a write path |

Tests:

- `doc-template/tests/tools.spec.ts`: the written result text contains no `--- document ---`; `value.content` and `value.markdown` are `undefined`.
- `doc-template/tests/output-path.spec.ts`: a written `.docx` result carries no base64; a `.docx` call without `output_path` fails.
- `snapshots/web/legal-preset/tool-schemas.expected.json` refreshes after the schema change.
- `document-preset.spec.ts` and `document-prompt-consistency.spec.ts` agree with the new result contract.

Risk: automation that reads `content` directly breaks. In-repository consumers are the model and the skills; no client reads `content`. Treat it as a pre-stable API and update every consumer.

#### P0-2: The studio preview follows the disk through the `file` Resource

`useResource` is a standard slot prop (`GlobalStandardProps` in `resources`). The `workspaceFiles` `file` provider already stats the address, observes changes, and shares subscriptions with the sidebar preview. The studio needs:

1. Extract preview content into a `PreviewPane` child component that calls `useResource<'file'>(fileAddressFor(sessionId, cwd, selectedPath))`.
2. Use `meta.value?.version` as a dependency of the read effect; re-read `readFileText` / `readFileTextComplete` when the version changes. Tag requests with an id and discard stale results.
3. Default `autoRefresh` on, with a localized switch in the preview bar; when off, only manual refresh reads.
4. When the file disappears, show "file deleted" and keep the last content with a marker; the Resource supplies metadata again if the file reappears.
5. Do not mount `PreviewPane` without a selection, so no subscription is opened for an empty address.

The studio does not open its own `$stream`: `workspaceFiles.changes` exists, but the Resource already handles sharing, reconnection, missing files, and path normalization. A second stream would duplicate the sidebar's and repeat its reconnect and disposal work.

Tests:

- `StudioView.client.spec.tsx`: stub `useResource`, change `version`, assert a re-read; with `autoRefresh` off, assert no re-read.
- A real registry test asserts that the studio and the sidebar reading the same address open one host stream; the studio side asserts subscription count only.
- Manual: `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml`, write a document, open the studio, edit the file on disk, and watch the preview update.

Risk: re-reading on every save can jitter. A 100 ms coalescing window that reads once per `version` is enough. The Resource `version` is opaque and is never parsed.

#### P0-3: Preview rendering upgrade

Markdown: render `.md` with `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives`, `variant="body"`, with labels from the studio's own locale (`code.copy`, `code.copied`, `codeBlock.title`, `codeBlock.wrap`, `codeBlock.unwrap`, `footnotes`). Raw HTML follows `MarkdownText`'s default safety policy; raw HTML is not enabled. Local images show alt text in P0; `pathImages` follows in P1 through the sidebar's host file route.

HTML: read `.html` with `readFileTextComplete` (host full read, bounded by `maxFileBytes`, default 32 MiB). Add a studio `Config.htmlPreviewMaxBytes` (default 8 MiB): above it, show "file too large, open in the sidebar preview" instead of loading a giant document into an iframe. Below it, keep the `sandbox=""` iframe `srcDoc` and its current security policy. Printing and export keep using the complete read; a truncated read points to the sidebar or the original file.

Text and code keep the 2 MiB byte window and its existing truncation notice; P1-D replaces that with paged reads. Binary formats keep the "preview in sidebar" button; inline Office preview is P2.

Tests:

- `.md` renders headings, lists, and code blocks rather than a `<pre>` copy.
- `.html` above `htmlPreviewMaxBytes` shows the handoff and creates no iframe.
- `.html` below the limit renders completely; the truncated half-page path no longer exists.

#### P0-4: Follow the newest artifact

Add studio state `follow` (default on). When `produced` grows and `follow` is on, select the last added entry. A manual selection turns `follow` off; the preview bar's "follow newest" switch turns it back on. When the selected file is deleted, fall back to the first entry and keep a notice.

Implementation: record the previous `produced.length` in a `useRef` and switch only on growth; rewriting the same file does not change the selection. Do not reorder `documentDeliverables` — reading order is brief → outline → chapters, and sorting by update time jumps. Labels come from the locale; icons use existing product icons.

Tests: adding `chapters/01.md` selects it; adding `chapters/02.md` selects 02. Manual selection of `chapters/01.md` survives the addition of 03; enabling follow resumes on the next addition. Deleting the selected file falls back to the first entry.

#### P0-5: Switch timing and visibility

The switch is driven by the successful `document_deliver` result, which can arrive while the final reply is still streaming.

Changes:

1. Add `hasDocumentProduced(entries)`: scan successful mutation calls and treat `md/html/pdf/docx/pptx` extensions as working drafts for this turn. Reuse `mutationPath` parsing rather than a second path grammar.
2. Switch only when the last event in the window is `turn/end`. Entering an old finished session usually ends in `turn/end` too, so behavior there is unchanged.
3. Keep the per-session-entry switch-once guard and the retry window.
4. Switch when the preset is `document` and either a registration succeeded or this turn produced a working draft.

Tests: a mid-turn `write` does not switch; `turn/end` does. Entering an old session with a registration still switches. After the user manually returns to chat, the same session entry is never taken over again.

Risk: a temporary `.md` written in a document session also triggers the switch. That is expected for the document preset and the user can switch back; if the product considers it too eager, `hasDocumentProduced` can require `document_artifact` or `document_deliver`.

#### P0-6: Skills write long documents chapter by chapter

`document-report`:

1. After brief confirmation, write `outline.md`: a chapter tree (H2 depth, at most two levels), one sentence of intent per chapter, and a source list per chapter.
2. Write `chapters/01-<slug>.md`, `chapters/02-<slug>.md`, …; each chapter opens with an H2 and cites its sources.
3. Assemble the final file with a shell command rather than a full model rewrite:

   ```sh
   printf '# <title>\n\n' > report.md
   cat chapters/*.md >> report.md
   ```

4. Render `report.html` from `report.md` (P1-C's file-to-file renderer; without that tool, follow the current HTML step by hand).
5. Register only final deliverables with `document_deliver` (`report.md`, `report.html`, and an optional `.docx`), never chapters.
6. Allow a single `report.md` for fewer than three chapters or under roughly 5,000 characters, so a short document does not grow directory noise.

Known limitation: a shell `cat` does not produce a `write` mutation, so the studio shows the assembled `report.md` only after `document_deliver` registers it; chapter files remain live. Showing shell output before registration requires P1-B's `document_artifact`, or an earlier registration once the final file exists. The skill must state this so users do not read a missing final file as a failure.

`document-brief` and `document-quality-gate`: the brief still requires `brief.md`; the quality gate checks final deliverables, with chapters as working drafts, and P0/P1 verification stays on deliverables.

Tests: `document-prompt-consistency.spec.ts` keeps passing. Add a keyless snapshot in which a document session writes `outline.md`, two chapters, and a final `report.md`, and the studio list shows both the working-draft group and the deliverables.

### P1: chapter artifacts and scale

#### P1-A: Path conventions, grouping, and progress

Grouping does not need a new protocol.

- **Deliverables**: entries registered by `document_deliver` (with `format` / `gate`), or base names in the final-output convention outside `chapters/` and `drafts/`: `report.md`, `report.html`, `index.html`, `deck.html`, `<name>.docx`, `<name>.pptx`, `<name>.pdf`.
- **Working drafts**: `brief.md`, `outline.md`, `chapters/**`, `drafts/**`, including `.docx` / `.pdf` drafts inside them.
- **Other**: remaining mutation paths (resources, temporary files), collapsed by default.

The title bar shows `deliverables N · working drafts M · chapters K`. When `outline.md` exists, parse its H2 count as the target chapter count; otherwise show the written count only. A parse failure degrades to the count and never breaks the list. Nothing is persisted; everything derives from `produced`.

Implementation: add pure functions `groupProduced(produced)` and `chapterProgress(produced, outline?)` in `packages/client/ui-document-studio/src/client/grouping.ts`; render two sections, keeping selection by path across the full list; distinguish "no working drafts" from "working drafts but no deliverables" in the empty state.

Tests: pure-function cases for brief / outline / chapters / final deliverables / mixed / duplicate paths; view tests for both sections, chapter counts, and selection surviving grouping.

Tooling waits because path conventions already answer "which chapter is written". Only a live `writing` state, a `failed` state, custom titles, or chapters written by shell / subagents need explicit state.

#### P1-B: `document_artifact` tool (decision gate)

Build it only when product acceptance requires one of: showing "chapter 7 is being written" (`writing`) rather than "appeared"; showing "chapter 7 failed" (`failed`); decoupling chapter titles from file names; or chapters written by shell / a subagent with no `write` mutation to fold.

Design: a new package `packages/document/document-artifact/` registering a model-facing `document_artifact` tool from `{ path, kind: 'brief' | 'outline' | 'chapter' | 'html' | 'docx' | 'pptx' | 'pdf', status: 'writing' | 'ready' | 'failed', title?, order?, note? }`. `ready` requires the file to exist through the same `ctx.fs` resolution and existence check as `document_deliver`; `writing` allows a missing file; `failed` records the reason. The result is one confirmation line (path, kind, status, title) with no body. The client folds `documentArtifacts` by host-normalized path identity, the latest state replacing older states, kept parallel to `documentDeliverables` rather than merged. The studio progress bar reads `documentArtifacts`; chat renders a compact chapter card through `presentResult`. `document_deliver` remains the final registration.

Tests: tool unit tests for path resolution, `ready` failing on a missing file, `writing` allowing absence, and `failed` carrying a reason; fold tests for same-ID overwrite, out-of-order records, and older records degrading; a snapshot for the tool schema and one chapter record; persona and skill text mentioning the tool. Cost: 3–5 person-days including the package, preset row, coverage, and snapshots.

#### P1-C: File-to-file rendering (the key scale fix for long reports)

A 30,000-character report currently makes the model emit 30,000 characters of HTML as well, all of it retained in the session history and carried by every later request. That output cost exceeds the preview problem.

Add `render_document_file` to `doc-template`, taking `{ input_path, output_path, format: 'html' | 'markdown', title?, style? }`. It reads `input_path` through `ctx.fs`, renders with the existing `marked` pipeline and document styles, and writes `output_path`, returning only `{ path, bytes, headings, words, warnings }`. The HTML renderer gains the minimum the report skill already asks the model to hand-write: heading `id` anchors, a table of contents, and a footer (document name, date, version). `render_doc_template` keeps owning structured "template + variables" documents; `render_document_file` owns "assembled Markdown → deliverable". `document-report` becomes chapters → `cat` assembly → `render_document_file`; visually demanding single-page artifacts still use `document-html`. Mount the tool in the document preset by default; the legal preset must add it beside `render_doc_template` in `legal.patch.yml`.

Tests: fixture Markdown → HTML with anchors, contents, footer, code blocks, and tables; a result without the body; a missing input failing; fs policy applied to the output path; a 500 KB input with bounded time and memory.

#### P1-D: Paged preview

The studio currently reads 2 MiB; a 5 MB Markdown file shows only its opening. The sidebar already pages with `workspaceFiles.read` (5,000 lines per page), and the studio can reuse it.

Add `readFilePage(path, offset)` in `file-reads.ts` calling `workspaceFiles.read(sessionId, path, { offset, limit })`. Load the first page, then the next on scroll-to-bottom or "load more" until `eof`. Render accumulated Markdown with `MarkdownText`'s `streaming={!eof}`, which tolerates an unclosed block at a page boundary. Text and code page the same way; HTML keeps complete reads. A version change resets to the first page and either keeps the scroll position or says "file updated, back to top".

Tests: multi-page accumulation, `eof`, reset on version change, and a single request per "load more"; a 1 MB Markdown file with bounded first-paint time and memory (virtualization is P2).

#### P1-E: Compaction and preview isolation audit

Preview already reads disk through `workspaceFiles.readBytes` and never reads pruned tool results. Add one regression test: build a session whose large tool result the pruner replaced, and assert the preview still reads the complete file. The test asserts only that preview reads through `workspaceFiles`, not the pruner's internals, so a future change that sources preview from the log is caught.

#### P1-F: Per-chapter subagents (optional, long documents)

For reports and manuals above 20 chapters: after the main agent finishes `outline.md` and the style constraints, spawn one writing subagent per chapter with the chapter goal, source list, style, and target file path. Each subagent writes `chapters/NN-*.md` and reports the path; the main agent owns consistency review, assembly, and the quality gate, so the main context keeps only the outline, chapter summaries, and paths. Risk: cross-chapter terminology and tone drift, which needs a main-agent review round. Pilot on one real long report before writing it into the skill.

### P2: large scale and long-term

**Virtualization.** Trigger when a single Markdown file exceeds 1 MB or first paint exceeds 2 s. Options: heading-chunked rendering with `content-visibility: auto`, or virtual scrolling over ~140 KB windows. Measure before building; P1-D paging already covers most manuals.

**Inline Office preview.** Reuse `packages/document/office-to-pdf` to convert `.docx` / `.pptx` to PDF, then reuse the sidebar's PDF body (`ui-sidebar-documentpreview`). Sidebar handoff stays the default. Inline preview needs the PDF body exposed as a reusable component or the studio opening the sidebar's PDF tab; Office parsing is not reimplemented. Trigger: users explicitly ask to stay inside the workbench for Word / PowerPoint.

**Cross-session workbench.** Cross-session history, search, and batch export need a host-side session-projection query and are designed separately. The studio folds only the current session window today, so early turns of a long session are dropped; that is a known limitation outside P0/P1.

**ACP and Typst-level IR.** ACP applies only when DSH embeds into an IDE; Web and Desktop do not drive editor-writing today. Typst-level incremental IR applies only when HTML / PDF preview latency becomes the main complaint; chapter-level re-rendering is enough until then.

### Sequencing and PR split

| Order | Item | Depends on | Estimate |
|---|---|---|---|
| 1 | P0-1 render tool returns only the path | — | 1 day |
| 2 | P0-2 studio preview follows disk (`useResource`) | — | 1.5 days |
| 3 | P0-3 Markdown rendering, complete HTML read, binary handoff | P0-2 | 1.5 days |
| 4 | P0-4 follow the newest artifact | P0-2 | 0.5 day |
| 5 | P0-5 switch at turn end, scan working drafts | — | 1 day |
| 6 | P0-6 skills write chapters | — | 0.5 day |
| 7 | P1-A grouping and progress | P0-4, P0-6 | 2 days |
| 8 | P1-C file-to-file rendering | P0-1 | 3–4 days |
| 9 | P1-D paged preview | P0-2 | 2 days |
| 10 | P1-B `document_artifact` (optional) | P1-A acceptance | 3–5 days |
| 11 | P1-F chapter subagent pilot | P0-6, P1-C | 1 day |
| 12 | P2 | as demanded | 10+ days |

PR split: PR-1 is P0-1 (tool contract, skills, snapshots; independently revertible). PR-2 is P0-2 through P0-4 (studio preview). PR-3 is P0-5 and P0-6 (switch timing and chapter writing). PR-4 is P1-A plus P1-D. PR-5 is P1-C. PR-6 is P1-B if the decision gate opens. Every GUI PR carries a keyless snapshot and a GIF; every model-visible change refreshes its snapshot; every new package meets the per-file coverage requirement.

## Alternatives considered

**A full-text generation stream or token-level document SSE.** Chapter files plus file observation already cover watching a document while it is written. A whole-text stream would entangle with compaction, reconnection, and sandbox policy for no outcome the file path does not already give.

**CRDT collaboration (Yjs / Lexical / Milkdown collab).** A single-user generation pipeline has no concurrent edits to reconcile.

**Pushing HTML, DOCX base64, or full text into the chat.** This conflicts with the document persona and makes context uncontrollable. Written tools return paths; `render_doc_template` returns only the path after writing.

**Previewing from pruned tool results.** Preview reads the disk; a pruned result is never content.

**Rewriting the whole manual at token granularity.** Chapter-level re-rendering plus paging is enough; Typst-level IR is deferred.

**A new `SessionEventMap` member for a single-user generation pipeline.** Tool calls are already logged facts; structured state uses a tool (`document_artifact`) when it is genuinely needed.

**Adding the `document_artifact` package before a product requirement.** Path conventions and grouping answer most of the question; a new package adds a tool, model discipline, coverage, and snapshots for a display field.

**Productizing the sidebar watch instead of the studio.** The sidebar already refreshes on `file` Resource metadata changes; the gap is specifically studio preview. The research document placed P0-1 on the sidebar.

**Attributing the scale problem to spill and the pruner.** Spill is already mounted and the pruner runs only under compaction pressure. The direct fix is the `render_doc_template` result contract and the `.docx` base64 fallback.

**Switching to the studio mid-generation.** The proposal switches after `turn/end` so the streaming reply is not taken away, while scanning working drafts keeps pre-delivery work visible.

**A `document.artifact` session event.** The proposal prefers path conventions and grouping, and adds only a `document_artifact` tool when `writing` / `failed` state is required; `SessionEventMap` is not extended.

**Treating compaction / preview separation as a medium change.** Preview already reads the disk; only a regression test is needed.

**Deferring file-to-file rendering and chapter subagents to P2.** They directly reduce the model output cost of the final HTML, so they sit between P1 and P2 rather than after virtualization and IR work.

## Acceptance criteria

P0 is accepted when all of the following hold:

- A document session that writes `brief.md` shows it in the deliverables tab without calling `document_deliver`.
- Rewriting `brief.md` on disk updates the preview within one second without re-selection.
- Writing `chapters/03-*.md` moves the preview to chapter three.
- `.md` renders as typeset text; `.html` renders completely or explicitly offers the sidebar handoff.
- The reply for the turn displays completely before the studio takes over.
- With `output_path`, a `render_doc_template` result carries no body; later requests for a 20,000-character report no longer carry 20,000 extra characters.
- `document-word` fails with a clear message when `output_path` is missing.

Verification matrix:

| Scenario | Assertion |
|---|---|
| 20,000-character report, written template render | One tool result under 2,000 characters; later requests exclude the body |
| 3-chapter document | Studio shows 3 working drafts; following selects the last chapter; refresh under 1 s |
| 10-chapter document | Group counts correct; `outline.md` target count correct |
| 5 MB Markdown | P1-D paging reaches the end; first paint under 2 s |
| 10 MB HTML | Above `htmlPreviewMaxBytes`, hand off to the sidebar and create no iframe |
| 30 chapters with subagents | Main context holds no full chapter text; the quality gate still reads the final deliverable |

Commands:

```sh
pnpm exec vitest run packages/document/doc-template
pnpm exec vitest run packages/client/ui-document-studio
pnpm run test:gui
pnpm run test:snapshot -t document-deliver
pnpm run test:snapshot:refresh -t document-deliver
pnpm run test:web
pnpm run test:web:refresh
pnpm run doc-sync
pnpm run test:docs
pnpm run build:artifacts
pnpm run build:check
pnpm run typecheck
pnpm run lint
```

Snapshot and web work: refresh `snapshots/session/document-deliver/tool-schemas.expected.json` and affected sessions after the result-text change; add a keyless chapter-record snapshot if P1-B lands; add a `document-studio` web scenario with a seeded workspace (`brief.md`, `outline.md`, `chapters/01.md`, `chapters/02.md`) and a document session, asserting grouping, following, Markdown rendering, and the HTML complete / oversize paths. If the snapshot harness cannot seed a document session, add that support in the same PR rather than leaving jsdom tests alone.

Documentation and generators: update `doc-template` and `ui-document-studio` READMEs and their `.zh.md` pairs for the result contract, preview, following, and `useResource`; update the document preset persona and skills; refresh the generated tool catalog; and mark the covered parts of [document mode workbench](2026-08-23-document-mode-workbench.md) implemented or supersede them with a new note so two proposals do not compete. This change touches no CLI, config key, persistence format, SDK, or wire protocol, so it needs no upgrade guide; the `render_doc_template` result change is noted in the package README and release notes.

Manual script: start `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml`; create a document session and ask for a three-chapter technical report; confirm `brief.md` and `outline.md` appear before `document_deliver`; rewrite `chapters/02-*.md` on disk and watch the preview refresh, then write `chapters/03-*.md` and watch the preview follow; confirm the switch happens only after the reply completes; inspect a `render_doc_template` tool card for a result with only path, bytes, residual placeholders, and warnings; select a `.docx` and confirm the sidebar preview renders it; record a GIF of write → list entry → refresh → follow.

## Risks

| Risk | Symptom | Mitigation | Rollback |
|---|---|---|---|
| Re-read jitter | Every save re-reads and the scroll position jumps | 100 ms coalescing; one read per `version`; preserve scroll position | Turn off the `autoRefresh` switch |
| Resource subscription leak | Old addresses stay held after switching files | `PreviewPane` releases on unmount; a real registry test asserts subscription count | Drop `useResource` and return to manual refresh |
| Oversized HTML | Iframe jank or high memory | `htmlPreviewMaxBytes` limit plus sidebar handoff | Lower the limit |
| Eager auto-switch | The user is switched away mid-reply | Switch at `turn/end` only; once per entry | Fall back to switching only on `document_deliver` |
| Tool contract change | External automation reads `content` | Update every in-repository consumer; state it in the README | Keep `content` for one version (not recommended) |
| Skill-mediated discipline | The model does not write `chapters/` | A single `report.md` still works; the studio degrades to a flat list | Make path conventions display-only, never a hard gate |
| New tool cost | `document_artifact` needs a package, snapshots, coverage | Decision gate: P1-A first; build only under explicit state requirements | Skip P1-B |
| Long-report fidelity | `marked` styles trail hand-written HTML | Keep `document-html` for visual artifacts; render reports file-to-file | Hand-written HTML remains available |

## Appendix: code evidence index

| Topic | File | Key symbols |
|---|---|---|
| Auto-switch | `packages/client/ui-document-studio/src/client/auto-switch.ts` | `hasDeliverRegistration` |
| Switch effect | `packages/client/ui-document-studio/src/client/index.ts` | `preset auto-switch` |
| Deliverables fold | `packages/client/ui-document-studio/src/client/document-deliverables.ts` | `mutationPath`, `producedFromTimeline` |
| View reads | `packages/client/ui-document-studio/src/client/StudioView.tsx` | `selectedPath` effect, `isTextPreviewable` |
| Preview reads | `packages/client/ui-document-studio/src/client/file-reads.ts` | `readBytes` window / complete read |
| Workspace probe | `packages/client/ui-document-studio/src/client/workspace-probe.ts` | `DELIVERABLE_EXTENSIONS`, `MAX_DEPTH` |
| Template render result | `packages/document/doc-template/src/tool/render-doc-template.ts` | `renderDocumentResult`, `writeRenderedDocument` |
| Document report skill | `packages/bundle/web-app/skills/document/document-report/SKILL.md` | chapter-by-chapter instructions |
| Word skill | `packages/bundle/web-app/skills/document/document-word/SKILL.md` | base64 fallback step |
| Preset composition | `packages/bundle/web-app/presets/document.patch.yml` | `tool-document-deliver`, `doc-template`, pruner |
| Spill | `packages/bundle/base/cordis.patch.yml` | `spill-local`, `spill-policy` |
| File observation | `packages/api/workspace-files/src/index.ts` | `changes` |
| `file` Resource | `packages/api/workspace-files/README.md` | client file resources |
| Sidebar auto-refresh | `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx` | `autoRefresh` |
| Studio design record | `../../implemented/feature/2026-08-23-document-delivery-studio.md` | auto-switch, sandbox, preview limits |
| Workbench proposal | `2026-08-23-document-mode-workbench.md` | four gaps, v2 |
