---
kind: upgrade-guide
description: "专利原子与阶段 handler 注册表现在返回 disposer，`StageError` 已从 `@deepseek-ai/dsh-patent-core` 移除。"
---

# 专利注册表返回 disposer；`StageError` 已移除

[English](guide.md) | 中文

## 变更

`AtomRegistry.register`、`StageHandlerRegistry.register` 与 `RegisterAtom` helper 现在返回 `() => void`。disposer 只在名称仍指向本次注册时删除条目，可重复调用，且不会删除后来覆盖它的注册。`@deepseek-ai/dsh-patent-tools` 用同一个 `ctx.effect` 包裹自己的 6 个包内原子与 handler，插件卸载时撤销它们，`patent-core` 内置原子保持注册。本指南记录的是 v0.2.1-rc.2 当时的 6 个包内原子；其后新增的包内原子仍由同一个 effect 卸载，不属于本次迁移。

`StageError` 不再导出。预期阶段失败返回 `degraded()` 片段；人工中断抛出 `InterruptStageError`；其它异常由工作流执行器的重试/降级策略处理。

## 迁移

1. 把即发即忘的注册改为有生命周期的注册：
   ```ts ignore-check
   ctx.effect(() => globalAtomRegistry.register(atom), 'my-plugin: atom')
   ```
   成对注册时收集两个 disposer，并按相反顺序调用。
2. 不使用 `ctx.effect` 时，在清理阶段调用返回的 disposer。仅在其注册仍有效时保留该 disposer。
3. 预期失败把 `throw new StageError(...)` 改为 `return degraded('<atom>', '<原因>')`。仅在人工审批或其它有意中断时使用 `InterruptStageError`。删除 `StageError` 的导入。
4. 确认：注册一个原子后卸载插件或调用 disposer，检查 `LookupStageHandler(name)` / `globalAtomRegistry.get(name)` 返回 `undefined`；`extract` 等 `patent-core` 内置原子仍在。
