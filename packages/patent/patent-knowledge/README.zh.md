---
description: "knowledge.db 查询接缝的服务定义（`ctx.patentKnowledge`）：判例全文检索、法规全文检索、wiki 卡片关键词查询、IPC 分类、知识图谱查询（基于 `node:sqlite`），以及从 Sati 移植的 `patent-knowledge:install` 数据引导。模型可见面全部由消费方负责；本包只解析并提供只读知识查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-knowledge

[English](README.md) | 中文

## 概述

knowledge.db 查询接缝的服务定义（`ctx.patentKnowledge`）：判例全文检索、法规全文检索、wiki 卡片关键词查询、IPC 分类、知识图谱查询（基于 `node:sqlite`），以及从 Sati 移植的 `patent-knowledge:install` 数据引导。模型可见面全部由消费方负责；本包只解析并提供只读知识查询。

## 目录

- [服务](#service)
- [配置](#configuration)
- [patent-knowledge:install](#patent-knowledgeinstall)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="service"></a>
## 服务

`PatentKnowledge` 服务以只读方式打开解析得到的 `knowledge.db`（数据库缺失或版本不匹配时经 `KnowledgeDbVersionError` fail-loud），并委托给移植的引擎。引擎惰性打开，并在所属 fiber 卸载时关闭。

### caseLawSearch(query, options?)

对 `documents`/`chunks`/`docs_fts` 表做全文检索（FTS5 BM25 优先，短查询或缺失 FTS 索引时降级 LIKE）。返回 `CaseLawHit[]`；options 支持按 `docType`、`court`、`excludeSource` 过滤。当 `documents.search_prefix` 存在（install 以 `--search-prefix` 写入）时，LIKE 降级只扫标题与明文前缀，不再解压全部 chunks；缺该列的库保留整表解压路径。

### legalSearch(query, options?)

经 `KnowledgeLawSearch` 对 `knowledge.db` 的 `law_article` 文档做全文检索。返回 `LawSearchResult[]`；options 支持按 `level` 与时点效力（`asOf`，以及 `includeUnverified`）过滤。每条命中带 `filename`（即该文档的 `file_path`），作为引文来源；并带 `validity`（`in-force` / `expired` / `not-yet-effective` / `unverified`），由可空的 `valid_from` / `valid_to` / `expired` 列计算。已废止与尚未生效的记录不返回；三列全缺失的记录标为 `unverified` 并默认返回（不当成现行有效），`includeUnverified: false` 时排除。`installKnowledgeDb` 给输出库补 `valid_from`、`valid_to`、`validity_source` 三个可空列，但不写入「未废止」默认值；存量记录在部署方回填前保持 `unverified`。

### guidelineSearch(query, options?)

对 `knowledge.db` 的 `guideline_rule` 文档（《专利审查指南》全文）做全文检索，由第二个以 `docTypes: ['guideline_rule']` 限定的 `KnowledgeLawSearch` 提供。引擎索引哪类规范文档由构造时的文档类型决定（缺省 `law_article`），因此法规语料与指南语料各自独立、共用同一条检索通路；`documents` 表早于 `file_path` 列的库仍可检索，只是命中不带来源路径。

### wikiCards(query, limit?) / wikiCardsIn(prefix, keyword?, limit?)

对 wiki 卡片目录做关键词查询（标题/概念/领域），可跨全部目录或限定一个目录前缀；前缀形式下关键词为空时列出该目录。P1 仅关键词路径：语义/向量 wiki 索引已延后，wiki 目录缺失时降级为空结果。

### wikiContext(id, maxChars?)

渲染单张卡片的正文片段供模型上下文使用，按 `maxChars` 截断；卡片不存在时返回空串。

### ipcClassify(text)

经移植的关键词分类器对专利领域文本做 IPC 分类。按置信度排序返回 `IpcClassification[]`。

### kgSearch / kgGetNode / kgListByType / kgSimilarNodes / kgNeighbors

在 `kg_nodes`/`kg_edges` 表上做知识图谱关键词检索（含关系扩展）、按 id 取节点、按类型列节点、取相似节点与出向邻居（unified schema，兼容 legacy `nodes`/`edges`）。当随库的 trigram `kg_nodes_fts`（含节点正文）与 `kg_nodes` 行数一致时，整句匹配直接走 FTS；短查询与 legacy unicode61 schema 回退 LIKE，行数不一致时禁用快路径。

### ipcStandards / ipcStandardsByArticle / ipcStandardsSearch

基于随包 `ipc-standards.yaml` 的审查标准卡片查询（按 IPC 部、按法条、按关键词）。

<a id="configuration"></a>
## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `knowledgeDir` | `~/.dsh/knowledge` | 查询数据库与 wiki 卡片的数据目录。 |
| `sourceDbPath` | `~/.sati/knowledge/knowledge.db` | `patent-knowledge:install` 的源数据库，及只读直用的回退路径。 |
| `nodeCacheMaxEntries` | `1024` | 知识图谱节点缓存上限，按 LRU 淘汰；部署需要反复查询大范围子图时调高。 |

查询数据库按 `knowledgeDir/knowledge.db`、`knowledgeDir/knowledge-lite.db`、`sourceDbPath` 的顺序解析。

<a id="patent-knowledgeinstall"></a>
## patent-knowledge:install

安装逻辑为导出的 `installKnowledgeDb(options)` 函数加 `patent-knowledge-install` 可执行入口；插件加载时不会自动运行。它把本机源 `knowledge.db` 裁剪为 `knowledgeDir/knowledge-lite.db`：VACUUM 生成紧凑副本、gzip 压缩 `chunks.content` 长正文（读取端透明解压）、删除 embeddings 表。传入 `--search-prefix` 时同时写入 `documents.search_prefix`：每个文档最长 chunk 的前 512 个码点（可配置），以明文存储。该前缀让两字判例查询扫描紧凑列而无需解压全部 8.1 万篇文档，代价是召回被限制在前缀内；随包语料约增加 120 MB。默认保留全文匹配；不带该选项重新 install 会删除从带前缀 lite 库继承的列。运行一次以准备数据：

```sh
pnpm --filter @deepseek-ai/dsh-patent-knowledge exec patent-knowledge-install
# or with an explicit source database:
patent-knowledge-install --from /path/to/knowledge.db --output ~/.dsh/knowledge/knowledge-lite.db
```

参数：`--from <path>`（源库）、`--output <path>`、`--no-compress-chunks`、`--keep-embeddings`、`--no-fts`、`--search-prefix`、`--search-prefix-chars <n>`（64–2048，默认 512）、`--skip-verify`、`-h/--help`。

<a id="model-experience"></a>
## Model Experience

None, as the knowledge seam resolves and serves read-only knowledge queries to the tool layer; dsh-patent-tools owns every model-facing schema and result.

#### KV Cache effect

Independent; the knowledge seam registers no prompt, tool schema, or result of its own.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **P1 无向量/语义检索** — embedding/向量路径（`knowledge-embeddings`、`wiki-card-vector-index`、三个 memory provider）未移植；wiki 卡片查询仅关键词路径，判例/法规/知识图谱检索仅 FTS5/LIKE。
- **知识图谱索引新鲜度由数据管道保证** — trigram 快速路径把行数一致的 `kg_nodes_fts` 视为完整并跳过 LIKE 兜底；原地修改节点正文后必须重建索引。
- **判例前缀召回有界（启用时）** — 使用 `--search-prefix` 时，短查询 LIKE 只匹配每个文档最长 chunk 的前 `searchPrefixChars` 个码点；更靠后的正文匹配不会返回。默认安装保留全文匹配。
- **源数据库不随包分发** — 数据须经 `patent-knowledge:install` 本地准备，或经 `sourceDbPath`/`knowledgeDir` 直接指向；不提供任何公共下载点。
- **`node:sqlite` 处于实验阶段** — 引擎运行在 Node 内置 SQLite 上，该模块在支持的 Node 版本线中仍为实验特性，可能随版本变更。

### 开发备注

无。

本包不发布 invariant 伴生组件：知识缝对外部 knowledge.db 提供只读查询，不持有包属持久会话事件流；模型可见与会话日志关系归消费这些查询的工具层所有。
