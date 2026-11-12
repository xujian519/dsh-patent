---
description: "Web GUI 的视频制作看板：一个 conversation.view 标签，从已落定的工具调用发现会话的视频项目，读取项目、人民币账本与任务日志，并经已鉴权的文件路由预览关键帧、片段与成片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-video-studio

[English](README.md) | 中文

## 概述

本包在 Web GUI 中渲染视频制作看板：`conversation.view` 环里的 `视频` 标签，与对话、轨迹、交付物并列。它从已落定的 `video_project` 结果元数据 `projectPath` 发现会话打开过的项目，读取每个 `project.json` 及其 `budget.json`、`tasks.json`，展示分镜、成片、进行中的任务、人民币预算（取已记录镜头成本与账本总额中的较大者）与所选关键帧、片段或成片的预览。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web patch 为每个会话挂载本插件；会话打开过项目后标签即出现。从未调用 `video_project` 的会话看到点名该工具的空态。看板只跟随实验模式的项目文档，绝不写入：`video_project`、`media`、`video_assemble`、`video_deliver` 仍是唯一的产出方。

### 项目头部

标题、画幅、目标时长与最后更新时间来自 `project.json`。一个会话打开多个项目时，选择器按文件名切换。预算条显示 `已用 / 预算`（CNY）；已用金额取所选镜头记录成本与已落定账本总额中的较大者，漏写回成本不会让数字偏小。超出预算时进度条变红并显示超支标签。

### 分镜、成片与任务

分镜按序号列出状态、时长、已选成本，以及是否带关键帧或片段；点选后预览其片段，没有片段时预览关键帧。成片列出创建时间（分钟）、实测时长与成本。进行中的任务来自日志，显示提供方模型与状态；任务落定后 Host 会删除记录，下次刷新即消失。

### 预览与动作

预览通过 `api/file?path=…&v=<版本>` 使用原生控件播放视频，拖动进度命中该路由的 Range 响应；关键帧显示为图片。Host 无法 stat 的文件显示为缺失，而不是空白播放器。预览在侧栏界面已组合时提供侧栏转交、用系统默认应用打开，以及 loopback 桌面上的“在文件夹中显示”。动作失败时在按钮旁显示 Host 的报错信息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`video-projects.ts` 注册回合级的 `ConversationNodeDefinition` 及其会话视图目标。`tool/call` 记录调用名；带 `meta.projectPath` 的成功 append-surface `tool/result` 发布该已解析路径，任意落定的 `video_project` 或 `media` 结果推进修订计数。视图构建器把窗口内每个回合折叠为首见路径列表与最高修订号。看板经 `useConversation` 读取该快照，自己不拥有 store、订阅或事件监听器。

标签经 `ctx.slots.inject('conversation.view')` 注册，id 与视图目标一致。注入面解析一次会话工作目录，并提供 `loadProject`（三次 `workspaceFiles.readBytes`，加上每个可预览媒体路径一次 `stat`）、媒体 URL 构建器与三个文件动作。文件解析在本地完成，对看板展示的字段严格校验：文档格式错误整体报错，而不是展示半个生产；账本或日志格式错误则降级为空总额或空列表，手改它们不会遮住文档本身。

发现修订号变化或用户点击刷新时重新读取；在工具集之外修改了标题或预算的项目需要这一次手势。列布局按 720px 的容器宽度堆叠，而不是视口宽度，因此被两侧栏夹窄的对话列同样得到单列布局。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-video-mode](../../experimental/video-mode/README.zh.md) —— 本看板读取的项目文档、账本、日志、工具与提供方。
- [ui-document-studio](../ui-document-studio/README.zh.md) —— 面向产出文件的兄弟交付工作室。
- [ui-conversation](../ui-conversation/README.zh.md) —— `conversation.view` 环及其视图定义。
- [客户端包地图](../README.zh.md) —— 相邻浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无。看板只读取并渲染文件，不注册工具、提示词段落或会话事件。

#### KV Cache 影响

无；本包不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **发现依赖结果元数据** —— 在 `video_project` 发布 `projectPath` 之前记录的会话不显示项目；看板不会从标题推导路径。
- **读取跟随工具落定** —— 修订号只在 `video_project` 与 `media` 结果上推进。其他进程修改的项目，或在工具之外替换的媒体文件，需要点击刷新后才出现。
- **单文件受工作区预算限制** —— 三次读取使用 Host 的完整文件上限；超过上限的项目文档报告读取失败，而不是预览。
- **预览只覆盖图片与视频** —— 其他后缀（例如 `.wav` 旁白）的关键帧与成片不进入预览列表；仍可通过侧栏或系统应用查看。
- **只读看板** —— 修改分镜、价格或预算仍由模型的工具完成；看板从不写入项目、账本或日志。
- **副文件格式错误会静默降级** —— 无法解析的 `budget.json` 读作零，无法解析的 `tasks.json` 读作无进行中任务；文档本身仍然渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/project-reads.client.spec.ts` 拥有解析与读取约定，`tests/video-projects.client.spec.ts` 拥有折叠与修订语义，`tests/StudioView.client.spec.tsx` 拥有看板行为。项目文档 schema 位于 `dsh-video-mode`；这些解析器只需与看板展示的字段保持对齐，不要复制 Host 的完整校验器。

</details>
