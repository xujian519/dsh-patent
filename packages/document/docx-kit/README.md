---
description: "Markdown to DOCX rendering and DOCX to text projection over Node's standard library only: six heading levels, paragraphs, unordered lists, tables, and inline bold and code, with recoverable parse failures returned as structured problems."
kind: "package-reference"
---

# @deepseek-ai/dsh-docx-kit

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-docx-kit` renders Markdown into a DOCX package and projects a DOCX package back to text. `renderDocx(markdown, options)` accepts six heading levels, plain paragraphs, `- ` and `* ` list items, pipe tables, and inline bold and code spans; `extractDocxText(bytes, limits)` returns the body, header, and footer text with heading levels preserved, reading under the caller's entry-count and uncompressed-byte budgets. Both directions use the ZIP and XML readers of this package over `node:zlib`, and a malformed archive comes back as `problems` rather than an exception. The package registers nothing into a Cordis composition.

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

### When to use it

[`@deepseek-ai/dsh-doc-template`](../doc-template/README.md) consumes it to render DOCX, and [`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.md) consumes it to extract DOCX text. It is the TypeScript rewrite of the author's Go DOCX renderer and reader, and a consumer reaches for it when it must produce DOCX bytes or read DOCX text without an Office library and without an external process.

### Entry point

```ts
import { extractDocxText, renderDocx } from '@deepseek-ai/dsh-docx-kit'

const bytes = renderDocx('# 标题\n\n正文**加粗**', { title: '交付件' })
const { text, problems } = extractDocxText(bytes, { maxArchiveEntries: 10_000, maxUncompressedBytes: 64 * 1024 * 1024 })
```

`renderDocx` returns the package bytes and throws only for a part name that cannot be stored. `extractDocxText` always returns: `text` holds every projected line joined by a blank line, `sections` lists the same lines with their heading levels, and `problems` names every archive or part failure, from `not-a-zip` through `too-large`, `malformed-xml`, and `no-text`.

The read budgets are a required argument rather than a default: one deflate stream can expand a small file thousands of times, so a reader that bounds nothing turns a bounded input into an arbitrary allocation. An archive over either budget is reported as `too-large` and left out, never truncated.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Both directions share the ZIP container and the XML scanner, so each line of the table below is reachable from either entry point.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | The shared vocabulary: the block model, the text projection, the problem codes, and the part names. |
| `src/xml.ts` | The XML scanner, the element tree, and entity escaping and decoding. |
| `src/zip.ts` | The ZIP reader and writer over `node:zlib`, with CRC-32 checksums, per-entry problems, and the caller's read budgets. |
| `src/markdown.ts` | `parseMarkdown` and `parseInline`: source lines to the block model. |
| `src/ooxml.ts` | The `word/document.xml` fragments and the two package parts. |
| `src/docx-write.ts` | `renderDocx`: the block model to fragments to a complete package. |
| `src/docx-read.ts` | `extractDocxText`: a package to lines, sections, and problems. |

The projection rules of the read direction are stated in full on the module JSDoc of `src/docx-read.ts`: a paragraph becomes one line built from its `w:t` text, a heading line carries a `#` prefix per level, a table row becomes its cells joined by ` | `, and the header and footer parts project in archive order behind their label lines.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Document group](../README.md) — the sibling packages of this group.
- [Office conversion](../../../docs/subsystems/office-kit.md) — the Host-side conversion path for Office files.
- [Package groups](../../README.md) — what each group owns.

-----

<a id="model-experience"></a>
## Model Experience

### Consumer-rendered document text

#### What the model sees

The package registers no prompt section, tool schema, or session event. A consumer that exposes either direction owns the model-visible text, whether that is a rendered `.docx` path or the `extractDocxText` projection, and this package contributes the text plus the `problems` a consumer can report.

#### Token effect

None by itself: the library adds no definition, prompt section, or result text to a request. Only a consuming tool's own schema and result carry tokens.

#### KV Cache effect

None: the package sends nothing to a provider and mutates no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The Markdown subset is the upstream subset** — ordered lists, block quotes, thematic breaks, links, images, and fenced code blocks are not recognized: their lines stay paragraph text, so a document using them renders without those structures instead of failing.
- **The text projection is not a Markdown round trip** — bold and code are run properties rather than text, so their markers are not restored; a list item projects as its bullet character, and table rows project as separate lines separated by a blank line, which a re-render reads as one single-row table per row.
- **Heading levels come from two properties** — `w:pStyle` naming `HeadingN` or the localized numeric form, otherwise an inline `w:outlineLvl` counting from zero; a paragraph carrying neither is a body paragraph, and a style that names a level wins over an outline level.
- **Parts are decoded as UTF-8** — the ZIP name flag is not consulted, so a legacy CP437 entry name decodes lossily and a UTF-16 document part reports `malformed-xml`.
- **ZIP64 archives report `unsupported-archive`** — entry data and archives beyond the 32-bit size and offset fields are out of scope.
- **The read budgets bound memory, not the work** — an archive that fits its budgets is still inflated synchronously, so the caller's process blocks for the duration and no cancellation reaches it.
- **A table nested in a cell contributes only text** — its paragraphs join the cell text, so its row and cell separators are not projected.
- **Headers and footers are selected by name prefix** — any `word/header*.xml` or `word/footer*.xml` part is projected in archive order, including a part such as `word/headerStyles.xml`.
- **Only text and heading levels are read** — styles, numbering, footnotes, comments, images, and deleted text (`w:delText`) are not projected.
- **The consuming plugins own file paths and authorization** — [`@deepseek-ai/dsh-doc-template`](../doc-template/README.md) passes a byte limit and owns the output path; [`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.md) passes read budgets and owns the extracted text.

<a id="dev-note"></a>
### Dev Note

The package is a rewrite of two files of the MIT-licensed Go project Mady: `domains/doctmpl/renderer_docx.go` for the write direction and `knowledge/fileindex/reader_docx.go` for the read direction. The deliberate differences are recorded in the module JSDoc of the modules they touch: the writer emits sizes in the local file header instead of a data descriptor and uses a fixed DOS timestamp, so equal input bytes produce equal output, and the reader reports structured problems where the Go reader returned empty text and a `Confidence` field.
