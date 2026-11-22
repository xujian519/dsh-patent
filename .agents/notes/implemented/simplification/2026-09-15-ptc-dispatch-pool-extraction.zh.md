# Agent Note：提取 `run_code` 的子分发车道（Issue #86）

Status: implemented

[English](2026-09-15-ptc-dispatch-pool-extraction.md) | 中文

## Problem

`packages/core/tool-executor-ptc/src/ptc.ts` 曾为 492 行，其中 320 行是 `createRunCodeTool` 的 `execute`。这个大函数体大部分在做调度而不是分发：`PendingDispatch` interface、两个队列加三个记账集合、唯一一趟驱动器、结算排空与背压等待——116 行，主语是「一次子分发何时启动与提交」，而不是「一个子分发是什么」。

[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)把这一刀放在批次 3，即那些落在语义上、每一刀都必须证明自己保住了什么的批次。它点名了四处押在行为上的东西：有序提交车道、独占屏障、背压与唤醒顺序防御。

## Decision

`packages/core/tool-executor-ptc/src/ptc.ts`（176 行）导出 `class DispatchPool`；`packages/core/tool-executor-ptc/src/ptc.ts` 为 372 行。

| 搬走的东西 | 在新模块中的形态 |
| --- | --- |
| `PendingDispatch` | `PooledDispatch`，其判别类型复用既有的 `ToolExecutionMode['kind']` |
| `pendingQueue`、`commitQueue`、`inFlight`、`exclusiveActive`、`driving`、`driverRun`、`wake`、`wakeup`、`drive` | `DispatchPool` 的私有状态与它的 `drive()` |
| 放弃排队条目的那次 `runController.signal.aborted` 读取 | `DispatchPoolOptions.isRunOver` |
| `drainDispatches` | `DispatchPool.drain()` |
| `logWork` | 池自己的 `sideWork` 台账，由 `track(work)` 填充 |

车道的输入是一个自带各阶段的条目（`start`、`classify`、`abandon`、`commit`、`flight`、`settled`、`mode`）、并行上限与运行结束探针。车道触达的其余一切都不出这三者，因此传输层继续持有注册表、执行、agent、会话事件追加与 `shapeDispatchLog` 瀑布。

### 三处并非逐行搬移的落位

`runOver` 被提升到池构造之前：车道以 `isRunOver` 接收它，而在构造期读取一个 `const` 否则会落进它的暂时性死区。

背压等待从条目的 `commit()` 移进车道：车道在头部提交之后、释放独占屏障之前施加它。等待与释放都在同一趟车道里，且车道之外没有任何人观测 `commit()` 何时 resolve，因此启动顺序不变。它的理由注释随它移动，它读取的台账也成为池自己的。

结算事件的附带工作从传输层的局部集合移入 `pool.track(work)`，因为约束它的上限现在归车道：一本台账同时装着存活主体与待办追加，`drain()` 与上限便不可能对「这次运行还欠多少工作」给出不同答案。

### 入口保住它的导出清单

`RUN_CODE_NAME`、`CodeRunFailedError`、`RunCodeBridgeOptions` 与 `createRunCodeTool` 均不变，`src/index.ts` 无需编辑。新模块不由包入口再导出（`exports` 列出 `.`、`./invariant`、`./types`、`./presentation`、`./src/*`），也没有新增运行期依赖：它唯一的导入是 `ToolExecutionMode` 类型。

### 测试变得可行，于是补上

`tests/ptc.spec.ts` 保留它的九个调度用例——重叠、独占调用先排空、上限、有序前置执行、屏障覆盖后置执行、结算后仍在途的提交也会排空、乱序完成下的提交顺序、被放弃的排队调用，以及停稳——它们原样通过，这就是本刀的集成证据。它们做不到的是：不围上 `run_code` 程序、代码运行时与工具注册表，就驱动一次车道决策。

`tests/ptc-dispatch-pool.spec.ts` 用八个用例直接驱动车道：乱序结算下的有序提交、跨越一次提交的独占屏障、并行上限、放弃、背压、提交期间登记的附带工作撑住 `drain()`、停稳后的再次提交，以及空池排空。对抽出的车道做六处变异，每处至少挂掉其中一例：

| 对抽出车道的变异 | 挂掉的用例数 |
| --- | --- |
| 提交游标改取任一已结算条目，而不是队首 | 1 |
| 容量恒为真，连带去掉独占规则与上限 | 4 |
| 忽略并行上限判定 | 3 |
| 从不放弃排队的未启动条目 | 1 |
| 去掉背压等待 | 1 |
| `drain()` 不等登记的附带工作就返回 | 1 |

`src/ptc-dispatch-pool.ts` 不在根 `vitest.config.ts` 的豁免名单里，因此逐文件门禁从第一个提交起就对它生效：语句、分支、函数、行均 100%，未写任何豁免。

### Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/core/tools` | 13 文件 / 399 通过（此前 12 / 391，加上 8 个新例） |
| `src/ptc-dispatch-pool.ts` 的覆盖率 | 语句／分支／函数／行均 100% |
| `pnpm run typecheck` | exit 0 |
| 对三个改动文件跑 `pnpm exec tsx scripts/run-oxlint.ts` | 0 警告 0 错误 |
| `pnpm run verify-export-jsdoc` | 每个导出名都有文档 |
| `pnpm run duplication` | 0 处克隆 |
| `pnpm run test:docs` | 18/18 |
| `pnpm run doc-sync` | 33 通过 / 3 失败——既有失败的 doc graphs、config catalog 与 package paths |

## Alternatives considered

- **把绑定工厂连同车道一起抽出，让 `createRunCodeTool` 只剩 schema 与运行调用。** 否决：该工厂闭包捕获注册表、执行、运行控制器、agent、子调用 id 与两处持久事件载荷。独立成模块需要约八个传输层值的依赖清单，并把 `tool/ptc-dispatch` 的载荷搬进一个主题是调度的文件。
- **让附带工作台账留在传输层，只把上限交给车道。** 否决：这个上限同时约束存活主体与待办追加，把台账与读取它的规则拆开，会让同一个界有两个所有者。
- **用车道自有的 map 记录已启动的判别类型，而不是 `PooledDispatch.mode`。** 否决：那会为一个 interface 已经声明的字段多养一个以条目为键的结构，而条目比它这次车道之行活得更久。
- **不写直接 spec，只靠 `ptc.spec.ts` 搬走车道。** 否决，理由是本计划自己的标准：批次 3 的一刀要在能证明自己保住了什么时才落地，而「没有整个 `run_code` 程序就没有测试能触达这条车道」正是本刀要换掉的东西。

## Consequences

`ptc.ts` 减少 120 行，`ptc-dispatch-pool.ts` 为 176 行，因此净增即 interface、它的 JSDoc 与模块头。本包新增一个测试文件、未新增覆盖率豁免；车道的状态从此可以作为一个单元被触达，于是下一次改动它时，失败可以是一例关于顺序的断言，而不是某个程序的结局。批次 3 剩余条目为 `core/session` 的 `Session` 类、`code-runtime-python` 的配置门与进程 supervisor、`ui-trajectory` 的行渲染器，以及以 id 稳定性测试开场的 `analyzer`。

## Related

- [拆分七个上帝文件](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本刀是批次 3 第二刀落地）
- [提取会话的增量折叠](../../archived/simplification/2026-09-14-session-folds-extraction.md)（批次 3 首刀落地）
- [提取 `acp`/`ptc` 簇](2026-09-14-acp-ptc-cluster-extraction.zh.md)（本文件批次 1 的一刀：静态 spec、flavor 表与 JSON 呈现）
- `packages/core/tool-executor-ptc/src/ptc.ts`、`packages/core/tool-executor-ptc/tests/ptc.spec.ts`
