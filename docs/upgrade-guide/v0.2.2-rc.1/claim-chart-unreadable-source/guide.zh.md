---
kind: upgrade-guide
description: "claim_chart_build 在目标源文不可读时于首次模型调用前中止，并报 invalid_tool_input。"
---

# `claim_chart_build` 在生成前校验源文

[English](guide.md) | 中文

## 变更

目标声明的 `source_path` 不可读时——文件不存在、路径不在 `chart_source_roots` 内、扩展名不是文本、或文件超过 `chart_source_max_bytes`——`claim_chart_build` 过去会先调用模型最多三次，再以 `tool_execution_failed` 失败。现在它在首次模型请求之前中止，抛出 `PatentToolError`，错误码为 `invalid_tool_input`。错误消息逐个列出不可读的路径、原因，以及相对路径的解析基准目录。

声明了 `source_path` 但不可读的目标，即使没有任何图表行引用它，也会让整次调用失败。不会再产出该目标引用未经校验的图表。

这会影响传入 `targets[].source_path` 的调用方，以及按工具错误码分流的消费方。

## 迁移

1. 若代码按 `code` 分流，把 `claim_chart_build` 返回的 `invalid_tool_input` 视为调用方可修正的输入问题，而不是工具故障。用相同参数重试不会成功。
2. 修正声明的路径，或把其所在目录加入 `chart_source_roots`。文件确实超出上限时调高 `chart_source_max_bytes`；PDF、DOCX 源文先抽取为文本再传入。
3. 确认迁移生效：`source_path` 有误的调用立即失败，消息列出每个失败路径，且不再为它追加 `patent/model-call` 事件。
