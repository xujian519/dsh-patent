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
