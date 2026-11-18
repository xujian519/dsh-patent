# Agent Note: 上游 dsh-v0.2.2-rc.5 同步

Status: implemented

[English](2026-11-18-upstream-dsh-v0.2.2-rc.5-sync.md) | 中文

## Problem

上游在 `dsh-v0.2.2-rc.4` 之后五个提交发布了 `dsh-v0.2.2-rc.5`。fork 与该标签的合并基正好是 rc.4 的标签提交，因此这一版只需一次内容合并，不需要修补祖先关系。发布内容包含两处用户可见变化：没有配置搜索提供方时，DeepSeek 模型路由上的会话搜索改为偏好 Messages 搜索；Messages 搜索结果优先使用条目自带的 `snippet`，缺失时才回退到引用摘录。此外还有所有已发布清单的版本升级，以及一份新的升级指南。

合并与 fork 自有代码在两处路径相撞：`web` 服务中 fork 抽出了共享的 `selectProvider` 辅助方法；`tool-lsp` 清单带有 fork 新增的依赖和字面破折号描述。

## Decision

- **一次内容合并完成 merge-forward，PR 以 merge commit 落地。** 合并基已经落在 rc.4 标签上，单次合并既让标签从 master 可达，也保证下一次发布的合并基正确。
- **让发布的 `preferredId` 走 fork 的 `selectProvider` 辅助方法。** 上游在 `selectSearchProvider` 里算出首选搜索提供方后直接传给 `resolveProvider`。fork 的 `selectSearchProvider`、`selectFetchProvider` 与 `resolveFetchProvider` 共用一个私有辅助方法，因此让该方法接收可选的 `preferredId`：搜索路径传入按路由推导的值，两条抓取路径不传。
- **按上游交付的形态采用路由相关的搜索默认值。** 没有配置 `searchProvider` 时，服务于 `deepseek-official` 或 `deepseek-account` 模型请求的搜索使用 `deepseek-official` 提供方（Messages 搜索，不按次收费），其余路由使用 `deepseek-search-api`。已配置的提供方 id 仍然优先。
- **在 `tool-lsp` 清单中保留 fork 的字面破折号与新增依赖，并采用发布版本号。** 描述文本本身未变，只有转义形式不同；`dsh-value` 是 fork 的依赖。
- **在上游已与 fork 做出同一决定的地方采用上游的真实时钟期限用例。** 上游在 #8465 中把写死的有效期限替换为按 `Date.now()` 推导；fork 在 #827 之后用 `NOW` 常量做了同样的决定。Git 的三方合并无冲突地保留 fork 的块，用例通过。
- **把 fork 自有清单推进到 `0.2.2-rc.5`。** 根版本随发布前移，而 `pnpm run constraints` 要求每个工作区清单与它一致。55 个 fork 独有的专利、法律、文档、桌面、自演化、视频与客户端清单跟进；vendor、native、examples、benchmarks 保留各自版本行，因为本次发布没有改动 vendor 版本。
- **九个 ACP 期望输出重新钉到 `0.2.2-rc.5`。** `agentInfo.version` 读取包清单元数据，所以每个握手钉都带发布版本。
- **把升级指南保留在上游选择的路径下。** 上游把搜索默认值指南放在 `docs/upgrade-guide/v0.2.2-rc.4/`——那是它改变行为的版本——fork 沿用上游路径。

## Alternatives considered

- **在 `selectSearchProvider` 与 `selectFetchProvider` 中恢复直接调用 `resolveProvider`。** 否决：fork 的 `resolveFetchProvider` 需要这个共享辅助方法，恢复直接调用会让选择规则第三次重复。
- **用 `DSH_SNAPSHOT=refresh` 重录 ACP 输出。** 否决：唯一的差异是版本串，重录会连带改写无关的钉值且没有收益。
- **采用上游 `DAY` 常量形式的期限用例。** 否决：两者表达的是同一个决定，而 fork 的块已经过评审与覆盖。

## Consequences

在 DeepSeek 模型路由上、没有保存搜索选择的会话现在通过 Messages 搜索进行搜索，按模型 token 计费；其他路由则通过 Search API 搜索。Messages 搜索结果自带摘录时保留它自己的摘录。fork 自有清单留在 `0.2.2-rc.5` 版本族，master 与 rc.5 标签共享可达的合并基。

## Testing

`pnpm run build:artifacts` 重建了目录、模块图、客户端元数据与 bundle（8 个门禁、387 份客户端产物），未留下跟踪文件改动；`pnpm run build:check` 针对该产物编译了两个聚合（2 个门禁）。`pnpm run typecheck`（5 个门禁）、`pnpm run lint`（退出码 0，无警告无错误）、`pnpm run duplication`（0 克隆）、`pnpm run constraints` 与 `pnpm run hygiene`（26 个门禁）通过。`pnpm run doc-sync` 在 `NODE_OPTIONS=--max-old-space-size=16384` 下通过全部 53 个门禁，因为本机树规模下 `verify-doc-graphs` 会超过默认堆上限。`pnpm run test:snapshot` 先刷新九个 ACP 钉值，再回放 275 个会话与 ACP 用例（2 个跳过）。`web`、`web-search-deepseek`、`web-deepseek-api`、`tool-web`、`ui-settings-web-search` 与 `liveshare` 的定向套件通过 2090 个用例。
