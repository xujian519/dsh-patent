---
description: "Function plugin porting the Sati patent document renderer into the DeepSeek Harness: thirteen shipped Chinese attorney-deliverable HTML templates, brand injection, headless-Chrome PDF rendering through ctx.subprocess, the render_patent_document tool with the controlled-draft converters for all thirteen templates, and the verify_deliverable delivery-consistency check."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-document

English | [中文](README.zh.md)

## Summary

Function plugin porting the Sati patent document renderer into the DeepSeek Harness: thirteen shipped Chinese attorney-deliverable HTML templates, brand injection, headless-Chrome PDF rendering through ctx.subprocess, the render_patent_document tool, and the verify_deliverable delivery-consistency check.

## Table of Contents

- [render_patent_document tool](#render_patent_document-tool)
- [Controlled drafts](#controlled-drafts)
- [verify_deliverable tool](#verify_deliverable-tool)
- [Document engine (library API)](#document-engine-library-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## render_patent_document tool

The claims-spec filing document takes a controlled draft (`draft` parameter, validated by `validateSpecDraft` in `dsh-patent-core`): bibliographic `meta`, unnumbered `claims`, multi-paragraph `abstract`, `figureFiles`, the abstract figure number (`abstractFigure`, default 1), and the five specification parts as `paragraph`/`list`/`table` blocks; the drawing-description part is a list with exactly one item per figure (the item count must equal the `figureFiles` count); each item carries only the figure name and description text, with no figure number prefix or terminal punctuation, because the renderer adds 「图N为」 and the `。`/`；` separator. The `draftConverter` module generates every heading, claim number, figure number (`图N为……`), and table caption (`表 N · 名称`, numbered continuously across the document) from that structure, and escapes all model text, so a valid render cannot carry model-authored markup; tables are accepted only in the embodiment part. A slot replaces only its own element's content: section headings and skeleton wrappers stay in the template in both mechanisms, so filling a body container never drops its heading, and an omitted optional slot contributes no text. The two form templates — right-evaluation-report and search-report-form — take a form draft instead (`validateTemplateDraft` against the `draftSchema` registry): `fields` text slots fill `.fill` spans (one id can appear in several places, e.g. the searcher name in both the header and the signature row), `choice` slots render `.cb` checkbox state by option id (`data-slot="<group>:<option>"` in the template, multi-select groups take an array), and `sections` carry `blocks` (paragraph/list, one cloned line per paragraph or item, surplus template lines removed) or `rows` (equal-width string arrays cloned per form data row, e.g. the six-column related-documents table). The ten remaining document templates — patentability-opinion, search-report, oa-response, invalidation-opinion, invalidation-analysis, invalidation-defense, rectification-response, re-examination-request, infringement-opinion, and litigation-pleading — take id-keyed drafts: `fields` fill leaf text slots (meta and footer ids), and `sections` carry `blocks` (paragraph/list/table, table captions generated and numbered continuously), `rows` (equal-width string arrays cloned from each table body's placeholder row), or `grounds` (invalidation reason items — `article`, `ground`, `claimNos`, `facts`, `evidence`, `conclusion`; the section heading `4.N 权利要求 …不具备…（法条）` and the four-part sub-headings are generated from those fields). `invalidation-opinion` renders the external request; `invalidation-analysis` renders the internal opinion that may carry the citation log, the outcome tiers, and the gap disclosure; `invalidation-defense` renders the patentee-side reply, whose per-reason answers reuse the same generated section skeleton with the template's own relation word (`权利要求 1 的创造性` instead of `权利要求 1 不具备创造性`). Every template requires a controlled draft; the legacy `sections` innerHTML parameter is gone, and callers passing it are rejected at the argument gate.

render_patent_document renders one of the thirteen shipped templates — patentability-opinion, search-report, oa-response, claims-spec, invalidation-opinion, invalidation-analysis, invalidation-defense, rectification-response, re-examination-request, infringement-opinion, litigation-pleading, right-evaluation-report, or search-report-form — into an HTML file and, by default, a PDF. Pick a template id and an outputName, then pass the controlled draft (structure below). The result is model-facing prose naming the written htmlPath, pdfPath, any pdfError, and warnings; when the PDF fails, the HTML still exists.

The renderer also checks the assembled document and reports each finding in `warnings`: a `一、`-style number outside the section heading level (the level is the document's first numbered heading, and the shipped templates that number sections use `h2`, so a numbered `h3` or `h4` collides with the skeleton), a duplicated section number, a section number out of ascending order, a heading using internal working-record wording, and body text carrying an internal working-record phrase (a success-rate tier, a gap list, a to-do, or an internal data key such as `source_path`). Evidence ids and the evidence list must also cover each other: every id the body cites outside the list table has to be registered in that table, every registered id has to be cited at least once in the body, and a row whose id cell is unfilled is reported on its own. The id form comes from the list's own id column (the `D` of `D1`, the `对比文件` of `对比文件1`), so patent numbers and reference numerals are not mistaken for ids; a range such as `D1–D4` expands to its members, and a list whose id column holds bare numbers reports only unfilled rows. A draft slot replaces only the slot element's inner content: skeleton wrappers and their headings stay in place, and the converters generate the headings, numbering, and captions inside each slot. The rules and both wording lists the renderer checks live in `document/documentCompliance.ts`; `scripts/verify-patent-document-output.ts` applies the same checks offline to a produced file or to the shipped template examples. Internal working records belong to a template the manifest lists in `internalRecords` (`invalidation-analysis`); those templates skip the internal working-record checks, while the evidence cross-check runs in both scopes. The renderer takes the scope from `input.template` while the offline gate takes it from the template directory the file lies in. The checks report rather than reject, so a rendered document with findings still reaches the caller.

A template declares paragraph numbering on a container with `data-paragraph-numbering`; the attribute value is the number's form (`[0001]` means bracketed, four digits, zero-padded). No Patent Law, Implementing Regulations, or Examination Guidelines clause requires paragraph numbering, so the claims-spec specification section does not carry the attribute by default; add it to a section when the filing format uses numbering, and every `<p>` and `<li>` in that section is written with a literal `[0001]`, `[0002]`, … number, continuous from 1, while headings, table content, and image-only paragraphs receive no number. The number is literal text rather than a CSS counter so the PDF and any downstream HTML-to-docx conversion read the same characters. Existing numbers are stripped and rewritten, so re-rendering is idempotent and hand-written numbers never stack — do not author the numbers by hand.

## Controlled drafts

`renderSpecDraftSections(draft)` converts a validated `SpecDraft` into the id → innerHTML map the renderer injects: the `meta-*` slots and the footer slots (`footer-date`, `footer-case`) take escaped bibliographic text; `claims` becomes one `.claim-item` per claim with an auto-incremented number; `specification` becomes the five `h3` parts in `SPEC_PART_HEADINGS` order, with the drawing-description list items renumbered as `图N为……` and embodiment tables captioned `表 N · 名称`; `abstract` becomes the `.abstract-box` with one paragraph per entry plus the `abstractFigure` line (default `1`). For the form templates, `injectTemplateDraft(html, template, draft)` fills `data-slot` attributes directly: text slot values are escaped and written into every matching element, choice selections add the `on` class to the matching checkbox, blocks sections clone the template line wrapper per block, and rows sections clone the `<tr data-slot>` row template per data row; the finished document carries no `data-slot` attributes. Each form template ships a `references/slots.md` inventory (the registry's fact source), an `assets/example-draft.json`, and an `example.html` regenerated from that draft; `tests/draft-schema-conformance.spec.ts` mechanically locks the registry against every `data-slot` in the template. The ten document templates share the same conformance lock: every element id in the template is either a registered field/section slot or a static wrapper entry, and every registered slot exists in the template; rows slot column counts match each table body placeholder row. Their masthead number line (`doc-number`) and footer number (`footer-case`) are required slots too, so a rendered document never carries a document number the template invented. The render pipeline rejects a SpecDraft for any template other than claims-spec, a templateDraft for claims-spec, and draft plus templateDraft together; the tool requires a draft on every call.

## verify_deliverable tool

verify_deliverable decides whether a delivery is the one the case main path shows. It takes `artifacts` (each pairing a role with the case main path `canonical_path` and the delivered copy `delivered_path`), optional `figures`, and an optional `rendered` file. Each pair is compared byte for byte, and `rendered` is ordered against every input the check read. Every path must name a regular file no larger than 64 MiB: a directory, device, FIFO, or oversized file is reported as a violation instead of being read. The result is `passed`, a `manifest` naming each file with its SHA-256 and mtime, and the violations: `artifact_mismatch` means a reader opening the case main path sees a superseded file, and `render_order` means the rendered deliverable predates an input it shows. Optional `requirements` (each the instructing party's own wording plus the files that evidence it) turn the check into the delivery's requirement checklist: a requirement with no evidence, or with an evidence file that does not exist, fails the delivery, and the result carries one row per requirement (requirement, evidence, satisfied) that the delivery report quotes instead of a prose assurance.

## Document engine (library API)

The package re-exports the ported engine for direct callers: renderPatentDocument, renderSpecDraftSections, renderBlocks, escapeHtmlText, renderPdf, findChrome, buildBrandStyle, mergeBrand, loadBrandFromPath, readTemplateManifest, resolveTemplate, readTemplateHtml, getTemplateRoot, and DocumentRenderError. These are keyless pure functions; nothing mounts them automatically.

## Configuration

Schemastery configuration, every field optional.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| chromePath | string | none | Absolute Chrome executable used for PDF; overrides DSH_CHROME_PATH/CHROME_PATH discovery. |
| outputRoot | string | .dsh/documents | Default output directory (relative to the process working directory) when neither outputDir nor caseId is given. |
| pdfTimeoutMs | number | 120000 | Timeout for one headless-Chrome print; a slower deployment can raise it without changing the SIGTERM->SIGKILL grace (3 s) or the per-stream output cap (100000 bytes), which stay fixed as a teardown symmetry and a memory bound. |

## Model Experience

### render_patent_document tool

#### What the model sees

One registered tool named `render_patent_document` with a required `template` enum (thirteen ids: `patentability-opinion`, `search-report`, `oa-response`, `claims-spec`, `invalidation-opinion`, `invalidation-analysis`, `invalidation-defense`, `rectification-response`, `re-examination-request`, `infringement-opinion`, `litigation-pleading`, `right-evaluation-report`, `search-report-form`), a required `outputName`, a required `draft`, and optional `caseId`, `outputDir`, `format`, `brand`, and `brandPath`. The result renders as Markdown prose naming the written `htmlPath`, `pdfPath`, any `pdfError`, and `warnings`.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is a few short file-path lines resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

### verify_deliverable tool

#### What the model sees

One registered tool named `verify_deliverable` with a required `artifacts` array (`role`, `canonical_path`, `delivered_path`), optional `figures`, an optional `rendered` path, and optional `requirements` (`requirement` in the instructing party's words plus `evidence` file paths). The result renders as Markdown: a pass/fail head, the delivery manifest naming each file with its SHA-256 and mtime, the per-requirement checklist when requirements were given, then any violations with a suggestion each.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result carries one manifest line per file it read.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No default brand theme.json** — the Sati products/_example/brand/theme.json default-brand fallback is dropped; callers must pass brand or brandPath explicitly, or the templates' tokens.css defaults apply.
- **PDF needs a discoverable Chrome** — headless PDF printing spawns Chrome through ctx.subprocess (replacing Sati's execFile); when no Chrome is discoverable (or chromePath/DSH_CHROME_PATH is unset), rendering degrades to HTML-only and the result carries pdfError.
- **Default output directory is .dsh/documents** — relative to the process working directory (replacing Sati's .sati/documents); a caseId keeps the data/cases/<caseId>/outputs convention.
- **brandPath reads a Sati-shaped theme.json** — the loader reads the documents.patent namespace from that file; no other theme schema is supported.
- **No figure page or image embedding** — the templates carry the 附图说明 text section only; a rendered document contains no drawing images, so drawings reach the client as separate attachments that the caller names and ships alongside the rendered file.
- **Paragraph numbering is opt-in and needs the renderer** — `data-paragraph-numbering` is a declaration, not markup; it is interpreted only by render_patent_document. No Patent Law, Implementing Regulations, or Examination Guidelines clause requires paragraph numbering, so the claims-spec template declares none; a template that declares it relies on the render path, and the writer must not author the numbers.
- **Draft cutover is complete** — `draft` is required for all thirteen templates; the legacy `sections` innerHTML parameter is removed, and callers passing it are rejected at the argument gate. Form-template page footers (per-page numbers), the right-evaluation stamp block, and the litigation signature slots are intentionally not draft-driven or optional; they are filled at finalization.

### Dev Note

None.
