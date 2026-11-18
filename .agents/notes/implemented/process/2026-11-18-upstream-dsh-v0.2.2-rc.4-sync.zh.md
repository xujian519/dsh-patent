# Agent Note: 上游 v0.2.2-rc.4 同步

Status: implemented

[English](2026-11-18-upstream-dsh-v0.2.2-rc.4-sync.md) | 中文

## Problem

上游在 `dsh-v0.2.2-rc.3` 之后三天发布了 `dsh-v0.2.2-rc.4`，晚六个提交。fork 与该标签的合并基正好是 rc.3 的标签提交，因此这一版只需一次内容合并，不需要修补祖先关系。发布内容包含三处用户可见变化：DeepSeek 流式拒答改为上报已计费用量后以 `CONTENT_REFUSED` 失败；LiveShare 隧道 worker 继承 Host 的 Electron Node 模式；所有者凭据期限的测试用例改由时钟推导时刻。此外还有所有已发布清单的版本升级，以及一份新的升级指南。

这次合并与 fork 自有代码在五个路径上冲突：LiveShare 的期限用例、`llm-deepseek` 的中英文 README 及其配对记录、`tool-lsp` 清单。另一件事是，合并前的主干上 `pnpm run doc-sync` 本来就失败：`verify-export-jsdoc` 报告 `packages/patent/patent-tools/src/figure/vector-figure-build.ts` 的 `buildVectorFigure` 没有 JSDoc，所以单靠同步无法把这条门禁变绿。

## Decision

- **用一次内容合并前向合并，PR 以合并提交落地。** 合并基已经在 rc.3 标签上，一次合并就能让标签从 master 可达，下一个版本的合并基也就正确。
- **原样采纳上游的拒答处理，并在同一段里保留 fork 的传输子句。** 本次发布把 `CONTENT_REFUSED` 加入 `LLM_FAILURE_CODES`，在抛出前上报最终用量，并保留提供方的说明，例如哪些图片被拦截。两侧都改了 `llm-deepseek` 的失败段：fork 的 `TRANSPORT` 句子点名了 `diagnostic` 中带错误码的链路错误，因此合并后的段落把这句放进上游的新文本里，并重记配对哈希。
- **接受上游改写的时钟相对期限用例，它与 fork 已做的决定相同。** fork 在 #827 之后用 `NOW` 常量替换了固定的 `START` 日期；上游同样用 `Date.now()` 推导 `PAST` 与 `LIVE`。合并保留 fork 的版本，因为它已经过评审和测试。
- **`tool-lsp` 描述保留 fork 的字面破折号，版本跟随发布。** 描述文本没有变化，差别只在转义写法。
- **把 fork 自有清单推进到 `0.2.2-rc.4`。** 根版本随发布前移，而 `pnpm run constraints` 要求每个工作区清单与它一致。55 个 fork 独有的专利、法律、文档、桌面、自演化、视频与客户端清单跟进；vendor、native、examples、benchmarks 保留各自版本行，因为本次发布没有改动 vendor 版本。
- **九个 ACP 期望输出重新钉到 `0.2.2-rc.4`。** `agentInfo.version` 读取包清单元数据，所以每个握手钉都带发布版本。
- **在同一个 PR 里补上 `buildVectorFigure` 缺失的 JSDoc。** 主干的 `doc-sync` 聚合在这条导出上已经失败，同步分支不加这条 JSDoc 就过不了同一个聚合。
- **不记录任何新的 fork 配置。** 本次发布中间的 `safetyCheck` 开关和常开的 `safety_check` 请求字段在同一版本内被撤回；标签的最终状态不发送该字段，只用测试断言它不存在。

## Alternatives considered

- **采用上游的期限改写，替换 fork 的版本。** 否决：两者表达同一个决定，而 fork 的命名已经过评审并有覆盖。
- **用 `DSH_SNAPSHOT=refresh` 重记 ACP 输出。** 否决：唯一的不一致是版本字符串，录制一遍只会顺带改写无关的钉。
- **把导出 JSDoc 的失败留给单独的 PR。** 否决：`doc-sync` 是必需门禁，主干已经在这条上失败，带着它同步不可能变绿。
- **把新的升级指南放到 `docs/upgrade-guide/v0.2.2-rc.4/`。** 否决：上游把拒答指南放在 `v0.2.2-rc.3` 下，那是它改变行为的版本，fork 沿用上游路径。

## Consequences

master 与 rc.4 标签共享可达的合并基。Session 现在会记录带计费用量的 `CONTENT_REFUSED` 尝试，替代 `MALFORMED_RESPONSE`，Web 客户端会为该失败撤回已流式显示的回复。桌面宿主启动 LiveShare 隧道 worker 时进入 Electron 的 Node 模式，外壳的单实例锁不会再结束该 worker。fork 自有清单留在 `0.2.2-rc.4` 版本族，让主干文档聚合一直红着的导出 JSDoc 缺口已经补上。

## Testing

`pnpm run build:artifacts` 重新生成了目录、模块图、客户端元数据与打包产物（8 条门禁），`pnpm run build:check` 针对该产物编译了两个聚合（2 条门禁）。`pnpm run typecheck`（5 条门禁）、`pnpm run lint`（8577 个文件 0 警告 0 错误）、`pnpm run duplication`（0 个克隆）、`pnpm run constraints` 与 `pnpm run hygiene`（26 条门禁）全部通过。`pnpm run doc-sync` 在 `NODE_OPTIONS=--max-old-space-size=8192` 下 53 条门禁全过，因为 `verify-doc-graphs` 在这棵树上会超出本机默认堆上限。`pnpm run test:snapshot` 回放 275 个会话与 ACP 用例（跳过 2 个）。`llm`、`llm-deepseek`、`liveshare`、`patent-tools` 的定向测试通过 5207 个用例，只有 `packages/experimental/liveshare/tests/host-relay-checks.spec.ts` 的 `reports an address that does not answer with its transport cause and the relay prefix` 失败，其 `afterEach` 十秒超时；同一用例在合并前的主干上同样失败，属于本机环境问题，与本次同步无关。
