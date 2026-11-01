---
description: "纯 TypeScript 库（无 `ctx` 依赖），承载自 Sati 移植的专利域引擎：`StageProvider`/`StageHandler` atoms 及其 30 个内置 handler、`PatentModelPort` 适配器、双轨 checker、技术问题四检验、TRIZ 矛盾分析、证据账本与判定引擎、推理原语、claim-chart 引擎、权利要求撰写自检与权利要求形式自检、说明书摘录锚点校验、数值范围新颖性核验、程序文书解析、答复计划与复审准备段、侵权确定性内核（全面覆盖、等同一致性、风险分级）、Pregel 风格图引擎及其四个专利域子图、规则协议与文本工具、IPC 分类器与审查标准查表、专利交付工具的受控草案模型（SpecDraft/TemplateDraft）及校验器、以及持久化/路径助手。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-core

[English](README.md) | 中文

## 概述

纯 TypeScript 库（无 `ctx` 依赖），承载自 Sati 移植的专利域引擎：`StageProvider`/`StageHandler` atoms 及其 30 个内置 handler、`PatentModelPort` 适配器、双轨 checker、技术问题四检验、TRIZ 矛盾分析、证据账本与判定引擎、推理原语、claim-chart 引擎、权利要求撰写自检与权利要求形式自检、说明书摘录锚点校验、数值范围新颖性核验、程序文书解析、答复计划与复审准备段、侵权确定性内核（全面覆盖、等同一致性、风险分级）、Pregel 风格图引擎及其四个专利域子图、规则协议与文本工具、IPC 分类器与审查标准查表、专利交付工具的受控草案模型（SpecDraft/TemplateDraft）及校验器、以及持久化/路径助手。

<a id="package-surface"></a>
## 包入口与导出

本包只导出根入口 `@deepseek-ai/dsh-patent-core`，解析到 `lib/index.js`，声明文件为 `lib/types/index.d.ts`；`./src/*` 深层导入不再导出，会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 失败。根 barrel 再导出各模块声明的全部类型，以及按消费方使用筛选后的运行时值：下文记述的引擎、注册表、图构造函数、解析器、校验器与存储。仅供内建 atom 使用的运行时助手保留在包内，相关行为经由 `registerBuiltinAtoms()`、图构造函数或对应模块的聚合引擎获得。`tests/package-surface.spec.ts` 校验每个导出目标都包含在 `files` 中。

## 目录

- [包入口与导出](#package-surface)
- [Atoms 引擎](#atoms-engines)
- [ModelPort](#modelport)
- [Checker（双轨确定性规则引擎）](#checker-dual-track-deterministic-rule-engine)
- [Problem（原子化技术问题四检验）](#problem-atomic-technical-problem-checks)
- [TRIZ 矛盾分析（发明人侧）](#triz-contradiction-analysis-inventor-side)
- [Evidence（证据闭环账本 + 判定引擎）](#evidence-closed-loop-ledger--judgment-engine)
- [Reasoning（事实黑板 + 三段论）](#reasoning-fact-blackboard--syllogism)
- [Claim-chart 运行时](#claim-chart-runtime)
- [权项覆盖自检](#claim-coverage-checks)
- [权利要求形式自检](#claim-formal-lint)
- [摘录锚点校验](#quote-anchoring)
- [数值范围新颖性核验](#numeric-range-novelty-check)
- [程序文书解析](#notice-parsing)
- [答复准备](#response-preparation)
- [侵权确定性内核](#infringement-kernel)
- [Graph 引擎](#graph-engine)
- [规则协议 + IPC](#rule-protocol--ipc)
- [受控草案模型](#draft-model-controlled-drafts)
- [Model Experience](#model-experience)
- [已知局限与延期工作](#known-limitations-and-deferred-work)

<a id="atoms-engines"></a>
## Atoms 引擎

atoms 层定义工作流阶段词汇：`Atom`/`AtomRegistry`（声明式契约）与 `StageHandler`/`StageHandlerRegistry`（运行时）。`registerBuiltinAtoms()` 注册 30 个 handler：模型/检索阶段 `search`、`keywords`、`extract`、`merge`、`compare`、`novelty`、`reasoning`、`groundedness`、`draft-claims`、`approval-gate` 与 `claim-chart`，对立审查阶段 `adversary-model` 与 `adversary-review`，以及确定性法律检查 `oa-parse`（通知书解析）、`grounds`（程序理由识别）、`response-plan`（答复计划骨架）、`coverage`（全面覆盖与等同核验）、`pfe-consistency`、`citation-check`、`time-baseline`、`dispute-framing`（争议粗定位）、`dispute-framing-refine`（时间依据修正）、`prior-art-filter`、`conflicting-application`、`numeric-range`、`problem-check`、`amendment-basis` 与 `evidence-check`，还有 `enablement-report`：从独立权利要求派生特征，由模型逐特征给出实施例摘录，再逐条复核原文后写入 A26.3 判定。`claim-breadth` 列出权利要求中的每条上位概括，由模型给出支撑实施例摘录并判断并列下位是否达到同一效果，复核原文后写入 A26.4 判定；该项在校准达标前保持 warn 级。`@deepseek-ai/dsh-patent-tools` 通过插件 effect 另注册 6 个包内原子：`slop-gate`、`draft-specification`、`spec-check`、`response-check`、`eligibility` 与 `legal-gaps`。宿主注入一个 `StageProvider`（`callLLM` 字符串接缝或流式 `llm` 端口，以及 `search`），handler 消费它并在缺失时降级而非抛错。调用方传入的 `signal` 会透传到 LLM 接缝与检索阶段：一旦中止，阶段以 `StageCancelledError` 拒绝（`stageId` 标识阶段），不再降级或重试；图引擎直接向上抛出该拒绝，而不是标记节点降级。

Stage params 可调整这些 handler。缺省键保留各原子默认值；畸形值会在调用模型前降级。

| 键 | 类型 | 默认值 | 适用范围 |
| --- | --- | --- | --- |
| `temperature` | 数字，0–2 | 按原子（`0`、`0.1` 或 `0.2`） | 调用模型的原子 |
| `prompt_char_limit` | 正整数 | 按原子 | prompt 中引用的来源摘录；短小生成行不受限 |
| `max_retries` | 整数，0–10 | `2` | `claim-chart` 的校验重做 |
| `groundedness_threshold` | 数字，0–1 | `0.6` | `groundedness` 低分过滤与提示词分数分界 |
| `chart_source_roots` | 非空字符串组成的数组 | 工作目录 | `claim-chart` 源文件读取；显式列表替换默认值，`[]` 拒绝所有读取 |
| `chart_source_max_bytes` | 整数，1–16 MiB | 1 MiB | `claim-chart` 单个源文件大小上限 |

`claim-chart` 只读取目标行点名的源文件，但模型给出的路径不会原样交给文件系统。路径按工作目录解析后以真实路径与允许根比对：落在所有根之外、不是普通文件、扩展名不在文本白名单内，或超过 `chart_source_max_bytes` 的源，会在引用它的每一行上报错，源文内容不进入提示词。符号链接按目标判定——指向根外即拒绝，指向根内仍可读取——无扩展名的路径按文本接受。允许根不可解析或参数畸形时，整个阶段在调用模型前降级。

<a id="modelport"></a>
## ModelPort

`PatentModelPort.stream(request, signal?)` 是 canonical 流式 LLM 词汇。`createLlmModelPort(stream, { provider, model })` 将 harness 的 `LlmRuntime.stream(options: GenerateOptions)` 适配为它，`collectPortText` 再把端口桥接回依赖 LLM 的 atoms 所用的字符串。provider 选择保留在 harness `ctx.llm` 适配器与 `agent/request` 瀑布（Sati router 不移植）。端口另带 `route`（哪条 provider/model 作答）与 `bindSession(sessionId)`——后者重新绑定端口，使每次请求都带上会话身份；工具在函数体内调用模型时先绑定会话，调用才有归属、才可被记录。

<a id="checker-dual-track-deterministic-rule-engine"></a>
## Checker（双轨确定性规则引擎）

`RuleEngine` 对分析文本逐条评估域过滤的 `CheckRule`——新颖性单独对比、创造性三步法、侵权全面覆盖、充分公开、说明书 checklist 与 24 条推理模式规则——含同义词扩展与否定检测；`aggregate` 将失败映射为 `pass`/`needs_revision`/`blocked`。规则语料随 `@deepseek-ai/dsh-patent-rule` 发布（由 `createCheckerRuleEvaluator()` 暴露）；本包只保留引擎、规则类型与 `RuleEvaluator` 端口，供三性子图的 `rule_gate` 消费。启用规则门的图必须注入评估器，缺少时在构图期报错，而不是静默省略规则门。每个子图声明规则门评估的最终报告键（`novelty_report`、`inventiveness_conclusion`、`enablement_conclusion`）；规则门不再扫描整个 state，原始输入的措辞不会触发规则失败。规则门 fail-closed：空领域、未知领域、评估器异常、域内零规则，以及任一声明来源缺失、为空、非字符串或带降级标记，均判 `blocked`，不会静默放行。结构化 `rule_gate` 状态记录 `status`（`pass`/`fail`/`blocked`）、评估器 `verdict`、失败规则、`evaluatedKeys` 与 `degradedSources`。

<a id="problem-atomic-technical-problem-checks"></a>
## Problem（原子化技术问题四检验）

`checkAtomic` 对实际解决的技术问题执行四项确定性检验（不绑方案、单一因果、可测效果、手段可反推），`technicalProblemCheck` 将其接入 checker 的 `customCheck` 规则。

<a id="triz-contradiction-analysis-inventor-side"></a>
## TRIZ 矛盾分析（发明人侧）

`extractTrizContradictions(port, text, { focus })` 用一次模型调用识别技术矛盾（改善某工程参数的同时牺牲另一工程参数）与交底书点名却未量化的工程参数（缺现状值／目标值／单位／测量口径）。`buildTrizAnalysis(extraction, sourceText)` 确定性组装结果：只接受 1-39 的整数参数编号，逐对落格到 `@deepseek-ai/dsh-methodology` 随包的 39x39 矛盾矩阵（对角格是物理矛盾，空格是转录缺口），参数与原理名称一律取随包资产而非模型输出，并**丢弃证据无法在交底书原文中逐字定位的矛盾**、计入丢弃数。

产物属发明人侧：候选方案方向与交底书补强缺口清单。矛盾对不是三步法第二步的技术问题表述——后者必须相对区别特征确定且不含解决手段（`checkAtomic`），把矛盾填进该字段会直接违反该检验。

<a id="evidence-closed-loop-ledger--judgment-engine"></a>
## Evidence（证据闭环账本 + 判定引擎）

证据层记录工具收据（`Ledger`/`receiptFromToolExecution`），提升为可定位的 `EvidenceSpan`，绑定结论、检测冲突，并运行三性 + 类型特定判定（`EvidenceEngine`）与举证责任/证明标准评估。三性评分衡量的是证据记录的完备度，不是其中断言的真实性：自报的内容哈希只在调用方声明已独立核验时计入真实性，声明的证据类型也不代替公证文书记载或来源域名。四要件中，片段否认的线索不按肯定认定：「未约定保密义务」是在排除保密义务而不是认定存在保密义务，公众可获取性须另由片段写明对公众开放才算认定。现有技术截止日取申请日与优先权日中的较早者（专利法第22条第5款），证明标准按证据方向而非评分归类，无法识别的标准按失败关闭处理（`status: 'unknown-standard'`、`met: false`），不凭置信度放行。来源 URI 无法解析时公开意图为 `unknown` 而不是 `public`，并生成复核项。`contentHash` 输出 `sha256:<64 位十六进制>`，账本摘要采用同一形式；`evidence-check` 对 `sha256:` 哈希与摘录做重算校验，旧版 FNV 哈希只在重算一致时按 `legacy-hash` 待核项接受，任意短十六进制不再自动当作内建哈希。gap 检测同时报告证据薄弱的行与根本没有映射行的「要素 × 目标」组合。`buildWorkflowEvidenceLedger` 把一次已完成运行消费的材料、权利要求书、现有技术（`D<n>`）、证据与抵触申请转成带 `citationId` 的收据，供结论引用回溯；`citation-check` 以同一套标号校验结论中的 `D<n>`，使引用可直接定位到运行持久化的收据。

<a id="reasoning-fact-blackboard--syllogism"></a>
## Reasoning（事实黑板 + 三段论）

`FactBlackboard` 在推理步骤间共享事实、规则约束与法条判定（软丢弃回溯、锁定保护），`SyllogismBuilder`/`ruleAssertion` 强制每条结论引用黑板事实与法条。

<a id="claim-chart-runtime"></a>
## Claim-chart 运行时

`validateElements`/`validateRowMapping`/`detectGaps`/`validatePinCite` 校验要素网格，`saveClaimChart`/`loadClaimChart`/`renderChartMarkdown` 持久化并渲染（复用共享的 `JsonFileStore` 助手）。`deriveClaimRefs` 从权利要求原文推出独立／从属类型与所引权项号：带前缀的引用语（`根据权利要求1`）在权项正文任意位置生效，不带前缀的 `权利要求1所述` 只在引言部分（特征部分之前或第一句以内）生效，概括引用（`前述权利要求中任一项`）展开为全部在前权项。

<a id="claim-coverage-checks"></a>
## 权项覆盖自检

`checkClaimUnity` 判定一组权利要求的单一性（A31.1）：清洗独立权利要求中的结构样板词后逐对比较字符重叠、Jaccard 与 bigram 余弦，取最弱对。`score` 即最弱对相似度的百分数，`grade` 与判定阈值同线（不低于 0.8 为 `good`，不低于 0.6 为 `fair`，低于 0.6 为 `poor`），任一对低于 0.6 相似度阈值时 `hasUnity` 为 false。阈值与权重是自上游 `unity.yaml` 规范继承的启发式口径、不是法条数值；结论服务于撰写自检，法律判断仍由代理师作出。

`checkEmbodimentCoverage` 生成权项—实施例覆盖矩阵：每条条目给出权利要求标识、其技术特征与支持它的实施例引用，本模块按整串出现判定 full/partial/none。调用方给出的覆盖度判读不是输入——结论只来自这两列事实；一条特征都不给的条目按非法驳回（`features 为空`），不报 full 也不报 none，因为两种读法都是空真的。断档仅在全部条目编号合法时推断，因为非法条目本应占据的编号未知。特征数按去重后计算，重复特征不再虚增已覆盖数（上游实现按原始列表计数）。

<a id="claim-formal-lint"></a>
## 权利要求形式自检

`lintClaimText` 校验一组权利要求应当满足的形式要件（《专利法实施细则》第二十二条、第二十三条、第二十四条、第二十五条；审查指南第二部分第二章 3.2.1、3.2.2、3.3.1、3.3.2 节），每条发现都带它据以判定的法条与指南条款。`parseClaimDocument` 以行首编号（`1.`、`2、`、`3．`）切分权项，其余任何非空行——标题、表格行、分隔线、权项之后的段落——都报为权利要求书之外的内容；只有位于权项开头的引用语才使其成为从属权利要求，因此独立权利要求内部的交叉引用仍是交叉引用。结构性规则是精确判定：编号连续、引用方向（从属权项只能引用在前的权项）、多项从属形式（只能以择一方式引用，且不得作为另一项多项从属权项的引用基础）、特征部分的存在、独立权利要求的两段式、每项结尾恰有一个句号，以及主题名称与被引用权项一致。`findAntecedentGaps` 报告「所述X」中 X 未在本项或所引用权项中出现的情形，并沿引用链传递遍历；术语边界按虚词启发式截断且封顶 8 字，组成部分均已出现的复合词（如「所述转子铁芯外圆」而「转子铁芯」已出现）降为 warning。用语规则——功能性或效果限定、方法特征、非技术内容、商业性用语、引用说明书或附图——是词表匹配，只用于提示复核，且只在特征部分生效，所以「一种用于…的装置」这类前序不会被读成功能性限定。本检查只陈述形式缺陷；说明书支持与可专利性不在其范围。

<a id="quote-anchoring"></a>
## 摘录锚点校验

`locateQuote(quote, sourceText)` 判断模型给出的说明书摘录是否真的出现在说明书原文中，并回填原文坐标下的命中区间。逐字命中记为 `exact`；否则双方各自归一化：全角与常用 CJK 标点折为 ASCII，不含换行的连续空白折为一个空格，含换行的空白串折为一个段边界。标点折叠是逐字符处理，不改写数字与字母，所以全角 `２０` 不会匹配 ASCII `20`；`…` 折为三个句点，下标映射保证每个命中仍指回原文字符。归一化后先按段边界结构匹配（摘录不含换行时等价于逐段匹配），失败再把段边界折为固定空格重试，因此摘录可以跨段，也可以在原文换行处写空格。每个阶段取最早命中，且 exact 阶段先于归一化阶段。`range` 是 `sourceText` 上的左闭右开区间，不指向归一化文本，`sourceText.slice(range.start, range.end)` 取回的是包含被折叠换行的原文片段。`matched: false` 且 `reason: 'empty'` 表示摘录为空或纯空白，调用方必须按未通过处理；`reason: 'not-found'` 表示归一化后仍不出现。本函数只证明原文有这句话，不证明这句话支持它所引用的权项特征。

<a id="numeric-range-novelty-check"></a>
## 数值范围新颖性核验

`analyzeNumericRanges` 从权利要求与对比文件文本提取数值，按区间相交做确定性判定（数值范围重叠或存在共同端点即破坏新颖性；数值点严格落在对比文件范围内且无共同端点则不破坏），给出 `overlapped`/`inside_without_endpoint`/`no_overlap`/`inconclusive`。数值可带正负号（含 Unicode 减号与全角减号），单边表述支持方向词（`不低于`）与后缀（`70℃以上`）两种写法。区间允许单位写在连接符之前（`20℃至90℃`、`5mg-10mg`）并读作一个区间；连接符与单位词表与 `validate_specification` 共用（`src/novelty/numeric-vocabulary.ts`），两条路径因此不会对同一文本读出不同结果，而该校验额外要求尾随单位（它要用同单位单值比对端点）。同量纲单位先换算到基单位再比较（`5-10mg` 等于 `0.005-0.01g`，`1-2h` 等于 `60-90min`）；温度只按摄氏刻度比较，不做温标偏置换算。表外单位仅在两侧写法完全相同时可比，否则记为一对不可比，只要存在不可比对结论就降为 `inconclusive`（已有破坏性重叠时除外）。只有后接已识别单位的发现算强发现并参与判定；汉字单位表是封闭的，否则"数值 + 两个汉字"的贪心匹配会把"任一""公开"当成单位、把权项编号抬成参数。换算后的端点相对误差在 1e-9 内视为共同端点，换算溢出为无穷大则不算。`crossCheckNumericVerdict` 与 LLM 轨的结论对照并标记一致性；任一具体分歧都记为 `disagree` 并在摘要中要求复核（上游只标记其中一个方向）。新颖性子图的 `numeric_range` 节点把该轨与 LLM 轨并行运行，并把 `numeric_range_verdict`、`numeric_range_agreement`、`numeric_range_deterministic` 写入 state，使 LLM 不可用时确定性结论仍然保留。

<a id="notice-parsing"></a>
## 程序文书解析

`parseOfficeAction` 只用关键词表与正则把审查意见通知书正文转成结构化事实：所援引的驳回类型（去重，按首次出现位置排序）、引用文献（相关性类别取文献号之后紧邻位置的标注，权项取同句共现，并列枚举（`权利要求1、2和3`）逐项计入）、正文提到的权项编号（`权利要求1至3`、`第1-5项` 两类区间展开为逐个编号，故 `第2-3页` 一类页段区间不入表）与至多五条审查员论点句。正文指代本申请自身的文献号（`本申请公开号CN…`、`本申请（申请号CN…）`、`CN…（本申请）`）不是引用文献，不入文献清单。同一文献在正文不同位置的相关性标注不一致时，结果列入解析冲突（`parseConflicts`：冲突源、候选值、采用依据），不静默取单一结论。`identifyInvalidationGrounds`、`identifyReexaminationGrounds`、`identifyDesignGrounds` 分别读三类程序的理由表——无效五条、复审六条（含实用新型客体）、外观设计三条（专利法第 23 条各款）——每条带法条依据与中文标签；`detectPatentSubject` 报出正文写明的专利权类型，无法判定时返回 `undetermined` 而不默认按发明处理。每条理由带 `negated`：命中词位于同一分句的前置否定（`未主张`、`并非`、`没有证据表明`）作用范围内时仍输出供人工核对，但标注为否定，调用方不会把被否认的理由当作已主张；同一理由先被否认、后又被主张时取后一处正面命中。被否定的命中不参与 `detectPatentSubject` 的实用新型推断，`grounds` 原子摘要会标注否定，`buildReexaminationPreparation` 会将其排除；后置否定（……的理由不成立）与双重否定不在判定范围内。与上游的差异：相关性只在有标注时给出（上游以 `A` 兜底，等于把"仅一般背景技术"当成已认定的事实）、引用文献的权项取同句共现而非恒空、论点按码位而非字节截取、补入"公开不充分"（上游表只收"公开充分/充分公开/能够实现"，最常见的写法漏检）、理由表无命中时返回空数组而不造一条新颖性默认理由、实用新型不剔除创造性理由（上游删除该理由且未给出依据）。本模块不产出法律结论。

<a id="response-preparation"></a>
## 答复准备

`buildResponsePlan(notice, { independentClaims })` 把通知书解析结果拼成答复骨架：每条驳回理由一段，带答复策略（争辩、修改或组合）与该段必须逐项回应的段落；修改类理由按（理由 × 通知书提到的权项）逐权项出一行修改对照，每行带修改动作（按独立/从属权利要求取值）与法条依据。`REJECTION_STRATEGY`、`REJECTION_AMENDMENT_ACTIONS`、`REJECTION_SECTIONS`、`REJECTION_BASIS` 是按驳回类型穷尽的闭集表，`summarizeStrategies` 渲染 `创造性→争辩、不清楚→修改` 摘要行。通知书无法确定的事报缺口而不假设：未识别到驳回条款、修改类理由未抽出任何权项编号、修改类驳回未点到任何独立权利要求。`buildReexaminationPreparation(findings, { oralHearing })` 给出复审各准备段：技术特征对比表与修改前后对比表的列、A33 不超范围的必填项与依据，以及仅在安排口审时才出现的按理由分组的合议组质疑预演与四阶段口审时间线。与上游的差异：修改对照表逐权项出行（上游只按受影响权项中最靠前的编号判动作，从属权利要求的动作从不生效）、修改对象不可知时报缺口而不兜底权利要求 1、A33 段不区分驳回决定是否提出该理由（复审阶段仍可能提交修改替换页）、对比表只给列不出占位行、口审两段挂在显式开关上且默认关闭——上游的 `oralHearing` 从未被置真，两段是不可达代码。

<a id="infringement-kernel"></a>
## 侵权确定性内核

`deriveAllElementsCoverage(rows, targetId, elements)` 对 claim-chart 的行级映射逐权利要求判定全面覆盖：逐权项区分字面覆盖的要素、字面覆盖依赖权利要求解释的要素、只有等同映射覆盖的要素，以及两者皆无的要素（该权项缺任一要素即不落入）。整体结论取覆盖最佳的权项——落入任一权利要求的保护范围即侵害该专利——并在 `claimNo` 指明该权项；要素表为空时结论为 `undetermined`，不给出 `not-covered` 的实质结论。`findEquivalenceContradictions(rows, triplets)` 核验图表与另给的等同认定记录：按等同落格却无认定记录、同一要素与目标有两条记录、认定记录否认等同、认定等同但手段/功能/效果三项均判不同、认定等同同时认定仍需创造性劳动、以及认定等同却未落到图表上。`scoreInfringement(input, weights?)` 给出评分：五个维度按固定次序加权求和，按 0.7 与 0.4 在权重量程上的比例定风险等级，阈值随结果一并返回。与上游的差异：字面与等同覆盖合成一个维度（上游分列加权，字面全覆盖只有 0.25 分而被评为低风险）、删除 `strategy_viability` 维度（它数的是助手自己给的建议的优先级）、赔偿上限改为调用方给出的比例而非硬编码的一千万元、求和次序固定而不随 Go map 迭代变化、权重非法或比例越界即抛错而不静默出分。

<a id="graph-engine"></a>
## Graph 引擎

`GraphBuilder`/`CompiledGraph` 运行 Pregel 风格超步（BSP）引擎：节点读取深拷贝 state 快照并返回增量片段，按 `Reducer`（last-write-wins/append/union/merge-map/fail-on-conflict）确定性合并。`NodePolicy` 提供重试、超时与副作用处理；`GraphInterruptError` 暂停以等待审批门；handler 通过 `_error`/`_retryable` 报告的预期失败会在图节点边界转换为 `<node>__degradation` 标记，进入运行的 `degraded` 汇总并由工具层判定为未完成，内部诊断键不进入图状态；`runGraphWithCheckpoints`/`grantApproval` 持久化每超步检查点并续跑。`buildNoveltyGraph`/`buildInventivenessGraph`/`buildEnablementGraph` 组装三性子图（新颖性/创造性/充分公开），含确定性节点、LLM 节点与 checker `rule_gate` 收口；新颖性子图的 `numeric_range` 节点在 LLM 轨旁并行运行数值范围确定性轨；`buildCitationCheckGraph` 为确定性纯函数图，校验结论文本中的每个引用（专利号或 D<id>/对比文件N 标识）均出现在 `prior_art` 状态中；`manifestToGraph` 将 `WorkflowManifest` 桥接为图。

<a id="rule-protocol--ipc"></a>
## 规则协议 + IPC

宪法规则引擎协议类型（`RuleSeverity`/`RuleAction`/`RuleCheck`/`ConstitutionalRule`/...）与 `hasNegationContext`/`parseCnNumber` 文本工具在此落地，供 P3.1/P4.1 规则门禁使用。IPC 分类器（`classifyIpc`/`classifyIpcTop`）与 `ipc-standards.yaml` 审查标准加载器以纯查表形式随包分发。

<a id="draft-model-controlled-drafts"></a>
## 受控草案模型

`draft` 模块定义了受控草案契约，取代专利交付工具中由模型产出的 HTML：`SpecDraft` 用于 claims-spec 申请文件（著录项 `meta`（含抬头编号行与页脚印出的案卷号）、不带项号的 `claims`、多段 `abstract`、`figureFiles`、摘要附图号 `abstractFigure`（1 起，缺省 1），以及按 `SPEC_PART_HEADINGS` 五部分 keyed 的 `sections`（附图说明部分恰每幅附图一条列表项，条数等于 `figureFiles` 项数，且每项只写图名与描述文字，不含图号前缀与句末标点））；`TemplateDraft` 用于其余文书模板：`fields` 承载 `text` 文本槽（填入 `.fill` 值位）与 `choice` 选项槽（选中项的选项 id，多选组为 id 数组），`sections` 承载 `blocks` 正文块（paragraph/list，每段或每项一行）或 `rows` 数据行（等宽字符串数组，供表单数据行克隆）。块仅有 `paragraph`/`list`/`table` 三种；表题与权项编号由下游转换器生成，因此合法草案不会携带标题或任意表格标记。两通道共享的词汇——`SPEC_PART_ORDER` 与生成「图N为……；/。」附图说明的 `numberedFigureDescriptions`——也在这里持有，HTML 与 DOCX 转换器不可能分叉。`validateSpecDraft`/`validateTemplateDraft` 把无类型的工具 JSON 窄化为上述类型，并把全部违规聚合进一次抛出的 `DraftValidationError`，消息中对每个未知键列出可用项。支撑 `TemplateDraft` 校验的槽位注册表随 `dsh-patent-document` 分发。

<a id="model-experience"></a>
## Model Experience

None，因为草案 schema 每次调用仅作为工具参数到达模型，库本身不贡献 prompt 或系统侧内容；模型以结构化草案替代模板 innerHTML 后，标题、权项标记与表格标记全部由下游转换器生成，模型输出更短且同模板文档的 token 结构一致，校验错误会列出可用槽位，被驳回的草案无需回读模板源码即可修正。

#### KV Cache effect

Independent; the draft schema is submitted per call inside tool arguments and never populates a reusable system-side KV-cache prefix.

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与延期工作

- **纯库、无 `ctx`** — 该包不注册任何内容；由宿主或消费方将引擎组装进工作流（P3.1）与工具（P3.2）层。
- **ModelPort 适配器需要注入的 stream** — `createLlmModelPort` 适配调用方提供的 `LlmRuntime.stream`；patent-core 不持有 provider 选择或活 `ctx.llm`。
- **证据规则资产暂存桩** — `loadEvidenceRulesEngine(ruleDirs?)` 接受显式目录，未传时返回默认权重引擎；真实规则包由 `dsh-patent-rule`（P4.1）解析。
- **IPC 数据以资产打包** — `ipc-standards.yaml` 随包发布在 `assets/`，经 `import.meta.url` 从源码与构建后 lib 均可解析。
- **检查点仍为文件存储** — `JsonFileCheckpointStore` 经共享的 `JsonFileStore` 持久化每超步检查点；`ctx.storage` 接缝随工作流集成（P3.1）落地。
- **持久化记录只校验、不带版本号** — `JsonFileCheckpointStore` 对字段不符合 `GraphCheckpoint` 的记录（含 `id` 与文件名不一致）抛带文件路径的 `StoredRecordError`，`list`/`loadLatest` 遇损坏文件直接失败而不是跳过。格式没有版本字段，不兼容的旧形状按非法记录拒绝，不做迁移。
- **图引擎为纯计算** — 超步引擎与各域子图在进程内运行、无 `ctx`；LLM 与检索能力经注入的 `StageProvider` 提供。
- **单一性是相似度指标** — 评分与评级来自对清洗后权利要求文本的加权词法相似度；本模块不给出法律结论，`fair` 或 `poor` 表示该组权利要求需要代理师复核，而不是直接判定为不满足单一性。
- **程序文书解析是词法判定** — 理由表沿用上游的宽词（清楚、支持），命中只表示文书写到了该条款，不表示该理由已被实质论证；相关性与逐篇权项取自文献号周围的文本，不是审查员的权威对应。
- **答复准备只排计划、不作论证** — 计划说明哪些理由必须答复、哪些权项必须修改、通知书留下了哪些缺口；是否要求优先权、具体修改文本与理由成立与否由代理师决定。
- **侵权的等同结论由调用方给出** — 手段/功能/效果的认定是输入，本模块只核对其与图表是否自洽；它既不判断是否构成等同，也不以未公开的赔偿上限替换调用方给出的比例。
- **数值提取只识别封闭的单位表** — 拉丁/符号单位加一份列明的汉字单位表；用其他单位（或无单位）书写的数值只算弱发现、不能改变结论。表外单位仅在两侧写法完全相同时可比，同量纲换算也只覆盖表内单位（不做温标偏置换算），因此该核验偏向返回 `inconclusive`。
- **LLM 对照依赖 `verdict` 字段** — 数值范围节点从 LLM JSON 读取 `verdict`；响应缺少该字段时对照结论保持 `n_a`，不做猜测。
- **草案模型只校验结构、不渲染** — 槽位注册表、HTML 转换器与 docx 映射位于 `dsh-patent-document`/`dsh-patent-filing`；patent-core 只持有共享类型与校验器。
- **不支持无附图申请** — `SpecDraft` 要求 `figureFiles` 必填，且附图说明部分须每幅附图一条列表项；无附图的申请不在当前草案契约范围内。

### 开发备注

无。

本包不发布 invariant 伴生组件：库是对调用方输入做纯计算，不持有可独立观测并可能分歧的包内持久状态。
