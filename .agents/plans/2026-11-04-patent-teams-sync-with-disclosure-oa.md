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
| t5 对立评审（清楚/支持/充分公开/单一性） | `spec_check` → `enablement_report` → `claim_breadth` → `slop_clean`（warn 级，不阻断）→ `draft_review`（可回退权项/说明书/策略） | 未拆确定性判定与换位 `draft_review`；未写两轮回退与人工复核交接点 |
| t8 收口只点 disclosure + novelty/inventiveness | 收口应覆盖策略表、权要草稿、说明书、26.3/26.4、draft_review、legal_gaps、review_gate | 收口清单过窄 |
| （无） | 阶段写作模式 / `writing-patterns` 按阶段供给 | 派工未要求成员核对阶段模式是否已注入（由 manifest 与 preset 供给，成员只验收） |
| （无） | 权要编号结构校验 / claim_lint | 形式/质量任务未点名 |

### 2.2 答复包 vs `patent_oa_response_v1`

| 当前团队任务（摘要） | workflow 阶段（权威） | 差距 |
|---|---|---|
| t1 解析 → t2 法条 → t3 策略 → t4 起草 → t5 红队 | parse → claim-chart → response-plan → adversary-model → draft → tighten → slop_gate → adversary-review → response_check → amendment_basis | 缺 claim-chart、response-plan、adversary-model、tighten、篇幅预算、slop、adversary-review、A33 修改依据 |
| 对立审查员只做「红队评审交付稿」 | 计划薄弱点（adversary-model）与定稿换位（adversary-review）分阶段 | 角色任务未分层 |
| 文档专员直接渲染 | 技能侧已有 4000 字预算与槽位硬上限 | 团队 DAG 未把预算验收挂到 t7/t8 之前 |

### 2.3 契约面

- `applicant-counsel` worker 的 `forbiddenActions` 含 `claim_strategy` / `draft_claims`：正确（策略原子归撰写链），但团队 t7「范围审视」易被读成可改策略表——需改派工口径为**只读审视 + HITL 建议**。
- `patent-oa-writer` 的 `allowedTools` 只是 persona 文案（`workerTools()` 的 JSDoc 明确 `allowedTools` 无运行时消费者），与答复链工具面「脱节」不构成缺陷；真正的限制路径是 `members.ts` 的 `MEMBER_DENIED_TOOLS` deny 名单。
- `patent-oa-writer` 的口径锚点写明「worker 不派发 manifest」：团队不得让成员驱动 manifest 阶段，只能读 captain 运行结果。
- `verify-patent-team-roster` 只比对角色 id 总表，**不**校验场景 DAG 与 manifest 阶段——漂移可再次发生。

## 3. 设计原则

1. **单会话 workflow 是权威序**；团队 DAG 是并行互证投影，不得另立撰写/答复阶段语义。
2. **不新增第 15 个角色**；换位审查继续由 `adversarial-reviewer`，策略建议由 `applicant-counsel`，确定性渲染与说明书由 `drafter`，形式编号由 `formal-examiner`（撰写包按需短任务或并入质量门）。
3. **执行权单向：captain 跑 manifest，成员只读阶段产出。** `patent_workflow_run` 没有「只跑某个内置阶段」的入口（只有整 manifest 或 graph，`approveStageIds` 仅跳过审批门），`flexible_plan` 也只跑自定义 stage。因此成员不触发 `claim_strategy` / `draft_claims` / `tighten` 等阶段，只对 captain 已产出的阶段结果做互证、补强与验收；这条与 `worker-contract.ts` 的「worker 不派发 manifest」锚点一致。
4. **附图仍不进权项输入**（既有纪律保留）；manifest 内图分析与说明书顺序为「图分析 → 说明书」，团队任务序须跟随，不得倒置。
5. 每个 P0 改动可独立合并、可回滚；先文档/技能，再契约字段，再门禁。

## 4. 执行任务

| ID | 优先级 | 任务 | 主要触点 | 验收 |
|---|---|---|---|---|
| P0-01 | P0 | 先在方案与 SKILL 中确立「captain 跑完整 manifest、成员只读阶段产出互证」的单向关系；删除「成员执行单个 manifest 阶段」的表述 | 本文件 §3 + `patent-team-composition/SKILL.md` | 全文无「成员触发 claim_strategy / tighten」类表述；与 `worker-contract.ts` 的「worker 不派发 manifest」锚点一致 |
| P0-02 | P0 | 重写撰写包任务 DAG：captain 跑 `patent_disclosure_v1` 至 `review_gate`，成员按阶段产出分工互证，`draft_review` 的回退类别决定返工责任人 | `patent-team-composition/SKILL.md` 场景二 | 场景表可标出「manifest 责任 / 团队责任」两列；不出现成员自行驱动子阶段 |
| P0-03 | P0 | 重写答复包任务 DAG：同上；`tighten` / `slop_gate` / `adversary-review` 归 manifest，成员负责事前计划薄弱点与事后验收解释；写入 4000 字预算验收 | 同文件场景三 | 与 `patentOaResponseManifest` 阶段一致；预算条目出现在验收段 |
| P1-01 | P1 | 同步 `role-contracts.ts` 职责文案：撰写员含策略表消费与确定性权项；对立审查员含 draft_review / adversary-*；形式审查员含权要编号结构 | `role-contracts.ts` + roster 门 | `verify-patent-team-roster` 仍绿；职责句覆盖新阶段 |
| P1-02 | P1 | 审视 `worker-contract`：`patent-oa-writer` / `applicant-counsel` 输出必含字段与禁写列表注释；如确需工具约束，改 `MEMBER_DENIED_TOOLS`（`allowedTools` 无运行时消费者，仅进 persona） | `worker-contract.ts` / `members.ts` + 单测 | 契约测试通过；禁写列表与 SKILL 口径一致 |
| P1-03 | P1 | 质量门技能 / 撰写收口清单点名 enablement、claim_breadth、draft_review、claim 编号、OA tighten/slop（注明披露链 `slop_clean` 为 warn 级不阻断） | `patent-quality-gate` 等 | 清单含新条目且不与单会话技能冲突 |
| P2-01 | P2 | 扩展漂移门：以 `manifests.ts` 导出的阶段 id 作为权威集，反向校验 SKILL 场景表提及的 manifest 与其阶段，避免正搜关键词被改写绕过 | `scripts/verify-patent-team-roster.ts`（或新 gate） | 故意删 `draft_review` 时门禁失败 |
| P2-02 | P2 | 升级指南 / 子系统文档一句：团队场景包跟披露链与 OA 链阶段对齐 | upgrade-guide 或 `docs/subsystems/patent*` | doc-sync 相关项通过 |
| P2-03 | P2 | （可选）立案/复审/无效包只做轻量交叉引用——若未消费新原子则不改 DAG | SKILL 其它场景 | 无无意义扩任务 |

## 5. 建议撰写包 DAG（目标态摘要）

成员不变（7）：检索员、撰写员、对立审查员、技术专家、申请人代理、制图员、文档专员。

「manifest」= captain 用 `patent_workflow_run` 一次性执行到 `review_gate` 暂停；「团队」= 成员对该次运行的阶段产出做互证与验收，不自行驱动子阶段。

| 任务 | 主题 | 责任面 | 负责人 | 依赖 |
|---|---|---|---|---|
| t1 | 交底书理解：PFIE + 发明点分级 | 团队（读交底书） | 撰写员 | — |
| t2 | 现有技术检索与对比文件 | 团队 | 检索员 | t1 |
| t3 | 图面准备：出图与附图标记表（不回流权项） | 团队 | 制图员 | t1 |
| t4 | `patent_workflow_run(patent_disclosure_v1)` 跑至 `review_gate`：preprocess…claim_strategy→draft_claims→figure_analysis→draft_specification→spec_check/enablement/claim_breadth/slop_clean→draft_review→legal_gaps | **manifest** | captain | t2, t3 |
| t5 | 策略表与权要草稿复核：只读 `claim_strategy` / `claims_draft`，指出越界或漏特征 | 团队 | 申请人代理 | t4 |
| t6 | 说明书互证：26.3 充分公开与 26.4 概括范围逐项复核（含锚点） | 团队 | 对立审查员 | t4 |
| t7 | 技术真实性核验：实施例与效果数据 | 团队 | 技术专家 | t4 |
| t8 | `draft_review` 结果处置：按回退类别（enablement/support/amendment→说明书，clarity→权要，unity→策略）指派返工并重跑 manifest 对应段 | 团队 + manifest | captain | t5, t6, t7 |
| t9 | 过 `review_gate`（HITL）并重跑收口 | **manifest** | captain | t8 |
| t10–t11 | 正式文档 + 交付放行 | 团队 | 文档专员 / captain | t9 |

返工纪律：t8 的返工**只能通过重跑 manifest**（`approveStageIds` 放行已批准的门）实现，不得由成员手写替换说明书或权要；成员的职责是判断「哪一类缺口、由谁负责解释」。

## 6. 建议答复包 DAG（目标态摘要）

| 任务 | 主题 | 责任面 | 负责人 | 依赖 |
|---|---|---|---|---|
| t1 | OA 解析与争点梳理（人工阅读，校验 manifest 解析结果） | 团队 | 撰写员 | — |
| t2 | 答复方向与修改方案（HITL） | 团队 | 申请人代理 | t1 |
| t3 | 附图修改（若有，受 A33 约束） | 团队 | 制图员 | t2 |
| t4 | `patent_workflow_run(patent_oa_response_v1)` 跑完：parse→claim-chart→response-plan→adversary-model→draft→tighten→slop_gate→adversary-review→response_check→amendment_basis | **manifest** | captain | t2, t3 |
| t5 | 计划与对立模型解释：说明 `response-plan` 策略与 `adversary-model` 薄弱点在定稿中如何回应 | 团队 | 对立审查员 | t4 |
| t6 | 技术核验：事实与数据 | 团队 | 技术专家 | t4 |
| t7 | 交付稿验收：篇幅预算（4000 字可见字符，不含表格与权要全文）、未提争点不设节、`amendment_basis` 通过 | 团队 | 撰写员 | t5, t6 |
| t8 | 收口 + HITL 放行 | **manifest** | captain | t7 |
| t9–t10 | 正式文档 + 交付 | 团队 | 文档专员 / captain | t8 |

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

## 10. 评审记录（2026-11-04）

评审对象为本文 §1–§9。结论：**方向成立，可批准；评审发现的四处硬伤已在正文同步修订**（§3 原则、§4 任务表、§5/§6 DAG、§2.3 契约面），下文记录原始发现与处置，供复核时对照。

### 10.1 结论成立的部分（已核验）

| 主张 | 核验证据 |
|---|---|
| 撰写链已有策略表与确定性权要 | `patentDisclosureManifest` 的 `claim_strategy` 阶段与 `draft_claims` 阶段，`claim-strategy` / `draft-claims` atom 均已注册 |
| 撰写链已有多轮换位审查与按类回退 | `draft_review` 的 `retry.routes` 映射 enablement/support/amendment→`draft_specification`、clarity→`draft_claims`、unity→`claim_strategy`，`maxRetries: 2` |
| 答复链已有删减、反套话与换位复评 | `tighten`、`slop_gate`（`rewindTo: 'draft'`）、`adversary-review`、`response_check`、`amendment_basis` 均在 `patentOaResponseManifest` 内 |
| 团队场景包未跟上 | `patent-team-composition/SKILL.md` 最后实质改动为 2026-10-17（无效包复核）；场景二/三无上述阶段名 |
| 附图与说明书顺序相反 | manifest 为 `...FIGURE_ANALYSIS_STAGES, DRAFT_SPECIFICATION_STAGE`，团队原 t4→t4a 恰好相反 |
| roster 门只管角色 id | `rosterDrift()` 仅比较角色列与 `defaultRoleContracts()`，函数头注释明确场景包不在本门范围 |

### 10.2 原始发现与处置

**(A) 成员无法执行单个 manifest 阶段（P0 级，已处置）。**
`patent_workflow_run` 只有「整 manifest」与「graph」两条路径，`approveStageIds` 仅跳过审批门，没有「只跑 `claim_strategy`→`draft_claims`」的入口；`flexible_plan` 的 `run` 也只执行调用方自定义的 pending/rolled_back stage，不是内置 manifest 切片。原 §5 让撰写员先跑策略再跑权要，落地后队员只能手写权要。
→ 已改写为 §3 原则 3「执行权单向：captain 跑 manifest，成员只读阶段产出」，并在 §5/§6 增加「责任面」列区分 manifest 与团队。

**(B) `tighten` / `slop_gate` 派给成员不可执行（P0 级，已处置）。**
两者是 manifest 内阶段，脱离 manifest 后既无法触发，`slop_gate` 的 `rewindTo: 'draft'` 回退也会失效，只剩自由文本改写。
→ 已并入 §6 的 manifest 责任列，成员改为「解释计划与对立模型结论、验收篇幅预算与 A33 检查通过」。

**(C) 与既有锚点冲突：「worker 不派发 manifest」（已处置）。**
`worker-contract.ts` 的 `patent-oa-writer` 注释写明：确定性执行面＝manifest，worker＝团队组装面作业角色，两者并行、互不派发。原文让成员「执行 tighten」违反该锚点。
→ §2.3 已改述为「成员只读 captain 的运行结果」。

**(D) `allowedTools` 不能用作工具约束（已处置）。**
`workerTools()` 的 JSDoc 明确 `allowedTools` 无运行时消费者，唯一限制路径是 `members.ts` 的 `MEMBER_DENIED_TOOLS` deny 名单。
→ P1-02 已改为「如确需工具约束，改 deny 名单或改派工验收」。

### 10.3 优先级处置

原 P0-03（派工口径）承载 (A)(B)(C) 的语义修正，已前置为新的 P0-01；两个场景 DAG 顺延为 P0-02/P0-03。§4 任务表已按此重排。

### 10.4 其余修订

- `slop_clean` 在披露链是 **warn 级、不阻断**，§2.1 与 P1-03 已注明，避免执行时误当交付阻塞。
- 原 §5 把对立审查员与技术专家并行核同一份说明书：并行不省轮次、反增汇总成本，已拆为各自独立任务（t6 说明书互证、t7 技术真实性）。
- P2-01 已改为以 manifest 导出阶段 id 为权威集反向校验，避免正向搜词被改写绕过。
- 「阶段写作模式」一项改为成员验收「模式是否已注入」，注入由 manifest 与 preset 负责。

### 10.5 复核要求

本方案仍为纯计划文档，无回归证据。实施时每个 PR 须附：

1. `pnpm exec tsx scripts/verify-patent-team-roster.ts`（角色总表与契约一致）。
2. 触及 `patent-workflow` / `patent-teams` 时的相关单测。
3. 改 SKILL 场景表时，`packages/bundle/web-app/tests/patent-preset.spec.ts` 的团队路由与确认点断言仍绿。
4. P2-01 门禁须有一条「删掉 `draft_review` 即失败」的反向用例。

`verify-md-wrap` 与 `verify-md-links` 的扫描集合都不含 `.agents/plans/**`（前者只收 `.agents/notes/**`，后者实测 3240 个文件中 plans 目录占 0 个），因此本目录的排版与相对链接没有机器门禁保护，需人工自查；是否把 plans 纳入这两道门见任务清单 C5。

详细任务与检查清单见 [2026-11-04-patent-teams-sync-tasks-and-checks.md](2026-11-04-patent-teams-sync-tasks-and-checks.md)。
