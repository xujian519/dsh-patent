---
description: "Video production board for the Web GUI: a conversation view tab that discovers a session's video projects from settled tool calls, reads each project, its CNY ledger, and its task journal, and previews keyframes, clips, and renders through the authenticated file route."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-video-studio

English | [中文](README.zh.md)

## Summary

This package renders the video production board in the Web GUI: a `Video` tab in the conversation view ring beside Chat, Trajectory, and Documents. It discovers the projects a session opened from the `projectPath` metadata on settled `video_project` results, reads each `project.json` with its `budget.json` and `tasks.json`, and shows shots, renders, in-flight tasks, the CNY budget against the larger of the recorded shot costs and the ledger, and a preview of the chosen keyframe, clip, or render.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web patch mounts this plugin for every session; the tab appears once a session has opened a project. A session that never called `video_project` sees an empty state that names the tool. The board follows the experiment's project document and never writes it: `video_project`, `media`, `video_assemble`, and `video_deliver` stay the only producers.

### The project header

The title, aspect ratio, target duration, and last update come from `project.json`. When a session opened several projects, a selector switches between them by file name. The budget bar shows `spent / budget` in CNY; the spent figure is the larger of the selected shots' recorded costs and the settled ledger total, so a forgotten cost write-back cannot understate it. A bar past the budget turns red and adds the over-budget label.

### Shots, renders, and tasks

Shots list in index order with their state, duration, selected cost, and whether a keyframe or clip is attached; activating one previews its clip, or its keyframe when no clip exists. Renders list with their creation minute, measured duration, and cost. In-flight tasks come from the journal and show the provider model and state; a settled task disappears on the next refresh because the Host removes its record.

### The preview and actions

The preview plays video through `api/file?path=…&v=<version>` with native controls, so seeking uses the route's Range responses, or shows a keyframe image. A file the Host cannot stat reads as missing instead of rendering an empty player. The preview offers the sidebar handoff when that surface is composed, opening with the OS default application, and reveal in the file manager on a loopback desktop. A failed action reports its Host message beside the buttons.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`video-projects.ts` registers a turn-scoped `ConversationNodeDefinition` and its session view target. A `tool/call` records the call name; a successful, append-surface `tool/result` carrying `meta.projectPath` publishes that resolved path, and any settled `video_project` or `media` result advances a revision counter. The view builder folds every turn in the window into one first-seen path list plus the highest revision. The studio reads that snapshot through `useConversation` and owns no store, subscription, or event listener.

The tab registers through `ctx.slots.inject('conversation.view')` under the same id as the view target. Its inject face resolves the session working directory once and supplies `loadProject` (three `workspaceFiles.readBytes` calls plus one `stat` per previewable media path), the media URL builder, and the three file actions. File parsing is local and strict about the fields the board renders: a malformed document fails as a whole rather than showing a partial production, while a malformed ledger or journal degrades to an empty total or list so a hand edit cannot hide the document.

The board re-reads when the discovery revision moves or the user presses Refresh; a project whose title or budget changed outside the tool set needs that gesture. Columns stack on a 720px container width rather than a viewport width, so a conversation column squeezed by both sidebars still gets the one-column layout.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-video-mode](../../experimental/video-mode/README.md) — the project document, ledger, journal, tools, and providers this board reads.
- [ui-document-studio](../ui-document-studio/README.md) — the sibling delivery studio over produced files.
- [ui-conversation](../ui-conversation/README.md) — the `conversation.view` ring and its view definitions.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the board reads files and renders them; it registers no tool, prompt section, or session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Discovery needs result metadata** — a session recorded before `video_project` published `projectPath` shows no project; the board does not derive a path from a title.
- **Reads follow tool settlements** — the revision advances on `video_project` and `media` results only. A project edited by another process, or a media file replaced outside those calls, appears after Refresh.
- **One workspace file budget** — the three reads use the Host's full-file cap, so a project document above it reports a read failure rather than a preview.
- **Preview covers images and video** — keyframes and renders with other suffixes (for example `.wav` narration) are omitted from the preview list; the sidebar or OS application remains the way to inspect them.
- **Read-only board** — editing shots, prices, or budgets stays with the model's tools; the board never writes the project, ledger, or journal.
- **Malformed sidecars degrade quietly** — an unparseable `budget.json` reads as zero and an unparseable `tasks.json` as no pending tasks; the document itself still renders.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/project-reads.client.spec.ts` owns the parser and read contract, `tests/video-projects.client.spec.ts` the fold and revision semantics, and `tests/StudioView.client.spec.tsx` the board behavior. The project document schema lives in `dsh-video-mode`; keep these parsers aligned with the fields the board displays rather than duplicating the Host's complete validator.

</details>
