# Agent Note：知识库查询内核迁入 dsh-knowledge-core

状态：implemented

[English](2026-11-11-knowledge-core-shared-query-home.md) | 中文

## 问题

法律知识库与专利知识库是两套独立引擎、面向各自数据，但共用一套检索机制：FTS5 文本准备、FTS 到 LIKE 的降级阶梯、长查询切词、结果上限归一、法条效力规则，以及安装期的文件操作。这些机制此前落在 `@deepseek-ai/dsh-patent-core`，`packages/legal/legal-knowledge/package.json` 因此在 `dependencies` 中声明了 `@deepseek-ai/dsh-patent-core`，并从中导入 12 个符号——这些函数不带任何专利语义。法律域的发布因此跟随专利核心包的发布节奏，专利内部变更也成为法律知识库依赖面的一部分。

D19 让两个入口在清洗与夹取上对齐，但保留了依赖：把共享代码搬进中立包是结构变更，需要独立决策。D20 就是这次变更。

## 决策

**共享检索机制获得领域中立的家。** 新包 `@deepseek-ai/dsh-knowledge-core`（`packages/law/knowledge-core`）拥有从 `patent-core/src/knowledge/` 迁出的六个模块——FTS5 工具、检索阶梯、切词、结果上限归一、法条效力规则与安装文件操作——外加从 `patent-core/src/paths.ts` 迁出的 `resolveRealPath`，使迁出模块不再残留对内的依赖。

**patent-core 转导出迁出面。** patent-core 此前从迁出模块导出的每个符号都改为从 `@deepseek-ai/dsh-knowledge-core` 转导出，专利域保持单一导入面，既有消费方（`patent-tools`）无需改动源码。导出名不变：迁移前后都是同样的 578 个名字。

**两个知识库包直接消费中立包。** `legal-knowledge` 与 `patent-knowledge` 从 `@deepseek-ai/dsh-knowledge-core` 导入；`legal-knowledge` 的 `dependencies` 完全去掉 `@deepseek-ai/dsh-patent-core`。法律域不再依赖任何专利包。

**引擎仍留在各域。** 各自的表、过滤子句、行映射、文案与后端保持原样。专利侧检索分块文档、知识图谱与 wiki，法律侧检索四类记录并带内存回退。合并两者要求统一的表结构与过滤列，而两份语料并不共享这些。

## 备选方案

- **机制留在 patent-core、接受该依赖。** 否决：这就是 2026 年 11 月 `dsh-law-core` 为引用判定规则解除的同一种边界倒置。
- **机制迁入法律域。** 只是把不对称反转，专利域将继承同样的问题。
- **合并两个检索引擎。** 依 D19 的查询行为对比表否决：两侧在表、过滤列、命中字段、后端与默认上限上都不同。
- **扩展 `dsh-law-core` 而不新增包。** 否决：`law-core` 是法条引用库，检索机制是消费方集合不同的第二件事；拆成两个包各自契约更易读。
- **只搬查询内核、安装辅助留在 patent-core。** 否决：`legal-knowledge/src/install.ts` 从 patent-core 导入五个安装辅助，法律域会保留依赖，R-10 关不掉。

## 影响

- `legal-knowledge` 对 `@deepseek-ai/dsh-patent-core` 的引用在源码与测试中均为 0，该依赖从它的 `package.json` 中消失。
- `law/` 包组现在承载两个领域中立库：法条引用（`dsh-law-core`）与知识库检索（`dsh-knowledge-core`）。
- 单元测试随模块迁入 `packages/law/knowledge-core/tests/`。新包 `src/**` 的语句、分支与函数覆盖率均为 100%。
- `resolveRealPath` 从专利域路径辅助变为共享规则；专利域的包含性校验 `resolveConfinedPath` 仍留在 `patent-core/src/paths.ts`，由它导入。
- 新包进入 Python SDK 运行时闭包，发布的 `dsh` 可执行文件因此从中立包解析这套共享机制。
- 未来的知识库域导入 `dsh-knowledge-core`，永不导入专利包。
