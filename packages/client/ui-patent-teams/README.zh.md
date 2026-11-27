---
description: "把 PatentTeams 监视面带回 Web UI 的浏览器插件：对话流里的一张持久团队卡片，以及固定的\"团队\"会话视图。两个面都折叠 [`dsh-patent-teams`](../../patent/patent-teams/README.zh.md) 拥有的九种 `patent-teams/*` 会话事件；上游 `@nanmicoder/dsh-agent-teams` 活动面板的交互词汇（分段进度、花名册、任务依赖图）被采纳，但其 body-portal 浮层与轮询 host 路由仍有意排除——本包改为重放会话日志，零轮询、零新增 host 面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-patent-teams

[English](README.md) | 中文

## 概述

把 PatentTeams 监视面带回 Web UI 的浏览器插件：对话流里的一张持久团队卡片，以及固定的"团队"会话视图。两个面都折叠 [`dsh-patent-teams`](../../patent/patent-teams/README.zh.md) 拥有的九种 `patent-teams/*` 会话事件；上游 `@nanmicoder/dsh-agent-teams` 活动面板的交互词汇（分段进度、花名册、任务依赖图）被采纳，但其 body-portal 浮层与轮询 host 路由仍有意排除——本包改为重放会话日志，零轮询、零新增 host 面。


## 目录

- [持久状态与重放](#durable-state-and-replay)
- [呈现与导航](#presentation-and-navigation)
- [组合](#composition)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="durable-state-and-replay"></a>
## 持久状态与重放

`patent-teams/team-created` 以 `teamId` 为键开启一个 Context；成员增删、任务创建、状态迁移、契约裁决、质量门拒绝、邮箱消息与团队删除按日志顺序更新该 Context。聊天 Definition 与视图源 Definition 跑的是 `teams-model.ts` 里的同一个 reducer，卡片与"团队"tab 是同一折叠的两个投影，不可能不一致。只含更新事件的历史尾页会保持 pending，直到更早的页补给唯一的 start；prepend、完整重放与增量 append 收敛到同一状态。后到的有效契约裁决会清掉先前的降级字段——最新裁决拥有任务视图。`patent-teams/team-deleted` 将团队标记为已解散但保留记录供复盘，与 host 的磁盘归档一致。折叠还为每个团队保留最近八条任务迁移与邮箱消息的动态流，供"团队"tab 使用。

"团队"tab 经由按会话隔离的 `ConversationViewBuilder` 读取 `patentTeams` 视图快照，builder 在增量 upsert 间保持团队创建顺序。由于折叠依赖唯一的 start 事件，若打开时已加载窗口只含尾部，只要尚未出现任何团队，视图就会持续向前翻页会话历史（Session 面的 `loadOlder`，上限 400 页）——长会话不再出现假空态。回溯期间显示加载态而非空态；历史加载失败或无法前进时（`historyLoadStatus` 为 `error`）停止回溯并回到空态。没有团队记录的会话仍显示空态；tab 本身是每个会话视图中的固定入口（order 30，位于"轨迹"与"文档"之后）。

<a id="presentation-and-navigation"></a>
## 呈现与导航

卡片是受控展开件：进行中的团队挂载即展开，已完成与已解散的团队挂载即折叠，整行表头可切换。折叠尾是成员数、任务 done/total 计数与状态点及文案；展开体列出成员（名字、角色、实时活跃）与任务（状态、负责人、依赖、契约缺字段与未过质量门标记）。宿主闭合词表之外的任务状态按原始字符串渲染。成员只有在全部事实一致时才能打开其子代理会话——运行中、在普通会话列表中、`origin: 'subagent'`、父会话为当前会话——与 `ui-workflow-run` 的证明相同，过期折叠永远不会变成死按钮。

"团队"视图按团队渲染一个仪表盘区块：Hero 区含团队字母徽标、实时状态徽章、成员与消息指标以及完成环；分段进度条按已完成、执行中、等待切分；花名册含队长通栏卡、按成员 id 派生的渐变头像、角色芯片、实时状态与当前/上一任务绑定；任务依赖图按依赖深度分层、以曲线连接依赖边，悬停追踪、点击固定依赖链，质量门退回带红色虚线框与徽标；以及封顶的最近动态流。全部文案走双语 locale 字典，动画在 `prefers-reduced-motion` 下降级。

<a id="composition"></a>
## 组合

包以 Cordis effect 注册两个 Conversation Node Definition、一个视图 Definition、locale 字典、keyed `patent-teams` Chat 渲染器与 `patentTeams` 会话视图。移除 client 入口即收回全部贡献。发布的 Web bundle 在 `ui-workflow-run` 之后收录本插件；桌面 app 经同一 roster 自动继承。

<a id="model-experience"></a>
## 模型体验

无：本包为人渲染持久会话事实，不新增 prompt、工具 schema、请求内容或模型可见结果。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 成员实时活跃来自普通会话列表 share；列表行尚未到达的成员渲染为待命，且不提供手动刷新动作。
- `patent_teams_*` 工具调用仍走通用工具卡；keyed toolview 推迟到能在不分叉 ui-tool 行 chrome 的前提下复用其模式时再做。
- 视图只覆盖事件落在本会话日志内的团队；尚无团队出现时向后排水会补齐窗口，但跨会话团队聚合仍需新的 host 查询面。
- 团队创建时不自动切到"团队"tab：会话服务尚无按会话读取快照的接口来给切换做门控。

### 开发备注
