# Agent Note: 将 Agent Teams 泛化为领域无关的能力接缝

Status: proposed

[English](2026-08-27-generalize-agent-teams-capability.md) | 中文

## Problem

多智能体团队功能在本仓库中存在三份实现、两种互不兼容的持久化模型，而唯一已发布的那份被锁死在专利领域：

- `packages/team/agent-team` + `packages/team/tool-agent-team`（[落位决策](../../archived/architecture/2026-08-18-experimental-agent-teams-packages.md)）——Lead/teammate 模型，邮箱与任务板存放在 Lead 的会话日志中，带事件折叠与不变量重放。未发布（experimental 发布排除），仅被 headless 示例挂载，且没有调度器。
- `packages/patent/patent-teams`——上游插件 `NanmiCoder/dsh-agent-teams` 的正式移植版，重定域到专利：文件态 `.patent-teams/`、带 `attempt`/`attemptId`/`handoffId` 撤销的事件驱动调度器、JSONL 邮箱、组合式完成门禁，以及唯一真实接入的 preset（[接线](../../implemented/feature/2026-08-23-wire-patent-teams-into-preset.zh.md)）。
- 上游插件本体（外部、MIT、约 1.1k stars）——领域无关且比我们的移植版功能更全，但在仓库之外、不受我们的接缝控制。

其余目标领域完全没有团队能力：`code` 与 `document` preset 只通过通用 `subagent`/`workflow` 工具组合智能体，自媒体领域位于用户的 ZCode 插件环境（video-agent-kit）、不在本仓库。今天要给第二个领域加上团队，就得复制 patent-teams（九个源文件、工具前缀、事件名、状态目录、UI 面板、preset 挂载），再改掉复制件里的领域导入。

专利耦合点恰好只有三处，正是任何复制件都要重写的地方：[members.ts](../../../../packages/patent/patent-teams/src/members.ts) 静态导入 `dsh-patent-workflow` 的 `RoleContract` 折叠（[决策](../../implemented/feature/2026-08-23-role-worker-contract-mapping.zh.md)）；[service.ts](../../../../packages/patent/patent-teams/src/service.ts) 静态导入 `roleContract`/`validateWorkerOutput` 与 `evaluatePatentContent`；`patentRuleGate` 查找已经是可选的 `ctx.get`（[门禁](../../implemented/feature/2026-08-23-quality-gate-into-teams.zh.md)）——需要反转的静态导入只有两处，第三处已经是正确的接缝形状。

两边的特性集也已分叉：移植版删掉了上游的 staged 计划 + Approve & Run、`halted`/`escalated` 生命周期与 `agent_teams_resume`、结构化质量任务种类（`requirements`…`integration`，带 verdict、验收结果、修复循环）以及命名团队 profiles；experimental 那对则是无调度器的手工委派加 `waitForChange`。任何后续领域都会继承这种漂移，而不是收敛到同一个核心。

## Proposal

抽取一个领域无关的 agent-teams 能力接缝供所有领域挂载，领域策略通过两个声明的钩子插入而不是通过复制。patent-teams/上游的文件态设计成为发布的 provider；experimental 那对退役。

### 上游研究确立了什么

`dsh-agent-teams` 是通用核心的参照系，因为它已在自己的范围内解决了领域无关性。值得纳入其所有权的语义：

- 基于 `ctx.subagents.startContinuable()` + `followup()` 成员的队长/成员模型，逐成员的模型路由快照（`provider`/`model`/`reasoning_effort`，外加 fallback 路由）。
- 事件驱动共享调度器：每次空闲边沿与任务变更都为真正空闲的成员尝试一次原子领取；转派先撤销旧 `attemptId`，因此迟到写入无法覆盖新结果；只有冷重启遗留任务才生成新 attempt。
- 文件状态为真相（`<workspace>/.agent-teams/<teamId>/team.json` + `inbox/*.jsonl`），会话事件（`agent-teams/*`）为审计/重放镜像——与已发布移植版相同的方式满足我们的 model-visible-⟺-logged 规则。
- 结构化质量种类：verdict 门控的完成判定与自动 repair/review 后续任务；人工停止（`halted`）区别于自动到顶（`escalated`），且只能通过显式 `agent_teams_resume` 恢复。
- `cordis.patch.yml` 中的命名 profiles（`taskPlanning: captain | seed`、成员阵容、protocol、review policy）——领域用配置而非代码交付的组合面。
- 两阶段 staged 计划（磁盘上可编辑的成员占位与 DAG，用户点击 Approve & Run 之前不创建子会话）。

### 包拓扑

新增 `packages/teams/` 组，遵循[能力接缝](../../../../docs/glossary.zh.md#capability-seam)纪律（Service Definition 与 provider 角色齐备；Consumer 分离）：

- `packages/teams/agent-teams`——Service Definition `ctx.agentTeams` 加参考文件态 provider：状态、调度器、邮箱、基于 continuable 子代理的成员生命周期、`agent_teams_*` 会话事件。从 patent-teams 泛化并移除专利导入；包名、工具前缀、事件命名空间与状态目录（`.agent-teams/`）全部去掉 `patent` 限定。
- `packages/teams/tool-agent-teams`——工具 Consumer：`agent_teams_*` 工具、队长协议提示段，以及成员作用域的工具禁用策略（`MEMBER_DENIED_TOOLS` 泛化为禁用所挂载团队工具集中的队长专属工具）。
- `packages/client/ui-agent-teams`——UI Consumer，泛化 `ui-patent-teams` 的事件折叠；每个团队一个聊天节点面板，命名空间无关。

刻意推迟把文件 provider 从 `agent-teams` 拆出：在 provider 角色独立演化（session-log provider、远程 provider）之前，接缝保持单包。

### 领域策略接缝

两处静态专利导入变成服务上声明的、配置可见的接缝：

- **成员 persona 增强**——可选的 `memberPersona(role): prompt-section` 贡献。专利挂载来自 `dsh-patent-workflow` 的角色契约；其他领域不挂载或挂自己的；无贡献时的成员 persona 就是名字 + 角色 + execution prompt，恰为上游的形状。
- **任务完成门禁**——可选的 `taskCompletionGate(task, output): pass | bounce(reason)` 贡献，取代 `qualityGate: boolean` + 静态 `evaluatePatentContent` 耦合。专利挂载其 evaluate + `patentRuleGate` 组合；上游的结构化质量种类作为现成门禁 provider 发布，编码类 preset 可单独挂载。任务上的 `contractValidation` 记录变成门禁输出而非专利词汇。

组合知识留在各领域已经奏效的位置：preset 在 `isolate` realm 后挂载接缝，技能（`patent-team-composition` 的场景角色包模式）与命名 profiles 承载阵容/DAG 知识。任何领域都不交付团队代码。

### 迁移与范围

- 专利重定基：`packages/patent/patent-teams` 收缩为实现两个钩子的小策略插件，覆盖 `patent-workflow`/`patent-tools`/`patent-rule`；专利 preset 的 `isolate.patentTeams` 挂载改名为通用服务。适用 pre-release 立场——不迁移旧 `.patent-teams/` 状态目录。
- Experimental 退役：删除 `packages/team/agent-team` + `tool-agent-team`，其 headless 示例改为挂载通用接缝，入站链接（含 `agentTeams` api-catalog 键）在同一变更中修复。其耐久的思想——团队事件的不变量重放、`waitForChange`——在此记录为日后并入通用 provider 的候选，而非阻塞项。
- 上游特性采纳分阶段：P0 是保持移植版现有语义的通用核心（调度器、attempt 撤销、邮箱、模型快照）；P1 加 `halted`/`escalated` 生命周期与 `agent_teams_resume`、命名 profiles；P2 是 staged 计划 + Approve & Run 与浮层活动面板（需要命令面与客户端工作）。
- 领域落位：专利迁移（P0 验证），`code`/`standard` preset 以现成质量种类门禁获得接缝（P1），`document` 携带组合技能挂载并以 `document_deliver` 为终局门禁（P1）。自媒体在该领域进入本仓库之前保持在外；接缝就是它届时要挂载的东西。

## Alternatives considered

**改为泛化 experimental 的 session-log 那对。** 它是我们自己的、可做不变量重放，并让所有团队状态处于 model-visible-⟺-logged 规则原生的会话日志之下。落选原因：它没有调度器、没有已发布消费方、没有 UI 路径、没有 preset 接线，而两个经过实战检验的实现（约 1.1k stars 的上游、我们已发布的移植版）独立选择了文件态 + 会话事件作审计镜像；采纳它意味着在较弱的地基上重建该特性已被验证的一半。

**把上游插件当外部依赖消费。** 零移植成本且由上游维护。落选原因：第三方插件不能成为我们的能力接缝——我们无法控制其服务词汇、其 host 键兼容窗口（它已在我们 rc 版本间探测 `ctx.httpServer` 与 `ctx.webServer`）或其事件/会话日志契合度，而且这里的每个领域集成都将依赖外部发布周期。

**按领域复制 patent-teams。** 第二个领域的现状路径。落选原因：复制件数量随领域数增长，且每个上游级别的特性（resume、profiles、staged 计划）都要重新移植 N 次；三处耦合点让每次复制都成为改名重接线的体力活而非配置活。

**仅提示词级组合（code/document 的现状）。** 基于通用 `subagent`/`workflow` 工具的 preset 与技能，没有共享的持久任务板。落选原因：没有依赖感知的任务领取、没有持久的对等邮箱、没有跨重启连续性——这些正是两份现有团队实现的动机所在。

## Acceptance criteria

- `packages/teams/*` 不含任何 `dsh-patent-*` 导入；专利 preset 挂载通用接缝加专利策略插件，移植过来的 patent-teams 测试与快照在行为上不变地通过。
- 专利组之外存在一个领域无关挂载：headless 示例（取代 experimental 那对）端到端跑通一个 fixture 团队，standard 或 code preset 的挂载作为已记录决策。
- 工具名（`agent_teams_*`）、会话事件（`agent-teams/*`）与状态目录写入 `docs/subsystems/`；api-catalog 重新生成；`doc-sync` 与 agent-note 门禁通过。
- experimental 包删除、入站文档与笔记链接修复，其退役记录在本笔记中。

## Risks

- 上游分叉：外部插件持续演化（其 staged 计划与浮层面板领先于我们）；拥有接缝意味着必须有意识地选择采纳什么，分阶段计划可能落后于我们想要的上游特性。
- 持久化模型之争可能重启：session-log 一方暂时失去不变量重放地基；已记录的缓解是把重放/不变量日后折叠进文件 provider 的事件镜像。
- UI 面成本真实存在：聊天节点面板触手可及，但上游的浮层面板、DAG 交互与 staged 计划编辑器是 P2 客户端工作，若需求保持专利形状则可能永远不落地。
- 继承的限制在泛化后依然存在：每队长同时一队、每团队单进程一致性、队长离线时无法冷恢复成员的事件驱动调度。泛化接缝不修复这些，只把它们变成显式的配置文档限制。
- 范围蔓延：profiles 与 staged 计划是产品特性而非接缝前提；P0/P1/P2 切分就是为了让接缝迁移保持可评审。
