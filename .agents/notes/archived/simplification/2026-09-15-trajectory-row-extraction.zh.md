# Agent Note：提取轨迹账本的行组件（Issue #86）

Status: implemented
Archived: 2026-11-07

[English](2026-09-15-trajectory-row-extraction.md) | 中文

## Problem

`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` 曾为 921 行，其中 255 行落在一个 `renderedRecords.map` 回调里：该行的逐记录标记、ARIA 属性、十一个 `data-*` 属性、三个输入处理器，以及它渲染的两个单元格。文件里没有别处读这些值，而账本把它经一个 `RecordPresentation` render prop 传下去，这个 prop 存在的唯一理由是让该行自己算出显示文案。

[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)把这一刀放在批次 3，并点名了让它留在那里的风险：该行捕获了账本的派生值与回调，显式传递约需 45 个 prop，而 memo 边界一旦处理不慎，就会在父组件每次重渲时重渲每个可见行，把虚拟化的收益还回去。

## Decision

`packages/client/ui-trajectory/src/client/trajectory-row.tsx`（344 行）导出 `TrajectoryRow`（一个 `memo` 组件）与 `TrajectoryRowProps`；`TrajectoryTable.tsx` 为 693 行。

| 搬走的东西 | 在新模块中的形态 |
| --- | --- |
| `<tr>`、它的 `<td className={css.event}>` 与 `<td className={css.content}>` | `TrajectoryRow` 返回的元素 |
| `isCollapsedSummary`、`isRequestOnly`、`isInitialSystem` | 该行渲染内的局部常量 |
| `request`、`requestInfo`、`requestStatus`、`requestRunIndex`、`requestLabel`、`requestSelected` | 该行渲染内的局部常量，把两个请求索引当作 prop 读取 |
| `sectionActive`、选中比较、时间线聚焦查询 | 账本算好的 prop（`sectionActive`、`selected`、`timelineFocus`） |
| `RequestBoundaryStyle` | 行模块的私有样式类型 |
| `RecordPresentation` 的 render prop 体 | 该行，由它持有这层包装 |

### 账本先算好的 prop，让比较得以成立

`selected`、`sectionActive` 与 `timelineFocus` 是账本 map 里算出的布尔值（或聚焦字面量），`selectedRequestIdentity` 取代了 `SelectedRequest` 对象。它们都是浅比较能抓住的值：一次选中现在只重渲被选中的行及其所在轮的其余行，而旧结构会重渲每个已挂载行。`requestBoundaryRuns` 作为偏移量的查询表随行传递。

### 保住自身标识的回调

该行接收 `onSelectRecord`、`onSelectRequest`、`onToggleTurn` 与 `onToggleAssistant`。第一个本就是 `useCallback`；`selectRequest` 及它依赖的 `activateTab` 改成了。`toggleTurn` 与 `toggleAssistant` 住在 `TrajectoryView.tsx`，原本是普通函数、每次视图重渲都会重建；两者都是 `setState` updater 闭包，因此取空依赖表。

其余回调的标识未动。`openRecordSummary`、`openCallSummary` 与 `onClearSelection` 保持原形：没有任何行接收它们，而 memo 边界本来就已把行与它们隔开。

### 测试变得可行，于是补上

`RecordPresentation` 是该行唯一的消费方，因此一个只包装它的局部模块 mock 就能数出行渲染次数，而不改变账本显示的内容。

| 用例 | 位置 | 钉住什么 |
| --- | --- | --- |
| 不改动任何行输入的父级重渲，六个已挂载行一律不动 | `tests/table-row.client.spec.tsx` | 边界对全部六行比较相等，同时父级确实重渲了（加载状态出现） |
| 一次选中只重渲自身输入改变的行 | `tests/table-row.client.spec.tsx` | 六行中恰好两行重渲 |
| 视图在已挂载行周围重渲 | `tests/views.client.spec.tsx` | 切换时间线模式会重渲视图，且不重渲任何行 |

| 变异 | 挂掉的用例 |
| --- | --- |
| `memo` 换成恒等函数 | 三例全挂 |
| 某个行 prop 变成内联箭头函数 | 三例全挂 |
| `toggleTurn` 去掉 `useCallback` | 视图那条用例 |
| `onClearSelection` 变成内联箭头函数 | 无——它是账本自身消费、无行读取的 prop |

最后一行是这个守卫的边界，如实记录而非糊过去：它数的是行渲染次数，因此只有账本自身消费的回调不在其内。

### Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/client/ui-trajectory` | 10 文件 / 152 通过（此前 149，加上三个新例） |
| `apps/web/tests/trajectory-virtualization.e2e.ts`（无密钥回放、真实 Chromium、构建产物） | 1 通过：选中、前插的身份保持、挂载行上限，以及每一段滚动范围 |
| `pnpm exec tsc -b tsconfig.client.json` | exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory` | 0 警告 0 错误 |
| 覆盖率 | 不受门禁：`packages/client/ui-trajectory/src/*` 是既有的 `TODO(gui)` 豁免，因此本文件无需自建豁免 |

## Alternatives considered

- **按计划的估算，把账本的派生值逐个作为 prop 传入。** 否决：该行需要 `requestInfo`、`requestStatus` 与 `requestLabel`，即每行三次对 `sessionRequestNumbers` 的查找；在账本 map 里先算它们，等于用一个更臃肿的 map 换一份 20 项的 prop 清单，工作量不变。
- **只给行加 memo，不去稳定视图的两个折叠加回调。** 否决：流式期间视图随每个快照重渲，那两个不稳定的回调每次都会比较不等，边界就永远不成立。
- **把账本接收的每个回调都稳定化。** 否决，理由是不必要：上面的变异显示，行对无人读取的回调完全不受影响，那些改动会是无从验证的改动。
- **用 DOM 断言边界而不是数渲染次数。** 否决：无论是否重渲，React 都保持同一批 DOM 节点，因此节点标识分不出「跳过渲染」与「重复渲染」。

## Consequences

`TrajectoryTable.tsx` 减少 228 行，`trajectory-row.tsx` 为 344 行，因此净增即 props interface、它的 JSDoc 与模块头。账本的行从此是一个输入清单明确的单元，而计划标为本刀风险的 memo 边界由三个用例钉住，不再只是一句注释。批次 3 的剩余条目是 `code-runtime-python` 的配置门与进程 supervisor，以及 id 稳定性前置件已落地的 `analyzer`。

## Related

- [拆分七个上帝文件](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本刀是批次 3 第四刀落地）
- [提取 `Session` 对象与发布观察者](2026-09-15-session-object-extraction.zh.md)（批次 3 第三刀落地）
- [提取记录检查器](2026-09-14-trajectory-record-inspector-extraction.zh.md)（本文件批次 2 的一刀：`<aside>` 面板与它的拖拽缩放）
- `packages/client/ui-trajectory/src/client/trajectory-row.tsx`、`packages/client/ui-trajectory/tests/table-row.client.spec.tsx`
