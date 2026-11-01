---
description: "函数插件，将 Sati 专利域工具集原生移植到 DeepSeek Harness。它注册 36 个模型可见工具，覆盖检索、元数据、知识查询、权利要求对照表、通知书解析、TRIZ 矛盾分析、撰写、分析报告、证据判定、规则检查、附图生成、跨图一致性与图文比对、案卷只追加日志以及工作流/计划状态机。每个工具返回可无损 JSON 序列化的规范值，并暴露纯 `output.render` 函数生成模型可见 prose（Sati 没有 render 拆分，这是新的 dsh 契约）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-tools

[English](README.md) | 中文

## 概述

函数插件，将 Sati 专利域工具集原生移植到 DeepSeek Harness。它注册 36 个模型可见工具，覆盖检索、元数据、知识查询、权利要求对照表、通知书解析、TRIZ 矛盾分析、撰写、分析报告、证据判定、规则检查、附图生成、跨图一致性与图文比对、案卷只追加日志以及工作流/计划状态机。每个工具返回可无损 JSON 序列化的规范值，并暴露纯 `output.render` 函数生成模型可见 prose（Sati 没有 render 拆分，这是新的 dsh 契约）。

## 目录

- [工具](#tools)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知局限与延后工作](#known-limitations-and-deferred-work)

<a id="tools"></a>
## 工具

| 工具 | 类别 | 数据源 / 引擎 |
| --- | --- | --- |
| `patent_search` | 检索 | `@deepseek-ai/dsh-patent-data`（nuo `searchPatents`，LRU 缓存；引擎失败或零命中时另走 CNIPR 通道） |
| `patent_metadata` | 检索 | `@deepseek-ai/dsh-patent-data`（nuo `scrapePatent`，LRU 缓存；引擎答不出的中国公开(公告)号另走 CNIPR 通道） |
| `patent_legal_status` | 检索 | `@deepseek-ai/dsh-patent-data`（nuo `LegalStatusChecker`，引擎答不出的号另走 CNIPR 通道） |
| `law_search` | 知识 | `ctx.patentKnowledge.legalSearch` / `.guidelineSearch`（knowledge.db FTS5，语料为 `law_article` 与 `guideline_rule` 两类文档，`scope` 选语料） |
| `patent_case_search` | 知识 | `ctx.patentKnowledge.caseLawSearch`（knowledge.db FTS5） |
| `patent_wiki_search` | 知识 | `ctx.patentKnowledge` wiki 卡片 |
| `patent_kg_query` | 知识 | `ctx.patentKnowledge` 知识图谱 |
| `patent_eval` | 质量 | 确定性（内联反套话引擎） |
| `patent_analysis_report` | 分析 | `@deepseek-ai/dsh-patent-core` analysis-report 聚合器 + 可选 ModelPort |
| `claim_chart_build` | 撰写 | `@deepseek-ai/dsh-patent-core` claim-chart 原子 + ModelPort；`mode: infringement` 另给确定性结论（逐被控产品全面覆盖、等同矛盾；`risk` 给出抗辩与补救事实时给出风险等级） |
| `parse_office_action` | 分析 | 确定性 `@deepseek-ai/dsh-patent-core` 通知书解析器（驳回类型、引用文献与相关性、涉及权项、审查员论点） |
| `triz_contradiction_analysis` | 分析 | `@deepseek-ai/dsh-patent-core` TRIZ 引擎（矛盾组装 + 经 `@deepseek-ai/dsh-methodology` 的矛盾矩阵落格）+ ModelPort 负责识别；产出发明人侧的方案方向与交底书参数缺口 |
| `draft_claims` | 撰写 | 确定性 |
| `draft_specification` | 撰写 | 确定性 |
| `validate_specification` | 质量 | 确定性 |
| `evaluate_evidence` | 证据 | `@deepseek-ai/dsh-patent-core` 证据引擎 |
| `rule_check` | 质量 | `@deepseek-ai/dsh-patent-rule` 规则引擎 |
| `claim_lint` | 质量 | 确定性 `@deepseek-ai/dsh-patent-core` 权利要求书形式自检（编号、引用方向、多项从属形式、引用基础、主题名称、两段式、用语、标点、正文之外的内容）；结构性规则精确判定，用语类规则是词表启发式 |
| `analyze_patent_figure` | 分析 | 经 `FigureAnalysisEngine` 走视觉 ModelPort（Config.figureAnalysisMode：`single`=一次调用，默认；`two-step`=结构抽取+说明生成两次调用）；按附图模型做图片输入门禁 |
| `search_patent_figure` | 检索 | 附图索引关键词检索（索引由 `analyze_patent_figure` 写入，见 Config.figureIndexFile） |
| `check_patent_figure_consistency` | 质量 | 对 `analyze_patent_figure` 的多图识别结果做确定性跨图校验（不调用模型）：同一数字标记在各图中必须同名、图号必须从 1 起连续、`claim_context`（权利要求书或说明书正文）中引用的标记（括号形「(10)」「（10）」或直连形「壳体10」）必须在某张图中识别到。电学符号与网表暂不在范围（电学分析引擎尚未移植）。 |
| `compare_patent_figure_analysis` | 质量 | 把出图时声明的期望标号清单与 `analyze_patent_figure` 的识别结果做确定性比对：缺标、多标、名称不符（仅两侧名称都非空时）、图型不符（忽略大小写，仅两侧都给出时）。闭合「生成 → 识图 → 比对」闭环；不调用模型；连接关系暂不比对。 |
| `generate_patent_figure` | 撰写 | 附图生成：Graphviz DOT 通路（流程图/状态图/框图/层级图/模板/原始 DOT）+ SVG 直绘通路（电路图/曲线图/剖视图/时序图/外观设计视图排布）；SVG 默认内置 `@viz-js/viz` WASM，png/pdf 与 `figureRenderer: 'cli'` 走 `dot` CLI（Config.graphvizExecutable / figureOutputDir / dotFont）；可选导出时文字转路径，使 SVG 不带字体依赖（Config.figureTextToPath，需要 Inkscape）；给了 `target_office` 或图型只有 SVG 通路时，png/pdf 走 SVG 全链（落版 → 渲染复核 → 文字转路径 → Inkscape `--export-type=png|pdf --export-area-page` 导出），落版、复核与引线标号因此对它们同样生效——本机没有 Inkscape 时改由渲染器直接出图，并明确提示落版与复核未生效；提交规格 page/dpi/margin/orientation；框图/层级图 SVG 默认引线标号（直绘图型收到该参数时明确回报「不生效」，不再静默忽略）；剖视图可给引线标号（`sections.labels`）、中心线（`sections.centerlines`）、断裂线（`sections.break_lines`：长零件省略中段时在两端各画一条锯齿或波浪细实线，零件拆成两段轮廓给出）、图面字号（`label_font_size_mm`）、按 GB/T 4457.4 的线宽（`stroke_width_mm`/`thin_stroke_width_mm`，零件用 `parts[].stroke_width_mm` 单独覆盖，均不得低于 0.18 毫米），非剖切轮廓用 `hatch: "none"`——剖视图也可不从手写坐标而来，而用 `sections.source`（STEP/IGES/BREP + 剖切平面）从 CAD 模型切出轮廓与剖面线，材料区域由 `parts[].anchor` 认领——`sections` 亦可传 JSON 文件路径；`panels` 多面板输出与 `figure_family` 跨图标号续接；部署的图面字号（Config.figureFontMm，小四 = 4.23 毫米）决定 DOT 的 `fontsize`、直绘图型的图面字号默认与落版核算的正文字高，故本所的小四/四号体例一次配置即生效（模型显式给的参数优先）；`require_cutting_marks`（Config.figureRequireCuttingMarks）让缺 `sections.cutting_marks` 的剖视图直接报错，而不是静默出一张没有剖切符号的图；`target_office` 按法域落版为固定幅面附图页并核算尺寸；返回图形绝对路径；返回图面用语检查警告、输入层剖面线警告与渲染复核发现；结果写入附图索引（Config.figureIndexFile） |
| `add_patent_figure_references` | 撰写 | SVG 标号后处理：内嵌模式按 `<text>`/`<tspan>` 文本匹配追加 `(标号)`；`leader_lines: true` 在部件轮廓外侧绘制引线并放置独立标号；返回标注文件的绝对路径 |
| `verify_patent_figure` | 质量 | 对已生成的 SVG 源做渲染复核量测（不需要栅格化器）：线宽与线段取向分布、文字元素，以及只在画面上才看得见的缺陷——图面文字（标号、元件名、连线说明）被引线或轮廓贯穿、与图线净距不足（`text_clearance_mm`，默认 1.5 毫米，0 关闭；绘图侧标注的引线与被更晚绘制的不透明白填充盖住的图元不计）、细点划线中心线被同位置的实线边覆盖、相邻零件剖面线取向近到无法区分、两个图元叠压（闭合轮廓包围盒部分相交——有意嵌套、同材料分组号的轮廓、两侧都是纯填充图元都不计）、字高低于下限（`min_font_mm` 或 Config.figureMinFontMm；报告同时给出量测值 `minFontMm`）、内容越出画布。同时给出 `hierarchy`（声明的父标记 → 子标记）与 `claims` 时，另报「图内层级与权项写出的构造归属相矛盾」。元素按嵌套逐层继承变换（translate/scale/rotate/matrix）与线宽、描边、字号（含自 `<g>` 继承的 `text-anchor` 与行内 `style`），根元素的画布尺寸与 viewBox/preserveAspectRatio 先解析成毫米，故落版页、拼版页与 px 级用户单位的导出文件同一口径；不在量测范围内的结构（CSS 类样式、`<use>`/`<image>`、嵌套 `<svg>` 内层视口、marker 端头、`<tspan>` 位移、dominant-baseline、百分比长度、无法解析的变换/路径/viewBox、按端点弦近似的曲线段）各出一条「未量测」发现而不是略过 |
| `generate_structure_figure` | 撰写 | FreeCAD TechDraw 结构线稿：经宿主 `freecadcmd` 子进程把 STEP/IGES/BREP 模型投影为黑白多视图 SVG（`iso`/`front`/`rear`/`top`/`bottom`/`left`/`right`，Config.freecadExecutable）；件号锚定到真实 3D 顶点的投影；局部放大视图（`details`：给出基视图与模型坐标窗口及放大倍数，落成 `TechDraw::DrawViewDetail`）；默认关闭（Config.structureFigureEnabled）且 CAD 隔离；支持单模型文件或目录批量（目录批量与 `callouts`、`details` 互斥：二者的坐标都只对单个模型有效）；`target_office` 按法域落版每个视图 SVG；结果写入附图索引（`figureType: 'structure'`）；可选导出时文字转路径（Config.figureTextToPath，同 generate_patent_figure） |
| `patent_pdf_download` | 文档 | browser-backend 冷决策：启用时中国公开(公告)号先走 CNIPR 通道，其余走 ego-browser CDP 响应体取回（统一 ego 栈） |
| `recognize_chemical_structure` | 分析 | 可选（rdkit 未随包）；索引写入已接线（Config.chemistryIndexFile） |
| `flexible_plan` | 工作流 | `@deepseek-ai/dsh-patent-workflow` flexible-plan |
| `patent_workflow` | 工作流 | `@deepseek-ai/dsh-patent-workflow` 收口 |
| `patent_workflow_run` | 工作流 | `@deepseek-ai/dsh-patent-workflow` + ModelPort |
| `patent_plan_task` | 工作流 | `@deepseek-ai/dsh-patent-workflow` plantask 状态机；`transition` 接受案卷条目（`issues` + 规划轮次 `round`），用随包处置表补全默认值、回显解析后的条目并交给阻塞/终态/轮次上限守卫 |
| `patent_worker_validate` | 质量 | `@deepseek-ai/dsh-patent-workflow` worker 契约 |
| `knowledge_note_save` | 知识 | Config.noteDir 下的文件写入器（默认 `<cwd>/99-知识库`） |
| `workbench_link_patent_case` | 工作流 | 个人工作台 loopback HTTP API：幂等案件桥接（patent_* 字典种子化；根任务 + L1–L5 阶段子任务，`source='patent'`；`_matter-log.md` 状态投影；不写案件目录、不改根任务状态） |
| `matter_log_append` | 工作流 | `<case_dir>/_matter-log.md` 的只追加写入口：每轮一条条目（本地时间 + UTC、动作、产物、本轮取代的路径、审批人、变更说明），写入前先判定取代链——产物须已存在、撰写/修订轮不得复用已登记的产物路径、取代目标必须已在日志中、同一旧版不得被取代两次 |

`render_patent_document` 由 `@deepseek-ai/dsh-patent-document` 拥有（其 `apply()` 注册该工具）；本包仅再导出 `createRenderPatentDocumentTool` 与 `renderDocumentResult` 供库消费者使用，不重复注册，因此同时组合两个插件不会产生重名错误。

`slop-gate` 是工作流原子，而非模型可见工具：`apply()` 将 `slopGateAtom` 与 `SlopGateHandler` 注册进全局注册表，因为该门依赖本包内联的反套话引擎。它按阶段参数 `text_keys` 指定的状态键做确定性分析（缺省 `['claims_draft']`，答复链路传 `['draft_tightened']`），写入 `slop_report` 与 `slop_score`；当文本未达通过线时，额外写入仅含证据的 `slop_revision_hint`（命中短语与建议替换、结构性问题行级定位；绝不包含评分数字、总分或通过线）。参数 `char_budget` 声明篇幅预算：传了按预算归一测 concision，不传则按段数，撰写链路走的是后者。声明预算同时把 evidence 与 directness 切到文书口径：通篇零证据锚点的正文不能靠中性基线过线（封顶在基线之下），「段落少于 3 段加分」只在未声明预算时生效，开头仍是「请审查员重新考虑…」式请求句时即便点明争点也不满分。`patent_disclosure_v1` manifest 的 `slop_clean` 阶段门控草稿、命中失败信号即回退到 `draft_claims`，`patent_oa_response_v1` 的 `slop_gate` 阶段门控答复正文并回退到 `draft`，两处都使重写时注入该提示。库消费者同样获得 `slopGateAtom`、`SlopGateHandler`、`SLOP_GATE_PASS_THRESHOLD` 与提示构造器 `buildSlopRevisionHint`。`tighten` 是同一旋钮的另一半：`apply()` 注册 `tightenAtom` 与 `TightenHandler`，因为它的判定要用同一份 `visibleChars`（现已从 `slop-engine.ts` 导出）。该函数也在包的公开 API 上（`export { visibleChars }`）：`patent-oas` 评测用同一套计数测交付物篇幅，若在那边另写一份，「同一个 4000 字」在两处就会算出不同的数。它只计散文：表格（Markdown 行或 HTML 元素）与修改后权项全文先被剔除再计数，因为这些块是交付载体，不是作者能删的篇幅。它读正文（`text_key`，缺省 `draft`）、答复计划（`plan_key`，缺省 `response-plan`）与 `char_budget`，写 `draft_tightened`、`tighten_report` 与 `tighten_violations`；删减后反而变长、原样返回（声明了预算却一字未删）或仍超预算时降级、不写入，只交正文也收，报告如实写明逐条清单缺失。

<a id="configuration"></a>
## 配置

Schemastery 配置，所有字段可选。

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `provider` | string | — | LLM 消费工具（`patent_analysis_report`、`claim_chart_build`、`patent_workflow_run`、`flexible_plan`、`analyze_patent_figure`）的 provider 路由。 |
| `model` | string | — | LLM 消费工具的模型 id。 |
| `imageModel` | object | — | 专用附图/图片模型路由（`{ provider, model }`），其声明的输入模态用于门禁 `analyze_patent_figure`；未设置时回退到 `provider`/`model`。 |
| `maxTokens` | number | — | LLM 消费工具的输出 token 上限（可选）；省略时用 provider 默认值。 |
| `workflowStageBudget` | number | `24` | 单个内置工作流 manifest 允许声明的最大阶段数；超过即插件加载失败。 |
| `workflowLlmStageBudget` | number | `12` | 单个内置工作流 manifest 允许声明的最大模型调用阶段数：未声明 atom 的阶段与契约标记 `usesModel` 的原子计入；超过即插件加载失败。 |
| `noteDir` | string | `<cwd>/99-知识库` | `knowledge_note_save` 的知识笔记目录（绝对或相对 cwd）。 |
| `figureIndexFile` | string | `<cwd>/.sati/figures-index.json` | 附图索引文件：`analyze_patent_figure` 写入分析条目、`search_patent_figure` 检索（绝对或相对 cwd）。 |
| `chemistryIndexFile` | string | `<cwd>/.sati/chemistry-index.json` | `recognize_chemical_structure` 写入的化学索引文件（绝对或相对 cwd）。 |
| `graphvizExecutable` | string | 自动探测 | `dot` 可执行路径覆盖；探测顺序：覆盖值 → `DSH_GRAPHVIZ_DOT` → 平台候选路径 → `PATH`。 |
| `graphvizRenderTimeoutMs` | number | `60000` | CLI `dot` 单次渲染的超时；WASM 引擎为同步渲染，不受它约束。 |
| `figureOutputDir` | string | `<cwd>/patent/figures` | `generate_patent_figure` 的输出目录（绝对或相对 cwd）。 |
| `figureTextToPath` | boolean | `false` | 导出时把图面文字转成轮廓路径，SVG 因此不依赖阅读器字体；需要 Inkscape，两个附图生成工具都适用，也适用于导出 png/pdf 所依据的中间 SVG；不经该全链的 png/pdf 仍由渲染器出字，并回报该参数不生效。产物仍含 `<text>`、未通过 SVG 安全校验、或墨迹越出原图范围时拒绝替换，原图保持原样。含中文的图导出 pdf 时本参数还是前置条件：Inkscape 1.4.4 在字体子集化个别字形（实测「源」）时会截断 PDF 且退出码仍为 0，故 `exportWithInkscape` 对缺 `startxref`/`%%EOF` 的 PDF 一律判为失败而不交付。 |
| `figureRequireCuttingMarks` | boolean | `false` | 要求每个剖视图都给出剖切位置符号（`sections.cutting_marks`）：未给即报错，不再交付缺剖切符号的剖视图。GB/T 4458.6 只在剖切平面与对称面重合且视图在标准位置时允许省略，此类剖视图可在调用时传 `require_cutting_marks: false`。 |
| `figureFailOnRenderFindings` | boolean | `false` | 两个附图生成工具的渲染复核门禁：为 true 时，除 `not-measured` 外的任何发现都判本次生成失败——已写入的文件保留供修正，但不作为交付件。非 SVG 直绘没有可量测的图面，门禁会明确回报未生效，而不是假装通过。 |
| `figureFontMm` | number | 无 | 部署的图面字号（毫米）：决定 DOT 的 `fontsize`、直绘图型的图面字号默认与落版核算的正文字高。小四 = 4.23 毫米、四号 = 4.94 毫米；模型逐次显式给的参数优先。 |
| `figureMinFontMm` | number | 无 | 图面字高内控下限（毫米）；模型未传 `min_font_mm` 时 `verify_patent_figure` 按它判定。法条只要求缩小到三分之二仍能分辨，毫米数是部署内控口径而非法定值。 |
| `inkscapeExecutable` | string | 自动探测 | 文字转路径所用的 `inkscape` 可执行路径覆盖；探测顺序：覆盖值 → `DSH_INKSCAPE` → 平台候选路径 → `PATH`。 |
| `inkscapeRenderTimeoutMs` | number | `30000` | 单次文字转路径的超时（毫秒）。 |
| `workbenchBaseUrl` | string | 进程内 webServer 端口 | `workbench_link_patent_case` 的工作台 API 基址；显式配置优先，web 组合内自动取 `http://127.0.0.1:<webServer 端口>`；不可用（非 web profile）时工具在执行期以 `setup_required` 失败。 |
| `workbenchCaseRoot` | string | `<cwd>/patent-workspace` | `workbench_link_patent_case` 的案件根目录：每案位于 `<root>/<案号>/`，内含 `_matter-log.md`。 |
| `dotFont` | string | 平台相关 | DOT 字体名覆盖；默认 Helvetica，label 含 CJK 时按平台候选（PingFang SC / Microsoft YaHei / Noto Sans CJK SC）。 |
| `figureRenderer` | `'wasm' \| 'cli'` | `wasm` | `generate_patent_figure` 的 Graphviz 渲染器：`wasm` 为内置 `@viz-js/viz`（SVG，无系统依赖）；`cli` 走 `dot` 子进程。未给 `target_office` 时的 png/pdf 路由到 CLI。 |
| `figureAnalysisMode` | `'single' \| 'two-step'` | `single` | `analyze_patent_figure` 模式：`single` 为一次视觉调用；`two-step` 在同一路由先做结构抽取再做说明生成（模型成本翻倍）。 |
| `figurePageSize` | `'a4' \| 'letter'` | — | 提交规格页面尺寸；设置时输出 DOT `page`/`size` 属性（per-call `page_size` 覆盖）。 |
| `figureOrientation` | `'portrait' \| 'landscape'` | portrait | 提交规格页面方向（per-call `orient` 覆盖）。 |
| `figureDpi` | number | — | 提交规格渲染 DPI（栅格输出生效；per-call `dpi` 覆盖）。 |
| `figureMargin` | number（厘米） | — | 四边同值页边距；与 `figurePageSize` 同给时收缩绘图区 `size`（per-call `margin` 覆盖）。 |
| `freecadExecutable` | string | 自动探测 | `generate_structure_figure` 与剖视图 CAD 剖切来源（`sections.source`）的 `freecadcmd` 可执行路径覆盖；探测顺序：覆盖值 → `DSH_FREECAD_CMD` → 平台候选路径 → `PATH`。 |
| `freecadRenderTimeoutMs` | number | `120000` | 单次 FreeCAD 步骤的超时（`generate_structure_figure` 的一次投影，或 `sections.source` 的一次剖切/一次剖面线）；FreeCAD 冷启动比 `dot` 慢，故默认值翻倍。 |
| `structureFigureEnabled` | boolean | `false` | `generate_structure_figure` 门禁：CAD 隔离、默认关闭；门禁未开启时工具在执行期以 `setup_required` 显式报错。 |
| `structureFigureScale` | number | `1` | `generate_structure_figure` 的 TechDraw 投影比例默认值（per-call `scale` 覆盖）。 |
| `structureFigureViews` | string[] | `['iso','front','top','right']` | `generate_structure_figure` 的缺省视图集（per-call `views` 覆盖）；每一项必须是受支持视图名（`iso`/`front`/`rear`/`top`/`bottom`/`left`/`right`），未知名称在配置加载时被拒绝。 |

有两项子进程预算保持固定、不做配置：SIGTERM→SIGKILL 升级宽限（3 秒），因为 `dsh-patent-data` 的 subprocess runner 与它共用，改一处就破坏收尾对称；单流输出上限（100 000 字节），因为它约束渲染器内存。导出的 `probeGraphviz`/`probeFreeCad` 由调用方自带超时（`DEFAULT_GRAPHVIZ_PROBE_TIMEOUT_MS`/`DEFAULT_FREECAD_PROBE_TIMEOUT_MS`）；插件自身不探测，因此没有可配置的探测预算。

未设置 `provider`/ `model` 时，LLM 消费工具照常注册，但调用时 fail loud（`setup_required`）。知识类工具需要经 `patent-knowledge:install` 准备的 knowledge.db；缺失时 fail loud 并给出安装引导。

<a id="model-experience"></a>
## Model Experience

### 工具 schema

#### 模型所见

36 个已注册工具定义（见上表），各含描述、参数 schema 与将规范结果渲染为 Markdown prose 的 `output.render`。精确描述与参数见生成的[`patent-tools` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-patent-tools)。`patent_search` 与 `patent_metadata` 在渲染结果与上游失败消息里都点名所读通道（`Google Patents（nuo 引擎）` 或 `CNIPR（中国知识产权网）`），检索报告据此写明事实来自哪个通道，而不必从命中的 URL 反推；`patent_search` 还在引擎失败或零命中时经 CNIPR 再检索一次（带 `assignee:` 这类 Google 字段语法的查询不咨询该通道），并点名本次实际服务的通道；`patent_metadata` 在引擎失败、抛错或查不到某条中国公开(公告)号（如 `CN218483312U`）时经 CNIPR 按号重查一次，该通道只发布标题、申请人、公开日与摘要，其余字段为空，被咨询过但未能服务的通道列入 `warnings`。两者对瞬时上游失败（超时、连接断开）各按带界退避重试两次，退避耗尽仍失败时报告已尝试次数。`patent_pdf_download` 逐篇点名通道（`Google Patents（nuo 引擎）` 或 `CNIPR（中国知识产权网）`），并在 `warnings` 里列出「被咨询过但未能服务」的通道，使回退可见、不与被接手的那篇混为一谈；续传条目的通道取自 MANIFEST 的记录。`patent_legal_status` 逐篇点名通道，并把引擎答不出的号经 CNIPR 重查一次；该通道也没有记录时保留引擎给出的原因。`matter_log_append` 在一次消息里列出被拒回合的每一处缺陷，各带稳定规则 id 与修法（该先落盘的产物、撰写轮需要的新路径、日志中查不到的旧版），使拒绝说明缺的是留档记录的哪一部分，而不只是「本轮被拒」。

#### Token 影响

每个已注册工具在每次请求产生固定定义开销；结果文本随数据变化，仅到压缩时才会重发。本包不注册任何 system-prompt 段，因此无额外固定 prompt 开销。

#### KV Cache 影响

在已注册工具集与其描述不变时前缀稳定；修改配置或注册集会使工具定义偏移，并从该点起失效复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与延后工作

- **`render_patent_document` 归属** — 该工具由 `@deepseek-ai/dsh-patent-document` 注册，而非本包；本包仅再导出其工厂。
- **`flexible_plan` 命名** — Sati 的 `patentFlexiblePlanTool.ts` 声明名为 `flexible_plan`（非 `patent_flexible_plan`）；dsh 工具信任 Sati 的 name 字段。
- **图片模态门禁范围** — `analyze_patent_figure` 把附图发送给解析出的附图模型路由，并按该路由声明的图片输入做准入（缺失时以错误码 `model_cannot_accept_image` 拒绝）；图片字节经 harness 附件服务入库后以持久引用随请求发送，附件服务或路由缺失时以 `setup_required` 显式报错。`search_patent_figure` 读取索引，刻意不做门禁（与 Sati 一致，仅门禁 analyze）。索引由 `analyze_patent_figure` 写入 Config.figureIndexFile；索引缺失或为空时返回零命中并附引导提示，而非报错。
- **化学引擎未移植** — `recognize_chemical_structure` 与 `validate_specification` 的化学表征检查降级为不可用，因为识别流水线（VLM 两步法、name→SMILES、RDKit 校验）尚未移植：RDKit 只是其中缺失件之一，不是唯一一件，因此无论宿主机装了什么，该工具都返回不可用结果。
- **图元内核** — `figure/mm-primitives` 是毫米坐标格式化与包围盒的唯一实现；直绘渲染器、落版页与引线通路都经它写 SVG 数值，一张图不会因绘制路径不同而混用精度。
- **视觉分析深度与化学引擎** — `analyze_patent_figure` 移植了 Sati 的包装层，提供单步/两步视觉分析；Sati PatentVision/PatentLMM 引擎中的电路网表与多图一致性检查未移植。附图生成、落版、渲染复核、Graphviz/Inkscape/FreeCAD 通路与关键词附图索引均已在本包实现。化学引擎（VLM 两步法、name→SMILES、RDKit 校验）仍未移植，因此 `recognize_chemical_structure` 返回不可用结果，`validate_specification` 的化学表征检查也随之降级。
- **附图生成范围** — `generate_patent_figure` 的 SVG 默认经内置 `@viz-js/viz` WASM 引擎渲染（Config.figureRenderer）；png/pdf 与 `figureRenderer: 'cli'` 走 `dot` 子进程，后者仍是系统依赖——这些路径缺失时 fail loud 并给出安装引导。该 WASM 渲染是同步调用、一旦开始无法中断，故输入规模受限：原始 DOT 超过 64 000 个字符（分层/树形引擎 `dot`/`circo`/`twopi`）或 20 000 个字符（强制导向引擎 `neato`/`fdp`/`sfdp`）同样改走 `dot` 子进程，结构化图元素上限 200 个（节点 + 边，嵌套节点计入）——超出即 `invalid_tool_input`，请拆分为 `panels`。`raw_dot` 必须自包含：`image`/`shapefile`/`fontpath` 等文件引用属性被拒绝，因为子进程路径会按宿主文件系统解析它们。引线标号对框图/层级图 SVG 默认开启（流程图与 `raw_dot`/`template` 默认关闭；per-call `leader_lines` 覆盖）：标号置于部件外侧并以 `<line>` 引线相连，替代内嵌标签后缀；非 SVG 格式保持内嵌标号并返回警告。放置时按所在组的平移把节点坐标换算到根坐标系，跳过会压盖已绘边线、箭头或边标签的方向，并在标号或引线越出根元素声明画布时扩展 `viewBox`/`width`/`height`——画布之外的 SVG 内容不会渲染。节点位于缩放/旋转/翻转的组内时无法这样定位：其标号内嵌进部件名并给出警告。每次生成后按《专利法实施细则》第二十一条与《专利审查指南》第一部分第一章 4.3 返回图面用语检查警告：非必需注释（注释前缀、正文引用、尺寸标注、比例标注、句末标点）、非中文词语（缩写与数字符号除外）、图号入图、数字与括号引号连用、非阿拉伯数字标号；检查只提示、不改写输入。矢量图型（`circuit`/`plot`/`cross_section`/`sequence_diagram`/`appearance_view`）不过 Graphviz，由 `vector-figure-build` 直接产出毫米坐标的 SVG 片段：电路图按网格放置符号并正交走线、T 形结点画实心连接点；曲线图画坐标轴与刻度并在图上禁用比例说明；剖视图画 45° 剖面线（相邻件方向相反或间距不等）与剖切位置符号——零件不写 `hatch` 就静默取默认 45°/3 毫米，故工具会逐图报出该默认值，非剖切实体应写 `hatch: "none"` 而不是用细长多边形伪造，标号、引线与中心线分别用 `sections.labels`、`sections.centerlines` 表达；时序图画生命线与消息箭线；外观设计视图按第一角（或第三角）排布六面视图、统一比例并在每个视图正下方标注视图名称。`panels` 渲染多面板组合（`fig1A`/`fig1B`，…）并共用同一标号系列；面板后缀必须互不重复，且 `panels` 不能与顶层结构/矢量输入同时提供（两者均报错，不再覆盖同一文件或静默丢弃图形）；外观设计视图片段只允许几何内容——script、style、foreignObject/iframe/object/embed、动画、事件处理属性、`javascript:` URL 与 ENTITY/CDATA 在落版前即被拒绝；per-call `figure_family` 对附图索引中同一家族记录的组件跨代续接标号——未声明家族即逐图独立编号，索引中无 `figureFamily` 的条目永不参与。`semantic` 彩色填充仅当色彩承载技术内容时使用（依据《专利审查指南》第一部分第一章 4.3，2023 修订；默认 `grayscale` 黑白）；`raw_dot`/`template` 模式无结构化组件/连接还原（索引条目残缺）。每张交付 SVG 都在落版之后、文字转路径之前复核，纯 SVG 输出同样在内（此前只有 png/pdf 的 SVG 全链与矢量直绘会复核）；净距按图型分档（`RENDER_CLEARANCE_MM`）：剖视图、结构线稿与内嵌标号的 Graphviz 图为 1.5 毫米，引线标号/原始 DOT 图为 0.5 毫米，电路图/曲线图/时序图为 0.7/0.9/0.7 毫米，外观设计视图片段暂不判。同一 `<g class="node|edge">` 分组内的文字与线段——节点标签在其节点框内、边标签挨着自己的边——不参与净距与贯穿判定：那是排版，不是跨元素压线。
- **附图提交规格与落版** — `figure/office-profile` 固化了已核实的目标法域数值：中国 A4 与 25/25/15/15 毫米页边距、图号「图N」（两幅以上才编号，依据指南第一部分第一章 4.3）、附图页码「第N页 共M页」（单页「第N页」）；PCT 的可用绘图区与 0.32 厘米最短字高（Rule 11.6(c)、11.13(h)）、图号「Fig. N」、不得着色（11.13(a)）、页码「1/3」；USPTO 的页边距与最短字高（37 CFR 1.84(g)、1.84(p)(3)）、图号「FIG. N」。给定 `target_office` 时 `figure/submission-page` 把图形落版为固定幅面的附图页（图号画在图形正下方、页码画在版心底部），`figure/compliance` 再核对彩色策略（PCT 直接拒绝彩色；美国实用申请彩色需呈请）、多幅图未编号与落版字高，并返回落版缩放比与尺寸。落版经 SVG 全链到达 png/pdf：Graphviz 的 `page`/`size`/`margin` 属性只影响图形自身画布（本机实测 Graphviz 15.1.1：`page` 对 svg/png/pdf 不产生幅面，`size` 只在超限时按比例缩小，`margin` 只加空白），因此给了 `target_office` 的 png/pdf 调用先出 SVG、落版、复核，再用 Inkscape 导出；没有 Inkscape 时退回渲染器直接出图，并报告落版与复核未生效。未给 `target_office` 的 png/pdf 调用行为不变。EPO 未列入档案：EPC Rule 46/47 与 EPO 审查指南的一手文本在本次核实时无法取得（epo.org 返回 403）。「缩小到三分之二仍可辨」只报出缩小后的实测字高、不设阈值告警，因为三个法域都没有给出该情形下的数值下限。
- **两步分析降级** — `figureAnalysisMode: 'two-step'` 下，结构抽取趟不可解析时按空组件返回尽力结果并附警告，跳过说明生成趟；图片门禁与结果形状与 `single` 一致。
- **结构线稿范围** — `generate_structure_figure` 需要宿主安装 FreeCAD 1.1+（`freecadcmd`），且在 `structureFigureEnabled: true` 前保持关闭；门禁未开启或可执行文件缺失时以 `setup_required` 显式报错并给出安装引导，绝不静默降级为示意图。每个请求视图建单个 `TechDraw::DrawViewPart`（不用 `DrawProjGroup.addProjection`，后者在 FreeCAD 1.1 报 TypeError），经 `TechDraw.viewPartAsSvg` 取几何片段——片段不含模板边框、标题栏或图号，符合《专利审查指南》第一部分第一章 4.3 对线条的要求；两幅以上附图的「图N」由 `target_office` 落版阶段写在图形正下方（该条要求编号标注在相应附图的正下方）。再包成独立黑描边 SVG。件号在 Python 脚本内经 `DrawViewPart.projectPoint` 锚定，与片段共享同一坐标帧，并沿外向偏移绘制引线。子进程的 HOME/临时/缓存目录重定向到输出目录内（尽力而为；macOS 下 FreeCAD 缓存路径不随 HOME 迁移）；脚本把文档 `TransientDir` 锚定到输出目录下的子目录，因为 TechDraw 以该属性为基准拷贝页面模板——拒绝写 FreeCAD 缓存目录的沙箱会让它保持为空、把该拷贝解析到 `/`，从而让整次渲染失败；子进程的临时目录变量（`TMPDIR`/`TEMP`/`TMP`）必须指向已存在的目录：指向不存在的路径时 `freecadcmd` 1.1.3 在运行任何脚本之前 SIGSEGV，stdout 与 stderr 全空、没有退出码，故渲染器在 spawn 前先建好输出目录内的该目录——出现「无产物、无诊断」的失败先查它；`HOME` 与 `XDG_CACHE_HOME` 指向不存在路径只多出缓存告警（实测）。成功判定只看退出码加 manifest 存在，因为 `freecadcmd` 对偏好/缓存写失败仅告警、非致命。输出 SVG 经与 Graphviz 路径同一的 `assertSafeSvg` 门禁，结果以 `figureType: 'structure'` 写入附图索引；给定 `target_office` 时每个视图 SVG 落版到该法域的 A4 幅面并返回落版尺寸，未给 `caption` 时不落图号——一个模型的多个视图最终如何编号由调用方按整案附图顺序决定。目录 `model_path` 对每个受支持模型出一图（排序、图号递增），但与 `callouts` 同用会被 `invalid_tool_input` 拒绝，因为件号 3D 锚点是模型专属的。改用 `model_paths` 则把多个模型文件投影成一张图——每个文件一个 `Part::Feature`，一起挂到同一视图的 `Source` 上，零件之间的遮挡由 TechDraw 在一次消隐里统一处理——装配图由此而来；此时每个件号都必须用 `callouts[].model`（`model_paths` 的 0 起下标）写明所属零件，脚本按该零件的真实几何核对锚点，锚点偏离该零件超过 0.5 毫米即在任何投影之前报错；`scale` 必须是正有限数、`figure_number` 必须是正整数，二者在渲染前校验。`details` 提供局部放大：每一项给出基视图、**模型坐标**下的窗口（`center` `[x,y,z]`、`radius_mm`）与放大倍数，脚本据此在该基视图上建一个 `TechDraw::DrawViewDetail`，裁剪成圆窗口与放大都交给 TechDraw（实测：细节片段的坐标随 `DrawViewDetail.Scale` 放大，而 `DrawViewPart` 的片段保持模型毫米不变；TechDraw 画出的边界圆比裁剪圆宽 1%，画布按这个余量取）。窗口圆心取基视图的 `projectPoint(圆心) − C`，`C` 是投影紧致几何中心、也是件号锚点用的同一个值——传 `projectPoint` 原始值会把窗口挪到别处。基视图上的窗口圆与 `reference` 标号由脚本自己画，因为 `ShowHighlight` 只进 GUI 页面：基视图的 `viewPartAsSvg` 在细节视图存在前后逐字节相同。`base` 必须是 `views` 之一，`radius_mm` 与 `scale` 必须正有限，目录 `model_path` 拒绝 `details` 的理由与拒绝 `callouts` 相同（窗口是模型专属坐标）。每个视图 SVG 都在落版之后、文字转路径之前复核；件号引线现在止于数字占位框外缘（与复核侧同一组字宽比例），并带 `data-dsh-role="leader"`，不再穿过自己的标号。尺寸标注与 DXF 出口仍未实现。
- **CAD 剖切来源范围** — `sections.source` 用剖切平面从 CAD 模型切出剖视图，取代手写坐标；它复用结构线稿那条 FreeCAD 通道（Config.freecadExecutable / freecadRenderTimeoutMs），但不另设门禁：本字段本身就是开关，宿主没有 `subprocess` 服务或没有 `freecadcmd` 时以 `setup_required` 显式报错，不静默降级为示意图。剖切出的每个材料区域对应一个 `parts` 项，用落在该区域内的 `anchor` 点认领，并把区域清单（个数、净面积、图面范围）作为警告返回以便放置标号：区域顺序是 OCCT 的边输出顺序，按序号对会把标号或剖面线分组挂到别的区域上，而数量不符、锚点不在任何材料内、锚点落在孔里、两个零件认领同一区域都报 `invalid_tool_input`。剖面线由 `TechDraw.makeGeomHatch` 在视图帧生成、按比例缩放后的轮廓原样喂入，故孔边被精确裁在画出来的位置——`figure/section-diagram` 的逐多边形裁剪做不到这件事，带孔的零件在调用方不提供裁好的 `hatchSegments` 时会被拒绝。这条通路受四条实测的 `makeGeomHatch` 约束支配：面必须落在 z=0 的 XY 平面（平移或绕 x 倾斜的面返回 0 条边的空 `Compound`，不是 `None`）；必须在视图帧生成剖面线，因为在模型帧生成会在图面上镜像角度；必须显式传 `patFile`，因为 `makeGeomHatch(face, scale)` 会 SIGSEGV（退出码 139）并把块缓冲的 stdout 全部丢掉；图案名不在 `.pat` 里或 `.pat` 不可读都返回 `None`、不抛异常——脚本把这四种结局一律变成硬失败，而不是交出一张「有轮廓、没剖面线」的图。`.pat` 以 `delta = 1` 写出，故 `patScale` 逐值等于毫米间距（0.25/0.5/1/2/3.5/10 毫米实测）、`.pat` 角就是图面角。`source.scale` 在打剖面线之前乘到切出的坐标上，故 `parts[].hatch.spacing_mm` 始终是图面毫米间距，而 `labels`/`centerlines`/`cutting_marks` 必须用同一比例下的坐标。给了 `part_size_mm` 就与模型包围盒比对（顺序无关、相对偏差 0.1 %），不符即拒绝：STEP 在文件头声明单位，IGES/BREP 没有单位声明，单位读错会让整张图比例全错——不给该声明则无从核对。
- **留档门禁按会话而非按轮计** — 专利 preset 的交付前置门禁要求先成功调用 `matter_log_append`，才允许 `render_patent_document` 或 `build_patent_filing`；其台账按 agent 记录本会话内成功返回、未声明 `blocked: true` 且未被下游 post-execute 拦截的工具名，因此一条留档条目即满足本会话后续所有被门禁的交付：下限是「本会话在出件前留过档」，不是「每次渲染各有条目」。按轮计数需要把台账改成按回合作用域，那同时会收紧 `rule_check` / `law_verify` 两条前置条件。
- **知识笔记 / PDF 下载接线** — `knowledge_note_save` 将笔记写入 Config.noteDir 下的文件（knowledge.db 原生写 API 延后）；`patent_pdf_download` 在每次调用时对延迟绑定的 `ctx.get('patentData')` lookup 解析批量运行器（`createDownloadChannelRunner`）：中国公开(公告)号先走 CNIPR 通道（`ctx.patentData.createCniprChannel()`，部署把 `cniprEnabled` 留关时为空）取全文直链，该通道服务不了的号写进 `warnings` 并交给 Google Patents 腿；服务在场走统一 ego 栈（经 `ctx.patentData.createEgoSession()`），服务缺席或浏览器不可用则退回抓取每页 CDN 链接的无浏览器通道，由工具自身的 fetch 兜底按带界重试/退避（超时、重试、Retry-After）下载。`patent_legal_status` 经同一延迟绑定 lookup 按调用读取该服务，并把无答案的号经 CNIPR 重查一次；`patent_metadata` 用同一 lookup，把引擎答不出的中国公开(公告)号经 CNIPR 重查一次。lookup 之所以按调用，是因为 `patent-data` 声明 `inject: ['subprocess']`，其激活晚于本包的 apply；见 [服务解析决策记录](../../../.agents/notes/implemented/bug-fix/2026-09-21-patent-pdf-download-resolves-service-per-call.zh.md)。browseros-neo、playwright 与 browser-use 参与探测但从不参与下载。
- **检索质量不由 `patent_eval` 评分** — 它的 `retrieval` 模式只数检索式里的词条（三词条及以上记 1.0，一至两个记 0.5），维度名是 `关键词条数`，全程不读结果列表，因此该分数描述的是检索式的形态，而不是检索把正确文献排到了第几条。结果排序改由 `rankOfFirstRelevant`、`meanReciprocalRank` 与 `ndcgAtK`（`src/eval/ir-metrics.ts`）度量，对照的语料、相关性判读与 BM25 基线记录都在 `tests/fixtures/retrieval-corpus/`。语料与基线都是仓内自撰的小规模资产：这些数值用来定位当前基线与拦住指标代码的回归，不代表普遍意义上的检索质量——没有使用第三方数据集，这里也没有任何东西是按大规模人工相关性判读标定的。
- **移除语义召回** — `patent_case_search` 仅保留 FTS/LIKE；基于 embedding 的语义召回未移植（dsh 暂无向量基建）。
- **证据规则资产** — `evaluate_evidence` 经 `@deepseek-ai/dsh-patent-rule` 的资产定位解析 `evidence-rules.yaml`；缺失时引擎降级为默认权重。
- **TRIZ 分析属发明人侧且有意的窄** — `triz_contradiction_analysis` 一次只读一篇交底书：不构建问题依赖图、不度量幻觉率、不做跨文档合并。它给出的矛盾是工程参数之间的设计层取舍，因此绝不进入审查意见答复或无效论证——三步法第二步的技术问题表述仍归 `checkAtomic` 与创造性子图。证据无法在交底书原文定位的矛盾被丢弃并计数，而不是照报；矩阵中没有推荐原理的格报成空缺，而不是从相邻格补一个。

- **`claim_lint` 读的是权项形式而非实质** — 引用基础规则把「所述」之后的术语按虚词截断并封顶 8 字；中文没有形态学边界，因此整体未被引入的复合词（如已有「转子铁芯」时的「所述转子铁芯外圆」）报 warning 而非 error。用语规则（功能性/效果性限定、方法特征、非技术内容、商业性用语、引用说明书或附图）是词表匹配：命中意味着该处需要人工判读，不等于权项有缺陷。本工具不做权项与说明书的支持性比对（那是 `validate_specification` 的特征覆盖检查），也不评判可专利性。
- **违规定位只覆盖字面命中** — `rule_check` 与 `validate_specification` 对**计入本次违规的最早一处命中**回报 `line` 与 `matchedSentence`，使告警可以在原处判读，不必通读全文。开启否定语境或引文豁免的词表检查（`negationContext`、`quoteImmune`）取的是豁免之后剩下最早的那一处，不是该词在文本中的最早出现。缺项类与比例类检查（章节缺失、覆盖率、数值范围端点）、`quote_repetition`（证据带重复次数，不是原文中的连续片段），以及读取独立入参字段的检查（发明名称、摘要、权利要求）不带这两项：那里指向说明书的行号没有对应位置。

- **带 block 级违规的 `rule_check` 不是交付证据** — 任一违规的 `action` 为 `block` 时，结果带 `blocked: true`；patent-rule 的交付台账会忽略声明该标志的前置结果。自检发现硬拦截后必须修订并重跑；只有 `review` 命中的自检仍算数，因为交付时的输出门禁会对渲染件请求审批。`blocked` 覆盖自检自身的结论，尚未证明被检文本与交付件一致。
- **空白文本是输入错误** — `rule_check` 对空串或纯空白的 `text` 以 `invalid_tool_input` 拒绝，零字节调用不会留下成功的前置记录。`patent` 预置还要求结果的 `evaluated` 列表非空，才允许交付渲染或成文，从而保留本次运行实际读过的文本身份。

- **结果携带「评估了什么」的身份** — `rule_check` 与 `validate_specification` 的文本是内联传入的，两个调用方核对「同一份文件」时可能各传一个修订本。实案实测：三个队友重跑同一道门禁分别传了 12164、12166、12177 字符，**没有一个等于磁盘上的 13399 字符**，而结论差异正好落在文本差异处。因此每条结果末尾带一行 `评估输入`，给出本次读到的各文本字段的字数与指纹，使两次运行可直接比对。该行只**报告**差异：目前没有任何东西强制一次运行必须与磁盘产物一致，交付门禁只核对至少评估过一段文本，不把指纹与渲染入参比对。

- **说明书检查区分形式缺陷与实体结论** — `validate_specification` 用 `not_assessed` 列出确定性规则不能判断的事项（A26.4 概括范围、附图清晰度与比例、照片适用性、缺附图分析、缺摘要附图号），`passed` 只表示已运行的规则未发现 error。`spec-check` 写出分项判定（`spec_form_check_passed`、`spec_claims_check_passed`、`spec_figure_check_passed`、`spec_prohibitions_check_passed`）与 `spec_not_assessed`；`legal-gaps` 把形式与权项判定映射到对应法条，充分公开只有在 `enablement_report` 与其 `enablement_passed` 判定同时存在时才可能通过，只有报告不算通过。因此占位草案、引用权利要求、商业宣传语、实用新型无附图、图号断号都会阻断默认工作流，而不是放行。
- **`adversary-review` 是确定性启发式门，不是模型审查** — 读取 `draft_tightened`/`draft`、`claims`、`office_action` 与 `reference_documents`（该键为空时回落到 `oa-parse` 的 citations）。证据缺口按缺口种类与通知书驳回类型归因法条，不再一律写成 A22.3；关键词未命中使用更低的启发式置信度。产出 `adversary_review_passed`（仅论证强度为 `insufficient` 时为 false），`oa-response` 的 `legal-gaps` 清单把它记为 severity `warn`，运行仍可交付，但汇总里看得见该缺口。
- **后续检查覆盖形式规则看不到的交付物缺口** —— 摘要附图从请求书字段（`abstract_figure_number`）读取，绝不从摘要正文里推断；`draft_specification` 直接生成不超过 300 字、含关键词行的确定性摘要，默认工作流无需另调摘要阶段即可交给 `spec-check`。背景技术引证（国别、公开号、公开日）、有益效果与现有技术对比、序列表引用、正文图片与表格位置、术语与附图标记一致性、实用新型附图内容均以 warning 报出。`verify_patent_figure` 传 `delivery_review=true` 时，另查位图/照片（`<image>`）、整幅框线、横向摆放与非必需图面词语。
- **说明书体例校验依赖 markdown 文本能表达的形态** — 必要章节按专利类型与有无附图计算：无附图发明只需四部分，实用新型必须有附图说明，写了附图说明却无图号报 error。标题集合校验放行必要部分标题与 `render_patent_document` 写出的 `说明书` 外层标题，其余标题一律报出，因此模板外层标题不同的部署会看到该标题被报出；括号标记校验读 `名称（数字）` 与 `名称(数字)`，并跳过以列举后缀结尾的名称（`实施例（1）`、`图（2）`），因此恰好在标记某构件的列举式引用不会被报出。段落编号是 warning 而非 error：法条与《专利审查指南》均未要求或禁止段落编号，是否使用取决于提交体例。

- **`patent_workflow_run` 的后台运行** — `run_in_background: true` 把 manifest 运行注册进 `ctx.jobs`（`@deepseek-ai/dsh-jobs` 加 `@deepseek-ai/dsh-tool-jobs`）并立即返回 job id；结算后的 job 携带与前台调用完全相同的那段渲染文本，经 `job_output` 收集。本会话未启用后台任务时该开关 fail loud（`setup_required`），不会静默阻塞当前回合；graph 路径上传入该开关按 `invalid_tool_input` 拒绝。带 caseId 的运行按「案卷 + manifest」写定一份产物路径，因此同一对已有一个在跑的后台运行时，第二次按 `file_conflict` 拒绝，而不是让两者互相覆盖对方的记录；不带 caseId 的运行不写产物，不受此约束。每推进一个阶段就更新 job 的进度行（`3/10 extraction`），运行期间由 `job_list` 显示。job 持有自己的中止信号，因为这次运行比启动它的调用活得久：`job_kill` 或 owner teardown 才是取消它的方式，而中止在阶段边界生效（进行中的模型调用不会被中断）。

### 开发备注

无。

本包不发布 invariant 伴生组件：专利工具除常规 tools/result 日志外不写入包属持久会话事件；workflow-run 与 plantask 事件归 dsh-patent-workflow 所有。
