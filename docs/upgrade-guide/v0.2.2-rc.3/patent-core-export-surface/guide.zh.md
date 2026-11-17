---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-core 不再导出没有其他包导入的根入口名字。"
---

# patent-core 移除未使用的根入口导出

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-patent-core` 过去从根入口再导出内部助手和类型，其中包括没有其他包导入的名字。现在，根入口只导出 `packages/patent/patent-core` 之外的文件有导入的名字。`matchKeywordsAll`、`renderClaimStrategyReport`、`describeCitation`、`readJsonStringArray` 这类助手仍留在定义它们的模块里，不能再从包入口导入。没有专利包导入的引用与检索助手不再由本包转导出；请从 `@deepseek-ai/dsh-law-core` 或 `@deepseek-ai/dsh-knowledge-core` 导入。`resolveResultLimit` 仍留在本包。引擎、注册表和工具的行为与原来相同。

从 `@deepseek-ai/dsh-patent-core` 导入被移除名字的调用方会受影响。

## 迁移

1. 针对 `@deepseek-ai/dsh-patent-core` 重新构建。缺失的名字已从 `packages/patent/patent-core/src/index.ts` 移除。
2. 本包不再转导出的引用或检索助手，改从 `@deepseek-ai/dsh-law-core` 或 `@deepseek-ai/dsh-knowledge-core` 导入。`resolveResultLimit` 仍从本包导入。
3. 对于 `matchKeywordsAll`、`renderClaimStrategyReport`、`describeCitation`、`readJsonStringArray` 这类助手，调用已经在使用它的导出引擎或工具（`registerBuiltinAtoms`，以及本包仍导出的权利要求对比表、规则检查和通知解析函数）。本包不导出 `./src/*` 子路径。
4. 运行 `pnpm run verify-patent-core-exports`。新增的根入口名字需要包外导入者，或者在该说明符上加含 `@public` 的注释。
