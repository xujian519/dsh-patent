# 专利团队对齐撰写/答复链 — 详细任务清单与检查清单

- 日期：2026-11-04（Asia/Shanghai）
- 上位方案：[2026-11-04-patent-teams-sync-with-disclosure-oa.md](2026-11-04-patent-teams-sync-with-disclosure-oa.md)
- 用途：把方案 §4 的 P0/P1/P2 拆成可派工、可验收的任务，并给出提交前/评审前可逐条勾选的检查清单
- 执行前提：方案 §10 的评审修订已生效——**captain 跑 manifest，成员只读阶段产出**，成员不驱动单个 manifest 阶段

## 1. 事实基线（执行前先认这些常量，不要在实现时重新猜）

### 1.1 `patent_disclosure_v1` 阶段权威序

`preprocess` → `eligibility` → `extract_problem` → `extract_features` → `extract_effects` → `merge` → `groundedness` → `consistency` → `generate_keywords` → `time_baseline` → `search` → `prior_art_filter` → `novelty` → `citation_check` → `report` → `claim_strategy` → `draft_claims` → `figure_analysis` → `figure_analysis_parse` → `draft_specification` → `spec_check` → `enablement_report` → `claim_breadth` → `slop_clean` → `draft_review` → `legal_gaps` → `review_gate`

### 1.2 `patent_oa_response_v1` 阶段权威序

`dispute-framing` → `parse` → `dispute-framing-refine` → `claim-chart` → `response-plan` → `adversary-model` → `generate_keywords` → `draft` → `tighten` → `slop_gate` → `adversary-review` → `response_check` → `amendment_basis` → `legal_gaps` → `approval`

### 1.3 14 个角色 id（不得增删）

`case-manager`、`researcher`、`drafter`、`technical-expert`、`adversarial-reviewer`、`applicant-counsel`、`formal-examiner`、`invalidity-petitioner`、`patentee-defender`、`adjudicator`、`defendant-counsel`、`tech-investigator`、`illustrator`、`document-specialist`

### 1.4 16 个 worker 名（引用时必须存在）

`patent-technical-analyzer`、`patent-search-commander`、`patent-novelty-analyzer`、`patent-inventiveness-analyzer`、`patent-oa-writer`、`quality_checker`、`case-manager`、`applicant-counsel`、`formal-examiner`、`invalidity-petitioner`、`patentee-defender`、`defendant-counsel`、`adjudicator`、`tech-investigator`、`patent-illustrator`、`patent-document-renderer`

### 1.5 成员工具约束的唯一生效路径

`MEMBER_DENIED_TOOLS`（`packages/patent/patent-teams/src/members.ts`）。`allowedTools` 只渲染进成员 persona，**无运行时消费者**；不要用它做约束，也不要为它写测试期望。

### 1.6 已知门禁覆盖缺口（本轮实测）

- `verify-md-wrap` 的扫描集合含 `docs/**`、`.agents/notes/**`、`packages/*/*.md` 等，**不含 `.agents/plans/**`**。
- `verify-md-links` 的扫描集合含 `.agents/skills/**`、`.agents/notes/**`，**不含 `.agents/plans/**`**；实测 `markdownLinkSourcePaths()` 返回 3240 个文件中 plans 目录占 0 个。
- 结论：本目录下的计划文档不受这两道门保护，检查清单里的「文档排版/链接」项对 plans 只能人工自查；若要机器化，见 C5。
- `builtinPatentManifests`（`packages/patent/patent-workflow/src/workflow/manifests.ts`）已导出全部 8 个内置 manifest，`verify-patent-team-stages` 直接以它作为阶段权威集，无需再读源码文本。

## 2. 任务清单

责任面说明：「manifest」= 只能由 captain 通过 `patent_workflow_run` 执行；「团队」= 成员只读产出做互证或产出团队自有物。

### 2.1 PR-A（P0）：团队技能与派工口径

| ID | 任务 | 改动文件 | 依赖 | 完成定义 |
|---|---|---|---|---|
| A1 | 在 SKILL 的「派工纪律」中新增一段「执行权单向」：captain 跑 manifest 至审批门，成员只读阶段产出互证；成员不得声明已执行某阶段 | `patent-team-composition/SKILL.md` | — | 全文检索无「由 X 调 `claim_strategy`」「成员执行 tighten」类表述 |
| A2 | 重写场景二（撰写包）任务表：加「责任面」列；图面准备在 manifest 之前；manifest 跑到 `review_gate`；`draft_review` 回退类别决定返工责任人；返工只能重跑 manifest | 同上 场景二 | A1 | 任务表逐行可映射到 §1.1 阶段序；无成员驱动子阶段 |
| A3 | 重写场景三（答复包）任务表：加「责任面」列；`tighten`/`slop_gate`/`adversary-review`/`response_check`/`amendment_basis` 归 manifest；成员负责方向确认、技术核验、交付稿验收 | 同上 场景三 | A1 | 逐行可映射到 §1.2；预算验收写在验收段 |
| A4 | 角色总表职责句补新阶段关键词：撰写员（消费策略表/确定性权项）、对立审查员（换位审查 `draft_review`、`adversary-model`/`adversary-review`）、形式审查员（权要编号结构） | 同上 角色总表 | — | 14 行未增删；`verify-patent-team-roster` 绿 |
| A5 | 协作纪律与质量门禁段：写清「披露链 `slop_clean` 为 warn 级不阻断」「OA `slop_gate` 未过会回退 `draft`」两条区别 | 同上 | A2, A3 | 两处描述与实际 atom 行为一致 |
| A6 | 质量门禁技能补条目：权要编号结构（`claim_lint`）、A26.3/26.4 实体判定（`enablement_report`/`claim_breadth`）、OA 篇幅预算 | `patent-quality-gate/SKILL.md` | — | 新条目不与既有 1–12 条重复；每条给出执行工具名 |
| A7 | 检查 preset 指南是否需同步：`presets/patent.md` / `patent.zh.md` 的技能数、流程描述 | `packages/bundle/web-app/presets/patent*.md` | A2, A3 | `patent-preset.spec.ts` 全绿；中文技能数与目录一致 |

### 2.2 PR-B（P1）：契约与文案

| ID | 任务 | 改动文件 | 依赖 | 完成定义 |
|---|---|---|---|---|
| B1 | `role-contracts.ts` 职责文案与 A4 口径一致（只改 `description`/`forbiddenActions` 文本，不改 role id、不改 workers 引用） | `patent-workflow/src/role-contracts.ts` | A4 | `role-contracts.spec.ts` 通过；14 角色、stance 合法、worker 均可解析 |
| B2 | `worker-contract.ts`：给 `patent-oa-writer`/`applicant-counsel` 的禁写列表补注释说明「不派发 manifest」的边界；确认 `requiredFields` 与 SKILL 验收字段一致 | `patent-workflow/src/worker-contract.ts` | — | 无新增 requiredFields 破坏既有 spec；注释不与代码矛盾 |
| B3 | 若确需工具约束，只在 `MEMBER_DENIED_TOOLS` 增删，并同步 `members.spec.ts` 的 deny 断言 | `patent-teams/src/members.ts` + `members.spec.ts` | — | deny 名单每个名字都在成员继承工具面内（否则 `tools.restrict()` 抛错） |
| B4 | 升级指南：若团队场景语义变化属外部可感知，写一条对应版本 guide | `docs/upgrade-guide/<version>/<item>/guide.md`（中英） | A2, A3 | `verify-upgrade-guides` 通过；中英成对 |

### 2.3 PR-C（P2）：门禁与文档

| ID | 任务 | 改动文件 | 依赖 | 完成定义 |
|---|---|---|---|---|
| C1 | 新门禁 `verify-patent-team-stages`：以 manifest 导出的阶段 id 为权威集，反向校验 SKILL 场景二/三提及的 manifest 与其阶段是否都真实存在且顺序不自相矛盾 | `scripts/verify-patent-team-stages.ts` | A2, A3 | 缺表/改关键词不会静默通过；空语料（未解析到任何 manifest 引用）判失败 |
| C2 | 门禁 spec：正向用例（当前树绿）+ 反向用例（删掉 `draft_review` 一行必须失败）+ 空语料用例 | `scripts/verify-patent-team-stages.spec.ts` | C1 | 三条用例各自独立可失败 |
| C3 | 接入 `run-gates.ts` 的 quick 组与 `package.json` 脚本 | `scripts/run-gates.ts`、`package.json` | C2 | `pnpm run verify-patent-team-stages` 可单跑；doc-quick 含该门 |
| C4 | 文档同步：子系统页或工作台任务页记录「团队场景跟 manifest 对齐」的当前态 | `docs/subsystems/patent*.md` 或 `docs/patent-workbench-tasks.md` | C1 | `doc-sync` 相关项通过；中英成对 |
| C5 | （可选，独立评估）把 `.agents/plans/**` 纳入 `verify-md-wrap` 与 `verify-md-links` | `scripts/verify-md-wrap.ts`、`scripts/verify-md-links.ts` | — | 加入后现存 plans 全绿，否则先修存量 |

### 2.5 落地状态（2026-11-04）

A1–A6、B1–B2、C1–C3 已实现；A7 不需要改动（preset 指南的技能数与名称未变，只补了执行面说明）；B3 无需要（未新增工具约束）；B4 未写（团队场景语义变化未触及已发布的外部契约面）；C4/C5 留待后续。

### 2.4 不做

- 不改 `patent_workflow_run` 的参数面（不新增「只跑某阶段」入口）。
- 不改 `patent-teams` 调度、邮箱、审批内核。
- 不新增第 15 个角色，不新增 worker。
- 不把 `writing-patterns` 提为角色。

## 3. 检查清单

### 3.1 通用（每个 PR 提交前逐条勾）

- [ ] 分支名符合 `cursor/<descriptive>-ebbd`，基于 `fix/patent-preset-writing-patterns-isolate`
- [ ] `git status --short --branch` 无意外文件；无临时调试代码
- [ ] `git diff --cached --check` 通过（行尾空白、文件末单一换行）
- [ ] 改动文件都在方案 §2 声明的触点内；超出需在 PR 描述说明理由
- [ ] 每个任务有对应验收命令并已运行，结果粘进 PR 的 Proof 块
- [ ] 未改未声明要改的公共导出、Session 格式、preset 行

### 3.2 PR-A 专项（技能文本正确性）

- [ ] 场景二/三表格的每个阶段名与 §1.1/§1.2 逐字一致（大小写、下划线/连字符都要对）
- [ ] 全文无「成员执行/触发某 manifest 阶段」的表述；成员动作用「复核」「互证」「验收」「解释」描述
- [ ] 附图相关任务位于说明书之前，且保留「附图不作为权利要求撰写输入」的纪律句
- [ ] 每个场景成员数 ≤ 8（`maxMembers` 默认值），成员名与角色总表一致
- [ ] 任务依赖无环；每个非首任务的 `依赖` 列都指向真实存在的任务号
- [ ] 返工路径只写「重跑 manifest（`approveStageIds` 放行已批准门）」，不写成员手改权要/说明书
- [ ] `slop_clean`（披露链，warn 不阻断）与 `slop_gate`（OA，未过回退 `draft`）描述不混用
- [ ] 质量门禁新条目各给出可执行工具名，不写「应检查」式空话
- [ ] 技能 frontmatter `name` 与目录同名、`description` 非空

### 3.3 PR-B 专项（契约一致性）

- [ ] 角色仍为 14 个，role id 未改，stance 未改
- [ ] 每个角色引用的 worker 名都在 §1.4 内
- [ ] 未新增 `requiredFields` 导致既有团队任务验收失败；如新增，同步更新 SKILL 验收段
- [ ] 若改 deny 名单：每个名字都在成员继承工具面内（未知名字会让 `add_member` 直接失败）
- [ ] 未用 `allowedTools` 表达约束意图
- [ ] 升级指南中英成对，术语与 `docs/i18n/terminology.md` 一致

### 3.4 PR-C 专项（门禁质量）

- [ ] 门禁有反向用例：故意删除场景表中某关键阶段后必须失败
- [ ] 门禁有空语料守卫：解析不到任何 manifest 引用时判失败，而不是空数组通过
- [ ] 门禁不依赖网络、不写文件、不占端口；可在 forked worker 内独立通过
- [ ] 门禁失败信息指名「哪个场景、缺哪个阶段、期望顺序」
- [ ] 接入 quick 组后 `pnpm run test:docs` 仍绿
- [ ] 若纳入 plans 目录的既有门禁：先修存量再加门，不新增失败

### 3.5 评审前（PR 描述）

- [ ] 按 `dsh-pr-description` 写全 Motivation / Changes / Testing / AI Usage
- [ ] 引用同仓库 Issue（`Refs #N`）
- [ ] Changes 明确列出 Interface changes 与 Behavior changes；文档改动也属 Behavior changes
- [ ] Testing 的 Test design 与改动类型匹配（文档型 = 如何检查内容；行为型 = 场景×前后×覆盖测试）
- [ ] 每条测试条目都写实际运行过的命令与结果
- [ ] 声明 `slop_clean` 等的实际等级，不夸大阻断性

### 3.6 实施后（合并前最后一遍）

- [ ] `pnpm exec tsx scripts/verify-patent-team-roster.ts` 通过
- [ ] `pnpm exec tsx scripts/verify-md-wrap.ts` 通过（注意不含 plans 目录）
- [ ] `pnpm exec tsx scripts/verify-md-links.ts` 通过
- [ ] `pnpm exec vitest run packages/bundle/web-app/tests/patent-preset.spec.ts` 全绿
- [ ] 触及 `patent-workflow` 时 `pnpm exec vitest run packages/patent/patent-workflow/tests` 全绿
- [ ] 触及 `patent-teams` 时 `pnpm exec vitest run packages/patent/patent-teams/tests` 全绿
- [ ] 若 C1–C3 已合并：`pnpm run verify-patent-team-stages` 通过
- [ ] 无新增 skip；CI 的 Windows/Python 车道不受影响（仅文档改动时说明理由）

## 4. 任务与检查项对照矩阵

| 任务 | 必过检查 | 命令 |
|---|---|---|
| A1/A2/A3 | 3.2 全部、3.6 前四条 | roster + md-wrap + md-links + patent-preset.spec |
| A4 | 3.3 前两条 | roster + role-contracts.spec |
| A5/A6 | 3.2 后三条 | md-wrap + patent-preset.spec |
| A7 | 3.6 第四条 | patent-preset.spec |
| B1 | 3.3、3.6 第五条 | role-contracts.spec |
| B2/B3 | 3.3、3.6 第六条 | members.spec + tool-contract.spec |
| B4 | 3.5、3.6 前三条 | verify-upgrade-guides + md-links |
| C1/C2/C3 | 3.4 全部 | 新门禁单测 + test:docs |
| C4 | 3.5、3.6 前三条 | doc-sync |
| C5 | 3.4 最后一条 | md-wrap + md-links |

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 场景表改写后成员仍按旧习惯手写权要 | A1 写入硬约束 + A2/A3 的「责任面」列 + C1 门禁 | 还原 SKILL 单文件 |
| 新门禁误伤既有绿灯 | C2 正向用例跑当前树；C1 空语料守卫 | 门禁独立提交，revert 即可 |
| B1 文案改动触发 role-contracts.spec 断言 | 只改文本字段，不动结构断言 | 还原 `role-contracts.ts` |
| 与 `fix/patent-preset-writing-patterns-isolate` 的 preset 隔离修复冲突 | A 系列不改 `patent.patch.yml` | 可叠在该修复之后 |
| 团队任务数增加导致 7 人过载 | 场景成员数不增；并行任务只在确无共享输入时并列 | 减任务不改结构 |

## 6. 派工模板（写 `patent_teams_create_task` 描述时照此五段）

- 目标：这条任务产出什么、给谁用（一句话）。
- 输入：captain 已产出的 manifest 阶段结果路径、案卷背景、要核的法条。
- 产出：落盘路径与文件名、必须包含的字段。
- 验收：通过标准（字段齐、来源可溯源、自检已跑）与自检工具名。
- 禁止：本条特有越界；统一附「不自行执行 manifest 阶段，受阻即上报不重试」。
