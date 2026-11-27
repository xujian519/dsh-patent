# 专利域全量审阅：发现清单

编号接续上级计划的 `F-PAT-058`，本条专档从 `F-PAT-059` 起。每条发现写清位置、证据、影响、最小修复建议、工作量与自动化可行性。

## F-PAT-059 patent-data 运行时导入未声明运行时依赖（复核为误报，已回退）

- 结论：**不成立**。回退提交 `0ccfa1a864`。
- 原始判断：`packages/patent/patent-data/src/cnipr-receipt.ts:1` 运行时 `import { asRecord } from '@deepseek-ai/dsh-value'`，而 `package.json` 只在 `devDependencies` 声明，判定发布安装无法解析。
- 复核证据：tsdown 会把**未在运行时依赖段声明**的导入内联进产物。主检出已构建的 `packages/patent/patent-data/lib/index.js` 里，该包只剩一处 JSDoc 注释，`asRecord` 以本地函数形式存在，没有任何裸 `import`。同一产物中 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/nuo-patent`、`@deepseek-ai/dsh-patent-core` 都以 `import ... from "..."` 形式外置——规则是「已声明则外置，未声明则打包」。
- 影响：原判不存在。把该依赖移入 `dependencies` 会让它转为外置，改变分发形态而无收益。
- 教训：源码层的「运行时导入必须声明在运行时段」不能单独作为判据；只有构建产物能区分「已内联」与「被外置」。判据改为产物级，见 F-PAT-063。

## F-PAT-060 patent-document 运行时导入未声明运行时依赖（复核为误报，已回退）

- 结论：**不成立**。回退提交 `0ccfa1a864`。
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
