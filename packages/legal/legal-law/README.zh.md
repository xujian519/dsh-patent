---
description: "DeepSeek Harness 的随包中国法条索引：法条引用解析、逐法记录来源与核验日期的索引、绝不把未转录条文静默放行的引用核验，以及 legal_law_verify 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-law

[English](README.md) | 中文

## 概述

DeepSeek Harness 的随包中国法条索引：法条引用解析、逐法记录来源与核验日期的索引、绝不把未转录条文静默放行的引用核验，以及 legal_law_verify 工具。

## 目录

- [为什么有这个包](#why-it-exists)
- [随包索引](#shipped-index)
- [引用判定](#citation-decision)
- [工具](#tool)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

一条引用《民法典》第 143 条的法律结论，其质量取决于这个条号背后的条文。索引随部署分发，使引用可以离线核验：先解析引用，再查条文，判定会区分"条文存在"与"条文不存在"，也区分"已转录"与"无人核验过"。引用解析器、条目读取器与命题比对机制通过 `@deepseek-ai/dsh-law-core` 与 `@deepseek-ai/dsh-patent-index-asset` 与 `@deepseek-ai/dsh-patent-law` 共用；本包负责法律域的语法、资产与文案。

<a id="shipped-index"></a>
## 随包索引

每部法律是 `assets/legal-law` 下的一个 YAML 文件，`manifest.json` 以 `[law, document, file]` 登记全部文件。文件声明 `law`、`document`、`revision`、`maxArticle`、`maxVerifiedOn`、`maxSource` 与 `articles` 列表；每个条目携带 `article`、可选的 `paragraphs`、`topics`、`text`、`sourceDoc` 与 `verifiedOn`。转录记录是全有或全无：有 `text` 就必须同时有 `sourceDoc` 与 `verifiedOn`，只有来源没有正文同样是加载错误，因此手改索引无法制造核验器要避免的“静默放行”状态。

插件加载时检查目录可读、非空并带有清单，否则让部署失败。第一次核验通过 `createLegalLawIndex().loadNames` 读取清单，把清单里的法律名与文件标题注册进解析器，随后只解析引用点名的法律；每部法律解析一次并缓存，读取失败后下一次调用可重试。两步都接受 `AbortSignal`；取消只结束该调用方的等待，与其他调用方共享的读取继续完成。需要整个语料的调用方仍可使用 `loadLegalLawBaselinesAsync`（逐文件让出事件循环），`loadLegalLawBaselines` 是它的同步版本；`parseLegalLawBaseline` 解析单个文件；`findLegalArticle` 查一个条号。资产声明的任何法律名都会成为引用形式，资产的文件标题同时作为正式全名别名；`legalLawNames` 返回当前集合。`baselineDir` 覆盖会替换随包目录，因此该目录必须在 YAML 文件之外一并提供 `manifest.json`。

<a id="citation-decision"></a>
## 引用判定

`parseLegalLawReference` 解析单独成文的引用，`extractLegalLawReferences` 提取一段文本中的全部引用（含 `第 143 条、第 144 条` 与 `第 2 款、第 3 款` 这类续指），`formatLegalLawReference` 渲染正式写法，`scanUnrecognizedLegalCitations` 列出解析器无法识别的疑似引用片段。`verifyLegalCitation` 把一条引用判定为 `valid`、`mismatch`、`unmatched`、`out-of-range`、`not-indexed` 或 `unverified`；命题先按主题词、再按加权字符对重合度与已转录条文比对，若命题由另一条文承载，则报告为 mismatch 并点出该条文。`resolveLegalCitationPolicy` 按部署的策略集映射判定，`renderLegalCitationRows` 渲染工具返回的判定表。

<a id="tool"></a>
## 工具

`legal_law_verify` 接受可选的 `text`（从中提取引用）、可选的 `references`（按原文逐条给出）与可选的 `proposition`（引用所支持的命题）；`text` 与 `references` 至少要给一个，空的 `text` 且无 references 是输入错误。结果携带 findings、`blocked` 标志、按判定分组的计数，以及未经核验的 `unrecognized` 片段。

<a id="model-experience"></a>
## 模型体验

### legal_law_verify 工具

#### 模型看到什么

注册一个名为 `legal_law_verify` 的工具，参数为上述 `text`、`references` 与 `proposition`；两者都没给时是错误，而不是一次没有 finding 的成功核验。每条 finding 携带原始引用、法律、条号、款或项、判定、处置与理由；结果还携带 `blocked`、判定计数与 `unrecognized`。工具描述写明六种判定、未转录的条文绝不报告为已核验，以及"不是恰好一条引用"属于输入错误。

#### Token 影响

工具启用期间每次请求都有固定的定义开销；每次结果是一张短表加说明，在压缩之前随会话重发。

#### KV Cache 影响

仅追加；新出现的结论文本位于可复用的请求前缀之后，不会使已有 KV-cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **只转录了十七部核心法律。** 民法典、刑法、公司法、劳动法、劳动合同法、民事诉讼法、刑事诉讼法、行政诉讼法、专利法、商标法、著作权法、反不正当竞争法、个人信息保护法、行政处罚法、行政许可法、行政复议法与仲裁法带有条文正文、来源文件与转录日期；其余自动生成的文件仍是 `text: null`，引用它们会返回 `unverified`。转录日期记录的是从该来源文件的机械抄录，不代表有资质的人读过回稿。默认策略拦截 `unverified` 与 `not-indexed` 引用；语料更窄的部署可通过 `Config` 放宽。
- **覆盖范围是生成语料，不是经审阅的纲要。** `assets/legal-law` 持有数千个按法拆分的文件，主题词由脚本推导；生成器漏掉的法律或条文会报告 `not-indexed`，即使该规定确实存在。两个已知的源语料缺口影响已转录集合：语料缺刑事诉讼法第 128 条；以 `第 N 条之一` 写成的修正案条文被并入基础条，而非单独索引。因此 `unverified` 或 `not-indexed` 只说明本索引收了什么，不说明中国法律有什么。
- **命题比对是字面的。** 主题词与加权字符对只比较字符；换用同义表述的命题会报告 `unmatched`，必须由人工阅读；多部条文共有的套话会降低但不能消除错误匹配。
- **项号只回显、不核验，缺款列表也不做窄化。** 随包法律索引不登记任何 `paragraphs` 列表，因此点名某一款的引用不会按款数核对。点名某一项的引用按条判定，项号只随结果回显。共享判定器在 `paragraphs` 缺失时跳过窄化，不报 `unverified`，因为本部署的默认策略会拦截该判定。
- **未识别的片段是警告，不是拦截。** `unrecognized` 列出未参与判定的片段，本身不会置 `blocked`。解析器读不了的款或项（`第十十款`、`第十十项`、`第（十十）项`）会拒绝整条引用：写在 `text` 里时片段列在这里，写在 `references` 里时改为输入错误。片段只有落在已解析引用的跨度内，才会从列表去掉。
- **基线正确性由内容负责。** 任何运行时观察都无法证明某个条目的正文就是现行官方文本；只有记录的来源与日期可以，门禁检查引用与索引成员关系，不检查法律正确性。

### 开发备注

无。
