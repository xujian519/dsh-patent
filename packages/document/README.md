---
description: "Package map for the document group: Host Office rendering and conversion, the model-facing Office tools, and the document agent preset's deliverable registration."
kind: "package-group"
---

# document/ — Office documents and document delivery

English | [中文](README.zh.md)

## Summary

The document group holds the document agent preset's model-facing plugins and Host-side Office work: render, convert, and recalculate authorized Office files for previews and the model's Office tools. `document-deliver/` provides `document_deliver`, which records delivered files, formats, and quality-gate state in the session log and backs the delivery studio's file list and badges. `doc-template/` renders packaged Chinese templates to Markdown, HTML, and DOCX, `docx-kit/` renders Markdown to DOCX and reads DOCX text, and `doc-style/` owns the tone, voice, anti-pattern, and disclaimer model. `office-kit/` runs the conversion service through LibreOffice kit, and `tool-office/` exposes its tools. Child READMEs own each package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns its configuration and lifetime rules; the subsystem reference describes the shared Office conversion operation.

| Package | Role | ctx key |
|---|---|---|
| [`document-deliver/`](document-deliver/README.md) | Model-facing `document_deliver`: record delivered files, formats, and quality-gate state in the session log. | (registers on `ctx.tools`) |
| [`docx-kit/`](docx-kit/README.md) | Markdown to DOCX rendering and DOCX to text projection over Node's standard library. | — |
| [`doc-template/`](doc-template/README.md) | Packaged Chinese document templates rendered to Markdown, HTML, and DOCX, with `list_doc_templates` and `render_doc_template`. | (registers on `ctx.tools`) |
| [`doc-style/`](doc-style/README.md) | Document style model: tone/voice/anti-patterns/disclaimers with the prompt, render-style, and disclaimer projections. | — |
| [office-kit](office-kit/README.md) | Authorized Office bytes to complete PDFs, PNG images, converted files, and recalculated workbooks with bounded queues and caching; the provider resolves its own Kit entry, engine manifests, and ASAR-unpacked engine paths | `ctx.officeKit` |
| [tool-office](tool-office/README.md) | `office_render`, `office_convert`, and `office_recalculate`, declared after an Office skill loads: render pages as images in the tool result, convert documents, and recalculate workbooks | — |

-----

<a id="related-documentation"></a>
## Related documentation

Consumers own source authorization and presentation.

- [Document conversion](../../docs/subsystems/office-kit.md) — shared operation and generated service reference.
- [Document preset](../bundle/web-app/presets/document.patch.yml) — the declaration whose composition mounts the delivery plugins.
- [Independent kit ownership](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) — engine distribution and application integration.
- [Workspace Files](../api/workspace-files/README.md) — authorized bounded source reads.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
