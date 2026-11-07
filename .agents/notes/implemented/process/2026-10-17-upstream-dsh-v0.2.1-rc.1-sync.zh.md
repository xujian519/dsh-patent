# Agent Note: 上游 dsh-v0.2.1-rc.1 同步

Status: implemented

[English](2026-10-17-upstream-dsh-v0.2.1-rc.1-sync.md) | 中文

## Problem

fork 从上游的 `dsh-v0.2.1-alpha.5` tag 前进到 `dsh-v0.2.1-rc.1`：4 个提交（2 个非合并提交）、355 个文件、+355/−355 行。merge base 就是上一次同步落地的 alpha.5 release commit，因此一次 `git merge` 即到达该 tag。`git merge-tree` 预测 1 个冲突文件，实际合并恰好产生 1 个。

本次发布是纯版本推进。上游改动的每个文件都是 `package.json`，且唯一变化的行是 `version`：`release(dsh): 0.2.1-rc.1` 把 DSH 家族提升到 `0.2.1-rc.1`，`release(vendor): cordis 4.0.5, …` 把 9 个 vendored Cordis 包从 `-alpha.2` 构建提升为正式版（cordis 4.0.5、cosmokit 1.8.6、group 1.0.5、hmr 1.0.20、include 1.0.10、loader 1.0.6、logger-console 1.0.5、schemastery 3.18.5、timer 1.1.7）。没有运行时源码、文档、快照或锁文件随之改动。发布说明描述的是自 `v0.2.0-rc.2` 以来的 0.2.1 功能集；这些行为已经通过历次 alpha 同步进入 fork，本次增量不包含其中任何一项。

## Decision

- **本同步分支对 release tag 做 merge-forward。** `sync/upstream-dsh-v0.2.1-rc.1` 承载这次合并；以 first parent 为 fork `master` 的 merge commit 落地，既把上游提交保留在 fork 的提交图中，也把该 tag 保留为下次同步的 merge base。squash 两点都做不到。
- **唯一冲突按类别解决。** `packages/lsp/tool-lsp/package.json` 取 fork 的 manifest，保留 description 中的字面 em dash，仅把版本提到 `0.2.1-rc.1`；发布侧提供的是转义 dash 和新版本号。
- **版本在 fork 自有面上统一钉住。** 根 manifest、47 份 fork 独有 manifest，以及 已随 PR #677 删除的 better-sidebar 包的 `service.ts` 中的 `SIDEBAR_SERVICE_VERSION` 一并前进到 `0.2.1-rc.1`。`pnpm exec tsx scripts/release/verify.ts --family dsh` 在该版本下解析出 388 个家族成员，无未排序的 peer 声明；`pnpm install --lockfile-only` 报「Already up to date」，未触碰 `pnpm-lock.yaml`。
- **九份 ACP golden 重新钉住 `agentInfo.version`。** `snapshots/acp/*/stdout.expected.jsonl` 的握手响应以字面字符串携带发布版本，因此期望文件随 manifest 一起更新，而不是等回放报出漂移。

## Consequences

fork 带着上游 `dsh-v0.2.1-rc.1` 的基线发布，专利、self-evolve、桌面、better-sidebar 与 document 各面保持不变，因为本次发布没有行为变更。合并后的树相对同步前 `master` 的 412 个文件，是 355 个上游 manifest 版本加 57 个 fork 版本固定点（47 份 manifest、1 个常量、9 份 golden）。

三处分歧仍需在每次发布时关注，且本次没有变化：fork 的 presets 是上游组合变更的落地处；上游退役笔记时，归档封条必须与上游一致；fork 的笔记必须跟随上游的 workflow 路径进入 `workflows-disabled/`。

## Alternatives considered

- **取发布侧的 `tool-lsp` manifest。** 否决：这会把 fork 的字面 em dash 换成转义序列，为一次纯版本变更引入发布并不要求的差异。
- **只更新上游点名的 manifest。** 否决：47 份 fork 独有 manifest 和侧栏常量会停在 `0.2.1-alpha.5`，而 `scripts/release/verify.ts --family dsh` 要求整个家族只有一个版本。
- **把 ACP golden 留给回放去发现。** 否决：漂移是确定性的，期望文件又被提交在仓库中；在版本提交里记录它，才能让回放的失败信号保持有意义。

## Testing

`pnpm run build:artifacts` 通过 7/7 门禁。`pnpm run typecheck` 通过全部五项门禁——Host Typert、host 与 client 编译器，以及两个 aggregate——`pnpm run build:check` 在构建产物上通过两个 aggregate 检查。

`pnpm run lint` 退出码为 0，只带 `packages/experimental/client-ui-cot-translation/src/index.ts` 中既有的 unused-disable 警告。`pnpm run hygiene` 报告 22/22 门禁通过，确认最终的 vendor 版本没有留下悬空引用。

`pnpm run doc-sync` 报告 51/51 门禁通过，包括 agent note 格式、翻译配对、升级指南与文档构建。

`pnpm run test:snapshot` 在 session、sdk、acp、web 四个 lane 回放 223 个无密钥用例，2 个跳过、无失败，共 4 个测试文件。ACP lane 证明九份重新钉住的 golden 与运行时报告的版本一致。

`pnpm run test:coverage` 未被选中：本次发布不改变可执行源码，版本提交只触及 manifest、一个常量和期望 JSON。
