# CI 门禁加固建议

目标：把本轮反复出现的问题转成持续防线。本页只写建议，不直接修改 CI 或脚本。Day 43（2026-11-18）定稿。

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
| 本轮新增 | `verify-patent-core-exports`（2026-11-17，随 F-PAT-013 修复引入） | `patent-core` 根入口的每个具名导出必须有包外导入或 `@public`，禁止 `export *` |

## 反复出现的问题聚类

| 聚类 | 出现面 | 对应建议 |
|---|---|---|
| 同一语义多份实现 | R1（原子写、OOXML 限额、默认值、`StrictRequest`）、F-PAT-027/028/029/030、F-LEG-006/007/008、F-VID-008/009/010、F-CROSS-001 | 同形本地助手检测、默认值双源检测 |
| 声明与使用不一致 | F-CROSS-002（导入未声明）、F-PAT-013（导出过宽）、F-PAT-024（默认值双源） | 反向依赖声明校验、导出面消费者校验、默认值双源检测 |
| 缺失或未知输入被读成通过 | F-PAT-042/045/048/049、F-LEG-011、F-VID-013 | 无机械门禁：这类语义差异靠 R-D1 用例与门禁 fail-closed 设计 |
| 失败路径缺断言 | F-PAT-033 至 F-PAT-038、F-DOC-007、F-LEG-010 | 覆盖率门禁量不到断言强度，只能靠审查清单 |
| 环境缺口掩盖风险 | OBS-001/002/003/006 | 密钥扫描、依赖漏洞审计 |

## 缺口与建议（定稿）

| 建议 | 触发问题 | 门禁形态 | 成本 | 自动化 | 落地位置 | 裁定 |
|---|---|---|---|---|---|---|
| 密钥扫描 | OBS-004：当前无密钥扫描 | 在 CI 增加 gitleaks 或 secretlint，扫描变更行与全量历史摘要 | 低 | 是 | `.github/workflows/ci-fork.yml` 的 `node-checks` | 采纳，下一周期 |
| SAST | OBS-004：当前无 SAST | 先对四域运行 Semgrep 规则集，记录基线后设「只降不升」阈值 | 中 | 是 | 新增独立 lane，避免拖慢主 lane | 采纳，延后到有基线之后 |
| 依赖漏洞审计 | OBS-002：`pnpm audit` 在当前 registry 不可用 | 指定 npmjs registry 运行 audit，或在 Dependabot 安全告警上设门禁 | 低 | 是 | `node-checks` 或独立 lane | 采纳 |
| 四域覆盖率豁免审计 | H08：豁免可能掩盖关键路径 | 每月生成四域未覆盖文件清单，新增豁免需在 PR 说明理由 | 低 | 是 | 复用 `scripts/coverage-exempt.ts` 与覆盖率报告 | 拒绝：H08 已推翻，豁免清单不含四域文件；月度清单降级为可选观察 |
| 组合预设漂移 | H09：八个 preset 手工列包 | 比较 preset 之间的行块、工具名与配置 | — | 否 | 现有四道 preset 门禁 | 拒绝：H09 已推翻，现有门禁已覆盖；反向缺口（仓库有包、所有 preset 都无）属产品判断，不可机械判定 |
| 导出面消费者校验 | F-PAT-013：导出面过宽，四域七包 63 条导出无包外提及 | 根 barrel 每个具名导出必须有包外导入或 `@public` | 中 | 是 | `hygiene` | 部分已落地：`verify-patent-core-exports` 覆盖 `patent-core`；其余六包先按 F-PAT-013 的同类修法收窄，再逐包加门禁 |
| 同形本地助手检测 | F-CROSS-001：四域 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有唯一实现 | oxlint `no-restricted-syntax` 禁止在 `src` 内定义同形函数，`tests` 与 `scripts` 豁免 | 低 | 是 | `oxlint` 配置 | 采纳；先删除 4 份实现再加规则，否则门禁立即红 |
| 默认值双源检测 | F-PAT-024：七包 42 对 schema `.default` 与 `?? 同值字面量` | 同包内同一字段同时出现 schema `.default(...)` 与 `config.X ?? 同值` 即失败 | 中 | 是 | 独立 `verify-plugin-defaults` | 采纳，延后到 F-PAT-024 修完之后 |
| 反向依赖声明校验 | F-CROSS-002：`patent-tools/src/tool/law-search.ts:16` 导入 `@deepseek-ai/dsh-value`，`package.json` 三节均无该声明，而 `verify-package-dependencies` 仍退出 0 | 对每个包的 `src` 收集 `@deepseek-ai/dsh-*` 值导入，要求该包在 `dependencies` 或 `peerDependencies` 声明同名条目 | 低 | 是 | 扩展现有 `verify-package-dependencies` | 采纳，下一周期第一批 |
| 外部 provider 契约测试 | H04/H06：provider 失败路径测试不足 | 用本地 mock server 固定超时、重试、取消、预算超限 | 中 | 是 | 各包的 `tests/` | 采纳，并入 R-D1 之后 |
| 文档交付断言 | H03：Office 转换异常路径 | 在 CI 的文档转换 lane 增加失败、取消、临时目录清理断言 | 中 | 是 | `packages/document/office-kit/tests/` | 降级为可选观察：H03 已推翻（取消与异常路径未发现泄漏），且本机无 LibreOffice，真实转换未验证 |
| 视频账本一致性 | H04：重复计费风险 | 对 journal、预算账本、项目文档增加不变量测试 | 中 | 是 | `packages/experimental/video-mode/tests/` | 部分已落地：R-E2 补了终态与空产物断言（`tests/minimax.spec.ts:441`、`tests/comfyui.spec.ts:478`）；并发预算与跨进程账本一致性仍无用例 |

## 落地顺序

1. 反向依赖声明校验：只需扩展已有脚本，能立刻拒绝 F-CROSS-002 这条真实反例。
2. 同形本地助手检测：先删 F-CROSS-001 的 4 份实现，再加 oxlint 规则。
3. 密钥扫描与依赖审计：先记录基线，再设为阻塞。
4. 默认值双源检测：排在 F-PAT-024 的逐包修复之后，否则门禁第一次运行就失败。
5. SAST：先跑一轮记录新发现数量，再设「只降不升」阈值。

## 落地原则

- 每条建议先证明能拒绝一个真实反例，再进入 CI。
- 阈值型门禁（SAST、克隆检测）先记录基线，再设为「只降不升」。
- 新增 lane 不得无限拉长主 lane；优先复用已有聚合入口。
- 本页已于 Day 43（2026-11-18）定稿；实施属于后续独立改动，不在本周期内直接修改 CI。
