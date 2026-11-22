# Day 13 — 脚本场景（一）：层口径、注入口与跑分器

## 今日维度与范围

本日按 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的 D13–D22 开工，先把脚本场景层的口径固定下来：哪 14 题能进这一层、三种注入怎么打、恢复怎么判、样本表的每一列从哪里取。题面与可接受集合沿用 [pilot-questions.md](pilot-questions.md)，本日不改题干、不改 `docs/code-review/daily/`，也不改业务代码、依赖、CI 或基础设施配置。

脚本场景层不采样模型，也不回放 snapshot。脚本按题面把参数填进工具，断言工具产出的外部结果（文件、字段、条数、路径、账本或退出状态），再对同一题注入一次失败并执行恢复计划。这一层测的是「参数语义、调用闭环、错误恢复」，不测工具选择、拒绝率、响应时间、成本与上下文利用率。

## 检查项

- [x] 列出 20 题中能进脚本层的 14 题，以及 6 题的未测口径。
- [x] 写清超时、空结果、取消三种注入的注入点与恢复判定。
- [x] 样本表的列与 [day-02.md](day-02.md) 的跑分器字段对齐。
- [x] 跑分器不调用模型，也不把 snapshot 回放计入任何一项。
- [x] 记录冻结状态与前置：题库于 2026-11-21 按起草文本冻结。直接调用记录在 [day-09.md](day-09.md) 至 [day-12.md](day-12.md)，通过线在 [day-12.md](day-12.md)。
- [x] 本日没有改 `daily/`、业务代码、依赖、CI 或基础设施配置。

## 可执行子集与未测口径

20 题里 14 题有确定性工具路径，可以进脚本层：P-RET-01 至 P-RET-04、P-LAW-01 至 P-LAW-04、P-CLM-01、P-CLM-03、P-SPC-01 至 P-SPC-04。其余 6 题按题面标注的层口径记未测，不记 0、不记失败：

| 题号 | 未测原因 |
|---|---|
| P-RET-05、P-LAW-05、P-CLM-05、P-SPC-05 | 应拒绝题只在真实模型层测量；脚本层没有模型可拒绝 |
| P-CLM-02、P-CLM-04 | `claim_chart_build` 内部调用模型；脚本层没有模型端口，按 [day-02.md](day-02.md) 的约定不进这一层 |

因此本层的闭环分母是 14，不是 20；恢复分母是 12 次注入，不是 20 题。14 题又按族分成四组，每族 5 题里能进本层的分别是 4、4、2、4。

## 跑分器接线

跑分器是一次性本地脚本，不留在仓库（沿用 [05-findings.md](../05-findings.md) 的 OBS-008 做法）。命令是：

```
pnpm exec tsx docs/code-review/metrics/.scenario/runner.ts
```

脚本每次用 `new Context()` 挂 `SystemPrompt` 与 `ToolRuntime`，注册一个工具，再经 `executeToolFixture` 把题面参数序列化成一次模型等价调用。工具的依赖按生产装配接真件，不手写假数据：

| 族 | 接线 |
|---|---|
| 检索与法律状态 | `CaseLawSearchEngine` 与 `WikiCardLoader` 读 `~/.dsh/knowledge/knowledge-lite.db` 与 `~/.dsh/knowledge/wiki`；`patent_search`、`patent_legal_status` 用默认 nuo 引擎 |
| 法条核验与规则 | `loadLawBaselines()` 与 `DEFAULT_CITATION_POLICY` 接 `law_verify`；`KnowledgeLawSearch` 分别接法规与指南；`rule_check`、`domain_check` 用随包资产 |
| 权利要求 | `claim_lint`、`draft_claims` 直接用纯函数工具 |
| 说明书与立案 | `render_patent_document`、`build_patent_filing` 接 `LocalSubprocessRuntime`；后者用随包 Python 运行时（`~/.dsh/dsh-runtimes/dsh-primary-runtime`）与随包模板、spec |

本机查询库是 `~/.dsh/knowledge/knowledge-lite.db`（3.5 GB）；`resolveKnowledgePaths()` 解析到它，未落到 `~/.sati` 源库。`build_patent_filing` 的引擎解释器按 `findPython()` 的探测顺序找到了随包运行时，`python-docx` 可用。

## 三种注入与恢复判定

注入只发生在一次调用的边界或数据 seam，不伪装成工具自身的实现：

| 注入 | 注入点 | 首次调用的可见结果 |
|---|---|---|
| 超时 | 工具执行边界，首次调用直接抛 `PatentToolError('tool_timeout')` | `tool/result` 为错误，`error.code` 是 `tool_timeout` |
| 取消 | 工具执行边界，首次调用直接抛 `PatentToolError('tool_aborted')` | `tool/result` 为错误，`error.code` 是 `tool_aborted` |
| 空结果 | 有数据 seam 的题在 seam 返回空（P-RET-01）；没有 seam 的纯函数题在边界返回一个满足输出 schema 的空投影 | 调用本身成功，但外部判定不成立；这条正是「`tool/result` 非错误不算闭环」的样本 |

恢复在第二次调用进行。恢复调用必须换参数、换通道或换输入表达，不能原样重放失败调用：

- 同名同参数的失败调用第二次出现 → 记未恢复。
- 同一失败身份下重试超过 2 次 → 记未恢复。
- 失败后宣称完成而外部判定不成立 → 记假恢复。
- 恢复调用成功、外部判定成立、且没有上面三条 → 记已恢复。

空结果注入的首次调用是「成功」形状，脚本不把它的成功当闭环；只有恢复后的外部判定成立才算恢复。这一条防止把「工具没报错」直接写成「任务完成」。

## 样本表列

每一天的样本表沿用计划规定的列：

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

本层只填可测的列：语法（`arguments` 能解析且通过 schema）、语义（题面指定的案号、路径、格式、条号在参数里）、外部判定、墙钟、恢复与残留。`token 费用`、`provider 费用`、`未使用 schema 字节`、`拒绝或误拒` 在本层没有采样，留空，不填 0。墙钟是跑分器在进程内量的单次调用时间，不区分模型等待与工具执行——脚本层没有模型等待。

## 残留与时间的量法

每次调用前把 `TMPDIR` 指到一个空目录，调用后检查三项：子进程表（`ps -P` 当前跑分器）为空；该目录里没有工具创建的临时目录或文件（跑分器持有的 `dsh-subprocess-*` 空目录是本地 subprocess 运行时的 spill 目录，进程正常退出时删除，不计入工具残留）；输出文件只出现在题面指定的输出目录。命中任何一项就记残留，不平均进利用率。

`build_patent_filing` 这类写文件工具会留下成品，成品是题面要求的交付物，不是残留；跑分器在记录之后删除一次性输出目录，避免把成品带进提交。

## 前置与冻结状态

题库于 2026-11-21 按起草文本冻结，清单在 [pilot-questions.md](pilot-questions.md)。直接调用记录在 [day-09.md](day-09.md) 至 [day-12.md](day-12.md)，通过线在 [day-12.md](day-12.md)。本层样本读的是这份冻结文本。通过线不由本层填写，也不把本层比例写进计划文件。

本层的产出是闭环与恢复基线，记下实际行为与题面判定的差距。四处差距随起草文本锁定，见 [day-22.md](day-22.md)。

## 本日结论

脚本层口径固定：14 题可测、6 题未测；三种注入各有明确的注入点与恢复判定；样本表列与 [day-02.md](day-02.md) 的记录字段对齐。跑分器接入真实知识库、真实检索与真实 Python 引擎，未接模型。

本日没有发现需要改业务代码才能继续的阻塞。发现的题面判定问题与产品行为差异从 D14 开始逐族记录。

## 明日第一件事

Day 14 第一件事：跑「检索与法律状态」4 道可测题的干净场景，逐题填语法、语义、外部判定、墙钟与残留；先记 P-RET-02 的状态值与 P-RET-03 的命中条数，再看它们是题面判定问题还是产品行为问题。
