# 专利模式 preset

[English](patent.md) | 中文

`patent` agent preset 在 DeepSeek Harness 上组合一个面向中国专利作业的 Agent。本 bundle 在 `presets/patent.patch.yml` 中声明它，其 16 个技能随附在 `skills/patent/` 下。它以 `standard` preset 为基础，加入专利域插件以及专利专用的人设与计划模式纪律，按 docs/patent-mode-design.md §4–§9 与 docs/sati-as-dsh-plugins-plan.md 的 P4.4 组装。法条/审查指南/判例核验优先走本机 cnlaw REST 法律底座（semantica-cnlaw，见「前置条件」），保留 source_path 溯源，不可用时回退 patent_case_search / patent_kg_query。引用形式先经 `@deepseek-ai/dsh-patent-law` 随包的法规索引核验：法律引用对照随包转录的条文判定，条文未转录的条目报「未核验」，不会被当成已核验；官费与年费金额由 `@deepseek-ai/dsh-patent-fees` 按随包金额计价，仅在某适用项没有金额时才不给出合计。

## 挂载内容

除专利作业所需的标准编码行（shell、文件、jobs、提醒、skills、goals 与 `/goal` 命令、计划模式、压缩、委托、web，以及告诉模型今天日期的时钟行）外，本 preset 另挂载 14 个插件——专利域的服务与工具，以及专利技能会调用的文献与方法学两行（装配清单见 `presets/patent.patch.yml`）：

- `@deepseek-ai/dsh-patent-data` — 数据接缝（ctx.patentData：nuo 检索 provider 工厂 + ego-browser 会话运行器 + CNIPR 通道；本 preset 经 `cniprEnabled` 打开该通道，用 ego lite 在 search.cnipr.com 的登录态取中国专利全文与法律状态）。patent_pdf_download 经该服务运行其 ego-browser 下载适配器，中国公开(公告)号走 CNIPR 通道；patent_legal_status 把引擎答不出的号经该通道重查一次。
- `@deepseek-ai/dsh-patent-knowledge` — knowledge.db 查询服务（ctx.patentKnowledge：caseLawSearch / legalSearch / wikiCards / kgSearch / kgGetNode / kgListByType / ipcClassify）。
- `@deepseek-ai/dsh-patent-workflow` — 执行管线服务（ctx.patentWorkflow：runWorkflow / runPlantask / approve / reject）。
- `@deepseek-ai/dsh-patent-tools` — 37 个模型工具：检索、元数据、法律状态、判例/wiki/图谱查询、法条原文检索、权利要求对照表、审查意见解析、TRIZ 矛盾分析、撰写、说明书校验、分析报告、证据判断、规则检查、领域缺陷清单检查、附图分析与生成、跨图一致性校验、图文比对、化学结构识别、PDF 下载、知识笔记、案卷留档、工作台案件关联，以及工作流/计划状态机（权威清单见 `docs/tool-catalog.md`）。
- `@deepseek-ai/dsh-patent-teams` — 持久多智能体团队服务（ctx.patentTeams），提供十二个 `patent_teams_*` 工具；`qualityGate: true` 时运行组合完成门禁，`approveCreation` / `approveClosure` 打开时把团队的两个案件级决定——建队与收口——交给本部署的 `approval` 服务判定，未获放行时直接拒绝该调用（结果名 `rejected` / `cancelled` / `unavailable`），不会创建或关闭用户未允许的团队。
- `@deepseek-ai/dsh-patent-rule` — 规则引擎、tools/post-execute 输出门禁、声明式结构门禁与交付前置门禁、EVI-011 证据守卫。
- `@deepseek-ai/dsh-patent-document` — render_patent_document。
- `@deepseek-ai/dsh-patent-filing` — build_patent_filing / verify_patent_filing：把一个 CNIPA 申请文件（摘要、摘要附图、权利要求书、说明书、说明书附图）装配成 DOCX，其排版由随包模板反推，并逐项核对成品与该模板一致。
- `@deepseek-ai/dsh-patent-deadline` — patent_deadlines：案件的法定与指定期限，含专利法实施细则的期限与送达规则，以及随包节假日日历用于届满日顺延。
- `@deepseek-ai/dsh-patent-fees` — patent_fees：逐项按本包随包的费用索引为案件计价（申请、实审、授权、年费与各项程序费用），按各费种的计数基准计数量——每件、超过免费基数的每项权利要求、每页、每项优先权要求、每个专利年度、每请求月数——并在索引登记了减缴时按案件适用的减缴计算。金额已按官方收费标准随包转录，因此工具会给出合计；只有适用项没有金额时才扣住合计——随包索引里这仍是说明书附加费与延长期限请求费两项，因为它们按条目模型承载不了的分档收费。
- `@deepseek-ai/dsh-patent-law` — law_verify：逐条把法条引用对照本包随包的法规索引判定（《专利法》《专利法实施细则》按条，《专利审查指南》按归一化节路径），并把已索引但未转录的条目报「未核验」而不是放行。两部法律（法规）的条文已随包转录——每个条目带着所引条文的文本、抄录的文书与版本、以及抄录日期——条数上限也已核验，因此编造的条号判「条号超出有效范围」、索引未覆盖的有效条号判「索引中不存在」，两者都不是通过。指南的 64 条节级条目已随包转录 2023 年修订版正文，引用会判成「已核验」「与所引命题不符」或「未判定」；只登记到部分、章或节一级、其下各节又都没转录的条目仍报「未核验」。引用必须经官方来源核验的纪律没有变，只是未核验的条目不再可能被读成已核验。
- `@deepseek-ai/dsh-writing-patterns` — 基于随包撰写/答复模式语料的 query_writing_patterns，以及承载编译后 `<writing_skills>` 块的系统提示段；该 section 只注入权利要求撰写、说明书撰写与三个审查意见类目，其余类目仍可经工具检索（工具始终检索整个模式库）。
- `@deepseek-ai/dsh-tool-literature` — paper_search / paper_list_sources。
- `@deepseek-ai/dsh-methodology` — `triz` 矛盾矩阵查表工具，用于已明确给出改善/恶化参数编号的场景。从交底书识别矛盾与参数缺口仍由 `triz_contradiction_analysis` 负责。

相对 `standard` 携带的行集，本 preset 有意省略三行——`tool-plugin-market`、`present` 与 `tool-plugin-manager`。三者都属部署面或 UI 面，不是办案的一步：交付物由 `render_patent_document` / `build_patent_filing` 声明，交付前置门禁把它们扣在规则检查、法条核验与本轮留档（`matter_log_append`）上，另开一条声明通道就会落在那道门禁之外。门禁同时核对前置结果：`rule_check` 必须报告它实际读过的文本，引用型交付件必须来自一次识别到引用的 `law_verify`，分析类收口必须由模板对应的 manifest 成功运行。`scripts/preset-mode-baseline.json` 逐条记下理由，并把每个交付型模式扣在同一份共享行集上。

专利服务放在 isolate 领域（patentData / patentKnowledge / patentWorkflow / patentTeams）内，与 patent-tools 共享该领域，使后者的 ctx.get('patentData') / ctx.get('patentKnowledge') 解析到本 preset 的实例而非宿主实例。省略 tool-ralph（一个案子用 goal / todo / workflow，而非 fresh-agent 迭代）；tool-web 开启 fetch，因为所有发货组合都挂载 http fetch provider（`dsh-base` 以 `fetchProvider: http` 组合 `dsh-web-fetch-http`，且没有任何 bundle 禁用它），先验证后引用因此可以打开来源页核验，而不是只信摘要。

本 preset 还挂载 `@deepseek-ai/dsh-self-evolve-benchmark`，放在独立的 isolate 领域（selfEvolveBenchmark）内：benchmark 驱动的自进化 provider，仅编程接口——无模型工具。其 `agentStateDir` 指向数据根下播种的 `patent-state` 工作副本（包内 examples/patent-oas），绝不指向调用方工作目录，真实案卷或知识库永远不会被优化循环打快照或改写。

## 技能

本 preset 的 16 个技能随附在 `skills/patent/` 下：

- patent-disclosure-understanding
- patent-prior-art-search
- patent-novelty-inventiveness
- patent-infringement
- patent-invalidity
- patent-invalidation-defense
- patent-oa-response
- patent-reexamination
- patent-quality-gate
- patent-workspace-layout
- patent-team-composition
- inventive-step-analysis
- patent-matter
- patent-fact-check
- patent-compliance-review
- patent-document-polish

`patent-team-composition` 是持久团队组建模板，且团队流程是可选路径：人设的作业模式路由把单会话意图驱动设为默认，只有用户在该轮明确要求组队时才允许建队，因此案件复杂本身不构成建队理由。获得该指示后，本会话已挂载 dsh-patent-teams 插件（patent_teams_* 工具），案件按覆盖专利全生命周期的七个场景角色包选择——立案包（案件管理员 / 检索员 / 技术专家 / 撰写员 / 文档专员）、撰写包（检索员 / 撰写员 / 对立审查员 / 技术专家 / 申请人代理 / 制图员 / 文档专员）、答复审查意见包（同撰写七角色）、补正包（撰写员 / 形式审查员 / 制图员 / 文档专员）、复审包（检索员 / 撰写员 / 对立审查员 / 申请人代理 / 制图员 / 合议组 / 文档专员）、无效宣告包（检索员 / 撰写员 / 技术专家 / 无效请求人 / 专利权人 / 合议组 / 文档专员）、侵权诉讼包（检索员 / 撰写员 / 技术专家 / 专利权人 / 被告代理人 / 裁判 / 文档专员，另可选技术调查官），由当前会话任 captain 统一调度；制图员（`illustrator`）负责附图与附图标记表（细则第二十一条第二款图文双向一致的唯一标记源），文档专员（`document-specialist`）负责收口前的正式文档输出（场景→模板映射、矫正、美化），两者均不改实体结论；仅当插件被禁用时回退单会话 + subagent_fork 专家互评。撰写包与答复包中，captain 跑完整个 manifest（`patent_disclosure_v1` / `patent_oa_response_v1`）至审批门，成员只读阶段结果：`patent_workflow_run` 没有单阶段入口，成员不得声称执行过 `claim_strategy`、`draft_claims` 或 `tighten` 之类的阶段，返工是重跑 manifest 而不是手写替换稿。复审、无效与诉讼包采用"立场配对 + 中立裁判"的对抗结构。团队是增加人工确认点而不是减少：成员名单与任务 DAG 在 `patent_teams_create` 前与用户确认，每个环节的关键产出在下一任务开始前给用户过目，策略取舍权留给用户，收口与文档渲染由用户放行——captain 不得单方收口；两种模式可在案件进行中互相切换，切换前先向用户交代已完成与未决的部分。建队与收口在这里不是指令而是执行点：该行的 `approveCreation` / `approveClosure` 把 `patent_teams_create` 与 `patent_teams_delete` 交给本部署的 `approval` 服务判定，未获放行的建队或收口在调用处即失败。

`patent-document-polish` 是正式文档输出规范：按场景选择模板（专利性意见/检索报告/OA 答复/权要+说明书/补正书/复审请求书/无效意见/侵权比对意见/诉讼文书），矫正（术语一致性、法条引用格式与出处、数字/日期/期限、编号层级、文书称谓）与美化（模板渲染、品牌注入、A4 版式、md 起草 → html/pdf 或 docx），交付放行与质量门禁收口合并为一次确认。

新颖性/创造性、侵权、无效三个技能改写自 Sati 的 patent-novelty-analysis、patent-inventiveness-analysis、patent-infringement-checker、patent-invalidity-checker。Sati 工具引用（patent_kg_query / patent_case_search / law_search）替换为 dsh 专利工具，<memory-context> 自动注入替换为显式必查清单，Sati 内部文件路径替换为工作目录相对路径。侵权、无效、答复审查意见、复审四个技能已改为驱动真实工具面：claim_chart_build 出要素级对照表、parse_office_action 解析通知书、patent_workflow_run 配 patent_infringement_v1 / patent_invalidation_v1 / patent_oa_response_v1 / patent_reexamination_v1 驱动确定性阶段、人工确认门与 run 记录。patent-oa-response 与 patent-reexamination 属本仓新增技能，非移植。

## 知识库策略

按计划 P4.4，系统知识读 dsh-patent-knowledge：判例、wiki 卡片与知识图谱经 patent_case_search / patent_wiki_search / patent_kg_query 查询，随包的法条与指南原文经 law_search（选择法规或指南集合并返回对应条文/节文本及其来源）查询。法条原文优先经本部署声明的 cnlaw 底座（见「前置条件」；端点即 `patent-law` 的 Config 字段）核验并保留 source_path 溯源，部署声明无底座时经 patent_case_search 加 web_fetch 核验权威来源。两条通道之前先跑 `law_verify`：它固定引用形式并说明随包索引收录与不收录什么，因此索引支撑不了的引用会被查证而不是凭记忆引用。工作目录 `99-知识库/` 仍作为项目级沉淀，用 fs-search / grep 先查本地再上网。

这修订了 docs/patent-mode-design.md §9（原为无引擎文件库）。`99-知识库/` 仍作项目沉淀；变化在于系统知识现在有了引擎。

## 前置条件

知识工具需要 knowledge.db。用 patent-knowledge-install bin 安装，或将 Config.sourceDbPath 指向已有 knowledge.db；见 packages/patent/patent-knowledge/README.md。缺库时知识工具在执行期 fail-loud。

cnlaw 法律底座是可选的部署声明，不由随包 preset 决定：部署跑起 semantica-cnlaw 服务并设置 `patent-law` 的 Config——`cnlawEnabled`（默认 `true`）、`cnlawSearchUrl`（默认 `http://127.0.0.1:8100`）、`cnlawGraphUrl`（默认 `http://127.0.0.1:8001`）。插件把这三个值渲染成一段系统提示，人设与技能因此引用「声明段给出的端点」而不是端口字面量；Neo4j（默认 7687）是该底座自己的存储，模型不会直接访问。声明有底座时，法条/审查指南/判例核验走 cnlaw 并保留 source_path 溯源；`cnlawEnabled=false` 时声明段写明本部署没有底座，纪律退回 patent_case_search / patent_kg_query 加 web_fetch。部署另外挂载 cnlaw 的 MCP 桥（`@deepseek-ai/dsh-mcp-client` 起 `cnlaw_mcp_launcher.py`）时，图谱/案件/创造性三步法端点以 `mcp__cnlaw__*` 工具形态可用，persona 优先指名它们；语义检索端点与 IPC 路由没有对应工具，仍按声明段给出的端点走 REST（curl）。

三个检索技能属用户级资产，由部署放在 `~/.agents/skills/` 下，不随本包发货：`cnipr-search-download`（CNIPR 全文与法律状态）、`cnipa-query`（官方法律状态事务）、`google-patents-search`（外国/全球检索）。preset 的检索例程把它们列为 CN、官方状态与外国通道的首选；其中任一项缺席时退回随包通道——本地 nuo 引擎的 `patent_search` / `patent_metadata` / `patent_legal_status`、`web_search` / `web_fetch`、原文 PDF 用 `patent_pdf_download`——并在检索报告里写明实际用到的通道。

OpenViking 长期记忆为另一个可选挂载：本 preset 随附一行 `openviking`，默认 `disabled: true`。运行 OpenViking 服务的部署（参见 [`@deepseek-ai/dsh-openviking`](../../../memory/openviking/README.zh.md)）复制本 preset、去掉 `disabled`，再通过 `dsh plugin --profile <name> config openviking.endpoint=…` 以及 `.account` / `.user` / `.agentId` / `.apiKey` 写入端点与身份 header；发货 preset 不携带凭据。召回文本以不可信背景数据的形式进入提示，persona 的先验证后引用纪律仍要求每个法条断言带 cnlaw 或 patent_case_search 的 source_path——OpenViking 不替代法律底座。

## Model Experience

模型看到：中文专利代理人设（专业身份、九条作业纪律、默认单会话意图驱动、仅在用户明确指示时才启用团队流程的作业模式路由、标准作业流程、案型路由表、带强制免责声明的输出纪律）、专利计划模式段落、`patent-law` 按本部署 Config 渲染的 cnlaw 声明段（端点，或本部署没有底座的声明）、15 个预设内技能，以及专利工具（含 `law_verify`，其描述写明未核验的条文永不报成已核验；含 `patent_fees`，按随包金额计价案件应缴的费种，仅在某适用项没有金额时才拒绝给出合计）加标准编码工具。人设只承载身份、九条纪律、作业模式与案型路由；通道调用式、检索式与引用格式都在路由行点名的技能里，只有案子真的载入该技能时才付这部分成本，且 `scripts/preset-mode-baseline.json` 给人设正文设了上限，增长必须是一次有意的改动。人设要求先验证后引用（每个事实用 web_fetch 打开原文）、单独对比、逐特征比对附引用，且每份分析输出必含免责声明。

## Known Limitations and Deferred Work

- 法条检索由 `law_search` 承担，它从 knowledge.db 取法规与《专利审查指南》原文（`ctx.patentKnowledge.legalSearch` / `guidelineSearch`）。`law_verify` 覆盖的是引用形式与索引收录，不是法条原文：它判定某条是否在索引内，并在某部署把条目转录之后判定所引命题是否与其相符。法条原文优先经部署声明的 cnlaw 底座核验（可选增强，缺席由声明段写明，见前置条件）——挂载时走 MCP 工具，否则按声明段给出的端点走 REST（curl）；没有底座时经 patent_case_search 加 web_fetch 与 `99-知识库/` 基线核验。发货组合挂载 http fetch provider（只接受公网 HTTP(S) 目的地，逐个解析、校验并固定连接），web_fetch 无需部署改动即可用。
- 随包费用索引只给条目模型表达得了的部分定价：金额取自国家知识产权局缴费服务指南附件 2，逐项记下抄录的文书与抄录日期，减缴比例（个人 85%、企业 70%）也一并记录，价格因专利类型而不同的费种拆成不同条目。仍有两个费种不带金额——说明书附加费与延长期限请求费按分档收费（按页区间、按次数），模型没有承载它的字段——因此碰到其中任一项就不会给出合计。金额是标准的机械抄录，不是复核：没有人回读过副本，开票前应再核对一次。
- 随包法条文本是官方修订文本的机械抄录，不是复核：「已核验」的含义是该条存在、所引命题与该条主题词相符，不含"由具备资质者回读过副本"。覆盖面也是部分的——《专利法》索引 82 条中的 37 条、《专利法实施细则》共 149 条，索引 45 条——因此一条存在但未被索引的条文会报「索引中不存在」，仍须查证原文。《专利审查指南》的节级条目已转录 2023 年修订版正文，但 2026 年版（2026-01-01 施行）已修改本指南，其中落在本索引上的三节在条目里写明是修改前文本。原按 2008 年修正编号 62/69/70 收录的《专利法》主题词，已改到 2020 年文本承载它们的 67/75/77 条；62 条改按 2020 年文本的主题（强制许可使用费）。
- patent_pdf_download 在宿主机有可用 ego-browser（ego lite，仅 macOS，且在 PATH 上）时在浏览器内取回 PDF 响应体（CDP `Network.getResponseBody`）；取不到时退回抓页面 CDN 链接 + HTTP 下载，整批仍能下载。两个通道都失败时按篇报告错误，不中断整批。knowledge_note_save 将笔记写入工作目录 `99-知识库/` 下的文件（knowledge.db 原生写 API 延后）。
- 4 个改写分析技能继承 Sati 方法论，但尚未对照现行中国专利实务复核；依赖前请将其检查清单与用户 patent-legal 基线交叉核验。
- patent-oa-response 与 patent-reexamination 属本仓新增技能，非移植：步骤顺序跟随 patent_oa_response_v1 / patent_reexamination_v1 manifest，期限一律由 patent_deadlines 给出，但两者均未经实务对照现行《专利审查指南》复核。复审技能对实用新型命中的创造性理由按现行口径保留、并把专利权类型单独输出（不静默删除理由）；该口径在工作台计划中仍标注为待确认项。
- patent-invalidation-defense 属本仓新增技能，非移植：它从专利权人（被请求人）侧答复无效宣告请求，期限经 `invalidation-transfer` 通知书由 patent_deadlines 给出（该指定期限依专利法实施细则第 75 条不得延长），交付经 `invalidation-defense` 模板渲染为 100902 意见陈述书与其 100014 附页。与 patent-invalidity 一样尚未对照现行实务复核。它点名的指南节次按随包索引与所引节的转录正文（2023 年修订版）核对；被 2026 年版修改过的节仍须以该版本文本为准。
- 设计文档的 `~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md` 是 Sati 用户级资产，未随附；事实核验与质量门禁技能已不再依赖它——引用形式改由随包索引核验，法条原文在使用时核验。
- 自进化 benchmark 仅编程接口：`ctx.selfEvolveBenchmark` 不挂模型工具；建立基线 / 优化循环由 operator 或脚本解析某 agent 的该服务后驱动。其默认 seams 在宿主 subagents 注册表上 fork 子代理，子代理继承本 preset 的 approval 设置（`'never'`）与计划模式纪律——需审批的操作在子代理中被拒，executor prompt 已显式退出计划语义，可直接产出交付物。