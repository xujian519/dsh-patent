---
description: "函数插件，为专利撰写者或 Agent 提供本部署适用的撰写模式：随包分发的 YAML 撰写模式语料（撰写与审查意见答复场景）经 query_writing_patterns 工具与一个 writing-patterns:skills 系统提示词 section（携带紧凑的 `<pattern_index>` 模式索引）到达模型，并作为无需密钥的库 API 供提示词装配使用。选择为词法匹配且离线完成——关键词检索、案件特征匹配、按类目列举或列举整个模式库——故同一查询始终选中同一批模式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-writing-patterns

[English](README.md) | 中文

## 概述

函数插件，为专利撰写者或 Agent 提供本部署适用的撰写模式：随包分发的 YAML 撰写模式语料（撰写与审查意见答复场景）经 query_writing_patterns 工具与一个 writing-patterns:skills 系统提示词 section（携带紧凑的 `<pattern_index>` 模式索引）到达模型，并作为无需密钥的库 API 供提示词装配使用。选择为词法匹配且离线完成——关键词检索、案件特征匹配、按类目列举或列举整个模式库——故同一查询始终选中同一批模式。

## 目录

- [query_writing_patterns 工具](#query_writing_patterns-tool)
- [模式语料与库 API](#pattern-corpus-and-library-api)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="query_writing_patterns-tool"></a>
## query_writing_patterns 工具

query_writing_patterns 返回适配某个撰写或审查意见答复场景的撰写模式，并编译为 `<writing_skills>` 块。每个模式对应一个场景——权利要求撰写、说明书撰写、技术交底书撰写、IPC 策略、具体实施方式撰写，以及关于创造性、新颖性、清楚性的审查意见答复——给出有序步骤及应遵循与应避免的规则。

选择顺序固定且不经过模型。调用给出 `query` 时按关键词检索语料；只给出 features 而不给 query 时，将这些特征与模式名称、著录关键词、摘要、步骤名比对，并以类目充当案件类型；只给出 `category` 时按 id 顺序列举该类目；不带任何参数时列举整个模式库。`limit` 限制返回条数：收窄的调用缺省取部署的 `matchLimit`，而不带参数的列举始终返回整个模式库。

评分为对著录字段的词项包含计分。关键词检索切分拉丁词，并对中文串补相邻二字组（bigram），再在名称命中计 3、著录关键词计 2.5、摘要计 2、场景（context）计 1.5、步骤名计 1、步骤指令/应遵循规则/应避免规则计 0.5，总数再乘该模式的质量权重。特征匹配在类目或其中文标签包含案件类型时计 5，名称命中计 3、著录关键词计 2.5、摘要计 2、步骤名计 1.5，再乘质量权重。同分按模式 id 升序排列，故重复调用返回同一份列表。

结果携带选择模式、每个命中模式的 id、类目、名称、模式库规模，以及编译后的块；`quality` 仅作为得分乘数留在内部，不进入模型可见结果。无命中时返回空模式列表、空 `skills`，并给出一行文字说明模式库规模及放宽调用的方式。

<a id="pattern-corpus-and-library-api"></a>
## 模式语料与库 API

语料随包分发于 `assets/patterns/`，每个模式一个资产文件，后缀为 `.yaml` 或 `.yml`，经 `import.meta.url` 相对本模块解析，故源码树与构建产物读取同一目录。文件要么声明一个模式，要么以 `patterns` 列表声明多个，字段为 `id`、`name`、`category`、`summary`，可选的 `sub_category`、`context`、`keywords`、`source_ref`、`version`，以及 `steps`、`examples`、`dos`、`donts`、`quality`；出现其他键会直接拒绝，不被静默丢弃。`keywords` 是著录的检索同义词；`source_ref` 记录法律依据，不编译进提示词，由包内 `source-ref` 用例逐条对照随包法律索引解析。前十个是 MIT 许可的 Go 项目 `Mady/domains/writing` 的种子模式：实用新型权利要求撰写、从属权利要求分层、背景技术、发明内容、创造性三步法答复、新颖性单独对比、清楚性与支持、交底书 PFE 三元组、IPC 策略、具体实施方式；上游的版权与许可声明保留在 `NOTICE` 中。另有八条撰写期模式：用最接近现有技术反打独权的三步法自检、26.3 实施例矩阵、33 条修改预埋、单一性、功能性限定、软件方法/装置/介质三件套、马库什并列下位、数值范围退路。`invalidation` 类目不带随包模式：它命名无效宣告实务，使部署语料无需改格式即可挂接；在 `sectionCategories` 中选中它不会多索引任何内容。

加载 fail-loud。`loadPatternStore()` 读取随包目录，`loadPatternStore(patternDir)` 读取显式目录（相对路径按工作目录解析）；目录不可读、目录下没有模式文件、YAML 语法错误、id 重复，或字段缺失、类型错误、超出范围、无法识别，一律抛出 `PatternAssetError` 并点名文件、字段路径与可用字段。类目不在已知九类之内同样如此，因为工具的类目枚举永远选不到这样的模式。`quality` 缺失或为零时取移植的默认值 0.8。

库 API 直接导出这些部件：`PatternStore`（`size`、`get`、`all`、`byCategory`、`search`、`match`）、`loadPatternCorpus`、`parsePatternFile`、`patternKeywords`、`compileWritingSkills`、`compileWritingPatternIndex`、`escapeXmlText` 与 `PATTERN_FILE_SUFFIXES`。`compileWritingSkills` 输出工具结果携带的 `<writing_skills>` 块，`compileWritingPatternIndex` 输出提示词 section 携带的紧凑 `<pattern_index>`；两者都是模式的纯函数，故调用方可对注入文本做断言。插件挂载还会提供 `writingPatterns` 服务（`patternsForStage`、`compiledForStage`、`stageIds`），按下文阶段映射解析。

<a id="configuration"></a>
## 配置

Schemastery 配置，全部字段可选。

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| patternDir | string | 随包资产 | 存放模式 YAML 文件的目录，相对路径按工作目录解析；须镜像随包布局。语料缺失或非法将使插件加载失败。 |
| matchLimit | number | 5 | 检索、特征匹配或类目列举未自行给出 `limit` 时的返回条数上限；不带参数的列举始终返回整个模式库。移植的上游来源把一次匹配上限写死为 5。 |
| registerSection | boolean | true | 注册常驻的 writing-patterns:skills 系统提示词 section。 |
| sectionCategories | string[] | 全部九个类目 | 索引 section 携带的类目；空列表则只注入指令文字。 |
| sectionOrder | number | 112 | 注入 section 在系统提示词中的位置，与专利域的 TRIZ section（111）相邻。 |
| stagePatterns | Record<string, string[]> | 无 | 每个工作流阶段的提示词应获得的模式 id，按阶段 id 索引。每个阶段列 3 到 5 个存在于已加载语料中的 id；未知或重复 id、数量超出该范围都会使插件加载失败。原子通过 `writingPatterns` 服务按阶段读取；查询未声明的阶段会抛错。 |

<a id="model-experience"></a>
## 模型体验

### query_writing_patterns 工具

#### 模型所见

一个名为 `query_writing_patterns` 的已注册工具，四个可选参数：`category`（九个模式类目之一）、`query`（检索关键词）、`features`（案件的技术特征）与 `limit`。结果渲染为命中模式——id、类目标签、名称——其后是编译后的 `<writing_skills>` 块，携带这些模式的摘要、步骤、应遵循规则与应避免规则；不带参数的调用无论 `matchLimit` 为何都列举整个模式库。`limit` 小于 1 时以点名该参数的工具错误返回；未知类目在枚举处即被拒绝，不会进入执行。

#### Token 影响

工具启用期间每次请求承担固定定义成本；每次结果重复命中模式及其编译块，故 `limit` 越大成本越高，仅在压缩前重复占用上下文。

#### KV Cache 影响

仅追加；新可见的结果文本位于可复用的请求前缀之后，不使既有 KV 缓存条目失效。

### writing-patterns:skills 系统提示词 section

#### 模型所见

一个常驻的提示词 section，名为 `writing-patterns:skills`，仅在 `registerSection` 为 `true`（默认）时以位置 112 注册，携带 `sectionCategories`（默认为全部类目）中模式的紧凑 `<pattern_index>` 索引。索引逐条列出一个模式的 id、类目与名称；步骤与规则经 `query_writing_patterns` 取得。其指令文字为：

##### 指令原文

```markdown
The <pattern_index> block below lists the writing patterns of this deployment by id, category, and name; it is an index, not the pattern text.
Call query_writing_patterns with the case category, the case features, or search keywords to retrieve the matching patterns with their ordered steps and the rules to follow or avoid. When the case at hand is already covered by one of the indexed patterns, retrieve that pattern before drafting.
```

#### Token 影响

每次请求承担两行指令的固定成本，加上注入类目的紧凑索引，该索引仅在压缩前重复占用上下文；`sectionCategories` 为空时只剩两行指令，`registerSection: false` 则整个 section 消失。随包语料下索引为 1,819 字符，而把原先十条模式全量编译为 17,461 字符。

#### KV Cache 影响

section 文本、其位置与索引不变时前缀稳定；改动 `sectionCategories`、`sectionOrder`、`patternDir` 或任一模式资产都会重建索引，并自该 section 起使缓存复用失效。`stagePatterns` 的改动不影响该 section。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **随包语料共十八条模式** —— 十条来自移植项目的种子模式，另加八条撰写期模式。把 `patternDir` 指向部署自备目录即可替换；其中每个文件仍须满足同一套字段规则，否则插件加载失败。
- **选择只是词法匹配，从不做语义理解** —— 中文串通过相邻二字组与著录 `keywords` 匹配，故同一场景换个说法仍可能命中不到。工具结果最后一段给出模式库规模，使模型能区分「库窄」与「查询窄」。
- **`quality` 是检索相关性，不是法律正确性** —— 它只乘在词法得分上且不进入工具结果，不证明模式中的规则或引用正确。
- **`source_ref` 在测试期校验，不在加载期校验** —— 编译器不把它写入提示词。`tests/source-ref.spec.ts` 将每条引用（含款号与审查指南节号）对照随包法律索引解析，但加载器仍会接受引用无法解析的语料。
- **`query` 与 `features` 计分方式不同且不叠加** —— 两者同时给出时按关键词检索，忽略特征匹配；特征匹配服务于已知特征、却不知如何措辞的案件。
- **提示词 section 只带索引，不带模式正文** —— 随包语料把 18 条模式索引为 1,819 字符；把 18 条全部编译则需 27,234 字符。模型要先调用 `query_writing_patterns` 才能按某条模式撰写，比原先的常驻全量块多一次工具往返。`system-prompt.expected.md` 快照逐字节固定了索引，语料改动使其变化时必须有意重录该 fixture。
- **`examples` 与应遵循/应避免规则的 `example` 只被解析、从不参与编译，`sub_category` 参与选择但不进入编译块** —— 编译块携带每个模式的摘要、步骤（含步骤自身的 `example`）、应遵循规则与应避免规则，与移植的编译器一致，且种子语料未设置顶层或规则级示例。`sub_category` 只参与类目查找。需要渲染示例的调用方自行从 store 读取。
- **工具只读且无状态** —— 它读取插件加载时读入的语料，自身不写入任何持久状态或会话事件；其结果仅作为普通工具结果进入日志。
- **阶段模式只是查询，不是注入** —— `stagePatterns` 按阶段解析 id 并经 `writingPatterns` 暴露；它不改工作流 manifest，也不自行把文本推进阶段提示词。消费方原子须主动按自己的阶段查询；未声明映射的阶段会在查询时显式失败。
- **资产失败发生在加载期而非调用期** —— 语料非法或缺失时在插件挂载阶段抛出 `PatternAssetError`，故部署不会带着空模式库面对模型。

<a id="dev-note"></a>
### 开发备注

无。

本包不发布 invariant 伴生组件：本包不持有持久状态与事件，每个导出都是针对语料的纯函数，唯一读取的资产目录在插件加载时 fail-loud 校验。
