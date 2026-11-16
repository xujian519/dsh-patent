# Day 14 — 2026-11-28

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：专利域-2：patent-workflow、patent-rule、patent-teams
- 时间盒：90 分钟
- 预期产出：B 维度专利域候选发现；daily/day-14.md

## 检查项

- [x] 检查状态机、存储与审批的重复抽象。
- [x] 检查规则资产加载与编译的重复。
- [x] 检查团队调度与任务板的重复。
- [x] 查找可删除的兼容层与转发函数。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与体量（15 分钟）**：`find … -name '*.ts' -exec wc -l` 得 `patent-workflow/src` 16 文件 4733 行、`patent-rule/src` 23 文件 5597 行、`patent-teams/src` 20 文件 5746 行。三包各自前十只有三个文件超过 700 行：`patent-workflow/src/workflow/manifests.ts` 960（常量 + `buildContestedManifest` 构造 8 个 manifest，体量来自数据）、`patent-rule/src/runtime/RuleLoader.ts` 780（单一职责的解析与校验）、`patent-teams/src/service.ts` 719（对外服务门面）。没有 Day 13 那种「一个文件里塞两套语言」的热点。

**孤儿模块与同名重复（10 分钟）**：从三包入口沿 import 图做可达性扫描，孤立模块 0 个；包内同名函数 0 组。`jscpd` 用仓库默认阈值（60 token / 6 行）得 0 克隆，与 Day 13 的专利域-1 一致，说明这三包的结构重复都在短函数与惯用法层面，工具阈值看不到。

**检查项 ①：状态机、存储与审批（20 分钟）**：三处都逐对读了实现。状态机有两套——`patent-workflow/src/plantask.ts:94` 的 `PlanTaskStateMachine`（`TRANSITIONS` 表 + 守卫 + `PlanTaskStateError` 抛错）与 `patent-teams/src/state.ts:47` 的 `TASK_TRANSITIONS`/`transitionError`（表 + 返回错误字符串，无守卫）。状态集（计划生命周期 5 态 / 任务 6 态）与失败契约（抛错 / 返回可读指导）都不同，抽一个泛型迁移器要同时容纳两种错误契约与守卫插槽，**判为非重复，不建议提取**。存储层两个适配器 `JsonFileWorkflowRunStore`（`workflow-store.ts:261`）与 `JsonFileFlexiblePlanStore`（`flexible-plan-store.ts:27`）都建在 `JsonFileStore` 上，前者补 `runId` 缺省与事件追加，后者补 `caseId` 与文件名一致性校验，**判为非重复**。审批只有一套 seam、三个消费者：`patent-workflow/src/index.ts:221`、`patent-rule/src/index.ts:572`、`patent-teams/src/approval.ts:59`；`patent-workflow` 没有导入 `dsh-user-approval` 而自己声明结构化的 `PatentApprovalSeam`（`types.ts:163`–`171`），JSDoc 明写这是为了让审批保持可选组合、本包对 `dsh-user-approval` 无编译期依赖——**有意为之，不记为缺陷**。反而是装配层的默认值暴露了重复，见 F-PAT-024。

**检查项 ②：规则资产加载与编译（15 分钟）**：加载路径没有第二份实现——候选目录集中在 `asset-location.ts:44` 的 `candidateRuleDirs`，装配复用 `RuleLoader.loadRuleSetDir` + `mergeRuleSets`，规则包清单走 `rule-pack.ts`，`patent-compliance.ts` 的 `parseActivationPatch`（`applyActivationPatch`）与 `loadActivationOverrides`（`RuleLoader` 侧施加）是「解析 / 施加」互补，不是同一件事写两遍；`asRecord` 也统一来自 `@deepseek-ai/dsh-value`（经 `RuleLoader.ts:57` 再导出）。真正的重复只在失败处理：`doc.errors[0]?.message ?? 'unknown'` 5 处、顶层对象校验两种写法，见 F-PAT-025。

**检查项 ③：团队调度与任务板（15 分钟）**：就绪判定只有一个来源——`state.ts:38` 的 `unsatisfiedDependencies` 同时被 `scheduler.ts:144` 的 `nextReadyTask` 与 `task-ops.ts:463` 使用，任务板没有第二份查询。降到 40 token / 4 行后 `jscpd` 在 `patent-teams` 得到 5 组 27 行克隆，逐处读上下文后合并为一条发现，并补出两处语义分叉（邮箱 ack/release 两种判定、`task-updated` 会话解析两种写法），见 F-PAT-026。

**检查项 ④：兼容层与转发函数（15 分钟）**：`git grep -nE 'deprecated|legacy|历史|已废弃|兼容'` 在三个包命中 5 处，逐条判定全部是当前行为的描述（`RuleEngine.ts:470` 的「缺省不过滤」、`RuleLoader.ts:4` 的两种 rules 形态、`patent-compliance.ts:343` 的历史行为一致、`task-ops.ts:291` 的 legacy 记录迁移处理、`manifests.ts:927` 的「审查历史」），**没有可删的兼容层**。再对三包 196 个导出函数做仓内消费者普查：零非测试消费者的只有 `patent-teams` 的 `activateTaskAttempt` 与 `memberWelcome`，两者都在同文件内被调用（`beginTaskAttempt` 与 `members.ts:444`），导出只是为测试，属内部面，不构成死代码；`patent-teams` 的 `index.ts` 除插件协议面（`name`/`inject`/`Config`/`apply`）外只导出 `PatentTeamsService` 与 `PatentTeamsConfig`，其余模块不对外。唯一的纯转发函数是 `patent-workflow/src/workflow-dag.ts:59` 的 `validateWorkflowManifestDag`，函数体一行 `manifestToFlowGraph(manifest).validate()`，仓内消费者只有自己的测试——但它是有 JSDoc 的公开便利入口（调用方不必先构造图），与 Day 13 对 `SectionSourceError` 的判定一致，**保留，不计为缺陷**。重导出模块（只有 `export *` 的文件）0 个。

## 发现

新增 3 条，均含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-PAT-024 | 插件默认值两份来源：`patent-teams` 10 处、`patent-rule` 7 处 | 约 17 行重复默认 + 消除「半解析配置」 |
| F-PAT-025 | 规则资产 YAML 失败处理惯用法重复 5 处，顶层对象校验两种写法 | 约 5–8 行 + 4 处 `v8 ignore` 并为 1 |
| F-PAT-026 | `patent-teams` 内部 5 处结构克隆，事件载荷与邮箱结算各有两个编码 | 约 18–22 行 + 两组语义单点化 |

F-PAT-024 是 F-DOC-004 同一根因在专利域的复现，且同域已有正确模板：`patent-workflow/src/index.ts:59`–`71` 的 schema 只做校验（`z.natural()`），缺省值在 `resolveWorkflowConfig` 落定一次，JSDoc 明写这两件事。修复建议因此可以照搬已经落地的 `z<Partial<Config>, Config>` 写法，不必新造约定。

## 假设验证/推翻

H09（四个 preset 手工列包）与今日范围无交集，仍待定，留给 Day 19。其余假设不更新。

各检查项的结论分布：①③ 有实质发现（配置默认值、结构克隆），② 只有惯用法层面的重复，④ 是干净的否定结论。三个包里没有出现 Day 13 那种「同一语义两份实现」，重复集中在配置装配与事件载荷两处。

## 未决问题

1. F-PAT-024 的两种修法对外都改变 `Config` 类型（字段从可选变必填，或 schema 去掉 `.default`）。是否需要在同一次改动里同时改三包（含 `patent-workflow` 的注释措辞），还是只修有问题的两包，取决于是否有仓外 preset 直接引用 `Config` 类型；需一次 `~/.dsh` preset 普查。
2. F-PAT-025 的 `parseYamlRecord` 若放进 `asset-location.ts`，该文件会从「路径解析」变成「路径 + YAML 解析」，与 Day 13 的 F-PAT-022 同类；放进新的 `runtime/yaml-asset.ts` 则多一个单职责文件。倾向前者把 YAML 解析留在各自的加载器、只共享一个 6 行的 `yamlError` 格式化函数，执行前需再读一次 `asset-location.ts` 的边界声明。
3. F-PAT-026 里 `patent-teams/task-updated` 的 3 处载荷中，`task-ops.ts:374` 传 `agent.session` 而另两处走 `captainSessionOf`；这处差异是「重指派由队长发起」的语义，抽 helper 时必须保留在调用点，否则会把一个有意义的差异藏进参数默认值。实施时要配一条断言两类会话来源的测试。

## 明日第一件事

Day 15（专利域-3：`patent-knowledge`、`patent-data`、`patent-document`、`patent-filing`、`writing-patterns`）第一件事：读 `packages/patent/patent-data/src/index.ts:88`–`96` 的再导出面与 `docs/upgrade-guide/v0.2.2-alpha.2/` 里的保留声明，判定 F-PAT-007 尾项（再导出 + 149 行测试）能否按当前升级指南口径删除——它落在明日范围内，是唯一已确认、只差口径的待办。
