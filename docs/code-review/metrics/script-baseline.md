# 工具指标脚本场景基线（D13–D22）

本文件是 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) D13–D22 的基线产物：四族 20 道试点题在脚本场景层的闭环与恢复读数。执行记录见 [day-13.md](day-13.md) 至 [day-22.md](day-22.md)，题面与外部判定见 [pilot-questions.md](pilot-questions.md)。

## 口径

- 层：脚本场景。不采样模型，不回放 snapshot；脚本按题面填参，断言外部结果，再注入一次失败。
- 分母：14 题可测，6 题按层未测。未测不记 0、不记失败，也不进入本文件的分子与分母。
- 恢复：注入第一次失败后外部判定成立，且同名同参数的失败调用没有原样出现第二次；重试超过 2 次算未恢复；失败后宣称成功而外部判定不成立算假恢复。
- 样本不足 20：只记分子与分母，不把小数写成通过线或族排名。

## 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-20 至 2026-11-21（Asia/Shanghai） |
| Node | v24.19.0 |
| 查询库 | `~/.dsh/knowledge/knowledge-lite.db`（3.5 GB） |
| wiki | `~/.dsh/knowledge/wiki` |
| Python | `~/.dsh/dsh-runtimes/dsh-primary-runtime`（带 `python-docx`） |
| 网络 | `patent_search` 与 `patent_legal_status` 的 nuo 引擎可达；直连 `patents.google.com` 超时，不影响引擎 |

## 闭环基线

| 题号 | 族 | 工具 | 语法 | 语义 | 外部判定 | 墙钟 | 闭环 |
|---|---|---|---|---|---|---|---|
| P-RET-01 | 检索与法律状态 | `patent_case_search` | 通过 | 有效 | 成立（2 条、fts、决定号 20037/588356） | 443 ms | 是 |
| P-RET-02 | 检索与法律状态 | `patent_legal_status` | 通过 | 有效 | 不成立（`Expired - Lifetime` 不在三值枚举） | 3132 ms | 否 |
| P-RET-03 | 检索与法律状态 | `patent_search` | 通过 | 有效 | 不成立（`limit=5` 返回 10 条） | 3272 ms | 否 |
| P-RET-04 | 检索与法律状态 | `patent_wiki_search` | 通过 | 有效 | 成立（3 张卡片、路径前缀、无公开号） | 38 ms | 是 |
| P-RET-05 | 检索与法律状态 | — | | | 未测（应拒绝题，真实模型层） | | 未测 |
| P-LAW-01 | 法条核验与规则 | `law_verify` | 通过 | 有效 | 成立（2 条 valid、blocked=false） | 4 ms | 是 |
| P-LAW-02 | 法条核验与规则 | `law_search` | 通过 | 有效 | 不成立（3 条中 2 条路径是 `审查指南/`） | 66 ms | 否 |
| P-LAW-03 | 法条核验与规则 | `rule_check` | 通过 | 有效 | 成立（MECH-INV-001、评估输入行） | 126 ms | 是 |
| P-LAW-04 | 法条核验与规则 | `domain_check` | 通过 | 有效 | 成立（30 项、5 pass、0 hit、25 manual） | 4 ms | 是 |
| P-LAW-05 | 法条核验与规则 | — | | | 未测（应拒绝题，真实模型层） | | 未测 |
| P-CLM-01 | 权利要求 | `claim_lint` | 通过 | 有效 | 成立（4 项、1 error、2 warning、未通过） | 1 ms | 是 |
| P-CLM-02 | 权利要求 | — | | | 未测（工具内模型） | | 未测 |
| P-CLM-03 | 权利要求 | `draft_claims` | 通过 | 有效 | 成立（3 项、线性引用 1/2） | 1 ms | 是 |
| P-CLM-04 | 权利要求 | — | | | 未测（工具内模型） | | 未测 |
| P-CLM-05 | 权利要求 | — | | | 未测（应拒绝题，真实模型层） | | 未测 |
| P-SPC-01 | 说明书与立案 | `draft_specification` | 通过 | 有效 | 成立（完整、五部分、摘要 72 字） | 1 ms | 是 |
| P-SPC-02 | 说明书与立案 | `validate_specification` | 通过 | 有效 | 成立（未通过、sections 错误） | 1 ms | 是 |
| P-SPC-03 | 说明书与立案 | `render_patent_document` | 通过 | 有效 | 不成立（draft 缺 16 个必填槽位） | 1 ms | 否 |
| P-SPC-04 | 说明书与立案 | `build_patent_filing` | 通过 | 有效 | 成立（docx、验收通过、3 分节） | 190 ms | 是 |
| P-SPC-05 | 说明书与立案 | — | | | 未测（应拒绝题，真实模型层） | | 未测 |

汇总：检索与法律状态 2/4，法条核验与规则 3/4，权利要求 2/2，说明书与立案 3/4；合计 10/14。

## 恢复基线

| 题号 | 注入 | 首次结果 | 恢复动作 | 重试 | 原样重复 | 恢复后判定 | 恢复 |
|---|---|---|---|---|---|---|---|
| P-RET-01 | 超时 | `tool_timeout` | `limit: 2 → 1` | 1 | 否 | 1 条、fts | 是 |
| P-RET-01 | 空结果 | 成功，`total=0`，判定不成立 | `limit: 2 → 1` | 1 | 否 | 1 条、fts | 是 |
| P-RET-04 | 取消 | `tool_aborted` | `limit: 3 → 2`、`include_body` 关闭 | 1 | 否 | 2 张卡片 | 是 |
| P-LAW-03 | 超时 | `tool_timeout` | 增加 `notice` | 1 | 否 | MECH-INV-001、评估输入 | 是 |
| P-LAW-01 | 空结果 | 成功，`findings=0`，判定不成立 | 改用 `references` 数组 | 1 | 否 | 2 条 valid | 是 |
| P-LAW-04 | 取消 | `tool_aborted` | 增加空 `figure_analysis` | 1 | 否 | 30 项、5/0/25 | 是 |
| P-CLM-01 | 超时 | `tool_timeout` | 增加 `max_claims: 4` | 1 | 否 | 4 项、1 error、2 warning | 是 |
| P-CLM-03 | 空结果 | 成功，`claims=0`，判定不成立 | 增加 `max_claims: 5` | 1 | 否 | 3 项、线性引用 | 是 |
| P-CLM-03 | 取消 | `tool_aborted` | 增加 `max_claims: 5` | 1 | 否 | 3 项、线性引用 | 是 |
| P-SPC-04 | 超时 | `tool_timeout` | `outputName` 改为 `pilot-filing-retry` | 1 | 否 | docx、验收通过、3 分节 | 是 |
| P-SPC-02 | 空结果 | 成功，`passed=true`，判定不成立 | 增加 `patent_type` | 1 | 否 | 未通过、sections 错误 | 是 |
| P-SPC-01 | 取消 | `tool_aborted` | 增加 `claims` 文本 | 1 | 否 | 完整、五部分、摘要 72 字 | 是 |

汇总：四族各 3 次，12/12 已恢复；原样重复 0，重试超过 2 次 0，假恢复 0。空结果注入的首次调用有 4 次是成功形状，但没有一次被当成闭环。

## 成功但未闭环

7 次调用返回了非错误结果、但按题面外部判定不成立：干净场景 P-RET-02、P-RET-03、P-LAW-02，加上注入轮 4 次空结果的首次调用（P-RET-01、P-LAW-01、P-CLM-03、P-SPC-02）。只看 `tool/result` 的非错误状态会把这 7 次记成完成，本基线全部记为未闭环。

## 锁定的判定差

题面于 2026-11-21 按起草文本冻结。下列四处随文本锁定，本批没有改题面。改题或改变工具行为之后，本基线与 [day-12.md](day-12.md) 的通过线一起作废，两层都要重跑。

1. P-RET-02：状态值可以是 `Expired - Lifetime` 这类带后缀的字符串，题面枚举只有 `Active`、`Expired`、`Abandoned`。
2. P-LAW-02：题面要求 `审查指南_md/`，测量到的 `sourcePath` 是 `审查指南/`。
3. P-SPC-03：草案缺少 patentability-opinion 所要求的 16 个字段（`fields.meta-case`、`meta-basis`、`meta-date`、`sum-title`、`footer-case`、`footer-date`，以及 `sections.doc-number`、`basis-body`、`claim-decomposition-body`、`feature-comparison-body`、`inventiveness-step-1/2/3`、`other-requirements-body`、`evidence-body`、`citation-log-body`），工具按现有校验拒绝。
4. P-SPC-03 的失败结果没有 `error.code`，记为不可解释，见 [F-CROSS-005](../05-findings.md)。

## 产品缺陷

F-PAT-056：`patent_search` 不按 `limit` 截断命中。真实引擎 `limit=5` 返回 10 条；注入的检索函数返回 10 条、`limit=2` 仍返回 10 条。截断缺口在工具侧，不在引擎。登记在 [05-findings.md](../05-findings.md)，另开修复 PR；本基线不改代码。

## 资源与残留

14 次干净调用与 12 次恢复调用：子进程 0，工具临时目录 0，业务目录写入 0。P-SPC-04 的两份 docx（干净场景 `pilot-filing.docx` 与恢复 `pilot-filing-retry.docx`）是题面要求的成品；跑分器在记录后删除一次性输出目录。跑分器自身的 `dsh-subprocess-*` 空 spill 目录在进程正常退出时删除，不计入工具残留。

## 可进 CI

不依赖模型与网络的检查：P-LAW-01、P-LAW-03、P-LAW-04、P-CLM-01、P-CLM-03、P-SPC-01、P-SPC-02；P-SPC-04 需要 `python-docx` 解释器，探测不到时跳过。P-RET-01、P-RET-04 需要本机知识库或 wiki，CI 没有时跳过。P-RET-02、P-RET-03 依赖网络，不进阻塞 CI。P-LAW-02 与 P-SPC-03 的外部判定不成立，不进阻塞 CI。12 个注入检查可随对应题进 CI；这 12 次的恢复判定在冻结文本上已经成立。不要把 10/14 当成通过线。

## 前置与状态

- 题库于 2026-11-21 按起草文本冻结，清单在 [pilot-questions.md](pilot-questions.md)。
- 直接调用记录在 [day-09.md](day-09.md) 至 [day-12.md](day-12.md)。通过线在 [day-12.md](day-12.md)。本基线的 10/14 不是通过线。
- 本基线读的是这份冻结文本。题面或工具行为改变时整段重跑，并作废直接调用通过线。
- 下一步：P3 真实模型层。选择、拒绝与成本对照 [day-12.md](day-12.md) 的通过线，不把 10/14 写进对照。
