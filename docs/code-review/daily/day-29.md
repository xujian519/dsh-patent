# Day 29 — 2026-12-13

## 今日维度与范围

- 维度：D 测试缺口
- 范围：专利域-3：patent-knowledge、patent-data、patent-document、patent-filing
- 时间盒：90 分钟
- 预期产出：D 维度专利域候选发现；daily/day-29.md

## 检查项

- [x] 检查空索引、损坏索引与缺资产。
- [x] 检查 provider 失败与超时。
- [x] 检查渲染格式断言。
- [x] 检查立案组装。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`。`vitest.config.ts:289`–`:294` 写明每个已发布的专利包都按每文件门禁测量。四包都不在 `exclude` 里。`patent-knowledge` 的 `src` 28 个文件、3817 行，`tests` 21 个文件、3521 行。`patent-data` 的 `src` 12 个文件、2319 行，`tests` 14 个文件、2889 行。`patent-document` 的 `src` 23 个文件、3711 行，`tests` 26 个文件、5334 行。`patent-filing` 的 `src` 10 个文件、1330 行，`tests` 12 个文件、2614 行。

**空索引、损坏记录与缺资产（20 分钟）**：`kg-store.spec.ts:338` 在没有知识图谱表时失败，`:348` 点名缺失的 `kg_edges`。`db-version.spec.ts:145` 拒绝未来版本，`:161` 拒绝不匹配的 `application_id`，`:184` 把打不开的路径包进 `KnowledgeDbVersionError`。`install.spec.ts:190` 拒绝越界的 `searchPrefixChars`，`:220` 拒绝输出路径与源库别名，`:356` 在输入库缺失时抛错。`wiki-card-loader.spec.ts:215` 在 `card-index.json` 损坏时退回扫描结果，`:259` 作废版本错误或数组畸形的缓存。`chunk-compression.spec.ts:55` 对损坏 BLOB 不抛错。`config.spec.ts:14` 锁住候选顺序：`knowledge.db`、`knowledge-lite.db`、源库。`knowledge-law-search.spec.ts:133` 在没有 `law_article` 行时仍可查询。`case-law-search.spec.ts:150` 在没有 `docs_fts` 时走 LIKE 并命中 `d1`。`:158` 在 FTS 无命中时仍经 LIKE 命中 `d1`，没有锁住零命中后的整表解压。该路径归 F-PAT-032，今日不重测、不新开编号。

**provider 失败与超时（25 分钟）**：CNIPR 在 `cnipr-channel.spec.ts:154` 把超截止期记为超时，`:165` 报告没有回执，`:313` 拒绝畸形回执。缓存谓词 `patent-cache.spec.ts:194` 拒绝 `检索失败` 与 `检索超时`，`:243` 失败结果不进缓存，`:255` 空命中不进缓存。`subprocess-runner.spec.ts:84` 断言注入的 `graceMs` 为 1000，`:97` 断言默认值为 3000。`createNuoSearchProvider`（`search-provider.ts:23`–`:31`）只映射 `hits`，没有 `try/catch`，不读 `warnings`。`search-provider.spec.ts` 只有两条成功用例（`:9` 映射字段，`:55` 默认上限 5），传入的 `warnings` 都是空数组。注入的 `search` 抛出 `检索超时` 时现有用例仍通过；在函数外包 `catch` 并返回 `[]` 同样通过。带超时告警且 `hits` 为空的结果今天会返回 `[]`，用例没有覆盖这条。这是 F-PAT-038。

**渲染格式（20 分钟）**：未知模板与缺 HTML 在 `template-resolver.spec.ts:44` 与 `:49`。合规拒绝在 `document-compliance.spec.ts`，损坏主题在 `brand-injector.spec.ts:65`。`renderPdf` 的成功用例 `pdf-renderer.spec.ts:67` 断言 `{ ok: true, path }` 与 `existsSync`，并检查 `--headless`。实现在 `pdfRenderer.ts:125` 同样只看文件是否存在，今日不把「不读 PDF 魔数」写成缺口。失败分类已有：缺 Chrome `:96`，非零退出 `:114`，零退出无文件 `:136`，内部超时 `:262`，调用方中止 `:294`，信号名 `:327`，子进程缝抛错 `:371` 与 `:392`。`GRACE_MS` 在 `pdfRenderer.ts:34` 为 3000，`:114` 传入 spawn，`:103` 注册 abort 监听，`:134` 在 `finally` 摘掉。`packages/patent/patent-document/tests` 里没有 `graceMs`、`listenerCount` 或 `removeEventListener`。删掉 `graceMs` 或 `removeEventListener` 后，上述超时、中止和成功用例仍然通过。这是 F-PAT-037。F-PAT-033 的附图 `dispose` 今日不重测。

**立案组装（15 分钟）**：`content.spec.ts:22` 起拒绝空摘要、空权利要求、空说明书、空白附图和越界的摘要附图下标。`from-draft.spec.ts:46` 起断言 HTML 与 docx 的表题、权项和附图一致。`assets.spec.ts:31` 用 sha256 钉住模板，`assets-resolution.spec.ts:23` 在没有模板身份时失败。`python.spec.ts:75` 把不存在的解释器报成本包错误。引擎包装的取消、非零退出和信号终止是 Day 27 的范围，今日不重开分类断言。`engine.ts:30` 的 `GRACE_MS` 在 `:201` 传入，`:191` 注册监听，`:221` 摘掉。`packages/patent/patent-filing/tests` 里没有 `graceMs`、`listenerCount` 或 `removeEventListener`。超时用例 `engine.spec.ts:633` 只断言内部 signal 已中止。这条与 F-PAT-037 同类。Day 27 已审该包装的失败分类，今日不另开编号。`subprocess-runner.ts:50` 与 `:77` 的监听摘除同样没有监听数断言；默认宽限已在 `subprocess-runner.spec.ts:97` 锁住，不另开。

**完全未测模块**：四包不在覆盖率豁免里。今日没有全仓覆盖率数字，不能把「每个文件都是 100%」写成今日测量。抽样到的知识库、CNIPR、缓存、HTML 渲染和立案内容都有测试文件触及。完全未测的模块清单为空。新缺口是 PDF 渲染的宽限与监听，以及 nuo provider 的抛错。

## 发现

- [F-PAT-037](../05-findings.md)：PDF 渲染的宽限和 abort 监听没有用例。
- [F-PAT-038](../05-findings.md)：nuo 检索 provider 的抛错和超时告警没有用例。

下面这些已有断言，不够格单列：

1. 知识库的缺表、未来版本、不匹配的 `application_id`、打不开的路径、缺输入库、损坏卡片索引和损坏分块 BLOB 已有直接断言。候选库顺序已锁住。
2. CNIPR 的超时、缺回执和畸形回执已有断言。缓存拒绝写入 `检索失败` 与 `检索超时`。`patent-data` 子进程运行器的默认 `graceMs` 已是 3000。
3. HTML 模板缺失、合规拒绝、损坏主题、立案内容校验、HTML 与 docx 一致性、模板身份和解释器缺失已有直接断言。

同构观察、不另开编号：立案引擎 `engine.ts:201` 的 `graceMs` 与 `:221` 的 `removeEventListener`，以及 `subprocess-runner.ts:77` 的监听摘除。前者的失败分类已在 Day 27 审过，补法是在 `engine.spec.ts:633` 断言 `calls[0].graceMs` 为 3000，并在一次成功调用后断言调用方信号的 abort 监听数与调用前相同。后者的默认宽限已有断言。

## 假设验证/推翻

H06 仍待验证。今日四包的缺口在 PDF 渲染的宽限与监听，以及 nuo 检索 provider 的抛错。文档域、法律域与 CLI 留到后续日。H01–H05、H07–H10 的验证点不在今日，状态不改。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。四包不在豁免内只说明门禁会测量它们，不代替今日的逐文件数字。
2. 没有删掉 `pdfRenderer.ts:134` 或 `engine.ts:221` 的 `removeEventListener` 再跑现有套件。结论来自测试文本里没有监听数断言。
3. 没有启动 Chrome、nuo、CNIPR 或真实 `knowledge.db`。PDF 与检索结论来自假子进程和注入的 `search`。

## 明日第一件事

Day 30（D 测试缺口：文档模式、法律模式与共享机制）第一件事：按高风险表面列 happy path，先看空语料、缺资产、provider 或 Office 失败和引用门禁的用例是否只断言成功结束。F-PAT-032 的测量、F-PAT-033 至 F-PAT-038、真实 Office 引擎和法律域合成库 LIKE 不要重测。
