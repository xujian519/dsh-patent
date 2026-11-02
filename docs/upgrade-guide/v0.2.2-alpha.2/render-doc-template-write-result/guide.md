---
kind: upgrade-guide
description: "`render_doc_template` stops returning the document body after writing to `output_path`, omits `content` and `markdown` from the written result, and requires `output_path` for `docx`."
---

# `render_doc_template` reports a written file instead of its body

English | [中文](guide.zh.md)

## Change

A `render_doc_template` call with `output_path` now returns the written file's `path` and `bytes` beside `residual` and `warnings`, and leaves `content` and `markdown` out of the result. The model-facing result text no longer appends the `--- document ---` section; it states that the body is on disk and points at `read`. The output schema makes `content` and `markdown` optional, so a consumer type-checking against `RenderDocTemplateOutput` must handle their absence.

A `docx` render without `output_path` now fails with `DocTemplateError` code `output-path-required`. The tool no longer returns the base64 package in `content`.

Inline renders of `markdown` and `html` without `output_path` keep returning `content` and `markdown`, so a small render's result text is unchanged.

Deployments, skills, and automation that read `content` or `markdown` from a written render observe this change. Sessions already recorded keep their old result text; the change applies to new calls.

## Migration

1. Replace every read of `content` or `markdown` from a written render with the returned `path`: read the file through the session filesystem or the HTTP workspace endpoint.
2. Pass `output_path` on every `docx` call, for example `format: "docx", output_path: "out/report.docx"`. Remove prompt or skill steps that decode a base64 `content` field.
3. Update TypeScript consumers of `RenderDocTemplateOutput` to narrow `content` and `markdown` before use. `InlineRenderedDocument` is the exported type for the no-`output_path` case where both fields are present.
4. Confirm: `pnpm exec vitest run packages/document/doc-template` passes; a `docx` call with `output_path` returns no `content` and no base64; the same call without `output_path` fails with `output-path-required`.
