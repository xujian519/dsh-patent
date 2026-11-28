# 专利域第二轮审阅：质量复检与精简专项（12-patent-r2）

本目录是专利域第二轮审阅的执行计划。第一轮 [11-patent](../11-patent/README.md) 于 2026-11-28 收口：564 个文件全部签收，100 条发现中 66 条已修、32 条未修（其中 2 条为误报回退），无未修 P1。本轮不重读已签收且内容未变的文件，只重审漂移文件与未覆盖维度，并把「精简」从附带结论提升为独立主线。

## 与第一轮的关系

| 已有资产 | 本轮用法 |
|---|---|
| [00-coverage.tsv](../11-patent/00-coverage.tsv)（564 行，全 signed，带 `blob_sha`） | 作为可达性基线；按 `blob_sha` 漂移决定重审范围 |
| [01-findings.md](../11-patent/01-findings.md)（F-PAT-001..158） | 待决策项进入 B1 闭环轨道，新发现另起 S-PAT 编号 |
| [03-decisions.md](../11-patent/03-decisions.md)（A/B/C/D 四类卡点，32 条） | 按卡点归并后批量决策 |
| 45 天计划 B 维度（Day 13–19） | 复用其结构复用与死代码结论，不重跑同口径扫描 |

第一轮台账存在计数不一致：`README` 记「69 已修、31 待决策」，`04-retro` 记「65 已修、32 待决策、3 误报」。B0 按 `01-findings.md` 逐条状态对账，权威口径为 66 已修、32 未修、2 误报，结果写 `02-batches/B0.md`。

## 已确认的三项决策

| 事项 | 决策 |
|---|---|
| 范围 | 专利域 18 包 + 接线：`packages/patent/` 16 包、`ui-patent-teams`、`ui-brand-patent`，以及 preset、`cordis.patch.yml`、包清单、tsconfig、realm、skill 注册、`tool-catalog`、`module-graph` |
| 处置权限 | L0 机械清理直接实施；L1 行为保持重构与 L2 能力相关改动先出报告，确认后实施 |
| 第一轮遗留 | 32 条未修项纳入本轮，在 B1 集中闭环 |

改动留在工作区，不提交、不推送。

## 范围

范围内：`packages/patent/` 16 包（549 个 `src` 文件、120,364 行；469 个测试文件、121,584 行）、`packages/client/ui-patent-teams`（20 个 `src` 文件）、`packages/client/ui-brand-patent`（6 个 `src` 文件），以及它们的接线配置。

边界只读：`law-core`、`knowledge-core`、`legal-*` 只核依赖方向与共享原语归属，修改另立范围。

范围外：`apps/cli`、`apps/web`、`apps/desktop` 的入口与渲染路径；`benchmarks/`（无专利用例）；需要 `DEEPSEEK_API_KEY` 的真实 API 端到端评测。

## 两条主线与一条专项

**A. 质量复检**沿用第一轮 P0–P3 定级，覆盖正确性与边界、契约一致性、依赖与接线、资源与生命周期、测试有效性、模型可见契约。

**B. 精简审阅**按 [dsh-find-simplifications](../../../.agents/skills/dsh-find-simplifications/SKILL.md) 方法执行，分七类：重复实现、过度抽象与单消费者间接层、投机性配置与无读者字段、冗余状态与可推导缓存、测试与 fixture 冗余、文档复述、未被任何入口消费的能力面。

**C. 死代码与孤岛专项**按约束执行：不凭「没有引用」判死，先穷举可达性入口，再给证据链、根因与三种处置建议，能力相关删除一律等确认。

可达性入口必须覆盖：`package.json` exports、tsdown 入口、`cordis.yml` 与 preset 的插件名、插件 Loader 动态解析、tool registry、skill 注册、realm manifest、动态 import、字符串引用、随包数据资产。

## 能力基线

B0 生成「能力基线快照」，之后每批改动后对比，差异必须为空或已书面批准。快照包含：

- 工具名称、描述与参数 schema 的哈希
- 每个包的公开导出名集合
- 服务名与消费者清单
- preset 插件行
- `test:snapshot -t patent` 的场景清单与输出哈希
- locale 字典 key 集合
- 会话事件判别符与持久化字段
- 重新生成的 `docs/tool-catalog.md` 与 `docs/module-graph.md` 差异

## 阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 基线 | 刷新台账 `blob_sha` 与漂移表；生成能力基线快照；复跑第一轮四条验收门禁并记录退出码；对账 31/32 | `02-batches/B0.md` |
| P1 遗留闭环 | 32 条按 A/B/C/D 卡点归并；可独立实施项进批次；产品口径项批量征询 | `03-decisions.md` |
| P2 精简普查 | 机械扫描（jscpd、跨仓未引用导出、Config 字段读取率、`v8 ignore` 与 `skip` 清单、入口可达性）加每包定向抽样 | 精简候选清单 |
| P3 质量复检 | 只精读漂移文件；对台账中「代理评审（结论已复核）」档按风险抽检不少于 20%，回源核验 | 新发现 |
| P4 分级处置 | L0 直接实施；L1 出清单后实施；L2 逐条确认后实施 | 批次记录与改动 |
| P5 收口 | 全量门禁加能力基线 diff 审核；文档、目录、快照同步 | `04-retro.md` |

## 批次

| 批次 | 范围 | `src` 文件 | 主维度 |
|---|---|---|---|
| B0 | 基线与台账 | 575（全量登记） | 机械 |
| B1 | 第一轮 32 条遗留加结构性依赖（F-PAT-079、F-PAT-122） | — | 决策与架构 |
| B2 | 纯库叶子：methodology、patent-index-asset、writing-patterns、patent-fees、patent-deadline | 37 | 精简与质量 |
| B3 | patent-core 权项、检查、证据 | 59 | 质量与精简 |
| B4 | patent-core atoms 与 handlers | 60 | 精简 |
| B5 | patent-core 其余（ModelPort、workflow、graph、persist） | 54 | 质量 |
| B6 | 服务接缝：patent-data、patent-knowledge | 43 | 质量 |
| B7 | 服务接缝：patent-workflow、patent-teams | 37 | 质量与精简 |
| B8 | 服务接缝：patent-rule、patent-law | 37 | 质量 |
| B9 | patent-tools 检索与数据 | 42 | 质量 |
| B10 | patent-tools 撰写与校核 | 21 | 质量 |
| B11 | patent-tools 分析与附图 | 60 | 质量与精简 |
| B12 | patent-tools 工作流与评审 | 48 | 质量 |
| B13 | 交付链：patent-document、patent-filing、tool-literature | 51 | 精简 |
| B14 | UI 两包、接线与收口 | 26 | 质量与接线 |

批次按依赖方向自叶子向根部推进；`src` 文件数为 2026-11-28 实测，B0 以刷新后的台账为准。

## 处置分级

| 级别 | 定义 | 是否需确认 |
|---|---|---|
| L0 机械 | 私有未用符号、重复常量、类型或测试可证明不可达的死分支 | 直接实施 |
| L1 行为保持 | 重复实现收敛到已存在的共享原语、内部抽象合并 | 先出清单，确认后实施 |
| L2 能力相关 | 公开导出、配置键、工具名、事件判别符、持久化字段、未接线功能、仅测试使用的导出、数据资产 | 逐条确认，附「删除会失去什么」 |

红线：不新增 `v8 ignore`、`skip`、`@ts-expect-error`、`any` 或 unknown cast；除有等价行为证据外不删除测试；删除提案与缺陷修复不混批。

## 候选记录模板

每条候选记录以下字段：ID（S-PAT-xxx）、位置（`file:line`）、类别、证据链（定义到引用到消费者，附命令与行号）、根因分类、删除后失去的能力、保留成本、三选一建议（删除、接线、保留）、风险级别、决策人。

死代码根因分为六类：①设计预留未接线；②接线遗漏，属缺陷；③被替代的兼容层；④测试专用导出；⑤对外扩展点；⑥生成资产或数据文件。

## 门禁矩阵

每批执行：

- 包级：`vitest run` 与覆盖率（`src` 逐文件 100%）
- 类型：`tsc -b`
- 静态：`lint`、`verify-export-jsdoc`、`verify-no-unknown-casts`、`verify-empty-catch`、`verify-no-shared-primitive-redefs`、`verify-published-imports`、`verify-patent-rule-alignment`、`scripts/oxlint-contract.spec.ts`、`scripts/duplication-gate.spec.ts`（后三项只在 fork CI 跑，B7 起纳入每批）
- 接线：`verify-cordis-config`、`verify-agent-preset-config`、`verify-preset-tool-refs`、`verify-preset-mode-baseline`、`verify-module-graph`
- 行为：`patent-preset-mount.spec`、`test:snapshot -t patent`、`test:docs`
- 收口：`build:artifacts` 后 `build:check`，并比对能力基线快照

## 交付物

`README.md`（本文件）、`00-coverage.tsv`（复用第一轮台账并加漂移列）、`01-findings.md`（S-PAT 编号）、`02-batches/B0–B14.md`、`03-decisions.md`、`04-retro.md`。

## 当前状态

- 2026-11-28：计划定稿，三项决策已确认。
- B0 完成：台账对账为 66 已修、32 未修、2 误报；发现 69 个文件第一轮签字后内容变更、9 个文件未收录，刷新后的台账 573 行、78 条待重审；能力基线已生成（64 个工具签名、1,431 个导出、7 个服务、14 个会话事件、43 行 preset、11 个快照场景）。
- B1 完成：32 条遗留逐条处置并取得四组口径；本轮实施 20 条，维持 4 条，仍需外部证据 6 条。F-PAT-122 已下沉重构到 `patent-core`，`patent-teams` 不再依赖 `patent-tools`（记录见 [02-batches/B1.md](02-batches/B1.md)）。下一步按 B2–B14 推进。
- B2 完成：五个库叶子包 37 个 `src` 文件。F-PAT-121 的 `limit` 部分与 F-PAT-136①③ 落地；两处 L0 精简（期限条目 id 常量、年费档位取价去重）加一处已确认的 L1（期限包 `Config` 默认值收敛到 schemastery 一处）；精简普查 7 个候选全部处置：3 个公开导出与 `asset-location` 维持现状（记录理由），其余见 [02-batches/B2.md](02-batches/B2.md)。下一步按 B3 推进。
- B3 完成：patent-core 权项、检查与证据共 59 个 `src` 文件。F-PAT-072、F-PAT-088 已落地，四组 L0 清理未改变包入口能力；用户授权后，新增 10 项 P2、3 项 P3（S-PAT-001…013）已全部修复并补回归，4 项 L1 精简（S-PAT-B3-1…4）已实施，3 项 L2（S-PAT-B3-5/6/7）保留待接线。范围覆盖率为 100%，11 个专利快照无差异（4 个 chain 场景因证据哈希格式刷新 contentHash），其余实测门禁见 [02-batches/B3.md](02-batches/B3.md)。下一步按 B4 推进。
- B4 完成：patent-core atoms 与 handlers 实测 38 个 `src` 文件（README 计划记 60，台账把 atoms 标为 B3，口径差异记在 [02-batches/B4.md](02-batches/B4.md)）。审阅未确认新缺陷；4 项 L1 精简已实施：`atoms/index.ts` 的 114 个 builtin 再导出收窄到 16 个，builtin barrel 的 123 个导出收窄到 75 个，`toIsoDate` 与 `findMalformedKey` 两处重复实现各合并为一处。atoms 与 `evidence/date.ts` 覆盖率为 100%（四个包 5,333 个用例），其余门禁见 [02-batches/B4.md](02-batches/B4.md)。下一步按 B5 推进。
- B5 完成：patent-core 图、工作流与根级设施实测 54 个 `src` 文件。新增并修复 5 条缺陷（S-PAT-014…018，1 项 P2、4 项 P3）：`llmNode` 取消穿透、已中止信号的子进程计时器误报、草稿质量折叠的 `null` 守卫、阶段输出兜底读取的类型校验、`safe-path` 文案；L1（`compileSignal` 收敛）同步落地，L2 保留未接线能力与仅测试导出。汇总见 [01-findings.md](01-findings.md) 与 [02-batches/B5.md](02-batches/B5.md)。B5 范围内全部 `src` 文件覆盖率为 100%（六个包 5,737 个用例），其余门禁见 B5 记录。下一步按 B6 推进。
- B6 完成：patent-data 与 patent-knowledge 实测 43 个 `src` 文件（14 + 29，与计划一致）。新增并修复 4 条 P3 缺陷（S-PAT-019…022）：重试等待不响应「进入等待前已中止」的信号、节点缓存配置约束后移到首次查询、wiki 目录缺失时静默返回 0 命中、安装期同表迭代更新。L0 三处（`install.ts` 重复 JSDoc 与文案空格、`cnipr-receipt.ts` 模块注释位置）。L2 三项按「保留未接线能力」处置，另列七项已排除候选。范围覆盖率为 100%（三个包 168 个测试文件、2,946 个用例），11 个专利快照无差异，其余门禁见 [02-batches/B6.md](02-batches/B6.md)。下一步按 B7 推进。
- 2026-11-29 修复 fork CI 的两处红灯（均由 B3 的同一次推送引入，本地门禁矩阵当时未覆盖这两个步骤）：`unity.spec.ts` 恢复被删的对齐锚点测试，`rule-procedure-alignment.yaml` 的 `unity-division` 测试引用重新成立；`oxlint-contract.spec.ts` 的 staged 用例改为断言「未使用指令静默」，与随 B3 落地的 lint 配置（关闭 `reportUnusedDisableDirectives`）一致。两条门禁已加入每批矩阵。
- 2026-11-29 修复第三处红灯：B6 的 `install.ts` 改动（压缩窗口化、同文件守卫文案去掉多余空格）让 `patent-knowledge/src/install.ts` 与 `legal-knowledge/src/install.ts` 的同文件守卫区间成为 14 行 / 40 token 的跨域克隆，`duplication-gate.spec.ts` 报 `crossDomainPairs` added。按基线既有约定（legal↔patent 同源实现已登记 12 对）把该对登记进 `scripts/duplication-baseline.json`。本地核对方法：`git archive HEAD packages/patent packages/legal packages/document .jscpd.json` 到临时目录后按门禁参数跑 jscpd——macOS 的 darwin-arm64 原生 jscpd 与 Linux CI 对**同域**克隆的判定不同（`llm-json|flexible-plan`、`task-ops` 自配对、`citator|verify` 三处），与本分支无关，不要据本地结果改基线。
- B7 完成：patent-workflow 与 patent-teams 实测 37 个 `src` 文件（17 + 20，与计划一致）。新增并修复 9 条 P3（S-PAT-023…031）：`fromJSON` 持久化校验、`claim_task` 文案、门禁打回残留、改派期更新守卫、调度回滚成员状态、孤儿成员 retire 告警、提前收尾的 `completed` 语义，以及两处 README 数字漂移；L0 两处孤立 JSDoc。F-PAT-118 未修的续跑材料、executor 取消信号、并行组取消、`verify()` 生产路径与全局原子注册，以及 F-PAT-119 的缺失 attemptId 兼容，均记录保留理由。`patent_teams_claim_task` 的描述变更已登记为能力基线已批准差异。范围覆盖率 100%（两个包 47 个测试文件、692 个用例），11 个专利快照无差异，其余门禁见 [02-batches/B7.md](02-batches/B7.md)。下一步按 B8 推进。
- B8 完成：patent-rule 与 patent-law 实测 37 个 `src` 文件（24 + 13，与计划一致；另抽出 1 个私有 `guideline-view.ts`）。新增并修复 3 条 P3（S-PAT-032…034）：`citationGate` 文档的四部法、沿革快照的修订 id/日期顺序校验、`rule_lock_as_of` 不再作为原子输入；L0 三处孤立/重复 JSDoc；L1 把 `verify` 与 `citator` 的指南版本合并收敛到 `guideline-view.ts`。`DEFAULT_RULE_LOCK_AS_OF_KEY` 与 `lockProvisions` 的 `asOf` 参数保留为公开保留面并写明未用。范围覆盖率 100%（两个包 42 个测试文件、914 个用例），11 个专利快照无差异，其余门禁见 [02-batches/B8.md](02-batches/B8.md)。下一步按 B9 推进。
- B9 完成：patent-tools 检索与数据实测 43 个 `src` 文件（41 个第一轮 B4 文件 + 2 个新 PDF 模块；`internal/slop-engine.ts` 已在 B3 迁往 `patent-core`，计划记 42 的口径差异记入批次记录）。新增并修复 6 条（S-PAT-035…040，1 项 P2、5 项 P3）：留档条目的换行/分隔符注入、PDF 兜底取消穿透、兜底重试预算、兜底告警顺序、非中国号咨询 CNIPR、非 Error 抛值渲染；L1 把 `patent_wiki_search` 的限额归一收敛到共享 `resolveResultLimit`。`MANIFEST.sha1` 作为无读者持久化字段保留待收口决策。范围覆盖率 100%（133 个测试文件、2,522 个用例），11 个专利快照仅 request header 的工具描述随 `matter_log_append` 更新，其余门禁见 [02-batches/B9.md](02-batches/B9.md)。下一步按 B10 推进。
- B10 完成：patent-tools 撰写与校核实测 21 个 `src` 文件（与计划一致），3 个漂移文件重读。新增并修复 7 条（S-PAT-041…047，1 项 P2、6 项 P3）：空白必填名称被当成完整草案、摘要方案编号误报、实施例标题重复、无交底原文时假缺口、重复章节标题漏报、风险比例越界的裸 `RangeError`、实用新型草案措辞；第一轮 F-PAT-086（裸「标准」引证）与 F-PAT-087（SMILES 列入 `not_assessed`）同批落地。`validate_specification` 的描述变化已登记为能力基线已批准差异。范围覆盖率 100%（133 个测试文件、2,532 个用例），11 个专利快照全部通过，其余门禁见 [02-batches/B10.md](02-batches/B10.md)。下一步按 B11 推进。
