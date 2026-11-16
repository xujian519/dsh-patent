# Day 38 — 2026-12-22

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：法律模式与共享机制
- 时间盒：90 分钟
- 预期产出：E 维度法律/共享域候选发现；daily/day-38.md

## 检查项

- [x] 检查引用解析与决策。
- [x] 检查证据评分不变量。
- [x] 检查 FTS 结果边界。
- [x] 检查共享机制。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。复现脚本 `d38-repro.mts` 放在仓库根（裸包名要从仓根 `node_modules` 解析），未跟踪，跑完已删除。

**引用解析与决策（20 分钟）**：读 `legal-law` 的 `reference.ts`、`verify.ts`、`baseline.ts`，`law-core` 的 `article-decision.ts`、`citation-extract.ts`、`continuation.ts`、`citation-text.ts`，以及 `legal-knowledge` 的 `shared/validity.ts`。逐项核对：三种引用写法归一、条/款/项窄化、续指的条→款→项顺序与继承、按条文身份去重、未识别片段的覆盖范围、六态判定与未转录/超范围/未索引的失败方向。没有新的缺陷。F-LEG-001（模块级名字表）、F-LEG-004（两域默认策略分叉）、F-LEG-010（未核验引用的处置没有锁住）仍是开放项，不在今天重复。

**证据评分不变量（25 分钟）**：读 `legal-evidence` 的 `engine.ts`、`rule-set.ts`、`evaluators/*`、`tool/evaluate-evidence.ts`。三性评分夹紧到 `[0,1]`、权重默认和为 1、综合分夹紧、摘要只统计失败的 critical 发现，这些读码确认；类型判定器的 fail-closed 方向逐条比对。发现 F-LEG-011（证人利害关系省略时关键规则报通过）与 F-LEG-012（`formLegal: false` 被忽略）。另观察到数值权重不校验范围与和，综合分被夹到 1.0；这与 F-LEG-003 的权重校验同属一处，不另开编号。

**FTS 结果边界（20 分钟）**：读 `legal-knowledge` 的 `shared/sqlite-search.ts`、`shared/memory-store.ts`、`shared/fts-search.ts`、`shared/fts.ts`、`shared/validity.ts`、`legal/search.ts`、`judicial-interpretation/search.ts`、`case-law/search.ts`，以及 `knowledge-core` 的 `result-limit.ts`。核对 NUL 清洗、`resolveResultLimit` 的整数夹取、FTS→LIKE 阶梯与粘性降级、`fetchFactor` 的超取、效力后过滤、`findRow`/`findRowsLike` 的失败路径。发现 F-LEG-013（先取 2 倍上限再按效力过滤，SQLite 与内存后端结果不同）。`limit` 为 0 或负数的入口已在 R-88 关闭，今天没有新增。

**共享机制（15 分钟）**：读 `law-core` 的 `citation-text.ts`、`continuation.ts`、`text-overlap.ts`、`article-decision.ts`，`knowledge-core` 的 `result-limit.ts`、`validity.ts`、`fts.ts`、`fts-search.ts`、`real-path.ts`、`install-fs.ts`。两个域共用同一份引用文本处理、续指、重合度与条号判定；共享原语各只有一个实现，没有发现新的漂移。发现 F-LEG-014（默认判定日期取 UTC）。H02 的结论不变：原语层完整，分叉在引擎骨架层。

**命令**：`pnpm exec tsx d38-repro.mts` 退出码 0。决定性结果：省略 `witnessHasConflict` 时 `LEGAL-EVI-007` 为 `passed: true`、理由「证人与案件无利害关系」；`formLegal: false` 与省略的合法性评分相同（电子数据 0.85、证人证言 0.80），`true` 为 1.00；三条同名法规中前两条失效时，`findByName(..., 1)` 在 SQLite 返回 `[]`、在内存返回 `['reg-3']`；固定时钟 `2026-12-21T19:00:00Z` 下 `todayIsoDate()` 为 `2026-12-21`，`Asia/Shanghai` 为 `2026-12-22`。

## 发现

F-LEG-011、F-LEG-012、F-LEG-013、F-LEG-014。

下面这些不够格单列：

1. `legal-evidence` 的数值权重不校验范围与和：YAML 写 `relevance/legality/authenticity: 0.5` 时没有警告，三性 0.9/1.0/1.0 的综合分被夹成 1.0。这与 F-LEG-003（非数值权重静默回落）同属权重校验，不另开编号。
2. F-LEG-001 的模块级名字表、F-LEG-002 的 YAML 通用规则不参与判定、F-LEG-010 的未核验引用处置，仍是已登记的开放项；今天只读复核，没有新证据。
3. `SqliteFtsTable.findRow`/`findRowsLike` 在查询失败时返回 `undefined`/`[]` 并写 warning；部署没注入 logger 时，查询失败与「没有该行」在调用方看来相同。该路径依赖部署注入日志，作为观察记录。
4. `legal-knowledge` 的 `legalSearch` 空结果摘要写「本部署的知识库未命中」，对 F-LEG-013 的召回窗口也适用；修复 F-LEG-013 时一并调整摘要措辞更准确。

## 假设验证/推翻

H01–H10 今日不改。H02 维持 Day 5b/15/17 的结论：引用文本、续指、重合度、条号判定与效力判定都是单一实现，今天发现的是引擎层的召回顺序与默认时区，不是共享原语漂移。H05 没有新的外部输入到危险汇点证据。H07 仍是 Day 7 的部分推翻；F-LEG-011 是同一失败方向的新实例（未知的利害关系被写成「无利害关系」通过），不改变结论。H06、H08、H09 维持原结论；今天没有重跑覆盖率或测试套件。H10 没有新增证据；`model-call-log.ts` 未改。

## 未决问题

1. `formLegal: false` 应沿用通用判定器的 −0.15，还是给电子数据/证人证言各定一档？这需要法律域的口径确认。
2. 效力过滤应做成「凑满 `limit` 条可见记录」的完整召回，还是保留有界超取并在文档里声明 best-effort？前者更准，后者延迟更可控。
3. 默认判定日期应固定 `Asia/Shanghai`，还是由部署配置 `timeZone`（与 patent-deadline 同形）？两者都能修 F-LEG-014，后者更灵活。

## 明日第一件事

Day 39（E 正确性与边界：视频模式全域，`video-mode`、`video-bundle`、`ui-video-studio`）第一件事：检查 EDL/ffmpeg 参数边界、provider 失败与重试、预算账本与任务 journal 的一致性、界面渲染失败，并附证据。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-014、F-CROSS-003、F-VID-001 至 F-VID-010 不要重测。不要启动真实 ffmpeg 或云 provider。H09 的旧数字不要改。
