# Day 20 — 2026-12-04

## 今日维度与范围

- 维度：C 优化
- 范围：专利域-1：patent-tools、patent-core 的热点路径
- 时间盒：90 分钟
- 预期产出：C 维度专利域候选发现；daily/day-20.md

## 检查项

- [x] 查找循环内远程调用与重复解析。
- [x] 查找大对象复制与不必要序列化。
- [x] 检查缓存命中率与失效策略。
- [x] 检查异常路径的资源释放。
- [x] 没有证据的只标“可选观察”。

## 实际执行

**基线从哪来（10 分钟）**：`benchmarks/` 下 9 个目录都是会话、折叠、终端与浏览器重连，没有专利域用例（OBS-008）。仓库 e2e 要 `DEEPSEEK_API_KEY`，本次不打模型、不打检索网络。本地替代是三段确定性路径：进程冷导入、规则/说明书/权利要求的单次调用、同一进程里的热循环。测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。命令是 `node --import tsx/esm` 导入 `@deepseek-ai/dsh-patent-rule`、`@deepseek-ai/dsh-patent-core` 与 `packages/patent/patent-tools/src/tool/validate-specification.ts`，退出码 0。文本是固定句子重复出来的合成说明书与权利要求，不含用户语料。`--cpu-prof` 的热循环帧落在 `packages/patent/patent-rule/src/runtime/RuleEngine.ts`，说明计时的是当前源码，不是另写的一套算法。

**冷启动与单次调用（25 分钟）**：新鲜进程导入 `patent-rule` 144ms，随后导入 `patent-core` 0ms（已在同一模块图里），再导入 `validate-specification.ts` 5ms。`loadPatentFullRuleSet()` 得到 125 条规则、0 条警告，第一次 38.33ms，同进程第二次 19.05ms——加载函数本身不缓存，第二次仍要重读 YAML。`loadIpcStandards()` 138 张卡片，冷解析 10.25ms，再次调用 0ms 且返回同一对象。第一次对 4 万字跑 `evaluateText`（全量 125 条）是 109.82ms，同进程随后 7 次落在 11.84–12.69ms；这 109ms 与采样里的 `yaml` 解析、`patent-law/src/baseline.ts`、`readFileSync` 同一次出现，对应首次引用检查去装法条上限，之后 `statuteCeilings()` 与 `REGEX_CACHE` 都留在进程内。

**热路径墙钟（30 分钟）**：下表是热循环的中位数。短/中/长说明书约 1881 / 7881 / 39881 字。权利要求 20 项 814 字、60 项 2454 字。`cloneState` 的状态约 236721 字节 JSON。

| 路径 | 工作量 | 中位数 | 样本 |
|---|---|---|---|
| `evaluateText` 全量 125 条 | 1881 / 7881 / 39881 字 | 0.65 / 2.23 / 10.67ms | 40 / 40 / 20 |
| 默认输出门禁子集（`selectGateRules`，14 条 `keyword_blocklist`，其中 8 条 `quoteImmune`） | 40000 字 | 7.15ms | 20 |
| `createCheckerRuleEvaluator().evaluate`（11 个域） | 1881 / 7881 / 39881 字 | 0.27 / 0.94 / 4.38ms | 40 / 20 / 10 |
| `lintClaimText` | 20 / 60 项 | 0.07 / 0.22ms | 40 / 20 |
| `validateSpecification` | 7881 / 39881 字 | 0.55 / 2.61ms | 30 / 15 |
| `searchStandards('创造性')` / `queryIpcDetail('G06F')` | 138 张卡片 | 0.04 / 0.00ms | 各 200 |
| `cloneState` | 236721 字节，单次 / 连续 20 次 | 0.01ms / 合计 0.25ms | 20 |

热循环 40 次另加 1 次预热的 CPU 采样共 554 个样本（同进程里还有 1 次规则加载），`quotedSpans` 占 209（37.7%）。它由 `quoteMask`（`RuleEngine.ts:100`）调用，而 `quoteMask` 在每条 `quoteImmune` 规则上各算一次（`:162`）。默认门禁 8 条这样的规则，4 万字整次调用 7.15ms，所以把掩码提升到一次评估只算一遍，省下的是这 7ms 里的一部分。

**循环内远程调用（15 分钟）**：`patent_search` 对一次查询做有界重试，只有第一通道没有可用答案时才再调一次 CNIPR（`patent-search.ts:305`、`:322`），不按命中条数发请求。`patent_pdf_download` 把待下载列表一次交给 ego runner（`:565`），CDN 兜底是 `Promise.all`（`:592`）；逐件循环只做本地 manifest 的 `stat` 和成功后的 sha1。`workbench_link_patent_case` 先拉一次字典、一次任务列表；字典最多补 6 条（`PATENT_TYPE_DICTIONARIES`），阶段固定 `l1`–`l5`，缺的才 POST、状态变了才 PATCH。上限大约 19 次本机 HTTP，不随说明书长度增长。这三处的网络往返本次没有测量。

**重复解析（10 分钟）**：Day 19 交过来的「四份文本读取器等于四次全量解析」不成立。`readStateText`、`readFirstStateText`、`firstStateString` 都是按键取状态里的字符串，一次原子用其中一个。真正对同一篇说明书重复切段的是 `validateSpecification`：未提供 `drawing_count` 和 `figure_analysis` 时，`sectionBodies` 走 12 次（入口 `presentSections`、`checkEmptySections`、背景/效果/媒体三处各 1 次，`drawingViolations` 里再 7 次，其中 `checkFigureReferenceMissing` 经 `withoutDrawingSection` 多切一次）。4 万字整次校验中位数 2.61ms，这 12 次都含在里面。

**缓存与异常路径（10 分钟）**：`rule_check`、`response-check`、`eligibility` 各自用进程内 `??=` 缓存，所以加载函数没有缓存也不会在每次调用时重读；三个调用方第一次仍会各解析一遍全量规则。IPC 索引是随包资产的进程单例，覆盖路径故意不进单例。`internal/index-store.ts` 按文件路径缓存，注释写明外部改文件在实例生命周期内不感知；本次没有生产索引的体积，不估命中率。三个附图渲染器的 `deadline.dispose()` 都在 `finally`（`graphviz-renderer.ts:252`、`freecad-renderer.ts:300`、`inkscape-renderer.ts:303` 与 `:363`）；Inkscape 描边的临时目录在同一 `finally` 里 `rm`。没有再做「渲染中途杀掉进程」的探针。

## 发现

无。上面几条本地路径的热调用都在 12ms 以内，够不上「明显的性能退化」。下面四条只作可选观察，不进 [05-findings.md](../05-findings.md)：

1. `quoteImmune` 的引号掩码按规则各算一次。默认门禁 8 条、4 万字、7.15ms。掩码改成按本次文本算一次，收益上限就是这一次调用。
2. `validateSpecification` 对同一篇说明书调用 `sectionBodies` 12 次，整次 2.61ms（39881 字）。
3. `loadPatentFullRuleSet` 无内部缓存，同进程第二次仍要 19.05ms。生产调用方各自缓存，一次进程里同一套 YAML 会被插件启动、`rule_check`、答复检查、客体检查各解析一次。
4. 工作台阶段写入是串行的，条数有上限；检索与 PDF 的远端耗时不在本次数字里。

`benchmarks/` 缺专利用例记为 OBS-008。

## 假设验证/推翻

H01–H10 没有一条把验证点放在今日这两包的热路径上，状态不改。

Day 19 交给今日的「四份读取器等于四次全量解析」没有假设编号。今日推翻这一说法：读取器是按键取值；重复切段在 `validateSpecification`，并且整次调用是 2.61ms。F-PAT-019 仍是 B 维度的语义分歧，不改成 C 维度条目。

## 未决问题

1. 默认输出门禁只有 `keyword_blocklist`。部署若把 `gateCheckTypes` 扩到全族，每次助手输出都会走近今日 10.67ms 那一档（39881 字、125 条），倍数未测。
2. `patent_search`、`patent_pdf_download`、工作台链接的远端往返没有测量。调用次数的上限已经数过，耗时留在 Day 21 的 `patent-data` 缓存与真正的检索通道。
3. 附图索引缓存不感知盘上的外部写入。没有一份生产索引的条目数，不能判断每次 `load` 复制数组是否值得管。

## 明日第一件事

Day 21（C 优化：`patent-knowledge`、`patent-data`）第一件事：读 `packages/patent/patent-data/src/patent-cache.ts` 的键、容量和失效，用现有 `patent-cache` 测试或一次本地重复查询把未命中和命中分开计时。今日已经确认 `patent_search` 只是调用 `cachedSearchPatents`，不要在 `patent-tools` 里再测一遍包装层。
