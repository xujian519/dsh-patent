---
description: "面向专利工作流的持久多智能体团队：一个由可续聊子代理组成的队长领导团队，配依赖感知任务、邮箱消息与事件驱动共享任务调度器。上游 `@nanmicoder/dsh-agent-teams` 插件的正式工作区移植版，重新定位于专利域（`patent_teams_*` 工具、`.patent-teams/` 状态目录、`patent-teams/*` 会话事件），并成形为服务定义（`ctx.patentTeams`），工具为其唯一 Consumer。"
kind: "package-reference"
---

# dsh-patent-teams

[English](README.md) | 中文

## 概述

面向专利工作流的持久多智能体团队：一个由可续聊子代理组成的队长领导团队，配依赖感知任务、邮箱消息与事件驱动共享任务调度器。上游 `@nanmicoder/dsh-agent-teams` 插件的正式工作区移植版，重新定位于专利域（`patent_teams_*` 工具、`.patent-teams/` 状态目录、`patent-teams/*` 会话事件），并成形为服务定义（`ctx.patentTeams`），工具为其唯一 Consumer。

## 目录

- [挂载内容](#what-it-mounts)
- [配置](#configuration)
- [状态模型](#state-model)
- [会话事件](#session-events)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="what-it-mounts"></a>
## 挂载内容

- `ctx.patentTeams` — `PatentTeamsService`：团队增删改查、带 attempt 撤销的任务状态机、成员生命周期（spawn/interrupt/retire）、邮箱持久化、删除时归档、调度器 kick。
- 十二个 `patent_teams_*` 工具：`create`、`add_member`、`remove_member`、`create_task`、`reassign_task`、`claim_task`、`update_task`、`send_message`、`wait`、`status`、`archive`、`delete`。
- 一段系统提示用法段落（`patent-teams:usage`，默认 order 117），教授队长协议。

<a id="configuration"></a>
## 配置

```yaml
- id: patent-teams
  config:
    stateDir: .patent-teams      # team state root under the captain's workspace
    memberProvider: spawn        # ctx.subagents provider (continuable + persona + toolFilter)
    memberModel: deepseek-v4     # optional model override for every member
    memberMaxDepth: 1            # member delegation depth cap (0 forbids delegation)
    maxMembers: 8                # team size cap
    promptSectionOrder: 117      # usage-section order
    qualityGate: false           # run the composite quality gate on worker completions
    passThreshold: 0.7           # advisory composite-score threshold (0.01..1)
    mailboxDeliveryLeaseMs: 60000 # live-delivery lease before a claimed message is retried
    approveCreation: false       # ask the approval answerers before creating a team
    approveClosure: false        # ask the approval answerers before archiving the team
```

十二个工具中有两个决定的是案件本身而不是案内的工作：`patent_teams_create` 开队、`patent_teams_delete` 收口。打开 `approveCreation` 或 `approveClosure` 后，工具在改动发生前先向本部署的 `approval` 服务索取一次决策——用户决定因此站在队长与案件两端之间：队长负责推进工作，但不单方决定「该不该组队」与「案件是否做完」。请求写明工具、具体调用与理由（建队时为队名与目标，收口时为关闭案件），审计配对由审批服务自己写入。开启开关但部署没有应答者时按拒绝处理、不放行：本模块抛 `TeamApprovalError` 并点明结果（`rejected`、`cancelled` 或 `unavailable`），模型看到的是这次调用失败。在 `never` 审批策略下的拒绝会点明这是策略自动拒绝，而不是用户决定。两个开关默认均为 `false`；patent 预设两个都打开。

`qualityGate` 默认关闭，只作用于创建时带 `worker` 契约的任务。完成时必须带输出（本次提交，或之前更新已存下）；契约缺字段、内容不足或规则门禁命中都会把任务打回给成员并附反馈。`passThreshold` 只控制何时在反馈中点名综合评分偏低，不决定是否打回。

每个成员都是队长的可续子会话，与队长同处一次预设生成。它的工具面由成员共享基线（文件、shell、后台任务、委派、团队通道与校验工具）、组合挂载的 `mcp__cnlaw__*`、角色声明且确实存在的工具，以及四件协作工具（`claim_task`、`update_task`、`send_message`、`status`）组成；队长专用改动工具与通用 `send_message` 被拒绝。没有角色的成员，或没有 cnlaw 的组合，退回仅拒绝模式。允许列表按队长的会话上下文解析，预设自身注册的工具因此能到达子会话；组合不携带的拒绝名在启动前剔除，允许列表中的未知名字仍会让成员创建失败。

<a id="state-model"></a>
## 状态模型

团队状态存放于 `<workspace>/<stateDir>/<teamId>/`：

- `team.json` — 持久 `TeamState` 记录（成员、任务、任务序号）。
- `inbox/<agentKey>.jsonl` — 每代理一个 JSONL 邮箱（`captain` 或成员名）。

工作区级的 `<workspace>/<stateDir>/retired-members.json` 记录退休成员会话 id；挂载时安装的守卫据此从代理列表中过滤，并拒绝恢复这些成员。

团队记录的变更在进程内按团队锁内执行并以原子方式持久化（同目录临时文件 + rename，Windows `EPERM` 时退化为直接写回）；信箱追加为单行 `O_APPEND` 写入，`add_member` 在锁外解析成员路由并启动子代理（状态准入与持久化仍在锁内复验），单次 spawn 不会阻塞团队的其他工具。一次实时投递认领在 `mailboxDeliveryLeaseMs`（默认 60 秒）内保持独占，之后才允许其他投递重试。`patent_teams_status` 把租约中的消息与当前可投递的消息分开计数（队长收件箱 `captain_inbox_leased`，成员收件箱 `leased`；`count` 只含当前可投递的未读），队长据此区分“没有来信”与“实时投递尚未释放的积压”。`patent_teams_add_member` 会拒绝 `role-contracts.ts` 未注册的 role id，角色名写错不会再创建一个没有契约的成员。任务状态转换由 `TASK_TRANSITIONS` 校验，被拒绝的转换会点名允许的下一状态，因此跳步的调用方（典型是 `claimed → completed`）能得知应先进入哪个中间状态，而不是盲目重试；每次认领携带 `attempt_id` 能力，重试/转派后即失效，迟到的成员更新会被拒绝。`patent_teams_delete` 将团队目录归档到 `archive/` 而非删除，保留任务与邮箱供后续复查；`patent_teams_archive` 只读地读回归档（工作区级列表 + 单团队详情）。已归档的团队名保持占用：用同名再建团队会被拒绝并返回 `TEAM_NAME_ARCHIVED`，因此后续删除不会覆盖上一代归档。

<a id="session-events"></a>
## 会话事件

每次状态变更都会向队长会话追加一条 `patent-teams/*` 事件（类型与载荷见 `event-types.ts`）：`team-created`、`member-added`、`member-removed`、`task-created`、`task-updated`、`task-validated`、`task-gated`、`message-sent`、`team-deleted`。事件是标记为 `ignorable: true` 的信息记录；持久化团队状态才是权威来源。

<a id="model-experience"></a>
## Model Experience

### 请求上下文与条件

#### 模型所见

插件挂载时，用法段落是固定的系统提示贡献，另加[工具目录](../../../docs/tool-catalog.zh.md)中的十二个工具 schema。

##### 本字段逐字文本（如需）

```markdown
When the user asks to run something with PatentTeams (e.g. "use PatentTeams to do X"), you are the captain of a multi-agent team. Follow this protocol:
1. Call patent_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
2. Call patent_teams_add_member once per role the goal needs, using a registered role id (researcher, drafter, illustrator, ...). Members are durable subagents: they wait for your messages, then work a full turn. By default a member on your current provider/model snapshots your current reasoning effort; a member routed to a different provider or model automatically uses that target model's default effort. Never ask the user to choose these per member; only pass provider/model when the user explicitly requests a different route for that role, and reasoning_effort only when the user explicitly requests a particular effort ("default" explicitly selects the target model's default).
3. Break the goal into tasks with patent_teams_create_task and wire dependencies. Assign role-specific work when useful; unassigned ready work belongs to the shared pool. The scheduler automatically claims one ready task for each truly idle member and wakes it, including across later rounds.
4. Lead by delegation: assign work with patent_teams_create_task, send guidance with patent_teams_send_message, and let idle teammates execute ready work. Then wait with patent_teams_wait and re-read patent_teams_status when it returns — the wait blocks until a task moves, a teammate reports, or a member starts or stops working, so never sleep, poll, or loop on status to pass the time. Do not duplicate a teammate's work merely because its turn is slow.
5. If work is blocked, stale, or needs takeover, always call patent_teams_reassign_task first. Reassign to another idle member, or use assignee=captain before doing it yourself. Reassignment revokes the old attempt and waits for that member to quiesce, preventing late results from overwriting the new attempt.
6. Tasks carry attempt_id capabilities. Members must use the current attempt_id for updates; STALE_ATTEMPT errors mean ownership changed. Keep dispatching and waiting until every required task is terminal and every member is idle/ready.
7. Present the team's results to the user, then patent_teams_delete the team unless the user wants to keep working with it. Deleted teams stay reviewable read-only through patent_teams_archive.

Tools: patent_teams_create, patent_teams_add_member, patent_teams_remove_member, patent_teams_create_task, patent_teams_reassign_task, patent_teams_claim_task, patent_teams_update_task, patent_teams_send_message, patent_teams_wait, patent_teams_status, patent_teams_archive, patent_teams_delete
```

#### Token 影响

固定：一个用法段落（约 2.7 KB）加十二个工具 schema。数据相关部分（团队状态载荷、任务指派提示、成员报告）有界：状态渲染最多 10 条邮箱警告，每个视图最多 10 条收件箱消息（队长收件箱与成员自己的收件箱显示完整正文，队长查看成员收件箱的预览截断至 200 字符），任务输出在状态与归档渲染中截断至 300 字符。

#### KV Cache 影响

前缀稳定：用法段落对给定挂载恒定，不使系统提示前缀失效。会话事件与团队状态从不进入提示；仅按需以工具结果形式进入。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **Web UI 为独立投影** — 上游插件的活动面板与美术资源路由未移植；`dsh-client-ui-patent-teams` 将 `patent-teams/*` 会话事件折叠为对话卡片与"团队"视图，磁盘文件与 `patent_teams_status` 仍是权威查看路径。
- **单进程串行** — 状态为文件持久化，在单个 DSH 进程内串行操作；多进程同时修改同一团队不保证一致。成员状态观察者维护进程内成员索引（由 `add_member`、`remove_member`、`delete` 维护），无关代理的状态事件不再触发状态目录全量扫描。
- **一队长一活跃团队** — 队长须先结束当前团队才能创建新团队。
- **实时投递尽力而为** — 接收方代理离线时消息留存在邮箱，在下一状态边界重试。
- **等待限于本进程** — `patent_teams_wait` 只观察本进程广播的变化，其他 DSH 进程改动团队时，等待方只能在自己的超时点上醒来。等待本身没有持久状态：调用随进程结束，无论如何都要在返回后重读团队状态。
- **审批开关的可用性取决于本部署的应答者** — 打开 `approveCreation` 或 `approveClosure` 后，没有挂载应答者、或审批策略为 `never` 的部署会拒绝该调用（`unavailable` / `rejected`），而不是照旧建队或收口。这是刻意的失败关闭方向，也是两个开关出包时都关着的原因：打开开关的部署必须同时组合一个应答者。

### 开发备注

无。
