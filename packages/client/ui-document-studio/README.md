---
description: "Document-delivery studio for the [document agent preset](../../bundle/web-app/presets/document.patch.yml): a `conversation.view` tab (`document`, label 交付物) that lists the session's produced files, previews HTML/text through the session's `workspaceFiles` Remote, lists the quality gate the model claimed beside the machine check that actually ran, and offers open / reveal / preview-in-sidebar / print / request-changes actions. It also auto-switches a session to the studio once that session has registered a deliverable."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-document-studio

English | [中文](README.zh.md)

## Summary

Document-delivery studio for the [document agent preset](../../bundle/web-app/presets/document.patch.yml): a `conversation.view` tab (`document`, label 交付物) that lists the session's produced files, previews HTML/text through the session's `workspaceFiles` Remote, lists the quality gate the model claimed beside the machine check that actually ran, and offers open / reveal / preview-in-sidebar / print / request-changes actions. It also auto-switches a session to the studio once that session has registered a deliverable.


## Table of Contents

- [What it mounts](#what-it-mounts)
- [Prerequisites](#prerequisites)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## What it mounts

- **The studio view** — one entry in the `conversation.view` ring (id `document`, order 20). The tab appears for every session once the plugin is loaded; selecting it shows the studio in the center column. A one-shot `viewRequest` naming a produced path selects that file, which is how a chat-side delivery card can land on its own file.
- **The produced-file vocabulary** — a turn-scoped `ConversationNodeDefinition` (`documentDeliverables`) folding successful mutation `locations` (diff cards and generic edit cards) **and** `document_deliver` registration calls into turn data, plus a session-scoped view target (`documentDeliverables`) folding every turn in the window into one first-seen ordered list. A registration call augments a mutation-derived entry in place with its announced format and P0/P1 gate state, plus the machine-check outcome its result recorded — so shell/officecli-produced outputs (`.docx`, `.pptx`) appear in the studio once the agent registers them, and old sessions degrade to the mutation-derived list with a "no gate record" badge. A machine verdict survives only while the newest entry carries one: a later mutation of the same file, and a later registration whose result had no readable check report, both withdraw it (the declaration was renewed, the verification was not). The derivation is the same vocabulary `ui-deliverables` uses; this package owns its own key so the studio works whether or not `ui-deliverables` is composed in.
- **One file, one row, however it was spelled** — a deliverable's identity is the Host-resolved canonical path (`identity`), not the string a call wrote: `out/report.html` written and `/work/out/report.html` registered are one row, and a later rewrite withdraws that row's verdict wherever it was recorded. `path` stays the declared spelling for display, because that is what the user recognises. Both are optional together: a log recorded before the Host wrote `identity` falls back to the declared spelling, and a row keyed by one is reachable by the other, so a session recorded across the change never splits one file into two rows.
- **The claim and the check, side by side** — the announced P0/P1 gate is the model's own claim, so its badge stays neutral and names the declared items (or their count when the list is long), and an expandable block lists every declared item under a "model claim, not a machine check" label. Only `checks.status === 'checked'` with no findings wears the success color; `unchecked` and `unreadable` read as their own degrade notes.
- **The stale-verdict marker** — the studio records each checked entry's `workspaceFiles` freshness token the first time it sees it and re-stats the checked entries when the produced list changes (never on a timer). A token that moved means the bytes no longer match the recorded verdict, so the badge becomes "file changed, not re-checked". The same badge covers the withdrawal the fold itself observed: when a later mutation or a check-less registration takes a verdict away, the entry records that fact (`checksWithdrawn`) rather than merely losing the badge, so a reloaded session still says the bytes are unverified instead of reading as never-checked.
- **The empty state** — two tiers. An empty session with nothing on disk reads as "no delivered files yet"; an empty session whose workspace holds deliverable-shaped files (`md`, `html`, `pdf`, `docx`, `pptx`, two directory levels below the workspace root) that no registration recorded lists them as unregistered, so a missing registration never masquerades as a missing deliverable. The probe runs once when the list is empty and again only on the user's "scan workspace" action; a failed probe reports its own failure instead of claiming there is nothing.
- **The preview** — selecting a file reads one byte window through the session's `remote.workspaceFiles.readBytes`, decoded as UTF-8 (a character the window cut in half is dropped whole). The window is the host's configured cap, so an oversized file shows its head plus a truncation note (HTML included); a read failure is localized from its Host code. HTML renders in a sandboxed iframe (`sandbox=""`, no scripts); Markdown/JSON/YAML/CSV/LOG renders as text; a format with no inline preview says so and offers the sidebar handoff.
- **The actions** — open with the OS default application, reveal the file in the OS file manager (`SessionOpenWorkspacePathRequest.action: 'reveal'`, gated on a loopback authority), preview in the right sidebar when that surface is composed (`ctx.sidebarRight.openResource` with a session file address, which is also how `.docx`/`.pptx`/`.pdf` get rendered), print / export PDF (re-reads the complete file through `remote.workspaceFiles.readBytes` without a range when the preview head was truncated — the host refuses a file above its full-file cap, which the studio reports as too large — then prints through the desktop bridge or the browser's print dialog, where "Save as PDF" exports, and a blocked popup is reported), and request changes. A failed open or reveal reports a localized line beside the action instead of leaving the click silent.
- **The drafts it writes, never sends** — "request changes" inserts the selected file's machine findings (one line each, with the reported line number) into the session composer draft; a delivered HTML file's declared `data-doc-id` sections appear in a picker that inserts a reference block. Both go through `ctx.conversation.input.setDraft`; submitting stays a human decision, and the view reports the insert rather than claiming the message was sent.
- **The auto-switch** — when the current session's preset is the document agent and its newest turn ended after a successful `document_deliver` registration or a deliverable-shaped working draft, the studio view is activated. The switch waits for `turn/end`, so the reply the user is reading is complete before the screen changes; a session that has produced nothing yet keeps the chat. The switch goes through `ctx.conversation.setActiveView`, which is the sanctioned cross-package channel (the per-session store handle is apply-local by design); the setter mounts with the session's conversation seat, so the switch retries for a bounded window, and each session entry switches at most once.

The shipped Web patch (`packages/bundle/web-app/cordis.patch.yml`) is the only composition that loads this package. Removing its one entry removes the tab, the vocabulary, the preview, and the auto-switch together.

## Prerequisites

The document agent preset (`document` in `packages/bundle/web-app/presets/`) is what a document session selects; the studio renders for every session regardless. The `workspaceFiles` Remote that serves the reads ships with the Web composition (`dsh-api-workspace-files`); no OpenDesign or other external process is required. The right-sidebar preview (`sidebarRight`, from `dsh-client-ui-sidebar-right`) is optional: without it the studio offers no handoff rather than holding the view pending.

## Model Experience

None, as this package renders already logged delivery registrations and writes only the user's composer draft, without altering model requests, tool execution, or session events.

#### KV Cache effect

None. The package is client-only presentation.

## Known Limitations and Deferred Work

- **The preview is preview, not execution** — HTML renders with `sandbox=""`, so interactive artifacts (JS-driven decks, live dashboards) show their first paint but do not run. A renderer that trusts the session's own produced files is deferred.
- **PDF is silent export on desktop** — inside the desktop app (Electron), the print action goes through `window.desktop.printHtmlToPdf` (hidden-window rasterization + OS save dialog); outside the desktop shell it falls back to the browser print dialog.
- **The stale-verdict baseline is this console's first look** — the freshness token is captured when the studio first renders a checked entry, because the registration's tool result carries no file version. A rewrite between the registration and that first render is therefore not detected; carrying the registered version in the result metadata would close it.
- **Selection anchoring is degraded** — the sandboxed frame is cross-origin, so the parent cannot read a text selection inside it; the section picker inserts a reference by declared `data-doc-id` instead of by selected text. A measured selection path was not attempted in this batch.
- **Auto-switch fires on session entry, once per turn** — a deliberate tab pick back to chat survives until the user leaves and re-enters the session, at which point a session whose finished turn produced something switches again.
- **Preview is text-only by extension** — binary formats (`.docx`, `.pptx`, `.pdf`) have no inline preview; they list with their badges and are rendered by the right-sidebar preview or the OS default application.
- **The list follows the session log window** — a long session whose early turns fall outside the loaded window loses those entries from the list; batch export and cross-session aggregation are the deferred workbench v2.

### Dev Note

None.
