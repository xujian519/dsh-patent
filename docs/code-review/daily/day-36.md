# Day 36 — 2026-12-20

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：专利域-3：patent-knowledge、patent-data、patent-law、patent-fees、patent-deadline
- 时间盒：90 分钟
- 预期产出：E 维度专利域候选发现；daily/day-36.md

## 检查项

- [x] 检查索引读取边界。
- [x] 检查期限与费用算术。
- [x] 检查引用决策。
- [x] 检查未核验语义。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-050、F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。复现脚本 `d36-repro.mts` 放在仓库根（裸包名要从仓根 `node_modules` 解析，放 `/tmp` 解析不到），未跟踪，跑完已删除。

**索引读取边界（20 分钟）**：`openKnowledgeDb` 的 `application_id`、`user_version` 与真源／派生语义同注释一致：真源版本不符抛 `KnowledgeDbVersionError`，派生旧版本返回 `needsRebuild`，存量 0 在写路径补戳、读路径宽容；`KnowledgeFtsSearchBase` 只读打开，先看 `docs_fts` 表再看运行时是否编译 FTS5，构造期 prepare 失败与查询期异常都粘性降级 LIKE；`CaseLawSearchEngine`、`KnowledgeLawSearch` 与 `KgStore` 的条数都经 `resolveResultLimit`，判例的前缀路径只在 `documents.search_prefix` 存在时启用，缺列回退整表；`AsyncResultCache` 只缓存成功结果，失败与零命中不入缓存，TTL 与 in-flight 合并语义正确。CNIPR 收据按号对齐、丢弃行报成 `page_state`，没有把残缺结果当完整命中集。新发现只有 mapper 输入边界的一条（F-PAT-055）。`VECTORS_DB` 与 `treatZeroAsStale` 在包内没有调用方，属于对外导出的能力，不单列。

**期限与费用算术（25 分钟）**：`addCalendarMonths` 的月末夹取与 `periodEnd` 的「首日不计」逐例复跑：`1999-12-31 + 2 个月` 为 `2000-02-29`，`2024-01-31 + 1 个月` 为 `2024-02-29`，`2024-02-29 + 1 年` 为 `2025-02-28`；邮寄推定收到日为发文日 +15 日且不顺延，电子送达按进入日或发文日起算，公告送达为公告日 +1 个月。`rollForward({2026,1,1})` 给出 `2026-01-04`，用的是 2026 年元旦调休工作日；未覆盖年份保留原始届满日并挂 `calendarCaveat`。年费届日按 `addCalendarMonths(filing, (year-1)*12)`，补缴窗口从顺延后的届满日起 6 个月再按同一规则顺延；`patentYearOf` 用周年日比对处理 2 月 29 日与月末夹取。费用的分单位整数运算、年费档位、减缴与滞纳金窗口读码确认；发现集中在多年度 `lateMonths`（F-PAT-053）与 `designatedMonths` 越过法定期间（F-PAT-054）。没有跑期限或费用的测试套件。

**引用决策（20 分钟）**：`reference.ts` 的三种文法（法条、指南节、`A22.3`）、`parseLawReference` 的整串判定与 `scanUnrecognizedCitations` 的未识别片段读码确认；`verifyCitation` 的六态与 `DEFAULT_CITATION_POLICY` 一致，`not-indexed` 与 `unverified` 不会静默通过；指南节由本节与子节共同判定，过期版本与未知版本分开。沿革路径与指南版本视图各发现一条：沿革快照按条号跨法套用（F-PAT-051），指南未修改节在 citator 与 verifier 之间结论相反（F-PAT-052）。`rule_lock_as_of` 被接收并转给 `queryValidity`，但四态判定不读它；`ValidityQuery.asOf` 已注明「reserved for future time-aware repeal checks」，`tests/rule-lock.spec.ts:148` 也把当前行为固定成「不影响判定」，因此不单列。

**未核验语义（15 分钟）**：`law_verify` 对已索引但未转录的条目返回 `unverified`；`rule_lock` 的 `unverified` 列表只收该状态；费用的 `complete` 只在每条适用行已核验、没有 pending、没有未收录阶段时为真，零数量行不扣合计；期限的节假日未覆盖年保留原始届满日并单独点名。失败方向的问题集中在 F-PAT-052（同一引用的已修订／已核验相反）与 F-PAT-053（带虚构滞纳金的 `complete` 合计）。

**命令**：`pnpm exec tsx d36-repro.mts` 退出码 0。决定性结果：`专利法实施细则第5条` 的 `effectiveDate` 为 `2021-06-01`（取自专利法第 5 条沿革）；`审查指南第二部分第四章3.2.1.1` 的 `queryValidity` 为 `revised`、`verifyCitation` 为 `valid`；指南 1241 节判 `revised`，其中 1069 节带已转录正文；年费 `[4,5]` 加 `lateMonths: 3` 产出两条 180.00 滞纳金与 `complete: true`；驳回决定加 `designatedMonths: 1` 的复审条目标签写 3 个月、届满日为 `2026-02-05`；`inventor_name: '[null]'` 使 `mapPatentData` 抛 `TypeError`。另用 `pnpm exec tsx -e` 核对月末夹取、15 日推定与 2026-01-01 顺延，退出码 0。

## 发现

F-PAT-051、F-PAT-052、F-PAT-053、F-PAT-054、F-PAT-055。

下面这些不够格单列：

1. `rule_lock_as_of` 与 `ValidityQuery.asOf` 是已声明的预留字段，类型注释与 `tests/rule-lock.spec.ts:148` 都把「不影响当前判定」固定成预期行为；对外原子说明没有写明这一点，属于文档漂移，不另开编号。
2. `VECTORS_DB` 与 `openKnowledgeDb` 的 `treatZeroAsStale` 在 `patent-knowledge` 内没有调用方，注释里的「中断构建的 vectors.db 不能静默当空库读」只有直接消费导出 API 的调用方才会走到。
3. `report.ts:157`–`:160` 的 `else if (excluded.length > 0)` 在有其他可恢复逾期项时不会单独打印一句，但同一段总述已写明专利权期限与优先权期限不适用恢复，信息没有丢，不单列。
4. `AsyncResultCache` 的 `maxEntries: 0` 或负数按容量 1 运行，`ttlMs` 为负则永不命中；这些选项来自包内调用方，不是插件配置，按同一进程的静态接口不单列。
5. `patent-law` 的 `rule-lock` 报告把 `revised` 一律渲染成「⚠️已失效」，对「已修订」本身措辞过强；这一点并入 F-PAT-052 的修复建议，不另开编号。

## 假设验证/推翻

H01–H10 今日不改。H07 仍是 Day 7 的部分推翻：F-PAT-052 是同一失败方向的另一面——2023 年文本的指南节在 `law_verify` 里读作已核验、在 citator 里读作已修订，不改变 H07 的结论。H05 今天没有新的外部输入到危险汇点证据；F-PAT-055 是上游数据边界的类型错误，不是汇点。H06 维持 Day 33 的部分推翻。H10 今天没有新增证据；`model-call-log.ts` 未改。H09 的旧数字维持 Day 19 的写法。

## 未决问题

1. 指南未修改节应以 `law_verify` 的「已核验」还是 citator 的「已修订」为准，需要产品决定；F-PAT-052 的最小修复两个方向都写了。
2. 没有真实的 nuo 上游数据证明 JSON 字符串会出现 null 元素；F-PAT-055 只有边界复现，没有线上失败样本。
3. 五个包的测试套件没有重跑；结论只覆盖脚本里的输入与随包资产。

## 明日第一件事

Day 37（E 正确性与边界：专利域-4 与文档模式，`patent-document`、`patent-filing`、document 全域）第一件事：检查渲染与立案的内容边界、文档转换的失败分类、模板变量与限额，并附证据。F-PAT-032 至 F-PAT-055 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 和 Chrome。H09 的旧数字不要改。
