# Agent Note: upstream v0.2.2-rc.2 sync

Status: implemented

[English](2026-11-12-upstream-dsh-v0.2.2-rc.2-sync.md) | 中文

## Problem

上游发布 0.2.2 系列的第二个候选版本 `dsh-v0.2.2-rc.2`，相对 `dsh-v0.2.2-rc.1` 带有 1568 个提交。上一个 release 的祖先链只能靠一次补做的 `-s ours` 合并让 master 记录，而本 tag 的祖先直接回溯到 rc.1 的合并父提交，因此 merge base 落在受维护的上游历史上，而不是 squash 压平的结果。对这样一个 base 做内容合并，仍会在 220 条路径上与 fork 自有代码相撞；同时该 release 重组了 fork 所组合的包：`office-to-pdf` 变成 `office-kit`，旁边新增 `tool-office`；实验性 agent-team 包移入 `team/`；两个 `web-search` provider 包被删除；account 相关包被替换。

## Decision

- **以一次内容合并向前合并，并让 pull request 以 merge commit 落地。** 该合并把 `dsh-v0.2.2-rc.2` 记录为父提交，使下一个同步仍能从 master 到达该 tag，并针对 220 个冲突逐个用三方差异裁决，而不是重放 master 已有答案的 fork 决策。
- **整体采纳上游的包重组**——`office-kit` 与 `tool-office`、移出 `experimental/` 的 `team/agent-team` 与 `team/tool-agent-team`、`client/ui-agent-team`、新增的 `experimental/terminal-panel`、`mcp/mcp-manager`、`util/error`、`util/ripgrep`、`client/ui-account-notifications`，以及 `api/account-controller`、`credentials/deepseek-account-platform`、`web-search-exa`、`web-search-perplexity` 的删除。fork 通过 bundle 与 preset 组合这些包，保留旧目录等于冻结一份上游已在别处维护的代码快照。
- **重建 `verify-plugin-entry-exports` 基线，而不是豁免 fork 包。** 该门禁是本 release 新增的；基线文件起初只有上游的 566 条，现在列出 125 个包、1385 条导出，包含 fork 独有的专利、法务与 self-evolve 条目，并删除两条上游已不再导出的条目。
- **把 jscpd 的理由注释留在忽略标记上方。** 该 release 把说明移到 `/* jscpd:ignore-start */` 之后，而 `verify-suppression-reasons` 只读取指令上方的注释，因此会判违规；注释文本沿用上游原文。
- **给 `rescope-vendor` 增加三条窄豁免**，对应 release 把 `cordis` 写成本地 agent preset id 而非包名的文件——创建者流程 e2e 以及两份 subagent-interrupt 升级指南。全局跳过会让真实的 vendor 残留漏检，逐文件条目使其余位置仍受检查。
- **把合并只改动一侧的 fork 自有译文与英文源对齐**：`docs/capability-seams.zh.md` 的十二条 fork 服务行与 Mermaid 块、`packages/client/web/README.zh.md` 的源码地图，以及重新生成的 `docs/event-producer-consumer` 中英两版。
- **在专利 preset 中跟随 agent-team 包改名**，并把它对两条通道的说法分开表述：通用 subagent 控制工具面向 subagent 树，官方 agent-team 工具只是在该组合中未启用。包改名同时更新对应 spec 断言。
- **不新写 fork 自己的升级指南。** 该 release 在引入各项变更的 release 目录下补齐了 45 份指南——包括 office kit、subagent 名称、会话 append 重载与 web-search 移除——并且自身没有创建 `docs/upgrade-guide/v0.2.2-rc.2/` 目录，因此每一项对外可感知的破坏性变更都已有记录。
- **采纳上游的客户端启动策略，并归档记录其前身的 fork note。** rc.2 用一份全局 `requiredClientEntryNames` 名单取代 fork 的逐行 `required` 标记，名单只列七个核心客户端包。名单之外的行——包括当前 profile 安装的每个包——都可以不激活而不影响启动，因此 fork 按「profile 安装的行」实现的宽容成为上游规则的子集，启动行为没有损失。描述逐行标记的 fork note 随其记录的实现一起移入 `archived/`。
- **给 fork 的 duplication 基线补一条克隆对。** 该 release 在 `office-kit` 的 `queue.ts` 与 `types.ts` 之间引入一处 jscpd 克隆。`scripts/duplication-baseline.json` 在上游没有对应文件，因此本次同步只登记这一对，而不是放宽阈值或豁免整个包。
- **把全部 433 个受跟踪 manifest 移到 `0.2.2-rc.2`。** vendor manifest 保持 rc.1 同步已记录的 4.1.0 版本族；本 release 只改版本号。

## Alternatives considered

- **用 `-s ours` 记录 tag，再单独应用差异。** 否决：那是针对 rc.1 被 squash 压平做的变通。这里的祖先链完整，ours 合并会丢弃 1568 个提交的真实上游工作，使 fork 失去它声称跟踪的代码。
- **把同步 squash 进 master。** 否决：这会抹掉第二个父提交，而它正是下一次 release 合并基正确的前提。
- **关闭 `verify-plugin-entry-exports`，或把 fork 包登记为未加载。** 否决：该门禁保护「函数插件与服务插件各自保持导出形式」这一 loader 约定。基线条目表达的是既有例外；关掉规则会连各包新增的违规一起放过。
- **在 rescope 检查中全局跳过 `cordis`。** 否决：`cordis` 在其他所有位置都是包名，全局跳过会掩盖 vendored 组合文件里的真实残留。
- **另写一份 `v0.2.2-rc.2` 升级指南重复已补齐的主题。** 否决：一项变更两份指南会让升级路径产生歧义，而上游放在引入它的 release 下才是已发布用户会读到的位置。

## Consequences

master 与 rc.2 tag 共享可达的合并基，下一个 release 无需再补造父提交。fork 独有包保持在同一 release 版本族 `0.2.2-rc.2`。`scripts/plugin-entry-existing-exports.ts` 现在登记 125 个包；fork 包新增公开导出必须扩充它，门禁会点名缺失条目。专利 preset 对 `@deepseek-ai/dsh-tool-agent-team` 只有否定断言，因此改名不改变该 preset 实际挂载的插件。fork 跟踪的是 `dsh-v0.2.2-rc.2` tag，而非 `upstream/master` 的最新提交：同步时该分支另有 166 个提交（其中 128 个非 merge），涵盖本次合并不包含的 CUA 与 PTC 工作，它们将随发布这些改动的 release 一并进入。

## Testing

`pnpm run build:artifacts` 重新生成了目录、模块图、能力 seam 与客户端元数据，`pnpm run build:check` 针对该产物编译聚合检查。`pnpm run test` 与 `pnpm run test:snapshot` 覆盖合并后的行为与重录的期望输出；`pnpm run test:docs`（30/0）与 `pnpm run hygiene`（25/0，含 vendor rescope、suppression reasons、plugin entry exports 与 unknown-cast 门禁）通过，`pnpm run duplication`（无克隆）与 `pnpm run gen-doc-graphs --check` 亦通过。

`pnpm run test` 在本机有 3 条用例失败，单跑均通过：`boot/hmr` 的配置替换用例在全量负载下超出 5 秒预算，`liveshare` 的 Relay 不可达用例等待本机解析器从不回答的 `.test` 主机名，`subprocess-local` 的 Windows PATH 用例读到外层 shell 导出的 `NoDefaultCurrentDirectoryInExePath`。三者都不触及本次合并的代码路径。
