---
description: "专利域的随包索引资产格式：YAML 映射读取、严格字段读取器、每个已转录条目都记录的来源与核验字段，以及索引格式错误时抛出的加载错误。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-index-asset

[English](README.md) | 中文

## 概述

专利域的随包索引资产格式：YAML 映射读取、严格字段读取器、每个已转录条目都记录的来源与核验字段，以及索引格式错误时抛出的加载错误。

## 目录

- [为什么有这个包](#why-it-exists)
- [字段读取器](#field-readers)
- [已记录的来源](#recorded-source)
- [错误契约](#error-contract)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

`@deepseek-ai/dsh-patent-law` 与 `@deepseek-ai/dsh-patent-fees` 各自随包分发一份由人工转录、由插件在加载时读取的 YAML 索引；两者都拒绝格式错误的字段而不是强行转换，也都记录每个条目内容的来源。共用一份实现是为了让这条规则不会在两个包之间漂移——第二份副本会让两份索引在"null 是什么意思"上产生分歧，而任何门禁都不会察觉。

<a id="field-readers"></a>
## 字段读取器

每个读取器要么返回资产声明的值，要么以点名该字段的消息拒绝整个文件：`parseYamlMapping(source, label, fail)` 读根映射，另有 `readString`、`readOptionalString`、`readOptionalDate`（`YYYY-MM-DD`）、`readCount`（正整数）、`readOptionalCount`、`readOptionalBoolean`、`readEnum`（闭集取值）与 `readMapping`。

`readOptional*` 对缺失字段返回 null 而不是默认值，调用方因此能区分三种状态：缺失、存在但为空、存在且有值。尚未转录的金额或条号保持缺失，直到有人记录它。

`readEntryTopics` 返回去除首尾空白的关键词。主题词要与命题原文比对，`[" 新颖性 "]` 这种带空白的写法永远命中不了；关键词本身的拼写保持不变。

<a id="recorded-source"></a>
## 已记录的来源

`readRecordedSource(entry, fail)` 读取随包索引每个条目在内容之外都携带的两个字段：`sourceDoc`（该值取自哪份官方文件）与 `verifiedOn`（有人对照该文件核验的日期）。两者在人工转录之前都是 null，这正是让消费方能区分"已转录的值"与"凭记忆写的值"的依据。索引可以在它们旁边加自己的字段——`@deepseek-ai/dsh-patent-fees` 就加了 `effectiveFrom`。

<a id="error-contract"></a>
## 错误契约

`IndexAssetError` 通过 `origin` 携带出问题的文件。读取器接收的是 `AssetFail`（调用方绑定到某个文件的工厂函数）而不是错误类，因此每个索引包保留自己可捕获的错误类型（`LawBaselineError`、`FeeTableError`），同时共用字段规则；两者都继承 `IndexAssetError`。

<a id="model-experience"></a>
## 模型体验

无：本库是对资产文件的纯校验；所有面向模型的 schema 与结果都由消费它的索引包拥有。

#### KV Cache 影响

独立；本库不产生模型可见内容，因此既不填充也不失效可复用的 KV 缓存前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **除字段类型外没有资产 schema** —— 读取器校验字段的类型与形态，不校验键名是否是消费方期望的写法；拼错的键会被读成缺失字段，因此各索引包用自己的测试钉住其随包资产使用的字段集。
- **日期按文本校验** —— `readOptionalDate` 接受 `YYYY-MM-DD`，不拒绝日历上不存在的日期；需要真实日历日的消费方要通过自己的日期模块解析。
- **无插件、无服务、无状态** —— 本包不注册任何东西；宿主通过 import 组合它，它也不是任何 preset 中的一行。

### 开发备注

无。

不发布 companion：本库是对调用方提供文本的纯校验，不拥有持久状态。
