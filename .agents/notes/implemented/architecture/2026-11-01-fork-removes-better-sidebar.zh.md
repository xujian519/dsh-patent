# Agent Note：本 fork 移除 `@deepseek-ai/dsh-better-sidebar`

Status: implemented

[English](2026-11-01-fork-removes-better-sidebar.md) | 中文

## 问题

工作区侧栏包仍是一等 optional 插件，带大测试面与桌面 overlay 行（`disabled: true`），而专利域组合从不挂载它，产品右侧栏已由 `ui-sidebar-right` 承担。继续保留会强制支付依赖、catalog 与门禁成本，却换不来本 fork 会交付的面。

## 决策

从本 fork 删除 `packages/client/better-sidebar`。去掉桌面 overlay 插入行、CLI/desktop-host 依赖、product-package-policy 条目、tsconfig paths、release 版本镜像，并重生 Cordis/config/module 图。右侧 UI 继续由 `@deepseek-ai/dsh-client-ui-sidebar-right` 承担。

仍插入该模块名的外部读者会在加载失败；升级指南 `docs/upgrade-guide/v0.2.2-alpha.2/remove-better-sidebar/` 写明迁移。

## 后果

- 无 `ctx.betterSidebar` 服务、无该包的 `/sidebar/*` 主机路由、无工作台工具（`sidebar_open`、可选 `terminal_*`）。
- 插件管理器测试仍可用字符串 `dsh-better-sidebar` 作夹具包名；与已删工作区包无关。
- 上游同步若重新引入该包，需要本 fork 显式决定保留或再次删除。
