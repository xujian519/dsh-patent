# Agent Note: Patent documents render from the controlled draft only

Status: implemented

English | [中文](2026-10-10-patent-documents-single-channel.zh.md)

## Problem

The 2026-10-10 scan found the same five document names in two template systems: `@deepseek-ai/dsh-doc-template` shipped `claims-spec`, `invalidation-opinion`, `patentability-opinion`, `search-report`, and `oa-response-sati` as variable-substitution assets, while `@deepseek-ai/dsh-patent-document` renders the same documents from a controlled draft. The controlled-draft rewrite (the PR #380 series, including `the controlled draft is the only content channel`) had moved one side only, so the claim was not true of the repository: a caller could render `claims-spec` through `render_doc_template` with no draft, no slot validation, and no compliance scan.

Three verified facts settled the direction. The patent preset mounts `@deepseek-ai/dsh-patent-document` and never mounts `doc-template`, so `render_doc_template` was unreachable inside patent mode and the five assets had no consumer beyond their own tests, the doc-template README, and the debt ledger. The two engines are not interchangeable: `patent-document` fills HTML body slots, injects the `tokens.css` brand, writes deterministic paragraph numbers, exports PDF through headless Chrome, audits the rendered HTML, and verifies a deliverable byte-for-byte, none of which `doc-template` offers. And a document a deployment cannot reach is still a document the catalog teaches: `list_doc_templates` returned the five names to every document-mode session.

## Decision

Patent deliverables have one production channel: `@deepseek-ai/dsh-patent-document` renders them from a controlled draft, and `@deepseek-ai/dsh-patent-filing` writes the submission DOCX from the same draft. The five duplicated assets are deleted from `dsh-doc-template`, whose shipped corpus is now twelve templates in four categories (`specification`, `claims`, `oa-response`, `disclosure`); `TEMPLATE_CATEGORY_ORDER` no longer carries `patent-report`, and the shipped templates declare no style, so no shipped template renders a disclaimer. `@deepseek-ai/dsh-doc-style` keeps its `patent-report` disclaimer key for a deployment that supplies its own template under that category.

The decision is machine-checked rather than documented as a boundary: `packages/bundle/web-app/tests/patent-preset.spec.ts` compares the declared names of the doc-template assets with the patent-document template ids and fails when one name appears on both sides.

**The DOCX serialization layers stay separate; the controlled draft is the shared seam.** `patent-filing` keeps its template-driven Python engine: `assets/engine/build.py` writes the filing through `python-docx` from the shipped `.docx` template, and `assets/engine/style.py` reverse-derives fonts, sizes, line spacing, indents, section count, and headers from that template. `@deepseek-ai/dsh-docx-kit` remains the generic Markdown writer and bounded DOCX text reader for the document workline: its writer emits exactly `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`, with no styles, numbering, media, headers, or section properties, so it cannot carry filing formatting. `patent-document` renders HTML and PDF and writes no DOCX. Both patent channels project the same `SpecDraft` through `patent-core`'s `SPEC_PART_ORDER`, `SPEC_PART_HEADINGS`, `formatTableCaption`, and `numberedFigureDescriptions`.

## Alternatives considered

**Keep both systems and write the boundary down.** Rejected: the boundary would live in prose while the model-facing catalog still offered a path with no draft validation, and the two systems would still need every style, field, and format correction twice.

**Port `patent-document` onto the `doc-template` engine.** Rejected: the patent deliverables depend on capabilities the variable-substitution engine does not have — HTML body slots with generated headings, claim numbers and captions, `tokens.css` brand injection, deterministic paragraph numbering with strip-then-write idempotence, headless-Chrome PDF, the post-render HTML audit, and `verify_deliverable`. Rebuilding them on the `doc-template` side risks the delivered 体例 that the patent work exists to protect, and buys nothing a user can observe.

**Route patent documents through `doc-template` and retire `patent-document`.** Rejected: it inverts the decision that made the draft the only validated channel, and the preset's delivery gate (`rule_check` plus `law_verify`, and `patent_workflow_run` for the analysis templates) hangs off `render_patent_document`.

**Reuse `docx-kit` as the patent DOCX writer.** Rejected: the kit writes a three-part minimal package with fixed inline formatting, while filing correctness depends on template-derived styles, section headers, page breaks, and one page per drawing. Making the kit carry those would rebuild the Python engine in JavaScript and turn a Markdown renderer into a second template engine.

## Consequences

A patent deliverable can no longer be produced without passing the draft schema and the compliance scan, and patent mode's model-facing catalog is unchanged because it never contained `render_doc_template`.

A deployment that rendered one of the five names through `render_doc_template` must migrate; the upgrade guide `docs/upgrade-guide/v0.2.1-alpha.2/doc-template-patent-report-assets-removed/guide.md` states the steps.

Engine coverage that used the shipped assets as its only styled, declared-variable example now rests on test fixtures in `packages/document/doc-template/tests/styled-template.ts`; `tests/assets.spec.ts` asserts that the shipped corpus declares no style, so the shipped-versus-fixture split stays visible.

`dsh-doc-style` carries a `patent-report` disclaimer key that no shipped template declares. Removing it would break a deployment that names the category in its own template, so it stays as a mapping entry.

`patent-filing` declares no `docx-kit` dependency, and `docx-kit` stays a document-workline package. A future shared DOCX engine needs a second consumer with the same fidelity contract and behavior-equivalence tests on both sides; it is not extracted speculatively.
