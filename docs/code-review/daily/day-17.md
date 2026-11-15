# Day 17 — 2026-12-01

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：法律模式与共享机制全域（`legal-evidence`、`legal-knowledge`、`legal-law`、`knowledge-core`、`law-core`）
- 时间盒：90 分钟
- 预期产出：B 维度法律/共享域候选发现；daily/day-17.md

## 检查项

- [x] 对照 legal 三包与 law 两包的重复。
- [x] 检查 law-core/knowledge-core 的共享边界。
- [x] 检查规则、索引与工具注册的重复。
- [x] 查找可删除的兼容层。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与体量（10 分钟）**：`find … -name '*.ts' -exec wc -l` 得 `legal-evidence/src` 12 文件 1727 行、`legal-knowledge/src` 16 文件 2305 行、`legal-law/src` 8 文件 1482 行、`knowledge-core/src` 8 文件 442 行、`law-core/src` 8 文件 1589 行，合计 52 文件 7545 行。域内没有 Day 13 那种单文件超 700 行的热点，前十为 `legal-law/src/baseline.ts` 444、`law-core/src/article-decision.ts` 422、`law-core/src/citation-tool.ts` 381、`legal-knowledge/src/shared/sqlite-search.ts` 368、`judicial-interpretation/search.ts` 289、`legal-evidence/src/tool/evaluate-evidence.ts` 266、`legal-knowledge/src/tool/search.ts` 252、`legal-law/src/reference.ts` 247、`legal-law/src/tool/law-verify.ts` 245、`legal-knowledge/src/types.ts` 239。体量最大两个文件分别是资产解析（`baseline.ts`）与引用决策（`article-decision.ts`），都是单职责，今日不开拆分发现。

**克隆检测（10 分钟）**：`npx jscpd packages/legal/*/src packages/law/*/src`（仓库 `.jscpd.json`，默认 60 token / 6 行）得 **0 克隆，46 个文件 7447 行**；降到 40 token / 4 行后得 **18 组、140 行（1.86%），49 个文件 7511 行**，JSON 报告在 `/tmp/jscpd-law17b`。逐组归类的处置：

- **12 组**是同一个判定器家族：判定尾（`base.ts:123-130` 对 `electronic`/`expert-opinion`/`witness-testimony` 各一组，`documentary.ts:48-56` 对五个判定器各一组，`documentary.ts:56-66` 对 `other-types.ts:82-90`）与两处开场样板（`electronic.ts:14-21` ↔ `witness-testimony.ts:14-21`、`electronic.ts:46-55` ↔ `other-types.ts:102-110`），见 F-LEG-006。
- **2 组**是 `evaluate-evidence.ts` 输出 schema 的三份维度判定对象互相配对，见 F-LEG-008。
- **2 组**是 `legal/search.ts:164-177` 与 `judicial-interpretation/search.ts:193-206` 的 `getById`，见 F-LEG-007。
- **1 组**是 `case-law/search.ts:118-126` ↔ `legal/search.ts:94-102` 的 `Backward-compatible` 构造归一，判为保留（见检查项 ④）。
- **1 组**是 `judicial-interpretation/search.ts:17-23` ↔ `legal/search.ts:17-23` 的 import 块，噪音。

**检查项 ①：legal 三包与 law 两包的重复（20 分钟）**：逐个读了五个包的公开面与内部共享层。**跨包重复只有一处**：`legal-knowledge` 内 `legal/search.ts` 与 `judicial-interpretation/search.ts` 的 `getById` 逐字相同（F-LEG-007），`case-law/search.ts:154` 的 `getById` 不做效力过滤，是另一形态。其余都不重复：① `legal-law/src/baseline.ts` 复用 `@deepseek-ai/dsh-patent-index-asset` 的 `readArticleEntries`/`parseYamlMapping`/`readOptional*`/`readString`/`IndexAssetError`，域内没有第二份 YAML 资产读取器；② `legal-law/src/reference.ts` 的 JSDoc 声明引用文法只在此处，数字读取与引用文本助手经 `@deepseek-ai/dsh-law-core` 共享，因此「引用文法在 legal-law、引用工具在 law-core」是分工而不是重复；③ `defineTool` 在三个 legal 包各注册一次，`law-core/src/citation-tool.ts` 只提供 `citationVerifyToolOptions` 等选项构造器，同一工具没有注册两次；④ 三个检索引擎的构造归一完全相同（`Backward-compatible` 块），但 `judicial-interpretation` 的构造签名多一个参数，2/3 实例不足以抽公共构造器。

**检查项 ②：`law-core`/`knowledge-core` 的共享边界（25 分钟）**：这是今日的重点，结论是**共享层真实且完整，分叉发生在引擎骨架层而不是原语层**。`knowledge-core`（442 行 8 文件）已托管两域共用的检索原语：`createFtsLadder`、`runFtsSearch`、`sanitizeSearchText`、`resolveResultLimit`、`resolveLawValidity`、`resolveAsOf`、`todayIsoDate`、`isLawVisible`、`extractLawKeywords`、`resolveRealPath`，每个都有 5–13 个域内消费者，没有零消费者导出。`legal-knowledge/src/shared/` 下的 `fts.ts`、`keywords.ts`、`fts-search.ts`、`validity.ts` 是薄再导出或列名适配器（`validity.ts` 85 行 = `knowledge-core` 的效力原语 + 本域列名映射），不是第二实现。**引擎骨架不能合并**：`SqliteBackedEngine`（`shared/sqlite-search.ts:325`）是数据驱动形态——调用方提供表名、别名、FTS 表、LIKE 列、行映射与过滤，基类另有内存回退；`patent-knowledge/src/shared/knowledge-fts.ts:27` 的 `KnowledgeFtsSearchBase` 是抽象模板——自己开 db、自己解压 chunk、自己做 FTS5 双条件探测与粘性降级（`degradeLabel`/`markFtsDegraded`）。两者共享的只有阶梯函数与结果限额，合并要把两套生命周期（谁持有连接、谁负责降级）一起参数化，净复杂度为负。这条回答 Day 15 留下的悬置：F-PAT-030 与 F-LEG-004 **不合并成跨域一条**。

**检查项 ③：规则、索引与工具注册的重复（20 分钟）**：① **规则层**：`legal-evidence` 的权重是单源——`rule-set.ts:14` 的 `DEFAULT_LEGAL_WEIGHTS` 只经 `engine.ts:62` 的 `private get weights()` 读取，域内没有第二份默认；跨域规则求值经 `knowledge-core` 的 `resolveLawValidity`，没有各写一遍。真正的规则层重复是判定器内部：13 处判定尾与 18 处布尔三元打分块（F-LEG-006），以及 `evaluate_legal_evidence` 输出 schema 的三份维度判定对象（F-LEG-008）。② **索引层**：`SqliteFtsTable`（`:65`）是唯一 SQLite+FTS 实现，三个引擎全经它；`legal-law` 的资产索引走 `patent-index-asset` 的读取器，没有第二份。③ **工具注册**：三个 `defineTool` 决策面（检索、核验、取证评估）各自独立，没有重复注册；`law-core` 的选项构造器被三包共用。④ `rule-set.ts:17`/`:32` 手写 `asRecord` 与同名 `hasText`（后者与 `evaluators/base.ts:44` 同名不同签名），见 F-LEG-009。

**检查项 ④：可删除的兼容层（15 分钟）**：读了三个最像「兼容层」的表面，**三处都判为不可删或不该删**。① `legal/search.ts:114` 与 `judicial-interpretation/search.ts:159` 的 `override search(query, options = {})` 方法体只有 `return super.search(query, options)`，但默认参数 `= {}` 是必要的：基类签名要求 `options: TOptions` 必填，而测试与工具层大量调用 `engine.search('合同')`，删掉会破坏公开 API。② `Backward-compatible` 构造归一（`recordsOrOptions` 既收数组又收选项对象）的唯一调用方是测试，但两个引擎类都是包级公开导出（`index.ts` 再导出），删除是对外可见的 API 收缩，不在 B 维度精简范围。③ `legal-knowledge/src/shared/` 的四个再导出文件不是兼容层，它们是本域 import 路径的稳定入口（Day 15 对 `patent-knowledge/src/shared/fts-search.ts` 已作同样判定）。域内**没有**死代码、未使用配置或零消费者导出。

**检查项 ⑤：净减少量（10 分钟）**：四项建议的净减少——F-LEG-006 (a) **−65 行**（13 处判定尾收敛为一行调用加一个 helper），(b) 可选再 **−62 行**（18 处布尔三元块）；F-LEG-007 **−10~−20 行**；F-LEG-008 **−17 行**；F-LEG-009 **−4 行**（主要收益是消除同名二义）。核心合计约 **−96~−106 行**，含可选 (b) 约 **−158~−168 行**。

**机械复核（5 分钟）**：① `grep -c 'Math.max(0, Math.min(score'` 得 12 而非 13——第 13 处判定尾是 `base.ts:90` 的关联性评估，它只写 `Math.min(score, 1.0)`（评分只增不减，与夹紧到 `[0,1]` 等价），因此「13 处尾部夹紧」的初稿措辞已改为「13 处判定尾，其中 12 处显式夹紧」。② `=== true` 计 27 处、`=== false` 计 18 处；`} else if (… === false)` 恰 18 处，即 18 个打分三元块——把初稿的「20 处」修正为 18，(b) 的净减少由 −70 改为 −62。③ `ruleId:` 计 22 处（`electronic` 5、`other-types` 5、`documentary` 4、`expert-opinion` 4、`witness-testimony` 4），与「每条规则一个 finding 字面量」一致。④ jscpd 两种阈值各复跑一次（0 组 / 18 组 140 行），逐组读上下文后按上述四类归档。⑤ `getById` 行号确认：`legal/search.ts:160`、`judicial-interpretation/search.ts:186`（方法签名跨三行）、`case-law/search.ts:154`。⑥ pathspec 复跑同样从仓库根执行（Day 16 记录的陷阱），子目录内相对 pathspec 会静默 0 命中。

## 发现

新增 4 条，均含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-LEG-006 | 三性判定器把「打分 + 结论对象」手写 13 份，布尔三元打分块 18 处 | −65 行（可选再 −62 行） |
| F-LEG-007 | `getById` 在 `legal` 与 `judicial-interpretation` 逐字相同 | −10~−20 行 |
| F-LEG-008 | `evaluate_legal_evidence` 输出 schema 把维度判定对象写三份 | −17 行 |
| F-LEG-009 | `rule-set.ts` 手写 `asRecord` 与同名 `hasText`，未用共享工具 | −4 行 + 消除同名二义 |

今日净减少合计约 −96~−106 行（含 F-LEG-006 的可选第二段则为 −158~−168 行）。与既有发现的关系：F-LEG-006 与 F-PAT-027（子进程骨架 4 份）是同一种「固定结尾 + 固定样板」根因，但修法不同（一个抽 helper、一个抽 wrapper），不并入；F-LEG-007 是 F-PAT-030 的域内对应物，两域仍各修各的；F-LEG-009 与 F-PAT-025 家族（短函数与 `asRecord` 重写）同源，建议并入 Day 19 横向收口。F-LEG-004（检索骨架）与 F-LEG-005（`[sati]` 标签）今日复核仍生效，无回归。

## 假设验证/推翻

**H02 保持确认，但判据要换**：共享机制的「域中立不完整」不成立于原语层——`knowledge-core` 的十个跨域原语都有 5–13 个消费者，两域的效力、可见性、日期解析、FTS 阶梯全部走同一实现；不完整位于**引擎骨架层**，两域各有一套检索基类，且两者的抽象方向相反（法律域是数据驱动、专利域是抽象模板）。因此跨域统一不是「把两份代码合成一份」，而是「先决定骨架该由数据驱动还是由模板驱动」，那是架构决策而不是 B 维度精简，本轮不做。这条也闭合 Day 15/F-PAT-030 的悬置：不合并成一条跨域发现。

H03、H04、H05、H06、H08、H09、H10 与今日范围无交集，不更新。H07（「未核验」降级）已在 Day 10 判定，今日的 `resolveLawValidity`/`isLawVisible` 复核与该判定一致，不重复记录。

## 未决问题

1. F-LEG-006 (b) 的取舍要一次人工确认：把 18 处 `if/else if` 打分块换成 `scoreSignal(...)` 后，权重会变成调用处的两个数组参数，18 处都要重读才能说出「某项证据值多少分」；(a) 不含这个代价。建议 (a) 先落地并跑过 `test:coverage`（`evaluators/*.ts` 在 per-file 100% 名单内）再决定 (b)。
2. F-LEG-009 的 `dsh-value` 依赖要算清成本：为 4 行 `asRecord` 增依赖意味着改 `package.json`、登记 tsconfig files 并跑 `pnpm run gen-module-graph`；若 Day 19 的横向收口没有别的包也需要 `dsh-value`，这条只做包内改名（`hasTextField`）就够。
3. 「知识共享层是否继续接收引擎骨架」留一个复查触发条件：今日判定不合并，是因为只有两域且抽象方向相反；若后续出现第三个域（例如视频素材检索）需要 FTS 引擎，判据变成「是否有三个消费者」，届时要重新评估把 `findRowsLike`/可见性包裹下沉到 `knowledge-core` 的成本收益。

## 明日第一件事

Day 18（视频模式全域：`video-mode`、`video-bundle`、`ui-video-studio`）第一件事：先跑 `npx jscpd packages/experimental/*/src packages/client/ui-video-studio/src`（默认与 40/4 两种阈值各一次），再逐条验今天的分域判据在视频域是否复现——① 时间线与 EDL 是否只有一份实现；② provider 结算、预算账本与任务 journal 是否各写一遍；③ F-VID-006 的 `StrictRequest`/`MediaTaskRequest` 字段全同是否在视频域还有第三份；④ 前端任务状态与工具结果是否各有两份投影。这样 Day 18 可以直接复用今日的分类框架（判定尾/输出 schema/兼容层/共享边界），不必从零找重复。
