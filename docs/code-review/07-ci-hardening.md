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

## 缺口与建议

| 建议 | 触发问题 | 门禁形态 | 成本 | 自动化 | 落地位置 |
|---|---|---|---|---|---|
| 密钥扫描 | OBS-004：当前无密钥扫描 | 在 CI 增加 gitleaks 或 secretlint，扫描变更行与全量历史摘要 | 低 | 是 | `.github/workflows/ci-fork.yml` 的 `node-checks` |
| SAST | OBS-004：当前无 SAST | 先对四域运行 Semgrep 规则集，输出与新发现数量设阈值 | 中 | 是 | 新增独立 lane，避免拖慢主 lane |
| 依赖漏洞审计 | OBS-002：`pnpm audit` 在当前 registry 不可用 | 指定 npmjs registry 运行 audit，或在 Dependabot 安全告警上设门禁 | 低 | 是 | `node-checks` 或独立 lane |
| 四域覆盖率豁免审计 | H08：豁免可能掩盖关键路径 | 每月生成四域未覆盖文件清单，新增豁免需在 PR 说明理由 | 低 | 是 | 复用 `scripts/coverage-exempt.ts` 与覆盖率报告 |
| 组合预设漂移 | H09：四个 preset 手工列包 | 扩展 `verify-group-readme-packages` 或新增校验：preset 中的包必须存在且已登记 | 中 | 是 | `doc-sync` 或 `hygiene` |
| 外部 provider 契约测试 | H04/H06：provider 失败路径测试不足 | 用本地 mock server 固定超时、重试、取消、预算超限 | 中 | 是 | 各包的 `tests/` |
| 文档交付断言 | H03：Office 转换异常路径 | 在 CI 的文档转换 lane 增加失败、取消、临时目录清理断言 | 中 | 是 | `packages/document/office-kit/tests/` |
| 视频账本一致性 | H04：重复计费风险 | 对 journal、预算账本、项目文档增加不变量测试 | 中 | 是 | `packages/experimental/video-mode/tests/` |

## 落地原则

- 每条建议先证明能拒绝一个真实反例，再进入 CI。
- 阈值型门禁（SAST、克隆检测）先记录基线，再设为“只降不升”。
- 新增 lane 不得无限拉长主 lane；优先复用已有聚合入口。
- 本页建议在 Day 43 定稿；实施属于后续独立改动，不在本周期内直接修改 CI。
