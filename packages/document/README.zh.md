---
description: "document 组的包索引：Host Office 渲染与转换、面向模型的 Office 工具，以及文档智能体 preset 的交付登记。"
kind: "package-group"
---

# document/ — Office 文档与文档交付

[English](README.md) | 中文

## 概述

document 组保存文档智能体 preset 的模型侧域插件与 Host 侧 Office 工作：为预览和模型的 Office 工具渲染、转换已授权的 Office 文件并重算工作簿。`document-deliver/` 提供 `document_deliver`，把交付文件、格式与质量门状态记录进会话日志，支撑交付工作室的文件列表与徽标。`doc-template/` 把随包中文模板渲染为 Markdown/HTML/DOCX，`docx-kit/` 渲染 Markdown→DOCX 并投影 DOCX→文本，`doc-style/` 负责语气、语态、反模式词与免责声明模型。`office-kit/` 通过 LibreOffice kit 运行转换服务，`tool-office/` 提供相应工具。各包契约由子 README 负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包负责自身配置和生命周期规则；子系统参考描述共享的 Office 转换操作。

| 包 | 职责 | ctx key |
|---|---|---|
| [`document-deliver/`](document-deliver/README.zh.md) | 模型可见 `document_deliver`：把交付文件、格式与质量门状态记录进会话日志。 | （注册于 `ctx.tools`） |
| [`docx-kit/`](docx-kit/README.zh.md) | 仅用 Node 标准库实现 Markdown→DOCX 渲染与 DOCX→文本投影。 | — |
| [`doc-template/`](doc-template/README.zh.md) | 把随包中文文档模板渲染为 Markdown/HTML/DOCX，提供 `list_doc_templates` 与 `render_doc_template`。 | （注册于 `ctx.tools`） |
| [`doc-style/`](doc-style/README.zh.md) | 文档样式模型：语气/语态/反模式词/免责声明，含提示词、渲染样式与免责声明三个投影。 | — |
| [office-kit](office-kit/README.zh.md) | 将已授权 Office 字节转换为完整 PDF、PNG 图片、转换后的文件和重算后的工作簿，并提供有界队列和缓存；提供方自行解析 Kit 入口、引擎清单和 ASAR 解包后的引擎路径 | `ctx.officeKit` |
| [tool-office](tool-office/README.zh.md) | 加载 Office 技能后声明的 `office_render`、`office_convert` 和 `office_recalculate`：在工具结果中把页面渲染为图片、转换文档、重算工作簿 | — |

-----

<a id="related-documentation"></a>
## 相关文档

消费者负责源文件授权与展示。

- [文档转换](../../docs/subsystems/office-kit.zh.md) — 共享操作和生成的服务参考。
- [文档 preset](../bundle/web-app/presets/document.patch.yml) — 其组合挂载交付插件的声明。
- [独立 kit 所有权](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.zh.md) — 引擎分发与应用集成。
- [工作区文件](../api/workspace-files/README.zh.md) — 已授权的有界源文件读取。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
