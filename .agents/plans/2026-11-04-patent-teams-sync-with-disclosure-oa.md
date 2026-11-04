# 专利团队对齐近期撰写 / 答复能力 — 优化方案

- 日期：2026-11-04（Asia/Shanghai）
- 状态：计划（待批准后执行）
- 范围：`patent-team-composition` 技能、`role-contracts` / `worker-contract`、质量门与漂移门禁；不改 `patent_disclosure_v1` / `patent_oa_response_v1` 原子实现
- 依据：本轮对 2026-10-20 以来专利域提交与团队侧最后触达时间的对照审查

## 1. 结论

近期专利域大量能力已进入 workflow / atoms / skills，但**专利团队编排面未同步**。

| 面 | 最后实质更新（约） | 近期能力是否接入 |
|---|---|---|
| `patent_disclosure_v1` / atoms | 2026-10-20 后连续合入 | 已有 claim-strategy、多路从权、writing-patterns、A26.3/26.4、draft-review、slop 等 |
| `patent_oa_response_v1` / OA 技能 | 同期精简与换位审查 | 已有 response-plan、adversary-model、tighten、slop_gate、adversary-review |
| `patent-team-composition` 场景 DAG | 2026-10-17（无效包） | **未**写 claim_strategy / draft_review / 篇幅预算 / tighten |
| `role-contracts.ts`（14 角色） | 更早；仅禁写列表提到 `claim_strategy` | 角色职责与派工字段未跟新阶段 |
| `patent-teams` 运行时 | 偏基础设施与审批 | 无业务阶段同步需求（本方案不改调度内核） |

判定：**需要优化**。优先改「场景任务 DAG + 角色/worker 契约 + 收口验收」，不新增角色；`adversarial-reviewer` / `applicant-counsel` / `drafter` / `formal-examiner` 承接新阶段即可。

## 2. 差距矩阵（证据）

### 2.1 撰写包 vs `patent_disclosure_v1`

| 当前团队任务（摘要） | workflow 阶段（权威） | 差距 |
|---|---|---|
| t3 权利要求布局方案（撰写员） | `claim_strategy` → `draft_claims`（策略表确定性渲染 + 多路从权） | 团队仍按「人工布局→再写权项」叙述；未要求消费策略表 / 从权树 |
| t4 说明书五部分 → t4a 附图 | `FIGURE_ANALYSIS_STAGES` → `draft_specification`（图在说明书前） | **顺序相反**；与「附图不进权项输入」纪律一致，但与 manifest 执行序冲突 |
| t5 对立评审（清楚/支持/充分公开/单一性） | `spec_check` → `enablement_report` → `claim_breadth` → `slop_clean` → `draft_review`（可回退权项/说明书/策略） | 未拆确定性判定与换位 `draft_review`；未写两轮回退与人工复核交接点 |
| t8 收口只点 disclosure + novelty/inventiveness | 收口应覆盖策略表、权要草稿、说明书、26.3/26.4、draft_review、legal_gaps、review_gate | 收口清单过窄 |
| （无） | 阶段写作模式 / `writing-patterns` 按阶段供给 | 派工未要求 `query_writing_patterns` 或阶段模式注入 |
| （无） | 权要编号结构校验 / claim_lint | 形式/质量任务未点名 |

### 2.2 答复包 vs `patent_oa_response_v1`

| 当前团队任务（摘要） | workflow 阶段（权威） | 差距 |
|---|---|---|
| t1 解析 → t2 法条 → t3 策略 → t4 起草 → t5 红队 | parse → claim-chart → response-plan → adversary-model → draft → tighten → slop_gate → adversary-review → response_check → amendment_basis | 缺 claim-chart、response-plan、adversary-model、tighten、篇幅预算、slop、adversary-review、A33 修改依据 |
| 对立审查员只做「红队评审交付稿」 | 计划薄弱点（adversary-model）与定稿换位（adversary-review）分阶段 | 角色任务未分层 |
| 文档专员直接渲染 | 技能侧已有 4000 字预算与槽位硬上限 | 团队 DAG 未把预算验收挂到 t7/t8 之前 |

### 2.3 契约面

- `applicant-counsel` worker 的 `forbiddenActions` 含 `claim_strategy` / `draft_claims`：正确（策略原子归撰写链），但团队 t7「范围审视」易被读成可改策略表——需改派工口径为**只读审视 + HITL 建议**。
- `patent-oa-writer` `allowedTools` 仍为 `read` / `write` / `patent_eval`，与答复链工具面脱节（若团队走 `patent_workflow_run` 收口则可保留薄工具面，但派工必须强制走 manifest）。
- `verify-patent-team-roster` 只比对角色 id 总表，**不**校验场景 DAG 与 manifest 阶段——漂移可再次发生。

## 3. 设计原则

1. **单会话 workflow 是权威序**；团队 DAG 是并行互证投影，不得另立撰写/答复阶段语义。
2. **不新增第 15 个角色**；换位审查继续由 `adversarial-reviewer`，策略建议由 `applicant-counsel`，确定性渲染与说明书由 `drafter`，形式编号由 `formal-examiner`（撰写包按需短任务或并入质量门）。
3. **团队成员优先调用 `patent_workflow_run` 对应阶段产物**，禁止用自由文本「重写一遍」绕过 claim-strategy / draft_claims / tighten。
4. **附图仍不进权项输入**（既有纪律保留）；仅把制图任务挪到说明书撰写之前或与说明书并行且不回流权项。
5. 每个 P0 改动可独立合并、可回滚；先文档/技能，再契约字段，再门禁。

## 4. 执行任务

| ID | 优先级 | 任务 | 主要触点 | 验收 |
|---|---|---|---|---|
| P0-01 | P0 | 重写撰写包任务 DAG：对齐 claim_strategy → draft_claims → 图分析 → draft_specification → 26.3/26.4 → slop → draft_review → legal_gaps → review_gate → 文档交付 | `patent-team-composition/SKILL.md` 场景二 | 任务表阶段 id 与 `patentDisclosureManifest` 可逐行对照；顺序与 manifest 一致 |
| P0-02 | P0 | 重写答复包任务 DAG：对齐 claim-chart → response-plan → adversary-model → draft → tighten → slop_gate → adversary-review → response_check / amendment_basis；写入 4000 字预算验收 | 同文件场景三 | 与 `patentOaResponseManifest` 可逐行对照；预算条目出现在验收段 |
| P0-03 | P0 | 更新对立审查员 / 撰写员 / 申请人代理在两场景中的任务主题与依赖（计划薄弱点 vs 定稿换位；策略表只读审视） | SKILL 任务表 + 角色总表职责句 | 无「代写策略表 / 绕过确定性权项渲染」表述 |
| P1-01 | P1 | 同步 `role-contracts.ts` 职责文案：撰写员含策略表消费与确定性权项；对立审查员含 draft_review / adversary-*；形式审查员含权要编号结构 | `role-contracts.ts` + roster 门 | `verify-patent-team-roster` 仍绿；职责句覆盖新阶段 |
| P1-02 | P1 | 审视 `worker-contract`：`patent-oa-writer` / `applicant-counsel` 输出必含字段与禁写列表注释；必要时为撰写员增加「策略表/从权树/权要草稿路径」硬字段（若团队仍用 worker 产出而非只跑 manifest） | `worker-contract.ts` + 单测 | 契约测试通过；禁写列表与 SKILL 口径一致 |
| P1-03 | P1 | 质量门技能 / 撰写收口清单点名 enablement、claim_breadth、draft_review、claim 编号、OA tighten/slop | `patent-quality-gate` 等 | 清单含新条目且不与单会话技能冲突 |
| P2-01 | P2 | 扩展漂移门：从 SKILL 场景二/三解析 `manifestId` 与关键阶段关键词，对照 `manifests.ts` 阶段 id 集合 | `scripts/verify-patent-team-roster.ts`（或新 gate） | 故意删 `draft_review` 时门禁失败 |
| P2-02 | P2 | 升级指南 / 子系统文档一句：团队场景包跟披露链与 OA 链阶段对齐 | upgrade-guide 或 `docs/subsystems/patent*` | doc-sync 相关项通过 |
| P2-03 | P2 | （可选）立案/复审/无效包只做轻量交叉引用——若未消费新原子则不改 DAG | SKILL 其它场景 | 无无意义扩任务 |

## 5. 建议撰写包 DAG（目标态摘要）

成员不变（7）：检索员、撰写员、对立审查员、技术专家、申请人代理、制图员、文档专员。

| 任务 | 主题 | 负责人 | 依赖 |
|---|---|---|---|
| t1 | 交底书理解：PFIE + 发明点分级（可走 disclosure 前段） | 撰写员 | — |
| t2 | 现有技术检索与对比文件 | 检索员 | t1 |
| t3 | 权利要求策略表（`claim_strategy`，HITL） | 撰写员 | t2 |
| t4 | 确定性权要草稿（`draft_claims`，多路从权；禁止手写覆盖策略表） | 撰写员 | t3 |
| t4a | 附图分析/出图与标记表（不回流权项） | 制图员 | t4 |
| t5 | 说明书五部分（消费权要+图；阶段 writing-patterns） | 撰写员 | t4a |
| t6 | A26.3/26.4 + slop 报告；技术真实性核验 | 对立审查员 / 技术专家（并行） | t5 |
| t7 | `draft_review` 换位审查；可执行项按类回退（最多两轮） | 对立审查员 | t6 |
| t8 | 范围只读审视（扩张/从权建议，不改策略表） | 申请人代理 | t7 |
| t9 | `patent_workflow_run(patent_disclosure_v1)` 收口至 review_gate + 规则门 | captain | t8 |
| t10–t11 | 正式文档 + 交付放行 | 文档专员 / captain | t9 |

## 6. 建议答复包 DAG（目标态摘要）

| 任务 | 主题 | 负责人 | 依赖 |
|---|---|---|---|
| t1 | OA 解析（`oa-parse`） | 撰写员 | — |
| t2 | 要素对照表（`claim-chart`） | 撰写员 | t1 |
| t3 | 答复计划骨架（`response-plan`，HITL） | 申请人代理 | t2 |
| t3a | 计划薄弱点（`adversary-model`） | 对立审查员 | t3 |
| t3b | 附图修改（若有） | 制图员 | t3 |
| t4 | 意见陈述起草（消费 plan + adversary-model；守预算） | 撰写员 | t3a, t3b |
| t5 | 删减（`tighten`）+ slop_gate | 撰写员 | t4 |
| t6 | 定稿换位（`adversary-review`）+ response_check / amendment_basis | 对立审查员 | t5 |
| t7 | 技术核验（并行于 t6 若无冲突） | 技术专家 | t4 |
| t8 | `patent_workflow_run(patent_oa_response_v1)` 收口 | captain | t6, t7 |
| t9–t10 | 正式文档 + 交付 | 文档专员 / captain | t8 |

## 7. 明确不做

- 不把 `writing-patterns` 提升为新团队角色。
- 不改 `patent-teams` 调度/邮箱/审批内核（除非门禁发现契约字段破坏运行时）。
- 不在本方案合并窗口重跑全量 snapshot；行为变更以技能与契约测试为主，必要时补一条团队场景期望片段。
- 不借机合并法律/文档/视频 30 天审查项（见 `reports/code-review-simplification-30-day-plan.md`）。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 任务数增加导致 7 人团队过载 | 保持成员上限；并行 t6/t7；强调「宁小勿大」纪律不变 |
| 队员绕过 manifest 手写权要 | 派工五段强制写验收工具与禁止项；P1 硬字段 |
| SKILL 与 manifest 再次漂移 | P2-01 门禁 |
| 与进行中的 preset writingPatterns 隔离修复冲突 | 本方案不改 `patent.patch.yml` 服务隔离；可叠在该修复之后 |

回滚：还原 `patent-team-composition/SKILL.md` 与契约文件即可；门禁新增用独立提交。

## 9. 批准后执行顺序

1. 合入/确认 `fix/patent-preset-writing-patterns-isolate`（或等价）不阻塞团队技能。
2. PR-A：P0-01 + P0-02 + P0-03（仅技能与角色表文案）。
3. PR-B：P1-01 + P1-02 + 契约测试。
4. PR-C：P1-03 + P2-01 + P2-02。

每 PR 运行：`pnpm exec tsx scripts/verify-patent-team-roster.ts`、相关 `patent-workflow` / `patent-teams` 单测；技能改动走 `doc-sync` 中触及项。
