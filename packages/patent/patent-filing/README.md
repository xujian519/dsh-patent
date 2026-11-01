---
description: "Patent filing document assembly for the DeepSeek Harness: renders a CNIPA application document (abstract, abstract drawing, claims, specification, drawings) into DOCX from a controlled draft, using a shipped template whose formatting is the single source of truth, then asserts the finished file against that template."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-filing

English | [中文](README.zh.md)

## Summary

Renders a CNIPA patent application document — abstract, abstract drawing, claims, specification, drawings — into one DOCX, and asserts the finished file against the shipped template. The template is the single source of truth for formatting: fonts, size, line spacing, first-line indent, section count, and headers are reverse-derived from it, and a `style` block that disagrees with it fails before writing. Content arrives as a controlled draft — the same SpecDraft the claims-spec HTML/PDF channel renders. Paragraph numbering follows the spec's per-section declaration: under `paragraph` the engine strips the draft's numbers and rewrites its own.

## Table of Contents

- [build_patent_filing tool](#build_patent_filing-tool)
- [Draft mapping](#draft-mapping)
- [verify_patent_filing tool](#verify_patent_filing-tool)
- [Filing assets](#filing-assets)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="build_patent_filing-tool"></a>
## build_patent_filing tool

build_patent_filing takes a controlled `draft` (the same `SpecDraft` the `render_patent_document` claims-spec template accepts, validated by `validateSpecDraft` from `dsh-patent-core`), an `outputName`, and optional `caseId`/`outputDir`, and writes one five-section DOCX. It returns the written path, the bitmaps that reached the document, the paragraphs and figures each section carries, the paragraph-numbering total, the source numbering it read and checked, the formatting it reverse-derived from the template, and the template's SHA-256. The legacy `content` parameter is deleted: a call carrying it is rejected at the executor's argument gate with `missing required property "draft"`.

The five sections are the statutory ones: 说明书摘要, 摘要附图, 权利要求书, 说明书, 说明书附图. Figures enter the document in `draft.figureFiles` order — the first becomes the abstract drawing, and all of them fill the drawing section one per page. A `.svg` source is rasterized through headless Chrome first; `.png`, `.jpg`, and `.jpeg` are used as they are.

Section headings, claim item numbers, figure captions, and table captions are generated from the draft structure, never authored: `contentFromDraft` maps the five specification parts to the statutory `h3` headings, prefixes claims with their item numbers, rewrites drawing-description list items as `图N为……；/。` paragraphs, and emits `表 N · 名称` caption paragraphs before each table — the same algorithm the HTML channel runs, so the two channels cannot diverge. Paragraph numbering follows the spec's per-section declaration: under `paragraph` the engine writes `[0001]`-style numbers, strips any source numbering a paragraph text still carries, and reports a number that disagrees with the paragraph order instead of overwriting it (caption paragraphs neither carry nor occupy a number); the shipped spec declares `none` for the specification section — no Patent Law, Implementing Regulations, or Examination Guidelines clause requires paragraph numbering — so the engine neither writes nor strips, and paragraphs enter as they are.

## Draft mapping

`contentFromDraft(draft)` is the deterministic `SpecDraft` → `FilingContent` bridge. Lists have no node kind in the content model, so a `list` block becomes one paragraph per item. Table captions are numbered continuously across the document (`表 N · 名称`) and the caption paragraph precedes the `table` node whose first row is the header. The consistency test in `tests/from-draft.spec.ts` pins the same draft's claim numbers, table captions, and figure captions against the HTML channel's `renderSpecDraftSections` output.

A drawing-free invention (Examination Guidelines Part II Chapter 2 §2.3) passes `figureFiles: []` and an empty `drawingDescriptions` part: `contentFromDraft` omits the 附图说明 heading, the build drops both optional figure sections, and the verifier expects a three-section document and treats 附图说明 as an optional heading. A utility model still needs drawings; that requirement is enforced by `spec-check`, not by this package.

## verify_patent_filing tool

verify_patent_filing takes one `docx` path and returns `passed`, the failing assertions, and the measured summary. It asserts the formatting a reader cannot see is missing only at review time — section count, per-section headers, line spacing, first-line indent (image paragraphs and the specification-title line are checked at zero), font size (tables included), and the absence of any non-black text, which is how a heading that fell into a Word built-in style shows up — plus the content checks: the five specification parts, the specification title (when the spec declares `specification_title`: the first line equals claim 1's subject, centered, followed by a blank line), every declared section carrying content, at least one claim, paragraph numbering continuous from 1 (effective under the spec's per-section declaration — with no section declaring numbering the assertion has no subject), and no surviving internal marks such as 待补案卷号 or 内部复核稿. The per-section check is what catches a section whose content never arrived: section count, headers, and numbering continuity all pass on a document missing one section's text. It also reverse-derives the template's formatting and reports a drifted template as a failure.

<a id="filing-assets"></a>
## Filing assets

Three assets ship at the package root and are resolved through `import.meta.url` in both the source and the bundled execution layout. A packaged desktop app keeps them outside `app.asar` (`asarUnpack` in `apps/desktop`): the Python child process reads the engine, template, and spec from the real filesystem, so resolution targets the sibling `app.asar.unpacked/` tree and fails when the assets are left packed instead of handing the child process a path it cannot open:

| Asset | Role |
|---|---|
| `assets/template/申请文件模板.docx` | The formatting source of truth. `assets/template/TEMPLATE-IDENTITY.md` records the file's fingerprints and the de-identification applied to its `docProps` parts. |
| `assets/spec/申请文件.json` | The document contract: section plan, numbering policy, and the assertions the verifier runs. Its `style` block is a projection of the template, and its numbering pattern is the one the builder writes and the verifier checks. |
| `assets/engine/` | The Python engine: `style.py` reverse-derives formatting, `build.py` writes the DOCX, `verify.py` asserts the result, `render_figures.py` rasterizes SVG sources. |

Formatting changes go into the template. A deployment that ships its own template must review `specPath` with it: a `style` block that disagrees with the template stops the build, and that check is the point — a document silently formatted by a different template is the defect this package exists to prevent. A section whose `kind`, source key, or figure index does not match the content stops the build for the same reason: a section that comes out empty would still satisfy the section count, the headers, and the numbering.

## Configuration

Schemastery configuration, every field optional.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| pythonPath | string | discovered | Absolute Python interpreter. Discovery order: this field, `DSH_PYTHON_PATH`, `DSH_PRIMARY_RUNTIME`, the packaged runtime under the Harness home (`DSH_HOME`, default `~/.dsh`), then `PATH`. A configured path that does not exist fails at load instead of falling back; a host where nothing is discoverable still mounts the plugin, and each tool call reports the missing interpreter. |
| chromePath | string | discovered | Absolute Chrome executable used for `.svg` rasterization; overrides `DSH_CHROME_PATH`/`CHROME_PATH` discovery. |
| templatePath | string | packaged template | Absolute template path; the formatting source of truth. |
| specPath | string | packaged spec | Absolute spec path; review it with any template change. |
| outputRoot | string | `.dsh/documents` | Output directory relative to the process working directory when neither `outputDir` nor `caseId` is given. |
| figureScale | number | 3 | Rasterization factor applied to a drawing's own width and height. |
| timeoutMs | number | 120000 | Timeout for one engine call; the SIGTERM→SIGKILL grace (3 s) and the per-stream output cap stay fixed. |

The engine needs `python-docx`; the packaged runtime payload supplies it, and discovery checks that an interpreter exists rather than probing its imports, so point the setting at one that carries the library — a first call against an interpreter without it names that interpreter instead of failing obscurely. `.svg` rasterization needs a discoverable Chrome, and only `figures` entries ending in `.svg` reach it.

<a id="model-experience"></a>
## Model Experience

### build_patent_filing tool

#### What the model sees

One registered tool named `build_patent_filing` with a required `draft` object (the shared `SpecDraft`: `meta`, unnumbered `claims`, `abstract`, `figureFiles`, `abstractFigure` (which figure goes into the 摘要附图 section, default 1), and the five specification parts as `paragraph`/`list`/`table` blocks (the drawing-description part lists one item per figure, each carrying only the figure name and description text without a figure number prefix or terminal punctuation)), a required `outputName`, and optional `caseId` and `outputDir`. The result renders as Markdown prose: the written path, the reverse-derived formatting, the per-section paragraph and figure tallies, the paragraph-numbering total beside the source numbering it checked, the figure count, and the truncated template fingerprint. See the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-patent-filing) for the schema itself.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is about six short lines resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

### verify_patent_filing tool

#### What the model sees

One registered tool named `verify_patent_filing` with a required `docx` path. The result renders as Markdown: a pass/fail head, one line per failing assertion, then the measured section count and headers, the paragraph, claim, numbering, table, and figure counts, the per-section tallies, and the truncated template fingerprint.

#### Token effect

Fixed definition cost on every request while the tool is enabled; a passing result is a few lines, and a failing one carries one line per failed assertion.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Figures reach the document as bitmaps** — a `.svg` source is rasterized before inserting, so the DOCX holds images rather than vector drawings. Re-export a drawing by re-running the build; the recorded template fingerprint does not cover figure sources.
- **The HTML review draft is not an input** — the upstream `claims-spec` draft is consumed as the shared controlled draft, so whoever produces it hands the same `SpecDraft` to both channels rather than a rendered file path. An importer for the rendered HTML was deliberately left out: the four defects recorded in the porting record all came from reading element structure out of that HTML.
- **Page count is not asserted** — the verifier compares formatting parameters, section boundaries, and content, but the pagination a real Word build produces depends on font metrics; LibreOffice reports a different page count for the same file and is not an arbiter.
- **The DOCX was never opened in Word on the development host** — the porting record states the same limitation; `genoffice` was the page-count arbiter.
- **The template carries no table formatting** — the packaged template has no table, so `table_size_pt` is the one formatting value the template cannot be reverse-derived for; it is declared in the spec and asserted through `max_sizes_pt`.
- **A deployment's own template must be paired with its own spec review** — the packaged spec asserts the five statutory sections and their headers; a template with a different section plan fails the build rather than adapting.

### Dev Note

None.
