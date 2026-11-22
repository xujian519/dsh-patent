# Agent Note：钉住 analyzer 的节点 id（Issue #86）

Status: implemented

[English](2026-09-15-node-id-stability.md) | 中文

## Problem

`WorkspaceAnalyzer` 铸造 `type:<file>:<line>:<column>#<ordinal>`。`allocateNodeId` 按起始位置各持一个计数器，因此 id 是「分析器在一个源码位置上访问节点的顺序」的函数，而不是它所命名类型的函数。两处让这个顺序难以预测：

- `convertType` 先分配再递归，于是同一个 `getStart()` 的外层形式与被它包住的节点由调用顺序决定先后，而不是由结构决定：union 与它的第一个成员、conditional 与它的 check 类型、`Payload['name']` 与 `Payload`、`string[]` 与 `string`。
- `resolvedRemoteCodecType` 在自己的 `convert` 闭包里、对自己那对 `completed`/`active` 缓存分配 id，因此一个作者写下的 Remote 边界会为它经该节点转换的每种编译器类型各铸一个 id，顺序由缓存未命中决定。

`tests/__snapshots__/type-model.spec.ts.snap` 记录了这些 id——仅 type-model fixture 就有 18 个同址位置，快照里 578 处出现、282 个不同——因此访问顺序一变，它们就改名，并以快照 diff 而非失败的形式到达。[拆分计划](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)正因如此把 `analyzer.ts` 留在批次 3，也正因如此规定：这个测试缺席时它的切分不得开始。

## Decision

`packages/typert/generator/tests/node-id-stability.spec.ts` 钉住模型会在同一位置访问多个节点的每一处，写作 `<file>:<line>:<column>#<ordinal>:<kind>[:<名称|字面量文本>]`：

| fixture | 钉住的位置 | 形态 |
| --- | --- | --- |
| `type-model` | `packages/host/src/models.ts` 的 18 处 | 外层语法形式持有较小序号：`8:26#1:conditional,2:reference:T`、`119:10#1:array,2:keyword:string` |
| `remote-model` | `packages/domain` 与 `packages/remote` 共 7 处 | 一个作者边界最多铸六个序号：`15:26#1:reference:AgentId,2:keyword:string,3:reference:AgentId,4:keyword:string,5:reference:AgentId,6:keyword:string` |

两张表是手写的，不是快照，且每一行写出「哪个类型拿到了该序号」而不只是它的 kind——于是被搬动的分配会以源码位置、序号与访问落点报错，且落在拥有该位置的那个用例里。

### 既有的批处理测试覆盖不到什么

`type-model.spec.ts` 早已比较 `analyze()` 与 `analyzeInBatches(1)`、`analyzeInBatches(2)` 以及反转包顺序后的结果。那是这条性质的另一半：它钉住「id 不依赖工作区如何被分析」，但每次比较的两侧都出自同一个转换顺序，所以访问顺序一变，两侧一起变而比较仍然通过。新文件钉住的是 id 本身是什么；两者合起来才覆盖「分析器必须挺过的重排」与「必须响铃失败的重排」。

### 这道守卫守住了什么，没守住什么

对 `analyzer.ts` 做四处变异来探它：

| 变异 | 结果 |
| --- | --- |
| union 在转换完自身成员之后再分配 | 拦住——语法表变化 |
| array 的元素先于 array 自身的 id 被转换 | 拦住——语法表变化 |
| codec 的 object 节点在成员之后才分配 | 拦住——codec 表变化 |
| codec 闭包在查 `completed` 缓存之前就分配 | 未拦住——那些作者位置从未命中缓存，多出的 id 是唯一差别，没有任何 id 改变 |

第五处变异——把 union 的成员转换提到发布该 union 的 `add` 之前——同样未被拦住，而这是守卫的边界而非缺口：`convertType` 在函数顶部、任何分支之前就分配，因此分支内的求值顺序无法移动 id。守卫钉住的是**分配**顺序，也正是模块切分能改变的东西。

## Verification

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/typert/generator` | 9 文件 / 203 通过（此前 201，加上 2 个新例） |
| `pnpm exec tsx scripts/run-oxlint.ts packages/typert/generator/tests/node-id-stability.spec.ts` | 0 警告 0 错误 |
| 上述四处变异，逐一施加后再还原 | 之后 `analyzer.ts` 与变异前副本逐字节相同 |
| `pnpm run typecheck` | exit 0 |
| `pnpm run test:docs` | 18/18 |
| `pnpm run doc-sync` | 33 通过 / 3 失败——既有失败的 doc graphs、config catalog 与 package paths |

本改动只新增一个测试文件、不新增任何源码行，因此没有覆盖率豁免移动，`packages/typert/generator/src` 的逐文件门禁不变。

## Alternatives considered

- **重新录一份更小的、只含 id 的快照。** 否决：计划抱怨的正是「重排以快照 diff 的形式到达」，而同一机制的更小快照只是把这个失败模式挪到一跳之外——没有任何东西迫使读者去问 id 为什么动了。
- **只断言每个位置的序号个数，不断言身份。** 经变异测试后否决：只数个数分不出是哪种编译器类型拿到了 `#1`，于是一处把两个「kind 序列相同」的转换互换的切分会通过。
- **只断言同一工作区的两次分析结果一致。** 不作为主守卫：被重排的转换是确定性的，两次分析会一致，断言照样通过。
- **在同一次改动里就开始切 `analyzer.ts`。** 否决：计划把这个测试定为该切分的前置件，而只有在切分搬动任何东西之前就已存在并通过，它才算证据。

## Consequences

`analyzer.ts` 未变，仍为 2806 行。批次 3 的 `analyzer` 条目现在有了前置件：切分可以开始，且一旦该切分重排了它们共同依赖的转换顺序，这个文件会失败。批次 3 剩余条目为 `code-runtime-python` 的配置门与进程 supervisor、`ui-trajectory` 的行渲染器。

## Related

- [拆分七个上帝文件](../../implemented/simplification/2026-09-14-god-file-split-plan.zh.md)（本改动为其批次 3 条目解开前置条件的计划）
- [提取 `Session` 对象与发布观察者](../../archived/simplification/2026-09-15-session-object-extraction.md)（批次 3 第三刀落地）
- `packages/typert/generator/tests/node-id-stability.spec.ts`、`packages/typert/generator/tests/type-model.spec.ts`
