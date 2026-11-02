---
description: "面向[文档模式 preset](../../bundle/web-app/presets/document.patch.yml)的文档交付工作室：一个 `conversation.view` 标签（`document`，标签「交付物」），列出会话已交付文件，从会话工作区预览 HTML/Markdown/文本并跟随文件更新，把模型自述的质量门与实际跑过的机器核验并列显示，并提供打开 / 显示文件位置 / 在侧栏预览 / 打印 / 要求修改动作。当会话登记过交付物时，还会自动切换到该视图。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-document-studio

[English](README.md) | 中文

## 概述

面向[文档模式 preset](../../bundle/web-app/presets/document.patch.yml)的文档交付工作室：一个 `conversation.view` 标签（`document`，标签「交付物」），列出会话已交付文件，从会话工作区预览 HTML/Markdown/文本并跟随文件更新，把模型自述的质量门与实际跑过的机器核验并列显示，并提供打开 / 显示文件位置 / 在侧栏预览 / 打印 / 要求修改动作。当会话登记过交付物时，还会自动切换到该视图。


## 目录

- [挂载内容](#what-it-mounts)
- [前提](#prerequisites)
- [预览上限](#preview-limits)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="what-it-mounts"></a>
## 挂载内容

- **交付工作室视图**——`conversation.view` 环形槽的一个条目（id `document`，order 20）。插件加载后每个会话都会出现该标签；选中即在中心列显示工作室。一次性的 `viewRequest` 若点名某个已产出路径，会选中该文件——聊天侧的交付卡由此落到自己的文件上。
- **产物词汇**——一个 turn 级 `ConversationNodeDefinition`（`documentDeliverables`），把成功变更的 `locations`（diff 卡与 generic edit 卡）以及 `document_deliver` 登记调用折叠为 turn 数据；外加一个会话级视图目标（`documentDeliverables`），把窗口内所有 turn 折叠为一份按首次出现排序的去重列表。登记调用会原地升级变更派生的条目，带上声明的格式、P0/P1 质量门状态与其结果记录的机器核验结论——因此经 shell/officecli 产出的二进制产物（`.docx`、`.pptx`）在登记后进入工作室；旧会话降级为变更派生列表并显示"未登记质量门"徽标。机器核验结论只在新条目仍携带它时继续成立：同一文件此后被改写，或后续登记的结果里没有可读的核验记录，结论都会被撤下（声明续上了，核验没有）。推导与 `ui-deliverables` 使用同一词汇；本包自持自己的 key，因此无论是否组合 `ui-deliverables`，工作室都能工作。
- **一个文件一行，不管怎么写**——交付物的身份是宿主解析后的规范路径（`identity`），而不是调用时写下的那个字符串：「写入 `out/report.html`」与「登记 `/work/out/report.html`」是同一行；此后改写会在它原本记录的拼写上也撤下该行的结论。`path` 仍保留声明时的拼写用于显示，因为用户认的是它。两者可以同时缺席：宿主尚未写入 `identity` 的旧日志退回到按声明拼写匹配，而按其中任一键建立的行都能被另一键找到，因此跨越本次变更录制的会话不会把一个文件拆成两行。
- **自述与核验并列**——声明的 P0/P1 质量门是模型自述，因此徽标保持中性、写出声明的条目（条目过多时写条数），展开块以"模型自述，不是机器核验结论"为标题逐条列出。只有 `checks.status === 'checked'` 且没有 findings 才使用成功色；`unchecked` 与 `unreadable` 各自显示为降级说明。
- **过期结论标记**——工作室在第一次看到某条已核验条目时记录它的 `workspaceFiles` 新鲜度 token，并在产物列表变化时重新 stat（不做定时轮询）。token 变了说明字节已不是结论所描述的那份，徽标转为"文件已变更，未重新核验"。同一个徽标也覆盖折叠过程自己发现的撤下：后续变更或一次没有核验记录的登记把结论拿走时，条目会记下这个事实（`checksWithdrawn`），而不是仅仅丢掉徽标，因此重新加载会话后仍显示"字节未经核验"，而不会被读成"从没核验过"。
- **空态分两档**——工作区里没有任何成品时显示"本会话还没有交付文件"；而当工作区里存在成品后缀（`md`、`html`、`pdf`、`docx`、`pptx`，工作区根下两层内）却没有登记记录时，空态把它们列为未登记，避免"没登记"被说成"没产出"。探测在空列表时执行一次，此后只在用户点"扫描工作区"时重跑；探测失败显示失败本身，而不是声称没有东西。
- **预览**——预览面板订阅所选文件的 `file` Resource，版本变化时重新读取，因此磁盘改写无需重新选中即可到达屏幕。自动刷新可暂停，手动刷新仍会读取当前字节。读取经会话的 `remote.workspaceFiles.readBytes` 取一个字节窗口并按 UTF-8 解码（被窗口从中间切断的字符整字丢弃；窗口大小即宿主的配置上限）。Markdown 经 `MarkdownText` 渲染为排版文本；HTML 完整读取后在沙箱 iframe（`sandbox=""`，不执行脚本）中渲染，超过 `htmlPreviewMaxBytes` 的文件改为显示侧栏入口而不创建 iframe；其余文本格式按文本渲染；没有内联预览的格式会说明这一点并给出侧栏入口。文件消失时保留最后一次内容并附删除提示；读取失败按宿主错误码本地化。
- **跟随最新**——列表选中最新产出的文件，包括尚未登记的生成中工作稿。手动选择其他文件会暂停跟随；预览栏的开关会在下一个新文件出现时恢复跟随，选中的文件被删除时回退到列表。
- **动作**——用系统默认应用打开、在系统文件管理器中定位文件（`SessionOpenWorkspacePathRequest.action: 'reveal'`，仅在回环权威下）、在右侧栏预览（组合了该面板时经 `ctx.sidebarRight.openResource` 与会话文件地址交接，`.docx`/`.pptx`/`.pdf` 也由此渲染）、打印 / 导出 PDF（预览头被截断时经 `remote.workspaceFiles.readBytes`（不带 range）重新读取完整文件——文件超过宿主整文件上限时被拒绝，工作室据此报「文件过大」——再经桌面桥或浏览器打印对话框导出，其中「另存为 PDF」完成导出；弹窗被拦截会报错），以及要求修改。打开或定位失败会在该动作旁显示一行本地化错误，而不是让点击静默。
- **只写草稿、不发送**——「要求修改」把选中文件的机器核验 findings（逐条、带报告的行号）插入会话的输入框草稿；已交付 HTML 中声明的 `data-doc-id` 小节出现在选择器里，插入一段引用。两条都走 `ctx.conversation.input.setDraft`；是否发送由人决定，界面只报告"已填入"，不会声称已发送。
- **自动跳转**——当当前会话的 preset 是文档智能体，且最新一轮在结束后已有成功的 `document_deliver` 登记或交付物形态的工作稿时，激活工作室视图。切换等待 `turn/end`，用户正在读的回复先完整显示；还没产出任何东西的会话留在聊天。切换经 `ctx.conversation.setActiveView`——这是受认可的跨插件通道（按设计，per-session store 句柄仅限 apply 局部）；setter 随会话的 conversation seat 挂载，因此切换在有限窗口内重试，且每次进入会话最多切换一次。

Web patch（`packages/bundle/web-app/cordis.patch.yml`）是加载本包的唯一组合。移除其唯一条目即同时移除标签、词汇、预览与自动跳转。

<a id="prerequisites"></a>
## 前提

文档会话选择的是文档模式 preset（`packages/bundle/web-app/presets/`）；工作室对每个会话都渲染，与 preset 无关。承载读取的 `workspaceFiles` Remote 随 Web 组合发货（`dsh-api-workspace-files`）；无需 OpenDesign 或任何外部进程。右侧栏预览（`sidebarRight`，来自 `dsh-client-ui-sidebar-right`）是可选组合：没有它时工作室不提供侧栏交接，而不是让整个视图挂起等待。

<a id="preview-limits"></a>
## 预览上限

本包的 Host 半侧把一项设置嵌入每个服务页面；改 YAML 后刷新浏览器页面生效。

| 键 | 默认值 | 含义 |
|---|---|---|
| `htmlPreviewMaxBytes` | `8388608`（8 MiB） | 内联渲染的最大 HTML 文件；更大的文件给出侧栏入口 |

<a id="model-experience"></a>
## 模型体验

无，本包仅渲染已登记的交付记录，并只写用户的输入框草稿，不改变模型请求、工具执行或会话事件。

#### KV 缓存影响

无。本包为纯客户端展示。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **预览是预览而非执行**——HTML 以 `sandbox=""` 渲染，交互式工件（JS 驱动的 Deck、实时仪表盘）只显示首帧而不运行。信任会话自身产物文件的渲染器留待后续。
- **桌面端 PDF 静默导出**——在桌面 App（Electron）内，打印动作经 `window.desktop.printHtmlToPdf` 走隐藏窗口 + `webContents.printToPDF` 并弹出系统保存对话框；桌面壳之外回退浏览器打印对话框。
- **过期结论的基线是"本控制台第一次看到"**——登记的工具结果没有携带文件版本，因此新鲜度 token 记录于工作室首次渲染该条目时；登记与首次渲染之间的改写不会被发现。把登记的版本写进结果元数据可以闭合这一点。
- **选区锚定是降级方案**——沙箱 iframe 跨源，父页面读不到其中的文本选区；小节选择器改为按声明的 `data-doc-id` 插入引用，而不是按选中文字。本批次未实测选区通路。
- **自动跳转只在进入会话时触发，每次进入最多一次**——手动切回聊天后，离开并重新进入会话前不会被覆盖；重新进入一个已结束回合且有产出的会话会再次切换。
- **二进制格式交给侧栏**——`.docx`、`.pptx`、`.pdf` 没有内联预览；它们带徽标列出，由右侧栏预览或系统默认应用渲染。
- **列表跟随会话日志窗口**——长会话中落在已加载窗口之外的早期 turn 会从列表丢失；批量导出与跨会话聚合属于延后的工作台 v2。

### 开发备注

无。
