# 专利律师工作台（Patent Workbench）建设方案

- 创建日期：2026-08-19
- 状态：**已实施（阶段 1–4）**——2026-08-19 评审通过「可落地」后落地；团队机制定为 `dsh-patent-teams` + `patent-team-composition`；阶段 5（打磨与验证）待完成。
- 追加落地（2026-09-04）：专利团队新增**文档专员**角色（`document-specialist`）——按场景输出正式交付文档、矫正与美化，不改实体结论；角色契约注册于 `patent-workflow`（13 角色），新增技能 `patent-document-polish`，`render_patent_document` 模板扩至 9 个（新增补正书 / 复审请求书 / 侵权比对意见 / 诉讼文书），七场景包均纳入文档专员并在质量门禁后、收口前安排「正式文档输出」任务。
- 收敛记录（2026-08-25）：两套 patent 预设已收敛为一套。**正本 = 仓库 `packages/preset/agent-presets/presets/patent/`**（git 跟踪；桌面打包把它部署进 `apps/desktop/resources/**`，该目录 gitignore）。原 `~/.dsh/.agent-presets/patent/`（含 `patent-matter` / `patent-fact-check` / `patent-compliance-review`、docx 交付与 HITL 放行规则）已并入正本并归档到 `~/.dsh/.agent-presets-archive/patent-*`。团队机制统一为 `dsh-patent-teams` + `patent-team-composition`；废弃泛化 agent-teams + `patent-team-workflow` 路线。
- 同步记录（2026-09-22，上游 v0.1.7-alpha.1）：preset 随上游改为声明式。**正本 = `packages/bundle/web-app/presets/patent.patch.yml`**（`dsh-web-app` bundle 内 id `patent` 的 `dsh-agent-preset` 声明，随应用安装交付），`packages/preset/agent-presets/presets/patent/` 与 `$DSH_HOME/.agent-presets` 用户根均不再存在。下文凡写这两处路径，均指该声明。
- 前置文档：`docs/patent-mode-design.md`（预设设计）、`docs/sati-as-dsh-plugins-plan.md`（插件移植计划，已实施完毕，本计划的插件层即其产物）
- 追加落地（2026-09-24）：专利团队新增**制图员**角色（`illustrator`，worker `patent-illustrator`，14 角色 / 16 worker）——附图与附图标记表的唯一权威源、标号回填、图文双向一致性核验、形式要件核验，不改实体结论；撰写包（7 成员）、答复包（7）、补正包（4）、复审包（7）纳入，无效与诉讼包按需在 `maxMembers` 内临时增补；`patent-quality-gate` 新增「附图与标号」条目；`patent_teams_add_member` 的 role 描述改为从角色目录派生。
- 评审修订：workspace 包数 10→9 勘误、规则数口径、G5 缺口表述（规则门禁已实例化，缺口为事实核验闸门与审计链整合）、阶段 1 补技能发现接线、阶段 2 状态机定案、阶段 4 落地边界
- 调研输入：开源社区专利/法律 AI 项目横向扫描（star 经 GitHub API 核验，2026-08-19）
- 定位：**在已有插件层基础上，补齐"工作台"缺的五块拼图，分阶段落地为可用的专利律师日常作业环境**
- 案卷目录口径（2026-11-04）：[ADR-001](adr/ADR-001-matter-folder-index.md) 将案卷真源定为可配置工作根目录（典型值 `/Users/xujian/工作`）下的 `<案号>/` 加 `_matter-log.md`。下文 `patent-workspace/<案号>/` 读作该目录，不要求另建独立 patent-workspace 树，也不要求每个案子一个 Cursor 或 git 项目。案卷与根任务双轨留给后续 ADR。

---

## 1. 目标与定位

在 `/Users/xujian/projects/deepseek-harness`（DSH fork）上构建**专利律师工作台**：面向专利工程师/代理人/律师的日常作业闭环——交底书理解 → 现有技术检索 → 新颖性/创造性分析 → 权利要求与说明书撰写 → 审查意见答复 → 侵权比对/无效宣告 → **案件管理 → 文书交付 → 审计留痕**。

三条硬约束（延续既有决策）：
1. **零 Sati 进程、零 MCP 桥**——全部能力以 DSH 原生插件 + preset + 技能承载；
2. **法域以中国专利法体系为主**（CNIPA），检索源 Google Patents + CNIPA 公布公告；
3. **幻觉防护为内建项**（七道防线，见 docs/patent-mode-design.md §12），不是可选优化。

---

## 2. 现状盘点（实证，2026-08-19 核实）

### 2.1 已有基础（已完成部分）

| 层 | 内容 | 状态 |
|---|---|---|
| **插件层** | `packages/patent/` 9 个 workspace 包：`patent-core`（纯库：atoms 引擎、ModelPort、双轨 checker、evidence 引擎、claim-chart、图引擎，不单独挂载）、`patent-data`（nuo-patent 检索/元数据/法律状态）、`patent-knowledge`（knowledge.db：判例 FTS/法规/wiki/图谱）、`patent-workflow`（workflow/flexible-plan/plantask 状态机 + HITL 审批）、`patent-tools`（29 个模型可见工具）、`patent-rule`（规则引擎 + post-execute 门禁 + 证据守卫）、`patent-document`（render_patent_document：5 个文书模板 → HTML/PDF）、`tool-literature`、`methodology`（TRIZ） | ✅ 已移植（P0–P3 落地，git log 可查） |
| **数据层** | `vendor/nuo-patent` v2.3.1（MIT 数据引擎）、本机 `knowledge.db`（21.5 万节点图谱/7.4 万判例/1500+ wiki 卡片，私有分发）、ego-browser 反爬接缝 | ✅ 就绪 |
| **技能层（用户级）** | `~/.agents/skills/`：`patent-legal`（撰写四领域/检索/CNIPA 查询/下载/比对）、`document-processing`、`officecli`、`ego-browser`、`browserclaw` | ✅ 就绪，任何会话自动发现 |
| **预设设计** | `docs/patent-mode-design.md`：五层架构（人设/工具面/技能层/流程层/知识库）、五大流水线 L1–L5、三大 HITL 确认点、七道幻觉防线、证据链契约 | ✅ 已落地（正本 `packages/preset/agent-presets/presets/patent/`） |

### 2.2 缺口（对照开源调研发现）

| # | 缺口 | 现状 | 开源参考 | 对应阶段 |
|---|---|---|---|---|
| G1 | **patent preset 未落地** | 设计文档就绪，shipped 版（`apps/desktop/resources/mac/backend/config/agent-presets/patent/`，sati plan P4.4 产物）已含 persona/plan/7 技能/插件组但漏挂 `patent-data` 行；用户级 `~/.dsh/.agent-presets/patent/` 已落地（2026-08-19 复制 + 补行）；headless/desktop profile 独立依赖树不含 patent 包，会话级验证需 GUI | dsh-legal-work-bench（preset 目录结构样板） | 阶段 1 |
| G2 | **案件管理（docket/matter）** | 无；设计文档只有 `_case-registry.md` 单文件索引 | dsh-legal-work-bench `legal-matter`（八级目录 + 六列状态机 + 只追加事件） | 阶段 2 |
| G3 | **文书交付只有 HTML/PDF** | `patent-document` 渲染 5 个模板为 HTML/PDF；无 docx 原生修订 | patrick（agent 直接在 .docx 内以 Word tracked changes 起草/修改，接受或拒绝） | 阶段 3 |
| G4 | **多专家协作是"按需 fork"，无持久团队** | docs/patent-mode-design §8.4 定义了 5 个 `subagent_fork` 角色，一次性（`dsh-subagent-fork-in-process` 已具备） | dsh-agent-teams（captain + durable members + 依赖感知任务 + 事件驱动调度，源码已存于本机调研目录） | 阶段 4 |
| G5 | **事实核验闸门与审计链未实例化** | 规则门禁已实例化（`patent-rule` post-execute 门禁 + `patent-workflow` quality-gate/output-gate/approval 审计闭环）；缺口是"事实核验（法条/判例/对比文件/日期数字）+ 合规审查"双闸门技能与案件级审计链无落地样板 | dsh-legal-work-bench（04 事实核验 + 05 合规审查 Fail-Closed + 16 审计链哈希链） | 阶段 2/3 |

---

## 3. 目标架构（六层）

```
┌─────────────────────────────────────────────────────────────┐
│ ⑥ 治理层  双闸门（事实核验 + 合规审查）· 审计链 · quality-gate   │ ← 补（阶段2/3）
├─────────────────────────────────────────────────────────────┤
│ ⑤ 预设层  ~/.dsh/.agent-presets/patent/（agent.cordis.yml）   │ ← 补（阶段1）
│           persona + 工具行挂载 + plan 段落 + 技能点亮          │
├─────────────────────────────────────────────────────────────┤
│ ④ 编排层  workflow / plantask HITL · subagent_fork 专家角色    │ ✅ 已有 + 阶段4 增强
│           （可选：agent-teams 持久团队）                       │
├─────────────────────────────────────────────────────────────┤
│ ③ 技能层  preset 内 7 技能 + 用户级 patent-legal 包 +          │ ✅ 已有 + 补案件管理/门禁
│           案件管理技能（新）                                   │
├─────────────────────────────────────────────────────────────┤
│ ② 插件层  dsh-patent-* 9 包（23 工具 + 规则门禁 + 文书渲染）    │ ✅ 已有（阶段3 增 docx）
├─────────────────────────────────────────────────────────────┤
│ ① 数据层  nuo-patent · knowledge.db · ego-browser · 文件化知识库│ ✅ 已有
└─────────────────────────────────────────────────────────────┘
```

桌面壳（`apps/desktop`、社区 DSH Desktop）只负责窗口/托盘/终端/更新，**工作台能力全部在插件 + preset 层**——换壳不换能力。

---

## 4. 实施路线（五阶段，每阶段可独立验收）

### 阶段 1 · patent preset 落地（G1）

**做什么**：把 `docs/patent-mode-design.md` §3–§4 的目录结构与 `agent.cordis.yml` 落地为 `~/.dsh/.agent-presets/patent/`；在工具行中**挂载 `dsh-patent-*` 插件族**（不是设计文档里的"零代码纯工具行"——现状已演进为插件已移植，preset 直接接线）。

**关键动作**：
1. `preset.yml`：name「专利模式」，description，order 5（字段与语法照 `packages/preset/agent-presets/src/metadata.ts` 与 `liangshen/preset.yml` 样板）；
2. `agent.cordis.yml`：standard 为底 + `@deepseek-ai/dsh-patent-tools`、`dsh-patent-workflow`、`dsh-patent-rule`、`dsh-patent-document`、`dsh-patent-data`、`dsh-patent-knowledge` 挂载行（参考各插件 README 的装配说明；`patent-core` 是纯库，经 `patent-tools` 依赖引入，不需要挂载行）；所有发布服务的行必须在 `cordis:group` + `isolate` 领域内（mount 强制，见 standard/liangshen 文件头注释）；`tool-web` 保持 `fetch: false`（有已提交的 fix）；
3. persona 全文（设计文档 §6）+ plan-mode 定制段落（§8.2）；
4. preset 内 7 技能（§7.2）落盘到 `~/.dsh/.agent-presets/patent/skills/`，**并**在 `agent.cordis.yml` 里补技能 provider 接线——技能发现不是自动的：仿 `liangshen` 的 `skill-filesystem` 行（本地目录 provider）与 `skill-search`（按需注入的 skill_search/skill_load 两个工具）让技能进入会话；
5. 新会话选「专利模式」验证：技能可列出、专利工具可调用、人设生效。

**参考**：`dsh-legal-work-bench` 的 `preset/preset.yml + agent.cordis.yml + skills/` 三段式；`~/.dsh/.agent-presets/liangshen/`（本机用户级 preset 样板：persona/instructions/skill 接线/plan 段落全齐）；`packages/preset/agent-presets/`（standard preset 源码）作接线语法蓝本。

**验收**：新会话选中「专利模式」，`patent_search`、`patent_case_search`、`draft_claims`、`render_patent_document` 均可调用；persona 纪律生效；plan-mode 段落生效。

### 阶段 2 · 案件管理层（G2）+ 双闸门实例化（G5）

**做什么**：借鉴 `dsh-legal-work-bench` 的 `legal-matter`，为专利作业建案件管理技能 + 目录规范；把"事实核验 + 合规审查"双闸门与案件级审计链实例化为 preset 内技能。

**关键动作**：
1. 新技能 `patent-matter`（preset 内）：案件 = 八级目录（可配置工作根目录下的 `<案号>/`，典型值 `/Users/xujian/工作/<案号>/`，其下 00-交底书 → 04-撰写 → 05-答复 → 99-知识库）+ 六列状态机（**按 L1–L5 流水线阶段定案**：open/retrieving/analyzing/drafting/review/closed 仅作展示别名）+ **只追加事件日志**（`_matter-log.md`：每步记录时间/动作/产物/审批人）；
2. 审计链：事件日志 + 产物文件头元数据（来源/版本/审批/时间戳），与 persona 纪律 5"输出即证据"合并落地；`patent-workflow` 的 `approval` 审计闭环（ApprovalRecord 只增日志）已存在，事件日志与其并轨，不做第二套账本；
3. 双闸门技能 `patent-fact-check`（法条/判例/对比文件/日期数字核验）+ `patent-compliance-review`（规则检查清单，复用 `dsh-patent-rule` 的 `rule_check` 工具与规则库），Fail-Closed：闸门不过不交付；
4. 三 HITL 门（检索式/布局/放行）经 `ctx.approval` 接线（`patent-workflow` 已有 plantask approval 接缝，`packages/patent/patent-workflow/src/index.ts`）。

**参考**：`dsh-legal-work-bench`（matter/audit-log/gate 三个技能）；`docs/patent-mode-design.md` §5、§8.3、§12.3。

**验收**：建一个虚拟案子，跑完「建案 → 检索 → 分析 → 撰写 → 门禁 → 归档」，事件日志完整、审计链可追溯、双闸门能拦截一处人为注入的错误法条。

### 阶段 3 · docx 原生修订交付（G3）

**做什么**：在 `patent-document` 基础上增加 **docx 交付通道**——不重造轮子，先接 DSH 已有的 Office 技能链（`~/.agents/skills/officecli` + `document-processing`），再由 agent 以 tracked changes 模式修订（对齐 patrick 的工作方式）。

**关键动作**：
1. 立即可做：preset persona + `patent-quality-gate` 中约定"成品交付 = md 起草 → docx 成品（officecli）→ 修订一律走 tracked changes"；
2. 中期（若需要原生能力）：`dsh-patent-document` 增 `render_patent_docx` 工具（把 5 个模板改渲染为 .docx，office 库选型：docx npm 包或 LibreOffice headless 转换），输出路径沿用 `data/cases/<caseId>/outputs` 约定；**此步改动 `packages/patent/`，须按仓库插件纪律执行**（工具注册走 `ctx.effect()`、补单测与快照，见 docs/cookbook/adding-a-tool.md）；
3. 与 `patent-matter` 集成：交付物版本号 + 修订历史入事件日志。

**参考**：`mhurhangee/patrick`（docx tracked changes 起草/修订交互、法条库接地、claim chart）；注意其局限——只改 Patrick 创建的草稿、不改原件（这条纪律直接沿用）。

**验收**：一份 OA 答复以 docx 交付，修改对照以 tracked changes 呈现，原件未被改动。

### 阶段 4 · 专家协作编排增强（G4）

**做什么**：在已有 `subagent_fork` 角色（检索员/新颖性审查员/创造性审查员/对立审查员/无效反方）之上，评估接入 **agent-teams 持久团队**（源码已存于本机调研目录，可改造为 `dsh-patent-teams`）。

**关键动作**：
1. 维持默认：单会话内 `subagent_fork` 专家互评（零新依赖，先跑通）；
2. 评估增强：agent-teams 的 captain 即专利模式会话，members = 检索员/撰写员/审查员（durable、可唤醒续聊），任务依赖感知（检索完成 → 撰写才开始），调度器事件驱动；改造点：把其 `src/tools.ts` 的通用任务协议换成专利流水线阶段，state 落在 `patent-workspace/.agent-teams/`；
3. 落地边界：若接入需要改动仓库代码，须按插件纪律（Service Definition/Provider/Consumer 三角色 + 单测 + 快照）立项为正式包；否则以用户级脚本/技能形态落地，不污染仓库；
4. 若接入，`patent-matter` 状态机与团队任务状态同步（避免两套账本，事件日志为唯一事实源）。

**参考**：`NanmiCoder/dsh-agent-teams`（已拆解源码：captain 即调用者、attempt/attemptId 防覆盖、事件驱动调度、退休守卫）；`erdalbektas/OpenPatent` 的 workflow agent 划分（draft/prosecute/consult/litigate/manage/strategy）可映射为成员角色。

**验收**：一份交底书由"检索员 → 撰写员 → 对立审查员"三成员接力完成，队长汇总，全程无人工干预失败点；或维持 fork 方案且互评通过。

### 阶段 5 · 打磨与验证（全流程）

**做什么**：按 `docs/patent-mode-design.md` §10 P4 的验收标准，用真实案件跑通三类典型任务。

**关键动作**：
1. L1→L3 完整流水线（交底书 → 检索 → 三性 → 撰写 → 门禁）跑通一次；
2. L4 OA 答复、L5 无效/侵权各跑通一次；
3. 迭代 persona/技能/门禁（preset 锁定机制：每次用新会话验证，验证通过再设默认 `agent-presets.default`）；
4. 沉淀：`99-知识库/` 自然积累判例/技巧；精选 wiki 卡片 30–80 张入 `references/`（可选）。

**验收**：三种典型任务各跑通一次；双闸门零漏检（注入错误的测试样本均被拦截）；审计链可完整重建任一产出的证据链。

---

## 5. 开源借鉴清单（含 star 核验，2026-08-19）

| 项目 | ★ | 借鉴点 | 落地 |
|---|---|---|---|
| kingselyjoe/dsh-legal-work-bench | 1 | preset 三段式结构、双闸门验证（04/05）、审计链（16）、案件管理（22 legal-matter）、门禁审批（23 legal-gate） | 阶段 1/2 |
| mhurhangee/patrick | 19 | docx tracked changes 起草/修订、只改草稿不改原件、法条库接地、claim chart | 阶段 3 |
| NanmiCoder/dsh-agent-teams | — | captain 团队协议、依赖感知任务、attempt 防覆盖、事件驱动调度（源码已存本机） | 阶段 4 |
| erdalbektas/OpenPatent | 37 | workflow agent 划分（draft/prosecute/consult/litigate/manage/strategy） | 阶段 4（角色映射） |
| RobThePCGuy/Claude-Patent-Creator | 172 | MPEP/USC Hybrid RAG 检索设计 | 未来（知识库引擎化时） |
| handsomeZR-netizen/cn-patent-drafter | 42 | CNIPA 规范同步节奏（撰写技能校准） | 阶段 5（校准基线） |
| yuc16/PatentRadar | 51 | 侵权分析产出技能打包方式 | 阶段 5（参考输出格式） |
| CSlawyer1985/claude-for-legal-ZH | 751 | 领域覆盖地图 + 画像机制（work-bench 的参考，间接） | 阶段 1（persona） |
| parkerhancock/patent-client-agents | 43 | IP 数据工具封装模式 | 插件层（可选对照） |

**不引入**：OpenPatent 的 OpenCode 底座、patrick 的 Tauri 壳、Claude-Patent-Creator 的 MCP server（与"零 MCP 桥"决策冲突）——只借鉴工作流/交互设计，不移植实现。

---

## 6. 风险与边界

| 风险 | 应对 |
|---|---|
| preset 锁定（会话产生内容后不可换 preset） | 迭代期每次新会话验证；验证通过才设默认 |
| docx tracked changes 在 officecli 链路中的保真度 | 阶段 3 先以"md 起草 → docx 成品"落地，tracked changes 作为独立子任务验证后再推广 |
| agent-teams 与 patent-matter 双账本 | 阶段 4 若接入，统一事件日志为唯一事实源，团队任务状态只是投影 |
| knowledge.db 私有分发 | 维持现有策略：本机直用/私有渠道，不进 git 与公共制品仓 |
| 双闸门漏检 | 规则基于 `dsh-patent-rule` 规则库 + 人工抽查；互评（subagent_fork）为启发式防线，明示"不替代人工复核" |
| 阶段 3/4 改动仓库代码引入回归 | 按插件纪律立项：效果注册、单测、快照、README 契约同步；否则以用户级技能/脚本落地 |
| 桌面壳与插件版本漂移 | 插件 pin 版本；能力全部在插件层，换壳不换能力 |

---

## 7. 立即行动清单（下一小步）

1. 建 `~/.dsh/.agent-presets/patent/`，写 `preset.yml` + `agent.cordis.yml`（挂载 6 个 `dsh-patent-*` 插件，`patent-core` 为纯库不挂载），从 `liangshen/` 与 standard preset 源码复制语法骨架；
2. 写入 persona（设计文档 §6 全文）与 plan-mode 段落（§8.2），并补技能 provider 接线（`skill-filesystem` 指向 preset `skills/`，仿 liangshen）；
3. 新会话验证工具面；通过后进入阶段 2 案件管理技能。
