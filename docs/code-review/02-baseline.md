# 自动化基线

记录于 2026-11-15，Day 1。原则：只记录、不修复；工具不可用也记录原因。

## 环境

| 项 | 观测值 | 判定 |
|---|---|---|
| Node（当前 shell） | v22.22.3 | 低于 `engines.node` 的 `>=24.9.0`；最小单测可跑 |
| Node 24 | `~/.nvm/versions/node/v24.19.0/bin/node`，v24.19.0 | 可用；构建与覆盖率基线使用 |
| pnpm | 11.28.5 | 与 `packageManager` 一致 |
| oxlint | 1.81.0 | 可用 |
| Vitest | 4.1.11 | 可用 |
| ffmpeg | `/Users/xujian/bin/ffmpeg` | 可用 |
| ffprobe | `/opt/homebrew/bin/ffprobe` | 可用 |
| LibreOffice | 未找到 | `office-kit` 真实转换无法本地验证 |
| `.env` | 不存在 | 真 API e2e 将自跳过 |

## 命令与结果

| 命令 | 退出码 | 输出摘要 |
|---|---|---|
| `git status --short` | 0 | 空，工作树干净 |
| `git branch --show-current` | 0 | `claude/30-day-code-review-plan-2e5aa7` |
| `git ls-files \| wc -l` | 0 | 33335 |
| `git log -1 --format='%H%n%ad%n%s' --date=iso` | 0 | HEAD 为 2026-11-15 15:59:48 +0800 的 master 合并提交；不记录 SHA |
| `node -v` | 0 | `v22.22.3` |
| `pnpm -v` | 0 | `11.28.5` |
| `oxlint --version` | 0 | `Version: 1.81.0` |
| `vitest --version` | 0 | `vitest/4.1.11 darwin-arm64 node-v22.22.3` |
| `pnpm audit --json` | 1 | `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`；registry 为 npmmirror，未提供审计端点 |
| `command -v ffmpeg` | 0 | `/Users/xujian/bin/ffmpeg` |
| `command -v ffprobe` | 0 | `/opt/homebrew/bin/ffprobe` |
| `command -v soffice` | 1 | 未找到 |
| `command -v libreoffice` | 1 | 未找到 |
| `test -f .env` | 1 | 不存在 |
| `pnpm exec vitest run packages/law/knowledge-core/tests/result-limit.spec.ts` | 0 | 1 个测试文件、2 个用例通过，耗时 157ms |

Day 1 初始未执行：`pnpm run typecheck`、`pnpm run lint`、`pnpm run test`、`pnpm run test:coverage`、`pnpm run build`。同日经用户确认在 Node 24（v24.19.0）下补跑 build 与 coverage，结果见下节。Day 5 补跑 `pnpm run typecheck` 与 `pnpm run lint`，退出码均为 0（2026-11-15 实际执行；Day 5 计划日期为 2026-11-19）。

## Node 24 构建与覆盖率基线（2026-11-15）

| 命令 | 退出码 | 耗时 | 输出摘要 |
|---|---|---|---|
| `pnpm run build:native-system` | 0 | — | `build: built darwin-arm64/bin/system.node` |
| `pnpm run build` | 0 | 118.04s | 10 个 gate 全部通过：native addon、Host Typert、host compiler、Host bundle、Desktop bundle、client compiler、Client bundle、host aggregate check、Web build、client aggregate check |
| `pnpm run test:coverage` | 1 | 548.82s | 10 个测试文件失败、13 个用例失败；`ERROR: Coverage` 计数 0；未写出 `coverage/` 目录，也未打印覆盖率百分比 |
| `pnpm run typecheck` | 0 | — | Day 5 在 Node v24.19.0 下通过 |
| `pnpm run lint` | 0 | — | Day 5 在 Node v24.19.0 下通过；仅 npm 配置警告，无 lint 告警 |

覆盖率运行汇总：

| 指标 | 数值 |
|---|---|
| Test Files | 10 failed / 3327 passed / 23 skipped（共 3360） |
| Tests | 13 failed / 67172 passed / 1 expected fail / 226 skipped（共 67412） |
| Duration | 548.82s |

13 个失败的分类：

| 测试文件 | 失败数 | 判定 | 依据 |
|---|---|---|---|
| `scripts/report-structure.spec.ts` | 1 | 负载超时 | 单跑 5/5 通过（3.45s） |
| `scripts/verify-suppression-reasons.spec.ts` | 2 | 负载超时 | 单跑 26/26 通过（2.95s） |
| `apps/plugin-market-generator/tests/git.spec.ts` | 1 | Git/网络环境（假设） | 断言期望的 git 输出与实际不同 |
| `packages/boot/hmr/tests/watch-config.spec.ts` | 1 | watch 竞态或 fork 分歧（假设，待复核） | 失败信息为 `refresh observed []` |
| `packages/experimental/client-ui-forge/tests/controller.host.spec.ts` | 1 | Git 错误消息本地化 | 中文“致命错误”与英文正则不符 |
| `packages/experimental/client-ui-forge/tests/worktree.host.spec.ts` | 2 | Git 错误消息本地化 | 同上 |
| `packages/experimental/liveshare/tests/host-relay-checks.spec.ts` | 1 | 网络环境（假设） | `.test` 域名无应答 |
| `packages/experimental/worktree/tests/checkout-safety.spec.ts` | 1 | Git 配置/本地化 | 错误消息与断言不符 |
| `packages/experimental/worktree/tests/removal.spec.ts` | 2 | Git 错误消息本地化 | 中文错误消息与英文断言不符 |
| `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts` | 1 | 环境变量 | `NoDefaultCurrentDirectoryInExePath=1` 已确认存在 |

判定为环境相关而非覆盖率阈值失败：`grep -c "ERROR: Coverage"` 为 0；两条超时用例单跑全绿；本轮改动只涉及 `docs/code-review/` 与 `scripts/translation-pairing.manifest.json`，没有业务代码变更。覆盖率百分比未在本机产出，需在 CI 覆盖率 lane 或提高测试超时后复跑获取。

## 工具矩阵

| 能力 | 工具 | 状态 | 说明 |
|---|---|---|---|
| 格式化 | oxlint 的 stylistic 规则 | 可用 | 根脚本 `lint` 走 `scripts/run-oxlint.ts` |
| 类型检查 | `tsc` / `pnpm run typecheck` | 可用 | Day 5 在 Node v24.19.0 下 5/5 gate 通过（22.86s） |
| 依赖漏洞扫描 | `pnpm audit` | 不可用 | 当前 registry 无审计端点 |
| 依赖更新 | Dependabot | 已配置 | npm、uv、github-actions；每日 cron，30 天冷却 |
| SAST | 无 | 缺失 | 未发现 Semgrep/CodeQL/Snyk 配置 |
| 密钥扫描 | 无 | 缺失 | 未发现 gitleaks/secretlint/trufflehog 配置 |
| SBOM | `gen-sbom` / `verify-sbom` | 可用 | 字节锁与 SPDX/CycloneDX 校验 |
| 跨文件克隆检测 | `jscpd` | 可用 | `pnpm run duplication` |
| 文档门禁 | `doc-sync` / `test:docs` | 可用 | 见下方“文档门禁注意事项” |

## 测试与覆盖率

- 单元测试：`pnpm run test`（先构建 native system）。
- 覆盖率：`pnpm run test:coverage`，`vitest.config.ts` 设置每文件 100% 的语句、分支、函数、行阈值；豁免机制由 `scripts/coverage-exempt.ts` 与平台排除清单维护。
- 快照：`pnpm run test:snapshot`、`pnpm run test:web`；后者需要 `pnpm run build`。
- e2e：`pnpm run test:e2e`，无 `DEEPSEEK_API_KEY` 时自跳过。
- 四域测试密度（测试文件数 / `src` 行数）：

| 域 | 包数 | `src` 行数 | 测试文件数 |
|---|---|---|---|
| 专利域 | 16 | 约 116,000 | 407 |
| 文档模式 | 6 | 约 8,700 | 38 |
| 法律模式 | 5 | 约 7,500 | 36 |
| 视频模式 | 3 | 约 8,800 | 18 |

测试密度只作抽样线索，不能替代覆盖率判断。

## 从零克隆到跑起来

最小步骤：

1. 安装 Node 24.9 或更高版本。
2. `pnpm install`。
3. `pnpm run build:native-system`。
4. 需要真实模型调用时，在根目录创建 `.env` 并设置 `DEEPSEEK_API_KEY`。
5. 运行 Web：`pnpm dsh web`，或 `pnpm run dev:web`。
6. 文档模式真实转换需要 LibreOffice；视频模式真实渲染需要 ffmpeg/ffprobe。

缺失或需确认的步骤：

- 本机 Node 版本不满足根 `engines`。
- 本机无 `.env`，真 API 路径无法验证。
- 本机无 LibreOffice，`office-kit` 真实转换无法验证。
- 依赖审计在当前 registry 不可用。

## 文档门禁注意事项

`docs/code-review/` 下的中文单语文档会被 `verify-translation-pairing` 判定为缺 `.zh.md` 与 `.i18n.yaml` 配对。仓库已有中文单语设计文档通过 `scripts/translation-pairing.manifest.json` 的 `excluded` 列表豁免。Day 1 按写入范围约束未修改该清单；同日经用户确认后加入 `"docs/code-review/"` 豁免。

修复前实测：

| 命令 | 退出码 | 输出摘要 |
|---|---|---|
| `pnpm run verify-translation-pairing` | 1 | 本目录 55 个 `.md` 全部报 `in-scope documentation must merge bilingual` |

加入豁免后复跑：

| 命令 | 退出码 | 输出摘要 |
|---|---|---|
| `pnpm run verify-translation-pairing` | 0 | 1725 对全部一致 |

同批通过的门禁：

| 命令 | 退出码 | 输出摘要 |
|---|---|---|
| `pnpm run verify-md-wrap` | 0 | 3561 个文件，无硬换行段落 |
| `pnpm run verify-md-links` | 0 | 3527 个文件，相对链接与片段全部解析 |
| `pnpm run verify-doc-refs` | 0 | 7279 个文件，文档引用全部解析 |
| `pnpm run verify-concrete-terms` | 0 | 受维护文件不含禁用术语 |
| `pnpm run verify-doc-budgets` | 0 | 7 个预算文档均在额度内 |
| `pnpm run verify-repository-references` | 0 | 无禁止引用 |
