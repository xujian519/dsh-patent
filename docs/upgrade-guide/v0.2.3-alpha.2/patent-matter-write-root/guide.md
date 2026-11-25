---
kind: upgrade-guide
description: "HTML, PDF, DOCX, and figure writes use the matter directory, and fail when that directory cannot be resolved."
---

# Filing writes use the matter directory

English | [中文](guide.zh.md)

## Change

`render_patent_document`, `build_patent_filing`, `generate_patent_figure`, and `generate_structure_figure` no longer write to `<cwd>/.dsh/documents` or `<cwd>/data/cases/<case id>/outputs` unless that path is passed explicitly.

When `workbenchCaseRoot` and a case id resolve a matter, or the working directory already contains `_matter-log.md`, the file is written inside that matter directory. HTML and PDF use the template's existing layout subdirectory (`01-检索`, `03-分析`, `04-撰写`, or `05-答复`). DOCX and figures use `04-撰写`. Plugin `outputRoot` no longer defaults to `.dsh/documents`. `figureOutputDir` no longer defaults to `patent/figures`.

If the matter directory cannot be resolved and the call passes no output directory, the write fails.

## Migration

1. Set `workbenchCaseRoot` to the local work root on `@deepseek-ai/dsh-patent-document`, `@deepseek-ai/dsh-patent-filing`, and `@deepseek-ai/dsh-patent-tools`. Pass `caseId` to the document and DOCX tools, or `case_id` to the figure tools.
2. To keep a previous location, pass `outputDir` for HTML, PDF, and DOCX, or set `figureOutputDir` for figures. `.dsh/documents` and `data/cases/<case id>/outputs` remain valid when passed that way.
3. Call a tool with a resolved matter and no output directory and confirm the file is under `<work root>/<case id>/` and its layout subdirectory. Call it with neither a matter nor an output directory and confirm the call fails.
