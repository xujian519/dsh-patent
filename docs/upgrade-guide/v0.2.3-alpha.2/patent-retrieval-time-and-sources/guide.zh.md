---
kind: upgrade-guide
description: "检索工具报告取数时间、缓存状态与咨询过的通道；patent_search 默认返回精简行，需显式请求摘要。"
---

# 检索工具写明事实的取数与来源

[English](guide.md) | 中文

## 变更

`patent_search` 与 `patent_metadata` 新增 `retrievedAt`（服务通道的取数时间；命中缓存时仍是原始取数时间）与 `cached`，所有检索工具新增 `channelsConsulted`——每个通道一条记录，结局为 `served`、`empty`、`failed` 或 `skipped`，并附原因。`patent_legal_status` 新增 `retrievedAt` 与 `channelsConsulted`；`patent_pdf_download` 为每个已下载条目新增 `retrievedAt`（续传命中取 MANIFEST 记录的时间）。

`patent_search` 默认返回精简行：除非调用传入 `includeAbstract: true`，`abstract` 字段为空。50 条命中的一页因此不再携带摘要。

`law_search` 与 `patent_case_search` 新增 `corpus` 块：上游索引构建时间（`lastIndexedAt`）、schema `version`、文档/分块数与本地副本的 `fileModifiedAt`。新增 `patent_corpus_status` 工具在不检索的情况下报告同一组事实，因此 `@deepseek-ai/dsh-patent-tools` 注册 38 个工具。

`patent-knowledge:install` 保留 `index_meta`（它记录语料构建时间与规模），只删除 `embeddings` 与 `ivf_index`。

受影响：不传 `includeAbstract` 就读 `patent_search` 摘要的调用方、把变更后的参数与输出字段写入录制工具 schema 的场景、断言 patent-tools 工具数的检查，以及由旧版 install 生成的 knowledge-lite 库。

## 迁移

1. 凡需要摘要来筛选命中，给 `patent_search` 传 `includeAbstract: true`；不传则返回精简行。
2. 用免密钥方式刷新录制的工具 schema：`pnpm run test:snapshot:refresh` 会重写各场景的期望输出，包括 `tool-schemas.expected.json`。
3. 重跑 `patent-knowledge-install`，让 `knowledge-lite.db` 带上 `index_meta`；在此之前 `patent_corpus_status` 退到 `version_history` 或文件修改时间，并省略 `lastIndexedAt`。
4. 确认：`patent_search` 结果写明通道集合与取数时间；重装后 `patent_corpus_status` 能报出 `lastIndexedAt`。
