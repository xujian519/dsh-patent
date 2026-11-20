---
kind: upgrade-guide
description: "七个专利插件让每项配置缺省值只有一处来源，因此这些插件导出的 Config 中原本带缺省值的字段改为必填。"
---

# 专利插件的 Config 中带缺省值的字段改为必填

[English](guide.md) | 中文

## 变更

`patent-teams`、`patent-rule`、`patent-data`、`patent-filing`、`writing-patterns`、`patent-knowledge` 与 `patent-document` 过去都把配置缺省值应用两次：一次在各自的 `Config` schema 中，一次在 `apply()` 或某个解析函数里。现在 schema 是唯一来源，因此这些插件导出的 `Config` 接口中，每项带缺省值的字段都是必填，schema 的输入类型为 `z<Partial<Config>, Config>`。

`cordis.yml` 与 Loader 不受影响：这些字段在配置中仍可省略，由 schema 解析时填充。

构造 `Config` 对象或以局部字面量调用 `apply()` 的 TypeScript 代码不再能通过编译；`new PatentData(ctx, { maxOutputBytes: 1024 })` 这类局部构造器调用同样如此，需先经该包的 `Config(...)` 补齐其余字段。

`patent-knowledge` 保留其库入口：`resolveKnowledgePaths(config = {})` 与 `new PatentKnowledge(ctx)` 仍可无配置调用并解析出厂缺省值。但它的 schema 现在只做校验，`PatentKnowledge.Config({})` 不再填充 `knowledgeDir`、`sourceDbPath` 与 `nodeCacheMaxEntries`，而是原样返回给定字段；解析后的路径请读 `resolveKnowledgePaths()`。

`patent-document` 的 `apply()` 现在总是传入 `outputRoot`，缺省目录 `.dsh/documents` 使用导出的 `DEFAULT_OUTPUT_DIR`，不再是第二处字面量。

## 迁移

1. 把每处局部配置交给该包的 schema 解析：`apply(ctx, Config({ rulesDir }))`、`new PatentData(ctx, PatentData.Config({ maxOutputBytes: 1024 }))`。
2. 原先从 `PatentKnowledge.Config({})` 读取 `knowledgeDir` 与 `sourceDbPath` 的地方改用 `resolveKnowledgePaths()`；假设了 `nodeCacheMaxEntries` 缺省值（1024）的地方改为显式传入。
3. 运行 `pnpm run typecheck`，剩余报错会指出该字段的缺省值现已归 schema 所有。
