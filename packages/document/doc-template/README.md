---
description: "Function plugin rendering the shipped Chinese document templates: YAML front-matter templates with a typed variable schema, validated resolution reporting residual placeholders and warnings, Markdown/HTML/DOCX renderers, and the list_doc_templates and render_doc_template tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-doc-template

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-doc-template` loads the document templates shipped with the harness and renders the one a caller selects. Each template is a Markdown asset whose YAML front-matter declares its category, domain, language, writing style, supported formats, and variable schema; its body fills `{{name}}` placeholders from the variables the call supplies (a name may be CJK or carry inner spaces; it is trimmed before lookup). Rendering returns the document together with the placeholders that stayed unfilled and the variable warnings, so a caller can tell a complete document from an incomplete one without re-parsing it.

## Table of Contents

- [Template assets](#template-assets)
- [list_doc_templates tool](#list_doc_templates-tool)
- [render_doc_template tool](#render_doc_template-tool)
- [Variable resolution](#variable-resolution)
- [Renderers](#renderers)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="template-assets"></a>
## Template assets

Seventeen templates ship under `assets/templates/`: twelve patent-domain assets grouped by directory — `specification/` (4), `claims/` (3), `oa-response/` (3), and `disclosure/` (2) — and five `document/` templates for the document preset (`prd`, `report`, `faq`, `release-notes`, `meeting-notes`). All of them are Chinese and declare `language: zh-CN`; the legal category of the upstream project is not part of this batch, and neither is the patent domain's own deliverables — those render from a controlled draft in [`@deepseek-ai/dsh-patent-document`](../../patent/patent-document/README.md) instead of a variable-substitution asset. The `oa-response/` category is document-mode only: its three templates are generic variable-substitution skeletons, not the patent response channel — a reply to a real office action renders from `dsh-patent-document`'s controlled draft, and the patent preset mounts no doc-template row.

Front-matter fields, read from the upstream template contract:

| Field | Meaning |
| --- | --- |
| `name` | Template name, unique within a store; required. |
| `title` | Document title, used as the renderer's level-1 heading. |
| `category` | Document category, which selects the style disclaimer. |
| `description` | One-line description shown to the model. |
| `domain` | Domain the template belongs to, e.g. `patent`. |
| `version` | Template version. |
| `language` | Language the body is written in; empty means the deployment default applies. |
| `style` | Writing style name, resolved against the loaded styles. |
| `use_when` | When the template should be used. |
| `formats` | Supported render formats; absent means Markdown only. |
| `vars` | Variable definitions, each with `name`, `type`, `required`, `default`, and `description`. |

A variable's `type` is one of `string`, `multiline`, `number`, or `bool`; an absent type is a single-line string. `language` is the only field this batch added to the upstream assets, and `formats` was written out explicitly where the upstream asset relied on the implicit Markdown-only default. The upstream composition and history fields (`extends`, `shared_vars`, `changelog`) are not carried: nothing composes or projects templates (see the Dev Note).

<a id="list_doc_templates-tool"></a>
## list_doc_templates tool

`list_doc_templates` returns the renderable templates with their variable schema, in category order (specification, claims, oa-response, disclosure) and then by name. The optional filters `category`, `domain`, `language`, and `query` combine; `query` is a case-insensitive substring matched against the name, title, description, and use-when text. The language of a template is its declared `language`, or the deployment default when it declares none.

<a id="render_doc_template-tool"></a>
## render_doc_template tool

`render_doc_template` resolves one template's variables and renders it. The result carries the suggested file name, the content type, the encoding, the residual placeholders, and the validation warnings. `format` defaults to Markdown and must be one the template declares; `title`, `author`, `date`, and `filename` override the template's own values, and `output_path` writes the rendered document through the session filesystem — UTF-8 text through `writeText`, a DOCX package through `writeBytes` — reporting the written path and byte count instead of repeating the document. An inline render without `output_path` returns the document in `content` and the resolved Markdown body in `markdown`; a DOCX render requires `output_path`, so the package never enters the result.

The call fails rather than returning a degraded document for an unknown template, an unknown style name, a format the template does not support, a variable whose value is not a string, and a missing required variable. A type mismatch and an unfilled placeholder are not failures: they are reported as a warning and as a residual placeholder, because a caller may still want the partially filled document.

<a id="variable-resolution"></a>
## Variable resolution

`validatedResolve(template, variables)` is the upstream pipeline, unchanged: validate, apply defaults, substitute, then report what is left.

- `VarSchema.validate` reports a missing required variable before its type, since an absent value has no type, and reports `invalid_type` for a value that is not a number or not `true`/`false`.
- `VarSchema.applyDefaults` copies the variables and fills the declared defaults; an empty default is no default.
- `substitutePlaceholders` replaces only the placeholders it has a value for, so an unfilled placeholder stays in the text.
- The returned `residual` lists every distinct `{{name}}` placeholder still present (CJK and inner-space names included, the name trimmed), in first-occurrence order, and `warnings` lists the validation issues in declaration order.

Upstream returned both lists to the caller and stopped there. This package keeps that pipeline and adds one decision above it: the render path turns a `missing_required` warning into an error, because a document missing a required variable is not a document a caller should deliver. The residual list is the deterministic evidence a document gate reads; it is reported for every successful render.

<a id="renderers"></a>
## Renderers

Three renderers ship, registered by format.

- `markdown` passes the resolved body through, prefixed with the style disclaimer and, when the body has no level-1 heading of its own, the document title.
- `html` converts the body with `marked` (GFM, hard line breaks) into a standalone document, with the patent A4 stylesheet for a patent style name and a screen stylesheet otherwise. Variable values are HTML-escaped before substitution in this format only, because the converter passes the templates' own raw HTML through. A Markdown link or image is written as an element only when its URL is http, https, mailto, or relative; `javascript:`, `data:`, `vbscript:`, and protocol-relative URLs become text. A placeholder introduced by a value is not expanded.
- `docx` delegates to `@deepseek-ai/dsh-docx-kit`, which writes the same OOXML package the upstream renderer wrote.

No PDF renderer ships. The upstream project had three: a Chrome one, a LibreOffice one, and a third of its own. The harness already owns a Chrome path and a LibreOffice path, so a third would duplicate both, and `pdf` is not an output format of this package.

<a id="configuration"></a>
## Configuration

Schemastery configuration, every field optional.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `templateDirs` | string[] | `[]` | Extra template roots, resolved against the working directory and layered after the packaged root. A later root overrides a template of the same name. |
| `styleDirs` | string[] | `[]` | Extra style directories, layered after the packaged one in ascending precedence. |
| `defaultLanguage` | string | `zh-CN` | Language a template that declares none renders in. |
| `includeDisclaimer` | boolean | `true` | Whether the style disclaimer is injected into rendered documents. |
| `styleGuide` | string | `''` | Loaded style name whose guide is injected as a system-prompt section; empty injects none. |
| `styleSectionOrder` | number | `100` | Position of the injected guide in the assembled system prompt. |

Every listed directory must exist: a configured root that is missing fails the plugin load rather than falling back to the packaged assets unnoticed. A `styleGuide` name no loaded style carries also fails the load, because a guide that silently does not apply would leave the model writing against a style no checker agrees with.

## Model Experience

### Injected style guide

#### What the model sees

When the deployment names a `styleGuide`, that style's guide enters the system prompt: the tone, the voice principles, the forbidden words with their replacements, the disclaimers, the citation rules, and the output conventions the style declares. The document preset points it at `assistant-neutral` and [`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.md) checks registrations against the same style, so the words the model is told to avoid and the words the gate refuses are one list.

#### Token effect

Fixed cost on every request of the agent that mounted the plugin: the shipped `assistant-neutral` guide is 428 characters over 20 lines, and `patent-standard` is 1222 characters over 40 lines. A deployment that wants no fixed cost leaves `styleGuide` empty; the forbidden words then reach the model only through the delivery gate's findings, which is why turning the guide off while keeping the gate on is recorded below as a limitation rather than recommended.

#### KV Cache effect

The section is static text, so it sits in the prefix: registering or removing the guide changes the prefix once, and nothing per request changes it afterwards.

### render_doc_template result

#### What the model sees

The `render_doc_template` tool definition and its result. The result text names the template, the format, the suggested file name, the content type, and the encoding, then either the written path and byte count or the inline document, then the residual placeholders and the warnings. A written render leaves the document body out of the result; an inline render shows it. A DOCX render always writes, because the tool requires `output_path`.

#### Token effect

Fixed definition cost on every request while the tool is enabled, plus an inline render's document. A written render reports only the path, byte count, residual placeholders, and warnings, so a long document is charged once at the write instead of on every later request.

#### KV Cache effect

Append-only; the tool definition and the rendered result follow the reusable request prefix and do not invalidate existing KV-cache entries.

### list_doc_templates result

#### What the model sees

The `list_doc_templates` tool definition and its result, one line group per template: category, name, title, description, formats, language, style, and each variable with its type, requiredness, and default. An empty filter result answers with one sentence naming no template.

#### Token effect

Fixed definition cost on every request while the tool is enabled, plus one short line group per matching template — a few hundred tokens for the shipped catalog, which is why the catalog is filtered rather than dumped whole.

#### KV Cache effect

Append-only; the listing follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Every template declares its variables, none of them required** — all seventeen templates carry a `vars` block whose names match the `{{name}}` placeholders in their bodies, declared `required: false` so a render degrades to `residual` instead of failing; a deployment that needs a variable enforced can mark it required in its own override. A template with a placeholder no `vars` entry names still reports it as residual.
- **Only one template per name** — a store keeps one entry per name, so a language variant needs its own name, as the upstream store documented. `findByNameAndLanguage` therefore filters the single entry rather than selecting among variants.
- **Template version drift is reported, not resolved** — `listConflicts` names an override whose version differs from the first-loaded one; nothing consumes it yet, and no template is merged or downgraded.
- **`systemPromptForTemplate` has no consumer yet** — the template-context projection of [`@deepseek-ai/dsh-doc-style`](../doc-style/README.md) is available, but the style guide this package injects is the template-free one (`systemPrompt`) and the render path uses `toRenderStyle` and `disclaimerFor` only.
- **The injected guide is not per template** — one agent reads one guide, chosen at load; a deployment that composes templates across styles gets the guide of the configured style and the disclaimer of each template's own, which the render path resolves separately.
- **An empty `styleGuide` leaves the gate unannounced** — [`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.md) refuses a word its style marks `block` whether or not the model was shown the guide, so a deployment that enables the checks and injects no guide can refuse a registration the model had no way to predict. Set `styleGuide` to the style the gate uses.
- **The shipped templates are Chinese only** — the assets self-describe with `language: zh-CN` and no bilingual twin ships, so a document in another language needs its own template asset.
- **`rendererRegistry` has no consumer yet** — the store hands out the registry a consumer would call to add a render format; every shipped format is registered at construction, so nothing reads it.
- **A written render runs under the deployment's file policy** — `output_path` is resolved against the session workspace and written without a per-call `sandboxPolicy`, so a workspace-confined deployment uses its configured root: a session whose working directory sits outside that root cannot write through this tool. Per-call escalation is deferred.
- **DOCX requires `output_path`** — a `docx` render without one fails, because a base64 package in the result would be re-sent on every later request and the model cannot decode it. The written file is the copy the caller reads.

### Dev Note

The package is a rewrite of six files of the MIT-licensed Go project Mady: `domains/doctmpl/loader.go`, `vars.go`, `store.go`, `format.go`, `renderer_registry.go`, `renderer_html.go`, `renderer_markdown.go`, and `renderer_docx.go`, plus the twenty-two templates of `domains/doctmpl/templates/` and the twenty of `doc-templates/`. Several deliberate differences are recorded in the module JSDoc of the modules they touch: an unknown format name fails the load where upstream dropped it, a duplicate name inside one asset root fails the load where upstream kept the first, `DocIndex` is not ported because the structured listing supersedes its presentation string, the upstream `extends`, `shared_vars`, and `changelog` front-matter fields are not carried because nothing composes or projects templates, and the DOCX renderer delegates to `@deepseek-ai/dsh-docx-kit` instead of carrying a second OOXML writer.
