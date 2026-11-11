---
description: "DeepSeek Harness 的法律知识库查询接缝：案例检索、法规检索、司法解释检索与指导案例查询，基于 SQLite FTS5，并以内存检索作为降级。"
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-knowledge

[English](README.md) | 中文

## 概述

DeepSeek Harness 的法律知识库查询接缝：案例检索、法规检索、司法解释检索与指导案例查询，基于 SQLite FTS5 并以内存检索作为降级，另提供可选的 `legal_knowledge_search` 工具插件。

## 目录

- [为什么有这个包](#why-it-exists)
- [查询接口](#query-surface)
- [面向模型的工具](#model-facing-tool)
- [后端](#backends)
- [安装与配置](#install-and-configuration)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

法律研究需要检索裁判文书、法规与司法解释，而每个消费方都不应各自实现全文排序、效力过滤，以及"部署没有数据库"时的降级路径。本包提供一个 Cordis 服务 `ctx.legalKnowledge`，覆盖四类记录，使工具与技能共用一份查询契约和一组结果字段。服务本身不拥有任何面向模型的表面：工具 schema 与结果渲染由消费方负责。可选的 `./tool` 子路径导出是本包唯一随附的消费方；它作为独立插件存在，只使用服务的部署不会挂载任何工具。

<a id="query-surface"></a>
## 查询接口

`caseLawSearch` 按上限与 `docType`、`court`、`caseType` 过滤查询案例；`legalSearch` 按层级与效力选项查询法规；`judicialInterpretationSearch` 按类型与效力选项查询司法解释；`guidingCaseSearch` 按关键词查询指导案例。`addCaseLawRecords`、`addLegalRegulationRecords`、`addJudicialInterpretationRecords` 与 `addGuidingCaseRecords` 填充内存存储，仅在引擎未使用数据库时生效。命中结果携带记录字段、相关度评分与产生该结果的通道；效力选项按调用方给出的截止日期过滤法规的施行与失效日期。查询中的 NUL 会在匹配前去掉，去掉后为空则没有命中。缺省或非有限的上限使用该方法的默认值，案例为 5，其余为 10；其他上限取整后落在 1 到该方法的最大值之间，案例为 50，其余为最大安全整数。

<a id="model-facing-tool"></a>
## 面向模型的工具

`@deepseek-ai/dsh-legal-knowledge/tool` 是一个函数插件，注入 `tools` 与 `legalKnowledge` 并注册 `legal_knowledge_search`。`scope` 选择一类记录：`regulation`（默认）、`case_law`、`judicial_interpretation` 或 `guiding_case`。工具把 `limit`、`asOf`、`level`、`docType`、`court`、`caseType` 与 `interpretationType` 转交给对应的服务方法，结果上限钳制在 1–20 条，并返回命中记录与摘要。去掉 NUL 后为空的查询会按空查询拒绝，回显的查询文本也不再含 NUL。摘要会说明：空结果表示本部署的知识库未命中，不代表该法源不存在。挂载时必须与服务处于同一个 `isolate` realm；法律 preset 的 `legal-knowledge-index` 分组已按此配置。

<a id="backends"></a>
## 后端

查询数据库存在且 `useFts5` 为真（默认）时，引擎打开数据库、探测 FTS5 并以 BM25 排序检索；FTS5 没有命中时回退到 `LIKE` 包含匹配，数据库无法服务该查询时降级到下一档而不是让调用失败。没有数据库或 `useFts5: false` 时，引擎服务运行时加入的内存记录。`sqliteHasFts5`、`escapeFtsPhrase`、`joinFtsOrTerms`、`FTS_MIN_RUNES` 与 `runFtsSearch` 导出给在相同表上自建查询的消费方。

<a id="install-and-configuration"></a>
## 安装与配置

`resolveLegalKnowledgePaths` 解析 `knowledgeDir`（默认 `~/.dsh/legal-knowledge`）与 `sourceDbPath`（默认 `~/.dsh/legal-knowledge/legal.db`），依次优先 `legal.db`、`legal-lite.db`，最后回退到源数据库。`installLegalKnowledgeDb` 从源库构建查询库。服务由 `knowledgeDir`、`sourceDbPath` 与 `useFts5` 配置；默认数据库缺失属于安装前状态，服务以内存模式启动，而不是对从未安装的文件做只读打开并失败。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **数据库不随包分发。** 案例与法规语料是宿主解析出的部署数据；新部署没有记录，每次查询都返回空结果，直到 `installLegalKnowledgeDb` 针对源数据库完成构建，或消费方加入内存记录。
- **内存降级是关键词匹配，不是排序检索。** 它只服务调用方在运行时加入的内容；相关度评分与过滤都作用在这些记录上，因此加入列表为空时，无论部署数据库里有什么，检索都为空。
- **FTS5 是否可用取决于 Node 运行时。** SQLite 经 `node:sqlite` 提供；没有 FTS5 的运行时降级到 `LIKE` 包含匹配，能找到子串但不按 BM25 排序。
- **效力过滤基于日期。** 未记录施行或失效日期的法规按可见处理；服务不查询外部修订表，因此在日期被记录之前，已被替代的文本仍可能保持可见。
- **服务本身不注册工具。** `legal_knowledge_search` 位于独立的 `./tool` 插件；服务仍不注册提示词区段或结果文本，所有 schema 与渲染结果都由消费方负责。

### 开发备注

无。
