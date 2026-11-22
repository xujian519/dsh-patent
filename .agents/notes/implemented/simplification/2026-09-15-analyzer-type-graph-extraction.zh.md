# Agent Note：提取 analyzer 的类型图（Issue #86）

Status: implemented

[English](2026-09-15-analyzer-type-graph-extraction.md) | 中文

## Problem

`packages/typert/generator/src/analyzer.ts` 曾为 2806 行，且把两簇塞在同一个 `FaceAnalyzer` 类里：Remote/RPC 分析器（标记、网关、边界、codec 类型、invocation，以及 type-meta 查找声明）与类型建模器（`convertType`、`members`、`signature`、`ensureDeclaration`、`targetForReference`，以及它们之下的 id 分配）。两者写同一组私有 map——`nodes`、`declarations`、`declarationStates` 与 `nodeOrdinals`——而 remote 簇还在两处直接以自己铸造的 id（`#remote-codec:`）写它们，于是这些状态没有所有者。

[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)把这一刀放在批次 3，并点名了它的难点：`allocateNodeId` 铸造 `type:<file>:<line>:<column>#<ordinal>`，因此一个 id 是「某个源位置上的访问顺序」的函数，而在有测试钉住该顺序之前这一刀不能开工。那个测试[已先行落地](../../implemented/testing/2026-09-15-node-id-stability.zh.md)。

## Decision

`packages/typert/generator/src/type-graph.ts`（875 行）导出 `class TypeGraph` 与 `TypeGraphDeps`；`analyzer.ts` 为 2206 行；`src/types.ts` 收下两个模块共享的词汇。

| 搬走的东西 | 在新模块中的形态 |
| --- | --- |
| `nodes`、`declarations`、`declarationStates`、`nodeOrdinals` | `TypeGraph` 的私有状态，读经 `declarationModels()` 与 `nodeModels()` |
| `allocateNodeId`、`addNode`、`referenceNode` | `TypeGraph` 方法；两处 codec 侧写入变为 `setNode(id, model)` 与 `setDeclaration(id, model)` |
| `convertType`、`members`、`memberBase`、`memberIdentity`、`signature`、`typeParameters`、`mergeTypeParameters`、`requiredType`、`inferType`、`enumMembers`、`heritage`、`convertHeritage`、`ensureDeclaration`、`targetForReference` | `TypeGraph` 方法，逐字搬移 |
| `location`、`locationKey`、`fail`、`symbolId`、`resolveSymbol`、`symbolAtType`、`packageNameForFile`、`isTypeMetaSymbol` | `TypeGraph` 方法；`isTypeMetaSymbol` 离开 remote 簇，因为只有 `members` 读它 |
| `AnalysisMode`、`ParsedConfig`、`PackageRegistration`、`SourceEdit`、`PackageImport`、`SourceEditQueued` | `src/types.ts`，并在 `analyzer.ts` 按原有公开面再导出 |

### 依赖清单就是接缝

`TypeGraphDeps` 携带十个值：root、face、checker、`allRegistrations`、mode、`queueEdit`，以及四个回调回包分析器——`registrationForFile`、`packageExportName`、`packageImportOf` 与 `recordCrossFaceLink`。对搬移集合的对外调用实测得到的正是这四个回调，别无其他，因此类型图不会为别的事回到分析器里。

`analyzer.ts` 保留十三处同名一行委派——`fail`、`location`、`symbolId`、`resolveSymbol`、`symbolAtType`、`isTypeMetaSymbol`、`allocateNodeId`、`convertType`、`addNode`、`referenceNode`、`ensureDeclaration`、`requiredType` 与 `signature`——沿用会话存储折叠那一刀的模式：120 处调用点原样不动，类型图的公开面就是其消费方所要的那些。

### id 稳定性测试换来了什么

`tests/node-id-stability.spec.ts` 手写钉住两个 fixture 里每一处同址位置，并写出「哪个类型拿到了该序号」。有了它，这次搬移是可核对的：`tests/__snapshots__/type-model.spec.ts.snap` 记录这些 id 的 578 处出现，而整套测试逐字节比对，因此一次被改动的访问顺序会以快照差异现身，而不是悄悄通过。没有任何 id、序号、声明或节点发生变化。

### Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/typert/generator` | 9 文件 / 203 通过，快照逐字节一致 |
| `pnpm exec tsc -p packages/typert/generator/tsconfig.json --noEmit` | exit 0 |
| `pnpm run typecheck` | host lib 构建加 client face：exit 0 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/typert/generator` | 0 警告 0 错误 |
| 覆盖率 | 不受门禁：`packages/typert/*/src/**` 是既有豁免 |

## Alternatives considered

- **把四张 map 留在 `FaceAnalyzer`，把分析器本身交给类型图。** 否决：类型图为了够到四张 map 与 checker 就得持有整个分析器，而「谁可以铸造 id、在哪个命名空间里铸造」这个所有权问题仍然没有答案。
- **先提取 Remote/RPC 那一簇。** 实测否决：它在自己函数体内调用类型图的十三个方法（其中有 `convertType`、`addNode`、`requiredType` 与 `allocateNodeId`），而它留在他处的调用点只有三处；先提它等于把同一道接缝改两遍。
- **不设共享所有者，直接把两簇切开。** 否决：两者写同一组四张 map，且 codec 路径早已在自己的命名空间里铸造 id；两个所有者会让这份重复成为永久事实。
- **把共享词汇放进新模块而不是 `types.ts`。** 否决：`types.ts` 已经持有拆分模块所读的词汇（`TypertAnalysisError`、`ModuleIdentity`、`ReferenceSite`、`EMPTY_DOCUMENTATION`），其模块注释也是这么写的；同一角色再开一个家会把答案劈成两半。

## Consequences

`analyzer.ts` 减少 600 行，`type-graph.ts` 为 875 行，因此净增即 deps interface、访问器、委派与它们的 JSDoc。两簇共写的状态如今有了唯一所有者与成文的 id 分配规则，而第二簇的切分实测只剩三处对外调用点。批次 3 的剩余条目是 `code-runtime-python` 的配置门与进程 supervisor，它与 worker-thread 后端的 `jscpd:ignore` 对称契约必须先定，再动任何一侧。

## Related

- [拆分七个上帝文件](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（计划；本刀是批次 3 第五刀落地）
- [钉住 analyzer 的节点 id](../testing/2026-09-15-node-id-stability.zh.md)（本刀的前置件）
- [提取 `Session` 对象与发布观察者](../../archived/simplification/2026-09-15-session-object-extraction.md)（批次 3 第三刀落地）
- `packages/typert/generator/src/type-graph.ts`、`packages/typert/generator/tests/node-id-stability.spec.ts`
