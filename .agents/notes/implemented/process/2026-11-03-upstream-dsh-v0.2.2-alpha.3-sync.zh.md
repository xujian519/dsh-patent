# Agent Note: upstream v0.2.2-alpha.3 sync

Status: implemented

[English](2026-11-03-upstream-dsh-v0.2.2-alpha.3-sync.md) | 中文

## Problem

fork 仍停在上游 `dsh-v0.2.2-alpha.2`，而 `dsh-v0.2.2-alpha.3` 已发布大面积变更：统一右键/键盘菜单、文件预览常驻目录树、实验性「变更请求与工作树」统一入口、自动化任务预填与 timing 修复、默认关闭的 `apply_patch`、Cordis/Loader vendor 升级、按需交付的 CUA，以及数百项配套修复。吸收该 tag 需要单向 merge-forward，使专利、法务、文档与 self-evolve 等 fork 面落在 release 结构上，同时不改写历史、也不把上游的 `dsh-v*` tag 推到 fork。

## Decision

- **从 fork master tip merge-forward 到 `dsh-v0.2.2-alpha.3`。** 分支 `sync/upstream-dsh-v0.2.2-alpha.3` 合并该 annotated tag（不做 rebase 或 cherry-pick）。冲突按类别处理：共享 package manifest 先取 release 再并回 fork 依赖并集；docs/snapshots/lockfile 优先 release；代码冲突按双方契约合成。
- **版本族对齐 `0.2.2-alpha.3`。** 根与 workspace manifest 跟随 release；fork 独有包并入同一版本族。fork 不推送上游 `dsh-v*` tag。
- **`timeout-guard` 更名为 `timeout-policy` / `@deepseek-ai/dsh-tool-call-timeout-policy`。** 与 release 一并落地；npm 名与目录不再一致，因此 `tsconfig.base.json` 在生成区外保留手写 alias，消费方改用新包名。
- **保留 fork 的 FS `writeBytes` 与客户端 `dsh-value` inline。** local/sandbox/SSH provider 与 RecordingFileSystem fixture 继续提供 `writeBytes` / `FsTextWriteOutcome` 以及抽象的 `patchText`/`deleteFile`/`moveFile` stub。`INLINE_SAFE` 在 release 的 `util-time` 与 `commands/builtin` 之外保留 fork 的 `|value`，使客户端包仍可 inline `@deepseek-ai/dsh-value`。
- **`system-prompt` 保留 fork 消费者已在使用的 `./prompt-cache` 子路径导出。**
- **按需 CUA 离开 DSH 安装闭包。** `@deepseek-ai/dsh-cua-bundle` 进入 `ON_DEMAND_BUNDLES`，不得出现在 `@deepseek-ai/dsh`（`apps/cli`）的 runtime 依赖中；去掉 fork 先前的直接安装边，以便 `gen-official-bundle-catalog` 写入包自有元数据。
- **fork 跑不了的上游 CI 工作流继续归档。** 用 release 的 `ci-windows.yml`、`ci-python.yml` 等相关托管流水线刷新 `.github/workflows-disabled/`；`.github/workflows/` 下仍保留本仓库可调度的 fork 工作流。
- **生成面重新生成，不做手工合并。** 在 `build:artifacts` 之后，由各自生成器重写配置/工具/持久化/插件目录、模块图、Cordis/client inspect 目录、CLI help、session-format 目录、依赖目录、官方按需目录与 tsconfig path alias。
- **session-log-export 沿用 release 的本地 `messageOf` 助手。** 该包客户端控制器上的 fork `@deepseek-ai/dsh-value` 导入在恢复 `|value` 之前违反 bundle purity；对该包而言，release 的文件内助手面更小。

## Alternatives considered

- **把 fork rebase 到 release tag 上。** 否决：专利与法务历史必须从 master 经 merge 可达，rebase 会改写已发布栈。
- **只 cherry-pick release notes 里的头条提交。** 否决：alpha.3 约 460 个提交，目录、vendor 与客户端变更互相咬合；选择性拣选会漏掉生成面与重命名后果。
- **继续把 `@deepseek-ai/dsh-cua-bundle` 作为 `apps/cli` 的直接依赖。** 否决：release 的按需安装器负责交付，官方 bundle 目录门禁禁止按需 provider 出现在 DSH 安装闭包中。
- **从 `INLINE_SAFE` 去掉 `|value`，并把所有客户端导入改写到 `@deepseek-ai/dsh-util-values`。** 本次同步否决：fork 已把共享谓词沉到 `dsh-value`，恢复 wire-layer 白名单即可保留该决策，无需大规模改导入。

## Consequences

同步分支承载 release 以及 fork 的专利/法务/文档/self-evolve 面。合并树上 `pnpm run typecheck` 与 `pnpm run build:artifacts` 通过。合并前仍需完成 snapshot 回放、hygiene 与完整 `test:snapshot`。合入必须使用 merge commit（不可 squash），以便两侧 parent 可见。

## Testing

`pnpm run typecheck` 在 Host Typert、host/client 编译器与两侧聚合程序上退出码为 0。`pnpm run build:artifacts` 完成全部八个门禁，含 Client bundle 与 Web build。Decision 所列目录生成器重写各自产物；在补上 timeout-policy 手写 alias 并去掉 CUA 安装边后，`gen-tsconfig-paths` 与 `gen-official-bundle-catalog` 成功。本分支上的无密钥 snapshot 回放与 `pnpm run hygiene` 仍待执行。
