# Day 35 — 2026-12-19

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：专利域-2：patent-workflow、patent-rule、patent-teams
- 时间盒：90 分钟
- 预期产出：E 维度专利域候选发现；daily/day-35.md

## 检查项

- [x] 检查状态机不变量。
- [x] 检查审批与恢复。
- [x] 检查规则失败的传播。
- [x] 检查团队任务一致性。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-046、F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。三个复现脚本放在仓库根（`d35-repro.mts`、`d35-repro2.mts`、`d35-repro3.mts`）：裸包名要从仓根 `node_modules` 解析，放 `/tmp` 解析不到；三份都未跟踪，跑完已删除。

**状态机不变量（20 分钟）**：`plantask.ts` 的迁移矩阵与 `SEMANTIC_GUARDS` 逐条对照，白名单外迁移与缺任务、缺反馈都抛错；`applyDecision` 只在 `roundCapReached` 时分到 `finished`，`pending` 只在 `autoApprove: false` 的挂起分支保留，决策与异常出口都会清掉。`replanTasks` 用 `hash → 旧任务` 的 Map 判保留，同哈希的多个新步骤共用同一条完成状态，见 F-PAT-050。`patent-teams/state.ts` 的 `TASK_TRANSITIONS` 与 `transitionError` 一致，`failed`／`cancelled` 只能经 `reassignTask` 重新开 attempt，与文档一致。读码确认 `flow-graph.ts` 的环检测与 `topologicalLevels` 对顺序链成立；`workflow-dag.ts` 刻意不把回退边入图，避免把受控回退报成环。

**审批与恢复（20 分钟）**：审批门在 `runStageOnce` 里判定放行，放行标记只进 handler 执行态，不写共享 state；`assertApprovalGrants` 在执行前拒绝非门阶段 id。中断后的恢复只有一条路径：带 `approvalGrants` 重跑，而 `runStages` 固定从第 0 个阶段开始。旧风险登记册的 R-77 已按同一语义登记并延后（`reports/code-review-risk-register.md:824`–`:835`），`workflow-recovery.spec.ts:117` 的注释也写明「恢复是整次重跑」；今天的补充证据是 8 个内置 manifest 的门都在最后一级与同 runId 覆盖。四阶段合成 manifest 的首跑与续跑调用序列再次证明前置阶段重跑，见 F-PAT-047。`patent-teams` 的建队与收口审批走 `requireTeamApproval`，未挂审批服务或结果为 `never` 都按拒绝处理，没有 fail-open。

**规则失败的传播（25 分钟）**：`patent-rule` 的基础合规资产缺失时 `loadBaseCompliance` 抛 `PatentRuleAssetError`；`nuo-*.yaml` 与并入文件缺失只记 warning（`:384`–`:390`），`index.ts:480` 把这些 warning 写进 `ctx.logger.warn`，模型侧看不到。`rule_check` 在 `patent`、`patent-electrical`、`patent-full` 与作业 scope 上只取 `.ruleSet`（`rule-check.ts:199`、`:206`、`:208`），不取 `loadPatentFullRuleSet` 的 warnings；这与 F-PAT-002（工具丢弃同义词资产告警）同一根因，归入该条，不另开编号。`structuralGate` 的 `strict` 只校验规则 id、action 与条目形状，不校验 `textArgs` 对应的入参是否真的存在；`citationGate` 共用同一段取文本逻辑。两处声明写错都静默放行，见 F-PAT-049。双输入规则在通知书解析为空时两条都判通过，见 F-PAT-048。

**团队任务一致性（15 分钟）**：`claimTask`／`reassignTask`／`removeMember` 的读改写都在 `withTeamLock` 内，attemptId 是唯一的能力凭据，重新分配先撤销旧 attempt 再等成员静默，第二段锁里按 `handoffId` 比对后才落盘；`removeMember` 把未完成任务放回 pending 池。调度器只在成员 idle 时开新 attempt；成员仍持有一个开放任务时换 attempt 重派，不会并行派出第二件。跨进程写同一 `team.json` 仍无文件锁，这条已由 F-PAT-003 记录（teams 的跨进程锁是刻意保留项），今天不重开。`buildTeamStatus` 的成员收件箱只确认展示出来的 10 条，队长收件箱确认最后 10 条，分页语义一致。

**命令**：`pnpm exec tsx d35-repro.mts`、`pnpm exec tsx d35-repro2.mts`、`pnpm exec tsx d35-repro3.mts`，退出码均为 0。决定性结果：四阶段 manifest 首跑执行 `s1`、`s2` 后中断，带 `approvalGrants` 续跑再次执行 `s1`、`s2`、`s3`，两次 `saveRun` 使用同一个 `<manifestId>` 键。`rejectionTypes` 为 `[]` 时 PR-OA-008／PR-OA-009 都返回 null，`rule_check` 结果里两条规则一条不出、也没有未评估行。`textArgs` 为 `draft` 时结构门禁命中 1 条、引用门禁报出第 999 条不存在；`draftt` 时分别 0 条与空数组。`replanTasks` 对两条同文本新步骤给出 `preserved: ['task-1','task-2']`、`toRun: []`。8 个内置 manifest 的审批门都在最后一级，门前阶段 7 至 26 个。

## 发现

F-PAT-047（复核旧登记 R-77 并量化）、F-PAT-048、F-PAT-049、F-PAT-050。

下面这些不够格单列：

1. `runPlantask` 与 `approve` 服务入口只向迁移守卫传 `tasks`，不传案卷条目（`index.ts:264`）；工具入口 `patent-plan-task.ts:250` 传 `issues`。服务入口没有生产调用方，进程内 `pending`／`rounds` 已由 F-PAT-011 记录。
2. `updateTask` 在质量门禁**通过**但任务仍是 `claimed` 时抛 `INVALID_TRANSITION`，而门禁**打回**时会自动落到 `in_progress`（`task-ops.ts:548`–`:588`）。工具参数说明已写明「`claimed` 必须先 `in_progress`」，属于已声明的两步要求，不单列。
3. `flexible-plan.ts:455`–`:512` 的 `fromJSON` 只校验部分字段，`createdAt`、`atom`、`params`、`technicalField` 可为任意类型，最后 `as FlexiblePlanState`。复现里 `createdAt: 123`、`atom: 7`、`params: 'xy'` 通过加载，`toManifest` 原样输出 `atom: 7`。消费方 `patent_flexible_plan` 会在 `runWorkflow` 的未知 atom 检查处 fail loud，今天不够格单列。

## 假设验证/推翻

H01–H10 今日不改。H07 仍是 Day 7 的部分推翻：今日 F-PAT-048 是同一失败方向的另一处（没真正执行的检查在结果里看起来通过），不改变 H07 的结论。H06 维持 Day 33 的部分推翻。H10 今天没有新增证据；`model-call-log.ts` 本次未改。H09 的旧数字维持 Day 19 的写法。

## 未决问题

1. 没有按真实 provider 的计费核算续跑的重复成本。重复规模由阶段数与门前原子推断，没有跑一次真实检索或模型调用。
2. 没有重跑 `patent-workflow`、`patent-rule`、`patent-teams` 的测试套件。结论只覆盖脚本里的输入。
3. 服务入口与工具入口的案卷守卫差异没有端到端用例；`runPlantask` 在生产代码里没有调用方，只按签名与调用点判断。

## 明日第一件事

Day 36（E 正确性与边界：专利域-3，`patent-knowledge`、`patent-data`、`patent-law`、`patent-fees`、`patent-deadline`）第一件事：检查索引读取边界、期限与费用算术、引用决策、未核验语义，并附证据。F-PAT-032 至 F-PAT-050 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 和 Chrome。H09 的旧数字不要改。
