# Agent Note: 上游 dsh-v0.2.3-alpha.2 同步

Status: implemented

[English](2026-11-23-upstream-dsh-v0.2.3-alpha.2-sync.md) | 中文

## Problem

上游于 2026-11-22 发布 `dsh-v0.2.3-alpha.2`，距 fork 同步的 `dsh-v0.2.3-alpha.1` 只有五个提交。该 tag 恰好是 `git merge-base origin/master dsh-v0.2.3-alpha.2`，因此本次只需一次内容合并，无需修复祖先关系。

该发布不含功能改动：488 个文件、+806/−707 行，几乎全是 manifest 版本 bump。它真正改变的是受支持的运行时：

- `engines.node` 提升为 `^24.22.3 || >=26.13.1`，这是内置 undici 带有 2026 年 11 月安全修复的首批版本。根指令、Python SDK 的 `node` carrier 检查、`BUILD_BACKED_NODE_COMPAT_VERSION` 以及主运行时锁文件都随之更新。
- vendor 的 Cordis 家族升到 `cordis 4.2.0-alpha.1`、`cosmokit 1.10.0-alpha.1`、`group`/`hmr`/`include`/`loader`/`logger-console 1.2.0-alpha.1`、`schemastery 3.20.0-alpha.1` 与 `timer 1.3.0-alpha.1`；只有它们的 manifest 变化。
- 桌面端升到 Electron 44.11.5 与 `node-addon-require-builtin 0.1.10`，`pnpm-workspace.yaml` 按 major 用 override 钉住 undici。
- Python SDK 可执行文件改为嵌入主运行时的确切 Node 版本，而不再用 `node24` 区间，`scripts/build-exe-for-python-sdk.ts` 因此从该锁文件读取 `nodeVersion`。

## Decision

- **单次 merge-forward，并以 merge commit 落地 PR。** merge base 就是 alpha.1 tag，一次合并既让该 tag 保持可达，也让下一次发布的 base 正确；squash 会再次把上游历史从 DAG 上剥离。
- **完整采纳运行时下限与依赖升级。** fork 在 `engines` 中采用同一 Node 下限、同一 Cordis 家族、同一 Electron 与 addon 指纹、同样的 undici override，以及由锁文件派生可执行文件版本，因为这些都是安全或打包要求，而非 fork 特有的选择。
- **在两个冲突 manifest 中保留 fork 的新增内容。** `tool-lsp` 与 `web-fetch-http` 保留 `@deepseek-ai/dsh-value` 依赖，同时采用上游的版本与 `undici 8.12.4`；runbook note 保留 fork 的 `workflows-disabled/` 链接，同时采用上游关于 Node 24.22.3 的措辞。
- **保留 fork 的 CI 归档安排。** `scripts/preview-workflow.spec.ts` 随它检查的工作流一并保持删除，而 `.github/workflows-disabled/` 下的十九份档案无需手工复制：git 把它们与对应的上游路径识别为 rename，本次发布对工作流的改动会自动落到那里。
- **把整个工作区移到 `0.2.3-alpha.2`。** 根 manifest 跟随发布，55 份 fork 独有 manifest（patent、legal、law、document、desktop、self-evolve、video、client 以及 fork 的 util 包）随之更新，因为 `pnpm run constraints` 要求单一版本线。
- **重录生成的基线，而不是手工编辑。** 九个 ACP `agentInfo.version` 钉值由回放刷新，runbook 的翻译配对 section 记录由 `verify-translation-pairing --write` 重写。

## Alternatives considered

- **因为只是版本 bump 而跳过本次发布。** 已拒绝：Node 下限存在的意义是让内置 undici 带上 2026 年 11 月的安全修复，停留在 24.9 会让 fork 用户继续运行不受支持的运行时。
- **手工把上游工作流文件复制进 `.github/workflows-disabled/`。** 已拒绝：git 已把每份档案跟踪为其上游路径的 rename，手工复制会与合并结果重复，并在下次发布时漂移。
- **让 fork 的 manifest 停在 `0.2.3-alpha.1` 并放宽 `constraints`。** 已拒绝：全工作区单一版本线正是该约束要强制的内容，且 fork 的 manifest 并不独立发布。

## Consequences

源码 checkout、容器以及任何构建 DSH 的 CI 作业现在都需要 Node 24.22.3 或更新的 24.x，或 Node 26.13.1 或更新；打包的桌面应用与 Python SDK 自带的可执行文件携带各自的 24.22.3 运行时。下一次发布同步以 alpha.2 tag 为 base。

## Testing

`pnpm run constraints` 通过，根与全部 55 份 fork 独有 manifest 均为 `0.2.3-alpha.2`，`pnpm install --frozen-lockfile` 报告锁文件已是最新。`pnpm run typecheck` 通过全部五道门禁。`pnpm run doc-sync` 在 `NODE_OPTIONS=--max-old-space-size=16384` 下通过全部 53 道门禁，重录后 `verify-translation-pairing` 报告 1887 对一致。`DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/acp --update` 回放 16 个用例，并把九个握手版本重新钉到 `0.2.3-alpha.2`。
