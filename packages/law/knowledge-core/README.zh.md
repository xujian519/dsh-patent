---
description: "法律域与专利域共用的知识库查询内核：FTS5 工具与 FTS 到 LIKE 的降级阶梯、查询文本清洗、查询切词、结果条数归一化、法规时间效力判定、共用安装文件操作，以及真实路径归一化。"
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge-core

[English](README.md) | 中文

## 概述

法律域与专利域共用的知识库查询内核：FTS5 工具与 FTS 到 LIKE 的降级阶梯、查询文本清洗、查询切词、结果条数归一化、法规时间效力判定、共用安装文件操作，以及真实路径归一化。

## 目录

- [为什么有这个包](#why-it-exists)
- [全文检索](#full-text-search)
- [查询切词](#query-keywords)
- [结果条数](#result-caps)
- [法规效力](#statute-validity)
- [安装文件操作](#install-file-operations)
- [真实路径](#real-paths)
- [消费方](#consumers)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

法律域的案例检索与专利域的现有技术检索跑同一套机制：先清洗查询文本让 SQLite 能绑定，再探测运行时 SQLite 是否编译了 FTS5，然后整句 phrase、切词 OR，都没命中或 FTS5 缺失时降级 LIKE，最后用同一套规则限制结果条数。这些机制此前落在专利域核心库里，法律域因此要为不承载专利含义的函数依赖专利核心包。引擎仍留在各域——表名、过滤子句、行映射与文案各域自有——但共用机制只在这里存一份，改一次两侧同时受益。

<a id="full-text-search"></a>
## 全文检索

`FTS_MIN_RUNES` 是 trigram tokenizer 的最小匹配长度，`sqliteHasFts5` 探测运行时 SQLite 是否编译了 FTS5（未编译的运行时即便数据库含 FTS 表也会抛 "no such module: fts5"），`escapeFtsPhrase` 把词条包成带引号的 FTS5 phrase 并把内嵌引号加倍，`joinFtsOrTerms` 为切词结果构建 OR 表达式，`sanitizeSearchText` 去掉会截断绑定文本的 NUL。`runFtsSearch` 跑降级阶梯——整句 FTS、切词 FTS、LIKE——FTS 抛异常时用异常消息调用调用方的 `degrade` 回调，由调用方把降级置为粘性。`createFtsLadder` 把一个引擎的三条查询路径与结果上限绑定成阶梯的输入。

<a id="query-keywords"></a>
## 查询切词

`extractLawKeywords` 按中文虚词与疑问词切分长查询，保留长度不少于 `FTS_MIN_RUNES` 的片段，最多返回 `max` 个。trigram tokenizer 无法匹配更短的片段，去掉它们正是切词这一级有用的前提。

<a id="result-caps"></a>
## 结果条数

`resolveResultLimit` 把调用方给的上限取整、夹进 `[1, max]`，上限缺失或非有限时退回调用方的缺省值。SQLite 把上限绑定为 `LIMIT ?`，小数操作数是数据类型错误，负数表示"不限制"；因此工具层与各引擎调用同一实现，上限在两侧含义一致。

<a id="statute-validity"></a>
## 法规效力

`resolveLawValidity` 回答法规在给定时点是否可见，读取 `expired` 标记、施行日与失效日三列。`expired=1` 或失效日早于时点为 `expired`；施行日晚于时点为 `not-yet-effective`；任一时间列存在且未命中上述情形为 `in-force`；三列全缺失为 `unverified`，未核验不等于在效。畸形日期按时间列缺失处理，不会被当成在效。`isLawVisible` 隐藏已废止与尚未生效的记录，未核验记录由调用方决定是否返回；`resolveAsOf` 读取调用方给的时点（缺省为今天，非法日期直接抛错而不当作今天）；`todayIsoDate` 渲染当前 UTC 日期。

<a id="install-file-operations"></a>
## 安装文件操作

两个知识库安装命令都要把源库复制进运行时目录，因此共用文件机制：`prepareTempSibling` 建好输出目录并返回同目录的临时文件路径，让随后的 rename 不跨文件系统，同时清掉上次中断留下的同名临时文件；`commitTempSibling` 原子替换输出并记录覆盖；`countTableRows` 统计表行数，表缺失时为 -1；`formatGigabytes` 渲染源库体积。

<a id="real-paths"></a>
## 真实路径

`resolveRealPath` 把路径归一到真实形态，并容忍文件尚不存在：对第一个存在的祖先目录做 realpath，再拼回缺失的路径段。"源文件与目标文件是同一个"的判定与工作目录包含性校验因此能在 `./`、`../` 与 symlink 别名下可靠比较。

<a id="consumers"></a>
## 消费方

`@deepseek-ai/dsh-legal-knowledge` 与 `@deepseek-ai/dsh-patent-knowledge` 直接导入本包；`@deepseek-ai/dsh-patent-core` 转导出它，使已按核心包导入的专利域调用方保持原有导入面。新的知识库域应导入本包，永不导入专利包。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **本包不分发知识库数据。** 数据库、表、过滤子句、行映射与结果渲染归各域索引包所有，本包只对调用方给定的内容求值。
- **降级阶梯是同步且进程内的。** 一次调用内跑完三级并把失败回报给回调；需要超时或后台重试的部署在自己的引擎里扩展。
- **效力判定只读三列。** 记录了自身时间语义（超出 `expired`、施行日、失效日之外）的语料，在调用 `resolveLawValidity` 前由自己的引擎完成映射。
- **FTS 工具按 trigram tokenizer 标定。** `FTS_MIN_RUNES` 与切词规则据此标定；换用其他 tokenizer 的部署自己提供最小长度与切词规则。

### 开发备注

无。
