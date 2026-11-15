# Day 18 — 2026-12-02

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：视频模式全域（`video-mode`、`video-bundle`、`ui-video-studio`）
- 时间盒：90 分钟
- 预期产出：B 维度视频域候选发现；daily/day-18.md

## 检查项

- [x] 检查 provider 公共代码（cloud-common、minimax-common）的重复。
- [x] 检查项目文档、锁与存储的重复。
- [x] 检查工具动作分发的重复。
- [x] 检查 ui-video-studio 的数据流重复。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与体量（10 分钟）**：`find … -name '*.ts' -o -name '*.tsx' -exec wc -l` 得 `experimental/video-mode/src` 22 文件 7380 行、`experimental/video-bundle/src` 1 文件 2 行、`client/ui-video-studio/src` 7 文件 1417 行，合计 30 文件 8799 行（jscpd 自己的口径为 8785 行）。测试 21 个文件 7323 行，分布 video-mode 16、video-bundle 1、ui-video-studio 4。视频域有两个明显的体量热点：`video-mode/src/media.ts` 1265 行（配置半段 83–666、运行半段 667–1265，天然切分）与 `comfyui.ts` 940 行；其后为 `minimax.ts` 538、`tools/media.ts` 502、`minimax-speech.ts` 477、`edl.ts` 470、`siliconflow.ts` 463、`store.ts` 424、`ui-video-studio/src/client/project-reads.ts` 408、`locales.ts` 406、`types.ts` 376。`video-bundle` 只有 2 行入口加 cordis 补丁、locale、preset 与技能资产，没有逻辑，今日不设发现。

**克隆检测（10 分钟）**：`npx jscpd packages/experimental/*/src packages/client/ui-video-studio/src`（仓库 `.jscpd.json`，默认 60 token / 6 行）得 **0 克隆，26 文件 8785 行**；降到 40 token / 4 行后得 **12 组 104 行（1.05%）**，JSON 报告在 `/tmp/jscpd-vid18`。逐组归类：**5 组**是 minimax↔siliconflow 的 provider 骨架（`203-209`↔`188-194`、`280-285`↔`274-279`、`291-303`↔`285-297`、`487-501`↔`420-434`、`505-521`↔`441-457`），见 F-VID-009；**1 组**是 `store.ts:147-154`↔`:171-178` 的 record/forget 骨架，见 F-VID-010；**1 组**是 `project.ts:174-179`↔`store.ts:364-369` 的「读 + `FS_NOT_FOUND`」骨架，判为客户端的缺失语义不同而非重复（项目文档缺失是 `MEDIA_PROJECT_INVALID` 之外的一条显式失败，store 文档缺失是空集合）；**2 组**是 `media.ts` 自克隆（`446-450`↔`494-498` 的设置构造、`623-627`↔`645-649` 的 provider schema 块）；**1 组**是 `media.ts:923-927`↔`:940-944` 的 `refresh`/`cancel` 前导；**1 组**是 `StudioView.tsx:214-222`↔`:239-247` 的徽章行（字段集不同）；**1 组**是 `tools/deliver.ts:85-92`↔`tools/media.ts:328-335` 的结构噪音。后四类各自 5–9 行，不设发现。

**检查项 ①：provider 公共代码（25 分钟）**：`cloud-common` 与 `minimax-common` 的抽象是成功的——`KeyedCloudProvider` 统一了 `key()` 缓存、`fetchImpl`、`estimate/submit/poll/cancel` 抽象成员，`resolveCloudKey`、`cloudJsonHeaders`、`failureCodeFor`、`rejectionMessage`、`downloadVideo`、`failedTask`、`submittedVideoTask`、`untrackedTask`、`supportedImageMediaType` 全部只有一份，`minimax-common` 只在它上面固定 `MINIMAX_IDENTITY` 与再导出五个符号（84 行），`minimax-speech.ts` 复用同一基类。**未收口的是三条骨架**：① submit 的「fetch + text + `!ok` + `rejectionMessage` + `failureCodeFor`」尾；② poll 的「节流 + 超时」前导与 settle 尾；③ 参考图编码 `imageDataUri`/`imageMediaTypeOf`。三条都被 `jscpd:ignore-start -- sibling cloud providers share …` 包裹，默认阈值看不见，而 **40/4 的拷贝已经漂移**：siliconflow 对空图片文件直接 `MEDIA_REQUEST_INVALID`，minimax 没有这条检查；超时分支 minimax 先 `await this.cancel(task)`、siliconflow 只删本地 `pending`（差异可由各自 `cancel` 语义解释，但说明「复制 + ignore」不是收口）。另有两处同源重复：`messageOf` 三份逐字相同（`media.ts:1098`、`cloud-common.ts:137`、`comfyui.ts:927`，第一份只为 `tests/media-runtime.spec.ts:25` 的两条断言而导出）、失败快照助手两份体相同而参数顺序相反（`failedTask(task, message, code)` 与 `comfyui.ts:805` 的 `failed(task, code, message)`），见 F-VID-009。`estimate` 三份实现各自不同（minimax 按分辨率乘每秒单价、siliconflow 固定单价、comfyui 走运行时设置），判为 provider 差异不是重复。

**检查项 ②：项目文档、锁与存储（20 分钟）**：Host 侧文档写入已经收口——`store.ts` 的 `readDocument`/`writeStoreText`/`parseStore` 是唯一读写入口，`journalSchema`/`ledgerSchema` 各自 `safeParse` 后复检；真正的半重复在写路径骨架：`recordTask`、`forgetTask`、`appendLedgerEntry` 各写一遍「`withKeyLock` + read + 过滤/去重 + 写」，任务 journal 有 `writeTaskRecords` 而账本没有 `writeLedger`，`forgetTask` 在无变化时短路、`recordTask` 不短路，见 F-VID-010。`project.ts` 的 `readProjectText` 与 `store.ts` 的 `readStoreText` 是同形不同义（前者把 `FS_NOT_FOUND` 转成 `MediaFailure`，后者返回 `undefined`），判为保留。**真正的问题是第二份读取者**：`ui-video-studio` 的 `project-reads.ts`（408 行）自己解析同一套文档文法——文件名字面量、`SHOT_STATUSES`/`PENDING_STATUSES`、`projectSchema`/`shotSchema`/`renderSchema` 的字段表、`Math.max(projectCost, ledgerCost)` 的预算口径——而该包 `package.json` 不依赖 `@deepseek-ai/dsh-video-mode`（`video-mode` 引 `node:fs`，不能跨 plane 导入），只能靠注释「mirrors the Host's constant」维持一致；且客户端的校验严格弱于 Host（`aspect` 不查枚举、`durationSec` 无 60 上限、`targetSeconds` 无 3600 上限、`id` 无正则、无 `.strict()`），会渲染 Host 随后拒绝的文档，见 F-VID-008。

**检查项 ③：工具动作分发（15 分钟）**：**判为非重复**。`tools/` 下五个模块对应四个工具——`video_assemble`（`assemble.ts:34`）、`video_deliver`（`deliver.ts:41`）、`media`（`media.ts:222`）、`video_project`（`project.ts:114`），`shared.ts` 是公共 helper。其中两个带动作分发：`tools/media.ts` 5 个 action（`models`/`estimate`/`generate`/`status`/`cancel`）、`tools/project.ts` 5 个（`init`/`read`/`upsert_shot`/`remove_shot`/`record_render`），每个 action 的参数校验与结果形状都不同，没有可合并的分发器；公共前导已由 `tools/shared.ts` 承担（`workingDirectoryOf`、`hostPathOf`、`derivedPath`、`subtitlePathOf`、`writeArtifact`）。唯一的逐字重复是四行渲染 lambda `render: (_args, value) => [{ type: 'text', text: value.message }]`（`assemble.ts:62`、`deliver.ts:90`、`media.ts:333`、`project.ts:164`），一行体、无漂移风险，**不设发现**。另注意 `tools/media.ts` 在 370/459/495 三处重复调用 `workingDirectoryOf(ctx, exec)`，是重复调用而不是重复代码。

**检查项 ④：`ui-video-studio` 的数据流（15 分钟）**：数据流是单向的——`video-projects.ts` 从 `${VIDEO_PROJECT_TOOL}`/`${VIDEO_MEDIA_TOOL}` 的 tool-call 结果累积 turn 局部状态，`readStudioProject` 经 `remote.readBytes`/`remote.stat` 读工程、账本、journal 与媒资，`StudioView` 只消费投影后的 `StudioProject`，没有任何写回路径。与 sibling studio 的比较：`openPath`（15 行，`openWorkspacePath` + 失败即抛）与 Context imports、文件动作与字典注册骨架和 `ui-document-studio/src/client/index.ts` 逐字相同，两包都用 `jscpd:ignore-start` 标记写明「the Host file action and dictionary registration are the shared studio skeleton」；`video-projects.ts` 的 `match` 与 `ui-schedule/src/client/schedule-turn.ts` 同属「turn-local tool-call accumulators share the definition lifecycle」。客户端 plane 全仓共有约 30 处此类标记，每处都带独立理由，**两例不足以抽公共包（15 行），判为保留**，与 Day 17 对兼容层候选的处理一致。真正需要收口的是上一条的文档文法，而不是组件骨架。

**检查项 ⑤：净减少量（10 分钟）**：F-VID-008 客户端 **−60~−80 行**（另 Host 两处 `max` 合并 −1 行）；F-VID-009 **−40~−55 行**（`imageDataUri`/`imageMediaTypeOf` −30、submit/settle 尾 −15、`messageOf` −12）；F-VID-010 **−8~−12 行**。合计约 **−108~−148 行**，其中 F-VID-009 与 F-VID-010 是纯 Host 内收口、不动对外行为。

**机械复核（5 分钟）**：① `messageOf` 全仓视频域计 3 处实现（`media.ts:1098`、`cloud-common.ts:137`、`comfyui.ts:927`），消费者为 `minimax.ts`、`siliconflow.ts`（经 `minimax-common.ts:23` 再导出）、`comfyui.ts` 自身、`media.ts:798` 与一条 spec——初稿写的「两份」已修正为三份。② 预算口径 `Math.max(projectCost(…), ledgerCost(…))` 在 Host 恰 2 处（`tools/deliver.ts:107`、`tools/media.ts:385`），加上客户端 `spentCnyOf` 共 3 处；`projectCost` 只在 `project.ts:332` 定义。③ `jscpd` 40/4 的 12 组累计 104 行、1.05%（初稿口头估的 92 行来自摘要，已按报告订正）。④ 客户端校验强度逐条对照 `projectSchema`/`shotSchema`：`aspect` 枚举、`index` 正值、`durationSec ≤ 60`、`targetSeconds ≤ 3600`、`id` 正则、`.strict()` 六项在客户端都缺失，措辞已限定为「更弱」而不是「错误」。⑤ `video-bundle/src` 只有 2 行入口，今日不占篇幅。⑥ pathspec 一律从仓库根执行（Day 16 记录的陷阱）。

## 发现

新增 3 条，均含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-VID-008 | `ui-video-studio` 手写第二份项目/账本/journal 文法，预算口径出现第三份 | −60~−80 行（+Host −1 行） |
| F-VID-009 | 云 provider 的 submit/poll 与图片编码骨架各写一遍，拷贝已漂移 | −40~−55 行 |
| F-VID-010 | store 的「锁 + 读 + 改 + 写」骨架三处各写一遍 | −8~−12 行 |

今日净减少合计约 −108~−148 行。与既有发现的关系：F-VID-009 与 F-PAT-027（子进程骨架 4 份）、F-LEG-006（判定器尾部 13 份）同属「固定前导/尾部 + 逐处复制」根因，但视频域的修法是把骨架提进 `KeyedCloudProvider` 模板方法，与前两者的一次性 helper 不同，不并入；F-VID-008 是 F-VID-003（zod schema 与手写类型双份维护）的跨 plane 版本——F-VID-003 在同一包内，F-VID-008 跨 Host/Client 且无法靠类型系统约束，两条的修法可以共享同一个 schema 出口；F-VID-010 与 F-VID-001（跨进程写守卫）在同一文件，修 F-VID-001 时顺带做最省事。F-VID-005（13 个默认值双写）与 F-VID-006（`StrictRequest` 字段全同）今日复核仍生效：F-VID-006 的第三份**不存在**，客户端 `StudioTask` 只是 journal 记录的裁剪投影（5 个字段）而不是请求类型的第三份；`resolveMediaConfig` 的 `??` 与其 schema 默认值仍是两份。

## 假设验证/推翻

**H04 维持 Day 11 的判定，今日补一条实现层证据**：「provider 失败或重试造成重复计费」的威胁模型不成立——`appendLedgerEntry` 按 `taskId` 去重后整份重写、`ledgerCost` 用分累加、预算取 `max(projectCost, ledgerCost)`，重复结算会被吞掉；真正的问题仍是 F-VID-007 的账本无完整性保护。今日新增的只是实现层重复（F-VID-010 的三条写路径），不改变威胁模型结论。

**H10 维持确认，判据不变**：视频 journal 的跨进程丢失（F-VID-001）今日在代码上复核仍成立——`lock.ts` 的 `withKeyLock` 只做进程内按 key 串行（文件头注释即写明 "in-process serialization"），文件系统层没有独占创建或 CAS；今日的 F-VID-010 若不合并锁键，会让未来的第四个写者更容易绕过同一把锁。provider 原始响应是否落日志待 Day 40。

H02、H07 与视频域无交集，不更新；H06（测试缺口）在视频域已有 21 个测试文件 7323 行，分布合理，具体判定留 Day 27–33。

## 未决问题

1. F-VID-008 的落地形态要一次架构判断：新建 browser-safe 叶子包（要过 `scripts/product-package-policy.ts` 与包分类）、在 `video-mode` 内开 `format/` 子路径并登记 Host/Client 两个编译面、还是并入现有 util 包——三条都要改 `package.json`、`tsconfig` files 与模块图，不在本计划「不改业务代码」的范围内，需先定形态再决定是否值得排期。
2. F-VID-009 的模板方法要防过度抽象：`pollPreamble` 只覆盖「节流 + 超时」，settle 尾（`succeeded` 无 URL、下载失败、未知状态）三支各有 provider 特有判断，抽早了会变成钩子满天飞。建议先只合 `imageDataUri` + `messageOf`（−42 行、零架构风险），把 settle 尾留到出现第三个云 provider 时再评估。
3. F-VID-010 与 F-VID-001 的修法可能冲突：F-VID-001 要引入跨进程守卫（独占创建或 CAS），会重写 `recordTask`/`forgetTask` 的写路径；若先按 F-VID-010 抽 `mutateTasks`、再改守卫，只需改一处；反过来则要改两处。排期建议 F-VID-001 优先，F-VID-010 作为它的重构顺带项。

## 明日第一件事

Day 19（B 维度横向复核与汇总）第一件事：把 D13–D18 的 21 条新发现（PAT 13 + DOC 1 + LEG 4 + VID 3）按根因重新聚成批次，先回答三个汇总问题——① 哪些是同一个 helper/wrapper 根因（F-PAT-027、F-LEG-006、F-VID-009 的「固定前导/尾部」家族）；② 哪些是 schema 双源家族（F-PAT-024、F-DOC-004、F-DOC-006、F-VID-003、F-VID-005、F-VID-008）；③ 哪些建议并进 CI 防线（`07-ci-hardening.md`）而不是留在清单里。汇总时把每条净减少量加总，给出「若全部实施可减多少行」，并标出与本计划「不改业务代码」约束冲突的条目（F-VID-008 的形态选择即属此类）。
