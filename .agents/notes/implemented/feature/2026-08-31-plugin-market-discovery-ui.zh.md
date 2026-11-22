# Agent Note: Web 设置里的只读插件市场发现

Status: implemented

[English](2026-08-31-plugin-market-discovery-ui.md) | 中文

## 问题

插件市场能力间隔（[`@deepseek-ai/dsh-host-plugin-market`](../../../../packages/host/plugin-market/README.zh.md)）原本只能通过操作者驱动的 `dsh plugin` CLI 触达。面向模型的[那一半](2026-08-31-plugin-market-agent-tools.zh.md)把封闭动词包装成工具，让 Agent 能回答*有哪些源*、*什么能匹配这个查询*、*这个钉定能否解析*。但在 Web UI 里操作者没有任何浏览器内的发现面：枚举已注册的目录源、搜索其中一个、或者预检一个 `name@version`，都仍然需要终端。浏览器需要同一个能力间隔的只读投影，让发现这一步不必依赖 shell。

## 决策

用**只读 Remote controller** 把能力间隔桥接到浏览器，并把投影作为独立**分区**放进设置页，让发现可以在产品内完成，而所有写入仍留在 CLI。

- [`@deepseek-ai/dsh-api-plugin-market-controller`](../../../../packages/api/plugin-market-controller/README.zh.md) 继承 `TypertRemoteService`，命名空间为 `pluginCatalog`，只转发只读动词 `listSources` / `search` / `preview`。它把 host 的 `PluginMarketError` 投射为 `TypertRemoteFailure` 业务码，并在未挂载 provider 时报告可执行的配置错误。
- [`@deepseek-ai/dsh-client-ui-plugin-catalog`](../../../../packages/client/ui-plugin-catalog/README.zh.md) 注册一个本地化的 `settings.section` 贡献（`id: 'pluginCatalog'`，`order: 30`），导航入口与页面外框由设置外壳拥有。它列出目录源，用 `q` / `category` / `capability` 搜索选中的源，并预检一个 `name@version` 引用。所有文案都走 typed locale 字典；组件只消费注入的纯函数，不直接触碰 `ctx` 或 Remote。
- `@deepseek-ai/dsh-api-remotes` 挂载该 controller（`pluginCatalogRemote`），令浏览器通过 `ctx.remote.pluginCatalog` 解析到与 CLI 动词相同的命名空间。

两者都从构造上保持只读：没有任何方法能写入 profile、编辑 `cordis.yml` 或安装包。安装与卸载仍保留在操作者驱动的 `dsh plugin` CLI。

### 类型契约

controller 与 UI 从 `@deepseek-ai/dsh-host-plugin-market/types` 导入 plugin-market 契约类型（`PluginMarketSource` / `CatalogQuery` / `CatalogPage` / `InstallPreview`），而非重复声明，从而 wire schema 变更不会让镜像漂移。这些类型已在生成的 Cordis catalog 中分类（见 `scripts/gen-cordis-catalog.ts` 的 type-link exemptions）。

## 备选方案

- **不在浏览器暴露面向模型的安装/卸载。** 写入 profile 需要审批与持久 receipt；它留在 CLI。浏览器内表面仅做发现与预检。
- **不重复声明契约。** 两个包都复用 plugin-market 服务类型，而非引入并行的镜像。
- **不是模型工具。** 浏览器投影是面向操作者的一半；[模型工具](2026-08-31-plugin-market-agent-tools.zh.md)仍是面向 Agent 的一半。那篇 Note 的备选条目把它推迟为独立面，本面板正是该面。

## 结果与代价

Web UI 中的操作者现在可以枚举目录源、搜索其中一个、并预检一个钉定，而无需动用终端，复用的正是 CLI 与模型工具所驱动的同一个能力间隔。每个动词在构造上只读，因此浏览器会话无法写入 profile 或安装包——写入路径仍留在操作者驱动的 CLI。代价是新增一个投射 `pluginCatalog` 命名空间的 Remote controller、web-app 组合里多一个依赖，以及一个刻意只读的 UI tab：没有安装/卸载 affordance，也没有添加的计划。初始目录源是内置离线的 `builtin-deepseek` 快照；公开 HTTPS 源仍是 host 包 README 中追踪的未完成项。
