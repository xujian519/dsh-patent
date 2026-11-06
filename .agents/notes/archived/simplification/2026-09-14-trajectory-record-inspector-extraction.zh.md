# Agent Note: Extracting the trajectory ledger's record inspector and resize handle (Issue #86)

Status: implemented
Archived: 2026-11-07

[English](2026-09-14-trajectory-record-inspector-extraction.md) | 中文

## Problem

批次 1 之后，`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` 为 1768 行。视图本身 —— virtualizer 接线、表格、滚动与跟随 effect —— 占据前三分之二。最后三分之一是一整块 JSX：552 行的 inspector `<aside>`，其开启条件是「是否选中了某条 record 或某个请求」。

那块区域并不自足。它渲染的每个值都在外层 `TrajectoryTable` 函数体里算出，并与表格同样需要的值混在一起：27 个派生自 `selected`、`selectedRequestInfo` 与 `allRecords` 的值，夹在行渲染与消费它们的 JSX 之间，因为组件体只有一个作用域。分隔条的指针捕获拖拽以另一种方式加剧了这一点：67 行 `onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel`/`onKeyDown`/`onDoubleClick` 被写成 JSX 属性，夹在 `<aside>` 开始标签与它渲染的 header 之间。

计划把这一刀列为批次 2 的 `ui-trajectory` 项：inspector 抽成 `RecordInspector`，其拖拽抽成 `useResizeHandle`。与批次 1 不同，它需要先定下一个接口，因为两个组件之间的边界恰恰就是入口计算、inspector 读取的那组值。

## Decision

现在由四个模块承载 inspector 及它与入口共享的词汇。`src/client/TrajectoryTable.tsx` 为 921 行。

| 模块 | 行数 | 承载 |
| --- | --- | --- |
| `src/client/trajectory-record-inspector.tsx` | 732 | `SelectedRequest`、`RecordInspectorProps`、`RecordInspector`，以及私有的 `OverviewSection` |
| `src/client/trajectory-resize-handle.ts` | 159 | `DetailsResizeHandlers`、`DetailsResizeHandle`、`useResizeHandle`、九个 resize 常量、`clampDetailsWidth`、`defaultToolRequestWidth` |
| `src/client/trajectory-kind.tsx` | 96 | `KIND_LABEL_KEY`、`KIND_ICON`、`ToolWrenchIcon`、`InformationIcon`、`CompactedIcon` |
| `src/client/trajectory-detail-tabs.ts` | 80 | `DetailTabItem`、`SYSTEM_PROMPT_TABS`、`SYSTEM_UPDATE_TABS`、`REQUEST_TABS`、`detailTabs`、`requestDetailTabs` |

### inspector 自算派生值

接口的第一版设计是把值传下去：入口保留它的 27 个派生值，并把 inspector 要渲染的那些交给它。那大约是 23 个值加 6 个回调，而且会让入口继续计算里面没有任何其他读者使用的值 —— 与之前同样的耦合，只是写成了 prop 列表。

`RecordInspectorProps` 只有 18 个成员：12 个值加 6 个回调。这些值是输入而非派生 —— `allRecords`、`currentRecord`、`requestNumbers`、`sessionRequestNumbers`、`selected`、`selectedRequest`，外加 `activeTab`、`thinkingExpanded`、`detailsWidth`、`resizeHandlers`、`t`、`renderImages`。27 个派生值全部原样搬进 inspector 函数体，它借以渲染它们的私有 `OverviewSection` 也一并搬入。入口保留其中三个 —— `selectedRequestInfo`、`activeTurn`、`activeSection` —— 外加 `splitStyle`。

`activeSection` 是这次搬迁唯一必须改写而非挪位的派生值。入口原来把它算作 `selectedRequestRecords[0]?.section`，而 `selectedRequestRecords` 在入口已不存在。它现在是 `allRecords.find(record => record.turn === selectedRequestInfo.turn && record.group === selectedRequestInfo.group)?.section`，指向同一个元素：`selectedRequestRecords` 就是按同一谓词做的 `allRecords.filter(…).map(currentRecord)`，而 `currentRecord` 只替换 `cell` 字段，从不改 `section`。

### resize 拖拽变成一个带返回类型的 hook

`useResizeHandle` 持有两个 `useState` 值（`detailsWidth`、`toolRequestOffset`）和拖拽用的 `useRef`，并把它们与一个 `handlers` 对象一起返回。这两个 state 值在本次改动前各自只有一个写入者、且在拖拽之外没有读者，因此完全内聚于该 hook；入口读 `toolRequestOffset` 构造 `splitStyle`，inspector 读 `detailsWidth` 作为宽度。

分隔条元素改为展开 `{...resizeHandlers}`，而不是逐个列出六个属性。这些 handler 读取分隔条的祖先 —— 父节点是 inspector，其宽度被改写；祖父节点是限定该宽度的 split 容器 —— 因此 hook 不需要元素参数，JSX 也就保持原有结构。

### 共享词汇必须离开入口

入口 import inspector，因此 inspector 不能 import 入口：`detailTabs`、`DetailTabItem`、`KIND_LABEL_KEY` 两边都读，必须落到两者都不拥有的模块里。`trajectory-detail-tabs.ts` 承接 tab 词汇；`trajectory-kind.tsx` 在 `KIND_ICON` 旁承接 `KIND_LABEL_KEY` —— 后者只有入口读，但它与前者由同三个图标字形构成，属于同一处。

`requestDetailTabs(hasOptions)` 是新增的，它是入口原有内联表达式提升而成的具名函数：`REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)`。三张 tab 表在 `trajectory-detail-tabs.ts` 中保持模块私有；只导出读取它们的两个函数。

### 本刀移动了常量，与批次 1 不同

[批次 1 的记录](2026-09-14-trajectory-ledger-module-extraction.zh.md)记下了三张 tab 表留在入口，因为批次 1 的验收标准是「不移动任何常量」。那条规则属于批次 1，而本刀是批次 2：九个 resize 常量随其唯一读者一起搬走，三张 tab 表随 `detailTabs` 与 `requestDetailTabs` 一起搬走。

批次 1 记录给出的「保留这些表」的理由也已失效。该理由基于 `REQUEST_TABS` 在 tab 条 JSX 中有一个入口侧的直读点。那块 JSX 现在位于 inspector 内，因此三张表的两个读者都在新模块里。

### 这次搬迁保持行为不变，并经过机械校验

`<aside>` 区域与 27 个派生值是按文本抽取的，随后用归一化 diff 与原文件比对。inspector 的 props 所重命名的那些名字 —— `activateTab` → `onActivateTab`、`clearInspectorSelection` → `onClearSelection`、`openRecordSummary` → `onOpenRecordSummary`、`openCallSummary` → `onOpenCallSummary`、`selectRequest` → `onSelectRequest`、`setThinkingExpanded` → `onThinkingExpandedChange` —— 在比对前映射回原名，被 hook 取代的 resize handler 属性块则被排除。结果是：JSX 区域 0 行差异，派生值块 2 处预期差异 —— 留在入口的两行（`activeTurn`、`activeSection`），以及 `selectedTabs` 上的一处类型标注。

那处标注是搬迁文本内唯一的改动：`selectedTabs: readonly DetailTabItem[]`，因为 `requestDetailTabs` 返回具名类型，而原先的内联 `filter` 推断出匿名数组类型。

## Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --noEmit` | 通过 |
| `pnpm exec vitest run packages/client/ui-trajectory` | 9 文件 / 149 通过 —— 与改动前的计数一致 |
| `pnpm exec vitest run packages/client` | 531 文件 / 7150 通过，5 跳过 |
| `pnpm exec tsc -b tsconfig.client.json` | 退出码 0，无诊断 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory/src` | 通过 |
| `pnpm exec tsx scripts/verify-export-jsdoc.ts` | 通过 |
| `pnpm run duplication` | 2205 个文件中 0 处克隆 |
| `pnpm run test:docs` | 18 通过，0 失败 |
| `<aside>` 区域的归一化 diff | 0 行差异 |
| 27 个派生值的归一化 diff | 2 处预期差异，均在搬迁文本之外 |

批次 2 的验收标准成立。入口导出同样的四个名字 —— `TrajectoryTable`、`TrajectoryTableProps`、`TrajectoryRequestNumber`、`TrajectoryUsage` —— 且 `tests/table.client.spec.tsx` 仍从 `../src/client/TrajectoryTable.tsx` 导入。包的 `./client` 子路径从未指向本模块。

`verify-export-jsdoc` 扫描 `packages/*/*/src/**/*.ts` 而不含 `.tsx`。四个新模块中有两个是 `.ts`（`trajectory-detail-tabs.ts`、`trajectory-resize-handle.ts`）；它们的七个导出补上了门禁要求的 JSDoc，契约不显然的接口成员同样补上。另外两个是 `.tsx`，与其来源入口一样不在该门禁范围内。

逐文件覆盖率门禁在此不适用，理由与批次 1 记录相同：`vitest.config.ts` 列出的是 `packages/client/ui-trajectory/src/*`，其 test-exclude 展开覆盖整棵源码子树，因此报告的覆盖率从不包含本包文件。包 README 无需改动 —— 它用一句话描述视图行为与 inspector 的内容，不含模块清单。

## Alternatives considered

- **把派生值作为 props 传下去。** 否决：那会让 prop 列表承载 inspector 本可从已有数据算出的内容，并把 23 个只有单一读者的派生值留在入口。选定的切法把派生值随其唯一读者一起搬走，使 prop 列表保持 18 项。
- **把 `SelectedRequest` 留在入口、由 inspector 导入。** 否决：这正是本刀要避免的循环 —— 入口为 `RecordInspector` 导入 inspector，inspector 又会为类型导入入口。
- **用 `trajectory-inspector-types.ts` 承载共享词汇，而不是两个主题模块。** 否决：这些共享名字并非同一套词汇。`detailTabs` 及其表是 tab 选择；`KIND_LABEL_KEY` 与 `KIND_ICON` 是 cell 呈现。为两者合设一个模块，它不会被恰当命名。
- **把三张 tab 表留在入口并导出给 inspector。** 否决：`SYSTEM_PROMPT_TABS` 与 `SYSTEM_UPDATE_TABS` 在入口没有读者，而导出这些表会让入口的导出列表超出批次 2 要求它保留的四个名字。
- **把 `KIND_ICON` 留在入口，只搬 `KIND_LABEL_KEY`。** 否决：两者以同一个 `TrajectoryCellKind` 为键，且 `KIND_ICON` 由那三个没有其他读者的字形组件构成。把一张表与另一张拆开，会让三个字形组件留在入口、而其唯一消费者在别处。
- **拆分 CSS 模块，让 inspector 不再 import `TrajectoryTable.module.css`。** 否决：那会在搬 JSX 的同一刀里转移类名归属，而样式表并不是让文件难读的原因。后续的刀可以另行决定 inspector 的类名落在哪里。
- **把 inspector 的提前返回折进一个包装组件。** 否决：该守卫原本就是入口的 JSX 条件，包装组件只会增加一个「重查 inspector 已有输入的条件」的组件。它是一个放在 `useMemo` 之后的提前返回，这正是 Hooks 规则要求的位置。

## Consequences

入口删除 884 行、新增 37 行 —— import、`useResizeHandle` 调用、三个留下的派生值、`<RecordInspector>` 元素 —— 净减 847 行。四个新模块合计 1067 行。没有任何内容被删除：每一行搬迁代码都在原名下存在，只有六个回调被重命名、一处类型标注是新加的。

本刀必须定下的接口现在已被声明：`RecordInspectorProps` 指明面板所需的 18 项输入，`DetailsResizeHandle` 指明分隔条拥有什么。两者此前都隐含在一个 1768 行的闭包里。这就是本刀按计划标准给出的证成 —— 不是「某个测试变得可行」，而是「某个接口变得显式」。

inspector 现在是包内最大的模块，732 行 JSX。它仍是单组件、单提前返回；把它的 tab 面板拆成组件将需要先定下类名与 `t` 座位的归属，本刀没有动这一块。

本刀保留而非制造了两处不对称。`trajectory-detail-tabs.ts` 是 `.ts` 模块却从 `.tsx` 模块导入 `isMarkdownRecord`，因为 `detailTabs` 要按 record 是否以 Markdown 渲染来分支；替代方案是复制那个谓词。而 `trajectory-kind.tsx` 导出一张 React 节点表，因此它是 `.tsx` 而它的邻居是 `.ts` —— 两个文件承载同一套词汇的两半，一半是纯逻辑，一半是渲染。

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本刀是它批次 2 的 `ui-trajectory` inspector 项）
- [Extracting the trajectory ledger's record model and presentation helpers](2026-09-14-trajectory-ledger-module-extraction.zh.md)（批次 1 同族；定下 `src/types.ts` 作为包的词汇归属处，并按批次 1 的「不移动常量」规则把 tab 表留在入口）
- [Extracting the python runtime's cost and log-ledger modules](2026-09-14-code-runtime-python-cost-and-ledger.zh.md)（批次 1 试点）
- `packages/AGENTS.md`（包的接缝词汇归属处）
