---
kind: upgrade-guide
description: "本 fork 移除已发布的 `@deepseek-ai/dsh-better-sidebar` 包及其 cordis 插入行。"
---

# 工作区侧栏包已移除

[English](guide.md) | 中文

## 变更

本 fork 不再发布 `@deepseek-ai/dsh-better-sidebar`。仍插入该模块名的 profile / overlay 会在加载时失败。桌面 host overlay 不再包含 `better-sidebar` 行。右侧工作区 UI 继续由 `@deepseek-ai/dsh-client-ui-sidebar-right`（及其文件/文档页签）承担。依赖工作台（资源管理器、内嵌编辑器/终端、侧聊、`sidebar_open` / 可选 `terminal_*` 工具）的部署将失去这些面。

## 迁移

1. 在全部 `cordis.yml`、overlay、patch 中搜索 `id: better-sidebar` 或 `name: '@deepseek-ai/dsh-better-sidebar'`，删除对应行。
2. 从任意 `package.json` 的 `dependencies` / `devDependencies` 去掉 `@deepseek-ai/dsh-better-sidebar` 并重新安装。
3. 删除对 `@deepseek-ai/dsh-better-sidebar` 的 TypeScript 导入与 `ctx.betterSidebar` 用法；改在产品右侧栏注册页签，或放弃该能力。
4. 用 `pnpm dsh web`（或 desktop）确认：进程无缺插件报错启动，且只挂载一个右侧栏。
