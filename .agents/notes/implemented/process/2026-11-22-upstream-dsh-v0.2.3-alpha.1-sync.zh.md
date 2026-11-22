# Agent Note: 上游 dsh-v0.2.3-alpha.1 同步

Status: implemented

[English](2026-11-22-upstream-dsh-v0.2.3-alpha.1-sync.md) | 中文

## Problem

上游于 2026-11-21 发布 `dsh-v0.2.3-alpha.1`（`d98f5d6851`），距 fork 上次同步的 `dsh-v0.2.2-rc.5`（`9c2670d3bc`）有 2343 个提交。该标签正好是 `git merge-base origin/master dsh-v0.2.3-alpha.1`，因此这一版只需一次内容合并，无需修补祖先关系。

这次发布的规模是一个完整 alpha 周期，而不是两个 rc 之间的补丁：7260 个文件、+302202/−83093 行、329 处内容冲突，分布在 `packages/*/tests`（86）、`packages/*/src`（59）、清单（26）、`docs`（25）、中文页（25）、`.i18n.yaml` 记录（38）、快照（17）、`scripts`（15）与 `.agents`（6）。它带来的改名与删除直接影响 fork 的消费方：

- Cordis 升到 `4.0.0-rc.12`（Loader 与 Include API），fork 自有的每个插件与 profile 补丁都要对照 vendored 源码复核。
- `packages/experimental/ptc-runtime-python` 与 `packages/experimental/personalized-recommendations` 整包删除，连带 fork 在 bundle、profile、快照与文档中引用的 Python PTC 通道。
- 新增 26 个包，包括 `account/deepseek-auth`、`client/ui-session-status`、九个 `connector/*` 提供方、`host/authentication-desktop`、`host/authentication-token`、`session/session-persistence-sqlite` 与 `util/text-search`。
- fork 自有包调用的若干 seam 变了：DeepSeek 请求统一经 `ctx.deepseekAuth` 解析；`list_agents` 的行改放在 `agents` 字段下；工具失败改用结构化错误码；包入口不再导出测试专用符号与旧子路径；会话工作目录与工作树改用 `enter_worktree`/`exit_worktree`，`working_directory` 工具被移除；客户端插件产物自装样式，CSS Modules 类名格式也不同。

## Decision

- **单步向前合并，PR 以合并提交落地。** 合并基就落在 rc.5 标签上，一次合并既让标签可达，又让下一版的 base 保持正确；此处若用 squash，会把上游历史第二次从 DAG 上摘掉。
- **接受上游的两处删除，并在同一改动里清掉 fork 的全部引用。** `ptc-runtime-python` 从 vendor 消费方、bundle 与 profile 补丁、PTC 快照和 Python 运行时文档中消失；描述 fd-3 协议的已实现 note 随其代码一起移入 `.agents/notes/archived/`。`personalized-recommendations` 随它以默认行进入 bundle 的那一项一起移除。
- **保留 fork 自有产品面，并把它们迁到改名后的 seam。** `packages/patent`、`packages/legal`、`packages/law`、`packages/self-evolve`、桌面 `bridge` 架构与品牌层、以及 fork 自有门禁全部保留。凡是上游改名的调用点——`list_agents` 的 `agents` 字段、结构化工具错误码、会话状态包、`ctx.deepseekAuth`——跟随上游，而不是在本地钉住一份副本。
- **保留 fork 的 `dsh-entry-lifecycle` 状态机，并把 `Session` 重新接回它。** 上游把 `Session` 重新聚合进 `core/session` 的入口，并把 fork 曾抽取的 announcement、dispatch 与延迟移除字段内联回去；照抄那份内联实现等于复活 `entry-lifecycle` 正是要消除的重复状态机。合并后的入口保持上游的单文件布局，但每个 entry 持有一个 `EntryLifecycle`：`enter`、`commit`、`detach` 与 `announce` 都把状态转移委托给该包。
- **fork 从未改名的包直接采用上游名称。** `packages/guard/timeout-policy` 在合并基上就已经叫上游的 `@deepseek-ai/dsh-tool-call-timeout-policy`，因此本次发布的清单更新原样适用。
- **整个 workspace 对齐到 `0.2.3-alpha.1`。** 根清单跟随发布；fork 独有清单（patent、legal、document、desktop、self-evolve、video、client）与 `SIDEBAR_SERVICE_VERSION` 一并跟随，因为 `pnpm run constraints` 要求版本族一致。
- **`standard` 采纳上游新增的 `tool-cordis` 行，三个交付 preset 记为已说明的缺席。** `packages/extensions/tool-cordis` 是给编写或配置插件的 agent 用的只读运行时 API 发现工具；文档、法律、专利三种交付都没有插件创作步骤，而单靠 preset 行不注册任何提供方——宿主组合对每个 Web preset 都只挂载一次 `@deepseek-ai/dsh-tool-cordis/host`。`scripts/preset-mode-baseline.json` 因此为每个 preset 写明理由，而不是放宽基线。
- **重录生成态基线，而不是放宽门禁。** `scripts/preset-divergence-baseline.json`、翻译配对记录、`docs/TECH_DEBT.md` 的计数表、模块图、Cordis 目录与客户端元数据，都改成本次合并后的真实产物。
- **用一条以版本命名的记录接上持久化变更链。** 上游新增的五条记录挂在它自己的前驱上，因此以同版本记录 `2026-11-22-v023-alpha1-sync` 声明 `previous: 2026-11-19-cua-input-notices`，并重新确认 fork 新增的事件根（`patent-rule-gate`、`patent-teams-report`、`self-evolve`），使它们不再被读成新增代际。
- **整目录吸收上游的 `docs/upgrade-guide/v0.2.2-rc.1` 至 `v0.2.2-rc.5`。** fork master 从未带过这些指南；上面每一处 fork 消费方迁移，都以它们为核对清单。

## Alternatives considered

- **把 fork 的提交 rebase 到发布之上。** 否决：那会重写 fork 已发布的历史和发布自身的合并基，而 fork 的分支上还有别的会话正在基于的已评审提交。
- **把上游最新的持久化记录指到 fork 链上，而不是新增桥接记录。** 否决：已提交的代际不可变，新记录应当声明真实前驱，而不是编辑发布自带的记录。
- **squash 合并以保持 master 线性。** 否决：fork 自己的升级指南已记录标签必须可达的理由，rc.2 那次事故就是失去它的代价。
- **在文档、法律、专利 preset 里也挂上 `tool-cordis`。** 否决：三者都没有插件创作步骤，该行会宣传一个宿主已为每个 preset 注册提供方的工具。
- **提高结构债阈值或删掉 `requiredRows` 条目来过门禁。** 否决：计数变化的原因是上游新增了文件，而不是 fork 的标准变了；报告记录实测数字与归因。

## Consequences

fork 现在运行在 Cordis 4 上，DeepSeek 凭据统一经一个服务解析，而它的 Python PTC 通道随承载它的包一起消失。26 个新包到来，包括 SQLite 持久化后端、连接器提供方，以及桌面与 token 两条认证行。god-file 拆分 note 里记录的 session folds 与 session-object 抽取已不再作为模块存在——`Session` 与 `SessionStore` 又回到 `core/session` 的入口，`SurfaceManager` 拥有 folds——因此那部分历史被归档。entry 生命周期状态仍留在 `packages/util/entry-lifecycle`：`SessionEntry` 持有一个 `EntryLifecycle`，entry 模块自身不再保留 announcement、dispatch 或 detach 标志。

债务台账随上游的文件增长：超过 150 行的函数 208 个、超过 800 行的源文件 102 个、`v8 ignore` 注释 1348 条，而专利域的大文件仍是 9 个。master 与 alpha.1 标签保持可达的合并基，下一版同步以该标签为 base。

## Testing

`pnpm run typecheck` 通过全部五个门禁（Host Typert、host 与 client 编译器、两个聚合检查）。合并提交上 `pnpm exec vitest run` 跑 10438 个套件、72995 个用例：72764 通过、231 跳过、darwin 上零失败，`pnpm run verify-test-skips --report <darwin json> --update` 已把该平台预算记为 72995 个用例、231 个跳过。`verify-cordis-config` 接受 448 个配置文件，`pnpm run persistence-changes --check` 以 49 条历史记录收口 90 个根。`verify-translation-pairing` 报告 1886 对一致，`verify-tech-debt-counters` 接受六个声明计数（`structure.long-functions` 207、`structure.large-files` 102），`verify-doc-budgets` 让七篇受控文档全部落在预算内。
