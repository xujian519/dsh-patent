---
description: "Pure TypeScript library (no `ctx` dependency) holding the document writing-style model: the DocumentStyle vocabulary of tone, voice, anti-patterns, disclaimers, and citation conventions, its loader over shipped Chinese style assets, and the system-prompt, template-context, and render-style projections."
kind: "package-reference"
---

# @deepseek-ai/dsh-doc-style

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-doc-style` holds the document writing-style model: what tone, voice, forbidden words, disclaimers, and citation conventions a document of a given domain follows. A style is a YAML asset with six sections; the package loads the shipped Chinese styles, layers a deployment's own directories over them, and projects one style into the three shapes its consumers need. The package takes no Cordis context, registers no tool and no prompt section, and owns no durable state.

## Table of Contents

- [Style assets](#style-assets)
- [Placeholder vocabulary](#placeholder-vocabulary)
- [Projections](#projections)
- [Loading](#loading)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="style-assets"></a>
## Style assets

Four styles ship under `assets/styles/`, transcribed from the upstream project: `patent-standard`, `legal-standard`, `assistant-neutral`, and `chat-friendly`. Each declares a name, a domain, a version, and these sections:

| Section | Meaning |
| --- | --- |
| `tone` | Formality, narrative perspective, and language tag. |
| `voice` | Voice principles, one imperative per entry. |
| `anti_patterns` | Forbidden or discouraged words with their replacements and a `block` or `warn` severity. |
| `disclaimers` | Disclaimer texts keyed by category key. |
| `citation` | Citation placement and format template. |
| `output_conventions` | Whether to attach confidence labels and to de-emphasize low-confidence content. |

An asset is a file boundary, so every declared value is validated when the style loads: a formality outside `casual`/`professional`/`academic`, a severity outside `block`/`warn`, a citation style outside `inline`/`footnote`/`endnote`, a blank disclaimer, or a non-boolean convention fails the load. A section the asset omits keeps its empty value.

<a id="placeholder-vocabulary"></a>
## Placeholder vocabulary

The document pipeline rejects and fills one shared vocabulary of placeholders rather than one per consumer. `placeholderBracePattern()` is the fillable form: any non-empty, at-most-80-character run between `{{` and `}}` holding no brace and no newline, so `{{client_name}}`, `{{客户名称}}`, and the padded `{{ case_id }}` are all placeholders — a consumer trims the name before matching a variable, which is what makes every brace form the quality gate blocks one a caller can fill. `residualPlaceholderPatterns()` adds the markers no variable fills: the bracketed `[TBD]`/`[TODO]`/`[REPLACE]`/`[PLACEHOLDER]`/`[XXX]`, `Lorem ipsum`, `待补充`/`待填写`/`此处填写`, and the official-form markers `×××`, `(写明`, and `（写明`, read from the `PLACEHOLDER_MARKERS` table so documentation and skill text enumerate the same list the gate enforces. A bare `……` stays out of the table because it is ordinary prose punctuation; a copied form that uses it as an empty field must be rewritten to a Chinese marker.

Every call returns fresh expressions: a scan site owns its `lastIndex`, so no two consumers share scanning state. The template engine substitutes by name with the brace form and reports what substitution left behind; the `document_deliver` checks reject the residual forms. Both read this module, so a change to either form cannot land on only one side.

<a id="projections"></a>
## Projections

One style projects into three shapes, because the consumers need different amounts of it.

- `systemPrompt(style)` renders the whole guide as the block a model reads before writing: the tone, the voice principles, the forbidden words with their replacements, the disclaimers, the citation rules, and the output conventions. A section the style leaves empty is omitted entirely.
- `toRenderStyle(style, categoryHint)` reduces the style to what a renderer injects: the name, which selects an HTML stylesheet, and the disclaimer.
- `disclaimerFor(style, category)` selects the disclaimer of one template category: `specification` and `claims` take `patent_drafting`, `oa-response` and `disclosure` take `patent_analysis`, and a category with no entry falls back to the domain-level `<domain>_analysis` disclaimer. A style that has neither returns the empty string, which means no disclaimer applies.

`findStyleByName(styles, name)` queries a loaded set by name.

<a id="loading"></a>
## Loading

`loadStyles(directories)` reads every `.yaml` asset of every listed directory and layers them: a later directory replaces an earlier style of the same name in place, so a deployment overrides a shipped style without recompiling. Every listed directory must exist, a malformed asset aborts the load, and a set that ends up empty is an error. `stylesDirectory()` resolves the packaged directory, which a caller lists first.

The upstream loader skipped a missing directory and skipped a file it could not parse. Both are failures here: a typo in a configured directory, or a broken override, must not leave a deployment silently on the shipped default.

## Model Experience

### Consumer-rendered style text

#### What the model sees

No prompt section and no tool schema of its own. A consumer that injects a style guide into a request calls `systemPrompt` and owns the assembly, so the model sees a consumer-rendered block such as `Style: <name> (domain: <domain>, version: <version>)` followed by the sections that style declares.

#### Token effect

None by itself; a style guide enters a request only through a consumer, and its size is the sections that style declares.

#### KV Cache effect

None: the package sends nothing to a provider and mutates no request prefix.

## Known Limitations and Deferred Work

- **The disclaimer map is transcribed, not derived** — the category keys and the `<domain>_analysis` fallback are copied into `DISCLAIMER_CATEGORY_KEYS`, so a category needs its own entry rather than a derived key.
- **No category reaches `prior_art`** — the patent style declares a `prior_art` disclaimer for search results, but no template category maps to it, so a search report carries the drafting disclaimer.
- **Only `style` selects a style** — a template names its style in front-matter; nothing selects a style by domain at render time, so a template without a style renders without a disclaimer.
- **Directions are not enforced** — the loaded `tone.perspective` and `citation.style` are validated as values, but nothing checks a document against them. [`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.md) checks the one direction that translates into a mechanical test — the `anti_patterns` words, at the severity the asset declares — and nothing else here is enforceable without reading the document's meaning.
- **The shipped styles are Chinese only** — the assets declare `language: zh-CN` and carry Chinese principles, so a style for another language is a new asset.

### Dev Note

The package is a rewrite of two files of the MIT-licensed Go project Mady: `domains/config/style.go` for the model and its projections, and `domains/config/style_embed.go` for the loader, plus the four `styles/*.yaml` assets. The deliberate differences are recorded in the module JSDoc of the modules they touch: the loader fails loud where upstream skipped a missing directory and a malformed file.
