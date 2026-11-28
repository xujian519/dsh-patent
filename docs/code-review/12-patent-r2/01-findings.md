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

## B7 服务接缝（patent-workflow、patent-teams）

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-023 | P3 | `patent-workflow/README.md:33`、`README.zh.md:34` | 文档写 `draft_review` 最多两次回退、第三次失败即收口；manifest 为 `maxRetries: 3`，v0.2.3 升级指南也写三次（第四次失败才收口）。 | 双语改为三次回退、第四次失败收口，并重录配对。 | 已修复 |
| S-PAT-024 | P3 | `patent-workflow/README.md:39`、`README.zh.md:40` | 文档写「39 个不同原子、30 个核心原子」；实测 41 个不同原子、32 个由 `registerBuiltinAtoms()` 注册，缺口仍是九个 patent-tools 原子。 | 双语改为 41 / 32；外部原子名单不变。 | 已修复 |
| S-PAT-025 | P3 | `patent-workflow/src/flexible-plan.ts:426-520` | `fromJSON` 接受 `createdAt: 42`、`updatedAt: null`、`technicalField: 7`、`artifacts: [null]`、`params: []`、`atom: 42` 等非法快照并断言成 `FlexiblePlanState`；`params` 会在执行器里展开进执行态。 | 补齐可选头字段、时间戳、`currentStageId`、阶段 `atom`/`params` 与三个字符串数组校验；补非法与合法往返用例。 | 已修复 |
| S-PAT-026 | P3 | `patent-teams/src/tools.ts:349-350`；`service.ts:313-317` | `claim_task` 文案说「省略 assignee 即以队长身份认领」，但未分配任务会被 `claiming an unassigned task needs an assignee` 拒绝；支持路径是 `reassign_task(assignee="captain")`。 | 工具描述、参数描述与服务 JSDoc 改为指向 reassign；重生成工具目录。 | 已修复 |
| S-PAT-027 | P3 | `patent-teams/src/task-ops.ts:620-631` | 质量门禁打回后再次成功完成，`gateFeedback` 不清除，`status` 仍把已完成任务渲染成 `gated ×N`；打回详情已有 `patent-teams/task-gated` 事件。 | 接受 `completed` 时删除 `gateFeedback`，保留 `gateRejections`。 | 已修复 |
| S-PAT-028 | P3 | `patent-teams/src/task-ops.ts:545-575`、`state.ts:112-131` | `claimTask` 拒绝 `reassigning` 中的任务，`updateTask` 不拒绝；改派等待静默期间新 assignee 可改写任务，第二次锁会接受被改写的状态。直接加守卫会让进程在两次锁之间崩溃后任务永久停在 `reassigning`。 | `updateTask` 加同样的守卫；`invalidateTaskAttempt` 返回 handoff id，`reassignTask` 用进程内 `activeHandoffs` 区分进行中的 handoff 与崩溃遗留标记，后者可被队长重新改派恢复。 | 已修复 |
| S-PAT-029 | P3 | `patent-teams/src/scheduler.ts:292-306` | 派发失败回滚发现 attempt 已被替换时直接返回，不把成员从 `working` 置回 `idle`；成员无在办任务时会长期显示 working。 | 仅在成员无 claimed/in_progress 任务时置 idle，仍持有新 attempt 的成员保持 working。 | 已修复 |
| S-PAT-030 | P3 | `patent-teams/src/member-runtime.ts:211-213` | 孤儿成员写 retired 名单失败时静默吞掉；子会话仍可被列出或冷恢复且无诊断。 | 失败时 `logger.warn` 记录成员 id 与原因，原始持久化错误继续上抛。 | 已修复 |
| S-PAT-031 | P3 | `patent-workflow/src/workflow.ts:603-620` | 稀疏阶段或幽灵回退目标让主循环提前收尾，结果只覆盖部分阶段，但 `completed` 仍为 true、摘要写「1/1 阶段完成」。 | `completed` 要求结果覆盖全部阶段；摘要追加未执行阶段数。 | 已修复 |

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

### B7 实施记录

用户确认「全部修复并补回归」后，S-PAT-023…031 与两处 L0 已全部落地，详见 [02-batches/B7.md](02-batches/B7.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-023 | 双语 README 的 `draft_review` 回退上限改为三次。 | `test:docs` 的翻译配对与文档标准 |
| S-PAT-024 | 双语 README 的原子计数改为 41 个不同原子、32 个核心原子。 | 同上 |
| S-PAT-025 | `fromJSON` 校验可选头字段、时间戳、`currentStageId`、阶段 `atom`/`params` 与三个字符串数组；新增两个私有谓词。 | `patent-workflow/tests/flexible-plan.spec.ts`：合法 atom/params 与可选字段往返、六类头字段与七类阶段集合的非法快照 |
| S-PAT-026 | `claim_task` 的工具/参数描述与服务 JSDoc 指向 `reassign_task(assignee="captain")`；重生成双语工具目录。 | `verify-tool-catalog`、`verify-translation-pairing`；既有拒绝路径用例不变 |
| S-PAT-027 | 接受 `completed` 时删除 `gateFeedback`，保留 `gateRejections`。 | `patent-teams/tests/service.spec.ts`：完成后记录与 status 均无 `gate_feedback`，`gate_rejections` 仍为 1；打回中仍带 `gate_feedback` |
| S-PAT-028 | `updateTask` 读取任务后拒绝 `reassigning === true`；`invalidateTaskAttempt` 返回 handoff id，`reassignTask` 用 `activeHandoffs` 拒绝进行中的二次改派并恢复崩溃遗留标记。 | `service.spec.ts`：成员与队长在改派中更新均被拒绝；进行中 handoff 拒绝二次改派；遗留 handoff 可恢复 |
| S-PAT-029 | 回滚发现 attempt 被替换时，仅在成员无在办任务且为 working 时置 idle。 | `scheduler.spec.ts`：新 attempt 仍占任务时保持 working；任务被放回共享池后置 idle |
| S-PAT-030 | 孤儿成员 retired 名单写入失败时记录 `logger.warn`，原始错误继续上抛。 | `service.spec.ts`：只读目录下告警包含孤儿成员 id |
| S-PAT-031 | `completed` 要求结果覆盖全部阶段；非中断摘要追加未执行阶段数。 | `workflow.spec.ts`：稀疏阶段、并行后空洞、幽灵回退目标三处改为 `completed: false` 并核对摘要 |

## B8 服务接缝（patent-rule、patent-law）

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-032 | P3 | `patent-rule/src/index.ts:319-325` | `Config.citationGate` 的 JSDoc 仍写「民法典和民事诉讼法走 legal-law 索引」；该修复后门禁实际索引四部法（另含劳动合同法、公司法），并跳过未索引法名。部署方据此会误判哪些民事引用会被核验。 | 改为「`INITIAL_LAW_NAMES` 的四部法」并列出名字。 | 已修复 |
| S-PAT-033 | P3 | `patent-law/src/lineage.ts:218-236`、`:104-120` | 沿革加载器不校验 `revisionHistory[].revision` 是否在 `revisions` 中，也不校验日期升序；`queryArticleAtDate` 对乱序历史提前 `break`，`queryDiffBetween` 对拼错 id 静默返回空。`lineageDir` 是受支持的覆盖项，属持久化边界。 | 加载期校验修订 id 归属、日期与目录一致、目录与历史严格升序；补五类用例。 | 已修复 |
| S-PAT-034 | P3 | `patent-law/src/rule-lock.ts:76`、`:120-130`、`:310-313` | `rule_lock_as_of` 被声明为判定时间点并读入，但 `queryValidity`/`decideValidity` 从不使用；传入 `1985-06-01` 仍报「现行有效（生效：2021-06-01）」。`ValidityQuery.asOf` 的注释本身写的是 reserved。 | 原子不再声明或读取该键；保留 `DEFAULT_RULE_LOCK_AS_OF_KEY` 与 `lockProvisions` 的 `asOf` 为公开保留面并写明未用。 | 已修复 |

### B8 实施记录

用户确认「全部修复并补回归」后，S-PAT-032…034、三处 L0 与 L1（`guideline-view.ts` 抽取）已全部落地，详见 [02-batches/B8.md](02-batches/B8.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-032 | `Config.citationGate` JSDoc 列出四部法并说明索引外民事法名跳过。 | `test:docs` 的文档标准与翻译配对 |
| S-PAT-033 | `readRevisions` 校验目录升序；`readArticleLineages` 校验历史修订 id、生效日一致与历史升序。 | `patent-law/tests/lineage.spec.ts`：合法快照、目录乱序、历史未知 id、历史日期不一致、历史乱序 |
| S-PAT-034 | `ruleLockAtom.inputSchema` 只保留 `rule_lock_provisions`；handler 不再读取 `rule_lock_as_of`；原子描述、模块注释与双语 README 写明时间点回溯未实现。 | `patent-law/tests/rule-lock.spec.ts`：原子输入集合、忽略 `rule_lock_as_of`、`asOf` 不改变判定 |
| S-PAT-B8-1 | 新增私有 `guideline-view.ts`，`verify.ts` 保留缓存包装，`citator.ts` 直接调用。 | 既有 `verify.spec.ts`、`citator.spec.ts`、`branches.spec.ts` |

## B9 patent-tools 检索与数据

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-035 | P2 | `patent-tools/src/tool/matter-log-append.ts:265-273`、`:346-381`、`:145-164` | `changes`/`note` 原样拼入单行条目，`artifacts`/`supersedes` 以 `、` 连接，写入前不校验换行或分隔符。探针传入含换行的 `changes` 后，附加行被 `parseMatterEntries` 读成第二条结构化条目，可伪造交付/取代记录；该日志是案卷唯一事实源。 | `matterLogDefects` 增加单行、路径分隔符与审批人分隔符校验，以稳定 rule id 拒绝；补多行与分隔符用例。 | 已修复 |
| S-PAT-036 | P3 | `patent-tools/src/tool/patent-pdf-download.ts:649-671`、`patent-pdf-download-transfer.ts:52-108` | 取消只由 `runGoogleLeg` 的 catch 转成 `tool_aborted`；fetch 兜底把 `network_abort` 当普通失败，随后仍调用 PatSnap 并正常返回 `status: failed`。探针在兜底 fetch 中取消后，调用方收到结果而不是 `tool_aborted`。 | 在 Google 腿、首次 fetch 与兜底腿之后检查 `exec.signal.aborted` 并抛 `tool_aborted`；补取消用例。 | 已修复 |
| S-PAT-037 | P3 | `patent-tools/src/tool/patent-pdf-download-transfer.ts:147`、`patent-pdf-download.ts:644-648` | 首次 fetch 把整体预算按尝试次数均分，兜底下载却把整份 `timeoutMs` 作为每次尝试期限，再由 `networkFetch` 重试。探针：`timeoutMs=300`、重试 2 次实际耗时 916ms。 | 兜底下载同样按 `1 + maxRetries` 均分预算；补预算用例。 | 已修复 |
| S-PAT-038 | P3 | `patent-tools/src/tool/patent-pdf-download-transfer.ts:141-160` | `warnings.push` 位于 `Promise.all` 的并发回调内，多条兜底成功时顺序取决于完成顺序；探针中 A2 先于 A1 写出。模型可见输出与会话记录不确定。 | 并发回调返回 `{ item, warning }`，完成后按请求顺序汇总。 | 已修复 |
| S-PAT-039 | P3 | `patent-tools/src/tool/patent-legal-status.ts:153-177` | `needsCniprRetry` 不区分国别，工具描述限定中国号；探针中 `US1A` 失败后 CNIPR 收到 `["US1A"]`，通道不可用时还会对非中国号报「CNIPR 不可用」。 | 只重查 `^CN` 号；无中国号时 consult 记为 `skipped` 并写明原因；补非中国号用例。 | 已修复 |
| S-PAT-040 | P3 | `patent-search.ts:230,428-429`、`patent-metadata.ts:190,488-489`、`patent-legal-status.ts:186`、`patent-case-search.ts:192,212`、`patent-corpus-status.ts:69`、`patent-pdf-download.ts:526`、`patent-pdf-download-ego.ts:161`、`patent-pdf-download-transfer.ts:99,137` | 非 `Error` 抛值按 `String(value)` 渲染，带 `message` 的对象变成 `[object Object]`；探针中 `throw {message:'socket hang up'}` 后通道原因为 `[object Object]`。 | 统一改用 `errorMessage`，删除两份本地 `thrownMessage`。 | 已修复 |

### B9 实施记录

用户确认「全部修复并补回归」后，S-PAT-035…040 与 L1（`patent-wiki-search` 限额归一）已全部落地；`MANIFEST.sha1` 保留并单列。详见 [02-batches/B9.md](02-batches/B9.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-035 | `matterLogDefects` 新增 `multiline_field`、`ambiguous_path`、`ambiguous_approver`；`changes`/`note` 禁止换行，路径禁止 `|`/`、`/换行，审批人禁止 `|`/换行；工具描述同步。 | `patent-tools/tests/matter-log-append.spec.ts`：三类 rule、自由文本保留 `|`/`、`、多行注入被拒且日志不变 |
| S-PAT-036 | `ensureNotAborted` 在 Google 腿、首次 fetch 与兜底腿后检查信号；已取消调用抛 `tool_aborted`，不再调用兜底通道。 | `patent-pdf-download.spec.ts`：兜底 fetch 中取消 → `tool_aborted`，`resolveFallback` 未被调用 |
| S-PAT-037 | 兜底下载按 `1 + maxRetries` 均分 `timeoutMs`；默认重试次数提取为 `DEFAULT_FALLBACK_RETRIES`。 | `patent-pdf-download-transfer.spec.ts`：300ms 预算、2 次重试在 600ms 内收敛 |
| S-PAT-038 | 并发回调返回 `{ item, warning }`，按 failures 顺序生成 warnings。 | `patent-pdf-download-transfer.spec.ts`：US1A 慢于 US2A 时告警仍按 US1A、US2A 排列 |
| S-PAT-039 | `retryThroughCnipr` 先按 `^CN` 过滤；无中国号时 `skipped`，并区分通道未接线；双语 README 改为「中国号」。 | `data-tools.spec.ts`：非中国失败号不咨询 CNIPR；中国号无通道时仍 `skipped` |
| S-PAT-040 | 七处工具改用 `errorMessage`；删除 `patent-search`/`patent-metadata` 的 `thrownMessage`。 | `data-tools.spec.ts`、`patent-pdf-download-transfer.spec.ts`：对象抛值按 `message` 渲染且不含 `[object Object]` |
| S-PAT-B9-1 | `patent-wiki-search` 改用共享 `resolveResultLimit`。 | `data-knowledge.spec.ts`：`limit: 2.9` 归一为 2 |
| S-PAT-B9-2 | 两份 `thrownMessage` 并入 S-PAT-040 的 `errorMessage`。 | 同上 |
| S-PAT-B9-3 | `MANIFEST.sha1` 每次下载后重读整份 PDF 计算但无读者；续传只比对 `size`。按 L2 保留，记入收口决策。 | 未改 |

## B10 patent-tools 撰写与校核

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-041 | P2 | `patent-tools/src/tool/draft-specification.ts:491`、`draft-claims.ts:128` | 必填名称只校验类型，不校验空白。探针：`title: '   '` 且其余字段齐全时 `complete: true`，渲染出 `**说明书草案（）**` 与「本发明公开了一种…关键词：」；`invention_name: '   '` 生成「一种，其特征在于，包括：壳体。」且无 warning。 | 工具 `execute` 用 `requireNonBlankText` 拒绝空白 `title` / `invention_name`，返回 `invalid_tool_input`；补工具边界用例。 | 已修复 |
| S-PAT-042 | P3 | `patent-tools/src/tool/spec-abstract.ts:26`、`:35-47` | 摘要标号检测把「方案1，」读成未加括号的附图标记并报 error，引用整段「本发明提供方案1」；`spec-style` 与 `spec-description-extras` 的程序性标签词表都已排除「方案」。 | `NON_MARK_NAME` 的后缀分支补 `方案`、`方式`；补不误报与仍报真标号用例。 | 已修复 |
| S-PAT-043 | P3 | `patent-tools/src/tool/spec-blocks.ts:232-245` | 调用方传入已带标题的实施例时，渲染器再补 `实施例N：`，输出「实施例1：实施例1：采用新结构。」；既有用例只断言子串包含，未发现重复。 | 正文已以实施例标签开头时不再补前缀；补单次出现断言。 | 已修复 |
| S-PAT-044 | P3 | `patent-tools/src/tool/amendment-reserve.ts:249`、`draft-specification.ts:278-282` | 只给权利要求、未给 `source_text` / `technical_solution` 时，空原文被读成「原文没有替代」，返回 `failed` 并为每条独权产生三个 `missing` 缺口与定位警告。 | 原文为空且权利要求可解析时返回 `not-assessed`，不产生缺口与警告。 | 已修复 |
| S-PAT-045 | P3 | `patent-tools/src/tool/spec-style.ts:88-126` | 重复的规定章节标题无人检测。探针：两个 `## 技术领域`（都有正文）时 `checkHeadingSet`、`checkSectionOrder` 与 `validateSpecification` 全部零违规。 | `checkHeadingSet` 增加 `heading_duplicate` error，列出重复标题并定位。 | 已修复 |
| S-PAT-046 | P3 | `patent-tools/src/tool/claim-chart-build.ts:281-286` | `risk.remedyExposureRatio` 只校验 `typeof number`；传 `1.5` 时内核 `scoreInfringement` 抛裸 `RangeError`，工具返回只有 message、没有 `info.code` 的错误。 | 解析层校验有限且 0–1，抛 `invalid_tool_input`；用例断言错误码。 | 已修复 |
| S-PAT-047 | P3 | `patent-tools/src/tool/draft-specification.ts:139-166`、`:222` | 实用新型草案仍写「本发明涉及…」「本发明要解决的技术问题…」「本发明公开了…」，与申请类型不一致。 | 按 `patent_type` 选择「本实用新型」/「本发明」，覆盖技术领域、发明内容与摘要。 | 已修复 |

### B10 实施记录

用户确认「全部修复」后，S-PAT-041…047 与 F-PAT-086、F-PAT-087 已全部落地，详见 [02-batches/B10.md](02-batches/B10.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-041 | `draft_specification` 与 `draft_claims` 在 `execute` 拒绝空白必填名称；错误码 `invalid_tool_input`。 | `drafting-engine.spec.ts`：空白 title / invention_name 各一条工具边界用例 |
| S-PAT-042 | `NON_MARK_NAME` 后缀补 `方案`、`方式`。 | `spec-abstract.spec.ts`：方案1、方式2 不报，壳体1 仍报 |
| S-PAT-043 | `renderEmbodimentBlocks` 以实施例标签开头的正文不再补前缀。 | `draft-specification-blocks.spec.ts`：具体实施方式中「实施例1：」恰好一次 |
| S-PAT-044 | `buildAmendmentReserve` 在原文为空时返回 `not-assessed`。 | `amendment-reserve.spec.ts`：空原文无缺口、无定位警告、无实施例索引 |
| S-PAT-045 | `checkHeadingSet` 统计重复标题并报 `heading_duplicate`。 | `spec-style.spec.ts`：重复技术领域报 error 并定位 |
| S-PAT-046 | `parseConclusionInput` 校验 `remedyExposureRatio` 为 0–1 的有限数。 | `drafting-engine.spec.ts`：`1.5` 返回 `invalid_tool_input` |
| S-PAT-047 | 技术领域、发明内容、摘要按 `patent_type` 使用「本实用新型」。 | `drafting-engine.spec.ts`：实用新型草案含本实用新型、不含本发明 |
| F-PAT-086 | `STANDARD_REFERENCE` 区分标准代号与裸「标准」；非专利文献分支按该词表放行。 | `spec-description-extras.spec.ts`：裸标准、GB/T 代号、标准号均不报 |
| F-PAT-087 | `notAssessedItems` 增加 `smiles-validity`；描述、双语 README、工具目录与快照 pin 同步。 | `validate-specification.spec.ts`：化学域、显式 SMILES、机械域三条断言 |

## B11 patent-tools 分析与附图

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| S-PAT-048 | P3 | `patent-tools/src/figure/freecad-section-script.ts:94`、`freecad-hatch-script.ts:82`、`freecad-structure-script.ts:316` | 三处脚本构建器用字符串参数调用 `String.replace('__PAYLOAD_LITERAL__', payload)`，替换值里的 `$&`、`$'`、`` $` `` 会被当作替换模式展开。探针：`modelPath` 含 `$&` 时内嵌 JSON 变成 `__PAYLOAD_LITERAL__`，含 `$'` 时 JSON 被截断，Python 侧 `json.loads` 失败；路径含这些字符的模型无法剖切/打剖面线/投影。 | 替换值改用函数返回（`() => payloadLiteral`），三处同改。 | 已修复 |
| S-PAT-049 | P3 | `patent-tools/src/figure/dot-builder.ts:515`、`:625` | 流程图与框图只按原始 id 建索引，`a b` 与 `a_b` 经 `sanitizeId` 都变成 `a_b` 后输出两条同 id 节点声明，后者覆盖前者且后继/连接指向合并后的节点。层级图与状态图已在遍历时拒绝重复 id。 | 新增 `assertUniqueIds`，在两个 builder 分配标号前按规范化 id 去重并抛 `DotBuildError('unknown_id')`。 | 已修复 |
| S-PAT-050 | P3 | `patent-tools/src/figure/freecad-renderer.ts:304`、`:354` | 结构投影脚本在交付目录写 `.freecad-structure-template.svg` 与 `.freecad-transient`，渲染结束只清 `.freecad-home` 与 `.py`。真实 FreeCAD 渲染后模板 SVG 留在输出目录，与交付图混在一起。 | `FreeCadScriptRequest` 增加 `cleanupPaths`，结构链路传入模板与 transient 目录，`finally` 内递归清理。 | 已修复 |
| S-PAT-051 | P3 | `patent-tools/src/atoms/slop-gate.ts:156` | 实施例块超预算但总分过线时 `passed` 为 false，报告写「需修订」，提示却只在 `!score.passed` 时生成，回退重写没有篇幅方向。探针：总分 35、实施例 200/50 时无 `slop_revision_hint`。 | 只要 `!passed` 就组装提示；总分提示与逐块超预算明细（序号、字数、上限）合并。 | 已修复 |
| S-PAT-052 | P3 | `patent-tools/src/figure/dot-builder.ts:320` | `resolvePageBundle` 只检查 `marginCm <= 0`，`NaN` 比较为 false 直接放行；A4 + 100cm 边距也放行并输出 `size="-70.47,-67.05"` 与 `margin="NaN,NaN"`，交给 Graphviz 的页面尺寸无效。 | 边距改查 `Number.isFinite` 与正数；同时给 `pageSize` 时要求两倍边距小于页面短边，否则 `invalid_page`。 | 已修复 |
| S-PAT-053 | P3 | `patent-tools/src/figure/svg-to-dxf.ts:72` | `scanSvg.unmeasured` 记录 marker 端头、CSS 样式、未展开引用等未量测原因，`svgToDxf` 只转述填充与曲线降级。探针：带 `marker-end` 的箭头 SVG 转换成功但 `warnings` 为空，调用方会把「缺箭头墨迹」当成几何完整。 | 把剩余 `unmeasured` 原因并入 `warnings`；已导致拒绝的 viewBox/变换原因在此之前已抛出。 | 已修复 |
| S-PAT-054 | P3 | `patent-tools/src/figure/plot-diagram.ts:327` | 画布只校验正有限数，不校验扣除左右边距、下轴带与图例后是否仍有绘图区。探针：20×20mm 得到 `plotWidth=-10`，横轴落在 x=22 的画布外；多序列图例还会继续吃掉高度。 | 计算后要求 `plotWidth > 0` 且 `plotHeight > 0`，否则 `invalid_input` 并说明是宽度还是高度不足。 | 已修复 |

### B11 第一轮遗留落地

| ID | 级别 | 位置 | 证据与影响 | 最小修复 | 状态 |
|---|---|---|---|---|---|
| F-PAT-078 | P3 | `patent-tools/src/tool/internal/invalidity-json.ts`、`tool/claim-chart-build.ts` | `claimNo` 缺失或非法时一律回退 0，而权项从 1 起编号；损坏/旧版记录以「权项 0」进入模型可见报告，无法与合法数据区分。 | 读取层把 `claimNo`、`referredClaimNo` 与成环 `claimNos` 校验为正整数；非法条目丢弃并记录 `{path, reason}`。`claim_chart_build` 在结论后追加「读取缺陷」小节。 | 已修复 |
| F-PAT-079 | P2 | `patent-tools/src/internal/index-store.ts:104-122` | 按文件路径的 Promise 队列只覆盖单进程；两个进程并发 upsert 时各自读同一份 `entries`，后写者覆盖前者且无告警。 | upsert 先建父目录，再在 `withFileLock` 内无条件重读磁盘、合并、原子写回；进程内队列保留用于同实例排序。 | 已修复 |

### B11 实施记录

用户确认「全部修复 + F-PAT-078/079」后，7 条新发现与两项遗留全部落地，详见 [02-batches/B11.md](02-batches/B11.md)。

| ID | 实施要点 | 回归测试 |
|---|---|---|
| S-PAT-048 | 三处 payload 替换改为函数返回。 | 三个 FreeCAD 脚本 spec：`$&`、`$'`、`` $` `` 路径往返一致 |
| S-PAT-049 | 流程图/框图按规范化 id 去重。 | `figure-dot-builder.spec.ts`：`a b` 与 `a_b` 均抛 id 重复 |
| S-PAT-050 | 结构渲染清理模板与 transient 目录。 | `figure-freecad-renderer.spec.ts`：子进程写出两者后均被删除；真实 FreeCAD 全套通过 |
| S-PAT-051 | 超预算实施例写入证据型提示。 | `slop-gate.spec.ts`：总分过线、实施例 1501/1500 时提示含明细 |
| S-PAT-052 | 页边距有限性与页面适配校验。 | `figure-dot-builder.spec.ts`：NaN/Infinity、A4 10.51cm/100cm 拒绝，10cm 放行 |
| S-PAT-053 | `svgToDxf` 透传未量测原因。 | `figure-svg-to-dxf.spec.ts`：marker 端头警告出现 |
| S-PAT-054 | 曲线图最小绘图区校验。 | `figure-plot-diagram.spec.ts`：过窄、过矮、图例吃掉高度三种输入拒绝 |
| F-PAT-078 | 读取层丢弃非法 claimNo 并记录缺陷。 | `invalidity-json.spec.ts`：非法 novelty/distinguishing/从属/引用条目被丢弃，缺陷路径逐条断言 |
| F-PAT-079 | `withFileLock` 包裹 upsert 并在锁内重读。 | `index-store.spec.ts`：两个独立 store 并发 upsert 均保留，锁文件清理 |
