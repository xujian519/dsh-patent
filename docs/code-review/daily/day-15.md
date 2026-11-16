# Day 15 — 2026-11-29

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：专利域-3：patent-knowledge、patent-data、patent-document、patent-filing、writing-patterns
- 时间盒：90 分钟
- 预期产出：B 维度专利域候选发现；daily/day-15.md

## 检查项

- [x] 检查 provider、mapper 与 cache 的重复。
- [x] 检查模板、渲染与立案组装的重复。
- [x] 检查写作范式选择与编译的重复。
- [x] 查找可删除的抽象与配置。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与体量（10 分钟）**：`find … -name '*.ts' -exec wc -l` 得 `patent-knowledge/src` 28 文件 3817 行、`patent-data/src` 12 文件 2319 行、`patent-document/src` 23 文件 3711 行、`patent-filing/src` 10 文件 1330 行、`writing-patterns/src` 7 文件 1347 行，合计 80 文件 12 524 行。五个包都没有 Day 13 那种单文件超 700 行的热点：前十为 `writing-patterns/src/pattern-store.ts` 567、`patent-document/src/document/documentCompliance.ts` 521、`patent-document/src/document/draftSchema/generic.ts` 510、`knowledge-law-search.ts` 478、`filing/engine.ts` 470、`wiki-card-loader.ts` 462、`case-law-search.ts` 447、`cnipr-receipt.ts` 444、`verify-deliverable.ts` 421、`patent-data/src/index.ts` 357。其中 `generic.ts` 体量来自三份草案注册表（数据），其余是单职责解析器或对外门面。

**克隆检测（10 分钟）**：`npx jscpd`（仓库 `.jscpd.json`，默认 60 token / 6 行）在这五个目录得 **0 克隆，72 个文件**；降到 40 token / 4 行后得 **11 组、63 行（0.51%），73 个文件**。逐组读上下文后的处置：`draftSchema/generic.ts` 三组（9/10/6 行）是三个草案注册表 `sections` 数据表的重叠，**判为非逻辑重复**——每份注册表是一份对外契约，保持显式才不会让「哪种文书有哪些槽位」需要跳读；`pdfRenderer.ts:108 ↔ filing/engine.ts:195`（10 行）是子进程骨架，见 F-PAT-027；`tool/render-patent-document.ts:160 ↔ tool/build-patent-filing.ts:114`（5 行）是 `...(args.x !== undefined ? { x: args.x } : {})` 可选转发惯用法，域内共 362 处，属 `exactOptionalPropertyTypes` 下的语言成本，**判为不可抽取**；`case-law-search.ts:18 ↔ knowledge-law-search.ts:18`（7 行）是 import 块，噪音；`patent-kg-adapter.ts` 三组（6 行）见 F-PAT-030；`pattern-store.ts:138 ↔ :156`（5 行）是 `search`/`match` 的评分尾，**判为不值得提取**；`filing/fromDraft.ts:39 ↔ :57`（5 行）与 `pattern-store.ts:504 ↔ :520`（5 行）是两个微项，见下文 ③。

**检查项 ①：provider、mapper 与 cache（15 分钟）**：逐个读了四处容易重复的表面，**结论是没有重复**。provider 四个（`cnipr-channel`、`nuo-channel`、`ego-session`、`search-provider`）的失败方向与超时来源各不相同，共享的只有 `subprocess-runner` 这一层适配器。mapper 只有 `patent-data` 的 `mapper.ts` 一份，两个检索引擎的 `row-mapper.ts`（`case-law/`、`legal/`）已在 `.agents/audits/2026-09-21-patent-domain-review.md:392`–`394` 判为非重复，今日复核仍成立：字段集不同、缺列处理不同。cache 有三种语义——`AsyncResultCache`（异步 TTL + inflight 合并）、`LruCache`（同步容量，`patent-knowledge/src/shared/lru-cache.ts`）、`templateResolver` 的单条 manifest 缓存——三者解决的问题不同，不构成重复。真正的重复落在子进程骨架（F-PAT-027）、邻居扩展循环与 `backfillContent`（F-PAT-030），都不属于 ① 的字面范围，因此改按 ② 记录。

**检查项 ②：模板、渲染与立案组装（20 分钟）**：`patent-document` 与 `patent-filing` 是今日重点，读了 `renderPatentDocument`、`pdfRenderer`、`templateDraft`、`genericDraft`、`sectionFold`、`paragraphNumbering`、`engine.ts` 与 `build-patent-filing` 的完整调用链。三处结构重复：① `resolveOutputDir` 两份逐字相同（`renderPatentDocument.ts:84`–`93` 与 `engine.ts:129`–`141`），连注释都同义，唯一差异是错误类型；② 安全文件名/案卷号判定有 4 种编码、接受集互不相同，并导致中文案卷号在 `build_patent_filing` 被拒而 `render_patent_document` 接受（F-PAT-028）；③ `escapeRegExp` 在域内 10 处（4 个命名封装 + 6 处内联）（F-PAT-029）。另有 `templateDraft` 的死字段 `openEnd`（F-PAT-031）。立案组装的其余部分不重复：`buildFiling` 只做「内容 → 章节 → 写入」，没有第二份渲染；`sectionFold` 与 `paragraphNumbering` 的扫描器各一份、用途不同（折叠 vs 编号）。

**检查项 ③：写作范式选择与编译（15 分钟）**：读了 `writing-patterns` 的 `index.ts`、`pattern-store.ts`、`skill-compiler.ts`、`prompt.ts`。**选择只有一条路径**：`selectPatterns` 由 `search` 与 `match` 两个工具共用，评分尾 5 行相同（`pattern-store.ts:138` ↔ `:156`，jscpd 命中），抽 `rankAndSlice(scored, limit)` 净减约 3 行，判为不值得提取。**编译有两个产物但不重复**：`skill-compiler` 生成 SKILL.md 文本，`prompt` 生成提示词段落，输入都是同一份 `WritingPattern`，输出形态与失败方向不同。配置面只有一处与今日主题重合：`matchLimit`、`sectionCategories`、`sectionOrder` 的 schema 缺省与 `apply()` 的 `??` 成对出现，`registerSection` 以 `=== false` 取反重述（并入 F-PAT-024）。另有两个微项不单列编号：`pattern-store.ts:504` ↔ `:520` 的 `parseExamples`/`parsePrinciples` 是两个同形映射函数，差别只有字段表与结果字段，抽 `mapEntries` 净减约 8–10 行；`patent-filing/src/filing/fromDraft.ts:39` ↔ `:57` 的 `blockNodes`/`drawingNodes` 分支骨架相同，差别是列表块与表格块的处理，抽公共分支净减约 5–6 行。两者都属可做可不做的整理，与 Day 13 对 `SectionSourceError` 的处置同口径。

**检查项 ④：可删除的抽象与配置（15 分钟）**：五包 `Config` 字段逐个统计读取点，全部 ≥1；`SerialQueue`、`GraphTraversal`、`LruCache`、`compressIfSmaller`、`resolveNodeTypes` 都有真实消费者；对五包导出面做仓内消费者普查，7 个零跨包消费者的导出全部在同文件内被调用（导出只为测试），与 Day 13/14 的判定一致。**假设被推翻一次**：`patent-knowledge/src/shared/fts-search.ts`（8 行再导出）先前疑为零消费者死文件，实际 `shared/knowledge-fts.ts:14` 就是消费者，且 `.agents/audits/2026-09-21-patent-domain-review.md:41`、`:410` 与 `docs/TECH_DEBT.md:195` 都把它记为「维持模块入口」的正面样本——撤回该假设，不作为发现落盘。可删的实项只有 `templateDraft` 的 `openEnd` 死字段（F-PAT-031）与 F-PAT-007 的再导出尾项（见下）。

**机械复核（5 分钟）**：① `git grep -n 'openEnd'` 确认该字段在 `templateDraft.ts` 内只有声明、赋值与 JSDoc，无读取。② 七个包的 `.default(` 与 `??` 逐行对齐，得出 42 对重述、2 处同义重述、1 处第三种缺省的精确计数（F-PAT-024，修正 D14 的「rule 7 处」）。③ `git grep -n '\[sati\]'` 全仓仍只有 `knowledge-fts.ts:60` 一处，已由 Day 10 的 F-LEG-005 记录，**不新开编号**。④ `git grep 'export function escapeRegExp'` 全仓 0 命中，确认无既有共享实现可复用（F-PAT-029 的前提）。⑤ 读 `patent-data/tests/persist-utils.spec.ts` 与 `patent-core` 的 tests 目录，确认 `assertSafeId`/`SAFE_ID_PATTERN` 的行为用例只存在于 `patent-data` 一侧——这是 F-PAT-007 尾项不能直接删测的原因。

## 发现

新增 5 条、扩写 1 条、闭合 1 条尾项，均含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-PAT-024（扩写） | 插件默认值两份来源扩到七个包：42 对 `??` + 2 处同义 + 1 处第三层 | 42 行重复默认 + 3 处语义冗余 |
| F-PAT-027 | 子进程超时/取消骨架 4 份，已抽好的 `subprocess-render` 未被复用 | 约 −40~−45 行 + 2 处超时/取消语义补齐 |
| F-PAT-028 | 输出目录与安全文件名判定 4 种编码，中文案卷号两工具接受集相反 | 约 −15~−20 行，接受集 4 种降为 2 种 |
| F-PAT-029 | `escapeRegExp` 域内 10 处，仓内无共享实现 | 约 −5~−8 行，正则转义字符集单一化 |
| F-PAT-030 | `patent-kg-adapter` 邻居循环 3 份，两引擎 `backfillContent` 近克隆 | 约 −20~−25 行 |
| F-PAT-031 | `templateDraft` 的 `openEnd` 死字段 + 2 处 `indexOf` 重扫 | −3 行 + 去掉 2 次全串扫描 |
| F-PAT-007（尾项） | 再导出面零消费者，但 spec 必须随用例搬迁 | −149 行 spec −8 条断言 −9 行导出 |

今日净减少合计约 −125~−140 行（不含 F-PAT-007 尾项的 149 行用例搬迁，也不含两个未单列编号的微项）。

与既有发现的关系：F-PAT-024 是 D14 的扩写而不是新条目，因为它与 `patent-teams`/`patent-rule` 是同一条根因、同一种修法，拆成两条会让修复批次各自重复一遍 `Config` 类型变更。F-PAT-028 与 F-PAT-014（输出目录包含性）相邻但不同：014 是「越出 cwd」的边界，今日这条是「同一概念四种接受集」。H02 已确认的跨域检索基类重复（legal 的 `SqliteFtsTable`/`SqliteBackedEngine` 对 patent 的 `KnowledgeFtsSearchBase`）今日复核仍成立，但属 Day 17 范围，不新开编号。

## 假设验证/推翻

**H02 保持确认，补内部证据**：`patent-knowledge` 内两个检索引擎确实共享骨架——`CaseLawSearchEngine` 与 `KnowledgeLawSearch` 都继承 `shared/knowledge-fts.ts:16` 的 `KnowledgeFtsSearchBase<TOptions, THit>`（94 行，含 FTS 双条件探测、`runFtsSearch(createFtsLadder(...))` 与粘性降级），因此「共享层只共享阶梯函数」的旧判断需要更新为「专利域内部已抽出检索基类」。但这套基类与法律域的 `SqliteFtsTable`/`SqliteBackedEngine`（368 行）仍是两套实现，跨域统一仍待 Day 17。分叉点在结果整理而非骨架：两引擎的 `backfillContent` 近克隆、`dedupeByDocument` 语义不同（一个取最小 `bm25` 再排序，一个保序截断），见 F-PAT-030。

**假设推翻（Day 15）**：`patent-knowledge/src/shared/fts-search.ts` 不是死文件。它是 `@deepseek-ai/dsh-knowledge-core` 的再导出，消费者是同目录的 `knowledge-fts.ts:14`，用途是让两个引擎的 import 路径保持在本包内。审计记录与 `docs/TECH_DEBT.md` 都把它列为正面样本，因此既不能删，也不该记成发现。

H01、H07、H09、H10 与今日范围无交集，不更新。

## 未决问题

1. F-PAT-024 若按方案 (a) 把 `Config` 字段改必填，`patent-knowledge` 与 `patent-document` 的 `??` 兼作「无 Loader、`config = {}`」的库级兜底（`resolveKnowledgePaths` 与 `renderPatentDocument` 的 `?? DEFAULT_*`）。改造前需一次普查，确认是否有直接 `new PatentKnowledge(ctx)` 或直接调 `renderPatentDocument` 而无配置的调用方（含 `python/` SDK 与 `~/.dsh` preset），否则 standalone 用法会断。
2. F-PAT-028 的接受集取舍需要产品决定：案卷号是否允许内部空格（当前三处拒绝、`buildFiling` 的 `outputName` 接受）。改接受集是对外可见行为变化；另外 `patent-core` 的 `assertSafeId` 还有域外消费者 `packages/self-evolve/self-evolve-benchmark/src/store.ts`，改共享 guard 时必须一并验证。
3. F-PAT-027 把 `startRenderDeadline` 放哪一层：`@deepseek-ai/dsh-subprocess` 明确「applies no defaults」，期限归 consumer；`patent-core` 是纯库，新增「期限」概念需要一条明确用途。倾向前者不动、放 `patent-core` 的纯 helper（只依赖 `AbortSignal`，不引入新依赖），执行前再读一次 core 的 README 边界声明。

## 明日第一件事

Day 16（文档模式全域：`office-kit`、`docx-kit`、`doc-template`、`doc-style`、`document-deliver`、`tool-office`）第一件事：先跑 `npx jscpd packages/document/*/src --min-tokens 40 --min-lines 4`，把今日的四条主题逐条对照文档域——① 插件默认值是否仍有双源（F-DOC-004 只修了 `document-deliver` 与 `doc-template`，其余四包未核）；② 子进程骨架（`office-kit` 的 LibreOffice 调用是否也手写一遍超时/取消）；③ 安全文件名判定（`doc-template` 的 `output_path` 与 `docx-kit` 的 entry 名）；④ 短函数重复。这样 Day 16 不需要从零开始找重复，直接验证专利域的四个模式是否在文档域复现。
