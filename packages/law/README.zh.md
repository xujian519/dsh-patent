---
description: "领域中立的法条引用族：law-core 库，法律域与专利域共用其中的引用文本、引用抽取、重合度评分与逐条引用判定。"
kind: "package-group"
---

# law/ — 领域中立的法条引用族

[English](README.md) | 中文

## 概述

law 组承载既不属于法律域也不属于专利域的法条引用机制：一条法条引用判定规则，以及组装该规则所需的引用文本、引用抽取、重合度评分与工具脚手架。领域包保留自己的语法、索引、工具名与文案；只有共享机制落在这里。

## 包

| 包 | 分工 |
|---|---|
| [`law-core/`](law-core/README.zh.md) | 领域中立的法条引用库：`dsh-legal-law` 直接消费，`dsh-patent-law` 经 `dsh-patent-core` 转导出消费 |
