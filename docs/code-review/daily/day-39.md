# Day 39 — 2026-12-23

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：视频模式全域（`video-mode`、`video-bundle`、`ui-video-studio`）
- 时间盒：90 分钟
- 预期产出：E 维度视频域候选发现；daily/day-39.md

## 检查项

- [x] 检查预算账本不变量。
- [x] 检查 EDL 与项目文档一致性。
- [x] 检查 provider 结果边界。
- [x] 检查客户端状态。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-014、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。复现脚本 `d39-repro.mts` 放在仓库根（裸包名要从仓根或包内 `node_modules` 解析），未跟踪，跑完已删除；另跑了两个聚焦用例。今日只对 H04 的 Day 39 验证点补状态，其余假设不改。

**预算账本不变量（25 分钟）**：读 `store.ts`、`project.ts`、`tools/media.ts`、`tools/deliver.ts`，并对照 `tools.spec.ts` 的 durable/ledger 用例。逐项核对：账本按 `taskId` 去重、金额按分累加、预算取 `max(projectCost, ledgerCost)`、失败与取消清 journal、重复 `status` 不重复记账。这些读码与用例一致；`appendLedgerEntry` 的锁只覆盖「读—追加—写」。发现 F-VID-011：余额检查与提交不在同一临界区，并发生成会各自通过检查再分别结算；现有用例 `tools.spec.ts:840` 正把这个行为写成「两次都成功、第三次才挡住」。发现 F-VID-012：`resume` 失败后没有工具侧清理路径，journal 记录永久残留；用例 `tools.spec.ts:975` 只能手工调用 `forgetTask` 收尾。另有三项作为观察：非 CNY 结算不进账本、`cost` 缺失时仍清 journal、提交与写 journal 之间的崩溃窗口。

**EDL 与项目文档一致性（20 分钟）**：读 `edl.ts`、`tools/assemble.ts`、`tools/deliver.ts`、`tools/project.ts`。EDL 是独立、可复现的渲染契约，`video_assemble` 不读工程文档；`video_deliver` 用镜头计划核对成片时长（偏差超过 15% 只警告），并阻断缺镜头、空文件、无视频流与未声明视频的情况；无 audio 只警告。`record_render` 与交付文件都是声明式记录，两者之间没有交叉校验，这与工具说明的「declaration, not a converter」一致，记为观察。发现 F-VID-015：`validateEdl` 只校验视觉片段的区间顺序，音频片段的 `inSec > outSec` 会通过校验、晚到 ffmpeg 才失败。F-VID-004 的覆写窗口与 Day 11 的注入面结论不重测。

**provider 结果边界（20 分钟）**：读 `cloud-common.ts`、`minimax.ts`、`siliconflow.ts`、`minimax-speech.ts`、`comfyui.ts`。逐项核对：未知状态落到 failed、成功但缺 URL/文件落到 failed、下载按 `content-length` 与实测字节双重上限、超时先取消再返回 `MEDIA_TASK_TIMEOUT`、空响应与非法 JSON 的失败方向、ComfyUI 的路径段与 `..` 拒绝。没有启动网络。发现 F-VID-013：`media status` 对 `succeeded` 且 `artifacts: []` 的任务照常结算并清 journal，而 `media generate` 对同一状态明确报 `MEDIA_ARTIFACT_INVALID`。观察：SiliconFlow 的取消只停本地轮询，远端任务可能继续计费且不产生账本条目（代码注释已说明）；ComfyUI 的结算成本固定为 0 CNY。

**客户端状态（15 分钟）**：读 `ui-video-studio` 的 `project-reads.ts`、`video-projects.ts`、`StudioView.tsx`、`client/index.ts`，并对照 4 个客户端测试文件。文档严格校验、账本/日志降级、媒体 `stat` 缺失、选择保持、刷新 revision 的折叠，读码与 4 个客户端测试的断言一致。发现 F-VID-014：工程身份用工具结果里的原始路径，`init` 发布绝对路径，其余动作发布调用方路径，同一生产会出现两项；`projectPathOfResult` 的注释称其为 Host-resolved。观察：失败的 `media` 调用不会推进 revision，但被中止的 `generate` 可能已经写入 journal，界面要等手动刷新或下一次成功调用才看见这条 pending。

**命令**：`pnpm exec tsx d39-repro.mts` 退出码 0。A：同一工程的两个身份 `/work/video/ep/project.json` 与 `video/ep/project.json`；B：视觉 `inSec:3/outSec:2` 被拒，音频 `inSec:10/outSec:5` 被接受；C：带 `costCny:9` 的 render 下 `projectCost` 仍为 0。`pnpm exec vitest run packages/experimental/video-mode/tests/tools.spec.ts -t "lets two generations compare the same ledger and then blocks the next one"` 退出码 0（1 passed，33 skipped）；同一命令跑 `-t "reports a lost task when the journal has no usable record"` 退出码 0（1 passed，33 skipped）；同一命令跑 `-t "journals a pending task, recovers it after a restart, and ledgers one charge"` 退出码 0（1 passed，33 skipped）。

## 发现

F-VID-011、F-VID-012、F-VID-013、F-VID-014、F-VID-015。

下面这些不够格单列：

1. 非 CNY 的结算不进账本：`settleTask` 只在 `task.cost.currency === 'CNY'` 时追加条目；SiliconFlow 国际站配置为 USD 时，每次生成都要 `confirm_cost`，但 `budget.json` 永远为 0，`video_deliver` 也看不到这些支出。错误消息已说明「cannot be compared with the project budget」，属于已知口径，记为观察。
2. `settleTask` 在 `task.cost === undefined` 时仍清 journal：seam 允许 provider 不报价，shipped provider 都从估计值补价；自定义 provider 会留下「付费但无账」的路径。与 F-VID-013 同属终态结算条件，修复时一并收口。
3. `media.submit` 成功与 `recordTask` 之间没有「提交意图」记录：进程在这个窗口崩溃时，provider 侧已计费，journal 与账本都不知道该任务。任务 id 由 provider 返回，提交前无法预写，只能先写一条意图再对账；当前没有。
4. SiliconFlow 的 `cancel` 只删本地 pending，远端任务可能完成并计费；工具返回「was cancelled」，账本没有对应条目。代码注释承认这是 provider 能力限制，记为观察。
5. `video_project record_render` 的 `costCny` 只用于 studio 展示：`projectCost` 只累加镜头，`video_deliver` 的预算、studio 的 `spentCny` 都不读 render 成本。字段语义（镜头的总生成成本，还是另一次付费）没有所有者，留作未决问题。
6. 中止的 `media generate` 会留下 journal 记录，但工具结果是错误，`video-projects` 不推进 revision；界面要手动刷新才显示这条 pending。属客户端新鲜度，不单列。

## 假设验证/推翻

H01–H03、H05–H10 今日不改，也没有重跑覆盖率或测试套件。H05 没有新的外部输入到危险汇点证据：F-VID-015 只影响校验时机，ffmpeg 仍收 argv 数组。H10 维持原结论：视频 journal 的跨进程丢失仍是 F-VID-001；F-VID-012 是 journal 生命周期的另一面，不改变「模型可见 ⟺ logged」的判断。

H04 在 Day 39 的验证点今日完成。结论分两半：同一 `taskId` 的重复结算会被 `appendLedgerEntry` 去重，`tools.spec.ts:753` 的恢复用例与重复 `status` 断言都通过，重复计费方向不成立；账本与项目文档的一致性仍有缺口——跨进程写的丢失窗口是 F-VID-001，余额检查的并发超额是 F-VID-011，孤儿记录的永久残留是 F-VID-012。因此 H04 从 Day 11/18 的「实现正确但威胁模型不成立」调整为「重复计费不成立、预算不变量部分成立」，状态列同步更新。

## 未决问题

1. 预算应改成提交前预留（按估计额写 pending 条目，结算时替换），还是把强制点后移到 `video_deliver` 并明确声明 best-effort？预留更准，代价是失败任务要可靠清理预留条目。
2. journal 的不可恢复记录应自动标 failed 并清掉，还是保留给人工判断？自动清理会让「provider 暂时未挂载」的记录消失，保留则永远显示幽灵 pending。
3. `VideoRender.costCny` 是并入预算（可能与其镜头成本、账本双重计数），还是降级为展示字段并在 schema/JSDoc 写明？两者都能消除当前「只显示不参与判定」的歧义。

## 明日第一件事

Day 40（E 正确性与边界：跨域，错误处理、静默降级、模型可见性与会话日志一致性）第一件事：对照四域的工具错误码、空结果摘要与交付门禁，检查同一种「未核验/未命中/降级」是否在不同路径给出相反结论，并把模型可见输入与会话日志逐项对齐。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-014、F-VID-001 至 F-VID-015、F-CROSS-003 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 或 Chrome。H09 的旧数字不要改。
