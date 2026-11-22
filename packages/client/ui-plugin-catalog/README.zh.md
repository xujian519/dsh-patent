---
description: "dsh Web 客户端设置中的只读插件发现页面：目录源、搜索与安装预检，基于 plugin-market Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-catalog

[English](README.md) | 中文

## 概述

`dsh-client-ui-plugin-catalog` 向 Web 设置贡献只读的**插件目录**页面。首次被选择时懒调用 `ctx.remote.pluginCatalog` 命名空间，并渲染目录源选择器、搜索表单与安装预检控件。它列出宿主已注册的目录源（标注内置来源）、按自由文本/类目/能力搜索某个源，并针对 `name@version` 引用向注册表做安装预检——全程不触碰任何 profile。加载、空结果、无匹配、预检与通用失败状态只属于已挂载组件，源读取失败后可以重试，且不会暴露传输细节。


## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置并选择**插件目录**条目，即可发现宿主能触达的插件。插件激活期间不会读取 Remote——首次选择该页面时才挂载组件，并通过 `api-remotes` 懒调用 `ctx.remote.pluginCatalog.listSources()`。

### 列出目录源

目录源选择器列出宿主已注册的每个源；内置源带有「内置」后缀。若没有注册任何源，分区会显示一个本地空态提示。

### 搜索某个源

选择一个源后输入自由文本、类目或能力，再点搜索。空过滤项会从 Catalog 查询中省略，结果以双列紧凑卡片网格渲染，每张卡片显示插件名称、包引用、描述、来源标签与能力/类目标签。本地自由文本框会进一步过滤已抓取的一页，而不会额外发起 Remote 调用。

### 预检引用

卡片上的预检按钮，或专门的 `name@version` 输入框，都会调用 `ctx.remote.pluginCatalog.preview()` 来校验引用。通过校验的引用会显示其版本；被拒绝的会显示失败席位。预检从不安装。

### 重试失败的读取

源读取失败会在页面内渲染通用失败状态；重试会重新执行懒 `listSources()` 调用，且不会暴露传输细节。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该页面是宿主拥有的 plugin-market 状态的只读投影；插件激活期间不执行任何 Remote 读取，首次选择时才取源列表。

### 注册

浏览器插件注册一个 id 为 `pluginCatalog`、order 为 `30` 的本地化 `settings.section` 贡献；设置外壳拥有导航入口与页面外框。注册使用 `ctx.slots.inject()`，因此能跟随分区 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

### Remote 面

`inject` 声明 `slots`、`locale`、`remote` 与 `remote.pluginCatalog`。注入面包装三个只读 Remote 方法——`listSources`、`search` 与 `preview`——并在 Remote 返回 `ok: false` 时抛出一个浅层 `pluginCatalog.<method> failed: <code>: <message>` 错误，因此组件从不接触传输信封。

### 渲染

组件只接收注入函数与 locale 键集，不持有 `ctx`。它以 `ViewState` union（loading / error / ready）建模源加载，以 `CatalogPage` 建模搜索结果，并以 `PreviewState` union（idle / pending / rejected / ready）建模预检。`current` 标志守护每个异步结果，避免卸载后的过期写入；失败席位不暴露任何传输细节。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置分区、Remote 表面与宿主侧 seam。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 的领域底座。
- [api-remotes](../../api/remotes/README.zh.md)——`pluginCatalog.*` 背后的 Remote BFF 表面。
- [plugin-market-controller](../../api/plugin-market-controller/README.zh.md)——把只读 seam 投影到 `pluginCatalog` 的宿主控制器。
- [plugin-market](../../host/plugin-market/README.zh.md)——本标签页所渲染的宿主侧目录与安装预检 seam。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端发现投影，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义发现视图的新鲜度与触达范围；它们是当前包约束。

- **每次 Settings 挂载或重试只读取一份源列表**：页面不订阅目录变化，也不会在重连后自动重新读取；切换分区会保留当前源列表，重新打开 Settings 则会取得新列表。
- **只读发现，不安装**：本页面从不安装或卸载插件；`dsh plugin install` 保持 CLI 独占。浏览器只能发现与预检。
- **公开 HTTPS 目录源仍待接**：shipped 组合提供一个内置离线目录源，因此无需网络目录端点即可发现；但远程 HTTPS `dsh-plugin` 目录仍是后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

</details>
