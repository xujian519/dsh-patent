---
description: "法律域与专利域共用的法条引用机制：引用文本归一化、引用抽取、命题重合度评分、逐条引用判定，以及 citation-verify 工具脚手架。"
kind: "package-reference"
---

# @deepseek-ai/dsh-law-core

[English](README.md) | 中文

## 概述

法律域与专利域共用的法条引用机制：引用文本归一化、引用抽取、命题重合度评分、逐条引用判定，以及 citation-verify 工具脚手架。

## 目录

- [为什么有这个包](#why-it-exists)
- [引用文本](#citation-text)
- [引用抽取](#reference-extraction)
- [命题重合度](#proposition-overlap)
- [逐条判定](#article-decision)
- [工具脚手架](#tool-scaffolding)
- [消费方](#consumers)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

法律域对《民法典》第 143 条的引用与专利域对《专利法》第 26 条的引用跑同一条判定规则：查条目，区分"条文存在"与"条文不存在"、"已转录"与"无人核验过"，再检验条目是否支撑命题。这条规则此前落在专利域核心库里，法律域因此继承了对专利命名与专利发布机制的依赖，且每次规则变更都有两侧漂移的风险。本包是领域中立的家：规则只在这里存一份，各域只保留自己的引用语法、索引、工具名与文案。

<a id="citation-text"></a>
## 引用文本

`normalizeCitationText`、`stripBookMarks`、`trimPunctuation`、`compactCitation` 与 `narrowed` 在解析前归一化被引字符串；`parseCnNumber` 读取中文数字（`一百一十二` → `112`，接受 `〇` 与 `千`，畸形数字返回 null），`formatCnNumber`/`formatCitationNumber`/`formatArticleCitation` 渲染 finding 打印的规范形式；`articleReferenceIdentity` 是同法同条引用的去重键。

<a id="reference-extraction"></a>
## 引用抽取

`readArticleContinuations` 把连续条号行（`第九十九条至一百零一条`）读成逐条引用；`collectReferences` 对文本运行领域语法，返回已解析引用与未解析候选；`readStatuteArticleCandidate` 解析单个裸 `第N条…` 提法，供 `scanUnrecognizedReferences` 的未识别引用扫描回报。

<a id="proposition-overlap"></a>
## 命题重合度

`textOverlap` 度量命题的加权字对中被条目转录文本承载的比例，`topicOverlap` 把命题与条目主题词匹配；两路信号刻意保持词面，改写过的命题报"无法判定"而非"矛盾"。`createOverlapIndex` 为每条基线只建一次字对频率，`PROPOSITION_SUPPORT_DEFAULT` 是默认支撑阈值。

<a id="article-decision"></a>
## 逐条判定

`decideArticleCitation` 把一条引用对法条基线判定为 `valid`、`mismatch`、`unmatched`、`out-of-range`、`not-indexed` 或 `unverified`，理由文案使用模型语言；`articleComparableEntries`、`findCompetingLabels`、`supportMismatchReason`、`transcribedText`、`truncateProposition` 与 `formatPercent` 是各领域 verify 路径围绕它组装的助手。

<a id="tool-scaffolding"></a>
## 工具脚手架

`citationVerifyToolOptions`、`citationVerifyParameters`、`citationVerifyExecute`、`citationVerifyOutputSchema`、`citationVerifyRender`、`citationVerifyReport`、`citationReportLines`、`citationFindingSchema`、`citationInputProblem`、`CITATION_FINDING_DECISION_PROPERTIES` 与 `CITATION_REPORT_PROPERTIES` 以纯值形式构建 citation-verify 工具的框架构件；领域包以自己的名称与描述注册工具，并拥有一切面向模型的文案。

<a id="consumers"></a>
## 消费方

`@deepseek-ai/dsh-legal-law` 直接导入本机制；`@deepseek-ai/dsh-patent-core` 转导出它，使专利域保持单一导入面，`@deepseek-ai/dsh-patent-law` 经该转导出消费。新的法条引用域应导入本包，永不导入专利包。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **本包不分发法条数据。** 基线、条目与法名是各领域索引包拥有的领域数据，本包只对调用方给定的条目求值。
- **重合度信号是词面的。** 围绕同义词改写的命题够不到主题词与转录文本两路信号，按设计报 `unmatched`；需要语义匹配的部署应在自己的 verify 路径中扩展，而不是在这里。
- **领域脚手架保持镜像。** legal-law 与 patent-law 的 verify/baseline/reference 文件按设计保持各领域结构；共享的只有它们调用的判定规则，`tests/fixtures/citation-samples.ts` 中的一致性样例守着这条边界。

### 开发备注

无。
