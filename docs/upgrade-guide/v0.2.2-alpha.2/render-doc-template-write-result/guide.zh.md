---
kind: upgrade-guide
description: "`render_doc_template` 写入 `output_path` 后不再返回文档正文，写盘结果省略 `content` 与 `markdown`，且 `docx` 必须传 `output_path`。"
---

# `render_doc_template` 写入文件后只回报文件，不再回灌正文

[English](guide.md) | 中文

## 变更

带 `output_path` 的 `render_doc_template` 调用现在返回写入文件的 `path` 与 `bytes`，并保留 `residual` 与 `warnings`，结果里不再包含 `content` 与 `markdown`。面向模型的结果文本不再追加 `--- document ---` 段；它说明正文已落盘，并指向 `read`。输出 schema 把 `content` 与 `markdown` 改为可选，因此按 `RenderDocTemplateOutput` 做类型检查的消费方必须处理字段缺失。

不传 `output_path` 的 `docx` 渲染现在以 `DocTemplateError` 错误码 `output-path-required` 失败。工具不再把 base64 包放进 `content` 返回。

不传 `output_path` 的 `markdown` 与 `html` 内联渲染仍返回 `content` 与 `markdown`，小型渲染的结果文本不变。

读取写盘渲染的 `content` 或 `markdown` 的部署、技能与自动化会观察到该变化。已记录的会话保留旧结果文本；变化只作用于新调用。

## 迁移

1. 把所有从写盘渲染读取 `content` 或 `markdown` 的地方改为读取返回的 `path`：经会话文件系统或 HTTP 工作区端点读取该文件。
2. 每次 `docx` 调用都传 `output_path`，例如 `format: "docx", output_path: "out/report.docx"`。删除提示词或技能里“解码 base64 `content` 字段”的步骤。
3. TypeScript 消费方在使用 `content` 与 `markdown` 前先收窄类型。不传 `output_path` 的场景可用导出的 `InlineRenderedDocument`，其两个字段必定存在。
4. 确认：`pnpm exec vitest run packages/document/doc-template` 通过；带 `output_path` 的 `docx` 调用结果没有 `content`、没有 base64；同一调用不传 `output_path` 时以 `output-path-required` 失败。
