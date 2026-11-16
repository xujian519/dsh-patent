# Day 13 — 2026-11-27

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：专利域-1：patent-tools、patent-core
- 时间盒：90 分钟
- 预期产出：B 维度专利域候选发现；daily/day-13.md

## 检查项

- [x] 查找 claim/draft/rule 逻辑的重复实现。
- [x] 检查纯库与消费者包的边界渗透。
- [x] 查找死代码、未导出模块与未使用配置。
- [x] 标记文件体量与复杂度热点。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与去重（10 分钟）**：读 issue #844 的五项检查与本页原计划，对 `05-findings.md` 现有 74 条逐条核对，确认 Day 5b 已落盘 15 条与 B 相关的发现（F-PAT-003/002/004/009/012、F-DOC-003/004/005、F-VID-005/006、F-LEG-003/005、F-PAT-007/008、F-VID-003），本轮只找未记录的新条目。

**体量与热点（15 分钟）**：`find … -name '*.ts' -exec wc -l` 得 `patent-core/src` 32,629 行、`patent-tools/src` 40,539 行。两者前十：

| 包 | 文件 | 行数 | 结构判断 |
|---|---|---|---|
| core | `atoms/handlers/builtin/evidence-check.ts` | 842 | 单一职责（证据四类校验），可读 |
| core | `draft/validate.ts` | 818 | 模板/区块两类校验并置，未见重复 |
| core | `ipc/ipc-classifier.ts` | 807 | 分类表驱动，体量来自数据 |
| core | `index.ts` | 746 | 导出面，见 F-PAT-013 |
| tools | `figure/freecad-structure-script.ts` | 1233 | **940 行是内嵌 Python**，见 F-PAT-023 |
| tools | `tool/patent-workflow-run.ts` | 1028 | 工具工厂 148 行 + 10 个 `parse*` + 渲染，未拆分但每段短 |
| tools | `figure/render-check-findings.ts` | 988 | 见 F-PAT-022（内含几何原语副本） |
| tools | `figure/section-diagram.ts` / `leader-line.ts` | 918 / 908 | 绘图主流程；`leader-line` 另含几何原语 |

**死代码与未使用配置（20 分钟）**：从两包入口沿 import 图做可达性扫描，孤立模块 0 个；`patent-tools/src/config.ts` 的 37 个 `Config` 字段逐个统计读取点，全部 ≥1（默认值来自 `SHIPPED_GUIDELINE_REVISION`、`DEFAULT_WORKFLOW_STAGE_BUDGET` 等常量，非未使用配置）；入口 131 条（tools）/ 75 条（core）`export` 语句中，仓内零引用的只有 `SectionSourceError`，而它的契约就是让外部 catch `expandSectionSource` 抛出的错误，属合理公开面。**未发现可删的整模块、未导出模块或未使用配置。**

**克隆检测（15 分钟）**：`npx jscpd`（仓库 `.jscpd.json`，60 token/6 行）得 patent-tools 13 处（0.21%）、patent-core 3 处（0.08%），逐处看均为 import/类型样板。再对 `claim-chart`、`draft`、`checker`、`atoms`、`patent-rule` 五个目录降阈到 50 token/5 行：**0 exact clones，52 个文件**。检查项 ①（claim/draft/rule 重复实现）因此判「低于工具阈值」；改按同名函数跨包聚合后找到两处人工可见的重复（F-PAT-019 的读取器族、F-PAT-020 的权项号派生），都是短函数，jscpd 结构上看不到。

**边界渗透 H01（15 分钟）**：patent-core 的 5 个直接 fs I/O 模块逐个读实现——`persist-utils.ts` 已委托 `@deepseek-ai/dsh-atomic-write`；`evidence/rule-loader.ts` 只读调用方注入的 `ruleDirs`（未传则返回默认引擎 + warnings）；`ipc/ipc-standards-loader.ts` 读随包 `assets/ipc-standards.yaml`；`claim-chart/runtime/store.ts` 与 `atoms/handlers/builtin/chart-source.ts` 在调用方给定的限定根内读模型路径并按 real path 比对。结论见「假设验证」。

**兼容层甄别（15 分钟）**：`grep -rn "deprecated\|legacy\|历史\|已废弃"` 命中 12 处，逐个判定：`extract.ts` 的「无 `problem_insight` 时按索引配对的旧路径」是当前分键抽取模式的现役分支；`evidence-check.ts:530` 的 `legacyFnv1a` 只为校验既有证据并按 `legacy-hash` 转待核；`response-check.ts:49` 的 `RESPONSE_CHECK_RULE_IDS` 别名在 upgrade guide `v0.2.2-alpha.2/patent-oa-concision-channel` 有公开保留声明。三者都有当前契约，**不是可删的兼容层**。

## 发现

新增 5 条，均已含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-PAT-019 | 同一管线状态的文本读取有 4 份实现，键列表解析已漂移 | 约 35–40 行 + 2 处语义分歧 |
| F-PAT-020 | 权项号派生两包各一份，无编号时的缺省语义相反 | 约 10 行，主要收益是缺省差异显式化 |
| F-PAT-021 | `workflow/types.ts` 两处 JSDoc 指向不存在的 `./workflow-store.js` | 0 行代码，去掉 2 处失效引用 |
| F-PAT-022 | `figure/` 几何与文本度量原语重复，`orientation` 同名异义 | 约 50 行 + 1 处同名异义 |
| F-PAT-023 | `freecad-structure-script.ts` 1233 行里 940 行是内嵌 Python | TS 文件 1233 → 约 300 行 |

与既有发现的关系：F-PAT-009（`registerPatentTools` 312 行）、F-PAT-012（`as unknown` 计数）、F-PAT-013（`patent-core` 导出面过宽）、F-PAT-007（`patent-data` 历史导出面）都已在册，本轮不重复。F-PAT-007 尚有一个收尾项不另开编号：`patent-data` 对 `JsonFileStore`/`atomicWriteJson`/`assertSafeId`/`SAFE_ID_PATTERN` 与 5 个 case 路径符号的再导出已无生产消费者——`patent-filing`、`patent-workflow`、`patent-tools` 全部直接从 `@deepseek-ai/dsh-patent-core` 导入——而 `patent-data/tests/persist-utils.spec.ts`（149 行）与 `scaffold.spec.ts:25–34` 只为这些再导出服务；删除可一并减少 149 行重复用例，但要先过升级指南口径（见未决问题 3）。

## 假设验证/推翻

**H01 推翻（Day 13）**：`patent-core` 的边界成立，不需要搬迁。5 个直接 fs I/O 模块的路径全部由调用方注入、限定根、或随包资产决定；工作流执行器与两套存储实现在 `patent-workflow`，`patent-core` 只保留 `WorkflowRunStore` 等类型与纯 helper。唯一的措辞张力是 README 的 “Pure TypeScript library (no `ctx` dependency)” 与这 5 个模块并存——`no ctx` 成立，“pure” 指不依赖 harness 运行时而非不碰文件系统；建议在 H01 状态里记「推翻」，措辞张力交 F-PAT-021 一并修注释（它正是这两处失准注释的同类）。

H02、H07、H09、H10 与今日范围无交集，不更新。

## 未决问题

1. F-PAT-019 删除 `readStateText` 数组分支的前提是「无仓外写入方」；自定义灵活计划的原子是否可能向文本键写 `string[]`，需要一次配置普查（`~/.dsh` 下的 preset 与 profile 计划）才能定。
2. F-PAT-023 的 `.py` 外置依赖 `build:artifacts` 是否把非 TS 资产带进发布包；迁移前需用 `ELECTRON_RUN_AS_NODE` 探针确认 asar 内可见，否则退回生成期内联。
3. F-PAT-007 的尾项是对外可见变更：再导出已在 `docs/upgrade-guide/v0.2.2-alpha.2/` 声明为保留别名，删除需同步该指南并按 `dsh-create-upgrade-guide` 记录。

## 明日第一件事

Day 14（专利域-2：`patent-workflow`、`patent-rule`、`patent-teams`）第一件事：对照 `patent-workflow/src/workflow-store.ts:232/261` 的 `InMemoryWorkflowRunStore`/`JsonFileWorkflowRunStore` 与 `flexible-plan-store.ts:27` 的 `JsonFileStore` 包装，确认「两个存储类是否只剩记录类型不同的重复」——它们是今日 F-PAT-019 同类问题的下一个候选。
