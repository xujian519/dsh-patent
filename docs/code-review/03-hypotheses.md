# 本轮审查假设

以下 10 条假设来自 Day 1 的结构地图与基线，不是结论。每条都写“依据、验证方式、可能落点、状态”；后续每日审阅用于验证或推翻。

| ID | 假设 | 依据 | 验证方式 | 维度 | 状态 |
|---|---|---|---|---|---|
| H01 | 专利域的纯库与工具层边界正在渗透，`patent-core` 承担了本应属于消费者包的业务编排 | `patent-core` 约 3.26 万行、`patent-tools` 约 4.05 万行；`patent-core/src` 同时包含 atoms、workflow、persist-utils、pdf-download | Day 2 与 Day 13 抽样调用链，检查 `patent-core` 是否直接读写文件、网络或会话 | B | 推翻（Day 13）：5 个 fs I/O 模块的路径均由调用方注入、限定根或随包资产决定，执行器与两套存储在 `patent-workflow`，core 只留类型与纯 helper，不搬迁；README 的 “pure” 与 fs I/O 并存的措辞张力归 F-PAT-021 同类注释修复 |
| H02 | 法律与专利共享机制存在为单域特化的分支，`law-core`/`knowledge-core` 的“域中立”不完整 | 两域保留各自语法、索引与工具名；共享层被两域直接消费 | Day 10 与 Day 17 对照两域调用点，查找条件分支与重复实现 | B | 确认（Day 5b）：决策层共用同一 `decideArticleCitation`，调用路径分叉；检索骨架层两域各一份 SQLite 基类，`knowledge-core` 只共享阶梯函数。Day 15 补内部证据：专利域两引擎已共用 `patent-knowledge/src/shared/knowledge-fts.ts:27` 的 `KnowledgeFtsSearchBase`，分叉点下移到结果整理（`backfillContent` 近克隆、`dedupeByDocument` 语义不同，见 F-PAT-030）。Day 17 结论：原语层完整（`knowledge-core` 十个跨域原语各有 5–13 个消费者，两域效力/可见性/日期/FTS 阶梯同一实现），不完整在引擎骨架层且两者抽象方向相反（法律域 `SqliteBackedEngine` 数据驱动、专利域 `KnowledgeFtsSearchBase` 抽象模板），合并属架构决策，F-PAT-030 与 F-LEG-004 不合并成跨域一条 |
| H03 | 文档域的 Office 转换在异常路径上可能泄漏子进程或临时文件 | `office-kit` 有 `queue.ts`、`scratch.ts`、`outputs.ts`；LibreOffice 为外部进程 | Day 9 与 Day 23 读取消、超时、失败路径的清理逻辑 | A/C | 定向未证实（Day 4）：office-kit 有队列/缓存/scratch/dispose；Day 9/23 验取消与异常 |
| H04 | 视频域的 provider 失败或重试可能造成重复计费或账本与项目文档不一致 | `video-mode` 有预算账本、任务 journal、`lock.ts`、多个云 provider | Day 11 与 Day 39 追提交、轮询、结算、取消路径 | A/E | 实现正确但威胁模型不成立（Day 11）：预算检查、幂等账本与 `max()` 都在，但 `budget.json` 位于模型可写的工作区且无完整性校验（F-VID-007）；跨进程冲突待 Day 39。Day 18 补实现层复核：`appendLedgerEntry` 按 `taskId` 去重、`ledgerCost` 按分累加、预算取 `max(projectCost, ledgerCost)`，重复结算会被吞掉，判定不变；今日新增的只是写路径骨架重复（F-VID-010） |
| H05 | 外部输入可以到达危险汇点：专利检索的 CNIPR/ego-browser 脚本、视频的 ffmpeg filter graph、文档的模板替换 | `patent-data` 有 `cnipr-script.ts`、`subprocess-runner.ts`；`video-mode` 有 `edl.ts`；`doc-template` 有变量替换 | Day 6—11 逐个检查 argv/env/URL/路径构造是否有边界校验 | A | 部分确认（Day 6）：脚本注入面已正确处理（JSON.stringify 嵌入、stdin、argv 数组、直链主机与响应 URL 约束）；未处理的是输出目录包含性（F-PAT-014）与临时文件独占创建（F-PAT-015） |
| H06 | 测试缺口集中在 provider 与 CLI 边界，而不是纯库 | `patent-data` 13 个测试文件/2.3k 行、`document-deliver` 2/1.8k、`tool-office` 2/0.7k、`ui-video-studio` 4/1.4k | Day 27—33 按高风险表面列未测分支，区分“完全未测/断言太弱/只覆盖 happy path” | D | 待验证 |
| H07 | “未核验”降级可能被上层当作通过 | `legal-law` 在缺语料时报告“未核验”；`patent-law` 有同类语义 | Day 10 与 Day 38 追工具返回值到提示词与交付门禁 | E | 部分推翻（Day 7）：渲染路径的交付门禁对 `not-indexed`/`unverified`/`out-of-range`/`mismatch` 全部阻断，比工具默认策略更严；缺口在立案构建路径未接引用门禁（F-PAT-017）。Day 4 的 legal-evidence 结论与 F-LEG-002 仍成立 |
| H08 | 每文件 100% 覆盖率门禁可能被豁免清单掩盖了四域的关键路径 | `vitest.config.ts` 有平台排除与重套件豁免；`coverage-exempt.ts` 维护成员 | Day 33 审计豁免清单与四域未覆盖文件 | D | 待验证 |
| H09 | 四个 preset 手工列包，新增或改名包时组合层会漂移 | 四个 preset 逐项列出 `@deepseek-ai/dsh-*`；现有门禁只覆盖部分引用 | Day 4 与 Day 19 对照包清单、preset 与门禁覆盖 | B/E | 推翻（Day 19）：数量与门禁覆盖两处前提都不成立。preset 实为 8 个（`web-app` 7 个 + `video-bundle` 1 个）、199 行插件、56 个不同包，共享核心 26 个包确实靠逐字复制，但已有四道门禁（`verify-agent-preset-config`、`verify-preset-tool-refs`、`verify-preset-divergence` 的块哈希基线、`verify-preset-mode-baseline` 的 authority/`explainedAbsences`）加运行时闭包与默认产品隔离，覆盖了分叉、缺失行、配置不匹配与工具名不存在。残留缺口是相反方向——仓库有包、8 个 preset 全无——门禁比较的是 preset 之间，该方向不可机械判定，只作为发布检查项 |
| H10 | 模型可见输入可能没有全部落到会话日志，尤其是外部 provider 的原始响应与视频任务 journal | 仓库规则要求“模型可见 ⟺ logged”；`patent-workflow` 有 `model-call-log.ts`，`video-mode` 有 journal | Day 11 与 Day 40 追 provider 响应到会话事件的映射 | E | 确认缺口（Day 5b）：`patent/model-call` 在流异常时不落事件（F-PAT-010），视频 journal 可跨进程丢失（F-VID-001）；provider 原始响应待 Day 11/40。Day 18 复核：`lock.ts` 的 `withKeyLock` 只做进程内串行、文件系统层无独占创建或 CAS，缺口仍成立 |

## 使用方式

- Day 1 只建立假设，不判定真假。
- 每日记录只写“验证/推翻/仍待定”，并链接 `daily/` 与 [05-findings.md](05-findings.md) 的证据。
- 周期结束时统计命中率与误报率，写入 [08-retrospective.md](08-retrospective.md)。
