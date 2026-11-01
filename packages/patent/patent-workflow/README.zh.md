---
description: "专利执行管线（`ctx.patentWorkflow`）的 Service Definition：声明式工作流执行器、灵活计划层、plantask 人机协作状态机与案卷问题条目 schema，移植自 Sati。本包把持久的 `patent/plantask`、`patent/workflow-run`、`patent/evidence-ledger`、`patent/legal-gaps` 与 `patent/model-call` 事件写入调用代理的会话日志，并经可选的 `ctx.approval` 接缝解决 plantask 审批。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-workflow

[English](README.md) | 中文

## 概述

专利执行管线（`ctx.patentWorkflow`）的 Service Definition：声明式工作流执行器、灵活计划层、plantask 人机协作状态机与案卷问题条目 schema，移植自 Sati。本包把持久的 `patent/plantask`、`patent/workflow-run`、`patent/evidence-ledger`、`patent/legal-gaps` 与 `patent/model-call` 事件写入调用代理的会话日志，并经可选的 `ctx.approval` 接缝解决 plantask 审批。

## 目录

- [服务](#service)
- [案卷问题条目](#case-docket-issues)
- [审批接线](#approval-wiring)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知局限与延期工作](#known-limitations-and-deferred-work)

<a id="service"></a>
## 服务

`PatentWorkflow` 服务暴露管线入口，并从本包根导出再导出纯管线 API（workflow、workflow-dag、workflow-store、flexible-plan、flexible-plan-store、plantask、worker-contract、docket-issue）。

### runWorkflow(manifest, ctx, executor?, options?, agent?)

经移植的执行器运行工作流 manifest，并在传入 agent 时把 `patent/workflow-run` 事件写入 `agent.session`。阶段声明 atom 或回退到 `executor`；阶段在 `consumes` 中列出上游阶段 id 时，这些阶段的产出会交给 executor（manifest 与图两条路径都把每个已执行阶段的产出存在该阶段 id 下），原子阶段则直接读共享 state；审批门 `InterruptStageError` 暂停运行并返回 `interrupted` 而非失败，宿主以 `options.approvalGrants` 重跑续接。取消是类型化的：阶段边界前已中止的信号以 `WorkflowError` 拒绝运行；阶段执行中到达 handler 的中止以 `StageCancelledError` 拒绝；两者都不重试、不写降级阶段输出。运行终态包含证据来源时，结果同时携带 `evidenceLedger`，并追加 `patent/evidence-ledger` 事件，按来源逐条给出收据；执行了 `legal-gaps` 阶段的运行还会追加 `patent/legal-gaps` 事件，携带该阶段的报告。回退可由阶段输出文本（`whenOutputMatches`）或阶段经 `_revision_signals` 返回的结构化 `RetrySignal` 触发；每次回退向运行结果的 `revisions` 追加一条 `RevisionRecord`（缺口编号、回退目标、前后产出摘要、原因、结果），上限 64 条，超出时以 `revisionsTruncated` 标记。

`patent_disclosure_v1` 与 `patent_patentability_v1` 在撰写前运行 `figure_analysis`（sub_agent，对 `figure_files` 中每个文件调用一次 `analyze_patent_figure`）与 `figure_analysis_parse`（确定性 `figure-analysis` 原子）；无附图、无视觉能力或未产出结果时写 `figure_analysis_skipped`，使说明书门禁能区分“未核”与“已核且一致”。

`builtinPatentManifests` 是八个内置 manifest 的数据目录：patent_novelty_v1、patent_disclosure_v1、patent_inventiveness_v1、patent_patentability_v1、patent_oa_response_v1、patent_invalidation_v1、patent_reexamination_v1、patent_infringement_v1。无效宣告与复审两个 manifest 共用同一个阶段构建器，差异只在确定性阶段的接线：无效宣告用无效理由表与 `invalidity` 图表模式，复审用复审理由表（多一项专利法第 2 条第 3 款的实用新型客体缺陷理由，专利权类型单独输出）与 `reexamination` 图表模式，后者也让两种案件落盘的对照表互不覆盖。

这些 manifest 共声明 30 个不同原子。`registerBuiltinAtoms()`（由 `PatentWorkflow` 构造函数与 dsh-patent-tools 调用）提供其中 24 个核心原子；依赖 patent-tools 的 slop 引擎、说明书校验器与规则资产的六个原子（`eligibility`、`spec-check`、`slop-gate`、`draft-specification`、`response-check`、`legal-gaps`）由 `@deepseek-ai/dsh-patent-tools` 在其插件 effect 中注册。仅挂载本包时，声明了这六个原子的 manifest 会在执行任何阶段之前被未知原子检查拒绝；请挂载 dsh-patent-tools，或经 `options.atoms` 与 `options.handlers` 注入对应契约与 handler。

### runPlantask(agent, caseId, planSteps, options?)

驱动 plantask 计划经过 planning → awaiting_approval → executing。awaiting_approval 门经 `ctx.get('approval')` 解决；无审批服务时计划 fail-closed（replanning）而非自动放行。`options.autoApprove: false` 让计划停在 awaiting_approval 等待带外决策。

### approve(caseId) / reject(caseId, feedback?)

针对停在 awaiting_approval 的 plantask 的决策入口：`approve` 续接至 executing，`reject` 带反馈回退至 replanning。以 `caseId` 为键；无匹配的挂起 plantask 时抛错。

### loggedPatentModel(port, agent, context)

包装专利模型端口，使其服务的每次调用向 `agent.session` 追加一条 `patent/model-call` 事件，记录调用点、manifest、provider 路由、token 用量与完整输出文本。agent loop 自己的调用记为 `request/*` 与 `assistant/*`；专利工具在函数体内发起的模型调用两者皆无，请求因此对会话日志不可见，keyless 回放也无法重建调用次序。请求侧无需自己的记录即可重建：工具调用的入参已入日志，manifest 与该轮各阶段产出共同构成提示词。流中途失败、或消费方提前停止消费的调用不追加任何事件——它没有产生完整的可见输出，其降级阶段由本轮结果记录。无 agent 时（直接库调用、单测）原样返回端口。

<a id="case-docket-issues"></a>
## 案卷问题条目

`DocketIssue` 是案卷里一条问题的机读记录：`id`、`summary`、`kind`、`disposition`、`status`、`blocking`、`round_opened`，外加可选的 `anchor`（权项、段落或文件路径）。`kind` 是六个取值的封闭词表（机检形式、可修改克服的实质缺陷、证据缺口、范围与策略取舍、无修改依据的不可克服缺陷、噪声）。本包随 `assets/issue-dispositions.json` 发布 kind → 默认值表；`loadIssueDispositions()` 在载入时校验（每个 kind 恰好一行、取值在词表内、判据非空），不通过则抛 `IssueDispositionError`。`resolveDocketIssue(draft, round, dispositions)` 用该 kind 的行补全缺省的 `disposition`/`blocking`，状态置 `open` 并写入 `round_opened`；条目自带的取值优先于行默认值。

`blocking` 设为三档，是因为二档会让每次问人都停摆：`none` 不拦派工，`blocking` 拦住派工直到该条闭合，`terminal` 让本轮只能收在终态。随包默认值按「闭合它实际要付什么代价」定：可修改克服的实质缺陷是 `none`（下一轮派工正是它的闭合手段），证据缺口是 `blocking`，无修改依据的缺陷是 `terminal`。

`patent_plan_task` 是这些条目的生产入口：transition 可以带 `issues` 草案与开启它们的 `round`，工具按随包处置表逐条补全，把解析后的条目交给状态机守卫，并在结果里回显。跨调用携带既有条目时把 `status` 与 `round_opened` 一并传回，已闭合的条目不会在下次调用中重新打开。

不变量由两个纯谓词表达：`openBlockingIssues`（未闭合且不为 `none`）与 `openTerminalIssues`（未闭合且为 `terminal`）。plantask 状态机在迁移守卫上执行它们——存在未闭合阻塞条目时拒绝进入 `executing`，存在未闭合终态条目时拒绝进入 `replanning`——而 `finished` 没有出边，故已终态的计划不能再派工。状态机从 `PlanTaskTransitionContext.issues` 读该案卷的条目；省略表示该案卷未登记条目，守卫不据此拒绝。`roundCapReached(rounds, maxRounds)` 是第三个谓词，守着「配置」一节所述的轮次上限。

<a id="approval-wiring"></a>
## 审批接线

Sati 的 `approval_pending` 事件加 `approvalDecide` 命令映射为 `approval/request` 瀑布（`ctx.approval.request(req)`）。plantask 的 awaiting_approval 状态即一次未决审批请求；`allowed-once` 为 approve（续接），`rejected`/`cancelled`/`unavailable` 为 reject（replanning 并回退阶段）。审批是经 `ctx.get('approval')` 读取的可选接缝，故本包对 dsh-user-approval 无编译期依赖。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxRounds` | `3` | 一个案卷可用于重规划的规划轮次。达上限后，拒绝反馈不再能驱动 `replanning`：计划转至 `finished`，结果带 `roundCapExhausted: true`。`0` 表示一次重规划都不允许。 |

轮次按 `caseId` 累计，计划收到 `finished` 时该登记清零，故同一案卷可从头再规划一轮。计数器在服务里，不入库，进程重启即重新计数。

| 方法 | 键 | 默认 | 含义 |
| --- | --- | --- | --- |
| `runPlantask` | `autoApprove` | `true` | 为 false 时让计划挂起，等待带外 `approve`/`reject`。 |
| `runPlantask` | `approvalReason` | （无） | 传给审批答案者的人类可读理由。 |

<a id="model-experience"></a>
## Model Experience

None, as the pipeline executes work for the tool layer; tool schemas, results, and approval prompts are owned by dsh-patent-tools and the interaction seam.

#### KV Cache effect

Independent; the pipeline registers no prompt, tool schema, or result of its own.

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与延期工作

- **存储经 `ctx.get('storage')` 可选** — 文件产物（workflow-run 与 flexible-plan 存储）使用调用方提供的 `JsonFileStore` 后端；服务不接线 storage-domain 接缝，ctx.storage 集成延期。
- **运行记录只校验、不带版本号** — `JsonFileWorkflowRunStore` 对字段不符合 `WorkflowRunResult` 的记录（含阶段、中断、证据账本、回退留痕等嵌套字段）抛带文件路径的 `StoredRecordError`；`listRuns` 只列文件名、不解析内容。格式没有版本字段，不兼容的旧形状按非法记录拒绝，不做迁移。`JsonFileFlexiblePlanStore` 同样拒绝 `caseId` 与文件名不一致的计划。
- **无答案者时审批 fail-closed** — 无审批服务挂载（或未组合答案者）时，`runPlantask` 拒绝计划转至 replanning 而非自动放行。
- **轮次计数器按进程** — `maxRounds` 计在服务里而非会话日志里：重启即清零，计划收到 `finished` 也清零该登记。

### 开发备注

无。
