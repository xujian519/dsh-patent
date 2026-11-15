# Day 2 — 2026-11-16

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-16）。

## 今日维度与范围

- 维度：定向与基线
- 范围：专利域核心入口：patent-tools、patent-core、patent-workflow
- 时间盒：90 分钟
- 预期产出：专利域核心数据流笔记；更新 01-repo-map.md 的入口与风险面；daily/day-02.md

## 检查项

- [x] 列出 patent-tools 注册的模型可见工具及其入口文件。
- [x] 列出 patent-core 的纯库导出与 ModelPort 边界。
- [x] 列出 patent-workflow 的状态机、持久化与 HITL 审批入口。
- [x] 标记外部进程、网络请求、文件写入与模型调用点。
- [x] 把待验证点映射到 H01、H05、H10。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| `codegraph_explore` 查询三包入口 | 定位 patent-tools 的 `wiring.ts`、patent-core 的 `model-port.ts`/`persist-utils.ts`、patent-workflow 的 `index.ts`/`model-call-log.ts` |
| 列出三包 `src` 文件 | patent-tools 约 120 个文件；patent-core 约 110 个；patent-workflow 15 个 |
| `grep` 服务依赖 | patent-tools 读取 `agentDefaultModel`、`llm`、`attachments`、`patentKnowledge`、`patentData`、`writingPatterns`、`jobs`、`approval`、`subprocess`、`webServer` |
| `grep` 外部 I/O | patent-core 的 `persist-utils.ts`、`paths.ts`、`evidence/rule-loader.ts`、`ipc/ipc-standards-loader.ts`、`claim-chart/runtime/store.ts`；patent-workflow 的 `workflow-store.ts`、`docket-issue.ts` |
| `grep` 子进程 | patent-tools 的 `figure/freecad-renderer.ts`、`inkscape-renderer.ts`、`subprocess-render.ts` 通过 `ctx.subprocess` 调用 dot/Inkscape/FreeCAD |
| 读关键实现 | `wiring.ts`、`approval-gate.ts`、`workflow-store.ts`、`model-call-log.ts`、`persist-utils.ts`、`paths.ts`、`plantask.ts`、`workflow/executor.ts`、`config.ts` |

## 数据流笔记

### patent-tools

- 入口：`src/index.ts` 的 `apply` 调 `registerPatentTools(ctx, config)`；注册面在 `src/wiring.ts`。
- 规模：注册 37 个模型可见工具；另注册 9 个本包 atom（`slop-gate`、`tighten`、`draft-specification`、`figure-analysis`、`spec-check`、`response-check`、`eligibility`、`legal-gaps`、`admissibility`）；patent-core 的内置 atom 由 `registerBuiltinAtoms()` 全局注册。
- 模型端口：`buildModelPort` 从 `Config.provider/model` 或 `ctx.get('agentDefaultModel')` 解析路由；缺路由或 `ctx.get('llm')` 时返回 fail-loud stub（`wiring.ts:141`）。
- 模型调用日志：6 个 LLM 消费工具都经 `loggedToolModel` 绑定会话（`patent-workflow-run`、`patent-flexible-plan`、`analyze-patent-figure`、`triz-contradiction-analysis`、`claim-chart-build`、`patent-analysis-report`）。
- HITL：`approveStageGates` 开启时，前台运行把默认审批门换成 `LiveApprovalGateHandler`；它只接受 `allowed-once`，`never`/`unavailable`/异常一律按拒绝处理（`approval-gate.ts:107`）。开启后 `approveStageIds` 被拒绝，避免模型自批。
- 外部进程：Graphviz dot、Inkscape、FreeCAD 通过 `ctx.get('subprocess')`；PDF 下载经 `ctx.patentData` 的 ego-browser 通道。
- 文件写入：附图输出、`figureIndexFile`、`chemistryIndexFile`、`noteDir`、`_matter-log.md`、`data/cases/<caseId>/outputs`。
- 网络：LLM、`patent_data` 检索、PDF 下载、workbench 回环 HTTP（`http://127.0.0.1:<webServer.port>`）。

### patent-core

- 定位：无 Cordis ctx 依赖的库，但不是无副作用库：`persist-utils.ts` 做原子写与 `JsonFileStore`，`paths.ts` 做真实路径包含性校验，`evidence/rule-loader.ts`、`ipc/ipc-standards-loader.ts`、`claim-chart/runtime/store.ts`、`atoms/handlers/builtin/chart-source.ts` 直接读文件。
- 模型边界：`PatentModelPort` 只声明 `stream`、`route`、`bindSession`；具体 LLM 适配在 `model-port.ts` 的 `createLlmModelPort`。
- 工作流契约：`workflow/manifest.ts`、`budget.ts`、`signal.ts`、`stage-outputs.ts`、`revision-log.ts` 在 patent-core；执行器与服务在 patent-workflow。
- 导出面：`src/index.ts` 约 747 行，覆盖 atoms、checker、evidence、graph、draft、claim、notice、IPC 等。

### patent-workflow

- 服务：`PatentWorkflow` 暴露 `runWorkflow`、`runPlantask`、`approve`、`reject`。
- 状态机：`planning → awaiting_approval → executing → awaiting_feedback → replanning → finished`；白名单迁移 + 语义守卫（任务非空、阻塞条目闭合、反馈非空、终态条目、轮次上限），非法迁移抛错（`plantask.ts:24`）。
- HITL：`awaiting_approval` 读 `ctx.get('approval')`；服务缺失时返回 `unavailable` 并按拒绝重规划；`autoApprove=false` 留在 pending；`pending` 以 caseId 为键，重复挂起被拒绝。
- 持久化：`JsonFileWorkflowRunStore` 每 run 一个 JSON，底层 `JsonFileStore` 用 `assertSafeId` 与 `atomicWriteJson`；run 目录在 `data/cases/<caseId>/workflow-runs`。
- 模型日志：`loggedPatentModel` 在流结束后追加 `patent/model-call`；无 agent 时原样返回端口。
- 会话事件：`runWorkflow` 追加 `patent/workflow-run`、`patent/evidence-ledger`、`patent/legal-gaps`；`runPlantask` 追加 `patent/plantask`。

## 发现

代码级发现：无。Day 2 只做定向，不判定缺陷。

结构观察（待对应维度确认）：

1. `patent-tools/src/tool/knowledge-note-file-writer.ts:16` 从 `@deepseek-ai/dsh-patent-data` 导入 `atomicWriteJson`，而该 helper 的归属是 `patent-core`；`patent-data` 只是历史导出面。候选 B 维度精简项，Day 15 复核。
2. `patent-workflow/src/index.ts:148-150` 的 `pending` 与 `rounds` 是进程内 Map；重启后挂起的 plantask 与轮次计数不恢复，虽然状态已写入会话事件。候选 E 维度恢复问题，Day 35 复核。
3. `patent-workflow/src/model-call-log.ts:55-69` 在流结束后才追加 `patent/model-call`；流中途抛错或消费者提前停止时没有事件。是否构成模型可见内容缺口，取决于工具是否把部分增量交给模型；候选 H10，Day 11/40 复核。
4. `patent-tools/src/wiring.ts:197-218` 的 `noteDir`、`figureIndexFile`、`chemistryIndexFile`、`figureOutputDir` 默认基于 `process.cwd()`；配置可覆盖，但桌面打包部署下 cwd 不一定是用户工作根。候选 A/E，Day 6 与 Day 37 复核。

## 假设验证/推翻

- H01：**部分确认**。`patent-core` 无 ctx 依赖，但含持久化、路径校验、资产读取与工作流契约；“纯库”指无 ctx，不是无 I/O。是否应搬迁，留到 Day 13 评估。
- H05：**待验证，已定位**。专利域的危险汇点集中在 `patent-tools` 的子进程（dot/Inkscape/FreeCAD）、PDF 下载脚本、附图/笔记/案卷文件写入；路径包含性校验在 `patent-core/src/paths.ts`，是否覆盖所有模型输入路径留到 Day 6/8/9。
- H10：**部分支持**。6 个 LLM 消费工具都接 `loggedToolModel`；但流中途失败不记 `patent/model-call`。Day 11/40 判断是否构成模型可见缺口。
- H02、H07：Day 2 未触及，仍待验证。

## 未决问题

1. `patent-core` 的“纯库”边界是否接受文件 I/O 与资产读取，还是应在 Day 13 提出搬迁方案。
2. `pending`/`rounds` 的进程内状态是否需要从会话事件恢复，或明确声明为单进程语义。
3. 默认 `process.cwd()` 路径在桌面部署下的实际工作根，需要 Day 6 用配置与预设对照。

## 明日第一件事

Day 3：读专利域外围 12 个包（patent-rule、patent-law、patent-fees、patent-deadline、patent-document、patent-filing、patent-knowledge、patent-data、patent-teams、writing-patterns、methodology、tool-literature），补全资产加载、期限/费用算术、渲染与立案、检索与团队入口。
