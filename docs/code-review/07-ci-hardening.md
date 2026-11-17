# CI 门禁加固建议

目标：把本轮反复出现的问题转成持续防线。本页只写建议，不直接修改 CI 或脚本。

## 现有防线

| 防线 | 当前实现 | 覆盖 |
|---|---|---|
| 类型检查 | `pnpm run typecheck` | 全仓 TypeScript |
| Lint | `pnpm run lint`（oxlint，类型感知） | 源码与测试 |
| 跨文件克隆 | `pnpm run duplication`（jscpd） | `packages` 与 `scripts` |
| 单元测试 | `pnpm run test` | Vitest |
| 覆盖率 | `pnpm run test:coverage`，每文件 100% | `packages/*/*/src`，含豁免 |
| 快照 | `pnpm run test:snapshot`、`pnpm run test:web` | 会话与 Web |
| 文档门禁 | `pnpm run test:docs` / `doc-sync` | 链接、换行、双语配对、生成目录 |
| SBOM | `pnpm run verify-sbom` | SPDX/CycloneDX 字节锁 |
| 依赖更新 | Dependabot | npm、uv、github-actions |
| 专利专项 | `verify-patent-oas-gold`、`verify-patent-law-coverage`、`verify-patent-law-freshness`、`verify-patent-rule-citations`、`verify-patent-rule-alignment`、`verify-patent-authority-eval` | 专利域 |
| 组合预设 | `verify-agent-preset-config`、`verify-preset-tool-refs`、`verify-preset-divergence`、`verify-preset-mode-baseline`、`verify-runtime-closure`、`verify-default-product-isolation` | 8 个 preset 的行块、配置 schema、工具名、authority 行集与运行时闭包 |

## 缺口与建议

| 建议 | 触发问题 | 门禁形态 | 成本 | 自动化 | 落地位置 |
|---|---|---|---|---|---|
| 密钥扫描 | OBS-004：当前无密钥扫描 | 在 CI 增加 gitleaks 或 secretlint，扫描变更行与全量历史摘要 | 低 | 是 | `.github/workflows/ci-fork.yml` 的 `node-checks` |
| SAST | OBS-004：当前无 SAST | 先对四域运行 Semgrep 规则集，输出与新发现数量设阈值 | 中 | 是 | 新增独立 lane，避免拖慢主 lane |
| 依赖漏洞审计 | OBS-002：`pnpm audit` 在当前 registry 不可用 | 指定 npmjs registry 运行 audit，或在 Dependabot 安全告警上设门禁 | 低 | 是 | `node-checks` 或独立 lane |
| 四域覆盖率豁免审计 | H08：豁免可能掩盖关键路径 | 每月生成四域未覆盖文件清单，新增豁免需在 PR 说明理由 | 低 | 是 | 复用 `scripts/coverage-exempt.ts` 与覆盖率报告 |
| 组合预设漂移 | H09：八个 preset 手工列包 | **已有覆盖，不需新增**：`verify-agent-preset-config`、`verify-preset-tool-refs`、`verify-preset-divergence`（行块哈希 + 基线）、`verify-preset-mode-baseline`（authority 行集 + `explainedAbsences`）已挡住分叉、缺失行、配置不匹配与工具名不存在（`scripts/run-gates.ts:881`–`884`）。残留方向是「仓库有包、所有 preset 都没有」，门禁比较 preset 之间而不比较仓库与 preset，且归哪种模式属产品判断，无法机械判定 | — | 否 | 发布检查项，不入 CI |
| 导出面消费者校验 | F-PAT-013：导出面过宽，四域七包 63 条导出无包外提及 | `patent-core` 已由 `verify-patent-core-exports` 执行：根 barrel 每个具名导出必须有包外导入或 `@public`，并禁止 `export *`。其余六包的「声明文件内多余 `export`」仍是建议 | 中 | 是 | `hygiene` |
| 同形本地助手检测 | F-CROSS-001：`messageOf`/`errorText` 全仓 19 处、`asRecord` 本地实现 4 处，而 `dsh-value` 已有唯一实现 | oxlint `no-restricted-syntax` 禁止在 `src` 内定义 `messageOf`/`errorText`/`asRecord` 同形函数，`tests` 与 `scripts` 豁免 | 低 | 是 | `oxlint` 配置 |
| 默认值双源检测 | F-PAT-024：七包 42 对 schema `.default` 与 `?? 同值字面量` | 同包内同一字段同时出现 schema `.default(...)` 与 `config.X ?? 同值` 即失败；跨文件比对需先解析 schemastery 默认值 | 中 | 是 | 独立 `verify-plugin-defaults` |
| 反向依赖声明校验 | F-CROSS-002：`patent-tools` 在 `src/tool/law-search.ts:16` 导入 `@deepseek-ai/dsh-value`，`package.json` 三节均无该声明，而 `verify-package-dependencies` 仍退出 0 | 对每个包的 `src` 收集 `@deepseek-ai/dsh-*` 值导入，要求该包在 `dependencies` 或 `peerDependencies` 声明同名条目；只校验声明侧与「声明→使用」方向的现有门禁不覆盖此方向 | 低 | 是 | 扩展现有 `verify-package-dependencies` |
| 外部 provider 契约测试 | H04/H06：provider 失败路径测试不足 | 用本地 mock server 固定超时、重试、取消、预算超限 | 中 | 是 | 各包的 `tests/` |
| 文档交付断言 | H03：Office 转换异常路径 | 在 CI 的文档转换 lane 增加失败、取消、临时目录清理断言 | 中 | 是 | `packages/document/office-kit/tests/` |
| 视频账本一致性 | H04：重复计费风险 | 对 journal、预算账本、项目文档增加不变量测试 | 中 | 是 | `packages/experimental/video-mode/tests/` |

## 落地原则

- 每条建议先证明能拒绝一个真实反例，再进入 CI。
- 阈值型门禁（SAST、克隆检测）先记录基线，再设为“只降不升”。
- 新增 lane 不得无限拉长主 lane；优先复用已有聚合入口。
- 本页建议在 Day 43 定稿；实施属于后续独立改动，不在本周期内直接修改 CI。
