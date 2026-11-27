# 专利域全量审阅（11-patent）

本目录是专利域的全量审阅专档，接续 [上级 45 天计划](../README.md) 在专利域留下的 38 条未修发现与 `F-PAT-033..038` 六条测试缺口（`D27–29`，`R-D1` 批次）。上级计划的日常节奏与发现模板继续适用；本专档只替换「范围、验收判据与批次」三件事。

与上级计划的一处差异需要显式记录：上级目录约定「只承载审阅文档，不改业务代码」，本专档经用户授权改为**审查 + 分批修复**，修复与测试同批提交。

## 范围

范围内：`packages/patent/` 16 个包、`packages/client/ui-patent-teams`、`packages/client/ui-brand-patent`，以及接线配置（`packages/bundle/web-app/presets/patent.patch.yml`、`legal.patch.yml`、各包 `package.json` 依赖方向、realm 隔离、技能注册）。

范围外：`apps/cli`、`apps/web`、`apps/desktop` 的入口与 UI 渲染路径；真实 API 端到端评测（需 `DEEPSEEK_API_KEY`）。

规模基线（2026-11-27，`git ls-files` 实测）：564 个 `src` 文件，合计 119,440 行。

## 四条验收标准与可执行判据

| 标准 | 判据（全部可离线执行） |
|---|---|
| 代码质量高 | 每包四门禁全绿（包级测试+覆盖率、`tsc -b`、`oxlint`、`verify-export-jsdoc`/`verify-no-unknown-casts`/`verify-empty-catch`）；本批 diff 新增 `v8 ignore` 为 0；变更文件过 `jscpd` 重复率检查 |
| 无断链 | 运行时 import 必须命中 `dependencies`；每个 `provideService` 有消费者或书面 waiver；工具数三方一致（`src/index.ts` JSDoc 数字、实际注册数、`docs/tool-catalog.md`） |
| 能接线 | `packages/bundle/web-app/tests/patent-preset.spec.ts` 与新建装配探针全绿；`verify-preset-mode-baseline`、`verify-cordis-config`、`verify-agent-preset-config`、`verify-module-graph`、`verify-preset-tool-refs` 全绿 |
| 端到端跑通 | 装配探针断言 16 个插件 fiber active、6 个服务可取且 provider/consumer 同 realm 实例、工具全集一致、门禁拒绝路径生效；`pnpm run test:snapshot -t patent` 的 11 个 keyless 回放场景全绿 |

## 批次

| 批次 | 范围 | 文件数 | 状态 |
|---|---|---|---|
| B0 | 逐文件台账与门禁基线 | 564（登记） | 完成 |
| B1 | 接线、依赖方向、装配探针 | 配置面 + 4 个探针文件 | 完成 |
| B2 | patent-core 权项/检查/IPC 等纯函数层 | 59 | 完成 |
| B3 | patent-core 其余（atoms、ModelPort、evidence、workflow 等） | 114 | 完成 |
| B4 | patent-tools 检索与数据通道 | 42 | 完成 |
| B5 | patent-tools 撰写与校核 | 21 | 完成 |
| B6 | patent-tools 分析、附图、工作流与评审 | 102 | 完成 |
| B7 | 六个服务接缝包 | 109 | 待开始 |
| B8 | 法律底座与交付链八包 | 94 | 待开始 |
| B9 | 两个 UI 包与收口 | 23 | 待开始 |

## 台账规则

[00-coverage.tsv](00-coverage.tsv) 每行一个源文件，列依次为：`path`、`lines`、`blob_sha`、`package`、`batch`、`status`、`note`。

`status` 只有三态：`pending`（未审）、`signed`（已签收）、`waived`（书面豁免，`note` 必填理由）。签收前必须把文件归入三档之一：**精读**、**由测试与门禁覆盖**、**纯类型声明**，并在 `note` 写该档依据；`note` 为空时写 `-`，避免行尾制表符。

「全量」的判据是每个文件都被分诊并签收，而不是逐行重读 119k 行。任何文件不得未经判断进入 `signed`。

批次收尾时以 `blob_sha` 比对：文件内容变了就是新审阅对象，必须用 `git diff <old-sha>..HEAD -- <path>` 复读并重签，否则视为「审了旧版」。

## 汇总口径

- 已签收文件数与总行数
- 每个批次的精读、测试覆盖、纯类型三档分布
- 未决发现数（P0/P1/P2）与待决策项数
- 门禁复跑结果与命令退出码

## 当前状态

- 2026-11-27：专档建立；B0 完成，564 个文件全部有归属、无未分配项。分布：B2 59、B3 114、B4 42、B5 21、B6 102、B7 109、B8 94、B9 23。基线命令与退出码见 [02-batches/B0.md](02-batches/B0.md)。
- 基线实测：单测 430 文件 / 7525 用例通过，typecheck 与 lint 通过；`verify-export-jsdoc` 与 `verify-npm-install-layout` 为既有红。
- 已修：`patent-tools` 两处导出函数的 JSDoc 缺漏（F-PAT-061）；纯 Host 包缺少产物级依赖门禁（F-PAT-063），新增 `verify-published-imports`，实测 365 个入口 0 违规。
- 已更正：F-PAT-059、F-PAT-060 原判为依赖错置，复核为误报并已回退（提交主题 `Revert "fix(patent-data,patent-document): declare dsh-value as a runtime dependency"`）——tsdown 把未声明导入内联进产物，发布安装本可正常加载。
- 未修：`verify-npm-install-layout` 超预算（F-PAT-062，待决策）。
- B1 完成：装配探针 `patent-preset-mount.spec.ts` 真实装载 16 个插件行，六个接缝服务全部可解析、15 个代表性工具全部可见，并附一条会变红的负控制；见 [02-batches/B1.md](02-batches/B1.md)。
- B2 完成：59/59 文件签收（精读 34、关键段 10、类型与再导出 15），四条 P2 已修（F-PAT-064 规则报告拼行、F-PAT-065 节点硬上界临界失效、F-PAT-066 缺失章节被读成「无缺失」、F-PAT-067 数值节点不转发取消信号），patent-core 95 文件 / 1874 用例全绿；见 [02-batches/B2.md](02-batches/B2.md)。
- B3 完成：114/114 文件签收（本人精读 9、代理评审 105，代理结论逐条复核），四条 P2 已修（F-PAT-068 权重 NaN、F-PAT-069 8 位数字误判日期、F-PAT-070 取消后计时器未清、F-PAT-071 黑板反序列化不校验），F-PAT-072 模糊词表误伤待决策；见 [02-batches/B3.md](02-batches/B3.md)。
- B4 完成：42/42 文件签收（精读 2、关键段复核 9、代理评审 31），五条已修（F-PAT-073 缓存腿丢弃 timeout/signal、F-PAT-074 留档非原子、F-PAT-075 退避不可中止、F-PAT-076 PDF 超时文案、F-PAT-077 `[object Object]`），F-PAT-078/079 未修；见 [02-batches/B4.md](02-batches/B4.md)。
- B5 完成：21/21 文件签收（精读 4、代理评审 17），五条已修（F-PAT-080 部分附图未分析却报悬空、F-PAT-081 中文单位在数值路径完全不识别、F-PAT-082 权项特征单位写法不一致即报缺失、F-PAT-083 权利要求引用正则漏写法、F-PAT-084 模糊词子串误伤），F-PAT-085..088 未修/待决策；专利两包 223 文件 / 4,293 用例全绿，改动源文件覆盖率 100%；见 [02-batches/B5.md](02-batches/B5.md)。
- B6 完成：102/102 文件签收（关键段复核 15、代理评审 87），十二条已修（F-PAT-089..100，其中唯一 P2 为跨图一致性把后图名称记到首图号），F-PAT-101..104 未修/待决策，附图索引跨进程丢失与 B4 的 F-PAT-079 同因不重复编号；patent-tools 127 文件 / 2,424 用例全绿，改动源文件覆盖率 100%，工具目录、中英配对与 `patent-oa-response` 快照已同步；见 [02-batches/B6.md](02-batches/B6.md)。
