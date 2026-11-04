# 外部工作台（dsh-personal-workbench）与专利工作台集成设计

> 目标：把 `@dely0/dsh-personal-workbench`（通用「日历 + 层级任务 + AI 澄清/拆解/执行/复盘 + 知识库」插件，外部仓库 <https://github.com/Dely0/dsh-personal-workbench>）与本仓库的专利工作台（`packages/patent/*` + patent preset + `packages/client/ui-patent-teams`）有机结合。
>
> 决策：
> 1. **数据分库**。`knowledge.db` 是专利权威知识库（判例 FTS / 法规 / wiki / 图谱，只读检索，私有），保持原样；外部工作台的作业数据落到新的 **`case.db`**，与 `knowledge.db` 物理隔离。
> 2. **半移植路线**：外部插件的**服务器半原样挂载**（`webServer` 路由 + AI 工具 + system-prompt 指南），**客户端经 Phase 1 冒烟实证直接采用**（slot 本地化重写降为二期可选项）。
> 3. **用户自建任务与案件任务共存**：`case.db` 同时承载用户手动 / 自然语言 / 重复规则创建的个人任务与专利案件映射任务；日历视图是人机共用的统一界面（见「日历视图」节）。
> 4. 本文档为**可执行的集成设计**：每阶段给出命令与验收清单，逐阶段验收通过再进入下一阶段。
>
> 5. **案卷真源**以 [ADR-001](adr/ADR-001-matter-folder-index.md)（Accepted，2026-11-04）为准。案卷正文在可配置工作根目录（典型值 `/Users/xujian/工作`）的 `<案号>/` 与 `_matter-log.md`。工作台 SQLite（`~/.dsh/workbench`，库文件 `case.db`）只做文件夹索引。下文若写 `patent-workspace/<案号>/`，读作 `<工作根目录>/<案号>/`。案卷与根任务双轨、多案卷工作目录不一致、以及只接受相对 `patent-workspace` 的路径检查，留给后续 ADR，本文不扩大产品范围。

---

## 1. 数据分层设计（核心）

三个数据载体，职责互斥，一处一事实：

| 载体 | 语义 | 读写 | 归属 |
|---|---|---|---|
| `knowledge.db` | 专利权威知识库：判例全文检索、法规、wiki 卡片、图谱、向量 | **只读**（对集成方案而言） | [patent-knowledge](../packages/patent/patent-knowledge/src/index.ts)（`openKnowledgeDb`，含版本校验 / 压缩 / `vectors.db`） |
| `case.db`（**新建**） | 作业数据：案件任务、用户个人任务、子任务、计划、日报周报、复盘、任务记忆、会话注册、工作台侧个人沉淀 | 读写 | 外部 workbench 的 SQLite（`dbPath` 指向 `case.db`） |
| `<工作根目录>/<案号>/` | 案件产物文件：七级业务子目录（00-交底书 → 05-答复 → 99-知识库）+ `_case-registry.md` + `_matter-log.md`。工作根目录可配置，典型值 `/Users/xujian/工作` | 读写（文件） | patent preset 技能（见 [patent-workbench-plan](patent-workbench-plan.md)） |

**边界规则（全文档唯一事实源定义处，后文只引用不重述）**：
- `_matter-log.md` 是案件级审计的**唯一事实源**；`case.db` 的 `task_events` 只是它的只读投影（方向与触发器见 Phase 5）。
- `case.db` 只存「索引 / 状态 / 结构化事实与指向」，不存案卷原文；案卷原文在可配置工作根目录下的 `<案号>/`（典型值 `/Users/xujian/工作`）。`knowledge.db` 不是案卷库。桥接可以读投影，把投影写回案卷目录不是账本。
- 外部 workbench schema 的 `knowledge_entries` / `ideas` / `idea_clusters` 属于**作业侧个人沉淀**，随 `case.db`，不并入专利 `knowledge.db`。
- 备份：`case.db` 与 `knowledge.db` 同等待遇——本地私有、不进 git 与公共制品仓；`case.db` 每日一份 WAL checkpoint 后的整库备份（外部 README 的「每日 JSON 备份」仍是规划，集成侧以 SQLite 文件备份为准），保留最近 30 份。

---

## 2. 现状盘点与兼容性结论（实证）

### 2.1 宿主半（服务器侧）——兼容 ✅

外部插件 `inject = ['webServer', 'systemPrompt', 'tools']`，调用 `ctx.webServer.register(route)`、`ctx.tools.register(tool)`、`ctx.systemPrompt.section({ name, order, text })`。

- 三个 peer 依赖在仓库同名存在：`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`。
- `webServer.register(route): () => void` 与 [webserver/src/index.ts](../packages/host/webserver/src/index.ts) 的签名一致。
- `WorkbenchDbConfig { dataDir?, dbPath? }` 支持自定义路径，改库名为 `case.db` 只需挂载 config 指 `dbPath`，不改其源码。

### 2.2 客户端半——实测兼容 ✅（Phase 1 冒烟实证）

初判「不兼容」被 Phase 1 冒烟推翻：外部客户端在 `0.1.2-alpha.4` 的 web 上完整工作——侧边栏「工作台」入口注入（`data-dsh-personal-workbench-entry`）、点击后中心列接管（视图 `display:block`）、今日/日历/任务/知识库/点子五个 tab 渲染、统计卡出数、零控制台错误；API 建任务后任务列表与统计即时呈现。本仓库 web 客户端保留了 rc.6 的 DOM 契约（`data-pane` / `centerCol` / `data-dsh-frame` / `dsh-panel-activate`），且客户端 bundle 由 web 客户端的模块加载器合并加载（无独立 script 标签）。

结论：**客户端不重写，直接采用**。slot 重写（`ctx.slots.register` 惯例）降级为二期的可选本地化项（深度主题统一 / desktop worker transport 一致性），触发条件见 Phase 4。

### 2.3 依赖与安装摩擦 ⚠️

- 外部插件 peer 声明 `^0.1.0-rc.6`；本仓库运行时 `0.1.2-alpha.4` 按 semver 预发布规则**不满足该 range**（不同版本元组的 prerelease 互不匹配），pnpm 会报 unmet peer——属预期告警，实测以运行时行为为准。
- 从 git 安装会触发 pnpm 10.x 的 git-hosted 构建白名单（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），需把该包加入 profile 的 `onlyBuiltDependencies`；tarball 与 `file:` 安装无此问题。
- `dsh plugin --profile web add <pkg>` 走 pnpm 转发；`dsh plugin --profile web install <name@version>` 走插件市场管道（带 preview 校验），两者语法见 [apps/cli/src/plugin.ts](../apps/cli/src/plugin.ts)。

---

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│ 专利工作台（内核，原有） 检索/三性/撰写/答复/无效 + 双闸门 + 审计 │
│   patent preset · packages/patent/* · ui-patent-teams        │
└──────────────▲──────────────────────────────▲───────────────┘
               │ bridge 工具（HTTP 复用其路由）  │ slot 挂载
┌──────────────┴──────────────────────────────┴───────────────┐
│ 外部工作台（外围，半移植） 日历/任务树/知识库/日报周报           │
│   服务器半原样(webServer+tools+prompt) · 客户端直接采用(实测兼容) │
│   用户自建任务 + 案件映射任务 同库同视图（人机共用）              │
└──────────────┬──────────────────────────────┬───────────────┘
               │                               │
        ┌──────▼──────┐                 ┌──────▼──────┐
        │   case.db   │                 │ knowledge.db │ 只读
        │ 作业数据     │                 │ 专利权威知识库 │
        └─────────────┘                 └─────────────┘
```

---

## 4. 获取与前置

- 源码：`git clone --depth 1 https://github.com/Dely0/dsh-personal-workbench.git`（本文档以 `wb/` 指代克隆目录）。
- 版本：`@dely0/dsh-personal-workbench` 当前 v1.9.0，目标 DSH `0.1.0-rc.6`；本仓库 `0.1.2-alpha.4`。unmet peer 告警按 §2.3 处理。
- 服务器半与数据模型按阶段接线；客户端实测兼容，直接采用。

---

## 5. Phase 1 · 兼容性冒烟（先取证，再动手）

**目的**：确认外部插件在本地实装后，服务器半能挂、客户端半的真实表现，不凭空假设。

**实施**：
1. 隔离挂载到独立 profile（不碰活跃的 `web` profile；活跃 profile 由旧版 pnpm 初始化，直接操作会撞 `ERR_PNPM_UNEXPECTED_STORE` 的 pnpm store 版本差）：
   ```sh
   pnpm dsh plugin --profile web-wb add @dely0/dsh-personal-workbench   # 初始化 + 安装
   pnpm dsh --profile web-wb --port 3180 --no-open
   ```
   新 profile 的默认模板只含 `dsh-base`；把 `@deepseek-ai/dsh-web-app` 加入该 profile 的 `dsh.profile.bundles` 即可——bundle 解析先走源码锚点（`apps/cli` 的 node_modules），无需 npm 安装。
2. 故障分支：git 安装撞白名单 → 改 tarball 或本地 `pnpm dsh plugin --profile web-wb add file:./wb`（先 `pnpm build`）；unmet peer 告警 → 记录但不阻断；旧 profile 撞 store 版本差 → 换新 profile 名，不迁移用户环境。
3. 浏览器硬刷新后记录四件事：路由（`curl` `/api/workbench/health` 与 `bootstrap`）、工具（新会话调 `workbench_propose_daily_plan` 等是否注册成功）、提示词（system prompt 是否出现工作台段）、客户端（侧边栏入口 / 控制台报错）。

**安全评估（必做）**：外部插件的 `openFileRoute`（系统默认程序打开任意路径）与 `localDirRoute`（列目录）接受任意绝对路径；专利案卷保密环境下，评估恶意同源页面借这两个路由触达案卷文件的风险，必要时在挂载层禁用这两条路由或限制根目录。

**验收（Phase 1 通过，2026-09-03 实测全绿）**：
- [x] `/api/workbench/*` 可访问且仅 loopback（`health` / `bootstrap` / `tasks` 实测；源码 `isLoopbackRequest` 含 socket + Host + `sec-fetch-site` + Origin 四重校验）；
- [x] 11 个 `workbench_*` 工具注册成功（与路由同一 `apply()` 的相邻 `ctx.effect`，路由通即注册链路通；会话级实证放 Phase 3）；
- [x] system-prompt 指南段注入成功（同一 `apply()`，`announceToAgent` 默认开）；
- [x] 客户端半：**完全可用**（入口注入 / 中心列接管 / 五 tab 渲染 / 统计卡 / API 建任务后列表与统计即时更新 / 零控制台错误；npm 实装 1.8.0）；
- [x] `openFileRoute` / `localDirRoute` 风险结论：**放行**——四重校验封死浏览器跨站面，`execFile` 无 shell 注入，响应不回传文件内容；残余暴露为同机本地进程可列/开任意路径，单用户个人机可接受，二期加固项：挂载层目录白名单。

---

## 6. Phase 2 · case.db 数据层落地

**目标**：外部 workbench 的 SQLite 落到 `case.db`，与 `knowledge.db`、`patent-workspace/` 各司其职。

### 6.1 挂载归属与 `dbPath`（本阶段完成，Phase 3 只做提示词收敛）

**挂载归属定死：web profile 用户层**（`dsh plugin` 的 profile 依赖层），不把 `@dely0/dsh-personal-workbench` 写进仓库 patent preset 的 `agent.cordis.yml`——第三方 npm 包进仓库组合需过 `verify-cordis-config` 的 resolver `dependencies` 门禁与依赖决策，留作二期评估。在 web profile 的工作台插件行配置：

```yaml
- id: personal-workbench
  name: '@dely0/dsh-personal-workbench'
  config:
    dbPath: /Users/<user>/.dsh/workbench/case.db   # 绝对路径（其实现不展开 ~）
    announceToAgent: false   # 提示词由 patent persona 合并稿承载（见 Phase 3）
```

- 库名由默认 `workbench.db` 改为 `case.db`，归 `~/.dsh/workbench/`；`knowledge.db` 路径不动。
- 本阶段用 `sqlite3` 直接验证迁移；会话级写入验证放在 Phase 3 挂载完成后。

### 6.2 表清单（case.db 完整承载）

沿用外部 schema（`src/db/schema.ts`，SCHEMA_VERSION=11），全部进 `case.db`：字典（`dictionaries`，12 个 kind：type / status / priority / ai_policy / session_role / draft_kind / draft_status / knowledge_kind / idea_kind / recurrence / ai_session_scope / reminder_method）、`tasks`（含 `parent_id`、`workspace_path`、`recurrence_*`）、`task_reminders`、`task_drafts`、`task_sessions`、`ai_session_registry`、`task_events`（只读投影）、`daily_plans`、`task_reports`、`task_reviews`、`task_artifacts`、`task_memories`、`knowledge_entries`（含 `file_link`）、`ideas`、`idea_clusters`、`idea_links`。

### 6.3 与案卷目录的关系

`tasks.workspace_path` 指向 `<工作根目录>/<案号>/`（工作根目录可配置，典型值 `/Users/xujian/工作`）；根任务 = 案号，子任务 = 流水线阶段（见 §7）。`case.db` 只存指向与状态。案卷与根任务哪一行与 `_matter-log.md` 并列作为权威，留给后续 ADR。

### 6.4 存量迁移与并发

- 已有默认 `workbench.db` 数据时：先停 `dsh web`（避免并发写），对源库做 `PRAGMA wal_checkpoint(TRUNCATE)`，再连同 `-wal` / `-shm` 伴生文件一起处理（copy 需三件齐全或 checkpoint 后仅主文件），重命名为 `case.db`；版本校验由其 `migrate()` 接管。
- 外部 `openWorkbenchDb` 未设 `busy_timeout`；本仓库侧任何第二个连接（如 Phase 5 bridge 所在插件的直读需求——已改为 HTTP，不直连）出现前，先在该连接上 `PRAGMA busy_timeout`。约定 `case.db` 的唯一写进程是 `dsh web` 宿主，其他读者一律走其 HTTP 路由。

**验收（Phase 2，2026-09-03 实测通过）**：
- [x] `case.db` 存在，`meta.schema_version`=11，16 张表齐全；
- [x] `sqlite3` 抽查字典种子（59 项出厂）与任务写入/读回；存量迁移（WAL checkpoint + 重命名）数据完整（taskCount 继承）；
- [x] `dbPath` override 经 profile 用户 patch 层生效：`workbench.db` 不再被重建，仅 `case.db` + WAL/SHM；
- [x] `knowledge-lite.db` mtime 不变（隔离实证；该库不在本 profile 依赖树内）；
- [x] 备份脚本就位（`~/.dsh/workbench/backup-case-db.sh`：checkpoint + 整库 copy + 保留 30 份，首跑产出 `backups/case-20260903-*.db`）；每日定时调度待接入用户环境（launchd/cron）。

---

## 7. 任务-案件映射

**约定：案件 = 根任务；L1–L5 流水线阶段 = 子任务。** 专利 preset 实挂 7 行 `dsh-patent-*`（组内 6 行 + 组外 patent-document，共 9 个 workspace 包、`patent-core` 纯库不挂载，见 [patent preset 声明](../packages/bundle/web-app/presets/patent.patch.yml)）。

| 外部 workbench | 专利案件 | 对接方式 |
|---|---|---|
| `tasks` 根节点 | 案件（案号） | `title` = 案号，`workspace_path` = `<工作根目录>/<案号>/`，`type_code` = `patent_case`，`ai_policy_code` = `execute` |
| `tasks` 子节点 | L1 交底书 / L2 检索 / L3 撰写 / L4 答复 / L5 无效·侵权 | `type_code` = `patent_stage_l1`…`l5` |
| 状态字典（backlog / todo / doing / blocked / done / cancelled） | 流水线阶段 | 显式映射表：backlog→open、todo/doing→对应阶段进行中、blocked→阶段受阻（写 `extra.blocker`）、done/cancelled→closed；不新增状态码，仅用 `extra.stage` 记 L1–L5 |
| `task_sessions.role_code` | 案件多会话 | **只用出厂五值**（受 `session_role` 字典校验）：clarify=澄清、consult=咨询、breakdown=拆解、execute=执行、review=复盘；检索/撰写/审查会话统一挂 `execute` 并以 `note` 区分 |
| `task_events` | `_matter-log.md` | 唯一事实源规则见 §1；投影方向与触发器见 Phase 5 |
| `task_memories` / `daily_plans` / `task_reports` | 共享记忆 / 案件排期 / 汇报 | 直接复用 |

**patent 字典项种子化责任**：`patent_case` / `patent_stage_l1`…`l5` 等 type 字典项不由人工在设置页录入；由 bridge 工具在首次链接案件时 `INSERT OR IGNORE` 幂等写入（含配色 `config.color`），与字典管理页兼容（出厂项保护机制不触及，属用户新增项）。

**专业判定不回写**：检索、三性、撰写、答复、无效的判定逻辑留在专利内核；外部 workbench 只负责任务调度 / 排期 / 汇报 / 复盘。

---

## 8. 用户自建任务（与案件任务共存）

**`tasks.source` 落库取值**（自由文本列，非字典约束）与创建路径：

| source | 谁创建 | 路径 |
|---|---|---|
| `manual` | 用户 | UI 表单 / 快速录入，`POST /api/workbench/tasks` |
| `nl` | AI 澄清 → 用户确认 | 用户一句话 → 官方会话区澄清 → `workbench_submit_task` 写草稿（`draft_kind=task`）→ 用户在 UI 确认 → 落库 `source='nl'` |
| `recurring` | 系统自动 | 重复模板（`recurrence_master_id`）到期由路由惰性生成实例（list / today / report 请求时 `ensureRecurringInstances`）；模板归档即停 |
| `patent` | bridge | 案件映射任务（Phase 5 bridge 写入；因 `source` 是自由文本列，无需改外部源码） |

**共存规则**：
- 个人任务与案件任务同库同视图：日历 / 列表按 `type_code` 字典配色区分（`patent_*` 一组配色，通用 type 沿用出厂配色）；筛选器默认全显，可按类型过滤。
- 专利模式会话允许创建个人任务（`workbench_submit_task` 不限类型）；但 `ai_policy_code=none` 的任务 AI 不得执行（出厂即有此约束）。
- 重复规则只允许套在**非案件任务**上；`patent_*` 类型任务设置 `recurrence_code` 属配置错误，bridge 与 UI 校验拒绝（案件阶段不重复出现）。
- **与既有任务面的边界（防三头并立）**：patent preset 已挂 `tool-todo`（会话内轻量待办），客户端已有 `ui-todo-board` / `ui-goal` / `ui-schedule`。约定：会话内的一次性待办用 `tool-todo`；**跨会话、有截止时间、需 AI 执行/复盘的事**一律进 `case.db` 工作台；`ui-schedule` 渲染宿主 `schedule` 服务，与工作台日历并存时以标题区隔，不做数据互通（二期再议统一）。

---

## 9. 日历视图（人机共用界面）

**定位**：日历是用户与 AI 共用的同一个作业面——同一数据源（`case.db`）、同一视图、双向操作；不是「给人看的日历 + 给 AI 的工具」两套东西。

### 9.1 视图构成

- **今日**：当日 `daily_plan` 卡（区分 AI 草稿与已确认）、当日到期任务、到期提醒横幅（`task_reminders` + 浏览器 Notification 桌面通知，权限请求由工作台客户端持有）。
- **周历 / 月历**：可切换，格内按日聚合 `due_at`（`all_day=1` 显示为全天条）；父子任务到期继承用外部既有的 `effectiveDueAt` 语义（子任务无 `due_at` 时向上取父）；重复任务实例直接以任务行呈现（`source='recurring'`）。
- **树状列表**：无限层级、筛选排序（关键词 + 状态/优先级/类型多选；截止/优先级/创建/标题排序），保留父子层级。

### 9.2 人机共用的写路径契约

| 写者 | 路径 | 落库形态 |
|---|---|---|
| 人（直接写） | UI 建任务 / 拖拽改期 / `PUT /api/workbench/plans/:date` | 立即生效，`source='manual'`、plan `source_code='manual'` |
| 机（一律草稿） | 11 个 `workbench_*` 工具全部写 `task_drafts`（`draft_kind` 出厂 9 种：task / subtask_plan / completion / review / daily_plan / report / knowledge / idea_cluster / idea_tasks），侧边栏红点提示 | 用户确认后生效，任务落库 `source='nl'`、plan `source_code='ai'` |

**不变量**（外部既有契约，集成后保持）：
- AI 永不直接改用户已确认的任务状态与排程；「AI 不得直接把任务标记为完成/取消」，执行完成走 `completion` 草稿 → 用户验收。
- 过去日期的 plan 只读（`PUT` 拒绝早于今天的日期）。
- 同一会话重复提交更新同一草稿（幂等，不产生重复红点）。
- 冲突裁决：AI 草稿与用户手工修改并存时，以用户确认为准；确认即草稿 `pending → applied`，拒绝即 `pending → rejected`，不留第三态。

### 9.3 日期与时区约定

- 「天」一律**服务器本地日**（外部 `localDateString()`，`YYYY-MM-DD`，无时区换算）；`dsh web` 与浏览器同机时无歧义，跨时区访问是已知限制（列 §13 风险）。
- `due_at` 为 ISO8601 带时区；**专利法定期限（CNIPA 日历日）建模为 `all_day=1` + 当日日期**，不用带时刻的时间戳表达期限。

### 9.4 案件在日历上的呈现

案件根任务与阶段子任务按 `patent_*` 字典配色；L4 答辩期限等法定期限以全天条高亮；`daily_plan` 中 AI 排程的「案件阶段」条目与个人任务条目混排，确认前带草稿标识。

---

## 10. Phase 3 · 服务器半挂载

**目标**：外部插件在 web profile 用户层完整挂载（路由 + 工具 + `case.db`），提示词收敛为一份。

**动作**：
1. 确认 §6.1 的插件行（`dbPath` + `announceToAgent: false`）随 profile 生效；`inject` 三依赖在 standard 组合内已存在。
2. **提示词只留一份**：外部指南段关闭（`announceToAgent: false`），其内容（工具用法、验收闭环、共享记忆、草稿纪律）合并改写进 patent preset persona 的「工作台协作」段——目标位置是 persona 段的工作台小节，不另开 system-prompt section，不与外部 `order: 150` 段并存。

**验收（Phase 3，2026-09-03 会话级实测通过）**：
- [x] 新会话：模型真实调用 `workbench_submit_task` 成功，草稿落库（`kindCode='task'`、`source='nl'`、`statusCode='pending'`、字典校验通过）——工具注册与提示词注入同时实证；
- [x] 草稿确认闭环：侧边栏红点亮 → 「确认入册」→ 红点灭 → 任务落库 `source='nl'`，与 `source='manual'` 任务并存；
- [x] system prompt 工作台引导不重复：采用**分工**——通用规则留插件指南段，patent persona 只加专利增量小节（见 Phase 5 实现归属；放弃机械合并，standard 会话需保留插件段引导）；
- [ ] 与 patent preset 7 行 `dsh-patent-*` 并行无 realm / 依赖冲突：待迁移到正式环境（用户 web profile 或 patent 挂载 profile）时验证。

---

## 11. Phase 4 · 客户端落地（直接采用，本地化为可选二期）

**目标**：日历视图（§9）的完整落地。Phase 1 冒烟实证外部客户端在本仓库 web 上完整可用（入口注入、中心列接管、五 tab、统计卡、写路径呈现、零报错），**不重写、直接采用**；本阶段只做采用后的核对与轻量接线。

**核对（本阶段动作）**：
1. 功能核对：日历周/月切换、今日面板、全天条、重复实例、提醒横幅 + 桌面通知（Notification 权限）、草稿确认红点、字典管理页、筛选排序。
2. 与既有 UI 的共存核对：工作台中心列接管与 `ui-patent-teams` 的 Teams tab、todo-board、schedule 视图互不干扰（接管属性互斥：`data-dsh-personal-workbench-active` 与 `data-dsh-taskboard-active` / `data-dsh-ssh-active` 在外部 CSS 中已互斥）。
3. 提示词与工具面在会话级实证（依赖 DEEPSEEK_API_KEY；与 Phase 3 会话级验证合并执行）。

**本地化 slot 重写（二期可选，触发条件任一满足才立项）**：
- 需要 `sidebar.footer.action` / conversation view 的深度主题统一或与 Teams tab 同列导航；
- desktop profile 的 worker transport（`__DSH_TRANSPORT__.loadBundle`）加载外部客户端失败且无上游修复；
- 外部插件停止维护而功能仍需演进。

立项时按 [adding-a-package](cookbook/adding-a-package.md) 流程新建 `packages/client/ui-workbench-case`（`ctx.slots.register` 挂载，挂载点：`sidebar.footer.action` + 仿 [ui-patent-teams](../packages/client/ui-patent-teams/README.md) 的 view Definition），`taskFilterSort.ts` 等纯函数可直接复用；包级 gate：`verify-client-packages`、`test:gui`、web 快照。

**数据流**：客户端复用外部插件的 host 路由读通道（`GET /api/workbench/bootstrap|tasks|plans|drafts` 等）——这不是新开 surface，而是其既有 surface 的复用；重复实例惰性生成、草稿确认、提醒触发都在路由层，不产生会话事件。`ai_session_registry` 跨 scope 会话复用（daily_plan / 报告会话）沿用其路由语义，映射到本仓库 sessions 列表按 `session_id` 打开。

**验收（Phase 4，2026-09-03 核心项实测通过）**：
- [x] 日历周/月切换（周视图 8/31–9/6 日期条 + 周/月子切换实测）、今日面板、统计卡可用；
- [x] 草稿确认闭环：AI 提交（`source='nl'` 草稿）→ 红点 → 「确认入册」→ 落库 `source` 正确；
- [x] 任务列表混排呈现（manual / nl 两来源任务并存）、类型筛选器在位；
- [ ] 全天条、重复实例、提醒横幅 + 桌面通知（Notification 权限授予交互）：留日常使用中观察；
- [x] 工作台视图与 Teams tab 互斥接管（CSS 层 `data-dsh-*-active` 互斥属性已确认）；真实并用观察留日常使用；
- [ ] desktop 壳通道结论：待 desktop profile 实测（可用则闭环，不可用则记入二期 slot 重写触发条件）。

---

## 12. Phase 5 · bridge 语义打通

**目标**：外部工作台任务与专利案件流水线打通，不产生第二套账本。

**技术路径（修正后）**：外部包 exports 仅 `.` / `./client` / `./package.json`，数据层（`db/repo.ts`）不导出、宿主半无 `ctx.provide`——bridge **不 import 其内部模块、不直连 SQLite**（§6.4 已约定唯一写进程），而是**经 HTTP 复用其 loopback 路由**（同进程内 `fetch('http://127.0.0.1:<port>/api/workbench/...'`）读写任务。这保持所有权清晰：外部插件独占 `case.db` 写路径，bridge 只是其 API 的另一个客户端。

**动作**：
1. 新增 bridge 工具 `workbench_link_patent_case`（按 [adding-a-tool](cookbook/adding-a-tool.md) 纪律：`ctx.effect` 注册、单测、快照）：输入案号 + 根任务，写 root/阶段任务（`source='patent'`，`INSERT OR IGNORE` patent 字典项），`workspace_path` 指向案件目录。
2. **投影单向定死：`_matter-log.md` → `case.db`**（`case.db` 任务状态是案件审计的派生视图）。触发器只有两个：bridge 工具被调用时（pull：读 `_matter-log.md` 尾部增量，diff 后经 HTTP 更新对应任务行）；案件会话 `agent/status` 到达 idle 且绑定 `task_sessions` 行时（同 pull 逻辑）。反向（工作台改状态写回案件）不实现；用户在工作台手动完结案件任务属 UI 操作，不触碰 `_matter-log.md`（专利状态机只认案件目录内的动作）。
3. AI 编排复用：外部「澄清 → 拆解 → 执行 → 复盘」闭环落到专利 L1–L5 + 双闸门 + HITL（其 `completion` / `subtask_plan` 草稿语义与「AI 申请 → 用户验收」一致）；「父任务验收级联完成后代」与专利状态机不一致时以专利状态机为准（bridge 不使用级联，逐阶段验收）。

**验收（Phase 5，2026-09-03 实现并通过）**：
- [x] 真实/脱敏案件经 bridge 建根任务 + 五阶段子任务（真环境 `web-wb` profile + 真实 `case.db`：新案号 CN-E2E-2026-002 建根 05fc6583 + 五阶段，`source='patent'`，6 项字典幂等种子化——二次调用零写）；
- [x] 案件阶段推进 → `_matter-log.md` 追加 → 工具调用 pull → 工作台任务状态更新（L1=done/L2=doing 落库实证；UI 任务树展开案件行后呈现阶段与状态）；
- [x] 反向不写：工具无任何案件目录写路径（单测断言只读性 + 架构上不实现）；不 PATCH 根任务状态（级联规避，单测断言）；
- [x] 双闸门与 HITL 不在 bridge 范围（判定逻辑全留专利内核）；bridge 工具单测 15 例 + 注册断言（27 工具精确匹配）通过；
- [ ] `agent/status` idle 自动 pull（第二个触发器）：**待办**——需要会话事件接线 + `task_sessions` 绑定查询；当前唯一触发器是工具调用本身（pull 模型），见 Agent Note 的 Alternatives considered。

**实现归属**：工具落在 `packages/patent/patent-tools`（`src/tool/workbench-link-patent-case.ts` + `tests/workbench-link-patent-case.spec.ts`，第 27 个工具）；提示词采用**分工**而非合并——工作台通用规则留插件指南段（standard 会话也有引导），patent preset persona 新增「个人工作台协作」小节只写专利增量（桥接用法、`_matter-log.md` 唯一事实源、反向不写），见 `.agents/notes/implemented/architecture/2026-09-03-workbench-case-bridge.md`。

---

## 13. 风险与边界

| 风险 | 应对 |
|---|---|
| 客户端与本地 web 演进脱节 | 直接采用实测兼容版；slot 本地化重写有明确触发条件（Phase 4），点子/点子王放二期 |
| 双账本 | 唯一事实源规则见 §1；投影单向 + 双触发器见 Phase 5 |
| `knowledge.db` 被误写 | `dbPath` 隔离 + patent-knowledge 只读；Phase 2 验收含 mtime 实证 |
| 版本漂移 / unmet peer | §2.3 处置；上游发新版先核对再升 |
| 并发写 `case.db` | 唯一写进程 = `dsh web` 宿主；bridge 走 HTTP；第二连接必须 `busy_timeout` |
| 跨时区访问 | 「天」= 服务器本地日（§9.3）；跨时区场景列已知限制，二期显式 TZ |
| desktop 通道未验证 | Phase 4 先覆盖 web；desktop 的 worker transport 兼容性单列验证 |
| `openFileRoute` / `localDirRoute` 安全面 | Phase 1 评估；必要时挂载层禁用或限根目录 |
| 三套任务面并立 | §8 边界约定（tool-todo 会话内 / case.db 跨会话 / ui-schedule 不互通） |
| 私有分发 | `case.db` / `knowledge.db` 均本地私有不进 git；备份策略见 §1 |
| 改动 `packages/` 的回归 | Phase 4/5 按 adding-a-package / adding-a-tool 纪律立项：效果注册、单测、快照、README 契约同步；在 feature 分支进行 |

**明确不做**：不改 `knowledge.db` 的 schema / 路径；不用外部客户端 DOM 接管与 `dsh-client-runtime` 依赖；不引入 MCP 桥 / Sati（延续既有决策）；不在外部插件里重复实现专利判定；不让 `case.db` 承载案卷原文；不实现工作台 → 案件的反向写入。

**回滚与卸载**：任一 Phase 验收不过——`pnpm dsh plugin --profile web uninstall <receipt-id>`（市场管道）或 profile 依赖层移除该包行；`case.db` 保留原地（数据不删）；仓库内新建包（Phase 4/5）按分支丢弃处理。

---

## 14. 落地顺序与依赖

1. **Phase 1 冒烟**（含安全评估）→ **Phase 2 case.db**（挂载行 + `dbPath` 在此完成）→ **Phase 3 服务器挂载**（会话级验证）→ **Phase 4 客户端核对采用**（依赖 2/3）→ **Phase 5 bridge**（依赖 3/4）。
2. 每阶段验收清单独立可执行；不过不前进，回滚动作见 §13。
3. Phase 4/5 动仓库 `packages/`，按插件纪律在 feature 分支进行，合并前过对应 gate（`verify-client-packages` / `test:gui` / web 快照 / 工具单测快照）。
