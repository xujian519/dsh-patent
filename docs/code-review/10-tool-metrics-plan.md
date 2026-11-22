# 工具调用指标的 45 天计划

本文件是下一周期的执行计划：验证十项工具调用指标。源码审阅的日程在 [04-daily-plan.md](04-daily-plan.md)，日卡在 [daily/](daily/day-01.md)，本周期不改那些文件。执行记录从开工第一天起写到 `metrics/day-NN.md`。本目录仍只记录审阅，不改业务代码、依赖、CI 或基础设施配置。

每天 1—2 小时，共 45 天。先用专利域 4 个族把记分跑通，再扩到其余 7 个族。通过线在直接调用基线出来之前留空。

## 远程跟踪

- 总跟踪：[#931](https://github.com/xujian519/dsh-patent/issues/931)
- 阶段 issue：[#932](https://github.com/xujian519/dsh-patent/issues/932)（P0，D1–D8）、[#933](https://github.com/xujian519/dsh-patent/issues/933)（P1，D9–D12）、[#934](https://github.com/xujian519/dsh-patent/issues/934)（P2，D13–D22）、[#935](https://github.com/xujian519/dsh-patent/issues/935)（P3，D23–D30）、[#936](https://github.com/xujian519/dsh-patent/issues/936)（P4，D31–D38）、[#937](https://github.com/xujian519/dsh-patent/issues/937)（P5，D39–D42）、[#938](https://github.com/xujian519/dsh-patent/issues/938)（P6，D43–D45）
- 执行记录写到 `metrics/`。阶段 issue 只跟踪该阶段的范围、检查项与验收，不替代 `metrics/day-NN.md`，也不改 `daily/`。

## 测什么

十项指标回答的是：模型面对四域工具时，一次任务有没有选对、填对、做完、在该停时停下，以及时间和费用、日志能否还原、失败后能否做完、有没有留下进程或临时目录。

[08-retrospective.md](08-retrospective.md) 的结论仍是源码审阅的结论：专利域可以做 30 天紧凑版，先看正确性再看精简。那一份不测量下面这十项。本周期把 B 维度的重复实现和过宽导出移出范围，也不重测已经修复的源码条目。

会扭曲指标读数的既有条目留在本周期里一起看：

| 条目 | 读数时怎么用 |
|---|---|
| F-CROSS-004 | `tool/result` 失败时只有文案、没有 `error.code`，该次调用记为不可解释 |
| F-PAT-010 | 截断的模型调用没有落入会话时，费用记为缺口，不记为 0 |
| F-PAT-032 | 判例短查询的整表扫描计入工具执行时间 |
| F-VID-011 | 视频并发结算计入 provider 费用；这笔费用不与 token 费用相加 |

## 三层记录

同一天只跑一层。三层的样本不合进一个百分数。

| 层 | 当天能填写的指标 | 证据 | 与模型采样的关系 |
|---|---|---|---|
| 直接调用 | 参数语法、可解释性、资源是否残留、畸形参数是否 fail-closed | 题库直接调用工具；会话里的 `tool/call` 与 `tool/result` | 不调用模型。可进 CI |
| 脚本场景 | 参数语义、闭环成功率、错误恢复 | 脚本按题面填入参数，断言外部结果；再注入超时、空结果、取消 | 不采样模型。可进 CI |
| 真实模型 | 工具选择准确率、拒绝率与误拒、响应时间、成本效率、上下文利用率 | 冻结的模型与提示词，每题重复跑 | 随模型版本变化。留作周期评测，不作阻塞 CI |

`pnpm run test:snapshot` 回放的是录制当时的模型选择，不计入选择准确率、拒绝率、响应时间、成本效率和上下文利用率。`benchmarks/` 的库函数中位数不计入响应时间。

会话里能直接读到的字段：

- `tool/call.name` 与 `tool/call.arguments`：工具名，以及模型产出的原始参数 JSON 字符串。
- `tool/result.error.code`：失败身份。失败结果没有 `error.code` 时，该次调用记为不可解释。
- 同一步的 `request/header.header.tools`：该次请求交给模型的工具 schema。
- `assistant/message.usage`：`inputTokens`、`outputTokens`；字段存在时另计 `cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`。
- `assistant/attempt` 不带 usage。没有配对 `assistant/message.usage` 的尝试，费用记为缺口，不记为 0。

会话事件类型没有时长字段。响应时间由跑分器记录任务墙钟，并自行打点区分模型等待与工具执行。视频 provider 费用从视频账本读取，不加入 token 费用。

## 指标契约

每次重复各算一条样本。一次任务里的多次调用不摊进任务分母。族的真实模型样本不足 20 时，只记分子和分母，不报百分数。

| 指标 | 记为成功的条件 | 分母 | 同时记录 |
|---|---|---|---|
| 工具选择准确率 | 第一个落在该题「可接受工具」或「禁止工具」里的调用，其名字属于可接受集合 | 真实模型任务数 | 混淆对：选中的名字，以及可接受集合 |
| 参数填充有效性 | 语法：`arguments` 能解析为 JSON，且满足该工具在 `request/header` 中的 schema。语义：题面指定的案号、路径、格式或条号出现在参数中 | 只统计已经选对工具的调用 | schema 通过但案号或路径错误，记为语义无效 |
| 调用闭环成功率 | 外部判定成立，且该次 `tool/call` 都有配对的 `tool/result`，回合正常结束 | 任务数 | `tool/result` 非错误本身不算成功 |
| 拒绝率与鲁棒性 | 拒绝：应拒绝题的轨迹不包含该题禁止的工具，且没有声称完成禁止的交付。鲁棒：直接调用层的畸形参数、路径穿越和注入 fail-closed | 应拒绝题数；对抗样本数 | 误拒：应调用题没有进入可接受集合，并以拒绝结束 |
| 响应时间 | 跑分器墙钟的 p50 与 p95 | 成功任务一份，全部任务一份 | 模型等待与工具执行分开；不与库函数中位数合并 |
| 成本效率 | 成功任务的费用合计除以成功任务数 | 成功任务数 | 失败任务的费用另计为浪费费用 |
| 可解释性 | 每次 `tool/call` 有配对 `tool/result`；失败时有 `error.code`；参数仍是原始 JSON 字符串 | 调用次数 | 只有自然语言错误、没有 `error.code`，记为不可解释 |
| 上下文利用率 | 见下方代理公式 | 闭环成功的真实模型任务 | 与闭环成功率一起读 |
| 错误恢复能力 | 注入第一次失败后外部判定成立，且同名同参数的失败调用没有原样出现第二次 | 注入失败的任务数 | 重试超过 2 次记为未恢复；失败后宣称成功而外部判定不成立，记为假恢复 |
| 资源利用率 | 每件成功任务的外部 provider 调用次数，以及跑分器采样的峰值内存 | 成功任务数 | 任务结束后子进程仍在、临时目录仍在，或视频账本与成功次数不一致：另记缺陷，不平均进利用率 |

费用按跑分器当天写进 `metrics/` 的单价，乘上 `assistant/message.usage` 的 token 数。本文件不写死单价。provider 费用保持独立的一列。

上下文利用率用 schema 体积作代理，不把系统提示正文算进去。`inputTokens` 单独作为体积记录：

`1 −（本任务 tool/call 未使用的工具 schema JSON 字节）/（该次 request/header 全部工具 schema JSON 字节）`

系统提示的 token 已经包含在 `inputTokens` 里，没有单独字段。这个代理升高而闭环成功率下降时，两列都保留，不合成一个分数。

外部判定按题面写成可以复核的结果：文件内容、法条核验结论、账本数字、进程退出状态，或检索结果里的公开号。判定读这些结果，不读模型自己的总结。

## 工具族

模型可见工具以 [tool-catalog.md](../tool-catalog.md) 为准。下表分组的是该目录里专利、文档、法律、视频现有的 67 个工具。目录增删工具时，同一改动更新本表。每族 5 题：3 道应调用、1 道近邻、1 道应拒绝。近邻题把易混的另一个工具写进「禁止工具」。

| 族 | 阶段 | 工具 |
|---|---|---|
| 检索与法律状态 | 试点 | `patent_search`、`patent_metadata`、`patent_legal_status`、`patent_case_search`、`patent_pdf_download`、`patent_wiki_search` |
| 法条核验与规则 | 试点 | `law_verify`、`law_search`、`rule_check`、`domain_check`、`patent_eval` |
| 权利要求 | 试点 | `claim_lint`、`claim_chart_build`、`draft_claims` |
| 说明书与立案 | 试点 | `draft_specification`、`validate_specification`、`render_patent_document`、`verify_deliverable`、`build_patent_filing`、`verify_patent_filing` |
| 附图 | 扩域 | `generate_patent_figure`、`verify_patent_figure`、`analyze_patent_figure`、`check_patent_figure_consistency`、`compare_patent_figure_analysis`、`add_patent_figure_references`、`search_patent_figure`、`generate_structure_figure`、`recognize_chemical_structure` |
| 费用与期限 | 扩域 | `patent_fees`、`patent_deadlines` |
| 工作流与团队 | 扩域 | `patent_workflow`、`patent_workflow_run`、`patent_plan_task`、`flexible_plan`、`patent_worker_validate`，以及 `patent_teams_create`、`patent_teams_add_member`、`patent_teams_archive`、`patent_teams_claim_task`、`patent_teams_create_task`、`patent_teams_delete`、`patent_teams_reassign_task`、`patent_teams_remove_member`、`patent_teams_send_message`、`patent_teams_status`、`patent_teams_update_task`、`patent_teams_wait` |
| 文档交付 | 扩域 | `document_deliver`、`office_convert`、`office_recalculate`、`office_render` |
| 法律检索与证据 | 扩域 | `legal_knowledge_search`、`legal_law_verify`、`evaluate_legal_evidence`、`evaluate_evidence` |
| 视频 | 扩域 | `media`、`video_assemble`、`video_deliver`、`video_project` |
| 知识与分析 | 扩域 | `knowledge_note_save`、`patent_kg_query`、`patent_analysis_report`、`matter_log_append`、`workbench_link_patent_case`、`triz_contradiction_analysis`、`parse_office_action` |

`evaluate_evidence` 与 `evaluate_legal_evidence`、`law_search` 与 `legal_knowledge_search`、`patent_search` 与 `patent_wiki_search` 写成近邻题。题干和标准答案由人冻结，不用被测模型出题。

本表的 67 个工具是四域工具族的范围口径。`docs/tool-catalog.md` 同域另有 4 个模型可见工具不在本周期：`triz`（通用方法）、`query_writing_patterns`（撰写范式）、`list_doc_templates` 与 `render_doc_template`（文档模板）。目录增删这些工具时，仍按上一段的规则在同一改动里核对本表。

试点 4 族共 20 题。11 族共 55 题。真实模型每题 3 次：试点 60 次，扩域新增 105 次。

## 45 天表

| 天 | 层 | 范围 | 产出 |
|---|---|---|---|
| 1–2 | 契约 | 对照会话事件核对上表分母能否算出。算不出的项写明由跑分器打点 | `metrics/day-01.md`、`metrics/day-02.md` |
| 3–4 | 清单 | 对照 tool-catalog 核对 11 族是否仍覆盖全部列出的工具 | 族清单确认 |
| 5–8 | 题库 | 4 个试点族，每族 5 题。每题写明可接受工具、必填参数、外部判定、禁止工具 | 20 题 |
| 9–12 | 直接调用 | 20 题不调用模型。填写参数语法、可解释性、资源残留、畸形参数 | 基线；用这份基线填写通过线 |
| 13–22 | 脚本场景 | 脚本按题面填参并断言外部结果。超时、空结果、取消每种至少覆盖每族一题 | 闭环与恢复基线 |
| 23–30 | 真实模型 | 20 题各 3 次。开工前写下模型名和提示词；之后变更就整段重跑 | 选择、拒绝、延迟、成本、上下文 |
| 31–34 | 题库与直接调用 | 其余 7 族，每族 5 题，并完成直接调用 | 35 题及直接调用基线 |
| 35–36 | 脚本场景 | 这 35 题的外部判定与注入失败 | 扩域的闭环与恢复 |
| 37–38 | 真实模型 | 这 35 题各 3 次，沿用已冻结的模型名和提示词 | 扩域的五项真实模型指标 |
| 39–42 | 低于基线的族 | 只深挖低于通过线的族，十项一起看 | 代码缺陷写入 [05-findings.md](05-findings.md)，编号取该文件当前最大序号加一 |
| 43–45 | 收敛 | 列出可进 CI 的直接调用检查和脚本场景检查；真实模型五项维持周期评测。复盘只回答这十项有没有按分母量到 | `metrics/day-43.md` 至 `metrics/day-45.md`、`metrics/ci-boundary.md` |

时间盒不够跑完的真实模型次数，记下实际分子和分母，不把未跑的题记为失败。没有 LibreOffice 时，`office_convert`、`office_recalculate`、`office_render` 的闭环记为未测。

## 每日记录

`metrics/day-NN.md` 沿用日卡的检查项结构，并加一张样本表。一题一行：

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

当天没有采样的列留空，不填 0。0 只表示已经测量并且结果是 0。

## 待确认

1. 通过线在第 9–12 天的直接调用基线之前留空。
2. token 单价在第 23 天写进当天的 `metrics/` 记录，不写进本文件。
3. 视频族在第 37–38 天的时间盒里能跑多少记多少。
4. 源码审阅修复队列仍由 [06-priority.md](06-priority.md) 跟踪，本计划不改那份队列的顺序。
