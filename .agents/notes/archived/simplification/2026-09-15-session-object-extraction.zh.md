# Agent Note：提取 `Session` 对象与发布观察者（Issue #86）

Status: implemented
Archived: 2026-11-22

[English](2026-09-15-session-object-extraction.md) | 中文

## Problem

`packages/core/session/src/index.ts` 曾为 904 行，三个主题共用它：`Context`／`Events` 声明与 `SessionStore` 服务、`Session` 对象，以及两条发布路径都要用的监听器分发 helper。仅这个类就占 382 行（126–507），而 store 还从同一个模块取三样东西：它的 `enter`、`detachEntered`、`liveEntryFor` 读写的 `SessionEntry`／`attachments` 对，以及 `announce`、`emitDisposed`、`flush` 解析的观察者。

[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)把这一刀放在批次 3，并点名它的两条约束：`attachments` 与 `SessionEntry` 必须同址，且类的类型字符串被 `tests/typert.spec.ts` 逐字断言。

## Decision

`packages/core/session/src/session.ts`（425 行）与 `packages/core/session/src/observers.ts`（44 行）为新增；`index.ts` 为 488 行。

| 搬走的东西 | 在新模块中的形态 |
| --- | --- |
| `Session`（126–507） | `session.ts`，由入口再导出，`@typert object` 标记原样保留 |
| `SessionEntry`、`attachments`（113–124） | `session.ts`，导出给铸造并读取它们的 store，且不在已发布面上 |
| `SessionCallback`、`collectSessionCallbacks`、`invokeContainedSessionObservers`（95–111） | `observers.ts` |

观察者独立成模块而不是随 `Session` 一起走，因为两侧都要用：`Session.append` 经 `collectSessionCallbacks` 解析自己的 `session/event` 快照并做 containment 调用，store 对 `announce`、`emitDisposed`、`flush` 做同样的事。把它们放进 `session.ts`，就会让 store 从会话模块里导入发布机制；它们现在共享的这个文件，正是它们共同的部分。

### 留下的东西，以及落在哪里

`@typert object` 标记随类移动，类型串 `@deepseek-ai/dsh-session#Session` 在 `SessionStore` 的注册里逐字不变，因此 `tests/typert.spec.ts` 仍断言同一个字面量，它解析出的 lookup 在类声明于别处后依然可用。`Context.sessions`、`Events`、`TypertLookupMap` 声明留在发出这些事件的 store 里，`SessionForkSource`、`SessionForkErrorCode`、`SessionForkError` 与整条 fork 路径同样留下。入口导出清单不变：`Session` 改为 `export { Session } from './session.ts'`，store 为 `prepare` 继续导入它。

搬走的 helper 在新模块里导出，因为 store 要导入它们，而它们都不由包入口再导出——`exports` 仍只列 `.`、`./invariant`、`./types`、`./surface` 与 `./src/*`。`attachments` 原来的注释写着「module-private」；现在它写的是实际成立的事：这一对不在已发布面上。

### 测试，以及证据由什么承载

这一刀换不来新测试：`Session` 早已由 `tests/session.spec.ts`（1838 行）经 `Session.create` 直接构造，每个驱动 store 的套件也都是如此。证据是既有套件原样通过，且逐文件覆盖率门禁覆盖两个新文件：15 文件 / 502 用例，没有任何测试需要新的导入路径，两个模块的语句、分支、函数、行均为 100%，未写任何豁免。

对类的搬迁而言，承重的是 `tests/typert.spec.ts`：它跑真实注册表，解析 `hostTypeSymbol: '@deepseek-ai/dsh-session#Session'`，并调用 `lookup.resolve(session.id)`，所以一处破坏符号解析的搬迁会在那里失败，而不是在类型检查里。`tests/scoped.spec.ts` 与 `tests/session.spec.ts` 覆盖搬走的观察者内部的 containment 路径，包括抛错的监听器与延后 detach 路径。

### Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/core/session` | 15 文件 / 502 通过，无测试需要新导入路径 |
| `src/session.ts` 与 `src/observers.ts` 的覆盖率 | 语句／分支／函数／行均为 100%，无豁免 |
| `pnpm run typecheck` | exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/core/session/src packages/core/session/tests` | 28 文件，0 警告 0 错误 |
| `pnpm run verify-export-jsdoc` | 每个导出名都有文档 |
| `pnpm run duplication` | 0 处克隆 |
| `pnpm run test:docs` | 18/18 |
| `pnpm run doc-sync` | 33 通过 / 3 失败——既有失败的 doc graphs、config catalog 与 package paths |

## Alternatives considered

- **把观察者 helper 留在 `session.ts`。** 否决：store 为 `session/created`、`session/disposed`、`session/flush` 解析并调用监听器时并不碰 `Session` 对象自身的机制，把它们放在会话模块里，只会让 store 再从这个模块导入出去一个并不服务于会话主题的东西。
- **把 `SessionStore` 搬走、`Session` 留在入口。** 否决：`Events` 与 `TypertLookupMap` 声明描述的是 store 的发布协议，把它们与发出它们的类分开，会把同一份协议拆到两个文件里。
- **让 `attachments` 保持模块私有，改成把 entry 传进 `Session.append`。** 否决：追加路径每来一个事件都要读该挂接，这等于把 store 的关切串进计划那条约束所保护的、与 store 无关的公共签名。
- **不导出这两个 helper，改为各写一份。** 否决：containment 正是 `scoped.spec.ts` 所测的不变式；两份副本会漂移，且只有一份被覆盖。

## Consequences

`index.ts` 减少 416 行；`session.ts` 与 `observers.ts` 为 425 与 44，因此净增即两个模块头，加上 store 现在经导入使用的那些 `export` 关键字。store 的文件现在就是 store：它的声明、生命周期与 fork 路径，而会话对象与发布观察者各自独立可读。批次 3 剩余条目为 `code-runtime-python` 的配置门与进程 supervisor、`ui-trajectory` 的行渲染器，以及以 `allocateNodeId` 的 id 稳定性测试开场的 `analyzer`。

## Related

- [拆分七个上帝文件](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本刀是批次 3 第三刀落地）
- [提取会话的增量折叠](2026-09-14-session-folds-extraction.zh.md)（批次 3 针对本文件的第一刀）
- [提取 `run_code` 的子分发车道](2026-09-15-ptc-dispatch-pool-extraction.zh.md)（批次 3 第二刀落地）
- `packages/core/session/src/session.ts`、`packages/core/session/src/observers.ts`、`packages/core/session/tests/typert.spec.ts`
