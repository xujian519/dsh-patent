# Day 25 — 2026-12-09

## 今日维度与范围

- 维度：C 优化
- 范围：视频模式：video-mode、ui-video-studio
- 时间盒：90 分钟
- 预期产出：C 维度视频域候选发现；daily/day-25.md

## 检查项

- [x] 检查 provider 轮询间隔与超时。
- [x] 检查下载与内联字节处理。
- [x] 检查 ffmpeg 进程生命周期。
- [x] 检查项目锁。
- [x] 附证据。

## 实际执行

**基线（10 分钟）**：测量时工作区停在已合并的 master，本日记录还没写入。Node `v24.19.0`，darwin arm64。不打模型，不打 MiniMax、SiliconFlow、ComfyUI。`benchmarks/` 仍没有视频用例（OBS-008）。命令是 `node --import tsx/esm` 导入 `video-mode` 与 `ui-video-studio` 的 `src`，退出码 0。脚本是一次性的，跑完即删。合成文件在临时目录，进程结束时删掉。真实 ffmpeg 没有启动，组装用的是会睡 30 秒的脚本。在这两个包的 `src` 检索 `setInterval(`，退出码 1，没有匹配。在 `video-mode/src` 检索 `mkdtemp` 与 `tmpdir`，退出码 1，没有匹配。

**轮询（25 分钟）**：`resolveMediaConfig()` 打出的默认值是 `waitMs` 30000、`pollMs` 250、`maxArtifactBytes` 536870912、`maxTasks` 64（`video-mode/src/media.ts:344`–`:347`）。这三个时间与任务上限必须为正（`:365`–`:366`）。`generate` 提交后进入 `wait`（`:823`–`:848`）。循环用 `timers/promises` 的 delay 睡一个 `pollMs`（`:13`，`:828`），再调用一次 `provider.poll`。云端默认间隔更稀：ComfyUI 2000ms、超时 3600000ms（`:213`–`:214`）；MiniMax 与 SiliconFlow 都是 10000ms、超时 3600000ms（`:241`–`:242`，`:262`–`:263`）。三家都在 `lastPollAt` 为 0 时放行第一次状态请求，间隔未到就原样返回任务（`siliconflow.ts:226`，`minimax.ts:242`，`comfyui.ts:514`）。本地把运行时收成 `pollMs` 250、`waitMs` 1000。计数 provider 第三次 poll 才成功。SiliconFlow 用桩 fetch，`pollMs` 10000，基址指向 `127.0.0.1:9`，请求没有离开进程。

| 路径 | 规模 | 耗时 | 样本 |
|---|---|---|---|
| 计数 provider，第三次 poll 成功 | `pollMs` 250，`waitMs` 1000 | 756.04ms，状态 succeeded，poll 3 次 | 1 |
| SiliconFlow 桩 | provider `pollMs` 10000，运行时 `waitMs` 1000 | 1012.28ms，状态 running；`/video/submit` 1 次，`/video/status` 1 次 | 1 |

**下载与内联字节（20 分钟）**：`downloadVideo` 只接受 http 或 https。`content-length` 有限且超过上限时，在读 body 之前拒绝；否则 `arrayBuffer` 成一整块 `Uint8Array`，空或超限再拒绝（`cloud-common.ts:179`–`:192`）。参考图也是先读完再检查大小。MiniMax 上限 31457280 字节（`minimax.ts:63`，`:495`–`:509`）。SiliconFlow 上限 10485760 字节（`siliconflow.ts:61`，`:428`–`:445`）。ComfyUI 读完后再拷进第二个 `ArrayBuffer`（`comfyui.ts:633`–`:639`）。8MiB 的 base64 计时走的是同样的读文件再编码，因为这个函数没有导出。桩 fetch 只认 `https://example.test`。下表的「热」是同一进程里的重复调用。

| 路径 | 规模 | 冷 / 中位数 | 样本 |
|---|---|---|---|
| 有 `content-length` 的下载 | 8388608 字节，上限等于体积 | 1.35ms / 0.68ms | 冷 1，热 3 |
| 无 `content-length` 的下载 | 8388608 字节 | 0.71ms 单次，body 读了 1 次 | 1 |
| 声明长度超过上限 | 声明比 8388608 多 1 字节，上限 1024 | 抛出；fetch 被调用，body 未读 | 1 |
| 无长度且 body 超过上限 | 64 字节，上限 16 | 抛出；body 已读 | 1 |
| 读入后再 base64 | 8388608 字节，字符 11184812 | 4.84ms / 2.04ms | 冷 1，热 1 |

**ffmpeg 生命周期（20 分钟）**：一次组装一次 `ctx.subprocess.spawn`。参数是数组，标准输出和标准错误各限 1048576 字节，`graceMs` 5000，调用方的 signal 原样传入（`edl.ts:325`–`:334`）。参数以 `-y` 开头（`:222`）。目标尚不存在时先写 0 字节占位，失败后不删除（`:451`–`:457`）。darwin 走子进程的 fallback，中止时对进程组发 SIGTERM，宽限后再 SIGKILL（`subprocess-local/src/spawn.ts:364`–`:380`，`subprocess-local/src/index.ts:254`–`:274`）。本次可执行文件是临时目录里的睡眠脚本。中止安排在启动后 200ms。组装在 217.69ms 抛出 `MediaFailure`，代码 `MEDIA_ASSEMBLY_FAILED`。脚本记下的 pid 已退出，完成标记没有写，输出文件仍是 0 字节。测量目录在进程结束时删除。

**项目锁与工作室（15 分钟）**：`withKeyLock` 按键串起进程内的 promise，当前这段结束后若仍是队尾就从表里删掉（`lock.ts:17`–`:24`）。journal 与账本只在读改写文件时持锁（`store.ts:152`，`:176`，`:241`），不包住提交、轮询或下载。工作室刷新是按钮（`ui-video-studio/src/client/StudioView.tsx:140`，`:170`）。`readStudioProject` 读一次项目 JSON，再对每个媒体路径串行 `stat`（`project-reads.ts:368`–`:399`，循环在 `:392`）。预览保存的是路径和版本，不把成片字节读进页面。下表的 stat 是即时桩，账本和 journal 按缺失处理。

| 路径 | 规模 | 冷 / 中位数 | 样本 |
|---|---|---|---|
| 同一键 200 个空任务 | 进程内锁 | 0.1ms / 0.06ms，跑满 200 | 冷 1，热 1 |
| 200 个不同键 | 同上 | 0.11ms / 0.1ms | 冷 1，热 1 |
| 同一键 20 次各等 5ms | 同上 | 113.13ms 单次 | 1 |
| 工作室读项目 | 200 镜，400 次 stat | 1.05ms / 0.43ms | 冷 1，热 1 |

## 发现

无。

下面几条不够格单列，只作可选观察：

1. 运行时默认每 250ms 醒一次，云 provider 自己的状态间隔是 2 秒或 10 秒。1000ms 窗口里桩状态接口只打了 1 次，任务仍是 running。计数 provider 的 756.04ms 基本就是三次 250ms 睡眠。
2. 没有 `content-length` 时，下载先读完 body 再按上限拒绝。64 字节对 16 字节上限证实了这一点。8MiB 有长度的热中位数是 0.68ms，上限是 536870912。参考图同样先读完；8MiB 再 base64 的热中位数是 2.04ms。ComfyUI 的第二次拷贝这次没有单独计时。
3. 取消后的睡眠脚本在 217.69ms 退出，记录到的 pid 已不在，完成标记没写。留下的是声明输出路径上的 0 字节占位。源码里没有私有临时目录。真实 ffmpeg 没启动，`graceMs` 5000 的升级这次没走到。F-VID-004 已记录覆写，不另开。
4. 同一键 200 次锁的热耗时 0.06ms；20 次各 5ms 串成 113.13ms。锁不包住提交和下载。F-VID-001 的跨进程缺口仍在，不另开。
5. 工作室没有轮询定时器。200 镜、400 次即时 stat 的热中位数是 0.43ms。这只说明循环是串行 await。

## 假设验证/推翻

H01–H10 维持原状态。H04 的验证点是 Day 11 与 Day 39，今日的轮询间隔不改变计费结论。H05 的 ffmpeg 汇点仍是已部分确认的安全项，今日只测了取消后进程是否还在。

## 未决问题

1. 云端轮询和下载的墙钟没有测。状态与下载都是桩 fetch，没有调用 MiniMax、SiliconFlow 或 ComfyUI。
2. 真实 ffmpeg 没有启动。取消测的是睡眠脚本，217.69ms 退出；`graceMs` 5000 的 SIGKILL 升级这次没有走到。
3. 工作室 Host 的 stat 往返没有测。400 次桩 stat 的 0.43ms 不能代表 IPC。Day 11 记下的 workspaceFiles 授权边界这次没有重审。

## 明日第一件事

Day 26（C 优化：子进程、临时文件、监听器、取消与并发）第一件事：看共享子进程的 grace、监听器和取消。今日视频路径的睡眠脚本在中止后 217.69ms 退出，进程不在，没有私有临时目录。法律域的 LIKE 扫描、Day 21 的判例零命中和 Day 23 的 Office 都不重测。
