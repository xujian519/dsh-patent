---
kind: upgrade-guide
description: "HTML、PDF、DOCX 与附图改为写入案卷目录；无法解析该目录且没有覆盖时写入失败。"
---

# 出件写入案卷目录

[English](guide.md) | 中文

## 变更

`render_patent_document`、`build_patent_filing`、`generate_patent_figure` 与 `generate_structure_figure` 不再写入 `<cwd>/.dsh/documents` 或 `<cwd>/data/cases/<案号>/outputs`，除非调用方显式传入该路径。

`workbenchCaseRoot` 与案号能解析出案卷目录，或工作目录里已有 `_matter-log.md` 时，文件写在该案卷目录内。HTML 与 PDF 使用模板对应的既有布局子目录（`01-检索`、`03-分析`、`04-撰写` 或 `05-答复`）。DOCX 与附图使用 `04-撰写`。插件 `outputRoot` 不再缺省为 `.dsh/documents`。`figureOutputDir` 不再缺省为 `patent/figures`。

案卷目录无法解析且调用未传输出目录时，写入失败。

## 迁移

1. 在 `@deepseek-ai/dsh-patent-document`、`@deepseek-ai/dsh-patent-filing` 与 `@deepseek-ai/dsh-patent-tools` 上把 `workbenchCaseRoot` 设成本机工作根目录。文书与 DOCX 工具传 `caseId`，附图工具传 `case_id`。
2. 要保留原先的位置，为 HTML、PDF 与 DOCX 传入 `outputDir`，或为附图设置 `figureOutputDir`。`.dsh/documents` 与 `data/cases/<案号>/outputs` 在这样传入时仍然有效。
3. 用已解析的案卷、且不传输出目录调用一次，确认文件在 `<工作根>/<案号>/` 及其布局子目录下。再在既无案卷也无输出目录时调用一次，确认调用失败。
