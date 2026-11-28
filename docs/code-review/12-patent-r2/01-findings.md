# 第二轮新发现

本文件登记第二轮审阅新确认、且第一轮 `11-patent/01-findings.md` 未覆盖的缺陷。精简候选记录在各批次文件中。当前发现均来自 B3；只读探针复现后，已回源核对输入、分支与消费者。登记时状态为「待确认」，表示修复会改变模型可见结论、错误类型或公开读取结果；用户授权后 S-PAT-001…013 已全部修复，实施要点与回归测试见文末[实施记录](#实施记录)。

## B3 权项与检查

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-001 | P2 | `patent-core/src/claim-chart/runtime/claim-refs.ts:150-153`、`mapping-machine.ts:100-130` | `referenceAlternatives` 只对直接引用做一层展开，再把传递闭包合取进同一路径。权 3 引用「1 或 2」、权 4 仅引用权 3，且只有 2a 未覆盖时，权 4 应存在「3→1」完整替代路径，实际却返回 `covered:false`、`missing:['2a']`，也没有 `alternatives`。会错误影响新颖性与区别特征。 | 递归展开父项的替代路径，按展开后的路径数生成逐路径结果；无效结论侧复用同一展开结果。 | 已修复 |
| S-PAT-002 | P2 | `patent-core/src/claim-lint/checks.ts:217-227` | 当前项引用一个多项从属权项即报 `multiple-dependent`，未要求当前项本身也是多项从属。权 3「根据权利要求 1 或 2」、权 4 仅引用权 3 是合法形式，现有测试还固化了该误报。 | 仅在 `claim.references.length > 1` 时执行「多项从属不得引用多项从属」检查，并同步修正旧测试预期。 | 已修复 |
| S-PAT-003 | P2 | `patent-core/src/checker/engine.ts:130-135` | 单独对比禁令用 `includes` 命中禁语。「不得将 D1 和 D2 结合」这类正确禁令也被判 Must 失败，会阻断合规分析。 | 复用本文件 `hasBanPhraseNegation` 的否定语境判定，排除「不得／不应」等 prohibition 语境；补核心与规则语料回归。 | 已修复 |
| S-PAT-004 | P2 | `patent-core/src/claim-lint/references.ts:152-159` | 无前缀概括引用直接在全文匹配，没有使用 `bareWindow`。因此「其特征在于，装配权利要求中任一项所述的装置」被误判为从属，违背模块头「裸引用仅限引言」契约，并污染引用闭包。 | 概括引用与裸编号引用一样在 `bareWindow` 中搜索；带前缀形式仍可全文识别。 | 已修复 |
| S-PAT-005 | P3 | `patent-core/src/claim-chart/runtime/element-validator.ts:156-163` | 连续性用单字符 `charCode` 推导，`ELEMENT_ID_RE` 却允许多字母后缀。`1a…1z,1aa` 的第 27 个要素被误报「期望 1b」。 | 使用双射 base-26 编号生成期望后缀，并补跨 `z→aa` 用例。 | 已修复 |

## B3 证据与分析

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-006 | P2 | `patent-core/src/evidence/judgment.ts:177-179,320-322` | `common_knowledge` 无条件输出「无需举证」，但 EVI-013 的 `fact_is_well_known`、`fact_is_uncontested` 可仍为 pending；同次结果同时给出免证结论与待核条件，模型可见理由互相矛盾。 | 仅在外部条件满足时设置豁免；否则报告未核实及缺失条件，修改既有「无条件免证」测试。 | 已修复 |
| S-PAT-007 | P2 | `patent-core/src/evidence/public-use.ts:117-127`、`judgment.ts:232-239` | 日期认定支持从 snippet 回退提取，四要件却只读 `docVersion`。snippet 为「2023年1月10日在上海公开销售」时，日期认定成功而 `timeElement.met=false`，造成 EVI-015 假阴性。 | 四要件与日期认定共用同一日期来源，覆盖 snippet 回退及无法解析分支。 | 已修复 |
| S-PAT-008 | P2 | `patent-core/src/evidence/index.ts:104-110`、`atoms/handlers/builtin/evidence-check.ts:551-570` | `spanFromReceipt` 在自定义 snippet 时仍对 `receipt.resultText` 生成哈希，实体却保存另一段 snippet；下游按 snippet 重算后误判完整性阻断。 | 对最终 `spanSnippet` 计算哈希；无摘录时不生成内容哈希。 | 已修复 |
| S-PAT-009 | P2 | `patent-core/src/evidence/ledger.ts:263-268,341` | `digestOf` 过滤缺省字段后无标签拼接；同类同 D 标号的 `{title:'x',snippet:'s'}` 与 `{sourceUri:'x',snippet:'s'}` 得到相同内容哈希和账本 digest，字段身份变化不可检测。 | 改为固定位置、带字段名的 JSON 元组哈希，并保留既有 digest 变化预期。 | 已修复 |
| S-PAT-010 | P3 | `patent-core/src/evidence/types.ts:94-100`、`rule-set.ts:132-141`、`patent-rule/assets/rules/patent/evidence-rules.yaml` | 类型已声明 `evidenceAssessment.platformCredibility` 与 `conditions`，解析器却丢弃它们；EVI-010、EVI-020、EVI-040 等 shipped YAML 实际使用这些字段，`getRules()` 审计结果不完整。 | 在 YAML 解析边界校验并保留两类字段，补真实资产回读断言。 | 已修复 |

## B3 证据检查与图执行

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-011 | P2 | `patent-core/src/atoms/handlers/builtin/evidence-check.ts:151-156,551-570` | `firstText` 对摘录 `trim()` 后再重算哈希；原摘录含首尾空白时，即使 `contentHash(原摘录)` 正确也会阻断，属于完整性误报。 | 完整性检查使用保留原文、仅以 trim 判空的读取器；补 SHA-256 首尾空白回归。 | 已修复 |
| S-PAT-012 | P2 | `patent-core/src/graph/domains/novelty.ts:138-154`、`atoms/handlers/builtin/llm.ts:149-175` | `numeric_range` 的 catch 将 `StageCancelledError`、abort 与 `AbortError` 全部降级，最终由图引擎包装成普通 `GraphEngineError`，丢失取消类型与 `stageId`；全图虽停止，取消契约仍错误。 | 复用 `callLlm`，或等价实现调用前检查、取消转换与类型化穿透；补节点内取消测试。 | 已修复 |
| S-PAT-013 | P3 | `patent-core/src/atoms/handlers/builtin/evidence-check.ts:292-345,696-701` | `resolveReference` 已区分 `reference-date`，报告却把所有非优先权日显示为「申请日」。显式 `reference_date` 因此被误标法律依据。 | 三分支显示「指定截止日／申请日／优先权日」，补报告断言。 | 已修复 |

## B5 图、工作流与根级设施

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-014 | P2 | `patent-core/src/graph/domains/shared.ts:67-83` | `llmNode` 把所有异常转成 `llm_unavailable` 降级，取消因此被吞：`RunOptions.signal` 契约是「节点内取消以 StageCancelledError 拒绝」（`graph/types.ts:84`），实际写入伪造降级标记，取消类型在超步边界被换成 `GraphEngineError`。与 S-PAT-012 同类；影响 inventiveness 7 个、enablement 4 个、novelty 1 个 LLM 节点。 | catch 内先抛 `isStageCancelledError(err)`；`signal?.aborted` 或 `isAbortError(err)` 时抛 `new StageCancelledError(outputKey)`；其余错误保持原文案。 | 已修复 |
| S-PAT-015 | P3 | `patent-core/src/subprocess-deadline.ts:42` | 已中止的调用方信号不会触发 abort 监听，第 42 行直接 `controller.abort()` 跳过 `clearTimeout`；计时器到点后 `timedOut()` 翻成 `true`，正是 35–36 行注释要避免的误报。消费方先查 `timedOut()`（`patent-filing/src/filing/engine.ts:214`、`patent-document/src/document/pdfRenderer.ts:128`），慢收尾的子进程会把用户取消报成「超时」。测试 42–52 行未推进计时器。 | 第 42 行改为 `onCallerAbort()`；补「已中止信号 + 推进 `timeoutMs` 后 `timedOut()` 仍为 false」。 | 已修复 |
| S-PAT-016 | P3 | `patent-core/src/quality/ledger.ts:88-92` | `null` 通过 `typeof raw !== 'object'` 守卫后 `raw.persisting` 抛 TypeError；与「账本缺失或字段畸形时判未评估」的契约不符，会让 `draft-quality-ledger` 原子整阶段失败。 | 改用 `@deepseek-ai/dsh-value` 的 `isRecord` 做非空对象守卫；补 null 用例。 | 已修复 |
| S-PAT-017 | P3 | `patent-core/src/graph/adapter.ts:173-182` | `execState[stage.id]` 用 `as string` 断言成字符串且未校验；`execState` 在读取前合并了 `stage.params`（键名不受校验），恢复时也来自检查点未逐键校验的 `state`。同名值非字符串时 `output.trim()` 抛 TypeError。 | 改为 `typeof … === 'string'` 读取；补 params 同名非字符用例。 | 已修复 |
| S-PAT-018 | P3 | `patent-core/src/safe-path.ts:23,48` | 文档与错误文案只说拒绝尾部空白/点，代码同时拒绝首部空白（测试 `safe-path.spec.ts:20` 断言 `' a'` 被拒）；首部空白输入会收到解释不了原因的文案。 | 文案与 JSDoc 改为「首尾空白」；行为不变。 | 已修复 |

## B6 服务接缝（patent-data、patent-knowledge）

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-019 | P3 | `patent-data/src/patsnap-channel.ts:82-91`、`:176` | 重试等待只靠 `abort` 事件提前结束；信号在进入等待前已中止时事件不再触发，等待跑满 `Retry-After`（上限 5 s）才由 `throwIfAborted()` 抛出，取消延迟被放大（与 S-PAT-015 同类）。计时器先到时时监听器也不摘除。现有用例只覆盖「等待期间中止」。 | 进入等待前检查 `signal?.aborted`；`finish` 同时清理计时器与监听器；补「已中止信号不延迟」用例。 | 已修复 |
| S-PAT-020 | P3 | `patent-knowledge/src/index.ts:124`、`:142`、`shared/lru-cache.ts:18-20`、`shared/kg-store.ts:76-79` | `nodeCacheMaxEntries` 的 schema 用 `z.number().min(1)`，接受 `1.5`/`Infinity`；构造期不复验，真正的整数约束在懒加载的 `LruCache` 上，配置错误会在首次 KG 查询时抛 `RangeError` 而非装载期失败。`patent-data` 同类字段全部 `z.natural().min(1)` 且构造期复验。 | schema 改 `z.natural().min(1)` 并按既有做法在构造器复验。 | 已修复 |
| S-PAT-021 | P3 | `patent-tools/src/wiring.ts:412-416`、`:417`；`patent-tools/src/tool/patent-wiki-search.ts:143-145` | 同一接线块中 KG 分支按 `existsSync(queryDbPath)` 决定是否注入（缺库报 `setup_required`），wiki 分支无条件注入。wiki 目录缺失时加载器扫描失败（服务未注入 logger），`search` 返回空数组，工具给出 `total: 0` 而非自带的 install 诊断。 | 与 KG 分支对称，按 `existsSync(wikiDir)` 决定注入；改动在 `patent-tools` 接线，跨出 B6 包边界。 | 已修复 |
| S-PAT-022 | P3 | `patent-knowledge/src/install.ts:27-43` | 同连接上 `SELECT id, content FROM chunks` 迭代期间 `UPDATE chunks`；SQLite 不保证同表游标扫描结果，可能跳过或重复行。跳过使部分 chunk 保持明文（可读、无数据损失），实际影响是 `compressedChunks` 计数与余量不符且无提示。fixture 只有 2 行，覆盖不到。 | 改为按 id 窗口分批查询再更新，保持流式内存占用。未在真实大库上复现。 | 已修复 |

## 实施记录

用户授权后，S-PAT-001…013 已全部修复并补回归，实施要点如下。测试路径均相对于 `packages/patent`。B5 的 S-PAT-014…018 同样在用户确认后修复，见文末[B5 实施记录](#b5-实施记录)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-001 | `claim-refs.ts` 递归展开父项的替代路径，按展开后路径数生成逐路径结果；无效结论侧复用同一展开结果。 | `patent-core/tests/claim-chart/claim-refs.spec.ts`、`mapping-machine.spec.ts` |
| S-PAT-002 | `checks.ts` 仅在 `claim.references.length > 1` 时执行「多项从属不得引用多项从属」检查，并修正旧测试预期。 | `patent-core/tests/claim-lint.spec.ts` |
| S-PAT-003 | `engine.ts` 禁令对比复用 `hasBanPhraseNegation` 排除「不得／不应」等否定语境。 | `patent-core/tests/checker.spec.ts`、`atomic-checker.spec.ts` |
| S-PAT-004 | `references.ts` 概括引用与裸编号引用一样在 `bareWindow` 中搜索；带前缀形式仍可全文识别。 | `patent-core/tests/claim-lint.spec.ts` |
| S-PAT-005 | `element-validator.ts` 使用双射 base-26 编号生成期望后缀。 | `patent-core/tests/claim-chart/element-validator.spec.ts`（跨 `z→aa`，R-41） |
| S-PAT-006 | `judgment.ts` `common_knowledge` 仅在 `isWellKnown===true && isUncontested===true` 时设置豁免，否则报告未核实及缺失条件。 | `patent-core/tests/evidence-engine.spec.ts` |
| S-PAT-007 | `public-use.ts` 新增 `timeFromSnippet`，四要件与日期认定共用同一日期来源，覆盖 snippet 回退及无法解析分支。 | `patent-core/tests/evidence-engine.spec.ts` |
| S-PAT-008 | `evidence/index.ts` `spanFromReceipt` 对最终 `spanSnippet` 计算哈希；无摘录时不生成内容哈希。 | `patent-core/tests/evidence-check-atom.spec.ts` |
| S-PAT-009 | `ledger.ts` `digestOf` 改为固定位置、带字段名的 JSON 元组哈希；空来源返回空串以保留无 contentHash 的既有语义。 | `patent-core/tests/evidence-ledger.spec.ts` |
| S-PAT-010 | `rule-set.ts` 在 YAML 解析边界校验并保留 `evidenceAssessment.platformCredibility` 与 `conditions`（含 undefined 过滤）。 | `patent-rule/tests/evidence-rules-asset.spec.ts`、`patent-core/tests/evidence-engine.spec.ts`（`parseRuleSet` 分支） |
| S-PAT-011 | `evidence-check.ts` 新增保留原文、仅以 trim 判空的读取器，完整性检查使用原文重算哈希。 | `patent-core/tests/evidence-check-atom.spec.ts`（SHA-256 首尾空白） |
| S-PAT-012 | `novelty.ts` `numericRangeNode` 移除吞掉取消的 try/catch，改用 `callLlm` 让 `StageCancelledError` 类型化穿透到图引擎。 | `patent-core/tests/graph/domains.spec.ts` |
| S-PAT-013 | `evidence-check.ts` 报告依据三分支显示「指定截止日／申请日／优先权日」。 | `patent-core/tests/evidence-check-atom.spec.ts` |

> 兼容性说明：S-PAT-008/009 仅改变 `contentHash`/`digest` 的哈希输入格式，不改变字段或语义；已持久化会话重放时会重算哈希值，哈希值不属于稳定契约。11 个专利 keyless 快照已用 `DSH_SNAPSHOT=refresh` 刷新，其中 4 个 chain 场景的 `contentHash` 随之更新（差异仅含哈希值，`durationMs` 噪声已剥离）。

### B5 实施记录

用户确认「全部修复并补回归」后，S-PAT-014…018 与 L1（`compileSignal` 收敛）已全部落地，既有用例未修改。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-014 | `graph/domains/shared.ts` 的 `llmNode` catch 先抛 `isStageCancelledError`，`signal?.aborted` 或 `isAbortError` 时抛 `new StageCancelledError(outputKey)`，其余错误保持原降级文案。 | `patent-core/tests/graph/domains.spec.ts` |
| S-PAT-015 | `subprocess-deadline.ts` 已中止分支改走 `onCallerAbort()`，与事件回调共用清理路径。 | `patent-core/tests/subprocess-deadline.spec.ts`（假计时器推进 `timeoutMs`） |
| S-PAT-016 | `quality/ledger.ts` 改用 `isRecord` 做非空对象守卫。 | `patent-core/tests/draft-quality-ledger.spec.ts` |
| S-PAT-017 | `graph/adapter.ts` 兜底读取改为 `typeof … === 'string'`，非字符串按缺失处理。 | `patent-core/tests/graph/adapter.spec.ts` |
| S-PAT-018 | `safe-path.ts` JSDoc 与错误文案改为「首尾空白」；校验逻辑不变。 | 既有 `safe-path.spec.ts` |
| L1 | `graph/adapter.ts` 回退条件边改用 `workflow/signal.ts` 的 `compileSignal`。 | 既有回退路由用例 |

### B6 实施记录

用户确认「全部修复并补回归」后，S-PAT-019…022 已全部落地，既有用例未修改；另有 L0 三处（重复 JSDoc、文案空格、模块注释位置）见 [02-batches/B6.md](02-batches/B6.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-019 | `patsnap-channel.ts` 的 `sleep` 进入等待前先看 `signal?.aborted`；`finish` 统一清理计时器与 `abort` 监听器。 | `patent-data/tests/patsnap-channel.spec.ts`（已中止信号 + `retry-after: 30`，200 ms 内以 `AbortError` 拒绝且只发一次请求） |
| S-PAT-020 | `index.ts` schema 改 `z.natural().min(1)`，新增 `resolveNodeCacheMaxEntries` 在构造期拒绝非安全正整数。 | `patent-knowledge/tests/service.spec.ts`（`1.5` 构造抛错、显式正整数正常构造） |
| S-PAT-021 | `wiring.ts` 仅当 `existsSync(wikiDir)` 时注入 `searchIn`/`formatAsContext`，缺目录时工具走既有 `setup_required`。 | `patent-tools/tests/wiring-composition.spec.ts`（目录缺失/存在两分支） |
| S-PAT-022 | `install.ts` 的 `compressChunksTable` 改为 `ORDER BY id LIMIT ? OFFSET ?` 的 500 行窗口再更新。 | `patent-knowledge/tests/install.spec.ts`（跨窗口的长 chunk 被压缩，首行保持明文） |
