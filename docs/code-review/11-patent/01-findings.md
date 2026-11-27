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

## F-PAT-113 结构化缺口重试耗尽被记成完成（B7 发现，P2，结论修正）

- 位置：`packages/patent/patent-workflow/src/workflow.ts`（回退耗尽分支）。
- 维度：语义（未完成读成完成）。
- 严重度：P2。
- 证据：文本信号耗尽标记 `degraded`，结构化信号耗尽直接 `pushStageResult`，输出非空即 `degraded=false`；`legal_gaps`/`draft_review` 类缺口门重试耗尽后运行报 `completed:true`、`degradedSteps:[]`，痕迹只有 `revisions[].outcome='exhausted'` 与阶段输出文本。
- 最终修法（B9 收口后修正 B7 的处置）：保留 `[WORKFLOW_REVISION_EXHAUSTED]` 前缀，**不**标 `degraded`。理由是结构化耗尽只表示「补提之后仍有缺口」，这是缺口门与评审门的正常结论，`revisions[].outcome='exhausted'` 已是可消费的结构化记录；标成降级会让「检出缺口」被读成「流程没跑完」，与 `legal_gaps` 的既有语义冲突。文本信号耗尽仍标 `degraded`（那才是阶段自身失败）。
- 为什么修正：B7 的改法把两条 `patent-workflow` 用例改成 `completed === false`，但没有跑作为消费者的 `patent-tools`，其 `legal-gaps-feedback.spec.ts` 一直断言 `completed === true`、`degraded === false`；两个 spec 对同一行为期望相反，直到 B9 收口后跑全量才暴露。
- 状态：已修（2026-11-28，B9 收口后）；两条 `workflow-retry` 用例改回 `completed === true` 与空 `degradedSteps`，前缀断言保留。

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

## F-PAT-123 类型不适用的费用阶段被渲染成「未核对」（B8，P2）

- 位置：`packages/patent/patent-fees/src/tool/patent-fees.ts`（`renderFeeTable` 的空表分支）、`src/compute.ts`（类型过滤 note）。
- 维度：模型可见文案（结论与合计自相矛盾）。
- 严重度：P2。
- 证据：查询 `patentType: 'design'` 且只点名 `substantive-examination` 时，唯一条目被类型过滤，`lines` 为空而 `total.complete` 为真、合计 `0.00`；同一份渲染里表格上方写「这不等于本案没有费用——请核对 triggers 是否漏了环节」。外观设计本就没有实审费，零是确定结论。
- 最小修复：`compute.ts` 导出 `TYPE_FILTER_NOTE_PREFIX`，渲染器据此在「全部被类型排除」时改说「对该专利类型不适用，无需缴纳」。
- 状态：已修（2026-11-28，B8）；一次点名的阶段全被类型排除时断言新文案且不含旧句。

## F-PAT-124 rule-lock 把已转录的关键条文报成「未判定」（B8，P1）

- 位置：`packages/patent/patent-law/src/citator.ts`（lineage 分支）。
- 维度：语义（已核验读成未判定）。
- 严重度：P1。
- 证据：随包 lineage 把专利法第 62/67/71/77 条标为 `currentStatus: unverified`（因 1984/1992 版本未转录），`decideArticleValidity` 直接采用该状态覆盖 baseline；实测第 71 条（损害赔偿）输出「未判定」，而同一次 `verifyCitation` 判 `valid`。
- 影响：接入 rule-lock 的 workflow 对最常引用的条文给出「无法判定」，且解释与事实相反。
- 最小修复：`unverified` 只表示沿革链的历史版本不可考，不覆盖现行条文的转录判定。
- 状态：已修（2026-11-28，B8）；已转录→按转录判定、未转录→仍 unverified 两条用例。

## F-PAT-125 PCT 效力终止时点写成 30 个月（B8，P2）

- 位置：`packages/patent/patent-deadline/src/report.ts`。
- 维度：法律规则（可能致案件被放弃）。
- 严重度：P2。
- 证据：只要 `pct-national-entry`（30 个月）逾期就输出「效力终止、不适用恢复」，紧接着又说「可缴宽限费延至 32 个月」。细则第122条第(二)项的终止点是未在 32 个月内办理。
- 影响：在「30 个月已过、32 个月未满」这一正是缴宽限费能救回案件的窗口里，模型会被告知效力已终止。
- 最小修复：按 30/32 两个条目分别措辞，终止警示只在宽限期届满时给出。
- 状态：已修（2026-11-28，B8）；宽限期内不含「效力终止」、宽限期后含。

## F-PAT-126 TRIZ 空格被说成「经典矩阵无解」（B8，P2）

- 位置：`packages/patent/methodology/src/tool/triz.ts`（`renderLookup` 非对角空单元分支）。
- 维度：模型可见文案。
- 严重度：P2。
- 证据：渲染写 `The classical matrix lists no recommendation for this pair`，而 `assets/README.md` 明确 234 个非对角空格是转写缺口。
- 最小修复：改为「本次转录未记录推荐（matrix gap），不代表经典矩阵无解」。
- 状态：已修（2026-11-28，B8）；用例正向钉住新文案并排除旧句。

## F-PAT-127 旧 PDF 被当作本次渲染产物（B8，P2）

- 位置：`packages/patent/patent-document/src/document/pdfRenderer.ts`。
- 维度：交付件正确性。
- 严重度：P2。
- 证据：Chrome 退出码 0 后只做 `existsSync(pdfPath)` 判成功；同名旧 PDF 存在时会把上次的产物当本次结果返回。
- 影响：正是 `verify_deliverable` 存在的理由（读者打开主路径看到旧文本）所针对的交付件错配。
- 最小修复：spawn 前删除同名旧 PDF，让 `existsSync` 只可能命中本次写出。
- 状态：已修（2026-11-28，B8）；预置旧 PDF + Chrome 不写文件时断言报失败且文件已删。

## F-PAT-128 arXiv 的 200+Error 响应被缓存（B8，P2）

- 位置：`packages/patent/tool-literature/src/runtime/connectors/arxiv.ts`。
- 维度：缓存（一次瞬时限流变成整段 TTL 必然失败）。
- 严重度：P2。
- 证据：`looksValid` 只判根元素是否 `<feed>`，而 arXiv 的限流/畸形查询错误条目同样在 `<feed>` 里；缓存 5 分钟后，`describeSourceError` 建议的「稍等几秒重试」永远读到同一错误。
- 最小修复：`looksValid` 同时排除 `/api/errors` 与 `Error` 标题条目。
- 状态：已修（2026-11-28，B8）；连续两次调用断言都到达网络。

## F-PAT-129 paper_download 直接写最终文件（B8，P2）

- 位置：`packages/patent/tool-literature/src/tool/paper-download.ts`（`writePdf`）。
- 维度：持久化（截断文件被当作已下载原文）。
- 严重度：P2。
- 证据：文件体已完整在内存里却用 `writeFile` 直写最终路径，兄弟工具 `patent_pdf_download` 用的是 `writeFileAtomic`；进程在写入窗口被中断会留下截断 PDF。
- 最小修复：改用 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`（新增 workspace 依赖）。
- 状态：已修（2026-11-28，B8）；`package.json` 与 lockfile 已更新，模块图重生成无变化。

## F-PAT-130 15/18 个法源未登记 `paragraphs`，款/项不核验（B8 发现，P1，已修）

- 位置：`packages/patent/patent-law/assets/law/*.yaml`（配合 `packages/law/law-core/src/article-decision.ts:464`）。
- 维度：覆盖面（不存在的款/项被判「已核验」）。
- 严重度：P1。
- 证据：只有《专利法》《实施细则》部分登记了 `paragraphs`；7 个司法解释与 8 个部门规章**全部 0 条**登记。`entry.paragraphs === undefined` 时款/项校验直接跳过，实测「专利法第1条第3款」判 `valid`。
- 修法：`text` 是逐款转录（每款一行），款数可由正文机械推出——款是分段，款内以「（一）」或「1.」编号的各项是项。按此规则为全部 577 条有条文的条文登记 `paragraphs`（单款条为 `[1]`），并修正《专利法》第 24、25、44、53、69、75 条把分项当成款的既有错误（第 25 条实际 2 款，此前登记 8 款）。规则先由《实施细则》149 条中已登记的 77 条交叉验证（0 分歧），再抽样人工核对，最后由 `citator.spec.ts` 的两条用例锁住：款号越界判未核验、每条数据的款数与正文分段一致。
- 未覆盖：**项号仍只报不查**（README 已声明「An item number is reported, not checked」），「第 4 条第 5 项」这类项级引用不在本次修复范围，需要项级索引或单独检查。
- 状态：已修（2026-11-28，B9 收口后）。

## F-PAT-131 期限引擎剩余的 PCT 与日历缺口（B8，P2，未修）

- 位置：`packages/patent/patent-deadline/src/report.ts`、`src/deadline-entries.ts`、`assets/work-calendar/cn-holidays.yaml`。
- 维度：规则覆盖与数据维护。
- 严重度：P2。
- 证据：①PCT 案的 `application-fee` 与 `pct-national-entry` 是同一 30 个月期限，但前者落入「可恢复」、后者落入「效力终止」，救济指引互相矛盾；②PCT 案恢复优先权应适用细则第128条（自进入日起 2 个月），引擎仍按第36条以国际申请日为基；③随包日历只有 2025/2026，2027 起的届满日一律只能给未顺延日期加 caveat。
- 为什么不修：①需要在期限条目模型里给 PCT 费用行标注「同属进入手续」；②要新增一条基于 `nationalPhaseEntryDate` 的恢复条目并在缺失时报 pending；③法定节假日安排需按国务院公告逐年录入，不能由代码推断。
- 状态：**未修**，待决策。

## F-PAT-132 文书渲染剩余的四条（B8，P2/P3，未修）

- 位置：`sectionFold.ts`（重编号与合规检查对「标题序号在行内标签里」判定不一致）、`renderPatentDocument.ts` + `genericDraft.ts`（blocks 槽位落在 `<ol>/<ul>` 上产生非法嵌套）、`documentCompliance.ts`（修改对照表的权项核对在全文无标签时静默通过、多提及即误报）、`paragraphNumbering.ts`（标签扫描不跳过注释与 `<script>/<style>`）。
- 严重度：P2（前两条）/ P3（后两条）。
- 为什么不修：①统一判定要改重编号的定位方式并补 span 序号用例；②槽位模型要区分列表容器与行容器，属模板契约调整；③权项核对要重新定义「块领起权项」的取法；④注释剔除要统一到 `htmlScan` 一个实现，且会连带让一条 `v8 ignore` 变为可达。
- 状态：**未修**，待决策。

## F-PAT-133 文献工具剩余的五条（B8，P2/P3，未修）

- 位置：`arxiv.ts`（自由文本查询未转义/加引号，含 `:` 的普通查询被当 Lucene 语法）、`openalex.ts`（`score` 混用相关度与引文数）、`source-error.ts`（限流判定靠正则匹配错误消息，状态码在工具层已丢）、`paper-download.ts`（PDF 响应体无字节上限）、`openalex.ts`（DOI 形式 id 无法被自身 `fetch` 解析）。
- 严重度：P2（查询转义）/ P3（其余）。
- 为什么不修：查询转义要先定义「用户写 arXiv 原生语法」与「自由文本」两类输入的边界；限流判定要导出 `LiteratureHttpError` 并把状态码结构化带进工具错误；PDF 上限要改流式读取；DOI 归一要同时改 `toHit` 与 `fetch` 两侧。
- 状态：**未修**，待决策。

## F-PAT-134 费用表剩余的三条（B8，P2/P3，未修）

- 位置：`assets/fees/cn-fees.yaml`（著录项目变更费按单一 200 元记录，官方为当事人 200 / 代理机构 50 两档）、`compute.ts`（`reducible === null` 时按全额计并计入合计）、`patent-filing/src/filing/engine.ts`（返回的 `figures` 是已删除的临时位图路径）、`build-patent-filing.ts`（同一消息里「附图 N 张」与「验收：附图 N+1」并存）。
- 严重度：P2。
- 为什么不修：变更费需要查询新增「变更类型」这项案头事实；`reducible === null` 改扣留会推翻既有用例的语义（需要连同该用例一起改）；`figures` 的契约要重新定义返回源件还是入文位图。
- 状态：**未修**，待决策。

## F-PAT-135 法条索引剩余的四条（B8，P2/P3，未修）

- 位置：`reference.ts`（同一法条两种写法重复引用时第二处被误报未识别）、`verify.ts`（部分/章级引用未登记容器条目被判「索引中不存在」）、`tool/law-verify.ts`（「未核验」被统一解释为「条目及其子节都未转录」，对旧编号/未知版本是错的）、`baseline.ts`（成文法接受 `supersededBy` 却不使用）。
- 严重度：P2。
- 为什么不修：覆盖判定要按条文身份保留每个出现区间；指南容器条目要补 31 个前缀；「未核验」文案要按 finding 原因分类；`supersededBy` 要么拒绝要么实现取代语义，属索引格式决策。
- 状态：**未修**，待决策。

## F-PAT-136 方法论与索引资产的剩余三条（B8，P3，未修）

- 位置：`methodology/src/tool/triz.ts`（参数错误用裸 `Error`，丢失错误码）、`patent-index-asset/src/source.ts`（`verifiedOn` 可脱离 `sourceDoc` 存在）、`patent-index-asset/src/index.ts` + README（文档只写两个消费方，实际 legal-law 也在用）。
- 严重度：P3。
- 为什么不修：错误类要新增 `TrizToolError extends HarnessError`；`verifiedOn` 配对校验会改变现有费用资产的合法组合；文档漂移随下一次该包维护一起更新。
- 状态：**未修**。

## F-PAT-137 DAG 几何有两个主人，两行标题节点重叠、依赖边线被节点吞掉（B9，P1，已修）

- 位置：`packages/client/ui-patent-teams/src/client/teams-dag.ts`（`DAG_NODE_HEIGHT`）、`src/client/TeamsDashboard.module.css`（`.dagNode`）。
- 维度：布局正确性（同一份尺寸写在两处且互不一致）。
- 严重度：P1。
- 证据：JS 按 140×52 计算节点坐标与边线锚点；`.dagNode` 是 `<button>`，`width: 140px; min-height: 52px; padding: 6px 9px 6px 11px; border: 0.5px`，且仓库没有全局 `box-sizing`（全仓 242 处 `border-box` 均为组件自声明，本包一处都没有）。content-box 下实宽 161px、`-webkit-line-clamp: 2` 使两行标题成为常态时实高 76px。行距只有 66px → 节点重叠约 10px；列距 36px 被吃掉 21px → 边线起点落在节点内部，可见段只剩约 9px。
- 最小修复：`DAG_NODE_HEIGHT` 52→76；`.dagNode` 加 `box-sizing: border-box` 与 `min-height: 76px`；`.dagNodeGated` 改用 `border-width` 保持 0.5px，避免门拒态挤动几何。依据 `docs/ui-radius.md:48`「Use `box-sizing: border-box` for fixed outer dimensions」。
- 状态：已修（2026-11-28，B9）；`teams-dag.client.spec.ts` 的几何断言同步更新。

## F-PAT-138 Teams 标签页把任务状态压成 8px 色点，屏幕阅读器与色觉障碍用户读不到（B9，P1，已修）

- 位置：`TeamsDashboard.tsx`（`nodeStateClass`、`<span className={css.nodeState …} />`）、`TeamsDashboard.module.css`。
- 维度：无障碍（WCAG 1.4.1 仅用颜色传达信息）。
- 严重度：P1。
- 证据：DAG 节点按钮里没有任务状态文本，状态只由 8px `<span>` 的背景色表达（绿/蓝/灰/红），该 span 无内容、无 `aria-label`；`title` 是任务主题而非状态。逐任务状态恰是该页面的主要信息，而聊天卡片走 `TeamsTaskList` 有文本状态，Teams 标签页没有。
- 最小修复：新增 `.srOnly`，在节点内补 `statusLabel(task.status, t)` 的视觉隐藏文本；`.nodeState` 标 `aria-hidden`。
- 状态：已修（2026-11-28，B9）。

## F-PAT-139 两个包共 21 处 `font-weight > 500`，是全仓最集中的一处违规（B9，P2，已修）

- 位置：`TeamsDashboard.module.css` 18 处（510×5、620×4、640×8、700×1）、`TeamsCard.module.css` 3 处（510）。
- 维度：视觉规范（字重）。
- 严重度：P2。
- 证据：`dsh-client-ui-ux` 规则要求 feature CSS 的 font-weight ≤500；`ui-theme/src/styles/design-platform.css:1-3` 更明确写着「Figma font-weight 510 always renders as `font-weight: 500` in this UI — non-variable webfonts snap intermediate weights unpredictably across platforms」。620/640/700 均为无依据的中间值，且集中落在 9.5–11px 的微标签上（`.gateBadge` 9.5px/640、`.nodeId` 10px/640）。同包 `TeamsSections.module.css` 一处字重都不设，两套视觉语言并存。
- 最小修复：全部降到 500（强调改用字号与墨色）。
- 状态：已修（2026-11-28，B9）。

## F-PAT-140 `.teamName` 的省略号从未生效，长团队名溢出并挤掉状态胶囊（B9，P2，已修）

- 位置：`TeamsDashboard.module.css`（`.teamName`）、`TeamsDashboard.tsx`（`<span>` 行内元素）。
- 维度：布局正确性（CSS 写法正确但作用于错误的盒类型）。
- 严重度：P2。
- 证据：`.teamName` 是 `<span>`，规则写了 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`，但 `overflow` 对非替换行内盒无效，于是没有裁剪、没有省略号；`white-space: nowrap` 仍生效，长中文团队名把同一行盒里的 `.statusPill` 一起推出 `.team` 的圆角边框（`.team` 无 `overflow: hidden`）。
- 最小修复：`display: inline-block; max-width: 100%`，保持与状态胶囊同行流，超长时省略并让胶囊换行。
- 状态：已修（2026-11-28，B9）。

## F-PAT-141 浅色主题下三层嵌套卡片可视分离为零（B9，P2，已修）

- 位置：`TeamsDashboard.module.css`（`.metric`、`.memberCard`、`.memberButton`、`.dagNode`、`.segBar`、`.stateIdle`、`.feedIconMessageSent`）。
- 维度：设计系统 token 使用。
- 严重度：P2。
- 证据：浅色主题下 `--dsw-alias-bg-base`、`bg-layer-1`、`bg-layer-2` 三者同为 `neutral-bluish-00`（纯白），`--dsw-alias-border-l1` 仅 `rgba(0,0,0,0.04)`。于是 `.metric`/`.memberCard`/`.dagNode` 用 layer-2 铺在 `.team` 的 layer-1 上只剩一条几乎不可见的 4% 描边；`.dagNode` 的阴影色是 `bg-base`，浅色下即白色阴影，等于没有。`docs/ui-radius.md` 的 settings-card 材质规定描边用 `--dsw-alias-border-l4`（16%）。暗色下三者有差异，属「只在一个主题成立」。
- 最小修复：三处卡片描边 l1→l4；`.dagNode` 去掉阴影（普通卡片不加阴影，hot 态保留）；轨道类填充 l1→l2。
- 状态：已修（2026-11-28，B9）。

## F-PAT-142 `--dsw-alias-label-quaternary` 全仓未定义，小节标题退回主墨色（B9，P2，已修）

- 位置：`TeamsCard.module.css`（`.sectionLabel`）、`TeamsDashboard.module.css`（`.dagNote`）。
- 维度：主题 token。
- 严重度：P2。
- 证据：label 阶梯只到 `tertiary`（另有 `caption`/`dimmed` 等），全仓无任何 `--dsw-alias-label-quaternary` 定义，仅 4 处引用。`TeamsCard.module.css` 那处无 fallback，`color` 声明在 computed-value 阶段失效后继承主墨色，「成员 / 任务」两个 `<h4>` 因此比 `.description` 还重；`TeamsDashboard.module.css` 同 token 却写了 fallback 到 `tertiary`，同包内一处有兜底一处没有。
- 最小修复：两处统一改用 `--dsw-alias-label-tertiary`。
- 状态：已修（2026-11-28，B9）。

## F-PAT-143 「执行中」标签的扫光画在文字之上，reduced-motion 下永久压字（B9，P2，已修）

- 位置：`TeamsDashboard.module.css`（`.stateRunning::after`、`prefers-reduced-motion` 块）。
- 维度：可读性 / 无障碍。
- 严重度：P2。
- 证据：`::after` 是 `position: absolute; inset: 0` 的半透明 `bg-layer-1` 渐变，绘制在同元素文本之后，周期性冲淡 10.5px 的标签；`prefers-reduced-motion` 下只写 `animation: none`，扫光停在原位，成为一条永久压在文字中部的浅色带——正是最需要读的状态 chip。对照 `ui-primitives/TextShimmer` 用的是复制文本层而非色块覆盖。
- 最小修复：reduced-motion 下 `display: none`；进度条上的同类扫光只压色块不压字，保留 `animation: none` 即可。
- 状态：已修（2026-11-28，B9）。

## F-PAT-144 固定某个 DAG 节点后，hover 与焦点预览彻底失效（B9，P2，已修）

- 位置：`TeamsDashboard.tsx`（`activeId`）。
- 维度：交互承诺。
- 严重度：P2。
- 证据：`const activeId = pinnedId ?? hoveredId`。一旦固定，`hoveredId` 被完全遮蔽：移到或 Tab 到别的节点不再高亮、依赖链不切换、其余节点保持 0.28 变暗，唯一绕法是再点一次取消固定。`dag.hint` 承诺「悬停高亮依赖链 · 点击固定」在固定态下不成立，键盘用户尤其受影响。
- 最小修复：改为 `hoveredId ?? pinnedId`（悬停优先预览，离开后回到固定链）。
- 状态：已修（2026-11-28，B9）。

## F-PAT-145 历史回溯失败时无终止，且回溯期间断言「暂无团队记录」（B9，P2，已修）

- 位置：`TeamsView.tsx`（drain effect、空态分支）。
- 维度：健壮性 + 用户可见的错误断言。
- 严重度：P2。
- 证据：`loadOlder` 的失败与无进展都不 reject（`session.ts` 内部 catch 后静默置 `historyLoadStatus='error'`，也不改 `hasMore`），而 drain 只在 `.finally` 里递增 tick，判定条件不看加载状态，于是失败场景会无间隔重发最多 400 次真实分页请求；同时 `list.length === 0` 立即渲染「本会话暂无团队记录」，而此刻可能正在回溯。
- 最小修复：读 `useSession(s => s.historyLoadStatus)`，`error` 即停；回溯期间显示新增的 `view.loading` 文案。
- 状态：已修（2026-11-28，B9）；新增两条用例（失败即停、回溯期间不报空态）。

## F-PAT-146 运行中成员的按钮 `aria-label` 覆盖了可见内容（B9，P2，已修）

- 位置：`TeamsDashboard.tsx`、`TeamsSections.tsx`（成员按钮）。
- 维度：无障碍。
- 严重度：P2。
- 证据：仅运行中成员渲染为 `<button aria-label={t('member.open', { name })}>`，`aria-label` 覆盖内部文本，屏幕阅读器只读到「打开 alice」，职责、运行状态、当前任务、完成数全部丢失；而不可点击的空闲成员是 `<div>`，内容反而完整可读——最有价值的行信息最少。
- 最小修复：去掉 `aria-label`，在内容后追加 `srOnly` 的「打开 {name}」。
- 状态：已修（2026-11-28，B9）。

## F-PAT-147 hero 指标把计数渲染两次（B9，P2，已修）

- 位置：`TeamsDashboard.tsx`（hero 指标）、`locales.ts`（`card.members`/`card.messages`）。
- 维度：文案语义。
- 严重度：P2。
- 证据：`metricLabel` 用带计数的 `card.members`（「{count} 名成员」），紧邻的 `metricValue` 又渲染同一个数，读作「2 名成员 2」；web 金标 `apps/web/tests/snapshots/patent-teams-panel/teams-view.expected.md` 直接把 `2 members 2 1 messages 1` 录成了期望值。
- 最小修复：新增不带计数的 `metric.members`/`metric.messages` 供指标标签使用；`card.*` 仍供折叠摘要使用。
- 状态：已修（2026-11-28，B9）；web 金标已重录。

## F-PAT-148 `memberId` 在折叠层被降级为裸 `string`，迫使三处断言回 `SessionId`（B9，P3，已修）

- 位置：`teams-model.ts`（`TeamsMemberState`、`PatentTeamsCardMember`）、`TeamsCard.tsx`、`TeamsSections.tsx`、`TeamsDashboard.tsx`。
- 维度：类型安全 / 不透明 id。
- 严重度：P3。
- 证据：host 的 `patent-teams/src/event-types.ts` 把 `memberId` 声明为 `SessionId` 并注明「The member's durable child session id」，`member-runtime.ts` 以 `SessionId(member.id)` 发出；UI 折叠却把它拓宽成 `string`，注释还写着「The host contract types memberId as a plain string」——与 host 契约直接矛盾，并在三处用 `as SessionId` 断言回来。
- 最小修复：`TeamsMemberState.memberId` 与 `PatentTeamsCardMember.memberId` 保留 `SessionId`，删除三处断言并更正注释。
- 状态：已修（2026-11-28，B9）。

## F-PAT-149 品牌包 README 把三个插槽写成两个（B9，P3，已修）

- 位置：`packages/client/ui-brand-patent/README.md`、`README.zh.md`（frontmatter、Summary、Use this package）。
- 维度：文档与实现一致。
- 严重度：P3。
- 证据：实现注册 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` 三个插槽（测试 `HOLES` 也是三个），README 正文只写前两个并称「两个 fallback」，漏掉侧栏产品名这一处用户可见的品牌替换；同族的 `ui-brand-official` README 写的是「mark and name」。
- 最小修复：中英同步改为三插槽三 fallback（含本地构建产品名）。
- 状态：已修（2026-11-28，B9）；`README.i18n.yaml` 已重录。

## F-PAT-150 无障碍与一致性打磨六项（B9，P3，已修）

- 位置：`TeamsDashboard.tsx`（`★`/`⊘`）、`TeamsDashboard.module.css`（`.nodeId`、`.memberButton`）、`TeamsSections.module.css`（`.root`）、`TeamsView.tsx`。
- 维度：无障碍 / 一致性。
- 严重度：P3。
- 证据：`★`（队长）与 `⊘`（门拒）裸露给屏幕阅读器，而同类装饰 glyph 都包在 `aria-hidden` 内；`.nodeId` 写了 `text-overflow: ellipsis` 却缺 `white-space: nowrap`，超长 taskId 会折行并撑高节点；`TeamsDashboard` 的 `.memberButton` 缺 `cursor: pointer`（`TeamsSections` 的同名类有）；`TeamsSections.module.css` 的 `.root` 无人引用。
- 最小修复：两处 glyph 加 `aria-hidden`；补 `nowrap`、`cursor`；删除死样式。
- 状态：已修（2026-11-28，B9）。

## F-PAT-151 中文 README 的 `Model Experience` 未译、视图名写成 `teams`（B9，P3，已修）

- 位置：`packages/client/ui-patent-teams/README.zh.md`、`README.md`。
- 维度：文档一致性。
- 严重度：P3。
- 证据：85 个 `packages/client/*/README.zh.md` 中 84 个用「模型体验」，只有本包保留 `## Model Experience` / `#### KV Cache effect`；两版 README 又把会话视图称作 `teams`，而实际 target 与 slot id 是 `patentTeams`（按反引号标识符 grep 找不到）。
- 最小修复：标题译回中文；视图名改为 `patentTeams`；同时补上新增的回溯加载态说明。
- 状态：已修（2026-11-28，B9）。

## F-PAT-152 分段进度条的「等待」段包含失败与已取消（B9，P3，未修）

- 位置：`teams-dag.ts`（`taskSegments`）、`locales.ts`（`dash.legendWaiting`）、两版 README。
- 严重度：P3。
- 证据：除 `completed`/`claimed`/`in_progress` 外全部计入 `waiting`，因此 `failed`/`cancelled` 显示为「等待中」，而同一批任务在 DAG 节点上染红。
- 为什么不修：要么再加一段颜色（需重新设计四段语义并同步图例与金标），要么改文案（「其他」仍不精确）——属产品口径决策。
- 状态：**未修**，待决策。

## F-PAT-153 「上一任务」按创建顺序而非完成时间取（B9，P3，未修）

- 位置：`teams-dag.ts`（`memberTaskBinding`）。
- 严重度：P3。
- 证据：在 fold（创建）顺序上迭代并覆盖 `last`，得到的是「最后创建的已完成任务」，不是「最近完成的」；同项目的任务常按依赖顺序创建，两者可能不同。
- 为什么不修：需要 `task-validated`/`task-updated` 的时间戳或 seq 参与，会改变折叠数据形状。
- 状态：**未修**，待决策。

## F-PAT-154 队长摘要的计数口径含未分配任务与已离队成员（B9，P3，未修）

- 位置：`TeamsDashboard.tsx`（`member.captainSummary` 实参）。
- 严重度：P3。
- 证据：`count` 取 `team.tasks.length`（含未分配任务），`members` 取 `team.members.length`（含已离队）；文案读作「已派发 N 项任务给 M 名成员」。
- 为什么不修：需要先定义「派发」的口径（有 assignee 的任务？未离队成员？），属产品决策。
- 状态：**未修**，待决策。

## F-PAT-155 六种已发布语言没有 UI 字典（B9，P2，未修）

- 位置：`ui-patent-teams/src/client/locales.ts`、`ctx.locale.register(NS, { zh, en })`。
- 严重度：P2。
- 证据：只注册 zh/en；`ja/es/fr/de/ru/pt` 六种语言缺全部 UI 键，卡片与 tab 的操作文案回退英文。`scripts/locale-dictionary-parity.spec.ts` 的 `PENDING_LOCALE_PACKAGES` 已把本包（连同 ui-document-studio、ui-plugin-catalog、ui-todo-board）书面豁免。
- 为什么不修：补六语言是 52×6 条翻译工作量，非本轮审查范围；但 README 未披露该限制。
- 建议：要么补翻译，要么在包 README 的 Known Limitations 登记该豁免。
- 状态：**未修**，待决策。

## F-PAT-156 品牌包英文元数据是包名且缺描述（B9，P3，未修）

- 位置：`packages/client/ui-brand-patent/locale/en.json`。
- 严重度：P3。
- 证据：`meta.title` 为 `ui-brand-patent`（slug）、无 `meta.description`；其余 7 种语言都是人类标题加描述。插件管理器缺描述时直接不渲染。
- 为什么不修：仓库 81 个 client 包中 57 个英文 title 是 slug、62 个无 description，`ui-brand-official` 同样如此，属主流写法而非本包独有；与本批另一个包不一致，但修正它需要同时改仓库惯例。
- 状态：**未修**，待决策。

## F-PAT-157 dim 幅度与头像字母对比度需要实机确认（B9，P2，未修）

- 位置：`TeamsDashboard.module.css`（`.dagNodeDim` 0.28、`.dagEdgeDim` 0.22）、`teams-avatar.ts`（`hsl(hue 72% 52%)`）+ `.avatar` 的文字色。
- 严重度：P2（潜在不可读）。
- 证据：`dagEdgeDim` 的 `border-l3` 本身的透明度再乘 0.22，估算不足 3% 不透明度，等价于消失；节点 dim 后其余任务难以扫视。头像背景色相由 memberId 哈希决定、明度固定在 52–60%，而字母色取 `label-primary-inverted`（浅色白 / 暗色深），因此同一名单里总有几位首字母在其中一个主题下对比度不足 2:1。
- 为什么不修：两者都需要真实渲染评估（哪几位成员、哪个主题），本批无法启动 Web 端逐项比对；数值调整也应与设计确认。
- 建议：dim 提到 0.45–0.55；头像渐变随主题收敛明度，或给字母加固定对比度的描边。
- 状态：**未修**，待实机。

## F-PAT-158 回溯上限 400 页在真实超长会话下的成本未验证（B9，P2，未修）

- 位置：`TeamsView.tsx`（`DRAIN_PAGE_LIMIT`）。
- 严重度：P2。
- 证据：打开一个团队记录位于极早期的会话时，最多连续拉 400 个窗口（每窗约 500 条消息）并把整段历史压进客户端共享窗口。本批修掉了失败与无进展时的空转，但成功路径的 400 页上限仍在。
- 为什么不修：需要真实超长会话测量耗时与内存，再决定是否改为显式「继续加载历史」入口。
- 状态：**未修**，待实机。
