---
description: "领域中立的共用机制族：法条引用库与知识库查询库，法律域与专利域都从这里消费。"
kind: "package-group"
---

# law/ — 领域中立的共用机制族

[English](README.md) | 中文

## 概述

law 组承载既不属于法律域也不属于专利域的机制：组装一条法条引用判定规则所需的引用机制，以及组装 SQLite 检索引擎所需的知识库查询机制。领域包保留自己的语法、索引、表、过滤子句、工具名与文案；只有共享机制落在这里。

## 包

| 包 | 分工 |
|---|---|
| [`law-core/`](law-core/README.zh.md) | 领域中立的法条引用库：`dsh-legal-law` 直接消费，`dsh-patent-law` 经 `dsh-patent-core` 转导出消费 |
| [`knowledge-core/`](knowledge-core/README.zh.md) | 领域中立的知识库查询库：`dsh-legal-knowledge` 与 `dsh-patent-knowledge` 直接消费；`dsh-patent-core` 为专利域既有的导入面转导出它 |
