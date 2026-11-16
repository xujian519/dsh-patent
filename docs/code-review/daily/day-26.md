# Day 26 — 2026-12-10

## 今日维度与范围

- 维度：C 优化
- 范围：C 维度横向：子进程、临时文件、监听器、取消与并发
- 时间盒：90 分钟
- 预期产出：C 维度汇总与去重结果；daily/day-26.md

## 检查项

- [x] 汇总四域的子进程与临时文件生命周期。
- [x] 检查取消与中止传播。
- [x] 检查并发上限。
- [x] 汇总 C 维度发现。
- [x] 更新假设状态。

## 实际执行

**基线（10 分钟）**：测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。不打模型，不打网络，不启动 ffmpeg、Chrome、Python、Inkscape 或 LibreOffice。法律域 LIKE、判例零命中和 Office 转换都不重测。命令是 `node --import tsx/esm` 导入 `subprocess-local` 的 `src`，退出码 0。脚本是一次性的，跑完即删。夹具在临时目录，进程结束时删掉。在专利、文档、法律、`law`、`video-mode` 与 `ui-video-studio` 的 `src` 检索 `setInterval(`，没有匹配。

**子进程与临时目录（25 分钟）**：四域里走到 `ctx.subprocess.spawn` 的是专利和视频。专利渲染、PDF、立案和 ego-browser 的宽限都是 3000（`subprocess-render.ts:33`，`pdfRenderer.ts:34`，`filing/engine.ts:30`，`subprocess-runner.ts:12`）。视频组装传入 5000（`video-mode/src/edl.ts:333`）。法律与 `law` 在 Day 24 已确认没有 `spawn`。文档转换不走这条缝，Day 23 记的是 LibreOffice helper 自己的 SIGKILL。临时目录有三处产品前缀：`dsh-office-kit-`（`office-kit/src/index.ts:399`，`finally` 删除，Day 23 已测）、`dsh-patent-filing-`（`filing/engine.ts:359`，`:380` 删除）、`dsh-outline-`（`inkscape-renderer.ts:257`，`:305` 删除）。视频没有 `mkdtemp`。共享收集器只在调用方带了 `spill` 时写溢出文件；四域这几处 spawn 只传 `maxBytes`。运行时仍会在第一次 spawn 准备私有目录 `dsh-subprocess-`（`subprocess-local/src/output.ts:104`–`:108`）。进程正常退出且目录为空时 `rmdir`（`:53`–`:56`）。完成的溢出文件会留下来（`:38`–`:39`）。

**取消（30 分钟）**：中止对进程组先发 SIGTERM，宽限后再发 SIGKILL（`subprocess-local/src/spawn.ts:364`–`:380`）。子进程范围退出后摘掉 abort 监听（`:354`）。专利包装在 `finally` 里 `clearTimeout` 并 `removeEventListener`（`subprocess-runner.ts:75`–`:78`，`pdfRenderer.ts:132`–`:135`，`filing/engine.ts:219`–`:222`，`subprocess-render.ts:210`–`:213`）。Graphviz、FreeCAD、Inkscape 都在 `finally` 调用 `deadline.dispose()`。本次直接对共享缝发中止。配合退出的脚本使用宽限 5000，中止后 32.88ms 以 SIGTERM 结束，pid 已不在，abort 监听剩 0。忽略 SIGTERM 的脚本使用宽限 400，先等到输出里的 armed，再中止；435.3ms 后以 SIGKILL 结束，pid 已不在，监听剩 0。夹具里的 spill 目录有 0 个文件。

| 路径 | 宽限 | 结果 |
|---|---|---|
| 配合退出，睡眠 30 秒 | 5000 | 32.88ms，SIGTERM，pid 不在，监听 0 |
| 忽略 SIGTERM，循环睡眠 | 400 | 435.3ms，SIGKILL，pid 不在，监听 0 |
| 16 个立即退出的脚本，不中止 | 500 | 44.41ms 一起结束 |

**并发与 C 维度去重（25 分钟）**：共享缝没有全局并发上限。16 个立即退出的脚本 44.41ms 跑完。各域自己设上限：Office 同时转换 2、排队 8、读者 32、后台 1（`office-kit/src/index.ts:92`–`:96`）；工作流并行阶段默认 4（`patent-workflow/src/workflow.ts:110`）；视频保留任务上限 64（`video-mode/src/media.ts:347`）。Windows 的 Job 启动器在子进程活着时每 10ms 轮询一次，收尾两处都 `clearInterval`（`spawn-runner.ts:321`，`:412`，`:430`）。本次是 darwin，没有走到那条路径。Day 20–25 的发现索引里，维度列为 C 的只有 F-PAT-032。F-PAT-027 是 B 维度的骨架重复，今日不改判。

## 发现

无。

下面几条不够格单列，只作可选观察：

1. 子进程配合 SIGTERM 时，宽限 5000 也只等了 32.88ms。忽略 SIGTERM 时，等待贴着宽限走：400 对应 435.3ms，随后是 SIGKILL，进程不在。专利域配置的宽限是 3000，视频是 5000。
2. 共享缝不限制同时存在的子进程。16 个立即退出的脚本耗时 44.41ms。上限在各域自己的队列和任务表上。
3. 四域的 spawn 不带 spill 字段，溢出文件这次是 0。运行时仍会为第一次 spawn 准备 `dsh-subprocess-`。空目录靠进程退出时的 `rmdir` 收掉。本次把 spill 指到夹具，没有观察系统临时区里的那个默认目录。
4. C 维度六天只有 F-PAT-032 一条新发现。今日的取消、临时目录和并发都不与那条 LIKE 扫描重叠。

## 假设验证/推翻

H01–H10 维持原状态。H03 仍是 Day 23 的「取消与异常路径未发现泄漏」。Office 转换不走今日这条 `graceMs` 缝，状态格不改。

## 未决问题

1. ffmpeg、Chrome、Python、Inkscape 和 LibreOffice 都没有启动。宽限测的是睡眠脚本。
2. 忽略 SIGTERM 时，专利域 3000 与视频 5000 的墙钟没有按这两个配置再测。本次宽限是 400，耗时 435.3ms。
3. 默认 `dsh-subprocess-` 目录有没有留在系统临时区，本次没有扫。spill 被指到了夹具目录，里面 0 个文件。

## 明日第一件事

Day 27（D 测试缺口：`patent-tools`、`patent-core`）第一件事：按高风险表面列 happy path。今日共享子进程的取消已经测过。法律域的 LIKE 扫描、Day 21 的判例零命中和 Day 23 的 Office 转换都不重测。先看渲染与立案这两条子进程包装的测试是否只覆盖成功退出。
