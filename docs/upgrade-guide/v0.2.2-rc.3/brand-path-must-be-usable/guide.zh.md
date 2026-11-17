---
kind: upgrade-guide
description: "配置了 brandPath 却无法读取时，render_patent_document 现在直接失败，而不是静默使用默认品牌。"
---

# 配置的品牌路径必须可用

[English](guide.md) | 中文

## 变更

`render_patent_document` 过去在 `brandPath` 存在但读不出时回退到默认品牌：路径写错、JSON 损坏，或缺少 `documents.patent` 命名空间都不会产生警告，渲染结果带着默认的事务所、免责声明与配色。

调用方给出的 `brandPath` 是一项配置决定，因此不可用时会以 `DocumentRenderError`（映射为 `invalid_tool_input`）让调用失败：文件缺失或不可读、JSON 非法、顶层不是对象、`documents.patent` 不是对象，或其中某个值不是字符串。不传 `brandPath` 时仍使用模板的默认 token。

## 迁移

1. 把 `brandPath` 指向不存在文件的部署，现在会看到渲染失败而不是默认品牌。修正路径；若本来就要默认品牌，删掉该选项。
2. `theme.json` 的 `documents.patent` 值写成数字或嵌套对象的，需要改为字符串；加载错误会点出具体键名。
3. 依赖已移除的警告文案（「品牌配置文件不存在，已回退默认」）的调用方改为处理 `DocumentRenderError`；直接调用 `loadBrandFromPath` 现在抛出同一错误。
