# Agent Note: Extracting the trajectory ledger's record model and presentation helpers (Issue #86)

Status: implemented

[English](2026-09-14-trajectory-ledger-module-extraction.md) | 中文

## Problem

`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` 达到 3208 行、110 个顶层声明。这些声明里只有最后几个属于视图本身：`TrajectoryTable` 以及它直接拥有的三个辅助 —— `useStableVirtualRowStructure`、resize 拖拽状态、Overview 区块。它上面的全部内容都是模块级的：把分组后的 turn 转成台账行的 record 投影层、这些行所依赖的类型词汇，以及把一条 record 映射为其渲染部件的六个 presentation helper 族。

文件自身的排列方式在这一点上起了反作用：声明按主题分组，而不是按调用关系分组，因此想改动「某个请求的失败文案如何显示」的读者，必须在同时容纳 virtualizer 接线和指针捕获拖拽的 3200 行里找到 `requestErrorMessage`。六个 presentation 族互不调用；投影层不调用其中任何一个。

[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)把这一刀列为批次 1 的 `ui-trajectory` 项。本记录记下这一刀产出了什么。

## Decision

现在由八个模块承载原文件，本刀落地时 `src/client/TrajectoryTable.tsx` 为 1768 行。110 个声明全部保留原名与原函数体：搬迁区间与离开入口的代码逐字节相同，留在入口的 38 个声明也逐字节相同，只有入口新需要的 import 接线是新增的。

| 模块 | 行数 | 搬迁 | 承载 |
| --- | --- | --- | --- |
| `src/types.ts` | 136 | 94 | `TableRecord`、`DetailTab`、`RecordState`、`ParentRecords`、`TrajectoryRequestNumber`、`TrajectoryUsage`、`jsonTreeLabels`、`markdownLabels` |
| `src/client/trajectory-record-model.ts` | 363 | 248 | 16 个声明：投影（`flattenRecords`、`filterRecords`）、请求索引（`requestKey`、`requestIdentity`、`indexRequestBoundaries`、`indexRequestNumbers`、`indexRequestBoundaryRuns`）、折叠（`collapseTurnRecords`、`collapseAssistantRecords`），以及逐 record 的读取器（`stateOf`、`statusLabel`、`requestErrorMessage`、`sectionLabel`、`assistantToolCalls`） |
| `src/client/trajectory-usage-panel.tsx` | 115 | 102 | `TokenRows`、`inputTotal`、`UsageRows`、`RequestUsagePanel` |
| `src/client/trajectory-timing.tsx` | 154 | 132 | `formatDurationMs`、`formatStartedAt`、`StartedAtValue` 控件、`totalTime`、`ttft`、`generationTime`、`throughput`、`AssistantTimingPanel`、`RecordTiming`、`RequestTiming`、`clickSelectsText` |
| `src/client/trajectory-record-presentation.tsx` | 220 | 193 | `messageSourceLabel`、`MessageSource`、`isMarkdownRecord`、`parentRecords`、`markdownSource`、`recordDisplayText`、`recordResultText`、`toolCallTextParts`、`isToolCallOnly`、`RecordPresentationValue`、`ToolCallTextParts`、`RecordPresentation`、`RecordListText` |
| `src/client/trajectory-markdown-content.tsx` | 291 | 270 | `MarkdownFragment`、`SourceBlocks`、`recordImages`、`MessageImages`、`AssistantToolCalls`、`MarkdownRecordContent` |
| `src/client/trajectory-prompt-diff.tsx` | 143 | 126 | `ToolGlyph`、`ToolCatalog`、`PromptDiffLine`、`promptDiffLines`、`PromptDiffSection`、`SystemPromptDiff` |
| `src/client/trajectory-record-payload.tsx` | 240 | 222 | `RequestOptions`、`ToolOutputBlocks`、`RecordPayload`、`RecordSchema`、`ParsedToolSchema`、`parseToolSchema`、`parseJsonContainer` |

### 这一刀在构造上保持行为不变

搬迁区间用两侧同一套 span 算法逐声明与原文比对。110 个声明全部以原名出现在新树中，无遗漏、无改名。1387 行搬迁内容逐字节相同，38 个留在入口的声明同样逐字节相同。没有函数体、常量、默认值或 schema 值被改动。

有一条注释随它描述的代码移动并保持原样：`trajectory-markdown-content.tsx` 中那三行注释，记录 Raw 视图保持模型 block 的顺序与粒度，与同一文件另一处渲染的聚合 record 图库不同。计划的第一条规则在这里不适用 —— `TrajectoryTable.tsx` 不含 `/* jscpd:ignore-start */` 块，计划自己的名单也从未列入它。

### 三张 tab 常量表留在入口

这一刀的第一版把 `DetailTabItem`、`SYSTEM_PROMPT_TABS`、`SYSTEM_UPDATE_TABS`、`REQUEST_TABS` 随读取它们的 `detailTabs` 一起搬进了 `trajectory-record-presentation.tsx`。这是错的，而指出它错的正是计划自己的批次 1 规则：**批次 1 不移动常量。** `readonly DetailTabItem[]` 表是常量值，而且 `REQUEST_TABS` 还被入口自己的 tab 条 JSX 直接读取，不只有 `detailTabs` 读它。

五个声明现全部回到入口。判定依据是机械可查的：三张表只被 `detailTabs` 引用，`detailTabs` 只被 `TrajectoryTable` 引用，`REQUEST_TABS` 被 `TrajectoryTable` 直接引用。入口之外没有任何地方提到它们，所以留在入口不产生额外 import 边，而移动它们则会把常量放进一个以「presentation helper」命名的模块。

批次 2 把这五个声明一起移进了 `trajectory-detail-tabs.ts`。inspector 的 tab 条 JSX 在那一刀里离开了入口，因此三张表的所有读者都在新模块内，批次 1 的「不移动常量」规则不再适用。[那份记录](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md)记下了这次移动。

### 共享词汇为何落到 `src/types.ts`

`TableRecord`、`RecordState`、`ParentRecords`、`DetailTab` 被投影层、presentation helper、以及入口自身的 JSX 同时读取。若把它们留在入口、由投影模块去 import，就会让 import 图成环，因为入口 import 了投影模块。

它们移入新建的 `src/types.ts`，`packages/AGENTS.md` 已经把包的接缝词汇安放在那里 —— 「its types plus the runtime values that vocabulary defines」（其类型，以及该词汇所定义的运行期值）。那里的两个运行期值 `jsonTreeLabels` 与 `markdownLabels` 正是如此：它们是该词汇为 record 面板所读的、由 locale 派生的标签表定义的构造器。该文件不转发任何其他模块的运行期值，符合那条规则。本改动援引计划的第三条规则所提的 Issue #99 例外，与 analyzer 的 `types.ts` 做法一致。

入口保留全部四个导出名。`TrajectoryRequestNumber` 与 `TrajectoryUsage` 现在经 `export type { TrajectoryRequestNumber, TrajectoryUsage } from '../types.ts'` 出栈。这两个导出是模块级的而非包级的：`TrajectoryTable` 与 `TrajectoryTableProps` 由 `TrajectoryView.tsx` 和表格 spec 消费。两个消费方仍沿用原来的路径 import `./TrajectoryTable.tsx`。包的 `./client` 子路径 —— `src/client/index.ts` —— 从未指名这个模块，因此也无需改动。

### 出口清单按名比对，而非按行

入口在切割前后各声明四个导出。按行 `grep '^export'` 会报「前 4 后 3」，因为旧文件把 `export type TrajectoryRequestNumber = …` 与 `export interface TrajectoryUsage` 写成两行，而新文件用一个花括号语句同时重新导出两者 —— 名字相同，行数不同。改为提取名字而非数行，两侧都得 `TrajectoryRequestNumber`、`TrajectoryTable`、`TrajectoryTableProps`、`TrajectoryUsage`。

### 本次搬迁必须补的 JSDoc

`verify-export-jsdoc` 扫描 `packages/*/*/src/**/*.ts` 而不扫 `.tsx`。八个新模块里有两个是 `.ts`（`types.ts`、`trajectory-record-model.ts`）；其余六个是 `.tsx`，与它们住在 `TrajectoryTable.tsx` 里时一样，位于该门禁之外。两个 `.ts` 模块的十六个函数导出补上了 `@param`/`@returns` 块 —— 共 29 行 `@param` —— 六个类型导出各补一行描述。这些 JSDoc 加上模块头与 import，就是八个新文件在 1387 行搬迁代码之外多出的 275 行。

## Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --noEmit` | 通过 |
| `pnpm exec tsc -p packages/client/ui-trajectory/tsconfig.json --emitDeclarationOnly` | 通过 |
| `pnpm exec vitest run packages/client/ui-trajectory` | 9 文件 / 149 通过 —— 与切割前相同 |
| `pnpm run typecheck` | 通过，覆盖该包 `./client` 子路径的跨包消费方 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-trajectory/src` | 通过 |
| `pnpm exec tsx scripts/verify-export-jsdoc.ts` | 通过 |
| `pnpm run duplication` | 0 处克隆，覆盖 2205 个文件 |
| 逐字节比对 | 1387 行搬迁内容与 38 个留存声明全部一致；110 个声明名全部在位 |
| 出口名比对 | 两侧同为 4 个名字 |

批次 1 的验收标准成立：入口导出同名，没有测试需要新的 import 路径（`tests/table.client.spec.tsx` 仍从 `../src/client/TrajectoryTable.tsx` import），没有常量、默认值或 schema 值被移动。

逐文件覆盖率门禁在此不适用：`vitest.config.ts` 列出的 `packages/client/ui-trajectory/src/*`，经 test-exclude 展开后覆盖整棵源码子树，因此报告的覆盖率从未包含本包文件，覆盖它们不构成本刀的证据。包 README 无需改动：它描述视图行为，不载模块清单，其中没有陈述过期。

## Alternatives considered

- **把三张 tab 表移进 presentation 模块。** 已否决并回退：批次 1 禁止移动常量，而 `REQUEST_TABS` 有一个入口侧读者，第一版的调用方分析漏掉了它，因为它只在 `detailTabs` 内部搜索该名字。
- **把共享词汇留在入口，由 `trajectory-record-model.ts` 去 import。** 已否决：入口 import 了投影模块，这正是拆分要避免的环。
- **新建 `trajectory-types.ts` 与其他新文件并列，而非用 `src/types.ts`。** 已否决：`packages/AGENTS.md` 为包的接缝词汇指定了唯一归宿，且 analyzer 那一刀已经确立了它。另设一个不同名的归宿会让下一个包的选择变成口味问题。
- **在同一刀里拆分入口的 `TrajectoryTable` 组件。** 已否决：计划把 inspector 的 `<aside>` 与 resize 拖拽放进批次 2，那里需要先定下 `RecordInspector` 接口与 `useResizeHandle`。在这里做会让那次接口设计成为本次搬迁的前提条件。
- **把六个 presentation 族合并为更少的模块。** 已否决：它们之间没有任何边 —— 用量面板、计时面板、record presentation、Markdown 内容、prompt diff、record payload 各自读取一条 record 并渲染它，互不 import。合并任意两个都会造出今天不存在的 import。
- **只移动 `detailTabs` 而不移动三张表。** 已否决：`detailTabs` 读全部三张表，且入口的 tab 条 JSX 在两处调用它，所以它必须留在调用方所在之处。
- **从入口重新导出搬迁的 helper。** 已否决：入口不消费的那些此前并未导出，现在导出会把模块的出口清单撑到超出批次 1 要求保留的四个名字。

## Consequences

`TrajectoryTable.tsx` 缩短 1440 行，本刀后只保留视图以及视图直接拥有的 38 个声明。代价是记账：搬迁 1387 行，八个新文件共 1662 行，入口十行 import 接线 —— 九条 import 加那条双名重新导出 —— 替换掉入口不再需要的 import。275 行的增长来自模块头、import，以及 `verify-export-jsdoc` 对两个 `.ts` 模块导出所要求的 JSDoc。没有任何内容被删除或重写。

这次搬迁让批次 2 的切口变得可度量。计划希望抽成 `RecordInspector` 的 inspector `<aside>`，当时是入口里仅剩的大块 JSX 区域；它渲染所经的六个 presentation 模块已经是独立文件，因此那一刀需要定下的接口，无需读过 virtualizer 就能看见。那一刀已经落地：[inspector 提取记录](../../archived/simplification/2026-09-14-trajectory-record-inspector-extraction.md)记下了它定下的 18 项 `RecordInspectorProps`，以及取代拖拽的 `useResizeHandle`。

有一处不对称是这一刀保留而非造成的：`trajectory-record-presentation.tsx` 同时承载 record 转文本的读取器（`markdownSource`、`recordDisplayText`、`recordResultText`）与渲染它们的 React 组件（`RecordPresentation`、`RecordListText`）。把读取器分出去成为 `.ts` 模块会为它们触发 `verify-export-jsdoc`，并让它们可以在没有组件的情况下被 import；那是留给后续切口处理的结构选择，不是这一刀必须定下的边界。

## Related

- [Splitting the seven god files](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本记录是它的批次 1 `ui-trajectory` 项）
- `2026-09-14-analyzer-module-extraction.md`（批次 1 同侪，作为独立 pull request 落地；确立了本刀复用的 `src/types.ts` 归宿）
- [Extracting the python runtime's cost and log-ledger modules](2026-09-14-code-runtime-python-cost-and-ledger.zh.md)（批次 1 试点）
- `packages/AGENTS.md`（包的接缝词汇所在之处）
