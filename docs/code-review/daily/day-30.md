# Day 30 — 2026-12-14

## 今日维度与范围

- 维度：D 测试缺口
- 范围：文档模式、法律模式与共享机制
- 时间盒：90 分钟
- 预期产出：D 维度文档/法律域候选发现；daily/day-30.md

## 检查项

- [x] 检查 Office 转换失败与取消。
- [x] 检查 DOCX 解析边界。
- [x] 检查法律引用未核验。
- [x] 检查证据评分边界。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`。这 11 个包没有出现在 `vitest.config.ts:272` 起的 `exclude` 名单里。`types.ts`、`bin.ts`、`worker.ts` 仍按全仓通配排除。`office-kit` 的 `src` 9 个文件、1445 行，`tests` 12 个文件、2241 行。`docx-kit` 的 `src` 8 个文件、1760 行，`tests` 7 个文件、1084 行。`doc-template` 的 `src` 13 个文件、2259 行，`tests` 12 个文件、2300 行。`doc-style` 的 `src` 7 个文件、821 行，`tests` 5 个文件、593 行。`document-deliver` 的 `src` 4 个文件、1790 行，`tests` 2 个文件、1533 行。`tool-office` 的 `src` 3 个文件、672 行，`tests` 3 个文件、1003 行。`legal-knowledge` 的 `src` 16 个文件、2305 行，`tests` 10 个文件、2863 行。`legal-law` 的 `src` 8 个文件、1482 行，`tests` 6 个文件、1526 行。`legal-evidence` 的 `src` 12 个文件、1727 行，`tests` 7 个文件、1530 行。`law-core` 的 `src` 8 个文件、1589 行，`tests` 7 个文件、667 行。`knowledge-core` 的 `src` 8 个文件、442 行，`tests` 7 个文件、435 行。

**Office 失败与取消（20 分钟）**：`provider.spec.ts:262` 在引擎超时时删掉临时目录并接受下一次转换，`:310` 取消排队调用且不打断另一路，`:403` 在分配资源前拒绝已取消的调用，`:237` 拒绝缺文件、非 PDF 和不完整 PDF。`queue.spec.ts:173` 起覆盖调用方取消，`:280` 不保留失败结果，`:569` 把卸载与取消分开。`tool-office.spec.ts:416` 在没有 Office 服务时把每次调用报为不可用，`:452` 传出转换失败。`output.ts:47`–`:52` 拒绝缺少 `%PDF-` 或 `%%EOF` 的输出，上述不完整 PDF 用例会走到这里。成功结束时 `queue.ts:303` 调用 `release`，`:214` 调用 `cleanup`，`:184` 摘掉 abort 监听，`:186` 注册时带 `{ once: true }`。`packages/document/office-kit/tests` 里没有 `getEventListeners` 或 `listenerCount`。删掉 `:184` 的 `removeEventListener` 后，现有取消和成功用例仍然通过。这是 F-DOC-007。今日没有启动 LibreOffice。F-PAT-033 至 F-PAT-038 不重测。

**DOCX 解析（15 分钟）**：`zip.spec.ts:130` 起拒绝非包、ZIP64、中央目录越界、校验和不符、条目超预算和解压超预算。`docx-extract.spec.ts:198` 起拒绝缺文档部件、空正文、畸形 XML 和非包字节。`markdown.spec.ts` 覆盖标题、段落、列表和表格。围栏代码块仍是 F-DOC-001，今日不把同一缺口再开成 D。`document-deliver.spec.ts:284` 在已取消时不进入校验，`:1171` 把取消与不可解析路径分开，`:497` 报告无法投影的包。F-DOC-002 的报错文案不重开。

**法律引用未核验（25 分钟）**：`verify.spec.ts:73` 对未转录条文返回 `unverified`，`:83` 返回 `not-indexed`，`:78` 返回 `out-of-range`，`:89` 返回 `mismatch`。`verify.spec.ts:150`–`:152` 只断言默认常量里 `unverified` 与 `notIndexed` 为 `block`。`resolveLegalCitationPolicy`（`verify.ts:98`–`:99`）的现有调用只覆盖 `valid`（`:132`）和 `mismatch`（`:147`）。工具用例 `tool.spec.ts:102`–`:109` 只断言 `decision` 为 `unverified`。夹具把该处置设为 `warn`（`:16`），测试不读 `policy`。`out-of-range`、`unmatched`、`mismatch` 和 `valid` 会断言 `policy`（`:114`–`:138`）。共享六态表在 `citation-tool.spec.ts:29`–`:36`。把法律包装对 `unverified` 改成返回 `allow` 后，这些已有用例仍然通过。这是 F-LEG-010。`baseline.spec.ts:234` 拒绝空目录，`:421` 拒绝没有清单，`:499` 与 `:516` 在成功等待后断言 abort 监听数为 0。空库检索在 `legal-search.spec.ts:54`、`case-law-search.spec.ts:42` 和 `judicial-interpretation.spec.ts:75`。`install.spec.ts:54` 在源库缺失时抛错，`:168` 报告空源和缺表。`service.spec.ts:117` 在目录里没有数据库时使用内存引擎。法律域合成库 LIKE 的耗时今日不重测。

**证据评分（20 分钟）**：`branches.spec.ts:148` 惩罚没有理由的缺原件，`:222` 惩罚未核验哈希，`:126` 拒绝未知证据类型，`:477` 报告 YAML 语法错误，`:538`–`:546` 把非法 `severity` 回落为 `warning` 并计数警告。`plugin.spec.ts:41` 在规则目录没有规则文件时加载失败，`:49` 在规则文件无法解析时失败。`evaluators.spec.ts:33` 与 `tool.spec.ts:104` 在必填属性缺失时给出关键发现。`knowledge-core` 的 `validity.spec.ts:31` 在三列全缺时标为未核验。这些路径今日不另开编号。F-LEG-002 与 F-LEG-003 不重开。

**完全未测模块**：11 个包不在豁免名单里。今日没有全仓覆盖率数字，不能把「每个文件都是 100%」写成今日测量。抽样到的 Office、DOCX、引用、空库和证据评分都有测试文件触及。完全未测的模块清单为空。新缺口是 Office 成功返回后的监听摘除，以及未核验引用的处置投影。

## 发现

- [F-DOC-007](../05-findings.md)：Office 转换成功返回后不检查 abort 监听是否摘掉。
- [F-LEG-010](../05-findings.md)：未核验与未索引引用的工具结果没有锁住处置。

下面这些已有断言，不够格单列：

1. Office 的超时、取消、缺安装、非 PDF、不完整 PDF、超限输出和队列失败已有直接断言。PNG 签名在 `operations.spec.ts:142`。
2. DOCX 的 ZIP 限额、校验和、畸形 XML、空正文和缺文档部件已有直接断言。模板缺目录、缺必填变量和损坏样式在加载期失败。
3. 空语料、缺源库、空索引目录、缺清单、未核验判定本身、证据缺字段和非法严重度回落已有直接断言。`law-core` 的六态处置表和 `legal-law` 成功等待后的监听数已有断言。

同构观察、不另开编号：围栏代码块仍是 F-DOC-001。`document_deliver` 的取消文案仍是 F-DOC-002，取消路径本身已有用例。F-LEG-002 的通用规则不参与判定不在今日重开。

## 假设验证/推翻

H06 仍待验证。今日文档域与法律域的失败路径大多已有断言。新缺口在 Office 队列的监听摘除和未核验引用的处置投影。视频与 CLI 留到后续日。H01–H05、H07–H10 的验证点不在今日，状态不改。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。11 个包不在豁免名单里只说明门禁会测量它们，不代替今日的逐文件数字。
2. 没有删掉 `queue.ts:184` 的 `removeEventListener` 再跑现有套件。结论来自测试文本里没有监听数断言。
3. 没有启动 LibreOffice，没有打开真实法律库，也没有把 `unverified` 改成 `allow` 再跑。Office 与引用结论来自假转换器和现有用例文本。

## 明日第一件事

Day 31（D 测试缺口：视频模式全域）第一件事：按高风险表面列 happy path，先看 EDL 校验失败、provider 失败与预算超限、项目锁并发和 `ui-video-studio` 渲染的用例是否只断言成功结束。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、真实 ffmpeg 和云 provider 不要重测。
