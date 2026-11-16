# Day 28 — 2026-12-12

## 今日维度与范围

- 维度：D 测试缺口
- 范围：专利域-2：patent-workflow、patent-rule、patent-teams
- 时间盒：90 分钟
- 预期产出：D 维度专利域候选发现；daily/day-28.md

## 检查项

- [x] 检查状态机转移与恢复测试。
- [x] 检查审批拒绝与超时。
- [x] 检查规则校验失败路径。
- [x] 检查团队调度。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`。`vitest.config.ts:289`–`:294` 写明每个已发布的专利包都按每文件门禁测量，`patent-workflow` 与 `patent-teams` 的豁免 TODO 已在 2026-10-18 撤销。`patent-rule` 不在 `exclude` 里。`patent-workflow` 的 `src` 16 个文件、4733 行，`tests` 27 个文件、6607 行。`patent-rule` 的 `src` 23 个文件、5597 行，`tests` 30 个文件、7239 行。`patent-teams` 的 `src` 20 个文件、5746 行，`tests` 18 个文件、6528 行。三包的 `src` 行数与 Day 14 的测量相同。

**状态机与恢复（20 分钟）**：计划状态机在 `plantask.spec.ts:28` 锁住六态封闭表，`:71` 拒绝非法迁移，`:88` 拒绝空白反馈进入重规划。任务状态机在 `state.spec.ts:142` 锁住六态出边，终态没有出边。工作流恢复在 `workflow-recovery.spec.ts:74` 先暂停再带 grant 续跑到完成，`:121` 不带 grant 时暂停记录保持不变。弹性计划在 `flexible-plan.spec.ts` 覆盖回退、未知阶段和非法快照。这些用例断言暂停阶段、未完成和非法迁移。

**审批拒绝与超时（20 分钟）**：`service.spec.ts:375` 在审批结果为 `cancelled` 时回到 `replanning`，`:390` 覆盖带反馈、空白反馈和无反馈的 `reject`，`:356` 在没有审批服务时结果为 `unavailable`。`workflow-recovery.spec.ts:246` 拒绝第一个门后不再询问第二个门，`:260` 的 grant 只放行点名的门，下一门仍暂停。`workflow-store.spec.ts:333` 在 `requireAllSteps: false` 时中断运行的 `completed` 仍是 `false`。`patent-teams` 的 `approval.spec.ts:91` 对 `rejected`、`cancelled`、`unavailable` 拒绝变更。`patent-rule` 的 `post-execute.spec.ts:100` 在审批拒绝时拦截，`:109` 覆盖 `cancelled` 与 `unavailable`，`:122` 覆盖审批通道抛错，`:134` 覆盖没有审批通道。`patent-workflow` 的 `src` 没有阶段墙钟超时。有界的是 `executor.ts:82` 的重试次数和回退次数。`workflow-retry.spec.ts:89` 在超过最大回退后保留不一致输出并标降级。团队等待超时在 `team-activity.spec.ts:16` 与 `service.spec.ts:1794`，越界在 `:1802`。

**规则校验失败路径（15 分钟）**：`rule-loader.spec.ts` 覆盖非法严重度、危险正则、缺字段和非对象顶层。`structural-gate.spec.ts`、`citation-gate.spec.ts`、`delivery-gate.spec.ts` 的拒绝路径有直接断言。`post-execute.spec.ts:317` 断言 log 级命中进入日志。这些路径今日不另开编号。

**团队调度的断言强度（25 分钟）**：`unsatisfiedDependencies`（`state.ts:38`–`:40`）把状态不是 `completed` 的依赖和缺失 id 都算未完成。调用点是认领（`task-ops.ts:463`–`:465`）和调度（`scheduler.ts:144`–`:147`）。直接用例 `state.spec.ts:125`–`:139` 只有 `completed`、`pending` 和缺失 id。`service.spec.ts:591`–`:594` 与 `:803`–`:806` 挡住的依赖都是刚创建的 `pending` 任务。`scheduler.spec.ts:276` 的 `claimed` 是成员自己丢失回合的开放任务，不是别人的依赖。把判定收成「只有 `pending` 和缺失 id 算未完成」后，这三处用例仍然通过。`failed`、`cancelled`、`claimed`、`in_progress` 会变成可认领。这是 F-PAT-036。`TeamActivity.wait` 在 `team-activity.ts:82` 注册 abort 监听，`:64` 在结束时摘掉。`waitForMemberIdle` 在 `members.ts:537` 注册，`:542` 在 `finally` 摘掉。两处都带 `once: true`。`team-activity.spec.ts` 覆盖超时（`:16`）、通知（`:9`）和中止（`:40`）。`service.spec.ts:1378` 在等待中途中止并断言错误文案。测试里没有 `listenerCount` 或 `removeEventListener`。删掉这两处 `removeEventListener` 后，现有超时、通知和中止用例仍然通过。这是 F-PAT-035。

**完全未测模块**：三包不在覆盖率豁免里。今日没有全仓覆盖率数字，不能把「每个文件都是 100%」写成今日测量。抽样到的状态机、恢复、审批、规则失败和调度都有测试文件触及。完全未测的模块清单为空。新缺口是断言没有锁住监听摘除和依赖终态。

## 发现

- [F-PAT-035](../05-findings.md)：团队等待结束后不检查 abort 监听是否摘掉。
- [F-PAT-036](../05-findings.md)：未完成依赖的判定没有锁住 `failed`、`cancelled`、`claimed`、`in_progress`。

下面三条不够格单列：

1. 审批拒绝、未授权门暂停和带 grant 的续跑都断言了暂停阶段与未完成。计划状态机和任务状态机的非法迁移已有用例。
2. `patent-workflow` 的 `src` 没有阶段墙钟超时。重试耗尽和团队等待超时已有用例。
3. 规则加载、结构门、引用门、交付门和输出门的失败路径已有直接断言。

## 假设验证/推翻

H06 仍待验证。今日三包的缺口在团队等待的监听摘除和依赖终态，provider 与 CLI 留到后续日。H01–H05、H07–H10 的验证点不在今日，状态不改。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。三包不在豁免内只说明门禁会测量它们，不代替今日的逐文件数字。
2. 没有删掉 `removeEventListener` 再跑现有套件。结论来自测试文本里没有监听数断言。
3. 没有启动真实成员进程。调度结论来自 `kickMember` 的假 agent 和 `unsatisfiedDependencies` 的纯函数用例。

## 明日第一件事

Day 29（D 测试缺口：`patent-knowledge`、`patent-data`、`patent-document`、`patent-filing`）第一件事：按高风险表面列 happy path，先看空索引、损坏记录、provider 失败和立案组装的用例是否只断言成功结束。渲染监听清理、PDF 清单 sha1、今日的等待监听和依赖终态不要重测。Day 27 已看过立案引擎包装的取消、非零退出和信号终止，Day 29 看包内其余表面。
