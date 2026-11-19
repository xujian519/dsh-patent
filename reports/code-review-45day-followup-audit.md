# Issue「[代码审阅] 四域 45 天计划」后续工作核查报告

> 采集时间：2026-11-19（Asia/Shanghai）。分析基线：`xujian519/dsh-patent` 的 `origin/master`，即 PR #904 合入后的主干（本地 HEAD 与 `origin/master` 相同，无本地未推提交）。
> 目标 Issue：[#849 [代码审阅] 四域 45 天计划（跟踪）](https://github.com/xujian519/dsh-patent/issues/849)，状态 OPEN。
> 计划文档：`docs/code-review/`（`README.md`、`00-scope.md`–`08-retrospective.md`、`daily/day-01.md`–`day-45.md`）。
> 本报告第 1–5 节是只读分析；第 7 节记录同批次落地的四条修复。未修改 Issue、评论、标签、分支或 CI 配置。

## 1. 总体结论

**部分需要处理。** 45 天审阅周期本身已经执行完毕并留下完整证据链，但周期产出的**修复队列尚未收口**：官方登记的 42 条未修发现（其中 1 条 P0、9 条 P1）在分析时点仍全部未修，且没有后续 Issue 或 PR 认领；另有 7 条「采纳」状态的 CI 门禁加固建议同样全部未落地。

分析后的同批次已修掉 4 条（1 条 P0 与 3 条 P1，见第 7 节），未修降为 38 条。

| 判断对象 | 结论 | 依据 |
|---|---|---|
| 45 天审阅计划是否执行完 | **是**，执行完了 | 45 张日卡全部有执行记录；#842–#848 七个阶段 issue 全部 CLOSED/COMPLETED；`docs/code-review/` 10 份文档已提交入库 |
| 该 Issue 是否可以关闭 | **否**，不能关 | 计划自己的验收项已完成，但派生的修复队列仍有 38 条未处理，其中 5 条可直接分派的 P1 与 7 条 CI 门禁建议待做 |
| 是否还有后续工作需要处理 | **是** | 修后：0 条 P0、5 条可直接分派的 P1、26 条 P2、6 条 P3、7 条 CI 门禁建议 |

Issue #849 保持 OPEN 是正确的；它的正文「当前状态（2026-11-15）」一节已经过期（仍写「计划文档尚未提交或推送」），但这属于文档同步问题，不改变判定。

## 2. 依据摘要

### 2.1 审阅周期的完成证据

- 阶段 issue 全部关闭：#842（D1–D5）、#843（D6–D12）、#844（D13–D19）、#845（D20–D26）、#846（D27–D33）、#847（D34–D40）、#848（D41–D45），状态均为 `CLOSED/COMPLETED`。
- 日卡 46 个文件（`day-01`–`day-45` + 计划外 `day-05b`），全部有执行记录。
- 产出文档入库：`git log -- docs/code-review/` 显示 `docs(code-review): finalize P6 convergence (D43–D45)` 等提交，文档已进入主干（随 PR #903 合入）。
- 复盘数据自洽（`docs/code-review/08-retrospective.md`）：98 条编号发现、56 条 fixed（修复率 57%）、误报 0、根因型 19 条、假设命中 1 条 / 部分命中 5 条 / 推翻 4 条。
- Day 44 抽样复核 10 条回到源码取证：9 条仍成立、1 条维持 deferred、误报 0。

### 2.2 未收口项的官方记录

`docs/code-review/06-priority.md`「未修条目打分（Day 44，2026-11-18）」明确记录：**42 条仍为 `new` / `confirmed` / `deferred`**，分布 P0 1 / P1 9 / P2 26 / P3 6，并按改动面分成 G1–G4 四组。`docs/code-review/08-retrospective.md`「修复转化」表逐队列写明「未处理」列：P0 1 条、P1 9 条、P2 26 条、P3 6 条。

#848（P6 收敛）issue 正文的「未收口项」段落原文：

> 42 条未修发现按 G1–G4 分派；`F-PAT-045` 是唯一 P0，尚未修复。

#848 评论同样写明「未收口：42 条未修（P0 1 / P1 9 / P2 26 / P3 6），其中 `F-PAT-045` 是唯一 P0」。

### 2.3 计划定稿后没有后续认领

- 计划定稿随 PR #903 合入（2026-11-18）。此后的 PR（#902–#915）主题是文档交付、法律域接线、preset 门禁、上游同步，**没有一条指向 42 条未修发现或 7 条 CI 门禁建议**。
- 仓库 issue 列表（#906–#914，2026-11-18 晚间那批「未接线」审计）与 #849 计划无交叉引用。
- PR 列表按 `F-PAT-045`、`F-DOC-010`、`F-LEG-013`、`F-CROSS-002`、`F-PAT-024`、`G1`–`G4` 全文检索，**命中 0 条**。
- 因此这批工作既没有完成，也没有任何 Issue / PR 在跟踪——这是「后续工作」而非「已完成待补文档」。

## 3. 后续工作清单

### 3.1 必须处理

| 工作项 | 来源 Issue/评论/PR | 当前状态 | 影响与优先级 | 建议动作 | 完成判据 | 证据链接或仓库路径 |
|---|---|---|---|---|---|---|
| F-PAT-045 省略 `parallel_lower_levels` 仍判概括范围通过 | #848 正文「未收口项」；#849 追踪 | 未修（`new`）；**已运行期复现** | **P0**（Medium × 高 × 本周期 = 12 分）。专利法第 26 条第 4 款概括检查在模型没列出并列下位时仍返回通过，报告同时写「效果一致：是」。法律缺口 `claim-support-breadth` 读这个布尔值 | 字段缺失时降级报错，不收成空数组；显式 `[]` 且 `all_parallel_same_effect: true` 时不得通过 | 省略字段时期望 `_error`；显式 `[]` + `all_parallel_same_effect: true` 时期望 `claim_breadth_passed: false`；两条各有回归用例 | `packages/patent/patent-core/src/atoms/handlers/builtin/claim-breadth.ts:246`（`checkRecord` 的 `passed` 条件）；`packages/patent/patent-core/src/llm-json.ts:199-201`（`parseOptionalJsonStringArray` 把 `undefined` 收成 `[]`） |
| F-CROSS-002 `patent-tools` 导入未声明的 `dsh-value` | `06-priority.md` G4 组；`07-ci-hardening.md` 落地顺序第 1 条 | 未修（`new`）；**已核验仍成立** | **P1**（Low × 高 × 本周期 = 6 分）。反向依赖声明未校验，`verify-package-dependencies` 只查「声明→使用」方向，运行产物靠打包内联掩盖 | 按 `07-ci-hardening.md` 落地顺序第 1 条：扩展 `verify-package-dependencies`，对每个包 `src` 收集 `@deepseek-ai/dsh-*` 值导入并要求同名声明；修掉这一处真实反例 | 门禁脚本能拒绝该反例（退出码非 0）；`patent-tools/package.json` 补上声明 | `packages/patent/patent-tools/src/tool/law-search.ts:16` 导入 `@deepseek-ai/dsh-value`，`packages/patent/patent-tools/package.json` 三节均无该条目 |
| F-DOC-010 占位符判定不识别 HTML 代码块、注释与属性 | `06-priority.md` G1 组 | 未修（`new`）；**已核验仍成立** | **P1**（Medium × 中 × 本周期 = 8 分）。合法 HTML 交付件只要展示代码示例、引用占位符写法或留一条编辑注释，就被 P0 门禁拒绝登记；同一内容换成 Markdown 就能过，门禁结论取决于导出格式而非文档内容 | `format: 'html'` 时先投影可见正文（复用已实现的 `htmlBodyText`），再从 `<pre>`/`<code>` 元素推导引用范围；保留行号映射或在结果里注明行号对应投影文本 | 五个输入补成用例（`<pre><code>`、`<code>`、`<!-- -->`、`<img alt>`、Markdown 对照）；同内容 Markdown/HTML 给出同结论 | `packages/document/document-deliver/src/checks.ts:485-499`（`placeholderDrafts` 只用 Markdown 围栏与行内代码的 `quotedRanges`）；对照 `checks.ts:319`（`htmlBodyText` 已实现正文投影，但只用于字数预算与空节） |
| F-LEG-013 法规检索先取 2 倍上限再按时间效力过滤 | `06-priority.md` G2 组 | 未修（`new`）；**已核验仍成立** | **P1**（Medium × 中 × 本周期 = 8 分）。请求 N 条可见结果时，前 2N 条原始命中被效力过滤掉就少返回甚至返回空；法规有多个失效版本时现行版本可能落在窗口之外；SQLite 与内存后端对 `findByName` 给出不同集合。模型会把召回窗口造成的空结果读成「本部署未收录」 | 效力过滤前置到截断之前：按页/按批读取直到凑满 `limit` 或行耗尽，或在 SQL 里直接带效力条件；内存路径统一为「先过滤、后截断」 | 一条超过窗口的 SQLite/内存 parity 用例（3 条失效 + 1 条可见，`limit: 1`）两后端结果相同 | `packages/legal/legal-knowledge/src/legal/search.ts:76` 与 `packages/legal/legal-knowledge/src/judicial-interpretation/search.ts:120` 仍为 `fetchFactor: 2`；`packages/legal/legal-knowledge/src/shared/sqlite-search.ts:261,301` 按 `limit * fetchFactor` 截断 |

### 3.2 建议处理

| 工作项 | 来源 Issue/评论/PR | 当前状态 | 影响与优先级 | 建议动作 | 完成判据 | 证据链接或仓库路径 |
|---|---|---|---|---|---|---|
| R-D1 测试缺口 8 条（F-PAT-033/034/035/036/037/038、F-DOC-007、F-LEG-010） | `06-priority.md`「测试缺口」 | 未修（`new`）；本轮未重测 | P2。**只加测试，不改行为**——审查清单指出失败路径缺断言，覆盖率门禁量不到断言强度 | 按 R-D1 建 8 条用例（监听摘除、清单 sha1、依赖终态、abort 监听、未核验引用处置） | 8 条用例落地并随 `pnpm run test` 通过 | `packages/patent/patent-core/tests/`、`packages/document/office-kit/tests/`、`packages/legal/legal-knowledge/tests/` |
| 正确性遗留 6 条（F-PAT-050、F-PAT-055、F-VID-015、F-LEG-013 之外的部分） | `06-priority.md`「维持原处置」 | 未修（`new`） | P2/P3。F-PAT-050 重规划把重复步骤全部判为已完成；F-PAT-055 上游 JSON 含 null 元素时 `mapPatentData` 抛 TypeError；F-VID-015 EDL 音频区间反向顺序晚到 ffmpeg 才失败 | 排在 R-D1 之后，单独一批处理 | 每条有对应修复 + 用例 | F-PAT-050 `packages/patent/patent-workflow/src/plantask.ts:202-209`（`prevByHash` 按哈希保留）；F-PAT-055 `packages/patent/patent-data/src/mapper.ts:16-24`（`parseJsonArray` 返回 `parsed as T[]`，不校验元素，`extractNames` 对 null 元素取 `item[key]` 抛错）；F-VID-015 `packages/experimental/video-mode/` |
| F-PAT-024 插件默认值双源（7 个专利包 42 对 `??`） | `06-priority.md` G3 组 | 未修（`new`）；**已核验仍成立** | P1（Medium × 高 × 可延后 = 6 分）。配置看起来生效但实际不生效的一类根因（R3）；且是「默认值双源检测」门禁的前置条件——门禁第一次跑就会红 | 先逐包把 schema `.default` 与消费侧 `??` 收敛到单一来源，再加门禁 | 七个包不再有同值双写；随后 `verify-plugin-defaults` 可运行 | `packages/patent/patent-teams/src/index.ts:116-122`（10 对 `??`，如 `stateDir: config.stateDir ?? '.patent-teams'`）；`packages/patent/patent-data/src/index.ts`、`patent-rule/src/index.ts`、`patent-filing/src/index.ts`、`writing-patterns/src/index.ts`、`patent-knowledge/src/index.ts`、`patent-document/src/index.ts` |
| F-PAT-027 / F-PAT-028 / F-VID-008 结构复用 | `06-priority.md` G3 组 | 未修（`new`） | P1/P2。F-PAT-027 子进程骨架重复；F-PAT-028 输出目录与安全文件名判定 4 种编码、两工具接受集相反；F-VID-008 `ui-video-studio` 手写第二份项目/账本/journal 文法，预算口径出现第三份 | 与 F-PAT-024 同批做结构类改动 | 各包收敛到单一实现 | `packages/patent/patent-*`、`packages/client/ui-video-studio/src/client/video-projects.ts` |
| F-VID-014 项目身份取原始路径，同一工程出现两次 | `05-findings.md` | 未修（`new`）；**已核验仍成立** | P1（Low × 高 × 本周期 = 6 分）。`projectPathOfResult` 的 JSDoc 写「Host-resolved」，但只有 `init` 解析；studio 按路径去重，同一文件因绝对/相对写法出现两个同名选项 | 每个动作都返回 `ctx.fs.processPath(target)`；`presentationMeta` 只发布解析后的路径 | Host 侧断言 `read`/`upsert_shot` 的 meta 为绝对路径；客户端加一条「同一文件的相对与绝对路径只产生一项」 | `packages/experimental/video-mode/src/tools/project.ts:186`（`init` 走 `processPath`）对 `:193`、`:200`、`:207`、`:220`（其余四个动作返回调用方原始路径） |
| CI 门禁加固：密钥扫描、SAST、依赖漏洞审计 | `07-ci-hardening.md`（定稿「采纳」3 条） | 未落地；**已核验 `.github/workflows/` 无相关配置** | P1。OBS-004 记录当前无密钥扫描、无 SAST；OBS-002 记录 `pnpm audit` 在当前 registry 不可用 | 按 `07-ci-hardening.md` 落地顺序第 3 条：先记录基线，再设为阻塞 | CI 中出现对应 lane，且有基线值记录 | `.github/workflows/ci-fork.yml` 的 `node-checks`（`gitleaks`/`secretlint`/`semgrep`/`trivy`/`audit` 均检索 0 命中） |
| CI 门禁加固：同形本地助手检测（oxlint 规则） | `07-ci-hardening.md`（采纳） | 未落地 | P2。先删 F-CROSS-001 的 4 份实现再加规则，否则门禁立即红 | 顺序：先删 `messageOf`/`errorText` 四份实现，再加 oxlint `no-restricted-syntax` | 规则落地且全仓通过 | `packages/` 四域 4 份 `messageOf`/`errorText` 与 1 份 `asRecord`（`dsh-value` 已有唯一实现） |
| CI 门禁加固：外部 provider 契约测试 | `07-ci-hardening.md`（采纳） | 未落地 | P2。H04/H06 记录 provider 失败路径测试不足 | 用本地 mock server 固定超时、重试、取消、预算超限 | 各包 `tests/` 有契约用例 | 各包 `tests/` |
| F-PAT-047 审批门中断后续跑从第一阶段重跑 | `05-findings.md`；`06-priority.md`「维持原处置」 | `deferred`（旧登记 R-77） | P1 队列位，但**本轮不可派发**——按复盘口径 deferred 不计入可派发项 | 需要仓库负责人决定：维持 deferred 还是另立项。真实续接语义另立项 | 负责人给出书面决定 | `packages/patent/patent-core/src/workflow/types.ts:190`；`packages/patent/patent-workflow/src/workflow.ts:481` |
| 其余 26 条 P2 / 6 条 P3 重复实现与过宽导出 | `06-priority.md`「未修条目打分（Day 44）」 | `new` / `confirmed` | P2 26 条、P3 6 条。多为重复实现与过宽导出，需与结构类改动一起做 | 与 F-PAT-024/027/028 同批；P3 记录并观察，重复出现时升级 | 各条关闭或升级 | `docs/code-review/05-findings.md` 总表与 `06-priority.md` 打分表 |

### 3.3 无需继续处理

| 事项 | 判定理由 | 证据 |
|---|---|---|
| 45 天审阅周期本身（Day 1–45 的审阅执行） | 45 张日卡全部有执行记录；7 个阶段 issue 全部 CLOSED/COMPLETED；10 份产出文档已入库；Day 44 抽样 10 条误报 0 | `docs/code-review/daily/` 46 个文件；#842–#848；`git log -- docs/code-review/` |
| 已被后续提交解决的 56 条 fixed 发现 | 56 条经 #852、#873–#877、#881、#884、#887、#888、#890、#895、#900–#915 等合入；逐条有修复记录与状态列 | `docs/code-review/05-findings.md` 总表状态列与「修复记录」段 |
| R-E1 至 R-E5 五组修复 | 批次执行状态表逐组标注「已实施（2026-11-18）」，并注明对应条目 | `docs/code-review/06-priority.md`「批次执行状态」 |
| 被拒绝或降级的门禁建议 | 覆盖率豁免审计（H08 已推翻，豁免清单不含四域文件）、组合预设漂移（H09 已推翻，已有六道门禁）、文档交付断言（H03 已推翻且本机无 LibreOffice）——这三项是**审阅已作出的裁定**，不需要再实现 | `docs/code-review/07-ci-hardening.md`「缺口与建议（定稿）」裁定列 |
| 假设 H01–H10 的重新验证 | H01/H03/H08/H09 已被推翻并给出证据；H02/H04/H05/H06/H07/H10 的结论已定稿，复盘明确「部分命中的五条仍各自产出了编号发现」 | `docs/code-review/08-retrospective.md`「假设命中率」表 |
| 重复导入与合并 | Day 41 去重已完成：10 条 `new`→`confirmed`、3 条 `new`→`fixed`，无一条因不成立而撤销（误报 0） | `docs/code-review/08-retrospective.md`「发现质量」 |

### 3.4 信息不足、无法判断

| 事项 | 缺口 | 建议 |
|---|---|---|
| 下一周期是否开工、开工范围与天数 | `08-retrospective.md`「需要仓库负责人确认的事项」列出 4 个待决问题：① F-PAT-045 是否在下一周期开工前单独修；② F-PAT-047 维持 deferred 还是立项；③ 密钥扫描与依赖审计的基线值由谁采集；④ 下一周期是只做专利域 30 天版，还是四域各做一次定向 10 天版。这 4 项属仓库负责人决策，分析侧不可代判 | 请负责人书面确认这 4 项；确认前按 §3.1 的 P0/P1 队列推进，两者不冲突 |
| R-D1 八条测试缺口的当前真实状态 | `06-priority.md` 明写「本轮未重测」；基线口径为「对照 #886，在 #890 合入后复核，状态未变」，此后主干已有 #895–#915 的改动，其中 #904 改动了 document 交付、#903/#915 改了 preset 与法律域接线。是否仍缺这 8 条断言，需逐条回到当前源码确认后才能断言 | 派 R-D1 时先做一次「是否仍缺」的复核，而不是直接按 Day 44 的旧清单补用例 |
| 26 条 P2 / 6 条 P3 的具体处置顺序 | `06-priority.md` 写明「多为重复实现与过宽导出，需与结构类改动一起做」，未给出逐条排期；`08-retrospective.md` 建议下一周期先做 E 后做 B，但未覆盖这些 B 维度条目 | 下一周期排期时与 G3 组一起排；本轮不单独判「必须」或「无需」 |

## 4. 验证记录

### 4.1 实际执行的命令

| 命令 | 退出状态 | 关键结果 |
|---|---|---|
| `git remote -v` / `git status --short` / `git log --oneline -5` | 0 | `origin` = `git@github.com:xujian519/dsh-patent.git`；工作树无业务代码改动（仅 `reports/` 下未跟踪产物） |
| `gh issue view 849 --repo xujian519/dsh-patent --json ...` | 0 | 状态 OPEN，无里程碑、无 assignee，5 个标签（`area/patent`、`area/docs`、`kind/cleanup`、`area/document`、`area/legal`），正文 7 个阶段全部 `[x]`，仅 2 条评论（#844、#845 的关闭说明） |
| `gh issue view 842..848 --json ...`（7 次） | 0 | 全部 `CLOSED/COMPLETED`；关闭时间 2026-11-15 至 2026-11-19 |
| `gh issue list --repo xujian519/dsh-patent --state all --limit 100` | 0 | 仓库 issue 总览；#849 是唯一 OPEN 的审阅类 issue |
| `gh pr list --repo xujian519/dsh-patent --state all --limit 50` | 0 | 最近 PR 为 #915（2026-11-18 合入）；按 `F-PAT-045`/`F-DOC-010`/`F-LEG-013`/`F-CROSS-002`/`F-PAT-024`/`G1`–`G4` 检索命中 0 条 |
| `gh issue view 848 --json body,comments` | 0 | 「未收口项：42 条未修发现按 G1–G4 分派；`F-PAT-045` 是唯一 P0，尚未修复。」 |
| `ls docs/code-review/` / `ls docs/code-review/daily/` | 0 | 10 份主文档 + 46 个日卡（day-01–day-45 + day-05b） |
| `git log --oneline -- docs/code-review/` | 0 | 定稿提交随 PR #903 合入（2026-11-18） |
| `git log -1 --format=... -L 308,345:packages/document/document-deliver/src/checks.ts` | 0 | `htmlBodyText` 来自 2026-10-19 的提交（`feat(document): close the delivery loop across tools, presets, and studio`），早于本轮审阅——据此排除「F-DOC-010 已被 htmlBodyText 修掉」的误判 |
| `git fetch origin master` | 0 | `origin/master` 与本地 HEAD 相同（PR #904 合入后的主干） |

### 4.2 代码核验（逐条回到源码）

| 核验对象 | 方法 | 结果 |
|---|---|---|
| F-PAT-045（P0） | 读 `claim-breadth.ts:246-250` 与 `llm-json.ts:199-201`；再写临时用例调用 `ClaimBreadthHandler.execute` 运行期复现 | **仍成立**。`checkRecord` 的 `passed = defect === 'none' && all_parallel_same_effect && anchor.matched`，不看 `parallel_lower_levels` 是否为空；`parseOptionalJsonStringArray` 把 `undefined` 收成 `[]`。复现输出：`_error = undefined`、`claim_breadth_passed = true`、`parallel_lower_levels = []`、报告写「效果一致：是」 |
| F-CROSS-002 | `grep -rn 'dsh-value' packages/patent/patent-tools/src/ packages/patent/patent-tools/package.json` | **仍成立**。`src/tool/law-search.ts:16` 导入 `@deepseek-ai/dsh-value`；`package.json` 三节（dependencies / peerDependencies / devDependencies）均无该条目 |
| F-DOC-010 | 读 `checks.ts:485-499` `placeholderDrafts` 与 `checks.ts:308-345` `htmlBodyText` | **仍成立**。`placeholderDrafts` 仍只用 Markdown 围栏与行内代码推导的 `quoted` 范围；`htmlBodyText` 已存在但只用于字数预算与空节，未接入占位符判定 |
| F-LEG-013 | 读 `legal/search.ts:76`、`judicial-interpretation/search.ts:120`、`shared/sqlite-search.ts:261,301`、`shared/validity.ts:69-89` | **仍成立**。两处仍为 `fetchFactor: 2`；SQLite 按 `limit * fetchFactor` 截断后才做效力过滤；内存路径 `filterByValidity` 已是「先过滤后截断」，两后端口径仍不一致 |
| F-PAT-024 | `grep -n '??' packages/patent/patent-teams/src/index.ts` | **仍成立**。`:116`–`:122` 仍是一组 schema `.default` 与消费侧 `??` 同值双写（如 `stateDir: config.stateDir ?? '.patent-teams'`） |
| F-VID-014 | 读 `packages/experimental/video-mode/src/tools/project.ts:186,193,200,207,220` | **仍成立**。`init` 返回 `ctx.fs.processPath(target)`；`read` / `upsert_shot` / `remove_shot` / `record_render` 均返回调用方原始 `path` |
| F-PAT-055 | 读 `packages/patent/patent-data/src/mapper.ts:16-24,43-54` | **仍成立**。`parseJsonArray` 返回 `parsed as T[]` 不校验元素；`extractNames` 对数组元素取 `item[key]`，null 元素触发 TypeError |
| F-PAT-050 | 读 `packages/patent/patent-workflow/src/plantask.ts:164-210` | **仍成立**。`hashStep` + `prevByHash` 按步骤文本哈希保留已完成项，重复步骤归入同一 hash |
| CI 门禁建议 | `grep -rniE 'gitleaks\|secretlint\|semgrep\|trivy\|npm audit\|pnpm audit' .github/workflows/`；`ls scripts/ | grep -iE 'plugin-default\|patent-core-export'` | **未落地**。workflows 检索 0 命中；仅有 `verify-patent-core-exports.ts`（部分落地项），无 `verify-plugin-defaults`，无反向依赖声明校验 |

### 4.3 仓库既有门禁（本轮实跑）

| 命令 | 退出状态 | 关键结果 |
|---|---|---|
| `vitest run packages/patent/patent-core/tests/` | 0 | 88 个测试文件、1755 个用例全部通过 → 确认 F-PAT-045 **不被任何现有用例覆盖** |
| `pnpm run typecheck` | 0 | 5 个门禁全部 PASS（Host Typert、host compiler、client compiler、host aggregate check、client aggregate check），16.78s |
| `pnpm run lint` | 0 | oxlint：8577 个文件、90 条规则，0 warnings、0 errors，53.0s |
| `pnpm run test:docs` | 0 | 30 个文档门禁全部 PASS（含 translation pairing、markdown links、markdown wrap、doc budgets、repository references），12.51s |

F-PAT-045 的运行期复现使用了一个临时用例文件，跑完后已删除；`git status --short` 复核确认工作树无业务代码改动。

### 4.4 未验证项

- **覆盖率门禁（`pnpm run test:coverage`）未跑**：该命令需先 `build:native-system` 并跑全量覆盖率，属仓库级门禁；本轮核验聚焦四域改动面，按「按受影响模块选择最小必要测试集」的口径未纳入。`docs/code-review/02-baseline.md` 记录 Day 1 时覆盖率运行曾因 13 个环境相关测试失败退出码 1，属环境依赖，非本轮引入。
- **F-PAT-047（deferred）未做代码级复核**：按 `05-findings.md` 与 `06-priority.md` 维持 `deferred`，不在本轮可派发范围。
- **R-D1 八条测试缺口未逐条复核**：见 §3.4。
- **`docs/code-review/` 文档内容本身未做措辞校对**：本轮只核验它们记录的结论与仓库当前状态是否一致，不评价文档表述质量。

## 5. 风险与未决问题

### 5.1 风险

| 风险 | 说明 | 依据 |
|---|---|---|
| R-1 唯一 P0 仍可被触发 | F-PAT-045 是全轮 98 条里唯一的 P0，运行期复现确认 `claim_breadth_passed: true` 且报告写「效果一致：是」。它不是理论缺口，而是一条已经能量化、能量复现的法律判断失效路径。`claim-support-breadth` 法律缺口读这个布尔值，因此缺口判定会跟着一起放过。**2026-11-19 批次 R-F1 已修复**（见第 7 节），此风险在修复前成立 | `packages/patent/patent-core/src/atoms/handlers/builtin/claim-breadth.ts:246` |
| R-2 修复队列无跟踪载体 | 余下 38 条未修发现曾只分散在 `05-findings.md` 与 `06-priority.md` 两份文档里，没有对应的 Issue 承接。#849 是**计划追踪** issue，不是**修复追踪** issue；7 个阶段 issue 已全部关闭，不会再有人从它们身上读出「还有 38 条要修」。**2026-11-19 已建 #916 承接**，此风险已消解 | [#916](https://github.com/xujian519/dsh-patent/issues/916) |
| R-3 门禁建议存在「先加规则会立刻红」的顺序依赖 | `07-ci-hardening.md` 落地顺序第 2 条（同形本地助手检测）要求先删 F-CROSS-001 的 4 份实现、第 4 条（默认值双源检测）要求排在 F-PAT-024 修完之后。若跳过前置修复直接加规则，CI 会立刻红并被误当成误报 | `docs/code-review/07-ci-hardening.md`「落地顺序」与「落地原则」 |
| R-4 Issue #849 正文状态过期 | 正文「当前状态（2026-11-15）」仍写「计划文档仍在工作树中，尚未提交或推送」「覆盖率运行因 13 个环境相关测试失败退出码 1」，与现状（文档已入库、覆盖率基线口径已在 Day 33 更新）不符。读到这份 Issue 的人会低估已完成度 | `gh issue view 849` 正文 |
| R-5 审查结论的时效性 | 本报告所有「仍成立」判定基于 `origin/master`（PR #904 合入后的主干，2026-11-19）。主干一旦推进（例如为 F-PAT-045 开 PR），结论会失效；报告中每条结论都附了可回溯路径与命令，可按同一口径重跑 | 本报告 §4.1、§4.2 |

### 5.2 未决问题

1. **F-PAT-045 是否在下一周期开工前单独修**（`08-retrospective.md` 待确认事项 ①）。本报告的证据支持「应当单独修」：它是唯一 P0，且已复现。
2. **F-PAT-047 维持 deferred 还是另立项**（待确认事项 ②）。
3. **密钥扫描与依赖漏洞审计的基线值由谁采集**（待确认事项 ③）。这两条门禁按定稿是「先记录基线，再设为阻塞」，没有基线就无法落地。
4. **下一周期是只做专利域 30 天版，还是四域各做一次定向 10 天版**（待确认事项 ④）。
5. **~~余下 38 条未修发现该由谁跟踪、用什么载体跟踪~~（2026-11-19 已建立）**。计划侧已收口而修复侧无载体，是本报告认为最需要补的一项。已新建 [#916 [代码审阅] 修复队列（跟踪）：四域 45 天计划余下 38 条](https://github.com/xujian519/dsh-patent/issues/916) 承接，按 P1 / P2 / P3 与 7 条 CI 门禁建议分组列出。
6. **#849 是否随修复队列落地而关闭**。建议 #849 保持 OPEN 直到可派发的 5 条 P1 关闭；不要在 38 条全清之前关闭，也不要因为「审阅周期已完成」就关闭。

## 6. 附录：分析口径与幂等性

- **分析时间点**：2026-11-19（Asia/Shanghai），基线 `origin/master`（PR #904 合入后的主干）。
- **幂等性**：重复运行本报告所用命令应得到一致结论；结论只依赖三类事实——Issue/PR 状态、`docs/code-review/` 文档内容、当前源码。仓库状态变化后需重跑，差异集中在「§4.2 代码核验」与「§3 后续工作清单」。
- **兼容性**：本轮未改变 Issue 状态、评论、标签、分支或工作区业务代码。未运行任何会写 Issue/PR 的命令；临时复现用例已删除并复核工作树。
- **未引入新工具**：仅使用仓库既有工具（`vitest`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run test:docs`）、`gh` CLI 与 `git`，未升级任何依赖，未新增运行时或语言。

## 7. 本批次落地的修复（2026-11-19，批次 R-F1）

分析后落地 4 条：唯一 P0 与 G1–G4 中 3 条可派发 P1。四条都属「缺输入或缺声明被读成通过」，改动只影响这四条路径。

| 发现 | 原队列 | 处理 | 回归用例 |
|---|---|---|---|
| F-PAT-045 | P0 | `parallel_lower_levels` 改用严格的 `parseJsonStringArray`，字段缺失按结构错误降级；`checkRecord` 的通过条件增加「并列下位非空」，显式空数组时按未通过处理，报告写「无可比对下位」 | `packages/patent/patent-core/tests/claim-breadth-atom.spec.ts`（新增 2 条） |
| F-DOC-010 | P1 | `format: 'html'` 时占位符判定改用 HTML 引用范围（`<pre>`/`<code>`/`<kbd>`/`<samp>` 内容）与不可见文本范围（注释、标签、属性值、`<script>`/`<style>` 内容），两者都只报 `warn`；标签扫描不因属性值里的 `>` 提前结束，闭合标签不当作开标签 | `packages/document/document-deliver/tests/checks.spec.ts`（新增 6 条） |
| F-LEG-013 | P1 | 效力过滤前置到截断之前：SQLite 侧按页取行（`LIMIT ? OFFSET ?`，FTS 加 `bm25` 同分时的 `id` 次序键，LIKE 与 `findRowsLikePage` 加 `id` 次序键以保证翻页稳定），内存侧取满命中再过滤，`fetchFactor` 删除 | `packages/legal/legal-knowledge/tests/validity-window-parity.spec.ts`（新增 5 条）、`sqlite-engines-branches.spec.ts`（新增 2 条、改写 1 条） |
| F-CROSS-002 | P1 | `patent-tools` 的 `dependencies` 补 `@deepseek-ai/dsh-value`，`pnpm-lock.yaml` 同步 | `pnpm run verify-package-dependencies` 104 包匹配策略 |

### 修复前后的行为对照

| 输入 | 修复前 | 修复后 |
|---|---|---|
| 模型漏给 `parallel_lower_levels`，其余字段合法 | `claim_breadth_passed: true`，报告写「效果一致：是」 | 降级：`[claim-breadth] records 第 1 项的 parallel_lower_levels 不是数组`，不写判定键 |
| 显式 `parallel_lower_levels: []` 且 `all_parallel_same_effect: true` | `claim_breadth_passed: true` | `claim_breadth_passed: false`，报告写「无可比对下位」 |
| HTML `<pre><code>{{case_id}}</code></pre>` | `placeholder` 判 `block`，拒绝登记 | 判 `warn`，登记继续；同一内容的 Markdown 交付件判定一致 |
| HTML `<!-- {{case_id}} -->` 与 `<img alt="[TBD]">` | 判 `block` | 判 `warn` |
| HTML 正文里的 `<p>客户名称：{{client_name}}</p>` | 判 `block` | 仍判 `block`（正文残余占位符不豁免） |
| 3 条失效版本在前、1 条现行版本在后，`findByName('民法典', 1)` | SQLite 返回 `[]`，内存返回 `[]` | 两者都返回现行版本，集合相同 |
| 同一条查询分页取与一次取全 | 可能重行或漏行（FTS 同分无次序键、LIKE 无 `ORDER BY`） | 结果集合相同，无重复无遗漏 |

### 本批次的验证

| 命令 | 退出状态 | 关键结果 |
|---|---|---|
| `vitest run packages/patent/ packages/document/ packages/legal/ packages/law/` | 0 | 485 个测试文件、8412 个用例全部通过（4 skipped） |
| `pnpm run typecheck` | 0 | 5 个门禁全部 PASS |
| `pnpm run lint` | 0 | oxlint：8578 个文件、90 条规则，0 warnings、0 errors |
| `pnpm run test:docs` | 0 | 30 个文档门禁全部 PASS |
| `pnpm run verify-package-dependencies` | 0 | 104 package(s) match the published dependency policy |
| `pnpm install --frozen-lockfile --lockfile-only` | 0 | 锁文件与清单一致（1806 条供应链策略校验通过） |

### 仍未解决

- **反向依赖声明校验未实现**：`07-ci-hardening.md` 落地顺序第 1 条要求扩展 `verify-package-dependencies`，让源码里每个 workspace specifier 必须出现在本包清单的某一节。本次只修掉了 F-CROSS-002 这条真实反例，同类问题仍无门禁拦截。
- **38 条未修发现与 7 条 CI 门禁建议仍在**：见 §3.2 与 §5.2。
- **`#849` 的正文状态未同步**：「当前状态（2026-11-15）」一节仍写「计划文档仍在工作树中，尚未提交或推送」，与现状不符。
- **修复队列的跟踪载体已建立**（2026-11-19）：#916 承接余下 38 条与 7 条 CI 门禁建议，#849 的过期状态段落已同步更新。本批次的代码改动在 #917（分支 `fix/code-review-rf1-findings`）。

## 8. 复审轮次（2026-11-19，批次 R-F1 复审）

批次 R-F1 落地后对同一批改动做了一轮代码审阅，发现并修掉 6 项问题：1 项阻断（修复本身不彻底）、2 项与模块自身口径矛盾、1 项门禁会红、2 项次要问题。

| 编号 | 位置 | 问题 | 处理 |
|---|---|---|---|
| B1（阻断） | `document-deliver/src/checks.ts` 的 `HTML_TAG` | 正则的 `[^>]*` 会在**引号内的 `>`** 处截断标签，于是该属性之后的属性落在所有范围之外，其中的占位符被当成正文可见文本而阻断。`<img src="x.png" alt="a>b" title="{{title}}">` 判 `block`，而 `<img src="x.png" title="{{title}}">` 判 `warn` —— 门禁结论取决于属性书写顺序 | 标签表达式改为整体消费引号值，引号内的 `>` 不再结束标签 |
| B2 | 同上 | `<script>`/`<style>` 的内容不在 `QUOTED_ELEMENTS` 里，而本模块的 `htmlBodyText` 早已按 `NON_TEXT_ELEMENTS` 把它们当非正文；两处口径矛盾，读者看不到的内容被阻断 | 元素清单改用 `NON_TEXT_ELEMENTS`，其内容并入不可见文本范围 |
| B3 | 同上 | 两处兜底分支不可达（标签表达式已要求元素名以字母开头；属性值表达式只匹配带引号的值），使该文件覆盖率低于仓库要求的每文件 100% | 删除不可达兜底；提取 `openedElementName` 去掉重复 |
| B4 | `legal-knowledge/src/legal/search.ts` | `pageSize = Math.max(limit, 1)` 使 `limit=1` 时每行一次查询；旧实现一次查询取 `limit * 2` 行。库里同名法规多时一次查找要发上百次 SQL | 页大小与结果上限解耦，取 `Math.max(limit, 50)` |
| B5 | `legal-knowledge/src/shared/sqlite-search.ts` | `findRowsLike` 改后无任何生产调用方，只剩测试引用 | 删除该方法，测试改用 `findRowsLikePage` |
| B6 | 同上 | `findRowsLikePage` 用 `LIMIT ? OFFSET ?` 但无 `ORDER BY`，行序未定义，翻页可能漏行或重行 | 补 `ORDER BY id`，与 FTS/LIKE 两条检索路径一致 |

复审还发现一个同源缺陷并一并修掉：**闭合标签被当成开标签**。`TAG_PREFIX` 在剥掉前缀时连闭合斜杠一起剥掉，`</pre>` 因而看起来像 `<pre>`，其「内容」一路延伸到文末，文档后半段的正文占位符被误判为引用文本而放行。修法是从标签原文读闭合斜杠，并补一条回归用例。

### 复审轮的验证

| 命令 | 退出状态 | 关键结果 |
|---|---|---|
| `vitest run packages/patent/ packages/document/ packages/legal/ packages/law/` | 0 | 485 个测试文件、8412 个用例全部通过（4 skipped） |
| `vitest run --coverage` （聚焦五个改动源码文件） | 0 | 语句、分支、函数、行**均为 100%** |
| `pnpm run typecheck` | 0 | 5 个门禁全部 PASS |
| `pnpm run lint` | 0 | oxlint：8578 个文件、90 条规则，0 warnings、0 errors |
| `pnpm run test:docs` | 0 | 30 个文档门禁全部 PASS |
| `pnpm run verify-package-dependencies` | 0 | 104 package(s) match the published dependency policy |

复审轮新增回归用例 8 条（document-deliver 6 条、legal-knowledge 2 条）。负向对照：逐个回退三处源码修复后，对应新用例全部失败；只有「正文占位符仍阻断」这一条护栏用例在两种情况下都通过，符合预期。
