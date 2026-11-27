# 专利域全量审阅：发现清单

编号接续上级计划的 `F-PAT-058`，本条专档从 `F-PAT-059` 起。每条发现写清位置、证据、影响、最小修复建议、工作量与自动化可行性。

## F-PAT-059 patent-data 的运行时依赖 dsh-value 只在 devDependencies

- 位置：`packages/patent/patent-data/src/cnipr-receipt.ts:1`；`packages/patent/patent-data/package.json`。
- 维度：无断链。
- 严重度：P1。
- 证据：该文件运行时 `import { asRecord } from '@deepseek-ai/dsh-value'`，而 `package.json` 只在 `devDependencies` 声明；同族的 `patent-core`、`patent-knowledge`、`patent-rule`、`patent-teams`、`patent-tools` 都把该依赖放在 `dependencies`。`verify-package-dependencies` 在此状态下退出码为 0。
- 影响：workspace hoisting 让源码模式全绿；该包 `publishConfig.public` 且 `files` 含 `lib`，脱离 workspace 的安装解析不到该依赖，运行时报模块缺失。
- 最小修复：把 `@deepseek-ai/dsh-value` 从 `devDependencies` 移到 `dependencies`。
- 工作量：5 分钟。可自动化：是（见 F-PAT-063）。
- 状态：已修（2026-11-27，B0）。

## F-PAT-060 patent-document 的运行时依赖 dsh-value 只在 devDependencies

- 位置：`packages/patent/patent-document/src/document/documentCompliance.ts:21`、`packages/patent/patent-document/src/document/paragraphNumbering.ts:13`；`packages/patent/patent-document/package.json`。
- 维度：无断链。
- 严重度：P1。
- 证据：两个模块运行时 `import { escapeRegExp } from '@deepseek-ai/dsh-value'`，`package.json` 同样只在 `devDependencies` 声明。
- 影响：与 F-PAT-059 相同，渲染链路在发布安装形态下启动即失败。
- 最小修复：把 `@deepseek-ai/dsh-value` 移入 `dependencies`。
- 工作量：5 分钟。可自动化：是。
- 状态：已修（2026-11-27，B0）。

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
- 证据：退出码 1，报 391 个包 × 3974 条内部边 = 1,553,834 单位，超预算 419,434 单位。该计量只统计 `dependencies`/`optionalDependencies`/`peerDependencies`，本轮两处依赖修正各增加 1 条边（合计约 782 单位），即使回退也仍超预算 419k 左右，因此是既有红。
- 影响：该门禁目前不提供信号；若 CI 依赖它，安装布局回归不会被发现。
- 最小修复：按脚本提示实测后上调预算常量，或先查清 3974 条边里哪些是重复/可合并。
- 工作量：0.5–1 小时（含实测）。可自动化：部分。
- 状态：未修，待决策（是否上调预算属仓库级策略）。

## F-PAT-063 verify-package-dependencies 对内部模块的运行时引用存在盲区

- 位置：`scripts/verify-package-dependencies.ts`（`readHostRuntimeUses` / `expectedPackageDependencies`）。
- 维度：无断链。
- 严重度：P1。
- 证据：在 F-PAT-059/060 存在期间，该门禁退出码为 0；规则本身要求运行时引用必须进 `dependencies`，但实际没有报出。用正则探针全仓扫描得到 33 条命中，其中多数是「仅类型导入」被误判（如 `packages/core/agent/src/dispatch.ts` 的 `@deepseek-ai/dsh-value`），说明补这条检查必须走 TypeScript AST，不能靠正则。
- 影响：同类依赖错置会继续漏检，且只在发布安装形态暴露。
- 最小修复：复用 `scripts/source-parse-uses.ts` 的 AST 采集，对所有 `src/**` 模块（而非仅入口可达图）求运行时包引用，并要求命中 `dependencies`/`peerDependencies`/`optionalDependencies`；排除 `dsh.client` 客户端包的打包依赖。
- 工作量：2–4 小时（含全仓存量核对与误报收敛）。可自动化：是。
- 状态：未修，需先量全仓存量再启用（见 B1 记录）。
