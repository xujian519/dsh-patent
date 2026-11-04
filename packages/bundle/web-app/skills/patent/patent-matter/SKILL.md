---
name: patent-matter
description: 专利案件管理：可配置工作根目录下的案卷文件夹、七级子目录与两个跟踪文件、L1–L5 流水线状态机、只追加事件日志与审计链。建案、案件状态流转、归档、追溯证据链时使用。
---

# 案件管理

一个案子一个子目录，目录在可配置工作根目录下（典型值 `/Users/xujian/工作`），所有中间产物与证据落在该目录的磁盘文件上。多个案子共用本仓库，不要为每个案子另建 Cursor 或 git 项目。案件生命周期由只追加事件日志驱动，产物文件头元数据构成审计链。决定见 `docs/adr/ADR-001-matter-folder-index.md`。

## 建案

1. 目录：在可配置工作根目录下建 `<案号>/`（典型值 `/Users/xujian/工作/<案号>/`）。其下建七级目录（`00-交底书` / `01-检索` / `02-对比文件` / `03-分析` / `04-撰写` / `05-答复` / `99-知识库`；目录命名与落盘规则详见 patent-workspace-layout 技能），加 `_case-registry.md` 与 `_matter-log.md` 两个跟踪文件。不要把该目录建成独立的 Cursor 或 git 项目，也不要改到忽略工作根目录的 `patent-workspace/` 树。多个案子共用本仓库。
2. 注册：`_case-registry.md` 追加一行（案号、状态、阶段产物索引）。
3. 初始化事件日志 `_matter-log.md`：`matter_log_append({case_dir, action: '建案', artifacts: [案件目录], changes: '建案，交底书已入 00-交底书/。', approver: '用户'})`——日志由该工具独占写入，首次调用即建案。
4. 建案即生成 `_checklist.md`，按案型勾选（见下表）：勾选即证据，未勾选项不得进入交付。

## 案件检查单（`_checklist.md`）

建案时按案型复制一份，逐项在对应阶段勾选并写产物路径；空着的项就是未完成的阶段。

| 阶段 | 必勾项（撰写案示例） | 证据 |
|---|---|---|
| 入口 | 载入 patent-workspace-layout / patent-disclosure-understanding / patent-prior-art-search | 技能加载记录 |
| 检索 | 检索式经用户确认；多通道执行并记录覆盖范围与未覆盖清单 | `01-检索/YYYY-MM-DD_<主题>.md` |
| 对比文件 | D1/D2/D3 落盘、公开日核验、双源交叉 | `02-对比文件/D*_<公开号>.pdf` |
| 撰写 | 要素拆分、权利要求布局（HITL）、说明书五部分、validate_specification | `03-分析/`、`04-撰写/` |
| 收口 | `patent_workflow_run`（按案型 manifest）留下 stage 记录 | 工作流 run 记录 |
| 闸门 | `rule_check`（patent-compliance-review）+ 法条/日期/数字核验（patent-fact-check） | 门禁结论 |
| 交付 | patent-quality-gate 通过、`render_patent_document` 渲染、`matter_log_append` 登记（含取代链）、工作台桥接 | `05-交付/` 或对应目录产物 |

案型差异：答复案把"撰写"换成 OA 解析 + 逐权项修改对照（`patent_oa_response_v1`）；检索/无效/复审/侵权案把"撰写"换成对应技能的分析流程与要素级比对，收口用该案型 manifest；补正案无 manifest 入口，以替换页逐项核验清单替代收口行。无效案代表专利权人（被请求人）时，"撰写"换成答辩流程（见 patent-invalidation-defense），收口仍用 `patent_invalidation_v1`。

## 状态机（六列，按 L1–L5 流水线映射）

| 状态 | 含义 | 对应流水线 |
|---|---|---|
| open | 已建案；含 t1 交底书理解（产物 `03-分析/<案号>_案件理解.md`） | 建案 / L1 |
| retrieving | 检索中 | L2 检索 |
| analyzing | 分析中 | L2 三性 / L5 侵权·无效 |
| drafting | 撰写中 | L3 撰写 / L4 答复 / L5 文书 |
| review | 门禁/审批中 | L3/L4/L5 quality-gate |
| closed | 归档 | 交付完成 |

状态只增不改：状态变更必须写日志，不覆盖历史。

## 事件日志（_matter-log.md，只追加）

日志的唯一写入口是 `matter_log_append({case_dir, action, artifacts, changes, supersedes?, approver?})`，条目字段由它固定，不手写日志行。

- `action` 取 建案/检索/分析/撰写/门禁/修订/交付/归档；`changes` 写清本轮改了什么、为什么、是否影响保护点——这就是交付回合要交代的留档内容。
- `artifacts` 是本轮产物（须已存在，日志记事实不记计划）；撰写/修订轮必须用新路径另存新文件，禁止覆盖上一轮。
- `supersedes` 显式登记本轮产物取代的既有文件：一个旧版只能有一个取代者（取代链不得分叉），被取代的旧版先归档，再让新路径成为读者打开的那一份。
- 条目只追加：既有行不改写；发现记录错误时追加更正行（`action=修订`，在 `changes` 里写明更正了什么）。
- 交付前置门禁要求本会话成功留档过，才允许 `render_patent_document` / `build_patent_filing`——未留档的回合交付不了件。

示例：

```
2026-08-19T21:00:00+08:00 | UTC 2026-08-19T13:00:00.000Z | 建案 | 产物 /Users/xujian/工作/CN2026-0001/ | 取代 — | 用户 | 建案，交底书已入 00-交底书/
2026-08-19T21:15:00+08:00 | UTC 2026-08-19T13:15:00.000Z | 检索 | 产物 01-检索/2026-08-19_硅基负极.md | 取代 — | 用户(检索式确认) | 三通道检索完成，命中 D1/D2，未覆盖清单见文末
```

## 审计链

- 每份交付产物（分析报告/权利要求书/答复意见/比对报告）文件头带元数据块：来源（输入文件）、版本（v1/v2…）、审批（ask_user_question 结果）、时间戳。
- 与 patent-workflow 的审批/plantask 记录并轨（`patent/plantask` 会话事件；ApprovalRecord 仅在部署配置 approvalStore 时产生）：事件日志是唯一事实源，审批记录只是投影，不另立账本。
- 交付物修订（tracked changes 的接受/拒绝）以追加行记录：动作=修订，备注=接受/拒绝与原因；不覆写已交付版本的日志行。
- 追溯：任一产物 → 文件头元数据 → `_matter-log.md` → `01-检索/` 记录 → 对比文件，链路完整才算审计可重建。

## 与编排机制对齐

- 一个案子注册一个 goal（跨轮持续推进）。
- 流水线阶段用 todo 跟踪，阶段产物即 todo 完成标准。
- 个人工作台桥接：用户的工作台（侧边栏「工作台」：日历/任务树/知识库/日报周报）挂载时，建案后或用户要求把案件纳入工作台时调用 `workbench_link_patent_case(caseNumber=案号)` 幂等桥接——根任务=案号、L1–L5 阶段子任务（`source=patent`），阶段状态按 `_matter-log.md` 投影。投影是单向的：案件状态的唯一事实源仍是 `_matter-log.md` 与案卷文件，不得经工作台反向改写；工作台通用协作规则（草稿确认、AI 验收闭环、任务共享记忆、排程提案）以插件注入的工作台指南段为准，其中执行完成一律提交验收申请，不得直接把任务标记为完成/取消。
- 工作台账本是 `~/.dsh/workbench` 下的 SQLite，只存索引（元数据与 workspace_path）。扫描进账本不复制案卷正文。案卷正文留在工作根目录的案卷文件夹，不进云端，也不进 `knowledge.db`。桥接可以读取投影，不得把写回案卷目录当成账本。`workbenchCaseRoot` 应设为该工作根目录；未配置时的 `<cwd>/patent-workspace` 回退不是真源。决定见 `docs/adr/ADR-001-matter-folder-index.md`。
- 关键 HITL 点（按 persona 纪律 6，非穷举）：检索式确认（L2 前，见 patent-prior-art-search）、权利要求布局确认（L3 plan-mode 获批时）、答复策略确认（L4）、无效理由组合确认（L5，请求人侧，见 patent-invalidity）、无效答辩策略与权利要求书修改方案确认（L5，被请求人侧，见 patent-invalidation-defense）、交付放行确认（门禁后，见 patent-quality-gate）。
