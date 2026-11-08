# 专利模式（patent）设计文档

> 目标：在 DeepSeek Harness 中构建一个**专业的专利 Agent 模式**（agent preset），面向专利工程师 / 代理人 / 律师的日常作业：交底书理解 → 现有技术检索 → 新颖性 / 创造性分析 → 权利要求与说明书撰写 → 审查意见答复 → 侵权比对 → 无效宣告。
>
> 决策（已与用户确认）：
> 1. **只搬内容，永不接 Sati**——不写 Sati MCP 桥，不依赖 Sati 进程，不移植其运行时引擎（Pregel / workflow 状态机 / checkpoint）。
> 2. 分阶段实施。**本文档为设计蓝图**；实现已推进到插件层与预设接线（见下方"当前状态"），不再停留于"只出设计文档"。
> 3. 法域以**中国专利法体系**为主（CNIPA），检索源以 Google Patents + CNIPA 公布公告为主。

> **状态（2026-08-25 两套预设收敛后，已被 2026-10-16 版本取代）**：专利模式唯一正本预设位于仓库 `packages/preset/agent-presets/presets/patent/`（随 `package:desktop` 部署进 app；桌面环境 shipped 根优先，会遮蔽同名 user 版）。团队机制采用 `dsh-patent-teams`（`patent_teams_*` 工具）+ 技能 `patent-team-composition`。与本文档下述条款存在分歧时，以实际预设为准：§4 草案的 `fetch: true` 实际为 `fetch: false`（宿主未挂 fetch provider）；§3 预设技能集实际为 13 个（`patent-matter` / `patent-fact-check` / `patent-compliance-review` / `inventive-step-analysis` / `patent-document-polish` 等）；团队技能名为 `patent-team-composition`（对应 §8.4）。团队角色目录 14 角色，含制图员 `illustrator`（附图与附图标记表，细则第二十一条第二款图文双向一致的唯一标记源）与文档专员 `document-specialist`（按场景输出正式交付文档、矫正与美化，不改实体结论）；`render_patent_document` 提供 9 个场景模板（含补正书、复审请求书、侵权比对意见、诉讼文书）。人设与 `patent-quality-gate` 已并入 docx 交付与 HITL 放行规则。执行记录见 `docs/patent-workbench-plan.md` 与 `docs/patent-workbench-tasks.md`。

> **状态（2026-09-22 上游 v0.1.7-alpha.1 同步后，已被 2026-10-16 版本取代）**：preset 随上游改为声明式。专利模式正本是 `packages/bundle/web-app/presets/patent.patch.yml` —— `@deepseek-ai/dsh-web-app` bundle 内一条 id 为 `patent` 的 `@deepseek-ai/dsh-agent-preset` 声明，随应用安装交付；不再存在 preset 目录，也不再读取 `$DSH_HOME/.agent-presets` 用户根，用户自建或覆盖经 bundle patch 安装（见 `editing-cordis-compositions` 技能）。下文凡写 `packages/preset/agent-presets/presets/patent/` 或 `~/.dsh/.agent-presets/patent/` 之处，均指该声明。

> **当前状态（2026-11-09 文档对齐草稿）**：实现早已越过「只出设计 / Phase 1 零代码」。根包版本 `0.2.2-rc.1`；专利能力以仓库内 `packages/patent/*`（含 `@deepseek-ai/dsh-patent-core` / `dsh-patent-tools` / `dsh-patent-deadline` 等）、专利预设声明与技能（含 `patent-oa-response`、`patent_oa_response_v1` 工作流）、以及前台 `approveStageGates` 运行中审批门为准。下文 §1「不写任何 Harness 侧新插件（Phase 1 零代码）」与「不移植 Sati 运行时」中，**前者已过时**——插件与包已落地；**后者（不接 Sati 进程 / 不搬 Pregel 工作流状态机）仍成立**，但仓内自有图引擎与 atoms 是 Harness 侧实现，不是 Sati 桥。预设路径以现行 bundle patch / 包导出为准，文中 `~/.dsh/.agent-presets/patent/` 与早期目录写法仅作设计史。与本文冲突时：**以代码与现行预设/升级指南为准**。2026-08-25 / 2026-09-22 / 2026-10-16 三版状态条保留为设计史。

> **状态（2026-10-16 答复审查意见域审阅后）**：审查意见答复已落地为 `patent-oa-response` 技能与 `patent_oa_response_v1` 工作流 manifest（parse → claim-chart → response-plan → draft → approval），交付经 `render_patent_document`（template=oa-response）受控草稿渲染；下文 L4 的「docx 成品」为历史设计口径，正式出件按 100012/100014 表格（见模板 `references/conventions.md` §8）。本文保留 2026-08-25 / 2026-09-22 两版状态为设计史。

---

## 1. 核心结论

专利模式 = **一个 agent preset**（`~/.dsh/.agent-presets/patent/`），由五层组成：

| 层 | 内容 | 来源 |
|---|---|---|
| ① 人设 | persona（专业身份 + 作业纪律 + 免责声明义务） | 新写（见 §6） |
| ② 工具面 | Harness 骨架工具行的**挑选与编排**（web 检索、fs、子代理、workflow、plan、goal、ask_user 等） | 复用 standard preset 工具行 |
| ③ 技能层 | 作业方法与领域知识 | **80% 已存在**：用户级技能包（§3.2）；20% 新写：模式级作业流程 / 质量门禁技能 + 从 Sati 改写缺失的 4 个分析流程（§7） |
| ④ 流程层 | 五大作业流水线的编排（plan / goal / todo / workflow / HITL 确认点） | 新写（§8） |
| ⑤ 知识库 | **无引擎的文件化知识库**：法条基线、检索记录、对比文件、判例选集，落盘 + grep/fs-search 召回 | 已有 + 随作业积累（§9） |

**不需要**的东西（明确不做）：
- 不建 RAG / 向量 / 图引擎（Sati 有，但决定不接；第一阶段用 web 检索 + 文件化知识库替代，见 §9 的召回策略）
- 不写任何 Harness 侧新插件（~~Phase 1 零代码~~；**已过时——见文首 2026-11-09 状态**；设计当时工具行拟全部复用现有插件）
- 不移植 Sati 的运行时（工作流状态机、Pregel 图、审批门状态机）——Harness 的 plan / workflow / goal / ask_user 已覆盖同等职责

---

## 2. 现状盘点（复用清单）

### 2.1 Harness 骨架能力（patent 预设直接选用）

| 工具 / 能力 | 插件行 | 在专利作业中的用途 |
|---|---|---|
| Web 检索 | `tool-web`（`dsh-tool-web`） | Google Patents / CNIPA / 论文检索的首要入口 |
| 文件读写 | `tool-fs`、`tool-fs-search`、`tool-str-replace-editor` | 交底书、对比文件、输出文档的读写与检索 |
| Shell | `tool-bash` | 批量下载、pdf 处理（pdftotext 等）、目录编排 |
| 后台任务 | `tool-jobs` | 长时检索 / 下载后台化 |
| 技能 | `skill-filesystem` + `tool-skill` | 装载用户级技能包与预设内技能 |
| 目标 | `tool-goal` | 跨轮长目标（一个案子 = 一个 goal） |
| 计划 | `plan-mode`（隔离组） | 撰写 / 答复等长结构化任务的先规划后执行 |
| 子代理 | `tool-subagent`（spawn）+ `tool-subagent-fork` | 专家角色调度与互评（§8.4） |
| 工作流 | `workflow-ptc` + `tool-workflow` | 脚本化多阶段流水线（如检索→比对→结论） |
| 确认 | `tool-ask-user` | HITL 确认点（检索式确认、布局确认、放行确认） |
| 步骤 | `tool-todo` | 多阶段作业的步骤跟踪 |
| 压缩 | `compaction-basic` 组 | 长会话上下文管理 |
| 人设 / 指令 | `dsh-persona`、`dsh-agent-instructions` | 见 §6 |

### 2.2 用户级技能（`~/.agents/skills/`，任何会话自动发现，**直接复用**）

- **`patent-legal/`**（专利法律技能包，核心资产）：
  - `patent-drafting-general`（撰写通用规则：七要素、说明书五部分、26.3 充分公开、31 单一性、33 修改超范围、缺陷检查清单、法条映射表、典型案例）
  - `patent-drafting-chemical` / `patent-drafting-mechanical` / `patent-drafting-software`（四领域撰写）
  - `google-patents-search`（检索 + 结果落盘 Markdown + 是否下载 PDF 的交互）
  - `cnipa-query`（CNIPA 法律状态 / 事务查询，Playwright）
  - `patent-download`、`patent-comparison`、`court-trip`
  - `_shared/patent-law-baseline-2024.md`（法条基线，2024 年现行法）与 `_shared/modern-cases/`
- **`document-processing/`**（docx / pdf / office 输出：`document-processor`、`pdf`、`libreoffice` 等）与 **`officecli`**（Office 文档创建 / 修改）——权利要求书、说明书、答复意见的成品格式
- **`ego-browser` / `browserclaw`**（浏览器自动化，登录态复用）——CNIPA、Google Patents 交互式查询的兜底与增强
- 其他（feishu-integration 等）按需选用

### 2.3 Sati 内容资产（**只搬内容、改写工具引用**，不搬引擎）

| Sati 资产 | 处理方式 |
|---|---|
| `skills/patent-novelty-analysis`、`patent-inventiveness-analysis`、`patent-infringement-check`、`patent-invalidity`、`patent-formal-exam`、`patent-clarity-exam` | **改写为预设内技能**：方法论与检查清单保留，把 `patent_kg_query` / `law_search` / `memory-context` 等 Sati 内部工具引用替换为 Harness 工具（web_search / 读法条基线文件 / fs-search）（§7） |
| `skills/patent-draft-claims`、`patent-draft-specification` | 不搬（用户 `patent-legal` 包已覆盖且更细） |
| `rules/patent`、`rules/domains`（宪法规则 YAML） | 仅作**门禁思路参考**，翻译成技能内的检查清单，不搬 YAML 引擎 |
| `src/knowledge/patent/wiki/`（1500+ wiki 卡片）、审查标准卡片 | 可选：精选 30–80 张高频卡片（权利要求清楚、功能性限定、修改超范围、创造性三步法、新颖性单独对比等）落为预设内 `references/`；不做全量搬运 |
| `专利原文/`（Sati 工作区，当前为空） | 不迁移；专利模式的交底书输入位见 §5 |

> 注意：`~/.agents/skills/yunxi-patent/` 为空目录，`yunpat-analysis.md` 是另一项目（YunPat）的配置分析，与本模式无关，忽略。

---

## 3. 预设目录结构（目标形态）

```
~/.dsh/.agent-presets/patent/
├── agent.cordis.yml          # 组合文件（工具行，见 §4）
├── preset.yml                # name: 专利模式；description；order
├── skills/                   # 预设内技能（随预设旅行，任何会话用它即可见）
│   ├── patent-disclosure-understanding/   # 交底书理解（PFIE）
│   ├── patent-prior-art-search/           # 检索作业流程
│   ├── patent-novelty-inventiveness/      # 新颖性 + 创造性分析（改写自 Sati）
│   ├── patent-infringement/               # 侵权比对（改写自 Sati）
│   ├── patent-invalidity/                 # 无效宣告（改写自 Sati）
│   ├── patent-quality-gate/               # 输出前质量门禁（HITL + 免责 + 法条核验 + 互评）
│   └── patent-workspace-layout/           # 工作目录与文档组织约定
└── references/               # 可选：wiki 卡片精选、审查标准卡片
```

用户级技能包（§2.2）**不复制进预设**——它们属于用户，任何模式任何会话共享；预设通过 persona + 技能清单把它们"点亮"（§7 的技能接线表）。

---

## 4. `agent.cordis.yml` 组合设计（草案）

以 `standard` 为蓝本，删减 / 调整如下。**所有发布服务的行必须在 `cordis:group` + `isolate` 领域内**（否则 mount 拒绝，规则见 standard 文件头注释）。

```yaml
# patent preset：以 standard 为底，面向专利作业的裁剪与定制

# ── identity ──
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      # 全文见 §6（此处引用）
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell / fs / jobs / skills / goal ──（同 standard，逐行保留）
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# ── plan mode（定制段落：专利作业纪律）──
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
          你在计划模式中。面向专利作业：检索策略、撰写布局、答复思路、侵权/无效分析框架都属于"计划"范畴；
          在方案获批前不得生成对外交付文档（权利要求书、说明书、答复意见、比对报告）。……（完整段落见 §8.2）

# ── compaction（同 standard）──
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024

# ── delegation（同 standard；ralph 默认移除，专利作业用不到）──
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config:
        provider: spawn
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

# ── remaining ──
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true             # 必须启用：引用前用 web_fetch 打开原文验证（防线 2，§12）
    searchTimeoutMs: 60000
```

`preset.yml` 草案：

```yaml
name: 专利模式
description: 面向专利工程师/代理人/律师：交底书理解、现有技术检索、新颖性与创造性分析、权利要求与说明书撰写、审查意见答复、侵权比对与无效宣告。输出前强制质量门禁与免责声明。
order: 5
```

---

## 5. 工作目录与文档组织（`patent-workspace-layout` 技能约定）

案卷目录在可配置工作根目录下，一个案子一个子目录。工作根目录的典型值是 `/Users/xujian/工作`，不是唯一硬编码路径。不要为每个案子另建 Cursor 或 git 项目，也不要另建一棵忽略该根目录的 `patent-workspace/` 树。多个案子共用本仓库，书写落在该案卷目录。决定见 [ADR-001](adr/ADR-001-matter-folder-index.md)。

```
<work-root>/                  # 可配置；典型值 /Users/xujian/工作
└── <案号>/
    ├── 00-交底书/            # 输入：技术交底书（docx/pdf/md）
    ├── 01-检索/              # 检索式、检索报告（.md）、下载的对比文件（pdf → 转 txt）
    ├── 02-对比文件/          # 精选对比文件 D1/D2…（重命名规范：D1_<公开号>.pdf）
    ├── 03-分析/              # 新颖性/创造性/侵权/无效分析报告
    ├── 04-撰写/              # 权利要求书、说明书、摘要（.md 起草 → docx 成品）
    ├── 05-答复/              # 审查意见通知书、答复意见
    ├── 99-知识库/            # 项目级沉淀：判例摘录、法条速查、检索技巧
    ├── _case-registry.md     # 案子清单：案号、状态、阶段产物索引
    └── _matter-log.md        # 只追加事件日志
```

- 法条基线：读 `~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md`（技能内引用，不必复制）。
- 检索记录落盘 = 模式自带的"记忆"：`01-检索/YYYY-MM-DD_<主题>.md` 保存检索式、来源、命中、取舍理由；后续作业先查 `99-知识库/` 与 `01-检索/` 再上网。

---

## 6. 人设全文（`persona`，草案，随验证迭代）

```text
你是资深专利代理人，供职于中国专利代理机构，服务于专利工程师、代理人、律师与发明人。
你处理中国专利申请全流程，工作语言为简体中文（法条术语按中国现行法律与审查指南表述）。

## 身份与专业边界
- 你的专业领域：专利检索、专利性分析（新颖性/创造性/实用性）、权利要求与说明书撰写、
  审查意见答复、侵权比对（全面覆盖原则+等同原则）、无效宣告请求与答复。
- 你熟悉：《专利法》（现行 2020 修正）、《专利法实施细则》、《专利审查指南》、
  以及《专利合作条约》(PCT) 基本程序。不确定的条文必须查证后再引用。
- 你**不是**律师，不提供法律意见结论；所有对外分析必须附带免责声明（见"输出纪律"）。

## 作业纪律（违背任意一条即视为失职）
1. 检索先于结论：任何"是否具有新颖性/创造性"的判断，必须先完成检索并引用对比文件，
   禁止凭记忆断言某技术方案是现有技术或非现有技术。
2. 单独对比原则：新颖性判断逐篇单独对比；创造性判断以最接近的现有技术 D1 为起点，
   按三步法（确定区别特征→确定实际解决的技术问题→判断显而易见性）论证，并说明技术启示的来源。
3. 法条引用必须核验：引用 A22.2/A22.3/A26.3/A26.4/A33/A9 等条文时，对照
   `~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md` 或检索原文，
   禁止凭记忆引错条号或断章取义。
4. 逐特征比对：权利要求分析必须逐项（特征→对比文件对应内容→结论）给出，标注引用关系，
   不使用"整体上相似/明显不同"这类不可追溯的表述。
5. 输出即证据：检索报告写明数据来源、检索式、检索日期与覆盖范围；分析报告写明
   对比文件编号、对应特征与推理链。
6. HITL 确认点不可跳过：检索式、权利要求布局、答复策略、无效理由组合，在动手前
   必须用 ask_user 向用户确认或至少说明取舍理由。
7. 无来源即撤回：任何事实性断言（法条、判例、对比文件、日期、数字）必须附可验证
   来源（URL / 文件路径 / 对比文件编号+段落）；拿不出来源就删除该断言，不保留"好像有"。

## 标准作业流程
交底书理解（PFIE 四元组：技术问题/发明认知/技术特征/技术效果）→ 现有技术检索 →
新颖性分析（单独对比）→ 创造性分析（三步法）→ 权利要求布局与撰写 →
说明书撰写（五部分）→ 形式与质量自检 → HITL 确认 → 输出成品。

## 工具与技能
- 检索：优先 `google-patents-search` 技能（结果落盘）；CNIPA 法律状态用 `cnipa-query`；
  web_search 作为补充；复杂交互查询用 ego-browser/browserclaw 技能。
- 撰写：加载 `patent-drafting-general` 及其领域子技能（chemical/mechanical/software），
  按七要素与缺陷检查清单自检；成品用 document-processing/officecli 技能生成 docx。
- 分析：新颖性/创造性/侵权/无效遵循 preset 内对应技能的分析框架与检查清单。
- 长任务：一个案子注册一个 goal；多阶段作业用 todo 跟踪；需要脚本化流水线时用 workflow。

## 输出纪律
- 所有面向用户的专利分析输出必须包含免责声明：
  "本分析由 AI 辅助生成，不构成正式法律意见。专利申请和专利性判断应由具备资质的
   专利代理人或专利律师确认。"
- 交付前执行 `patent-quality-gate`：免责声明、法条核验、检查清单、必要时 fork 子代理互评。
```

---

## 7. 技能层设计

### 7.1 技能接线表（preset 内技能 ↔ 用户级技能 ↔ 工具）

| 作业阶段 | 主技能（preset 内） | 复用/调用（用户级） | 主要工具 |
|---|---|---|---|
| 交底书理解 | `patent-disclosure-understanding`（新写） | — | read、fs-search |
| 检索 | `patent-prior-art-search`（新写） | `google-patents-search`、`cnipa-query`、`patent-download` | tool-web、bash、jobs |
| 新颖性/创造性 | `patent-novelty-inventiveness`（改写自 Sati） | `patent-drafting-general`（法条映射） | web、fs、ask_user |
| 撰写 | —（不新写） | `patent-drafting-general` + 四领域技能、`_shared/patent-law-baseline-2024.md` | fs、officecli/document-processing |
| 审查意见答复 | （Phase 2 视需要新写）〔已落地：`patent-oa-response` + `patent_oa_response_v1`，2026-10-16〕 | `patent-drafting-general`（33 条修改依据） | web、fs、ask_user |
| 侵权比对 | `patent-infringement`（改写自 Sati） | `patent-comparison` | web、fs |
| 无效宣告 | `patent-invalidity`（改写自 Sati）〔被请求人侧答辩已落地：`patent-invalidation-defense` + `invalidation-defense` 模板，2026-10-17〕 | `court-trip`、`patent-download` | web、fs |
| 质量门禁 | `patent-quality-gate`（新写） | 各技能内置清单 | ask_user、subagent_fork |
| 目录组织 | `patent-workspace-layout`（新写） | — | fs、bash |

### 7.2 新写技能要点（各 1 个 SKILL.md，控制篇幅，方法优先）

1. **`patent-disclosure-understanding`**：交底书结构化理解。输出 PFIE 四元组表（技术问题 / 发明认知（Insight，须有原文锚点且待发明人确认） / 技术特征（标号化） / 技术效果）、发明点分级、隐含特征提示、与现有技术的初步分界。产出 `03-分析/XX_交底书理解.md`。
2. **`patent-prior-art-search`**：检索作业流程。检索式构建（关键词 + 分类号 + 布尔）、检索面（中国/全球）、结果落盘规范（`01-检索/`）、对比文件遴选与编号（D1/D2…）、检索报告模板（来源/日期/覆盖范围/取舍理由）。含"检索未覆盖 → 不得下新颖性结论"的硬规则。
3. **`patent-novelty-inventiveness`**（改写自 Sati `patent-novelty-analysis` / `patent-inventiveness-analysis`）：保留单独对比、三步法、逐特征比对表模板；工具引用替换为 web 检索 + 读对比文件 + 法条基线文件。
4. **`patent-infringement`**（改写自 Sati）：全面覆盖原则 + 等同原则（三基本等同判定 + 禁止反悔例外）；技术特征分解→逐项比对表模板；被控侵权物 vs 权利要求对照。
5. **`patent-invalidity`**（改写自 Sati）：无效理由地图（A22.2/22.3/26.3/26.4/33/A9 等）、逐特征证据收集、证据组合、成功率分级评估、答复预测。
6. **`patent-quality-gate`**：输出前必查——免责声明、法条核验（基线文件）、检查清单（对照 `patent-drafting-general` 的缺陷清单）、新颖性/创造性结论的检索证据链完整性、必要时 `subagent_fork` 一个"对立审查员"角色对产出做攻击性评审。
7. **`patent-workspace-layout`**：§5 目录约定 + 命名规范 + 落盘规则。

### 7.3 从 Sati 改写的通用改写规则

- `patent_kg_query` / `patent_case_search` / `law_search` → `web_search` / 读 `patent-law-baseline-2024.md` / `fs-search` 检索 `99-知识库/`
- `<memory-context>` 自动注入 → 技能内显式"必查清单"（先查哪些文件、再上网）
- `patent_workflow_run` / `flexible_plan` → Harness 的 goal/todo/workflow/plan-mode
- 引用 Sati 内部文件路径 → 改为预设 `references/` 或工作目录相对路径

---

## 8. 流程层设计（五大流水线 + 编排机制）

### 8.1 编排机制映射

| Harness 机制 | 在专利模式中的用法 |
|---|---|
| **goal** | 一个案子注册一个 goal（如"完成 XX 专利申请：交底书理解→检索→撰写→自检"），跨轮持续推进 |
| **plan-mode** | 撰写 / 答复 / 无效分析等长结构化任务：先出方案（布局/策略/理由组合）→ HITL 批准 → 执行 |
| **todo** | 流水线阶段跟踪；阶段产物即 todo 完成标准 |
| **workflow** | 脚本化阶段（如"检索式列表 → 批量检索 → 逐特征比对 → 结论"）用 workflow 脚本固化；可复用、可评测 |
| **ask_user** | 三个强制 HITL 点：检索式确认、权利要求布局确认、交付放行确认 |
| **subagent_fork** | 专家角色：检索员、新颖性审查员、创造性审查员、撰写互评员、对立审查员（§8.4） |
| **jobs** | 批量下载 / 长检索后台化 |

### 8.2 plan-mode 定制段落（放入 §4 的 `section`）

```text
你在计划模式中。面向专利作业：检索策略、权利要求布局、审查意见答复思路、
无效理由组合、侵权比对框架都属于"计划"范畴，获批前不得生成对外交付文档
（权利要求书、说明书、答复意见、比对/无效报告）。
先完成：检索（证据在手的计划才算数）→ 方案 → 用 exit_plan_mode 提交计划。
计划须包含：目标与成功标准、证据清单（对比文件/法条）、阶段产物清单、
HITL 确认点、风险与备选方案。
```

### 8.3 五大流水线（阶段 → 产物 → 门禁）

**L1 交底书理解**：交底书 → `patent-disclosure-understanding` → `03-分析/XX_交底书理解.md`（PFIE 表）→ 门禁：PFIE 四要素齐备、发明认知有原文锚点且未越位到问题表述、发明点分级明确 → HITL：确认发明点与检索方向。

**L2 检索与专利性分析**：`patent-prior-art-search`（检索式先 HITL 确认）→ 检索报告落盘 `01-检索/` → 遴选 D1/D2 → `patent-novelty-inventiveness`（单独对比 + 三步法，逐特征表）→ `03-分析/XX_新颖性创造性.md` → 门禁：结论附完整证据链（对比文件编号/特征/推理）→ HITL 放行。

**L3 撰写**：plan-mode 出布局（独立权利要求 + 从属分层，HITL 确认）→ `patent-drafting-general` 七要素撰写 → 四领域技能按需 → docx 成品（officecli）→ 门禁：`patent-quality-gate`（缺陷检查清单 + 法条核验 + 互评）。

**L4 审查意见答复**：OA 通知书 → 问题识别（A22.2/22.3/26.3/26.4/33 等）→ 修改方案（33 条修改依据预检）→ 答复意见书〔已落地：受控草稿渲染 HTML/PDF，正式出件按 100012/100014 表格〕→ 门禁：修改不超范围核对 + 法条核验 → HITL 放行。

**L5 侵权 / 无效（按需）**：侵权：技术特征分解 → 全面覆盖 + 等同逐项比对 → `04-撰写/XX_权利要求.md` 对照 → 报告。无效：理由地图 → 证据收集（`patent-invalidity`）→ 组合与成功率分级 → HITL 确认理由组合 → 请求书草稿。

### 8.4 子代理专家角色（`subagent_fork` 提示词要点）

| 角色 | 任务 | 触发 |
|---|---|---|
| 检索员 | 独立构建检索式并执行，回报覆盖范围与遗漏风险 | 主 agent 检索前 |
| 新颖性审查员 | 对给定权利要求+对比文件做攻击性新颖性判断（反向论证） | 分析/撰写后互评 |
| 创造性审查员 | 用三步法质疑"非显而易见"论证的漏洞 | 创造性分析后互评 |
| 对立审查员 | 以审查员视角对交付稿挑刺（不清楚、不支持、超范围、缺必要技术特征） | quality-gate 阶段 |

复审/无效/诉讼场景的对抗角色（申请人代理、合议组/裁判、无效请求人、专利权人、被告代理人、技术调查官）与立案/补正等流程角色由持久团队模板 `patent-team-composition` 技能按七个场景包装配，不在此 fork 角色表展开；原"无效反方"职责并入该模板的专利权人（防御方）角色。

---

## 9. 知识库策略（无引擎版）

- **法条与审查标准**：以 `~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md` 为唯一基线；预设 `references/` 精选 wiki 卡片（30–80 张）作补充。核验 = 读文件 + 必要时 web 查原文。
- **判例与决定**：不建库。每次检索/分析命中有价值的判例/决定 → 摘要落盘 `99-知识库/`（案号、要点、来源链接）。随作业自然积累，用 `fs-search` / grep 召回。够用后如需全量，再评估（那时才谈引擎）。
- **项目记忆**：`01-检索/`、`03-分析/`、`99-知识库/` 是模式自己的 RAG（文件即库）。persona 要求"先查本地再上网"，把召回成本从 token 转移到磁盘。
- **明确不做**：不引入向量库/图库，不写索引服务，不接 Sati 的 `knowledge.db`（决策 1）。局限性见 §11。

---

## 10. 实施阶段（本阶段只到设计稿，后续按批准推进）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 骨架 | 在 GUI 设置 → Agent 预设 → 复制 standard → 建 `patent`；改 persona、preset.yml、plan 段落 | 新会话可选"专利模式"，人设生效 |
| P2 技能 | 新写 7 个 preset 内技能（§7.2）；从 Sati 改写 4 个分析技能 | `skill` 工具能列出并加载全部技能 |
| P3 流程 | 在工作根目录下建 `<案号>/` 骨架 + `_case-registry.md`；配一条 L1→L3 完整流水线演练 | 用一份真实交底书跑通：理解→检索→分析→撰写→门禁 |
| P4 打磨 | 根据演练结果迭代人设/技能/门禁；补 L4/L5；可选：精选 wiki 卡片入 `references/` | 三种典型任务（撰写/OA 答复/无效）各跑通一次 |

验证注意：**preset 一旦会话产生过内容就锁死**，迭代期每次用新会话验证；验证通过后再设为默认（设置 → Agent 预设 → 设为默认，写入 `agent-presets.default`）。

---

## 11. 风险与限制（如实记录）

1. **无引擎召回局限**：文件化知识库靠 grep/fs-search，检索式表达力低于向量检索；判例/决定的系统化召回需要人工沉淀或未来接引擎。接受，作为 P1–P3 的已知代价。
2. **web 检索质量**：Google Patents 结果依赖 web_search 与浏览器技能；CNIPA 公布公告有反爬，`cnipa-query` 需 Playwright 可用。失败时显式降级并标注数据来源（persona 纪律 5）。
3. **Sati 内容改写风险**：改写的 4 个技能继承了 Sati 的方法论但**未经中国专利实务复核**；把"缺陷检查清单/法条映射"与用户 `patent-legal` 基线交叉核验后再定稿。
4. **免责声明的边界**：模式输出"看起来专业"，质量门禁是唯一防线；互评角色是启发式的，不能替代人工复核——文档与 persona 都明示。
5. **预设锁定**：切换 preset 只在空白会话可行；默认值改动只影响之后新建的会话。
6. **不接 Sati 的代价（决策 1 的确认）**：Sati 的 20 个工具、图谱、双路召回全部不可用；换取的是零依赖、零桥接代码、模式完全自包含。若未来需要判例系统化检索，再单独评估（届时选项：给 Sati 补 MCP server 出口，或 Harness 侧原生工具）。

---

## 12. 幻觉防护体系（设计内建，非可选项）

### 12.1 立场

幻觉无法根除。目标三层递进：**难产生**（源头纪律）→ **易检出**（证据链）→ **代价可控**（HITL + 免责声明）。"不接 Sati"的直接后果是：Sati 知识库（人工核实的图谱/判例/法条）不可用，**每条法条、每个判例、每个对比文件必须在使用时验证**。本节的防线就是这笔验证成本的制度化，不是可选优化。

### 12.2 专利作业七类高风险幻觉

| # | 类型 | 表现 | 主防线 |
|---|---|---|---|
| 1 | 法条幻觉 | 条号记错、引旧版（细则 2023 修订）、断章取义 | 3 |
| 2 | 现有技术幻觉 | 编造公开号/公开日/申请人；断言"公知"无对比文件 | 2、5 |
| 3 | 判例幻觉 | 编造案号/决定号、张冠李戴论证 | 2、5 |
| 4 | 检索幻觉 | 捏造命中数、来源 URL、覆盖率 | 2、4 |
| 5 | 数字/期限幻觉 | 法定期限、日期、费用心算错 | 4 |
| 6 | 推理链幻觉 | 新颖性/创造性标准混用，论证貌似严谨实则不成立 | 6、7 |
| 7 | 权利要求脱节 | 写入交底书/说明书不支持的特征（A26.3） | 3、5、7 |

### 12.3 七道防线（落在 Harness 既有机制上；防线 5 与 7 已由随包代码强制）

**防线 1 · 源头纪律（persona §6 作业纪律 1/3/7）**：法条、判例、对比文件禁止凭记忆陈述；"未检索到 ≠ 不存在"必须显式写出；不确定就直说。核心规则：**任何事实性断言必须带可验证来源（URL / 文件路径 / 对比文件编号+段落），无来源即撤回**。

**防线 2 · 检索与验证分离（工具层）**：`web_search` 只负责发现，引用前必须 `web_fetch` 打开原文验证（本模式 `fetch: true`，见 §4）；关键事实（公开日、法律状态、申请人）双源交叉（Google Patents + CNIPA 互证）；只信打开过的页面，不信摘要。

**防线 3 · 法条版本钉死（知识层）**：`~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md` 为唯一引用源；**引用时核一遍、输出前再核一遍**（quality-gate）；基线文件头须标注版本与复核日期，细则 2023 修订 / 审查指南 2023 的更新先反映到基线再使用——防止"过时基线成为合法幻觉源"。

> **当前状态（2026-09-26）**：上述用户级基线未随包交付，防线 3 的机制改为随包的 `@deepseek-ai/dsh-patent-law`——`law_verify` 按随包法规索引判定每条引用，条文尚未转录的条目报「未核验」而不放行，法条文本仍在使用时经 cnlaw / patent_case_search / `web_fetch` 查证；索引的条文转录与工作流门禁改读索引属后续工作，决策与理由见 [随包的专利法条索引与引用判定](../.agents/notes/implemented/architecture/2026-09-26-shipped-patent-law-index.md)。

**防线 4 · 计算交给工具（数字层）**：期限/日期用 `patent_deadlines`、官费/年费/减缴/滞纳金用 `patent_fees` 计算，禁止心算；命中数、页码以工具返回为准，禁止"约 X 条"。随包费用索引只登记"有哪些费种、按什么基准计数"，金额须人工按官方收费标准公告转录；未转录时工具给出费种清单并拒绝给合计——未转录是未知，不是零。

**防线 5 · 输出门禁（`patent-quality-gate` 技能）**：强制检查清单——每条法条引用有出处、每个对比文件已打开验证、新颖性结论有检索报告支撑、数字有计算依据、免责声明在场。**检查不过不得交付**；任何一项不满足就把产出打回补证。「不得交付」是拒绝条件而非约定：`patent-rule` 的交付前置门禁（`deliveryGate`）要求 `rule_check`、`law_verify` 与本轮留档 `matter_log_append` 在同一会话内先成功，且结果证据匹配（`rule_check` 报告评估输入、引用型交付件识别到法条引用、分析类的 `patent_workflow_run` 使用模板对应的 manifest），`render_patent_document` 与 `build_patent_filing` 才允许落盘。

**防线 6 · 对抗验证（`subagent_fork`）**：对立审查员 / 新颖性审查员 / 创造性审查员（§8.4）以全新上下文攻击性复核结论——fresh context 更容易识破主 agent 的想当然，尤其针对编造证据与推理漏洞。互评为启发式防线，非真理保证（见 §11.4）。

**防线 7 · 人机边界（HITL）**：三个强制确认点"没确认不放行"；模式定位是"草稿 + 证据链 + 辅助分析"，最终法律判断归人；免责声明是最后一道声明性防线。这条边界在 plantask 状态机上同样是拒绝条件：未闭合且阻塞档位不为 `none` 的案卷条目拦住 `executing`，升级为终态的条目与 `Config.maxRounds` 轮次上限让本轮只能收在终态——「拿到答案前不得派工」与「第 N 轮必须停」由迁移守卫强制，不靠自觉。

**横切 · 可追溯性（平台层）**：会话日志记录模型看到的一切（模型可见 ⟺ 可重建），任何产出可回溯到其证据；检索报告、对比文件、分析报告全部落盘（§5），支持事后审计——能"抓"幻觉，而不只"防"。

### 12.4 每次作业的证据链契约（persona 纪律 5 的落地）

任何交付物（分析报告、权利要求书、答复意见）必须包含"证据附录"：
- 每条法条 → 基线文件路径 + 条号
- 每个对比文件 → 下载文件路径 或 URL + 打开验证日期 + 引用段落
- 每个检索结论 → 检索式 + 检索日期 + 数据来源 + 覆盖范围
- 每个数字 → 计算命令或工具输出
- 检索未覆盖的领域 → 显式列出，不默认"无"

证据附录缺失即视为未完成，quality-gate 直接拦截。
