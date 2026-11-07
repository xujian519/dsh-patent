# Agent Note: 上游 dsh-v0.2.1-alpha.5 同步

Status: implemented

[English](2026-10-16-upstream-dsh-v0.2.1-alpha.5-sync.md) | 中文

## 问题

fork 从上游的 `dsh-v0.2.1-alpha.4` tag 前进到 `dsh-v0.2.1-alpha.5`：36 个提交（25 个非合并提交）、586 个文件、+3,129/−1,117 行，新增 23 个文件，无删除、无改名。merge base 就是 alpha.4 的 release commit 本身，而那一次同步以 merge commit 落地，因此一次 `git merge` 即到达该 tag，没有任何上游提交被重新推导。`git merge-tree` 预测 4 个冲突文件，实际合并恰好产生 4 个，是迄今冲突最少的一次同步。

这个 release 的主体内容是桌面、Web 与账号设置。Windows 打包 runner 交由 Task Scheduler 监管；发布流程新增 `preflight-desktop-publish` / `desktop-publish-qualification` 脚本对，并附上留存产物与 COS 拒绝的 golden；Windows 打包默认为签名；账号设置插件新增层叠通知面（`notice-transition.ts`，以及 `v0.2.1-alpha.4/account-notification-fields` 升级指南）。Web 获得 provider 感知的模型标签 slot、按会话共享的终端发现、插件变更后的斜杠菜单刷新，以及一处侧栏裁剪修复。vendor 拿到分阶段推进的 `cordis-rc11-upgrade-plan.md`。

只有一条上游工作线触及 fork。release 的两个提交重做了 PTC 指令的组装方式，使任何调用点都不再依赖共享散文，随后又把面向模型的措辞恢复到已发布 SDK persona 所兼容的文本。两者合起来重写了 `packages/core/tool-executor-ptc/src/ptc.ts`、`ts-types.ts` 与 `py-types.ts`，恢复后的措辞还传到 `packages/fs/tool-fs/src/read.ts`、`packages/subagent/tool-subagent/src/index.ts`、工具 catalog，以及每一份带 system prompt 的 session 与 SDK 快照。

## 决策

- **本同步分支对 release tag 做 merge-forward。** `sync/upstream-dsh-v0.2.1-alpha.5` 承载这次合并，PR 以 first parent 为 fork `master` 的 merge commit 落地。squash 会把上游提交移出 fork 的提交图，并把下次同步的 merge base 推回这个 tag。
- **冲突按类别解决，绝不按行范围取一侧。**

  | 文件 | 解法 |
  |---|---|
  | `packages/core/tool-executor-ptc/src/ptc.ts` | 保留 fork 的 run-code flavor 抽取，把 release 的改动移植进去 |
  | `packages/lsp/tool-lsp/package.json` | 取 fork 的 manifest，仅把版本提到 `0.2.1-alpha.5` |
  | `docs/tool-catalog.i18n.yaml` | 生成物附属文件；由生成器重录 |
  | `snapshots/session/ptc-python-turn/tool-schemas.expected.json` | 由 fork 回放重录；两侧都不复制 |

- **release 的 PTC 改动落在 `run-code-flavor.ts`，而不是 `ptc.ts`。** fork 把一个语言的 `run_code` 描述与它的 `code` 参数描述放在一起，位于 `packages/core/tool-executor-ptc/src/ptc.ts`，上游没有这个模块。上游两个提交带来四项改动：`runCodeFlavor` 获得 `execution` 覆写，用于程序格式措辞；新增 `TYPESCRIPT_FUNCTION_FLAVOR` 描述 `programFormat` 为 `function-body` 的运行时；`resolveFlavor` 在 `runtime.language === 'typescript' && runtime.programFormat === 'function-body'` 时分支到它；参数顺序把 `code` 移到 `description` 之前，静态 `parameters` 块与动态 getter 都改，jsdoc 与 `RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION` 中被删掉的「Provide `description` before `code`」一句随之调整。前三项属于 flavor 模块，已移植进 `run-code-flavor.ts`；第四项属于 `ptc.ts`，自动合并完成。
- **release 有意改动面向模型的提示文本，重录后的 golden 承载 release 的文本。** 恢复措辞的那个提交把文本移回已发布 SDK persona 所兼容的版本，因此合并后的树在 fork 合并前发出较长句子的地方发出**较短**的句子：`read` 去掉「or sed, head, or tail」并加上「to continue reading large files」，subagent 段落删去「end your turn instead of sleeping or polling」一句。两句的来源文件随文本一同变动。在这里与 release 不一致的重录 golden 是构建产物问题，不是 fork 分歧。
- **版本在 fork 自有面上统一钉住。** 根 manifest、47 份 fork 独有 manifest，以及 已随 PR #677 删除的 better-sidebar 包的 `service.ts` 中的 `SIDEBAR_SERVICE_VERSION` 一并前进到 `0.2.1-alpha.5`。`pnpm exec tsx scripts/release/verify.ts --family dsh` 在该版本下解析出 388 个家族成员，无未排序的 peer 声明；`pnpm install --lockfile-only` 报「Already up to date」，未触碰 `pnpm-lock.yaml`。
- **工具 catalog 配对重录，而非取某一侧。** `docs/tool-catalog.i18n.yaml` 由 catalog 的成对页面生成；生成器同一次运行重写了 `docs/tool-catalog.md`、`docs/tool-catalog.zh.md`、`docs/config-catalog.md`、`docs/config-catalog.zh.md` 与 `apps/cli/composition.md`，`verify-translation-pairing --write` 重录附属文件。
- **快照按改动归属切分。** 上游改动了 97 个快照文件（13 个 SDK、77 个 session、7 个 web），97 个全部在合并结果中。其中 18 个两侧都改过——PTC 提示文本家族加上 `snapshots/sdk/sdk.snapshot.ts`——这些由回放 fork 的树重录，而不是取任何一侧。九份 `snapshots/acp/*/stdout.expected.jsonl` 把 `agentInfo.version` 重新钉到 `0.2.1-alpha.5`，这是 ACP 回放报出的唯一漂移。web lane 无需重录：它变动的 7 个文件都来自上游，五份 `apps/web/tests/*.snapshot.ts` driver 原样通过。
- **任何 `DSH_SNAPSHOT=refresh` 之前先跑 `pnpm run build:artifacts`。** 快照 harness 会启动真实的 profile 运行时，而后者把 workspace 包解析到构建后的 `lib/`，因此比合并后的 `src` 更旧的 `lib/` 会静默污染每一份重录的 golden。这是本次同步耗时最多的陷阱，记在「后果」中。

## 后果

fork 带着上游 v0.2.1-alpha.5 的基线发布，专利、self-evolve、桌面、better-sidebar 与 document 各面保持完整；冲突数从上一次的 38 降到 4——上一次同步给 fork 的插件目录改名，消除了当时占主导的 add/add 撞车。

这个 release 补上的教训是：源平面门禁与产物平面门禁可以同时报成功却互相矛盾。`pnpm run typecheck` 通过 tsconfig `paths` 读 `src`，在合并后的树上通过；`DSH_SNAPSHOT=refresh` 读到的却是合并前构建留下的旧 `lib/`，于是第一轮对 `snapshots/sdk` 的重录写出 11 份 `system-prompt.expected.md`，承载 fork 合并前的措辞，并以成功状态退出。无论是合并还是重录的退出码，都无法把这种情况与一次正确录制区分开。识别它靠的是对同一句话做四参考点比对——merge base、`master`、release tag、`HEAD`：merge base 与 `master` 是长句，tag 与 `HEAD` 是短句，而刚写出的 golden 是长句，属于一棵已不再检出的树。`git checkout -- snapshots/sdk`、`pnpm run build:artifacts`、再重录一次，产出的 golden 与该 tag 一致。

错误文本之所以看起来可信，源于那个恢复提交的形态：一个主题为「恢复 PTC 指导与 SDK persona」的 release 提交，把面向模型的文本向**回**移动，移向更早 release 发布过的措辞。这里的冲突不能靠「哪一侧看起来更新」来解决，重录后的 golden 才是合并后的树实际发出哪一侧文本的唯一证据。

三项分歧在每次 release 仍需关注，与以往相同：fork 的 preset 是上游组装变化落地之处；对上游退役的笔记，归档印章必须与上游一致；fork 的笔记必须跟随上游的 workflow 路径进入 `workflows-disabled/`。release 在 `.github/workflows/ci.yml` 中新增的 pwsh 解析步骤经改名检测落到了 fork 的归档副本 `.github/workflows-disabled/ci.yml`，因此 fork 被禁用的 workflow 与 release 保持一致，无需手工移植。

## 备选方案

- **整份采用 release 的 `ptc.ts`，放弃 fork 的 flavor 抽取。** 否决：抽取正是让一个语言的两条面向模型字符串共处一处的机制，倒退回会让此后每次 release 重新推导同一个冲突。
- **把 flavor 模块并回 `ptc.ts`，以贴合上游的布局。** 同理否决；而且这还得把 release 的 function-body flavor 塞进一个 release 自己保持无逐语言文本的文件。
- **取 release 的 `packages/lsp/tool-lsp/package.json`。** 否决：fork 的 manifest 列出了 `@deepseek-ai/dsh-value`，以及 fork 自己对工具调用超时包的 `dsh-timeout-guard` 改名，release 的 manifest 两者都没有。fork 侧与 release 侧的差异恰好是这两条依赖、描述行的字符编码与版本号。
- **在重建 workspace 之前就重录 PTC 提示快照。** 事后否决：那正是产出「后果」中所述 11 份被污染 golden 的一轮。可用的顺序是先构建，再重录。
- **取 release 的 `docs/tool-catalog.i18n.yaml`，只在门禁失败时才重录。** 否决：fork 的 catalog 带有 release 没有的行，因此该附属文件的逐标题哈希不属于任何一侧的文件；生成器加 `--write` 是唯一正确的产出方式。

## 测试

`pnpm run typecheck` 五道门禁全过——Host Typert、host 与 client 编译器，以及两个聚合——在合并后的树上执行，正是它证明 release 的 PTC 改动与 fork 的 flavor 模块相容。

`pnpm run lint` 退出码 0，仅剩 `packages/experimental/client-ui-cot-translation/src/index.ts` 中那条既有的 unused-disable 警告。`pnpm run hygiene` 报 22/22 通过，正是它确认 fork 对工具调用超时包的 `dsh-timeout-guard` 改名没有留下指向 release 名字的悬挂引用。

`pnpm run doc-sync` 报 50/51。唯一失败项是 `verify-repository-references`，与上一次同步相同。该门禁把七至四十位的十六进制串与本地对象库比对，凡是一个提交的唯一前缀即判为维护中的提交引用。`python/sdk/uv.lock` 中一个 pillow wheel 的字节数恰好与这样一个前缀重合，而 alpha.3 与 alpha.4 同步笔记在记录这同一处失败时引用了那个字节数。该门禁自身的契约写明，浅历史中不存在的对象无法匹配，因此 CI 的浅克隆报不出这些行；`git diff --stat master HEAD` 显示被点名的文件均未被本次合并触碰。本笔记因此以提交主题而非 hash 指代 release 的提交。

`pnpm run build:artifacts` 接着 `pnpm run build:check` 通过，这一对把合并后的 `src` 写进 `lib/`，位置在「后果」所述的重录之前。

`pnpm run test:snapshot` 在 session、sdk、acp 与 web 四个 lane 上回放 223 条无密钥用例，2 条跳过，无失败，共 4 个测试文件。五份 `apps/web/tests/*.snapshot.ts` driver 15/15 通过。

`pnpm run test:coverage` 不写出 `ERROR: Coverage` 行，而那正是该门禁对逐文件 100% 的通过条件；52,894 条用例中通过 52,667 条。七条失败，无一落在本次合并触碰的路径上。五条是在满负载下耗尽预算的整仓扫描与真实 watcher（`scripts/report-structure.spec.ts`、`scripts/persistence-schema.spec.ts`、`scripts/verify-suppression-reasons.spec.ts`、`packages/boot/hmr/tests/watch-config.spec.ts`、`packages/api/workspace-files/tests/changes.spec.ts`）；单独重跑时五条全部通过，包括此前几次同步为 `watch-config.spec.ts` 加上的、基于 `_closers` 的武装等待循环。一条来自本 shell 导出的 `NoDefaultCurrentDirectoryInExePath`，它让 `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts` 读到的 Windows `PATH` 缺少前导项：在 `env -u NoDefaultCurrentDirectoryInExePath` 下，它的 35 条用例全部通过。第七条是 `packages/patent/patent-tools/tests/figure-freecad-real-render.spec.ts`，它同步 spawn 本机 FreeCAD；该探测永不返回，用例自身的超时无法打断它，于是它占住整个 lane 十七分钟，直到进程被杀。CI 不安装 FreeCAD，该 suite 在 CI 上跳过。

`pnpm run verify-test-skips` 把 darwin 记为 52,894 条用例、219 条跳过，取自同时产出覆盖率数字的那一次 `pnpm test`。此前为 release 的平台门控用例记账的那次提交已把 linux 改到 52,836 与 222，却把 darwin 留在了 alpha.4 的数字上；而本平台的预算，按此前几次预算提交所遵循的惯例，取自本地运行。两个平台的跳过数仍相差三，与 release 之前相同。
