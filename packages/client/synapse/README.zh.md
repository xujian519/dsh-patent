---
description: "Synapse 会话地图的浏览器半侧：**对话/会话地图** 视图切换与 `/synapse/` 全屏 iframe，通过客户端会话/工作区服务桥接。在画布中可浏览、分支、追问、新建会话；原生对话与当前会话双向跟随。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-synapse

[English](README.md) | 中文

## 概述

Synapse 会话地图的浏览器半侧：**对话/会话地图** 视图切换与 `/synapse/` 全屏 iframe，通过客户端会话/工作区服务桥接。在画布中可浏览、分支、追问、新建会话；原生对话与当前会话双向跟随。

宿主半侧（`@deepseek-ai/dsh-host-synapse`）拥有画布页面与投影；本包只渲染宿主壳并转发桥接消息。


## 目录

- [注册](#registration)
- [模型影响](#model-experience)
- [已知限制与后续](#known-limitations-and-deferred-work)

<a id="registration"></a>
## 注册

Web 组合以 `dsh.client` 行 `synapse-client` 挂载本包（节点半侧为空 Loader 入口）。宿主行 `synapse` 同时挂载时，聊天界面出现地图切换；缺少它时 iframe 无内容。

<a id="model-experience"></a>
## 模型影响

无，浏览器半侧仅把会话/工作区快照桥接给画布，不触达模型请求、工具执行或会话事件。

#### KV Cache 影响

无。本包不发送模型请求，也不修改请求头。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续

- 地图运行在 iframe 内、使用自带 DOM/Markdown 栈；不属于 React 插槽系统，宿主主题令牌与无障碍约定在画布内不适用。
- 切换控件同样是纯 DOM，不占插槽。它把 CSS 锚点名 `--dsh-synapse-switch` 赋给会话标签行（`data-conversation-tab-row`，否则 `data-conversation-tabs`），并与该盒子的右缘和底缘对齐；没有标签行的空白会话改锚到 `data-conversation-session`，位于其顶缘下方 40px。锚点缺失或折叠时使用样式表角落。列宽变化（包括拖动右侧栏）时切换控件随锚点移动，且不读取布局。
- 暴露的桥接面（create/fork/send/open/activate）是与画布约定的最小 RPC 契约；增加动词需同时扩展 `src/client/index.ts` 与画布 app。

### 开发备注
