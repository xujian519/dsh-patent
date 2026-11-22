# Day 32 — 直接调用（一）：附图、费用与期限、工作流与团队

## 今日维度与范围

本日对 [extended-questions.md](extended-questions.md) 的附图、费用与期限、工作流与团队三族共 12 道可调用题做直接调用记录。测量日是 2026-11-22，题库当日冻结。调用走带会话日志的工具执行，每次调用产生一对 `tool/call` 与 `tool/result`；provider 是一次性脚本化的 Messages SSE 服务，只回放题面给出的 `tool_use` 参数，不参与判断。

本日不调用真实模型，不用 snapshot 回放，不改 `daily/`、业务代码、依赖、CI 或基础设施配置。应拒绝的 3 题只在真实模型层测量。样本表只填本日采样到的列；墙钟含进程启动与已禁用的会话标题等待，不填；mock provider 的 usage 不是真实费用，也不填。

## 环境

工作目录是仓库根。工具补丁 `/tmp/p4-ext.patch.yml` 在 `headless` 基础组合上插入七族插件，并禁用 `session-title` 与 `session-title-llm`，避免标题请求抢占脚本步骤。`request/header` 共 98 个工具，schema 合计 214,197 字节。Graphviz `dot` 可用；`ffmpeg` 与 `ffprobe` 可用；本机没有 Office Kit，与本日三族无关。

## 检查项

- [x] 12 道题各有 `tool/call` 与配对的 `tool/result`，没有 `INVALID_ARGS`。
- [x] 每个成功调用的参数仍是原始 JSON 对象，结果没有在 schema 校验前被丢弃。
- [x] 外部判定读工具结果原文或落盘文件，不读总结。
- [x] 4 处外部判定不成立或只部分成立，记入观测，不改成通过。
- [x] 残留只登记实际写出的文件与目录，不把交付物记成泄漏。

## 样本表

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P4-FIG-01 | 附图 | 直接 | `generate_patent_figure` | `generate_patent_figure` | 通过 | 是 | 是 | 无误拒 | | | | | | `patent/figures/p4-fig1.svg` |
| P4-FIG-02 | 附图 | 直接 | `check_patent_figure_consistency` | `check_patent_figure_consistency` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-FIG-03 | 附图 | 直接 | `add_patent_figure_references` | `add_patent_figure_references` | 通过 | 是 | 是 | 无误拒 | | | | | | `/tmp/p4-fixtures/fig1_annotated.svg` |
| P4-FIG-04 | 附图 | 直接 | `verify_patent_figure` | `verify_patent_figure` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-FEE-01 | 费用与期限 | 直接 | `patent_fees` | `patent_fees` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-FEE-02 | 费用与期限 | 直接 | `patent_deadlines` | `patent_deadlines` | 通过 | 是 | 否 | 无误拒 | | | | | | 0 |
| P4-FEE-03 | 费用与期限 | 直接 | `patent_fees` | `patent_fees` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-FEE-04 | 费用与期限 | 直接 | `patent_deadlines` | `patent_deadlines` | 通过 | 是 | 否 | 无误拒 | | | | | | 0 |
| P4-WF-01 | 工作流与团队 | 直接 | `patent_plan_task` | `patent_plan_task` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-WF-02 | 工作流与团队 | 直接 | `patent_teams_create` | `patent_teams_create` | 通过 | 是 | 是 | 无误拒 | | | | | | `.patent-teams/p4-team-demo` |
| P4-WF-03 | 工作流与团队 | 直接 | `flexible_plan` | `flexible_plan` | 通过 | 是 | 否 | 无误拒 | | | | | | `data/cases/p4-flex-demo/workflow-runs/flexible-plans/p4-flex-demo.json` |
| P4-WF-04 | 工作流与团队 | 直接 | `patent_plan_task` | `patent_plan_task` | 通过 | 是 | 否 | 无误拒 | | | | | | 0 |

## 附图

- P4-FIG-01 写出 `patent/figures/p4-fig1.svg`，标号 100、102、104 与三个步骤一一对应；附图说明含「图1」与「流程图」。工具在结果里保留了曲线段只按端点弦近似的渲染复核警告，没有写成零缺陷。
- P4-FIG-02 报跨图冲突 1 处（标记 10 在图 1、3 中分别为壳体与底座），缺图号 2。
- P4-FIG-03 写出 `fig1_annotated.svg`（469 字节，源文件 459 字节且未改）；两条标号落盘为「壳体 (10)」「底座 (12)」，未命中列表只有「盖板」。
- P4-FIG-04 量到画布 120×80 毫米、文字 2 个、线宽 0.5mm×3，发现的问题为「未发现问题」，没有混入跨图结论。

## 费用与期限

- P4-FEE-01 逐项为申请费 900、公布印刷费 50、权利要求附加费 300（12 项减 10 项免费基数，按 2 项计）、优先权要求费 80，合计 1330.00 CNY；说明书附加费数量 0、状态「金额未转录」，没有被写成 0 元已核验。
- P4-FEE-03 第 4 年度年费 900 元，按个人费减 85% 后应付 135 元；逾期 1 个月滞纳金 45 元；合计 180.00 CNY，三项都是已核验。
- P4-FEE-02 的申请费期限是 2024-03-10，实质审查期限 2027-01-10，逾期项都标了「已逾期」。年费期限没有进入可计算表，而是列在「无法计算」清单里，缺少授权公告日。题面外部判定要求「表内出现年费期限」，本项不成立。
- P4-FEE-04 回声「已缴至第 2 年度」，列了 5 项可计算期限与 11 项无法计算期限；但没有题面要求的年费缴纳期限与滞纳期起算日，全文没有「滞纳」字样。工具在缺少授权公告日时不推算年费年度，这是输入不足，不是把期限算错。

## 工作流与团队

- P4-WF-01 同步出 task-1、task-2、task-3，后两项分别依赖前一项，状态都是 pending，待执行顺序与题面一致。
- P4-WF-02 返回 id `p4-team-demo`、状态目录 `.patent-teams/p4-team-demo` 与 captain 身份；目录里有 `team.json` 和空的 `inbox/`。
- P4-WF-03 返回 caseId、status=active 与持久化提示，但「当前阶段」是「（无待执行阶段）」：题面没有提供 `stages`，`create` 只建计划不生成阶段。题面要求「报告当前阶段」，本项没有可报的阶段。
- P4-WF-04 只返回 `planning → awaiting_approval ✅`。`transition` 分支不读 `planSteps`，题面把「校验迁移」与「同步任务依赖」写进一次调用，依赖列表无法出现。

## 观测

四处外部判定不成立来自题面设计，不是工具执行错误：FEE-02 与 FEE-04 缺少授权公告日，年费期限按工具契约进入「无法计算」；WF-03 缺少 `stages`；WF-04 把两个 action 合成一次调用。按冻结规则，本批不改题面，四处判定差随文本锁定，记录在 [extended-questions.md](extended-questions.md) 的判定差一节；真实模型层的选择与参数指标不受影响。

附图生成与团队创建的残留是交付物或状态目录，不是泄漏；其余 8 题没有新增文件。`patent/figures/p4-fig1.svg` 在进入真实模型轮前删除，使模型层从空工作区开始。

## 下一步

[day-33.md](day-33.md) 完成其余四族的直接调用，并汇总本批的语法、语义、可解释性与畸形参数；[day-34.md](day-34.md) 给出直接调用通过线。
