# Agent Note: 上游 v0.2.2-rc.3 同步

Status: implemented

[English](2026-11-15-upstream-dsh-v0.2.2-rc.3-sync.md) | 中文

## Problem

上游在 `dsh-v0.2.2-rc.2` 之后三天发布了 `dsh-v0.2.2-rc.3`,距 rc.2 只有 6 个提交。因为 rc.2 同步是以 merge commit 落库的,fork 与该 tag 的 merge base 就是 rc.2 的 tag 提交本身,本次只需一次内容合并,无需修补祖先关系。该版本带来一个新的可选实验包 `@deepseek-ai/dsh-deepseek-chat-import`、一份被沙箱准备脚本共用的 CI 下载辅助脚本,以及例行的全量清单版本号升级。

合并与 fork 自有代码在 11 个路径上冲突。其中两份是生成物或记录文件(`docs/config-catalog.md` 及其中文对、两份翻译配对哈希文件、一份 `pnpm-lock.yaml`),四份是 fork 扩展过的清单与编译登记(`apps/cli/package.json`、`packages/lsp/tool-lsp/package.json`、`tsconfig.client.json`、`scripts/experimental-package-policy.ts`),其余两侧各有实现:侧栏样式表与 bubblewrap 准备脚本。

## Decision

- **单步 merge-forward,PR 以 merge commit 落地。** merge base 已经落在 rc.2 的 tag 上,一次合并即可让 tag 从 master 可达,并保证下次 release 的 base 正确。
- **按上游原样接纳新包 `deepseek-chat-import`。** 该包注册 `ctx.deepseekChatImport`,提供仅 owner 可用的上传路由,把 DeepSeek 官网导出的每个对话导入为一个 Session。上游同时把它列入 `OPTIONAL_BUNDLES`、`MORE_BUNDLES` 与 `EXPERIMENTAL_BUNDLES`,因此它是 fork 各 profile 不挂载的可选实验 bundle;fork 不额外组合它。
- **在 fork 的 profile 下重录新包的 Web 钉值。** 上游是按它自己的 profile 录的 `snapshots/web/deepseek-chat-import/`,而那份 system prompt 既没有 fork 的插件市场发现段,也没有语言策略行,于是续聊用例挂在 system-prompt 钉值上。`DSH_SNAPSHOT=refresh` 从合并后的树重写了 system prompt 与工具 schema,两份差异都只增不减:发现指引、它的三个市场工具与那行语言策略。`snapshots/web/creation-recommendations/session.v4.jsonl` 的目录行则多出一条新包条目,由上游在该包进入 profile 所发现的目录时录制。
- **保留 fork 的 bubblewrap 多镜像回退,同时采纳上游的校验下载辅助脚本。** 该版本把内联 `curl` 换成新脚本 `scripts/ci-verified-download.sh` 里的 `acquire_verified_archive`,后者校验后原子写入缓存文件,缓存命中时不触网。fork 保留自己的三个有序主机——先 pin 住的 Launchpad 构建,再两份 Ubuntu pool 副本——因为 `launchpad.net` 的 503 频繁到足以让 job 失败;现在每次尝试都走辅助脚本,命中校验过的缓存时完全跳过网络,单个死掉的主机只花掉一次有界尝试。fork 的用例里针对旧内联 `sha256sum --check --status` 的断言被删除,因为校验已移入辅助脚本、相邻用例已断言该脚本调用;镜像顺序的断言保留。
- **侧栏样式表保留 fork 的品牌块,同时采纳上游的会话行包裹层。** 该版本在 `.newSessionRow` 包裹层旁新增 `.buildVersion`;fork 的品牌插件已替换掉构建版本徽标,故合并保留已合并组件实际渲染的包裹层,删掉不再被引用的徽标类文本。
- **把提升后工作台入口的样式对齐到被包裹的会话行。** 该版本把 New Session 按钮移进 `.newSessionRow` 内 `sidebar.session.action` HOC 槽位的内容层,外层外边距挪到包裹层,`.newSession` 归零并撑满该行。fork 的提升入口逐条复刻这层表面,因此它的规则去掉那层外边距;对应用例里 `renderSlot` 的替身改为渲染槽位的 `children`,即渲染器在没有层认领槽位时显示的内容。
- **把 owner 凭证 horizon 用例里的固定日期换成相对当前时钟的边界。** host 用真实时钟判断 horizon,而该用例把「有效」的 horizon 钉在一个已经过去的日期上,于是所有 `verified` 断言都读成 `expired`。`PAST` 与 `LIVE` 现在由 `Date.now()` 偏移得出。
- **重录两份翻译哈希、重新生成配置目录,而非手工合并。** 两侧改到了同一批生成或记录区段,因此用 `pnpm run gen-config-catalog` 从源码重写该目录对,并在新包的英文与中文表格行合并后,用 `pnpm run verify-translation-pairing --write` 重录 `docs/capability-seams.md` 与 `packages/experimental/README.md` 的分节哈希。
- **长函数计数升至 190。** 新包的 `importDeepseekChatExport` 有 160 行。其余五个受跟踪计数不变;fork 不在同步中拆分上游文件。
- **fork 自有清单对齐到 `0.2.2-rc.3`。** 根版本随 release 变化,`pnpm run constraints` 要求每份 workspace 清单与之一致;版本对齐不改动 `pnpm-lock.yaml`。

## Alternatives considered

- **沿用上游单一的 bubblewrap 下载地址。** 否决:fork 加镜像列表正是为了 Launchpad 的 503 会让 job 失败,而辅助脚本只重试一个主机。去掉镜像等于把 fork 已修过的故障放回去。
- **把上游用例的断言改成循环形式,而不保留一次字面主调用。** 否决:fork 的脚本先用 `BUBBLEWRAP_URL` 直接调辅助脚本、只在失败后回退到镜像数组,因此上游的断言依然成立,下次同步不必重新推导这处冲突。
- **恢复 `.buildVersion` 类。** 否决:合并后的组件不再引用它,它只会作为无解释的残留留在样式表里。
- **在 fork 的某个 profile 里挂载 `deepseek-chat-import`。** 否决:它把 DeepSeek 官网对话导入为 Session,没有 fork profile 需要它,任何挂载都会抬升该 profile 的插件与测试面。

## Consequences

master 与 rc.3 的 tag 共享可达的 merge base。fork 以上游的上传导入包作为不挂载的可选 bundle 携带它;启用它是配置改动,不是代码改动。沙箱准备脚本现在依赖 `scripts/ci-verified-download.sh` 与上游 workflow 恢复的 `~/.cache/dsh-ci/bubblewrap` 缓存目录。fork 自有清单保持在 `0.2.2-rc.3` 发布族内。`structure.long-functions` 台账记着一个 fork 不拆分的上游函数。

## Testing

`pnpm run build:artifacts` 重新生成了目录、模块图、客户端元数据与 bundle 产物,`pnpm run typecheck` 针对该产物编译了 host 与 client 两个聚合。`pnpm run lint`、`pnpm run duplication`、`pnpm run duplication:baseline`(95 对收紧域、13 对跨域)、`pnpm run constraints`、`pnpm run hygiene` 与 `pnpm run verify-translation-pairing`(1721 对)通过,六项生成物检查(`verify-config-catalog`、`verify-cordis-catalog`、`verify-cordis-api`、`verify-cordis-inspect-catalog`、`verify-module-graph`、`verify-tech-debt-counters`)与 `pnpm run doc-sync`(53 道门禁)亦通过。`pnpm run test:snapshot` 回放合并后的行为;Web 套件保持 `ci-fork.yml` 车道已记录的既有红(master 上 67 个文件,黄金值记为 fork 新增客户端插件之前的状态),新包的两条用例在重录钉值后通过。
