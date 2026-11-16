# Day 31 — 2026-12-15

## 今日维度与范围

- 维度：D 测试缺口
- 范围：视频模式全域
- 时间盒：90 分钟
- 预期产出：D 维度视频域候选发现；daily/day-31.md

## 检查项

- [x] 检查 EDL 校验失败。
- [x] 检查 provider 失败与预算超限。
- [x] 检查项目锁并发。
- [x] 检查 ui-video-studio 渲染。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`，也没有重跑视频测试套件。`video-mode`、`video-bundle`、`ui-video-studio` 没有出现在 `vitest.config.ts:272` 起的 `exclude` 名单里。`types.ts`、`bin.ts`、`worker.ts` 仍按全仓通配排除。`video-mode` 的 `src` 22 个文件、7380 行，`tests` 16 个文件、6209 行，其中 3 个是未跑的 `*.e2e.ts`。`video-bundle` 的 `src` 1 个文件、2 行，`tests` 1 个文件、140 行。`ui-video-studio` 的 `src` 7 个文件、1417 行，`tests` 4 个文件、974 行。

**EDL（20 分钟）**：`edl.spec.ts:90` 拒绝 schema 失败，`:191` 拒绝字幕路径或字体里的控制字符，`:233` 报告缺可执行文件、非零 probe 和无法解析的 JSON，`:243` 在渲染失败时带上诊断尾部，`:257` 在退出码 0 但没有输出文件时失败。`edl.ts:333` 把 `graceMs: 5000` 传给 `ctx.subprocess.spawn`，`:334` 传入调用方 signal。`edl.spec.ts` 不读这两项，也没有中止一次组装。三个视频包的 `src` 里没有 `addEventListener` 或 `removeEventListener`。共享缝在 `packages/subprocess/subprocess-local/tests/spawn.spec.ts:258` 断言调用方 signal 触发 SIGTERM，在 `:273` 断言忽略 SIGTERM 时升级为 SIGKILL。真实 ffmpeg 那组在 `edl.spec.ts:266` 的 `describe.runIf` 里，今日没有启动 ffmpeg，也没有重跑该组。F-VID-004 不重开。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010 不重测。

**provider 与预算（25 分钟）**：ComfyUI 的工作流错误在 `comfyui.spec.ts:200`，超时码 `MEDIA_TASK_TIMEOUT` 在 `:236`，取消在 `:240`，下载的 HTTP 错误与两种体积上限在 `:525`，取消传输失败被吞掉在 `:664`。SiliconFlow 的 provider 失败在 `siliconflow.spec.ts:445`，状态与下载错误在 `:474`，超时码在 `:549`，取消在 `:558`。MiniMax 把付款失败映射为 `MEDIA_BUDGET_EXCEEDED`（`minimax.spec.ts:213`），失败消息在 `:253`，取消在 `:265`，超时码在 `:290`。`tools.spec.ts:186` 拦住非法参数，`:230` 报告失败和已取消的生成，`:810` 在账本花掉余额后拒绝下一次生成，文案含 `exceeds the 2.00 CNY remaining`，账本仍是 1 条。`:840` 让两次并发生成都成功：预算 `budget_cny` 为 3，每次估价 2 元，结束后 `ledgerCost` 为 4（`:873`），第三条被 `remaining in the project budget` 拦住（`:874`），账本仍是 2 条。该用例把两次都成功锁成当前行为，不属于未测缺口。F-VID-001、F-VID-002 与 F-VID-007 不改写。今日没有访问 MiniMax、SiliconFlow 或 ComfyUI。

**项目锁（15 分钟）**：`project.spec.ts:138` 在另一写者改过文档后重试，并断言合并后的镜头与成片。`:161` 在文档持续变化时于 3 次尝试后抛 `MEDIA_PROJECT_CONFLICT`，`:174` 断言读了 6 次。`:177` 把同一 key 的两个写者排成先开始、先结束、再第二个，并在抛错后放锁，下一次 `withProjectLock` 能完成。`lock.ts:17` 按 key 串一条 Promise。重叠断言只用了同一个 key；另一个 key 要等抛错结束才进入。改成全局一条链后，现有顺序断言仍通过，写出的文档仍然正确。这条不另开编号。F-VID-010 不重开。

**ui-video-studio（15 分钟）**：`StudioView.client.spec.tsx:88` 是空发现，`:94` 渲染完整项目，`:157` 报告缺失、畸形和不可读，`:210` 画出超预算条，`:227` 覆盖零预算和非 Error 的读取失败，`:254` 覆盖每种镜头和任务状态，`:291` 在卸载后忽略已结束的读取，`:316` 报告 Error 与非 Error 的动作失败。`project-reads.client.spec.ts:165` 保留畸形或缺失的账本和 journal，`:178` 在项目不存在时返回 undefined 并报告其他读取失败，`:197` 把非 JSON 和非 UTF-8 标为非法。`video-projects.client.spec.ts:125` 忽略失败、孤儿结果和无关工具。`client-apply.client.spec.ts:132` 在 Host 拒绝打开时带上 Host 消息。F-VID-008 不重开。今日没有开浏览器。

**完全未测模块**：三包不在豁免名单里。今日没有全仓覆盖率数字，不能把每个文件都是 100% 写成今日测量。`video-bundle` 的源文件是空导出。预设声明由 `video-preset.spec.ts:71`、`:79` 和 `:124` 钉住模式、模型与六个技能目录。抽样到的 EDL、provider、预算、项目锁和界面都有失败断言。完全未测的模块清单为空。

## 发现

无。

下面这些已有断言，不够格单列：

1. EDL 的 schema 失败、控制字符、缺可执行文件、非零 probe、无法解析的 JSON、渲染诊断尾部，以及成功退出但没有输出文件，已有直接断言。
2. 三个云 provider 的工作流或 HTTP 失败、超时、取消、下载上限和付款映射已有直接断言。账本花掉余额后的拒绝已有断言。两次并发都成功、账本到达 4 元、第三条被拒绝，也已有断言。
3. 项目文档的重试合并、三次尝试后的冲突，以及同一 key 的顺序和抛错后放锁，已有直接断言。界面的空项目、畸形项目、超预算、零预算和动作失败已有直接断言。

同构观察、不另开编号：`edl.ts:333` 的 `graceMs` 为 5000，`:334` 传入调用方 signal。`edl.spec.ts` 不读这两项。补法是包一层 spawn，让睡眠脚本在中止前不退出，断言这次调用的 `graceMs` 为 5000，且传入的 signal 就是调用方信号；中止后组装失败。共享缝已在 `spawn.spec.ts:258` 与 `:273` 锁住 SIGTERM 和 SIGKILL。视频包装没有自己的 abort 监听。F-PAT-037 的监听摘除不在本条重开。

## 假设验证/推翻

H06 仍待验证。今日视频三包的失败路径大多已有断言。没有新的 D 编号。跨域失败路径留到 Day 32。H01–H05、H07–H10 的验证点不在今日，状态不改。H03 维持 Day 23 的句子。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。三包不在豁免名单里只说明门禁会测量它们，不代替今日的逐文件数字。`types.ts` 仍按全仓通配排除。
2. 没有启动 ffmpeg，也没有访问 MiniMax、SiliconFlow 或 ComfyUI。EDL 与 provider 结论来自用例文本，来自假可执行文件和假 fetch 的写法。
3. 没有改掉 `edl.ts:333` 的 `graceMs` 或拿掉 `:334` 的 signal 再跑。结论来自 `edl.spec.ts` 不读这两项。

## 明日第一件事

Day 32（D 测试缺口：跨域失败路径，网络、权限、磁盘、部分写入）第一件事：先看网络超时与取消、权限拒绝、磁盘满与只读、部分写入与恢复的用例是否只断言成功结束。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-VID-001 至 F-VID-010、真实 ffmpeg、云 provider、LibreOffice 和 Chrome 不要重测。
