---
description: "函数插件，供[文档智能体 preset](../../bundle/web-app/presets/document.patch.yml)使用：一个模型可见的 `document_deliver` 工具，登记交付的成品文件、导出格式与模型自己的质量门自述，并自行读取这些文件、把确定性核验结论与该自述并列。调用写入会话日志，[交付工作室](../../../packages/client/ui-document-studio/README.zh.md)据此从日志与结果元数据推导交付物列表与两列质量门——不新增会话事件类型，也不新增 host 写 RPC。"
kind: "package-reference"
---

# @deepseek-ai/dsh-document-deliver

[English](README.md) | 中文

## 概述

函数插件，供[文档智能体 preset](../../bundle/web-app/presets/document.patch.yml)使用：一个模型可见的 `document_deliver` 工具，登记交付的成品文件、导出格式与模型自己的质量门自述，并自行读取这些文件、把确定性核验结论与该自述并列。调用写入会话日志，[交付工作室](../../../packages/client/ui-document-studio/README.zh.md)据此从日志与结果元数据推导交付物列表与两列质量门——不新增会话事件类型，也不新增 host 写 RPC。

## 目录

- [挂载内容](#what-it-mounts)
- [确定性核验](#deterministic-checks)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="what-it-mounts"></a>
## 挂载内容

- **`document_deliver`** —— 声明 `files`（`{ path, format }`，format 取值 `markdown | html | pdf | docx | pptx | other`）、`gate`（必填的 `p0`，模型在其中自述质量门技能的稳定 id 已通过；可选 `p1` 列表）、可选的 `unreadable_ack` 原因（每个读不出的文件一条 `{ path, reason_text }`）、可选 `brief_ref`、可选 `style` 风格名、可选 `char_budget` 字数预算。按调用方会话工作区解析每个路径；文件不存在（幽灵文件不算交付物）即报错；随后读取每个交付文件跑确定性核验，回执自述的 P0/P1 项数、所用风格与每个文件一份核验报告。自述只被记录、不被核验：`p0` 里漏填或写法无法识别的 id 以登记提示返回，是否拒绝登记只由确定性核验结论决定。

  每份核验报告用两个名字指向同一个文件：`path` 是调用方写的原始拼写（保留原样，读者认的是它），`identity` 是宿主解析后的规范绝对路径——同一文件的不同拼写共享这一个值。消费方以 `identity` 作为交付物身份键、以 `path` 作为显示文本，因此「写入 `out/report.html` + 登记 `/work/out/report.html`」是一个交付物，而不是两个。该字段出现之前记录的结果没有 `identity`，消费方退回按声明路径匹配（交付工作室即如此）。`unreadable_ack` 条目同样按这一规范身份匹配文件，因此用一种拼写写下的原因也能解释以另一种拼写声明的文件。

  除逐文件报告外，结果的 `meta` 还携带消费方与报告并列展示的登记级事实：`style`（确定性核验所用样式）与 `warnings`（登记声明本身写错的地方，每行一条）。两者只在有内容时写入；在它们出现之前记录的结果只是缺少该键。

<a id="deterministic-checks"></a>
## 确定性核验

工具读取交付文件本身，而不是相信模型的自述。文件扩展名决定用哪个读取器（`.md`/`.markdown` 按 Markdown、`.html`/`.htm` 按 HTML、`.docx` 按包、`.pdf`/`.pptx` 按无文本读取器的格式），声明与扩展名不一致时按扩展名核验，并把不一致写进该文件的原因里；`other` 与未知扩展名沿用声明的格式。Markdown 与 HTML 按文本读取；`.docx` 包经 [`@deepseek-ai/dsh-docx-kit`](../docx-kit/README.zh.md) 投影为文本，读取受 `maxArchiveEntries` 与 `maxUncompressedBytes` 两个配置预算约束；没有文本读取器的格式（`pdf`、`pptx`、`other`）报为 `unchecked` 并附原因，而不是"通过"。超出任一读取预算的包报为 `unreadable` 并在原因中带 `too-large`，绝不截断，也不需要声明原因；其余 `unreadable` 文件必须在 `unreadable_ack` 里写一条原因，否则调用失败——"没核验"不能被读成"核验通过"。

| 检查 | 触发条件 | 级别 |
| --- | --- | --- |
| `placeholder` | 仍有残余占位符：可填的 `{{变量}}`，或 `[TBD]`、`Lorem ipsum`、`待补充` 等共享词表（定义在 [`@deepseek-ai/dsh-doc-style`](../doc-style/README.zh.md)）里的标记形式 | 引用文本之外 `block`，代码块或行内代码之内 `warn` |
| `anti_pattern` | 所选风格把该词列为禁用 | 沿用风格自身的 `block` / `warn`；作为代码或示例文本被引用的词一律 `warn` |
| `empty_section` | 标题到下一个标题之间没有任何内容；直接写在更深标题之上的 H1 是文档标题，其内容在子标题之下 | `warn` |
| `broken_anchor` | `](#片段)` 或 `href="#片段"` 指向本文档未声明的 id、命名锚点或标题 slug，且不是渲染器惯例应答的 `top` | `warn` |
| `length_budget` | 声明的 `char_budget` 偏差超过配置的 `lengthTolerance`（随包默认 20%）。HTML 文档按正文计字数：先剥掉标签、注释与 `script`/`style` 元素的内容 | `warn` |

`block` 级问题直接抛错：拒绝登记，错误信息指出文件、检查项与行号，模型修复文档而不是把它登记出去。`warn` 级问题记录在结果里、登记照常进行——它们都存在评审可以接受的读法。风格取自 `defaultStyle`、篇幅容差取自 `lengthTolerance`，两者都由工具描述给出；未加载的风格名会让调用失败并列出可用名称。每项检查最多列出 `maxFindingsPerCheck` 条（默认 5 条），其余汇总一行，不静默丢弃。

## Model Experience

### 工具 schema

#### 模型看到什么

一个已注册的工具定义：`document_deliver`，含参数 schema（文件列表与格式、质量门清单、可选 brief 引用、风格名、字数预算）与登记回执渲染；回执包含模型自报的 P0/P1 项数、每个文件的确定性核验结论与每条提示。精确的 description 与参数见生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-document-deliver)。

#### Token 影响

固定一个工具的定义成本，每次请求都存在；结果内容是回执加每条提示一行，压缩前每次结果都会重发。本包不注册 system-prompt 段落，无额外固定提示词成本；可配置的样式指南由 [`@deepseek-ai/dsh-doc-template`](../doc-template/README.zh.md) 注入，本包核验所用的风格资产同样由该包持有。

#### KV Cache 影响

注册工具集与 description 不变时前缀稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **登记是声明而非转换** —— 工具不复制、渲染或转换文件，只做存在性与内容核验并在会话日志记录声明。PDF 导出仍走交付工作室的打印动作；幻灯片与特殊 Office 格式转换仍依赖用户级 `officecli` 技能。
- **不设交付门，与专利模式的差异是有意的** —— 专利模式给 `render_patent_document` 与 `build_patent_filing` 挂了交付前置门禁：规则、法条与留档三次运行未成功过，这一轮就交付不了件。本模式不声明任何门禁，因此会话可以在交付物未登记的情况下结束。门禁绑定的是「前置调用早于被门禁调用」，专利模式两半都齐：前置是一次中间动作（本轮的留档条目），被门禁的调用是专利域唯一被认可的产出路径——[`patent-document-polish`](../../bundle/web-app/skills/patent/patent-document-polish/SKILL.md) 明写交付件只走 `render_patent_document` 这一条。`document_deliver` 则是终结性的声明：字节先由作业需要的那条路写出来（手写 Markdown 与 HTML、`render_doc_template`、`.docx`/`.pptx` 的用户级 `officecli` 技能），它之后再无工具被调用。两条更强的设计已评估并否决：把落盘收进工具，会让登记工具变成转换器，与 `doc-template`、`officecli` 重复，而且仍覆盖不到手写路径；在轮次边界上做回复级检查（`agent/turn-stopping` 配 `agent.steer`）必须从回复判断这一轮是否意在交付，而本模式有意先写 brief、大纲与草稿，文件写入与标题都不是交付轮的标记，用声明去门禁声明本身也不判定任何东西。工具被调用时确实守住的：声明的文件不存在即调用失败，`block` 级发现直接拒绝登记。
- **无跨会话聚合** —— 交付工作室只折叠单个会话的日志窗口；跨会话历史、搜索与批量导出属于延期的文档工作台 v2（见[工作台提案](../../../.agents/notes/proposed/feature/2026-08-23-document-mode-workbench.zh.md)）。
- **核验不等于评审** —— 它只覆盖质量门里可机械判定的部分（占位符、风格禁用词、空章节、同文档片段、声明字数预算），对来源、正确性、可访问性不发一言。P0/P1 项仍是模型的自述；工具把结论并列展示而不去验证它，面板两列都显示。
- **只强制已配置风格的词表** —— 需要避开风格词表之外用词的部署，应把这些词加进风格资产（或用 `styleDirs` 指向自己的目录）。单次调用的豁免参数会让禁用词无理由地溜过去且不留记录，故本工具不提供。
- **锚点检查是启发式** —— 它接受 `id`/`name` 属性声明的片段、按 GitHub 规则命名的标题 slug，以及渲染器无需声明即可应答的 `top` 惯例，因此采用其他 slug 约定的渲染器可能产生"其实没断"的 `broken_anchor` 提示；正因为如此该检查只报提示。
- **HTML 字数是扫描而非解析** —— 它剥掉注释、声明、标签与 `script`/`style` 元素的内容，并解码字符引用；属性值里带引号的 `>` 不在覆盖范围内，代价是随后那段标记的字数偏差，而不是跳过某项检查。
- **超限是跳过而非截断** —— 超过 `maxCheckBytes`（随包默认 4 MiB）的交付物不再读取，报为 `unreadable` 并附原因；核验跑在"什么都没查"上，而不是跑在一个可能恰好通过的开头上。
- **DOCX 读取预算是部署级预算** —— 声明条目数超过 `maxArchiveEntries`、或解压后超过 `maxUncompressedBytes` 的包报为 `unreadable` 并带 `too-large`；交付超大可重复文档的部署应在 `cordis.yml` 上调高该上限，而不是接受一次不完整的核验。
- **读不出的文件必须给出原因** —— 核验读不出的文件，调用方必须在 `unreadable_ack` 里写一条原因，否则登记失败；"没核验"因此永远不会被读成"核验通过"。读取预算这一档（`too-large`）例外：那是部署自己的预算，不是文档本身的缺陷。
- **取消不是"文件不可读"** —— 调用方信号在核验途中中止时，调用以取消错误拒绝，而不是报 `unreadable`；逐文件循环在读取下一个文件前停下，模型不会因此去修一份它从未读过的文档。

### 开发备注

确定性核验为本包原创，不是移植：它读取移植来的风格资产（[`@deepseek-ai/dsh-doc-style`](../doc-style/README.zh.md)）的禁用词表，以及移植来的模板引擎（[`@deepseek-ai/dsh-doc-template`](../doc-template/README.zh.md)）的占位符约定。`document_deliver` 工具本身、其参数校验与存在性检查沿用原插件，未作改动。
