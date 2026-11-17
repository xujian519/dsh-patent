---
description: "Function plugin for the [document agent preset](../../bundle/web-app/presets/document.patch.yml): one model-facing `document_deliver` tool that records the delivered files, formats, and the model's quality-gate claim, and reads those files to report its own deterministic document checks beside that claim. The call is session-logged, so the [delivery studio](../../../packages/client/ui-document-studio/README.md) derives the deliverable list and both gate columns from the log and the result metadata — no new session event type, no host write RPC."
kind: "package-reference"
---

# @deepseek-ai/dsh-document-deliver

English | [中文](README.zh.md)

## Summary

Function plugin for the [document agent preset](../../bundle/web-app/presets/document.patch.yml): one model-facing `document_deliver` tool that records the delivered files, formats, and the model's quality-gate claim, and reads those files to report its own deterministic document checks beside that claim. The call is session-logged, so the [delivery studio](../../../packages/client/ui-document-studio/README.md) derives the deliverable list and both gate columns from the log and the result metadata — no new session event type, no host write RPC.

## Table of Contents

- [What it mounts](#what-it-mounts)
- [Deterministic checks](#deterministic-checks)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## What it mounts

- **`document_deliver`** — declares `files` (`{ path, format }`, format from `markdown | html | pdf | docx | pptx | other`), `gate` (a required `p0` list in which the model claims the quality-gate skill's stable ids passed, an optional `p1` list), optional `unreadable_ack` reasons (one `{ path, reason_text }` per file the checker cannot read), an optional `brief_ref`, an optional `style` name, and an optional `char_budget` in characters. It resolves each path against the calling session's workspace, fails loud when a file is missing (a ghost file is not a deliverable), reads each delivered file for the deterministic checks, and confirms the registration with the claimed P0/P1 counts, the style it checked against, and one check report per file. The claim is recorded, not verified: a `p0` id the list leaves out or writes unrecognizably comes back as a registration warning, and the deterministic checks alone decide whether the call is refused.

  Each check report names its file twice: `path` is the declared spelling, kept verbatim because it is what a reader recognises, and `identity` is the Host-resolved canonical absolute path that every spelling of the same file shares. A consumer keys a deliverable on `identity` and displays `path`, so `out/report.html` written and `/work/out/report.html` registered are one deliverable rather than two. `identity` is absent on results recorded before it existed; a consumer then falls back to the declared path, which is what the delivery studio does. `unreadable_ack` entries match a file by that same canonical identity, so a reason written in one spelling explains a file declared in the other.

<a id="deterministic-checks"></a>
## Deterministic checks

The tool reads the delivered bytes rather than trusting the declaration. The file's extension decides which reader runs (`.md`/`.markdown` as Markdown, `.html`/`.htm` as HTML, `.docx` as a package, `.pdf`/`.pptx` as formats with no text reader), and a declaration the extension contradicts is read the way the extension says while the result carries the contradiction in that file's reason; `other` and a path with no known extension keep the declared format. Markdown and HTML are read as text; a `.docx` package is projected to text through [`@deepseek-ai/dsh-docx-kit`](../docx-kit/README.md) under the configured `maxArchiveEntries` and `maxUncompressedBytes` budgets; a format with no text reader (`pdf`, `pptx`, `other`) is reported as `unchecked` with the reason instead of a pass. A package that exceeds a read budget is reported `unreadable` with `too-large` in its reason, never truncated, and needs no acknowledgement; any other `unreadable` file must carry an `unreadable_ack` reason or the call fails, so "not checked" cannot be read as "checked".

| Check | Reported when | Level |
| --- | --- | --- |
| `placeholder` | A residual placeholder remains: a fillable `{{variable}}`, or one of the marker forms `[TBD]`, `Lorem ipsum`, `待补充`, and the rest of the shared vocabulary [`@deepseek-ai/dsh-doc-style`](../doc-style/README.md) defines | `block` outside quoted text, `warn` inside a code fence or an inline code span |
| `anti_pattern` | The selected style lists the word as forbidden | the style's own `block` or `warn` severity, always `warn` for a word quoted as code or sample text |
| `empty_section` | A heading's section holds no content before the next heading; an H1 written directly above a deeper heading is the document title and keeps the content below it | `warn` |
| `broken_anchor` | A `](#fragment)` or `href="#fragment"` names a fragment the document declares no id, named anchor, or heading slug for, and the renderer convention `top` does not answer | `warn` |
| `length_budget` | A declared `char_budget` is missed by more than the configured `lengthTolerance` (shipped default 20%). An HTML document is measured by its body text: markup, comments, and the contents of its `script` and `style` elements are removed first | `warn` |

A `block` finding throws: the registration is refused and the error names the file, the check, and the line, so the model fixes the document instead of registering it. A `warn` finding is recorded and the registration proceeds, because each has a reading a reviewer may accept. The style comes from `defaultStyle` and the budget tolerance from `lengthTolerance`, both named in the tool description; a style name no loaded style carries fails the call and lists the loaded names. Every finding is capped at `maxFindingsPerCheck` per check (five by default), with the remainder summarized rather than dropped.

## Model Experience

### Tool schemas

#### What the model sees

One registered tool definition: `document_deliver` with its parameter schema (file list with formats, gate checklists, optional brief reference, style name, character budget) and the confirmation render, which carries the model-reported P0/P1 counts, the deterministic outcome per file, and each warning line. The exact description and parameters are in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-document-deliver).

#### Token effect

Fixed definition cost of one tool on every request; the result is the confirmation plus one line per warning, resent only until compaction. No system-prompt section is registered, so there is no additional fixed prompt cost. The configurable style guide is injected by [`@deepseek-ai/dsh-doc-template`](../doc-template/README.md), which owns the style assets this package also checks against.

#### KV Cache effect

Prefix-stable while the registered tool set and the description are unchanged.

## Known Limitations and Deferred Work

- **Registration is a declaration, not a conversion** — the tool does not copy, render, or convert files; it checks existence and content and records the declaration in the session log. PDF export still goes through the studio's print action, and slide/exotic Office conversion still needs the user-level `officecli` skill.
- **No delivery gate; the difference from patent mode is deliberate** — patent mode holds `render_patent_document` and `build_patent_filing` to a gate, so a round cannot ship a deliverable before its rule, citation, and archive runs have succeeded. This mode declares no gate, and a session can therefore end with an unregistered deliverable. A gate binds a prerequisite to a later call, and patent mode has both parts: the prerequisite is an intermediate act (the round's archive entry), and the gated call is the domain's one sanctioned production path — [`patent-document-polish`](../../bundle/web-app/skills/patent/patent-document-polish/SKILL.md) states that a deliverable goes through `render_patent_document` alone. `document_deliver` is a terminal declaration instead: the bytes are written first, by whichever route the work needs (hand-written Markdown and HTML, `render_doc_template`, the user-level `officecli` skill for `.docx` and `.pptx`), and no tool is called after it. Two stronger designs were considered and rejected. Moving the file write into the tool would turn a registration into a converter, duplicating `doc-template` and `officecli` and still missing the hand-written routes. A reply-level check on the turn boundary (`agent/turn-stopping` with `agent.steer`) would have to decide from the reply that the turn was meant as a delivery; the mode deliberately writes briefs, outlines, and drafts first, so neither a file write nor a heading identifies the delivery turn, and gating a declaration on itself decides nothing. What the tool does hold when it is called: a declared file that is missing fails the call, and a blocking finding refuses the registration.
- **No cross-session aggregation** — the studio folds one session's log window; cross-session history, search, and batch export are the deferred document-workbench v2 (see the [workbench proposal](../../../.agents/notes/proposed/feature/2026-08-23-document-mode-workbench.md)).
- **The reported checks are not a review** — they cover the mechanically decidable part of the quality gate (placeholders, the style's forbidden words, section emptiness, same-document fragments, a declared length budget) and say nothing about sourcing, correctness, or accessibility. The P0/P1 items stay the model's claim; the tool reports its findings beside it rather than validating it, and the studio shows both columns.
- **Only the configured style's words are enforced** — a deployment whose documents must avoid words outside the loaded style's list adds them to that style asset (or points `styleDirs` at its own directory). A per-call waiver would let a forbidden word through with no record of why, so the tool has none.
- **The anchor check is heuristic** — it accepts a fragment declared by an `id`/`name` attribute, by a heading slug under GitHub's rule, or by the `top` convention a renderer answers without any declaration, so a renderer with a different slug convention can produce a `broken_anchor` warning that is not broken. That check is a warning for exactly that reason.
- **The HTML character count is a scan, not a parser** — it removes comments, declarations, tags, and the contents of `script` and `style` elements, and decodes character references; a `>` inside a quoted attribute value is out of scope, which shifts the count by the markup that follows it rather than skipping a check.
- **The size cap skips, it does not truncate** — a deliverable larger than `maxCheckBytes` (shipped default 4 MiB) is read no further and reported `unreadable` with its reason; the checks run over nothing rather than over a head that would pass.
- **The DOCX read budget is a deployment budget** — a package that declares more entries than `maxArchiveEntries` or expands past `maxUncompressedBytes` is reported `unreadable` with `too-large`; a deployment that delivers very large repetitive documents raises the cap in `cordis.yml` rather than getting a partial check.
- **An unreadable file has to be explained** — a file the checker cannot read fails the registration unless the call supplies its `unreadable_ack` reason, so "not checked" can never read as "checked"; the read-cap case (`too-large`) is exempt because that cap is the deployment's own budget rather than a defect in the document.
- **Cancellation is not an unreadable file** — when the caller's signal aborts during a check, the call rejects with the cancellation instead of reporting `unreadable`, and the per-file loop stops before reading the next file. A cancelled run therefore cannot send the model to repair a document it never read.

### Dev Note

The deterministic checks are original to this package, not a port: they read the forbidden words of the ported style assets ([`@deepseek-ai/dsh-doc-style`](../doc-style/README.md)) and the placeholder conventions of the ported template engine ([`@deepseek-ai/dsh-doc-template`](../doc-template/README.md)). The `document_deliver` tool itself, its argument validation, and its existence check are unchanged from the original plugin.
