# 专利域全量审阅：发现清单

编号接续上级计划的 `F-PAT-058`，本条专档从 `F-PAT-059` 起。每条发现写清位置、证据、影响、最小修复建议、工作量与自动化可行性。

## F-PAT-059 patent-data 运行时导入未声明运行时依赖（复核为误报，已回退）

- 结论：**不成立**。已回退，提交主题为 `Revert "fix(patent-data,patent-document): declare dsh-value as a runtime dependency"`。
- 原始判断：`packages/patent/patent-data/src/cnipr-receipt.ts:1` 运行时 `import { asRecord } from '@deepseek-ai/dsh-value'`，而 `package.json` 只在 `devDependencies` 声明，判定发布安装无法解析。
- 复核证据：tsdown 会把**未在运行时依赖段声明**的导入内联进产物。主检出已构建的 `packages/patent/patent-data/lib/index.js` 里，该包只剩一处 JSDoc 注释，`asRecord` 以本地函数形式存在，没有任何裸 `import`。同一产物中 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/nuo-patent`、`@deepseek-ai/dsh-patent-core` 都以 `import ... from "..."` 形式外置——规则是「已声明则外置，未声明则打包」。
- 影响：原判不存在。把该依赖移入 `dependencies` 会让它转为外置，改变分发形态而无收益。
- 教训：源码层的「运行时导入必须声明在运行时段」不能单独作为判据；只有构建产物能区分「已内联」与「被外置」。判据改为产物级，见 F-PAT-063。

## F-PAT-060 patent-document 运行时导入未声明运行时依赖（复核为误报，已回退）

- 结论：**不成立**。已回退，提交主题为 `Revert "fix(patent-data,patent-document): declare dsh-value as a runtime dependency"`。
- 原始判断：`documentCompliance.ts:21` 与 `paragraphNumbering.ts:13` 使用 `escapeRegExp`，`package.json` 只在 `devDependencies` 声明。
- 复核证据：与 F-PAT-059 同因。构建产物中该依赖被内联，发布安装可正常加载。
- 教训：同 F-PAT-059。

## F-PAT-061 patent-tools 两个导出函数缺 JSDoc 参数与返回值

- 位置：`packages/patent/patent-tools/src/tool/patent-metadata.ts:290`（`renderMetadata`）、`packages/patent/patent-tools/src/tool/patent-search.ts:266`（`renderSearch`）。
- 维度：代码质量。
- 严重度：P2。
- 证据：`pnpm run verify-export-jsdoc` 退出码 1，报 4 条违规（各缺 `@param value` 与 `@returns`）；这是专档建立时的基线红。
- 影响：导出契约不完整，违反 AGENTS.md 的 JSDoc 要求；也让该门禁失去回归价值。
- 最小修复：补 `@param value - ...` 与 `@returns ...`。
- 工作量：5 分钟。可自动化：否。
- 状态：已修（2026-11-27，B0）；复跑退出码 0。

## F-PAT-062 verify-npm-install-layout 超出解析工作量预算

- 位置：`scripts/verify-npm-install-layout.ts:34`（`MAX_RESOLUTION_WORK_UNITS = 1_134_400`）。
- 维度：代码质量（门禁基线）。
- 严重度：P2。
- 证据：退出码 1，报 391 个包 × 3974 条内部边 = 1,553,834 单位，超预算 419,434 单位。该计量只统计 `dependencies`/`optionalDependencies`/`peerDependencies`，与专利域无关，是既有红。
- 影响：该门禁目前不提供信号。
- 最小修复：实测后上调预算常量，或先查清 3974 条边里哪些可合并。
- 工作量：0.5–1 小时。可自动化：部分。
- 状态：未修，待决策（是否上调预算属仓库级策略）。

## F-PAT-063 纯 Host 包没有产物级依赖门禁（已修）

- 位置：`scripts/verify-package-dependencies.ts` 的包选择范围；新增 `scripts/verify-published-imports.ts`。
- 维度：无断链。
- 严重度：P1。
- 证据：`readPackageDependencyState` 实测只产出 110 个包的 facts，且全部是带 Client 面的包（`client-host` 103、`client-only` 5、`configured-host` 2）；`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-patent-data` 等纯 Host 包不在其中。因此该门禁的比较逻辑没有问题，问题在管辖范围：纯 Host 包的发布入口没有任何门禁检查。
- 影响：Host 包若真的把某个依赖外置却未声明，只在消费者安装后才暴露，仓库侧无信号。
- 最小修复：新增产物级门禁，扫描每个 Host 包 `main` 入口的裸 import，要求全部落在 `dependencies`/`peerDependencies`/`optionalDependencies`；Client 组按策略跳过。
- 实测：365 个 Host 入口，0 违规。唯一例外是 `dsh-experimental-webworker-runtime` 的 3 个 `require`，它们经包内 VFS module loader（`loader.requireFrom(root)`）从镜像解析而非 node_modules，已显式豁免并写明理由。
- 配套：`scripts/verify-published-imports.spec.ts` 4 条用例，其中 3 条为负控制（未声明依赖、Client 组跳过、缺失构建入口）。
- 工作量：2 小时。可自动化：是。
- 状态：已修（2026-11-27）；门禁登记在 `ciPrimaryGates()`，`needs: ['build']`。

## F-PAT-064 规则引擎全通过报告被拼成一行（B2）

- 位置：`packages/patent/patent-core/src/checker/engine.ts:444`（`formatRuleResults`）。
- 维度：正确性与边界 / 模型可见输出。
- 严重度：P2。
- 证据：非空的失败分支用 `lines.join('\n')`，而「全部通过」分支用 `lines.join('')`，标题、结论与正文因此连成一串：`## 规则引擎检查检查结论: ✅ 通过所有规则检查均通过。`。既有测试只断言子串 `所有规则检查均通过`，拼接错误未被发现。
- 影响：规则检查全部通过时，返回给模型的 Markdown 报告结构损坏。
- 最小修复：改为 `join('\n')`；测试补一条按行断言标题与结论各占一行。
- 工作量：5 分钟。可自动化：是。
- 状态：已修（2026-11-27，B2）。patent-core 95 文件 / 1873 用例通过。

## F-PAT-065 节点硬上界在临界毫秒被静默取消（B2）

- 位置：`packages/patent/patent-core/src/graph/node-policy.ts:75`（`runNodeWithPolicy` 的 `withDeadline` 调用）。
- 维度：正确性与边界（并发/超时）。
- 严重度：P2。
- 证据：`withDeadline(promise, ms)` 在 `ms <= 0` 时返回原 promise（用于「无截止」语义）；而调用点传入的 `remaining = Math.max(0, deadline - Date.now())` 在截止前最后一毫秒可算出 0，此时硬上界被关闭。若节点不响应 abort 信号，图执行会无限挂起——而硬上界存在的目的正是兜住这种节点。
- 影响：极窄时间窗下的挂死风险；正常路径不受影响。
- 最小修复：有截止时按 `Math.max(1, remaining)` 传参，保留「无截止传 0」的语义。
- 工作量：5 分钟。可自动化：否（毫秒级竞态，测试只能覆盖时序）。
- 状态：已修（2026-11-27，B2）。

## F-PAT-066 充分公开子图把数组当字符串读，缺失章节被说成「无缺失」（B2）

- 位置：`packages/patent/patent-core/src/graph/domains/enablement.ts`（`completeness` 与 `conclude` 的提示词拼装）。
- 维度：正确性与边界 / 模型可见输入。
- 严重度：P2。
- 证据：`load` 节点把 `spec_sections_missing` 与 `domain_rules` 节点把 `domain_requirements` 都写成 `string[]`；提示词用 `getStateString` 读取，而该函数对非字符串返回空串。于是完整性提示词恒显示「（无缺失）」——把确定性检测到的缺失章节反过来告诉模型「没有缺失」；领域特殊要求则整段消失。
- 影响：两个确定性节点的产出对模型不可见，A26.3 审查的结构完整性输入被一条恒真的假阴性覆盖。
- 最小修复：改用 `getStateArray(...).join(...)`。
- 工作量：10 分钟。可自动化：是。
- 状态：已修（2026-11-27，B2）；新增用例喂入缺章节的说明书，断言提示词含缺失章节名与领域要求。

## F-PAT-067 数值范围节点的 LLM 调用不转发取消信号（B2）

- 位置：`packages/patent/patent-core/src/graph/domains/novelty.ts`（`numericRangeNode`）。
- 维度：正确性与边界（并发/取消）。
- 严重度：P2。
- 证据：该节点只解构 `{ state, provider }`，调用 `provider.callLLM(prompt, opts)` 时缺少第三个 `signal` 参数；`shared.ts` 的 `llmNode` 与子图其它 LLM 路径都会传。
- 影响：图被取消时，在途的数值范围判定请求不会被中止，调用方要等到该请求自己结束；无节点策略时没有硬上界兜底。
- 最小修复：解构 `signal` 并作为第三个实参传递。
- 工作量：5 分钟。可自动化：部分。
- 状态：已修（2026-11-27，B2）。

## F-PAT-068 证据权重只校验 typeof，NaN 与负数直接进入加权平均（B3）

- 位置：`packages/patent/patent-core/src/evidence/rule-set.ts`（`weights` 读取）；消费方 `evidence/judgment.ts` 的 `computeOverallScore`。
- 维度：正确性与边界（配置边界）。
- 严重度：P2。
- 证据：三个权重用 `typeof value === 'number'` 判定；YAML 可写 `.nan` / `.inf` 与负数，全部通过。`computeOverallScore` 只兜底 `weightSum === 0`：NaN 权重使 `total / weightSum` 与 `Math.min(1, base)` 均为 NaN，负权重可把综合分压成负数，随后 `confidence` 的阈值比较静默失真。
- 影响：部署侧改坏一个权重字段，整条证据链的综合分变成 NaN 而不报错。
- 最小修复：权重要求有限非负，否则回退默认值并累积警告；同级的分级分数也加 `Number.isFinite`。
- 工作量：15 分钟。可自动化：是。
- 状态：已修（2026-11-27，B3）；用例覆盖 `.nan` 与负数两种写法。

## F-PAT-069 文本日期提取把任意 8 位数字当日期（B3）

- 位置：`packages/patent/patent-core/src/evidence/date.ts`（`extractDateFromText`）。
- 维度：正确性与边界。
- 严重度：P2。
- 证据：`\d{8}` 无边界约束。中国申请号是 12 位（如 `202310123456`），正则从第 1 位截出 `20231012`，`parseDateFlexible` 以 `yyyyMMdd` 接受，于是申请号被当成公开日，并据此计算 `isPriorArt`。
- 影响：使用公开类证据的日期认定与现有技术判定被污染。
- 最小修复：8 位分支加零宽断言 `(?<!\d)\d{8}(?!\d)`。
- 工作量：5 分钟。可自动化：是。
- 状态：已修（2026-11-27，B3）。

## F-PAT-070 调用方取消后内部计时器未清除，超时判定被污染（B3）

- 位置：`packages/patent/patent-core/src/subprocess-deadline.ts`（`onCallerAbort`）。
- 维度：正确性与边界（并发/取消）。
- 严重度：P2。
- 证据：`onCallerAbort` 只 `controller.abort()`，计时器要到 `dispose()` 才清除。子进程收尾慢于剩余超时时，计时器仍会触发并把 `timedOut` 置真，`timedOut()` 于是把用户主动取消报成内部超时。既有用例只在取消后立刻查一次，没有推进时间，因此没抓到。
- 影响：错误文案与错误归类出错（取消被当作超时）。
- 最小修复：`onCallerAbort` 内一并 `clearTimeout(timer)`；用例推进到超时点之后再断言。
- 工作量：10 分钟。可自动化：是。
- 状态：已修（2026-11-27，B3）。

## F-PAT-071 事实黑板反序列化不校验，损坏记录抛原始 TypeError（B3）

- 位置：`packages/patent/patent-core/src/reasoning/fact-blackboard.ts`（`FactBlackboard.fromJSON`）。
- 维度：正确性与边界（持久化边界）。
- 严重度：P2。
- 证据：`JSON.parse(text) as {...}` 后直接 `for...of data.facts` 等四个数组。字段缺失或类型错误时抛 `TypeError: undefined is not iterable`，恢复方拿不到「这是损坏记录」的信号；同级 `patent-workflow` 的 `flexible-plan.ts` 是逐字段校验并抛领域错误的。
- 影响：外部消费者从损坏记录恢复时得到无信息的崩溃。
- 最小修复：顶层用 `isJsonRecord` 判定，四个数组逐个断言，错误信息点名坏字段。
- 工作量：15 分钟。可自动化：是。
- 状态：已修（2026-11-27，B3）；新增损坏记录用例。说明：该方法当前无生产消费者，仅公开 API 的健壮性加固。

## F-PAT-072 清晰度评分的模糊词表按子串匹配，误伤合法术语（B3，待决策）

- 位置：`packages/patent/patent-core/src/analysis-report/build.ts`（`FUZZY_TERMS` 与 `computeClarityScore`）。
- 维度：正确性与边界（模型可见输出）。
- 严重度：P2。
- 证据：`claim.includes(term)` 逐词子串匹配。「约束」「约定」「节约」含「约」，「左右两侧」「左右对称」含「左右」，均被计为模糊限定词：每个词扣 5 分，并在报告里写明「检出模糊限定词：约」。
- 影响：机械类权利要求常见写法被系统性误判，清晰度评分与理由都失真。
- 可能的修复方向：把判定改成带上下文的模式（「约」限定在数值前后、「左右」要求前接数值或单位），或改为排除已知复合词。
- 工作量：0.5 小时（含口径确认）。可自动化：是。
- 状态：**未修，待决策**。中文没有词边界，改判定就是改领域口径；这一项属于代理师判断，不擅自调整。

## F-PAT-073 缓存包装器丢弃 timeout 与 signal，工具声明的超时形同虚设（B4）

- 位置：`packages/patent/patent-data/src/patent-cache.ts`（`cachedScrapePatent` / `cachedSearchPatents`）；受影响工具 `patent_metadata`、`patent_search`、pdf 下载的无浏览器腿。
- 维度：无断链 / 正确性与边界（取消与超时）。
- 严重度：P2。
- 证据：两个包装器只透传 `limit` 或 `returnAbstract/returnLegal`，`cachedScrapePatent` 的入参类型里根本没有 `timeout`/`signal`。而 `patent_metadata` 的 schema 公开了 `timeout`（默认 30000）并在 execute 里传了 `{timeout, signal}`——生产路径走缓存包装器，两个字段在运行时被静默丢掉：调用方设 5 秒，引擎仍按自带 30 秒走；取消信号到不了底层 fetch。
- 影响：一个文档化的参数完全无效；取消要等引擎默认超时（最坏三次重试约 90 秒）才收敛。
- 最小修复：两个包装器接受并透传 `timeout`/`signal`（二者不参与缓存键）；`patent_metadata` 同时把 `exec.signal` 传给 `retryBounded`。
- 工作量：30 分钟。可自动化：是。
- 状态：已修（2026-11-27，B4）；新增两条透传用例。

## F-PAT-074 留档的「读—校验—追加」不是原子操作（B4）

- 位置：`packages/patent/patent-tools/src/tool/matter-log-append.ts`（`execute`）。
- 维度：正确性与边界（并发）。
- 严重度：P2。
- 证据：先 `readFile` 取快照，在快照上判定 `reused_artifact_path` / `forked_chain`，再 `appendFile`。两个并发留档读到同一份过期日志、都判无缺陷、各写一条：`_matter-log.md` 里同一产物被登记两次，或同一旧版出现两个后继。
- 影响：案件"唯一事实源"的取代链确定性被破坏。
- 最小修复：整段包进 `withFileLock(logPath, …)`（`@deepseek-ai/dsh-atomic-write` 已提供跨进程写者锁），锁内重读。
- 工作量：20 分钟。可自动化：部分。
- 状态：已修（2026-11-27，B4）。

## F-PAT-075 重试的退避不可中止，取消后仍会多发一次上游请求（B4）

- 位置：`packages/patent/patent-tools/src/tool/internal/bounded-retry.ts`。
- 维度：正确性与边界（取消）。
- 严重度：P2。
- 证据：`delay` 是不可中止的 `setTimeout`，循环只在退避**前**检查 `signal.aborted`。调用方在退避窗口内取消，循环仍会走完等待并再发一次尝试，与模块头「the retry never outlives the caller's patience」相反。
- 影响：取消延迟最多一个退避周期，且多一次无用上游请求。
- 最小修复：退避监听 `signal` 并提前结束，退避后复查中止状态。
- 工作量：15 分钟。可自动化：是。
- 状态：已修（2026-11-27，B4）；新增 3 条用例（含取消时不再重试）。

## F-PAT-076 PDF 下载的 timeoutMs 文案与实现口径不一致（B4）

- 位置：`packages/patent/patent-tools/src/tool/patent-pdf-download.ts`（schema 文案）。
- 维度：模型可见契约。
- 严重度：P3。
- 证据：schema 写「整体执行超时」，而实现是每腿预算：`cniprBudgetMs` 取 `max(90s, 按比例份额)`，最坏两腿各用满预算。内部注释明确承认这一点。
- 影响：模型按「整体上限」理解该参数，对实际耗时产生误判。
- 最小修复：文案改为「单腿执行预算」并写明 CNIPR 腿的 90 秒下限。
- 工作量：5 分钟。可自动化：否。
- 状态：已修（2026-11-27，B4）；同步 `docs/tool-catalog.md` 与 `patent-oa-response` 的工具 schema 快照。

## F-PAT-077 非 Error 抛值会以 `[object Object]` 进入模型可见文案（B4）

- 位置：`tool/internal/approval-gate.ts`、`tool/knowledge-note-save.ts`。
- 维度：模型可见输出。
- 严重度：P3。
- 证据：两处对未知抛值用 `String(error)`；普通对象会渲染成 `[object Object]`，审批暂停原因与保存失败文案因此不可读。
- 最小修复：统一改用 `@deepseek-ai/dsh-value` 的 `errorMessage`（对敌意抛值也有固定占位）。
- 工作量：5 分钟。可自动化：是。
- 状态：已修（2026-11-27，B4）。

## F-PAT-078 无效宣告结论的 claimNo 缺省 0，损坏字段被捏造成「权项 0」（B4，未修）

- 位置：`packages/patent/patent-tools/src/tool/internal/invalidity-json.ts`（多处 `recordNumberOr(value, 'claimNo', 0)`）。
- 维度：正确性与边界（持久化边界）。
- 严重度：P3。
- 证据：`claimNo` 缺失或非法时一律回退 0，而权利要求从 1 起编号。损坏/旧版记录会以「权项 0」进入模型可见报告，且无法与合法数据区分。
- 状态：**未修**。修法需要在读取处丢弃非法条目并记录缺陷，会改变数组长度与既有测试期望；留待下一轮与渲染侧一起处理。

## F-PAT-079 索引存储的 upsert 只在进程内串行，跨进程并发会丢条目（B4，未修）

- 位置：`packages/patent/patent-tools/src/internal/index-store.ts`（`upsert`）。
- 维度：正确性与边界（并发）。
- 严重度：P2。
- 证据：按文件路径的 Promise 队列只覆盖单进程；两个进程（或外部进程改了同一索引）并发 upsert 时各自读到同一份 `entries`，先后 rename，后者覆盖前者，被覆盖的条目静默丢失且无告警。
- 状态：**未修**。修法同样是 `withFileLock`，但该模块被附图检索与化学索引共用，需要连同其测试一起改，留待下一轮。

## F-PAT-080 部分附图未参与分析时，附图说明中的标号被判成悬空 error（B5）

- 位置：`packages/patent/patent-tools/src/tool/spec-figure-marks.ts`（`checkFigureMarkConsistency`）。
- 维度：模型可见判定。
- 严重度：P2。
- 证据：`figureMarks` 只收集 `usable` 图的组件；`unusable` 仅产生一条「分析结果不可用」warning。但 `dangling = listedMarks - figureMarks` 与权利要求括号标号照常计算，于是在没读出来的那张图上，附图说明里的标号会被报 error「附图说明中的标记 N 在附图中不存在」。
- 影响：客户只提供部分图，或某张图 OCR 失败时，校验工具给出 error 级、指向文本的缺陷结论（`passed=false`），而真实情况是数据缺口。错误方向与「不可用」提示相反。
- 最小修复：存在不可用图时跳过悬空与权利要求标号缺失判定，保留「分析结果不完整」warning。
- 工作量：10 分钟。可自动化：是。
- 状态：已修（2026-11-27，B5）；新增用例「一张可用 + 一张不可用、权利要求引用 (9)」，断言无 error 且保留不可用 warning。

## F-PAT-081 规格校验的两条数值路径完全不识别中文单位（B5）

- 位置：`spec-numeric.ts` 的 `RANGE_PATTERN`／`VALUE_PATTERN`；`spec-claim-coverage.ts` 的 `CLAIM_VALUE_PATTERN`。
- 维度：覆盖面（漏报）。
- 严重度：P2。
- 证据：共享词表 `NUMERIC_UNIT_ALTERNATION` 只有拉丁单位，而同一模块的 `NUMERIC_UNIT_SCALES` 与新颖性轨的 `HAN_UNITS` 都收了中文单位。新颖性轨先匹配数值、再从片段末尾读单位，所以读得到；规格校验要求单位紧跟数值，只能依赖 alternation。实测 `extractNumericRanges('厚度为20毫米至90毫米。')` 返回 `[]`，端点与中点两条检查静默不跑。
- 影响：中文写法是中文专利的常见形式，这些文本的数值范围检查整体失效，报告仍显示「通过」。
- 最小修复：词表新增 `NUMERIC_HAN_UNIT_ALTERNATION` 与合并串 `NUMERIC_ANY_UNIT_ALTERNATION`，两条路径改用合并串。
- 工作量：30 分钟。可自动化：是。
- 状态：已修（2026-11-27，B5）；含中文区间、中文单值、混合写法与端到端校验四类用例。

## F-PAT-082 权项特征按原文单位写法比对，10mm 与 10毫米 互判缺失（B5）

- 位置：`spec-claim-coverage.ts`（`checkClaimCoverage`）。
- 维度：正确性（误报）。
- 严重度：P2。
- 证据：特征键是 `数值 + 归一单位`，而归一函数只统一摄氏度与全角百分号，随后用 `text.includes(feature)` 在说明书中查找。权利要求写 `10mm`、说明书写 `10毫米` 时判定为「技术特征未记载」。
- 影响：error 级误报，且这类「权利要求用代号、说明书用中文」的混写在实务中很常见。
- 最小修复：两侧都按 `canonicalNumericUnit` 建键比对（说明书侧改为抽取数值后建键，不再用子串查找），不做量纲换算——`10cm` 不覆盖 `100mm`，避免用静默换算掩盖真实的数值不一致。
- 工作量：40 分钟。可自动化：是。
- 状态：已修（2026-11-27，B5）；含覆盖与未覆盖两条用例。

## F-PAT-083 权利要求引用正则漏多种实际写法（B5）

- 位置：`spec-prohibitions.ts`（`CLAIM_CITATION_RE`）。
- 维度：覆盖面（漏报，法条检查）。
- 严重度：P2。
- 证据：中间字符类只有数字、中文数字与「或／至／、／,／空白」：「如权利要求1和2所述」「根据权利要求1至3中任一项所述」「如权利要求第1项所述」「根据权利要求1-3所述」「参见上述权利要求2所述」都不匹配，而这些都属于细则第二十条第三款禁止的引用语。
- 影响：说明书引用了权利要求却报「无违规」，是法条级漏报。
- 最小修复：扩字符类（和／与／及／第／项／之／任／中、范围连接符、全角逗号），前缀允许「上述／前述」，动词补「参见」。
- 工作量：15 分钟。可自动化：是。
- 状态：已修（2026-11-27，B5）；5 种写法各一条断言，另加一条「非引用语不误报」。

## F-PAT-084 模糊词「可能」按子串匹配，误伤「尽可能」「不可能」「可能性」（B5）

- 位置：`spec-clarity.ts`。
- 维度：正确性（误报）。
- 严重度：P3。
- 证据：模块自述「按上下文而非子串匹配」，实现却是 `text.includes('可能')`。「尽可能提高精度」「不可能脱落」「失效的可能性」都会报警。另有一处位置偏差：命中后仍用 `locateMatch` 找首个出现位置，若前面出现过「尽可能」，报的行号会指到那里。
- 最小修复：改用 `(?<![尽不])可能(?!性)`；位置由匹配下标与 `locationAt` 计算，不再二次查找子串。
- 工作量：20 分钟。可自动化：是。
- 状态：已修（2026-11-27，B5）；含「三种合法用法不报」与「位置落在自身行」两条用例。

## F-PAT-085 摘要未加括号的标号检测前瞻过窄（B5，未修）

- 位置：`spec-abstract.ts`（`unparenthesizedMark`）。
- 维度：覆盖面。
- 严重度：P3。
- 证据：前瞻只认 `[，。；、\s]|$`，句中写法「壳体1设置在底座上」不报。
- 为什么不修：去掉前瞻会把「包括2个」「含有5份」读成标号，而 `QUANTITY_WORDS` 只覆盖度量名。扩字符集属于打地鼠，先要定「什么才算组件标号」的口径。
- 状态：**未修**，待决策。

## F-PAT-086 背景技术把裸「标准」当作文献引证（B5，未修）

- 位置：`spec-description-extras.ts`（`CITATION_CLAIM`）。
- 维度：正确性（误报口径）。
- 严重度：P3。
- 证据：「符合国家标准」「按行业标准设计」都会进入引证分支，再因缺少字面「标准号」报 warning。
- 为什么不修：要求补出处的方向本身正确，只是判据偏宽；是否必须写标准号需要产品口径。
- 状态：**未修**，待决策。

## F-PAT-087 SMILES 校验是空实现，且未列入未评估项（B5，未修）

- 位置：`spec-quantification.ts`（`checkSmilesValidity`）、`validate-specification.ts`（`notAssessedItems`）。
- 维度：模型可见输出。
- 严重度：P3。
- 证据：函数恒返回 `[]`（RDKit 未打包），报告里没有任何「化学结构式未核」的痕迹。
- 影响：化学领域用户会认为结构式已被检查。
- 为什么不修：需要先有可靠的 SMILES 候选抽取，否则「未评估」本身也无法给出判据。
- 状态：**未修**。

## F-PAT-088 新颖性轨把中文单位的数值区间读成两个数值点（B5 发现，属 patent-core）

- 位置：`packages/patent/patent-core/src/novelty/numeric-range.ts`（`RANGE_PATTERN`）与 `numeric-vocabulary.ts`。
- 维度：正确性（判定方向）。
- 严重度：P2。
- 证据：探针 `温度为20毫米至90毫米` 的 `extractNumericFindings` 返回 20、90、50 三个 `isPoint`。两侧都用中文单位写区间时，「权利要求 20 毫米至 90 毫米 vs 对比文件 25 毫米至 30 毫米」会判 `no_overlap`，正确结论应是覆盖（`overlapped`）。
- 为什么不随本批修：把中文单位并进共享 alternation 会改变新颖性判定输出（模型可见摘要），需要同批更新 `numeric-range` 用例与相关快照，属于独立变更。
- 状态：**未修**，建议单独一批处理。

## F-PAT-089 模块 JSDoc 的工具数与实际注册数不一致（B6）

- 位置：`packages/patent/patent-tools/src/index.ts`（模块 JSDoc）。
- 维度：文档与接线一致性（验收标准「工具数三方一致」）。
- 严重度：P3。
- 证据：JSDoc 写「38 model-facing patent tools」，而 `wiring.ts` 实际注册 39 个工厂、`docs/tool-catalog.md` 也列 39 个（单独是 TRIZ 工具后加的，未同步计数）。
- 影响：维护者按 JSDoc 判断工具面会少算一个。
- 最小修复：计数改为 39 并点名 TRIZ；新增用例钉住 39 个注册工具名（含「不含 render_patent_document」）。
- 状态：已修（2026-11-27，B6）；`wiring-composition.spec.ts` 新增断言。

## F-PAT-090 跨图一致性把后图名称记到首图号下（B6，P2）

- 位置：`packages/patent/patent-tools/src/figure/figure-set-consistency.ts`（冲突归属）。
- 维度：正确性（错误结论 + 错误位置）。
- 严重度：P2。
- 证据：首图该标号没有名称时，后图的名称会回填到 `existing.name`；第三图出现不同名称时，冲突报告把已回填的名称冠到「首个出现该标号的图号」之下。于是「标记 10 在图 1、图 3 中名称不一致：立柱 / 立柱体」里的「立柱」其实是图 2 的名字，图 1 根本没有名字。
- 影响：模型按报告去改图 1 的附图说明或权利要求，改错了地方。
- 最小修复：为每个标记冻结「首个非空名称 + 其所在图号」，冲突的原值用该快照。
- 状态：已修（2026-11-27，B6）；新增用例（首图空名 + 图 2/3 异名），断言 `values` 归属 2/3 且消息不含图 1。

## F-PAT-091 FreeCAD 渲染的隔离目录与脚本不清理（B6）

- 位置：`packages/patent/patent-tools/src/figure/freecad-renderer.ts`（`runFreeCadScript`）。
- 维度：资源与残留。
- 严重度：P3。
- 证据：`HOME`/XDG/临时目录与渲染脚本都写在 `request.outputDir`（交付目录，非临时目录），`finally` 只释放计时器；同族的 Inkscape 渲染器会删掉自己的临时目录。
- 影响：每次结构/剖切/剖面线渲染都在客户交付目录累积 `.freecad-home/` 与 `.py` 残留，与 `manifest.json` 混在一起。
- 最小修复：`finally` 里删除隔离目录与脚本；清理失败不改变渲染结论。
- 状态：已修（2026-11-27，B6）；新增用例（成功路径断言清理、rm 失败路径仍返回成功）。

## F-PAT-092 交付检查未展平曲线，图号可被错误豁免（B6）

- 位置：`packages/patent/patent-tools/src/figure/delivery-review.ts`。
- 维度：覆盖面（假通过）。
- 严重度：P3。
- 证据：`scanSvg(svg)` 未传 `curveToleranceMm`，曲线只取端点弦；而 `render-check-findings` 用 0.05mm 展平。弧形墨迹底边被低估后，`baseline > inkBottom` 的图号豁免判据会把压在弧内的图号当成「在图形正下方」而跳过用词检查。
- 最小修复：导出 `RENDER_CURVE_TOLERANCE_MM` 并在交付检查传入。
- 状态：已修（2026-11-27，B6）；新增用例（半圆弧最低点 70、图号基线 60，断言仍报用词违规）。

## F-PAT-093 模型可见警告含实现词汇（B6）

- 位置：`figure/analysis-engine.ts`（两步分析降级警告）、`figure/section-source.ts`（区域清单提示）。
- 维度：模型可见文案。
- 严重度：P3。
- 证据：警告直接写「两步分析第一步（结构抽取）…跳过第二步说明生成」与「parts 按 anchor 逐点匹配区域」，把引擎内部步骤和数据字段名暴露给模型。
- 最小修复：改为任务视角的表述（附图结构未能识别 / 标号落点须落在对应材料区域内）。
- 状态：已修（2026-11-27，B6）；同步降级用例断言。

## F-PAT-094 analyze_patent_figure 的 figure_number 契约与实现不一致（B6）

- 位置：`packages/patent/patent-tools/src/tool/analyze-patent-figure.ts`。
- 维度：模型可见契约。
- 严重度：P3。
- 证据：输入 schema 为 `type: 'number'`、输出为 `integer`，execute 直接 `?? 1` 后交给引擎，无正整数校验；同族工具已用 `integer` 或运行时校验收口。
- 影响：`0`/`-1` 会进入附图说明「图N」与索引键；`2.5` 由 schema 拒绝，但直调方绕过 schema 时不拒绝。
- 最小修复：schema 改 `integer`，execute 校验正整数并报 `invalid_tool_input`。
- 状态：已修（2026-11-27，B6）；同步工具目录中英两版与 `patent-oa-response` 的工具 schema 快照（回放通过）。

## F-PAT-095 附图文件名静默改名且未披露（B6）

- 位置：`packages/patent/patent-tools/src/tool/generate-patent-figure.ts`（`filename`）。
- 维度：模型可见契约。
- 严重度：P3。
- 证据：schema 只写「输出文件名（不含扩展名）」，实现经 `sanitizeDotFilename` 把 `[^\w\-]` 全部替换为 `_`；同族的 `add_patent_figure_references` 明确拒绝静默改名。
- 影响：模型给中文或带空格的文件名时拿到一串下划线，需要猜实际产物名。
- 最小修复：schema 描述写明替换规则。
- 状态：已修（2026-11-27，B6，选择「披露」而非「fail-loud」以免破坏既有调用）；同步目录与快照。备选强化：改为拒绝并报 `invalid_tool_input`。

## F-PAT-096 受理条件未执行时待核项为空（B6）

- 位置：`packages/patent/patent-tools/src/atoms/admissibility.ts`（缺 `grounds` 分支）。
- 维度：投影层语义（未检查读成通过）。
- 严重度：P3。
- 证据：该分支返回 `admissibility_passed: true` 与 `admissibility_pending: []`，报告文本写「未执行」；下游 `legal-gaps` 靠字符串匹配「未执行」兜住，一旦改词就会变成「通过且无待核」。
- 最小修复：待核项填一条 `ADM-UNASSESSED`，让 pending 路径稳健兜住。
- 状态：已修（2026-11-27，B6）；用例断言 pending 只含 `ADM-UNASSESSED`。

## F-PAT-097 未提供要求清单时仍报「覆盖度 100%」（B6）

- 位置：`packages/patent/patent-tools/src/tool/patent-eval.ts`（`evaluateCitations`）。
- 维度：模型可见文案（自相矛盾）。
- 严重度：P3。
- 证据：`required_citations` 为空时退化为「正文是否出现第X条」的抽查，命中即 `passed=true`，而 details 打印「要求 0 条引用，覆盖度 100%」。
- 最小修复：空清单时 details 明示「未提供 required_citations：按正文是否引用法条抽查，未核对覆盖度」。
- 状态：已修（2026-11-27，B6）；用例断言不含「覆盖度 100」。

## F-PAT-098 分析报告在 LLM 补分失败时静默缺两维（B6）

- 位置：`packages/patent/patent-tools/src/tool/patent-analysis-report.ts`（`renderReport`）。
- 维度：模型可见输出（缺省读成没有）。
- 严重度：P3。
- 证据：模型路由缺失或调用失败时 `modelScores` 为 undefined，报告只渲染清晰度/完整性两维，没有任何「未评分」标记，而工具描述承诺给出新颖性与技术强度评分。
- 最小修复：渲染时对缺席的模型维度逐项输出「未评分（LLM 未配置或调用失败）」。
- 状态：已修（2026-11-27，B6）；两条用例（全缺、只缺一维）。

## F-PAT-099 provider 与 model 只配置一半时被静默丢弃（B6）

- 位置：`packages/patent/patent-tools/src/wiring.ts`（`resolveModelRoute`）。
- 维度：装配（误配置静默回落）。
- 严重度：P3。
- 证据：`provider`/`model` 是相互独立的可选字段，只配其一时整条配置被忽略并回落到宿主默认模型；`config.ts` 的 JSDoc 却暗示只在「两者都未设置」时才回落。
- 影响：运维显式指定的 provider 被无声丢弃，调用可能落到未预期的模型上。
- 最小修复：只配一半时在插件加载期报 `setup_required`。
- 状态：已修（2026-11-27，B6）；两条用例（只配 provider / 只配 model）。

## F-PAT-100 剖切几何的三个叶子字段未校验（B6）

- 位置：`packages/patent/patent-tools/src/figure/freecad-section-geometry.ts`（`readSectionGeometry`）。
- 维度：边界校验（子进程产物）。
- 严重度：P3。
- 证据：环坐标、面积与视图帧向量都逐项校验，而 `model.path`、`model.solids`、`plane.distance` 原样赋值；`distance` 为 `null` 或字符串时会静默成为 `distanceMm`。
- 最小修复：三个字段分别校验非空字符串、非负整数、有限数。
- 状态：已修（2026-11-27，B6）；新增用例覆盖三种坏值。

## F-PAT-101 add_patent_figure_references 的「参考标号：N」报的是请求数（B6，未修）

- 位置：`packages/patent/patent-tools/src/tool/add-patent-figure-references.ts`（render 与 `numReferences`）。
- 维度：模型可见文案。
- 严重度：P3。
- 证据：`numReferences` 取 `args.references.length`，未命中项只进 warnings；render 输出「参考标号：2」与「未命中：Ghost」并列，读起来像两个标号都已落图。
- 为什么不修：字段语义（参考数）与 render 措辞都有既有消费者，改动会牵动输出契约；warnings 已列出未命中，影响有限。留待与附图标注的返回契约一起调整。
- 状态：**未修**，待决策。

## F-PAT-102 workbench_link_patent_case 的 stages 未做枚举校验（B6，待确认）

- 位置：`packages/patent/patent-tools/src/tool/workbench-link-patent-case.ts`。
- 维度：边界校验（模型 JSON → 远端 API）。
- 严重度：P3。
- 证据：`stages` 的 items 为 `additionalProperties: true`，`stage` 与 `statusCode` 无枚举约束，非法值透传到工作台 `PATCH` 才由远端报错。
- 待确认：工作台 API 是最终校验边界，若它稳定拒绝非法值，这只是错误码不友好而非缺陷。
- 状态：**未修**。

## F-PAT-103 电路图结点阈值与计数口径不一致（B6，待决策）

- 位置：`packages/patent/patent-tools/src/figure/circuit-diagram.ts`。
- 维度：图面正确性。
- 严重度：P3。
- 证据：JSDoc 写「≥3 条连线共用一点必须有结点」，实现 `count >= 2` 即画结点；且只统计连线起止引脚，折点处的 T 形交点不计数。
- 为什么不修：正确阈值是领域判定（两条线相交是否按结点处理、折点是否算交点），需要与电路图绘制规范一起定。
- 状态：**未修**，待决策。

## F-PAT-104 归属匹配窗口上限 8 字（B6，待确认）

- 位置：`packages/patent/patent-tools/src/figure/hierarchy-check.ts`。
- 维度：覆盖面（启发式漏报）。
- 严重度：P3。
- 证据：正则 `(\d+)[^\d，。；：、（）()]{0,8}?的…(\d+)` 把「的」两侧的非数字字符限制在 8 个以内，长修饰语的归属关系不命中。
- 待确认：上限可能是为了压误报而设；放宽前需要一组真实句子的误报率。
- 状态：**未修**。

## F-PAT-105 判例检索不按文档类型收窄（B7，P1）

- 位置：`packages/patent/patent-knowledge/src/case-law/case-law-search.ts`（三条静态热路径 SQL、`appendCaseLawFilters`、`stmtCount`）。
- 维度：语义（把法条当判例返回）。
- 严重度：P1。
- 证据：`documents` 表同时存 case/judgment/law_article/guideline_rule/concept/personal_note，而 `CaseLawDocType` 类型只允许 `case`/`judgment`，SQL 却不加 `doc_type` 过滤。真库上搜「假冒专利的」前五条是 1 条 judgment + 4 条 `law_article`。
- 影响：模型把法条、审查指南当作在先判例引用，证据归属错误。
- 最小修复：静态 SQL 与动态过滤统一加 `d.doc_type IN ('case','judgment')`；`count()` 同步收窄。
- 状态：已修（2026-11-27，B7）；FTS / LIKE / 前缀三条路径各一条用例。

## F-PAT-106 node_type 别名把语料真实类型映射掉（B7，P1）

- 位置：`packages/patent/patent-knowledge/src/patent/patent-kg-adapter.ts`（`resolveNodeTypes`）。
- 维度：语义（按类型浏览恒为 0）。
- 严重度：P1。
- 证据：真库 `node_type` 取值是 `Judgment`(6,831) / `LawArticle`(3,500)，而别名表把二者映射成 `SupremeCourtJudgment`/`RegionalCourtJudgment` 与 `Clause`/`Chapter`——这四个类型在真库各 0 行；展开结果不含原名。
- 影响：`patent_kg_query` 按 `node_type=Judgment` 浏览返回空，模型得出「图谱里没有判决」的错误结论。
- 最小修复：展开结果以传入名为首项，后接历史别名。
- 状态：已修（2026-11-27，B7）；别名断言与「语料用原名存储时仍能浏览」各一条用例。

## F-PAT-107 知识库安装先提交再破坏性裁剪（B7，P2）

- 位置：`packages/patent/patent-knowledge/src/install.ts`。
- 维度：持久化（半成品覆盖可用产物）。
- 严重度：P2。
- 证据：`VACUUM INTO` 的紧凑副本先 `commitTempSibling` 到输出，随后在输出上执行建列、压缩、删表、二次 `VACUUM`；任一步失败都留下半裁剪库，且上一份可用库已被 rename 覆盖。最坏情形是 `search_prefix` 全为 NULL，判例短查询静默丧失正文召回。
- 最小修复：全部裁剪在临时副本上完成，成功后才提交；失败时删除临时文件。
- 状态：已修（2026-11-27，B7）；「裁剪步骤失败时旧输出原样保留且无残留临时文件」一条用例。

## F-PAT-108 KG 引用关系词表漏掉语料里最多的两类边（B7，P2）

- 位置：`packages/patent/patent-knowledge/src/patent/patent-kg-adapter.ts`（`CITE_RELATIONS`）与 `packages/patent/patent-tools/src/tool/patent-kg-query.ts`（同名单）。
- 维度：覆盖面（引用链静默缺失）。
- 严重度：P2。
- 证据：真库 `kg_edges.relation` 有 `CITES_EVIDENCE`(74,151)、`APPLIES_LAW`(54,012)，词表只含 `CITES`/`CITES_LAW`/`FREQUENTLY_CITES`/`REFERENCES`，其中后两个在真库不存在。
- 影响：约 12.8 万条「决定—证据」「决定—法条」边不展开，模型看不到引用链且无任何提示。
- 最小修复：词表补齐两类边并保留旧写法；工具侧改为引用库包导出的同一常量。
- 状态：已修（2026-11-27，B7）；工具邻居调用断言同步。

## F-PAT-109 引用门把「本索引不管的法律」判成核验失败（B7，P1）

- 位置：`packages/patent/patent-rule/src/runtime/citation-gate.ts`。
- 维度：门禁（误拒合法交付）。
- 严重度：P1。
- 证据：`civilIndex()` 只载入民法典与民诉法，而抽取器无条件识别 `INITIAL_LAW_NAMES` 里的劳动合同法、公司法；`verifyLegalCitation` 对未载入法律返回 `not-indexed`，`BLOCKING` 含该值。实测「依据劳动合同法第39条」被拒，文案还劝模型删掉正确引用。
- 影响：声明了 `citationGate` 的部署会拒掉职务发明/权属意见里的合法引用。
- 最小修复：索引补齐四部常引法；对索引未覆盖的法律跳过而不是判失败。
- 状态：已修（2026-11-27，B7）；四部法、越界、未索引法各一条用例。

## F-PAT-110 显式 manifestPath 失效时静默退化为 base 包（B7，P1）

- 位置：`packages/patent/patent-rule/src/runtime/rule-pack.ts`（`loadRulePack`）。
- 维度：装配（误配置静默降级）。
- 严重度：P1。
- 证据：清单不存在或解析失败只 push 一条 warning，随后用 `{base:'base'}` 继续；实测路径拼错后规则数从 125 条降到 6 条，门禁「仍在跑」。
- 影响：专利全量规则（含 31 条 block 级）整体不加载，且只有一行 warn。
- 最小修复：显式配置的清单读不到或解析失败时抛错；仅未配置才走默认。
- 状态：已修（2026-11-27，B7）；不存在与解析失败各一条用例，`apply-branches` 相应更新。

## F-PAT-111 移除成员把已取消/失败的任务复活成 pending（B7，P1）

- 位置：`packages/patent/patent-teams/src/member-runtime.ts`（`removeMember`）。
- 维度：状态机（绕过终态）。
- 严重度：P1。
- 证据：requeue 循环只跳过 `completed`，随后对 `cancelled`/`failed` 调用 `invalidateTaskAttempt`，该函数无条件把状态改回 `pending` 并删除 output，末尾 `kickTeam` 随即重新派发。`TASK_TRANSITIONS` 里两者都是没有出边的终态。
- 影响：队长显式取消的任务在移除成员时被静默重开并重跑。
- 最小修复：终态任务只保留，不再 invalidate。
- 状态：已修（2026-11-27，B7）；「已取消任务不被重新入队」一条用例。

## F-PAT-112 审批门缺 handler 时被 executor 文本顶替（B7，P1）

- 位置：`packages/patent/patent-workflow/src/workflow.ts`（`assertKnownAtoms`）、`workflow/executor.ts`。
- 维度：门禁（未问过读成已放行）。
- 严重度：P1。
- 证据：`assertKnownAtoms` 只校验 atom 契约；handler 查不到时 `runStageOnce` 落到 executor 分支，把调用方给的文本记为阶段产出，`degraded=false`，事件里仍带 `atom:'approval-gate'` 且 `completed:true`。
- 影响：下游无法区分「门已放行」与「门被一段文本填掉」。
- 最小修复：审批门阶段必须注册 handler；收口重放显式传 `atomStagesMayUseExecutor: true`。
- 状态：已修（2026-11-27，B7）；拒绝与显式放行各一条用例，`patent-tools` 的 recap 已显式声明。

## F-PAT-113 结构化缺口重试耗尽被记成完成（B7，P2）

- 位置：`packages/patent/patent-workflow/src/workflow.ts`（回退耗尽分支）。
- 维度：语义（未完成读成完成）。
- 严重度：P2。
- 证据：文本信号耗尽标记 `degraded`，结构化信号耗尽直接 `pushStageResult`，输出非空即 `degraded=false`；`legal_gaps`/`draft_review` 类缺口门重试耗尽后运行报 `completed:true`、`degradedSteps:[]`，唯一痕迹是 `revisions[].outcome='exhausted'`。
- 最小修复：结构化耗尽同样标记 degraded，并加 `[WORKFLOW_REVISION_EXHAUSTED]` 前缀。
- 状态：已修（2026-11-27，B7）；两条既有用例改为断言 `completed === false` 与降级步骤。

## F-PAT-114 引擎 JSON 数组里的 null 元素让整次元数据调用失败（B7，P2）

- 位置：`packages/patent/patent-data/src/mapper.ts`。
- 维度：边界校验（wire 输入）。
- 严重度：P2。
- 证据：`parseJsonArray('[null]')` 返回 `[null]`，`item[key]` 抛 `TypeError`；`classifications` 也未过滤非字符串。该缺陷原登记为 F-PAT-055，本轮复现。
- 最小修复：`extractNames` 先判 `item` 是非空对象，`classifications` 过滤非字符串。
- 状态：已修（2026-11-27，B7），F-PAT-055 随之关闭。

## F-PAT-115 ego-browser 环境白名单在真实 subprocess 上不生效（B7，P2）

- 位置：`packages/patent/patent-data/src/ego-session.ts`（`buildEnv`）。
- 维度：最小权限（承诺未达成）。
- 严重度：P2。
- 证据：`buildEnv` 只复制白名单名字，注释写「其余名称省略」；但 `SubprocessSpawnSpec.env` 的契约是合并到 `scrubbedParentEnv()` 之上（`{ ...scrubbedParentEnv(), ...extra }`），省略不等于移除。`SENSITIVE_ENV_PATTERN` 只擦 `KEY|PASSWORD|SECRET|TOKEN`，`GH_PAT`/`SSH_AUTH_SOCK`/`NODE_OPTIONS`/`AWS_PROFILE` 会进入第三方浏览器进程。原登记为 F-PAT-016，其修复只改了断言层。
- 影响：README 与 JSDoc 的最小权限承诺在出厂 bundle 上不成立。
- 最小修复：对每个非白名单名字写 `undefined` 墓碑。
- 状态：已修（2026-11-27，B7），F-PAT-016 随之关闭；用 `scrubbedParentEnv()` 合并后断言两条环境名消失。

## F-PAT-116 CNIPR 通道的三处完整性缺口（B7，未修）

- 位置：`packages/patent/patent-data/src/cnipr-script.ts`（逐号 catch、翻页 break、`resolveAppNumber`）、`cnipr-receipt.ts`（法律状态 total 不比对）。
- 维度：通道完整性。
- 严重度：P2。
- 证据：逐号 catch 只取 `.message`，批量中途登录失效的 `login_required` 码丢失；翻页找不到链接时静默 `break`，`limit>10` 只返回 10 条且无告警；公开号转申请号取页面第一个匹配而不绑定结果行；法律状态 `total` 与 `records.length` 从不比对，页面改版会表现为「查询成功但无记录」。
- 为什么不修：这四处都要连带改通道返回契约（批量失败提升、`page_state` 判据、行级绑定、`dropped` 对称检查），且多页路径没有真机用例；需要一次专门的通道维护。
- 状态：**未修**，待决策。

## F-PAT-117 知识库剩余的 P3 组（B7，未修）

- 位置：`wiki-card-loader.ts`（card-index 合并把缺省写成 `undefined`、`titleFromFileName` 契约与实现不符）、`index.ts`（服务不注入 logger/stats）、`install.ts`（`verifyComponents` 失败不释放句柄）、`db-version.ts`（只在 `user_version=0` 补 `application_id`）、`config.ts`（查询库路径构造期固定，先启动后安装需重启）、`knowledge-law-search.ts`（`limit` 未归一化）。
- 严重度：P3。
- 为什么不修：均为潜伏缺陷或有更好的既有实现可对照，但单条影响限于诊断与可观测性；`limit` 归一化在仓内无生产调用点。留待知识库的下一次维护窗口统一处理。
- 状态：**未修**。

## F-PAT-118 工作流剩余的 P2/P3 组（B7，未修）

- 位置：`workflow.ts`（续跑用本次 ctx 覆盖恢复态、executor 阶段收不到 AbortSignal、`completed` 未与阶段数对齐、续跑后 pending 回退记录丢 `after`、并行组一个阶段中断不停其它）、`flexible-plan.ts`（读回不校验 atom/params）、`role-contracts.ts`（`verify()` 生产路径不调用）、`index.ts`（构造器全局注册不受 ctx 生命周期）。
- 严重度：P2（续跑材料覆盖与取消信号）/ P3（其余）。
- 为什么不修：续跑一致性需要把 manifest 结构摘要与材料摘要写进 recovery，属协议扩展；取消信号要扩 `StageExecutor` 签名，跨 patent-core；其余为防御路径。留待与工作流恢复协议一起改。
- 状态：**未修**，待决策。

## F-PAT-119 团队剩余的 P2/P3 组（B7，未修）

- 位置：`task-ops.ts`（质量门禁打回判据通过后不清除、`attemptId` 缺失时能力校验跳过、`updateTask` 无 `reassigning` 守卫）、`tools.ts`（`claim_task` 文案与执行相反）、`scheduler.ts`（派发失败回滚早退把成员留 `working`）、`member-runtime.ts`（孤儿成员 retire 失败静默吞）。
- 严重度：P2（门禁判据、attempt 校验）/ P3（其余）。
- 为什么不修：门禁判据要在 host 状态与客户端 fold 两侧同时加「门通过」事件，属事件契约扩展；`attempt_id` 强制会让既有「队长代填」路径失效，需先确认调用方；其余为并发窗口。留待团队事件契约的一次整体调整。
- 状态：**未修**，待决策。

## F-PAT-120 规则门禁剩余的 P2/P3 组（B7，未修）

- 位置：`RuleLoader.ts`（空 `rules` 文件不计问题、缺 `action` 静默降级 `warn`）、`structural-gate.ts`（制品文本为空或不取字符串时整体不判、未知 rule id 文案说「整条已忽略」实际只剔除该 id）、`patent-compliance.ts`（资产损坏报「未找到」、基础规则绕过 activation-overrides）、`RuleEngine.ts`（无上限法条静默不检查）、`dual-input.ts`（漏「第22条第3款」「A33」写法、22.4 回退到整条族）、`index.ts`（`gateCheckTypes` 解析为空时静默不判）。
- 严重度：P2（空规则文件、结构门空文本、action 降级）/ P3（其余）。
- 为什么不修：空规则文件与 `action` 缺失要给规则资产加加载期校验，会连带失败现有资产（当前资产恰好都合规，属潜在缺陷）；结构门空文本的判定口径需要在 `strict` 语义里定；其余为文案与覆盖面。
- 状态：**未修**，待决策。

## F-PAT-121 writing-patterns 的模型可见契约与分词（B7，未修）

- 位置：`tool/query-writing-patterns.ts`（`命中 N / M` 的 N 是截断后条数、`category` 在三种模式下语义不同但描述未披露、`limit` 非法抛裸 `Error`）、`pattern-store.ts`（构造器重复 id 文档与实际不符、被数字切出的孤立单字权重高于 bigram）。
- 严重度：P2（前两条）/ P3（其余）。
- 为什么不修：命中数文案要改输出字段并连带工具目录与快照；`category` 语义要么改成真过滤（行为变更）要么补描述（模型可见文案变更）；分词权重需要先量对检索排序的影响。
- 状态：**未修**，待决策。

## F-PAT-122 patent-teams 依赖 patent-tools 只为取一个纯函数（B7，P2）

- 位置：`packages/patent/patent-teams/src/task-ops.ts:14`（`import { evaluatePatentContent } from '@deepseek-ai/dsh-patent-tools'`）。
- 维度：依赖方向（服务层依赖模型工具层）。
- 严重度：P2。
- 证据：`evaluatePatentContent` 是 `patent-tools/src/tool/patent-eval.ts` 里的纯函数（JSDoc 自称 pure entry point），`patent-teams` 只用它做质量门禁评分。结果是安装闭包把 39 个模型工具、附图渲染与 FreeCAD 路径一并拖进团队服务。
- 为什么不修：正确归属是 `patent-core`（`patent-tools` 与 `patent-teams` 都依赖它），需要移动约 290 行、更新两处导出与两条测试路径，并在 `patent-core` 的导出门禁下登记；这是独立的重构，不应与 B7 的缺陷修复混在一起。
- 状态：**未修**，建议单列一次重构。
