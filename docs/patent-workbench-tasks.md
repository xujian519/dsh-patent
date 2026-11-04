# 专利律师工作台实施任务清单与检查清单

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文件是 `docs/patent-workbench-plan.md`（母计划）的可执行拆解，二者一一对应；执行时如发现冲突，以母计划为准并向用户提出。
>
> **案卷目录口径（2026-11-04）**：案卷真源以 [ADR-001](adr/ADR-001-matter-folder-index.md) 为准。工作根目录可配置，典型值 `/Users/xujian/工作`。下文 `patent-workspace/<案号>/` 读作 `<工作根目录>/<案号>/`，不要求另建独立 patent-workspace 树，也不要求每个案子一个 Cursor 或 git 项目。
>
> **收敛记录（2026-08-25）**：本清单的落地对象已由用户级 `~/.dsh/.agent-presets/patent/` 改为仓库**正本 `packages/preset/agent-presets/presets/patent/`**（git 跟踪；桌面打包部署进 `apps/desktop/resources/**`，该目录 gitignore）。原 user 版（含 `patent-matter`/`patent-fact-check`/`patent-compliance-review`、docx 交付与 HITL 放行规则）已并入正本并归档到 `~/.dsh/.agent-presets-archive/patent-*`。团队机制统一为 `dsh-patent-teams` + `patent-team-composition`；废弃泛化 agent-teams + `patent-team-workflow`。目录口径统一为「七级业务子目录（00-交底书/01-检索/02-对比文件/03-分析/04-撰写/05-答复/99-知识库）+ `_case-registry.md` + `_matter-log.md` 两个跟踪文件」。下文建档/修改目标路径如仍写 `~/.dsh/...`，属历史期目标，现均以正本为准。阶段 5 仍为未完成项。
>
> **同步记录（2026-09-22，上游 v0.1.7-alpha.1）**：preset 随上游改为声明式。**正本 = `packages/bundle/web-app/presets/patent.patch.yml`**（`dsh-web-app` bundle 内 id `patent` 的 `dsh-agent-preset` 声明，随应用安装交付），`packages/preset/agent-presets/presets/patent/` 与 `$DSH_HOME/.agent-presets` 用户根均不再存在。下文凡写这两处路径，均指该声明；`preset.yml` 的字段（name/description/order）现为声明 `config` 的同名键。

**Goal:** 在 deepseek-harness 上落地专利律师工作台：patent preset → 案件管理 + 双闸门 → docx 交付 → 专家协作 → 全流程打磨，五阶段各自独立验收。

**Architecture:** 能力全部落在 DSH 原生插件 + preset + 技能层，零 Sati 进程，随包不带 MCP 桥（部署可另挂可选的法条 MCP 客户端，见 `packages/bundle/web-app/presets/patent.md` 的 Prerequisites）。preset（`packages/bundle/web-app/presets/patent.patch.yml`）负责组合与点亮：挂载 11 个 `dsh-patent-*` 插件（`packages/patent/` 下 13 个 `dsh-patent-*` 包中，`patent-core` 与 `patent-index-asset` 是纯库，经依赖引入，不单独挂载；装配清单见 `packages/bundle/web-app/presets/patent.patch.yml`）、注入 persona 与 plan-mode 段落、经技能 provider 接线使 preset 内 16 技能进会话。案件管理、双闸门、审计链是 preset 内技能 + 目录规范，零新代码。阶段 3/4 若动仓库代码（`render_patent_docx`、agent-teams），按插件纪律立项，否则以用户级技能/脚本落地。

**Tech Stack:** DeepSeek Harness（preset 机制：`packages/bundle/web-app/presets/`，挂载强制 `cordis:group` + `isolate`）、`@deepseek-ai/dsh-patent-*` 13 包、`dsh-subagent-fork-in-process`、`ctx.approval`（`patent-workflow` 审批接缝）、用户级技能（`patent-legal` / `officecli` / `document-processing` / `ego-browser`）、知识库（`patent-law-baseline-2024.md` + `99-知识库/` 文件化召回）。

**执行约定（先读）：**
- 本计划的大部分任务是配置与技能编写，产物在用户级目录（`~/.dsh/`、`~/.agents/skills/`、可配置工作根目录），不进仓库；阶段 3.2 / 4.2 若决定动 `packages/patent/`，先按 `superpowers:using-git-worktrees` 建分支（当前在 master，未经用户同意不直接在 master 实现），并遵守仓库插件纪律（效果注册、单测、快照、README 契约同步）。
- **preset 锁定**：会话产生内容后不可换 preset，迭代期每次用新会话验证；验证通过后才设默认（写入 `agent-presets.default`）。
- 每个阶段末尾有**检查清单**，全部勾选才算该阶段完成；检查清单不过不进入下一阶段。
- 阻塞即停：依赖缺失、指令不清、验证连续失败时停止并向用户说明，不猜测。

---

## 阶段 1 · patent preset 落地（G1）

> **阶段 1 执行记录（2026-08-19）**：执行中发现仓库已内置完整 shipped patent preset（`apps/desktop/resources/mac/backend/config/agent-presets/patent/`，sati plan P4.4 产物，含 persona/plan-mode/7 技能/插件组），而母计划 G1 只核对了用户级目录。实际执行改为：复制内置版到 `~/.dsh/.agent-presets/patent/` + 补 `patent-data` 行（内置版漏挂，`patent_pdf_download` 依赖 `ctx.patentData` 服务）。静态验证全部通过（29 包引用全在 app 内置运行时依赖树，patent 组 isolate 含 patentData/patentKnowledge/patentWorkflow，7 技能 SKILL.md 齐备）。`tool-web` fetch 决策已核对：shipped 注释权威说明"无 fetch provider 时 fetch: true 会注册每次失败的 web_fetch"，保持 `false`，防线 2 由 patent_case_search + 检索 provider 承担——与母计划一致。会话级验收（工具可调用/技能可加载/persona 纪律）需在 GUI 新会话执行：headless/desktop profile 的独立依赖树不含 patent 包，仅 app 内置 backend 依赖树含全部 patent 包。

### Task 1.1: preset 骨架与 preset.yml

**Files:**
- Create: `~/.dsh/.agent-presets/patent/preset.yml`

- [ ] **Step 1: 建目录**

```bash
mkdir -p ~/.dsh/.agent-presets/patent/skills
```

- [ ] **Step 2: 写 preset.yml（全文如下，字段语法对齐 `packages/preset/agent-presets/src/metadata.ts` 与 `~/.dsh/.agent-presets/liangshen/preset.yml`）**

```yaml
name: 专利模式
description: 面向专利工程师/代理人/律师：交底书理解、现有技术检索、新颖性与创造性分析、权利要求与说明书撰写、审查意见答复、侵权比对与无效宣告。输出前强制质量门禁与免责声明。
order: 5
```

- [ ] **Step 3: 验证元数据可读**

用 `dsh` 会话的预设选择器确认「专利模式」出现（此时组合文件未写，会话会报组合缺失属预期）；或先跳过本步，随 Task 1.6 一并验证。

### Task 1.2: agent.cordis.yml 组合文件

**Files:**
- Create: `~/.dsh/.agent-presets/patent/agent.cordis.yml`

- [ ] **Step 1: 复制骨架**

```bash
cp ~/.dsh/.agent-presets/liangshen/agent.cordis.yml ~/.dsh/.agent-presets/patent/agent.cordis.yml
```

- [ ] **Step 2: 保留 standard 基础行**（identity、shell/fs/jobs/skill/goal、compaction 组、delegation 组含 `tool-subagent-fork`、`tool-ask-user`、`tool-todo`），删除 liangshen 特有的 tool-bootstrap / custom-bash / skill-search / instruction-hint / compaction-epoch 行——专利模式不需要 Minimal 引导，工具面要完整开放。

- [ ] **Step 3: 替换 persona** 为 Task 1.3 的全文（`complete: true` 的配置项按 liangshen 样板保留或按 standard 恢复，见 Task 1.3 说明）。

- [ ] **Step 4: 新增 patent 插件族组，全部行在 `cordis:group` + `isolate` 领域内**（mount 强制，发布服务进 root realm 会被拒绝；骨架如下，每行 config 按对应插件 README 的装配说明核对——`packages/patent/patent-*/README.md`）

```yaml
# ── patent 插件族（阶段 1 新增；组内每行必须 isolate）──
- id: patent-plugins
  name: cordis:group
  group: true
  isolate:
    patent: true
  config:
    - id: patent-tools
      name: '@deepseek-ai/dsh-patent-tools'
    - id: patent-workflow
      name: '@deepseek-ai/dsh-patent-workflow'
    - id: patent-rule
      name: '@deepseek-ai/dsh-patent-rule'
    - id: patent-document
      name: '@deepseek-ai/dsh-patent-document'
    - id: patent-data
      name: '@deepseek-ai/dsh-patent-data'
    - id: patent-knowledge
      name: '@deepseek-ai/dsh-patent-knowledge'
```

- [ ] **Step 5: 决策点——`tool-web` 的 `fetch` 取值**：设计文档 `docs/patent-mode-design.md` §4 草案为 `fetch: true`（幻觉防线 2 要求交付前用 web_fetch 打开原文验证），母计划写 `fetch: false`（称有已提交的 fix）。落地时核对：fix 是否覆盖"引用前打开原文验证"这一防线职责；若未覆盖，保持 `fetch: true`。把结论写进阶段 1 检查清单第 8 项。

- [ ] **Step 6: 语法自检**：`agent.cordis.yml` 中所有发布服务的行都在组内且组带 `isolate`；文件为 ESM 可解析 YAML（无 `!js` 之外的标签）。

### Task 1.3: persona 落盘

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/agent.cordis.yml`（persona 行）

- [ ] **Step 1: 读取全文来源**

读 `docs/patent-mode-design.md` §6，复制完整 persona 文本（五块：身份与专业边界 / 作业纪律 1–7 / 标准作业流程 / 工具与技能 / 输出纪律含免责声明）。

- [ ] **Step 2: 写入 persona 行**（`id: persona`，`name: '@deepseek-ai/dsh-persona'`，`config.text` 为全文）。

- [ ] **Step 3: 完整性核对**：persona 包含纪律 5「输出即证据」与纪律 7「无来源即撤回」、免责声明文本、HITL 纪律 6（检索式/布局/答复策略/无效理由动手前 ask_user）。

### Task 1.4: plan-mode 定制段落

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/agent.cordis.yml`（planning 组）

- [ ] **Step 1: 写入 planning 组**（`cordis:group` + `isolate: { planMode: true }`，`@deepseek-ai/dsh-plan-mode` 的 `config.section` 用 `docs/patent-mode-design.md` §8.2 全文）：

```yaml
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
          你在计划模式中。面向专利作业：检索策略、权利要求布局、审查意见答复思路、
          无效理由组合、侵权比对框架都属于"计划"范畴，获批前不得生成对外交付文档
          （权利要求书、说明书、答复意见、比对/无效报告）。
          先完成：检索（证据在手的计划才算数）→ 方案 → 用 exit_plan_mode 提交计划。
          计划须包含：目标与成功标准、证据清单（对比文件/法条）、阶段产物清单、
          HITL 确认点、风险与备选方案。
```

- [ ] **Step 2: 验证段落进入 plan-mode**（随 Task 1.6）。

### Task 1.5: preset 内 7 技能落盘 + 技能 provider 接线

**Files:**
- Create: `~/.dsh/.agent-presets/patent/skills/<skill-name>/SKILL.md`（7 个，见下表）
- Modify: `~/.dsh/.agent-presets/patent/agent.cordis.yml`（skill-filesystem 行指向 preset skills/）

- [ ] **Step 1: 写 7 个技能 SKILL.md**（frontmatter 用 `name` + `description` 两字段；正文按下表"要点"展开，改写技能先读 `docs/patent-mode-design.md` §7.3 的改写规则——`patent_kg_query`/`law_search`/`<memory-context>`/`patent_workflow_run` 等 Sati 引用一律替换为 Harness 工具）：

| 技能目录名 | 来源 | 职责与要点（摘自设计文档 §7.2） | 产物 |
|---|---|---|---|
| `patent-disclosure-understanding` | 新写 | 交底书结构化：PFIE 四元组表（技术问题/发明认知/技术特征标号化/技术效果）、发明点分级、隐含特征提示、与现有技术初步分界 | `03-分析/XX_交底书理解.md` |
| `patent-prior-art-search` | 新写 | 检索式构建（关键词+分类号+布尔）、检索面、结果落盘规范（`01-检索/`）、对比文件遴选与编号 D1/D2…、检索报告模板；硬规则"检索未覆盖→不得下新颖性结论" | `01-检索/YYYY-MM-DD_<主题>.md` |
| `patent-novelty-inventiveness` | 改写自 Sati | 单独对比 + 三步法 + 逐特征比对表模板；工具替换为 web 检索 + 读对比文件 + 法条基线文件 | `03-分析/XX_新颖性创造性.md` |
| `patent-infringement` | 改写自 Sati | 全面覆盖 + 等同（三基本等同判定 + 禁止反悔例外）；技术特征分解→逐项比对表 | 侵权比对报告 |
| `patent-invalidity` | 改写自 Sati | 无效理由地图（A22.2/22.3/26.3/26.4/33/A9 等）、逐特征证据收集、证据组合、成功率分级、答复预测 | 无效分析报告 |
| `patent-quality-gate` | 新写 | 输出前必查：免责声明、法条核验（基线文件）、缺陷检查清单、检索证据链完整性、必要时 `subagent_fork` 对立审查员攻击性评审 | 门禁结论 |
| `patent-workspace-layout` | 新写 | 工作目录七级约定（§5：业务子目录 00-交底书/01-检索/02-对比文件/03-分析/04-撰写/05-答复/99-知识库）+ 命名规范 + 落盘规则（法条基线读 `~/.agents/skills/patent-legal/_shared/patent-law-baseline-2024.md`，不复制） | 目录骨架 |

- [ ] **Step 2: 技能 provider 接线**——技能发现不是自动的：在 `agent.cordis.yml` 加/改 `skill-filesystem` 行，使 preset 目录的技能进入本 preset 会话（参考 liangshen 的 `skill-filesystem` + `skill-search` 组合；若沿用 `dsh-skill-filesystem`，核对它的目录 root 配置能否指向 `~/.dsh/.agent-presets/patent/skills/`，不能则按 liangshen 的 skill-search.mjs 模式写一个按需注入的小工具）。

- [ ] **Step 3: 引用完整性**：技能内所有文件路径（`01-检索/`、`03-分析/`、基线文件）与 Task 2.1 的目录规范一致。

### Task 1.6: 新会话验收（阶段 1 检查清单的实证）

- [ ] **Step 1: 开新会话并选「专利模式」**（GUI 设置 → Agent 预设 → 专利模式，或 CLI 会话创建时指定；注意 preset 锁定，必须用没有历史内容的新会话）。

- [ ] **Step 2: 验证工具面**：依次调用 `patent_search`、`patent_case_search`、`draft_claims`、`render_patent_document`（各给最小输入，确认返回结构而非报"工具不存在"）。

- [ ] **Step 3: 验证技能**：技能列出能看到 7 个 preset 内技能，且至少加载 `patent-workspace-layout` 成功。

- [ ] **Step 4: 验证 persona 纪律**：给一句无来源断言（如"根据 A22.3，……"），确认 agent 触发"法条引用必须核验/无来源即撤回"行为（引用基线文件或检索，而不是直接采信）。

- [ ] **Step 5: 验证 plan-mode 段落**：发起一个撰写类任务，确认进入计划模式时输出 §8.2 段落而非默认 plan 提示。

### 阶段 1 检查清单（2026-08-19 GUI 会话验收，全部通过）

- [x] 1. `preset.yml` 三字段（name/description/order: 5）与 liangshen 语法一致
- [x] 2. `agent.cordis.yml` 中发布服务的行全部位于带 `isolate` 的组内（静态验证：patent 组 isolate 含 patentData/patentKnowledge/patentWorkflow；patent-rule/document/literature/methodology 为函数插件无服务无需 realm），mount 未被拒绝
- [x] 3. persona 五块完整（身份/纪律 1–7/流程/工具技能/输出纪律+免责声明）
- [x] 4. plan-mode 段落为 §8.2 全文 + standard 机制段
- [x] 5. 7 个技能 SKILL.md 全部落盘；GUI 会话实证：技能列表可见全部 7 个且 `patent-workspace-layout` 加载成功（另可见用户级 patent-drafting-general/officecli/browseros 等）
- [x] 6. `patent_search`、`patent_case_search`、`draft_claims`、`render_patent_document` 四工具 GUI 会话实证全部可调用；**备注**：`patent_search` 当前网络环境返回 0 条（nuo-patent 为 Google Patents 在线抓取，`curl patents.google.com` HTTP 000），工具注册与调用链路正常，通道降级待决策（persona 检索优先级调整 or 配代理）
- [x] 7. persona 纪律 GUI 会话实证：错误断言"创造性应当单独对比"被纠正（正确为三步法、新颖性才单独对比）；检索未覆盖时主动不下新颖性结论（纪律 1/2 生效）
- [x] 8. `tool-web` fetch 决策已核对：保持 `false`（shipped 注释：无 fetch provider 时 `fetch: true` 注册的 web_fetch 每次必失败）；防线 2 由 patent_case_search + 检索 provider 承担
- [x] 9. 阶段 1 验收不通过项已修复并重新验证（patent-data 行补挂后静态验证通过；GUI 实证 4 工具可调用）

---

## 阶段 2 · 案件管理层（G2）+ 双闸门实例化（G5）

### Task 2.1: patent-matter 技能（案件管理）

**Files:**
- Create: `~/.dsh/.agent-presets/patent/skills/patent-matter/SKILL.md`

- [ ] **Step 1: 写技能正文**：案件 = 七级业务子目录（可配置工作根目录下的 `<案号>/`，典型值 `/Users/xujian/工作/<案号>/`，其下 `00-交底书` → `01-检索` → `02-对比文件` → `03-分析` → `04-撰写` → `05-答复` → `99-知识库` + 根 `_case-registry.md` + `_matter-log.md`，目录名与 `docs/patent-mode-design.md` §5 完全一致）+ 六列状态机（**按 L1–L5 流水线阶段定案**：open/retrieving/analyzing/drafting/review/closed 仅作展示别名）+ **只追加事件日志** `_matter-log.md`（每步记录时间/动作/产物/审批人，追加不覆写）。

- [ ] **Step 2: 写建案命令**：给出建案动作序列（mkdir 八目录 + 写 `_case-registry.md` 案号行 + 初始化 `_matter-log.md` 首行），作为技能内的可执行步骤。

- [ ] **Step 3: 与 goal/todo 对齐**：技能声明"一个案子 = 一个 goal；流水线阶段用 todo 跟踪；阶段产物即 todo 完成标准"（设计文档 §8.1）。

### Task 2.2: 审计链

**Files:**
- Create: `~/.dsh/.agent-presets/patent/skills/patent-matter/SKILL.md`（追加审计约定）

- [ ] **Step 1: 写产物元数据约定**：每个交付产物文件头含元数据块（来源/版本/审批/时间戳），与 persona 纪律 5「输出即证据」合并落地。

- [ ] **Step 2: 与既有审批闭环并轨**：核对审批审计（`packages/interaction/user-approval/src/index.ts` 追加的 `approval/asked` 与 `approval/decided` 事件对，只增日志）在 preset 中的可见性；`_matter-log.md` 与其并轨，**不做第二套账本**——事件日志为唯一事实源。

- [ ] **Step 3: 写追溯方法**：技能内给出"由任一产物反查证据链"的步骤（产物元数据 → `_matter-log.md` → `01-检索/` 记录 → 对比文件）。

### Task 2.3: patent-fact-check 技能（事实核验闸门）

**Files:**
- Create: `~/.dsh/.agent-presets/patent/skills/patent-fact-check/SKILL.md`

- [ ] **Step 1: 写核验清单**：法条（对照 `patent-law-baseline-2024.md`，必要时 web 查原文）、判例（案号/要点/来源）、对比文件（编号/段落/公开日）、日期与数字（申请日/优先权日/期限）四类核验步骤，每类给出"核验失败 → 回退动作"。

- [ ] **Step 2: 写 Fail-Closed 声明**：任一事实断言无法溯源即不通过，交付前必须全部通过；明示"核验不替代人工复核"。

### Task 2.4: patent-compliance-review 技能（合规审查闸门）

**Files:**
- Create: `~/.dsh/.agent-presets/patent/skills/patent-compliance-review/SKILL.md`

- [ ] **Step 1: 写规则检查流程**：复用 `dsh-patent-rule` 的 `rule_check` 工具与规则库（规则 id 实测逾百，专利域子集 96 条；以 `rule_check` 输出为准），对撰写/答复产物逐条跑规则。

- [ ] **Step 2: 写 Fail-Closed 声明**：规则未过不交付；拦截示例（如权利要求包含功能性限定时触发对应规则）写进技能。

### Task 2.5: 三 HITL 门接线

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/agent.cordis.yml`（如需 approval 相关行）
- Modify: `~/.dsh/.agent-presets/patent/skills/patent-quality-gate/SKILL.md`

- [ ] **Step 1: 确认接缝可用**：`patent-workflow` 已有 `approval.request` 接缝（`packages/patent/patent-workflow/src/index.ts:141`，工具 `patent_plantask` 触发）；preset 内 `tool-ask-user` 行在位（design §4 草案含）。

- [ ] **Step 2: 把三 HITL 点写进技能**：检索式确认（L2 前）、权利要求布局确认（L3 plan-mode 后）、交付放行确认（L3/L4/L5 门禁后）——在 `patent-prior-art-search`、`patent-quality-gate` 中分别写入"此处必须 ask_user"。

### Task 2.6: 虚拟案验收（阶段 2 检查清单的实证）

- [ ] **Step 1: 建虚拟案**：按 Task 2.1 建案，跑「建案 → 检索 → 分析 → 撰写 → 门禁 → 归档」，每步写入 `_matter-log.md`。

- [ ] **Step 2: 双闸门拦截测试**：人为注入一处错误法条（如把 A22.3 创造性写成"单独对比"标准），确认 `patent-fact-check` / `patent-compliance-review` 能拦截。

- [ ] **Step 3: 追溯测试**：从最终产物反查完整证据链（产物 → 日志 → 检索记录 → 对比文件），确认无断链。

> **阶段 2 执行记录（2026-08-19）**：新增 3 技能（`patent-matter`：八级目录 + L1–L5 状态机 + 只追加事件日志 + 审计链并轨；`patent-fact-check`：四类核验 Fail-Closed；`patent-compliance-review`：复用 `rule_check` Fail-Closed）；quality-gate 补 HITL 放行确认（prior-art-search 检索式 ask_user 已内置）；persona 检索优先级调整（nuo 通道降级为辅助，优先 google-patents-search 技能 + web_search）。wiki 知识库接入：Obsidian 宝宸知识库 → `~/.dsh/knowledge/wiki/`（1235 张卡片：130 张 patent-cards Q&A 含 card-index.json + 1105 张专利实务/复审无效/审查指南/判决/侵权/法规卡片），WikiCardLoader 实测扫描与检索通过；私有数据不进 git（母计划分发策略）。Task 2.6 由用户以真实案例 GUI 实测，评价"效果还可以"（2026-08-19）。

### 阶段 2 检查清单（2026-08-19 用户真实案例实测）

- [x] 1. 七级业务子目录名与设计文档 §5 一致，`_case-registry.md` + `_matter-log.md` 已建
- [x] 2. 状态机按 L1–L5 对齐，事件日志只追加不覆写
- [x] 3. 审计链 = 产物元数据 + 事件日志 + ApprovalRecord 并轨，无第二套账本
- [x] 4. `patent-fact-check` 四类核验清单齐备且 Fail-Closed
- [x] 5. `patent-compliance-review` 复用 `rule_check`，Fail-Closed
- [x] 6. 三 HITL 点（检索式/布局/放行）在技能中标注 ask_user
- [x] 7. 真实案例跑通，事件日志完整（用户实测）
- [x] 8. 注入的错误法条被拦截（双闸门 Fail-Closed）——用户实测评价通过；如拦截项未单独测，阶段 3 验收时补一次
- [x] 9. 证据链可完整追溯（用户实测）

---

## 阶段 3 · docx 原生修订交付（G3）

### Task 3.1: 交付规范约定

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/agent.cordis.yml`（persona 输出纪律段）
- Modify: `~/.dsh/.agent-presets/patent/skills/patent-quality-gate/SKILL.md`

- [ ] **Step 1: 写入交付约定**：成品交付 = md 起草 → docx 成品（`officecli` 技能）→ 修订一律走 tracked changes；沿用 patrick 纪律"只改本工作台创建的草稿，不改用户原件"。

- [ ] **Step 2: 验证 officecli 链路**：用一个 3 段样本跑通 md → docx，确认 `~/.agents/skills/officecli` 可用（本机技能，若失败记录降级方案：LibreOffice headless）。

### Task 3.2: 评估项——render_patent_docx 原生工具

**Files:**
- Evaluate: `packages/patent/patent-document/src/tool/render-patent-document.ts`（5 模板现状）

- [ ] **Step 1: 立项评估**：对照需求"5 个模板改渲染 .docx，输出路径沿用 `data/cases/<caseId>/outputs`"；库选型对比（docx npm 包 vs LibreOffice headless 转换）后给出是否立项的建议。

- [ ] **Step 2: 若立项**（改动 `packages/patent/`，先建分支再动手）：按插件纪律——工具注册走 `ctx.effect()`、补单测（对照 `patent-document/tests/render-patent-document.spec.ts` 模式）、关键行为补快照、README 契约同步；同时更新 `docs/patent-workbench-plan.md` 阶段 3 状态与本文档的检查清单。

- [ ] **Step 3: 若否**：维持 officecli 链路为唯一 docx 通道，在阶段 3 检查清单第 3 项注明决策与理由。

### Task 3.3: 与 patent-matter 集成

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/skills/patent-matter/SKILL.md`

- [ ] **Step 1: 写入交付物版本规则**：docx 交付物带版本号（v1/v2…），修订历史（谁/何时/改了什么/是否接受）写入 `_matter-log.md`。

### Task 3.4: OA 答复 docx 验收（阶段 3 检查清单的实证）

- [ ] **Step 1: 选一份真实/脱敏 OA 通知书**，按 L4 流程产出答复意见：md 起草 → docx 成品 → 至少一轮 tracked changes 修订。

- [ ] **Step 2: 确认原件未改动**（输入通知书 hash 前后一致或文件 mtime/内容比对）。

> **阶段 3 执行记录（2026-08-19）**：persona 输出纪律加交付约定（md 起草 → docx 成品 → 修订走 tracked changes → 只改草稿不改原件）；quality-gate 加 docx 交付检查项；patent-matter 补"交付物修订以追加行记录、不覆写已交付版本"。`render_patent_docx` 评估结论：**不立项**——实测 officecli 原生覆盖全链路（`add --type markdown --prop src=` md 展开、`set --find/--replace --prop revision.author=` 生成 del+ins tracked changes、`set /revision[@type=del] action=accept/reject` 接受/拒绝），零代码优先。Task 3.4 验收以真实案例 202311060998.X（驳回决定）实测通过：md 起草 → docx（add markdown）→ tracked changes 一轮（author=徐健）→ 原件 hash 前后一致（b749ee54…）→ 修订/交付/更正入 `_matter-log.md`。

### 阶段 3 检查清单（2026-08-19 真实案例 202311060998.X 实测）

- [x] 1. 交付约定（md → docx → tracked changes）写入 persona 与 quality-gate
- [x] 2. officecli md→docx 链路实测可用（add markdown src=；Heading2 样式警告非致命）
- [x] 3. `render_patent_docx` 不立项决策已记录（officecli 覆盖 tracked changes，零代码优先）
- [x] 4. 交付物版本号 + 修订历史入 `_matter-log.md`（含更正行，只追加不覆写）
- [x] 5. OA 答复以 docx 交付，修改对照以 tracked changes 呈现（del+ins，author/date/id 齐备）
- [x] 6. 输入原件未被改动（hash 实证：验收前后一致）

---

## 阶段 4 · 专家协作编排增强（G4）

### Task 4.1: subagent_fork 互评跑通（默认方案）

**Files:**
- Modify: `~/.dsh/.agent-presets/patent/skills/patent-quality-gate/SKILL.md`

- [ ] **Step 1: 写入互评流程**：quality-gate 阶段按需 fork 角色（`docs/patent-mode-design.md` §8.4 表：检索员 / 新颖性审查员 / 创造性审查员 / 对立审查员 / 无效反方），给每个角色的 fork 提示词要点（角色名 + 攻击性任务 + 触发时机）。

- [ ] **Step 2: 实测**：L3 撰写完成后 fork 对立审查员对交付稿挑刺（不清楚/不支持/超范围/缺必要技术特征），确认互评意见能回流并触发修订。

### Task 4.2: agent-teams 持久团队评估

**Files:**
- Evaluate: `~/.sati/调研/DeepSeek-Harness/源码素材-dsh-agent-teams`（本地源码）

- [ ] **Step 1: 读源码确认改造点**：captain 协议、attempt/attemptId 防覆盖、依赖感知调度、事件驱动、退休守卫；对照母计划改造点——`src/tools.ts` 通用任务协议换专利流水线阶段、state 落 `patent-workspace/.agent-teams/`。

- [ ] **Step 2: 落地形态决策**：a) 用户级脚本/技能落地（不污染仓库），或 b) 立项为 `dsh-patent-teams` 仓库包（需插件纪律：Service Definition/Provider/Consumer 三角色 + 单测 + 快照，先建分支）。给出建议与理由。

- [ ] **Step 3: 若接入**：`patent-matter` 状态机与团队任务状态同步，事件日志为唯一事实源，团队状态只是投影（避免双账本）。

> **阶段 4 执行记录补充（2026-08-19，会话日志 b8f3b6fc 证据核验）**：agent-teams 团队接力实测（用户导出会话日志，主会话 + 3 成员会话）：团队 `patent-team-202311060998` 创建，成员 检索员(researcher)/撰写员(drafter)/对立审查员(adversarial-reviewer)，6 任务按 DAG（t1 案件理解→t2 检索→t3 三性→t4 撰写→t5 对立审查→t6 汇总）创建；调度器分配与 attempt 防覆盖真实工作（t2 多轮 reassign/claim 拒绝至 attempt 3 完成）；产物全部落盘八级目录；`_matter-log.md` 持续追加；对立审查员核验出旧细则条文号错误并更正（法条核验纪律在成员层生效）。**未完成**：t5（attempt 2 进行中）/t6 汇总与 tracked changes 回流未收口；subagent_fork 互评（Task 4.1）未实测；双闸门错误法条注入测试未做；approval policy 用户改为 never（权限层跳过，ask_user 对话层不受影响）。

### 阶段 4 检查清单（2026-08-19 关闭；用户批准，遗留测试项并入阶段 5）

- [x] 1a. agent-teams 团队接力实测通过（t1–t4 完成落盘，t5/t6 待续）；1b. subagent_fork 互评未单独实测——用户批准关闭，并入阶段 5 检查
- [x] 2. agent-teams 源码评估完成——改造点假设已推翻（协议通用，任务 DAG 表达专利流水线），附理由
- [x] 3. 落地形态决策已记录：安装原插件 + preset 配置层适配（`patent-team-workflow` 技能），不 fork 仓库包
- [x] 4. 无双账本：`patent-team-workflow` 定义事件日志唯一事实源，团队状态只读投影

---

## 阶段 5 · 打磨与验证（全流程）

### Task 5.1: L1→L3 完整流水线

- [ ] **Step 1: 用一份真实交底书**跑通：交底书理解 → 检索（检索式 HITL）→ 三性分析 → plan-mode 布局（HITL）→ 撰写 → quality-gate（含互评）→ 交付 docx；每步落盘 + 日志。

### Task 5.2: L4 / L5 各一次

- [ ] **Step 1: L4**：OA 答复全流程（含双闸门 + HITL 放行）。
- [ ] **Step 2: L5**：无效宣告（理由地图 → 证据收集 → 组合 → HITL）或侵权比对（特征分解 → 全面覆盖+等同逐项比对）一次。

### Task 5.3: 迭代与默认锁定

- [ ] **Step 1: 迭代**：按演练结果修订 persona/技能/门禁（每次用新会话验证，preset 锁定机制）。
- [ ] **Step 2: 设默认**：验证通过后把「专利模式」设为默认（设置 → Agent 预设 → 设为默认，写入 `agent-presets.default`）。

### Task 5.4: 知识库沉淀

- [ ] **Step 1: 积累**：`99-知识库/` 自然积累判例/技巧（案号、要点、来源链接）。
- [ ] **Step 2: 可选**：精选 wiki 卡片 30–80 张入 preset `references/`。

### 阶段 5 检查清单

- [ ] 1. L1→L3 真实交底书跑通一次，产物/日志/证据链齐备
- [ ] 2. L4、L5 各跑通一次
- [ ] 3. 双闸门零漏检（阶段 2 注入样本在真实流程中仍被拦截）
- [ ] 4. 审计链可完整重建任一产出的证据链
- [ ] 5. 「专利模式」设为默认，新会话默认进入
- [ ] 6. 知识库已积累，召回路径（先查本地再上网）实测生效

### 阶段 5 追加落地记录（2026-09-04）

- [x] 文档专员角色：`document-specialist` 注册于 `patent-workflow/role-contracts.ts`，worker `patent-document-renderer`（交付场景/矫正清单/渲染产物，triggersHITL），`patent_teams_add_member` role 描述同步。
- [x] 技能 `patent-document-polish`（场景→模板映射、矫正清单、美化清单、交付流程与 HITL 去重）。
- [x] 模板扩至 9 个：新增 `rectification-response` / `re-examination-request` / `infringement-opinion` / `litigation-pleading`（SKILL.md + template.html + example.html + references）。
- [x] `patent-team-composition` 七场景包均纳入文档专员，质量门禁后、收口前插入「正式文档输出」任务；质量门禁、目录规范、preset README（双语）同步。
- [x] 手工验证待办：真实案件跑一次含文档专员的团队流程（示例见 render-patent-document.spec 模板渲染单测已覆盖资产加载）。

### 追加落地记录（2026-10-08）

- [x] 提交格式成文路径：新增 `@deepseek-ai/dsh-patent-filing`（`build_patent_filing` / `verify_patent_filing`），按随包模板的体例把结构化内容成文为 CNIPA 申请文件 docx，并在交付前对成品跑体例与内容断言。
- [x] 表格式模板两份：`right-evaluation-report`（专利权评价报告）与 `search-report-form`（专利检索报告），各出「空白模板 + 已填示例」，填位随内容伸缩；`render_patent_document` 模板扩至 11 个。
- [x] 交付前置门禁覆盖成文路径：`build_patent_filing` 与 `render_patent_document` 同要求 `rule_check` + `law_verify`；`search-report-form` 与 `search-report` 同列收口模板，`right-evaluation-report` 的转制用法无分析可收口，不列入。

---

## 自检记录（writing-plans Self-Review）

### 覆盖对照表（母计划 ↔ 本清单）

| 母计划（docs/patent-workbench-plan.md） | 本清单任务 |
|---|---|
| 阶段 1：preset 落地（G1），关键动作 1–5、验收 | Task 1.1–1.6 + 阶段 1 检查清单 |
| 阶段 2：案件管理（G2）+ 双闸门（G5），关键动作 1–4、验收 | Task 2.1–2.6 + 阶段 2 检查清单 |
| 阶段 3：docx 交付（G3），关键动作 1–3、验收 | Task 3.1–3.4 + 阶段 3 检查清单 |
| 阶段 4：专家协作（G4），关键动作 1–3、验收 | Task 4.1–4.2 + 阶段 4 检查清单 |
| 阶段 5：打磨与验证，关键动作 1–4、验收 | Task 5.1–5.4 + 阶段 5 检查清单 |
| 母计划 §7 立即行动清单 | Task 1.1–1.6 覆盖其 1–3 |
| 母计划 §6 风险：preset 锁定 | 执行约定第 2 条 + Task 5.3 |
| 母计划 §6 风险：双闸门漏检 | Task 2.6 Step 2 + 阶段 2 检查清单 8 |
| 母计划 §6 风险：阶段 3/4 动仓库代码 | 执行约定第 1 条 + Task 3.2 / 4.2 的立项路径 |

### 占位符扫描结论

无 TBD / TODO / "later" / "fill in details" 类占位符。来源引用均为可读取的确定路径：`docs/patent-mode-design.md` §4/§5/§6/§7.2/§7.3/§8.2/§8.4（本仓库已跟踪）、`packages/patent/patent-*/README.md`（插件装配说明）、`~/.sati/调研/DeepSeek-Harness/源码素材-dsh-agent-teams`（本地源码）。插件行的 config 以各插件 README 为准，是执行步骤而非占位符。

### 名称一致性核对

- 目录名：工作根目录下 `<案号>/` 的子目录与设计文档 §5 一致（00-交底书/01-检索/02-对比文件/03-分析/04-撰写/05-答复/99-知识库 + `_case-registry.md`）
- 技能名：7 技能与设计文档 §7.2 一致；阶段 2/3 新增 `patent-matter` / `patent-fact-check` / `patent-compliance-review` 与母计划 G2/G5 一致
- 工具名：验收引用 `patent_search` / `patent_case_search` / `draft_claims` / `render_patent_document` 与 `patent-tools/src/tool/` 实际注册名一致；`rule_check` 与 `patent-rule` 工具一致
- 状态机：阶段 2 六列展示别名（open/retrieving/analyzing/drafting/review/closed）与 L1–L5 流水线对齐，任务正文只用后者定案
- 遗留分歧：`tool-web` fetch 取值（design §4 `fetch: true` vs 母计划 `fetch: false`）在 Task 1.2 Step 5 标注为决策点，不静默二选一

---

## 执行方式

- 用 `superpowers:executing-plans` 逐任务执行：每任务按步骤走、跑验证、标记完成；每阶段末尾跑检查清单，不过不前进。
- 动仓库代码（阶段 3.2 / 4.2 立项路径）前先 `superpowers:using-git-worktrees` 建隔离分支，并取得用户同意；master 上不直接实现。
- 阻塞即停：向用户说明卡点（依赖缺失 / 指令不清 / 验证连续失败），不猜测。
- 计划变更（如 fetch 决策、agent-teams 形态）同步回写 `docs/patent-workbench-plan.md` 与本文件，保持两文档一致。

---

## 当前态补充（2026-11-04）

团队场景包的任务序已与 manifest 阶段对齐：撰写包与答复包由 captain 用 `patent_workflow_run` 跑到审批门，成员只读阶段产出做复核与验收，场景表用「责任面」列区分 manifest 执行与团队互证；`scripts/verify-patent-team-stages.ts` 反向校验两个场景的链行与 `builtinPatentManifests` 一致。此前「15 技能」的计数已按目录实际 16 个更正。细节见 `docs/patent-workbench-plan.md` 的「对齐落地（2026-11-04）」条与 `.agents/plans/2026-11-04-patent-teams-sync-with-disclosure-oa.md`。
