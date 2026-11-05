# Agent Note：法条引用判定规则迁入 dsh-law-core

状态：implemented

[English](2026-11-06-law-core-statute-citation-shared-home.md) | 中文

## 问题

Issue #739：legal-law 的引用核验与 patent-law 的引用核验共用一条判定规则，但该规则落在 `@deepseek-ai/dsh-patent-core`，法律域的构建与发布因此跟着专利核心包走，专利内部变更都会成为法律核验的依赖面。`packages/legal/legal-law/package.json` 在 `dependencies` 中声明了 `@deepseek-ai/dsh-patent-core`。

## 决策

**共享机制获得领域中立的家。** 新包 `@deepseek-ai/dsh-law-core`（`packages/law/law-core`）拥有从 patent-core 迁出的六个引用模块——引用文本、引用抽取、连续条号、命题重合度、逐条判定与 citation-verify 工具脚手架——外加从 patent-core 的 `rule/text-utils.ts` 迁出的 `parseCnNumber`，使迁出模块不再残留对内的依赖。

**patent-core 转导出迁出面。** patent-core 此前从迁出模块导出的每个符号都改为从 `@deepseek-ai/dsh-law-core` 转导出，专利域消费方（`patent-law`、`patent-document`、`patent-rule`、`patent-tools`）保持单一导入面，无需改动源码。

**legal-law 直接消费 law-core。** 它的四个导入方模块（`verify.ts`、`reference.ts`、`support.ts`、`tool/law-verify.ts`）改为从 `@deepseek-ai/dsh-law-core` 导入，`dependencies` 中的 `dsh-patent-core` 替换为 `dsh-law-core`。

**同一份样例两边都跑。** `packages/law/law-core/tests/fixtures/citation-samples.ts` 把引用样例、共享基线内容与期望判定标签只定义一次；`legal-law` 与 `patent-law` 各自的 `citation-conformance.spec.ts` 把每个样例跑过自己的 verify 路径。两侧唯一有意不同的是领域数据（法名与基线文档名），并在适配处注释来源。

## 备选方案

- **规则留在 patent-core、接受该依赖。** issue 已否决：该依赖方向使法律域发布跟随专利内部变化。
- **规则迁入法律域。** 只是把不对称反转，专利域将继承同样的问题。
- **连各域的 verify/baseline/reference 脚手架也一并合并。** 依 2026-10-31 的复制门禁说明否决：这些文件是共享规则之上的各领域结构，而一致性样例现在守护的正是需要共享的那条边界。

## 影响

- legal↔patent 跨域克隆对 `legal-law/src/types.ts ↔ patent-core/src/knowledge/article-decision.ts` 从复制门禁基线中消失（跨域接受对降为 13）。
- `parseCnNumber` 的单元测试随它迁至 `packages/law/law-core/tests/cn-number.spec.ts`；patent-core 为既有消费方保留转导出。
- 未来的法条引用域导入 `dsh-law-core`，永不导入专利包。
