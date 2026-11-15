# Day 5 — 2026-11-19

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-19）。

## 今日维度与范围

- 维度：定向与基线
- 范围：视频模式入口与基线补全：video-mode、video-bundle、ui-video-studio
- 时间盒：120 分钟
- 预期产出：视频域数据流笔记；02-baseline.md 补全；daily/day-05.md

## 检查项

- [x] 记录 ctx.media、项目文档、EDL 与四个模型可见工具。
- [x] 记录 provider 选择、凭据、成本账本与任务 journal 入口。
- [x] 记录 ui-video-studio 的客户端数据流。
- [x] 记录 video-bundle 的 preset 与技能组合。
- [x] 在环境允许时补跑 typecheck 与 lint，并记录退出码（两者 exit 0）。
- [x] 记录覆盖率获取方式与四域测试密度。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 列出三包 `src`/preset/skills | `video-mode` 22 个源码文件；`video-bundle` 6 个技能；`ui-video-studio` 客户端视图与读取层 |
| `grep` 服务/工具 | `ctx.media` 在 `Service.init` 注册 5 类 provider；四个工具在 `ctx.inject(['tools','fs','subprocess'])` 中注册 |
| `grep` provider/凭据/账本/锁 | 合成、ComfyUI、MiniMax 视频、MiniMax 语音、SiliconFlow；`ctx.get('credentials')` 或 `process.env`；`tasks.json` 与 `budget.json` |
| 读关键实现 | `media.ts`、`project.ts`、`edl.ts`、`store.ts`、`lock.ts`、`tools/media.ts`、`tools/project.ts`、`tools/assemble.ts`、`tools/deliver.ts`、`video-projects.ts`、`project-reads.ts` |
| Node 24 `pnpm run typecheck` | exit 0（后台日志第 16 行） |
| Node 24 `pnpm run lint` | exit 0；仅 npm 配置警告，无 lint 告警 |

## 数据流笔记

### video-mode

- `ctx.media`：`MediaRuntime` 继承 Cordis Service；`Service.init` 按配置注册合成、ComfyUI、MiniMax 视频、MiniMax 语音与 SiliconFlow 五类 provider。重复 id 直接拒绝，注册通过 `ctx.effect` 拥有 dispose。
- provider 选择：`resolve(request)` 先拒绝空 prompt，再筛可用且支持该能力的 provider；模型未知或多 provider 同名模型分别抛 `MEDIA_MODEL_UNKNOWN` / `MEDIA_PROVIDER_AMBIGUOUS`；选定后做请求校验。
- 凭据：`resolveCredential(ref)` 优先走 `ctx.get('credentials')`，服务缺失时回退 `process.env`；provider 支持直接 `apiKey` 或 `apiKeyEnv` 引用。
- 任务：`submit` 估算费用、提交 provider、记录到内存任务表与 `costs`；`wait` 轮询到终态或 `waitMs` 超时；`status`/`refresh`/`cancel` 读或改保留任务；`resume(record)` 用 provider 的 `resume` 从 journal 恢复。
- 项目文档：`video/<id>/project.json`，zod 严格 schema；`newProject` 默认 9:16、45 秒、50 CNY；`validateProject` 拒绝任何多余字段；`mutateProjectFile` 在写入前重读，若文件已被他人改写就重试，三次后抛 `MEDIA_PROJECT_CONFLICT`。
- 锁：`lock.ts` 的 `withKeyLock` 是进程内按 key 的 Promise 链；`withProjectLock` 也是进程内。跨进程写入靠 `mutateProjectFile` 的读后重试检测，不是文件锁。
- EDL：严格 schema 限画布 64–7680、fps 1–120、clips 1–400、audio ≤32；`validateEdl` 检查 `outSec > inSec`；`rejectFilterControl` 拒绝控制字符，`escapeSubtitleFilename` 处理引号与反斜杠；`assemble` 构建 ffmpeg 参数并通过 `ctx.subprocess` 执行，`command` 随结果返回以便复现。
- 账本与 journal：`tasks.json` 记录未结算任务，`budget.json` 记录已结算费用；`appendLedgerEntry` 按 `taskId` 幂等，重复结算不会重复计费；`ledgerCost` 用“分”累加避免浮点漂移。
- 四个工具：
  - `media`：`models`/`estimate`/`generate`/`status`/`cancel`。`generate` 在提交前读项目与账本，`spent = max(projectCost, ledgerCost)`，超出预算抛 `MEDIA_BUDGET_EXCEEDED`；非 CNY 估算或超过 `approvalThresholdCny` 时必须 `confirm_cost`；成功后写 artifact 并结算，失败/取消则移除 journal。
  - `video_project`：`init`/`read`/`upsert_shot`/`remove_shot`/`record_render`；每次变更先校验完整文档再写。
  - `video_assemble`：校验 EDL、跑 ffmpeg、返回测量时长/分辨率/音频与完整命令；超时 15 分钟。
  - `video_deliver`：读项目与账本，拒绝无镜头、缺 clip、预算超限、无视频流；对无音频与时长偏差给警告；探测视频流。

### video-bundle

- `src/index.ts` 只导出空对象；运行时行在 `cordis.patch.yml` 与 `presets/video.patch.yml`。
- preset 挂载 `@deepseek-ai/dsh-video-mode`，并用 `skill-filesystem` 指向 `skills/video` 下的六个技能：`video-brief`、`video-storyboard`、`video-generate`、`video-assemble`、`video-voice`、`video-deliver`；`tool-skill` 暴露技能目录。
- `locale/` 提供 zh/en/ja/es/fr/de/ru/pt 八种文案。

### ui-video-studio

- `video-projects.ts`：对话节点按 turn 收集 `video_project` 结果元数据里的 `projectPath`，`media` 结算会提升 revision；会话级视图折叠出首次出现的项目路径，studio 在 revision 变化时重读文件。
- `project-reads.ts`：通过 `workspaceFiles` Remote 读 `project.json`、`budget.json`、`tasks.json`；`spentCny` 取镜头费用与账本的较大值；账本/journal 损坏时读为零/空，项目文档损坏时抛 `StudioReadError`，不展示半份文档。
- 客户端只读：studio 不写项目文件，Host 的项目文档是唯一事实源。

## 发现

代码级发现：无。Day 5 只做定向，不判定缺陷。

结构观察（待对应维度确认）：

1. 预算与账本设计完整：提交前预算检查、非 CNY 强制 `confirm_cost`、审批阈值、`taskId` 幂等账本、`max(projectCost, ledgerCost)` 与“分”累加；H04 在定向层面出现正向证据。
2. 跨进程项目写入是乐观并发，不是文件锁：`withProjectLock` 只在进程内；`mutateProjectFile` 在读后重试三次，冲突抛 `MEDIA_PROJECT_CONFLICT`。不会静默覆盖，但两个 host 进程同时写会冲突；Day 39 复核用户可见行为。
3. provider 重启恢复不均衡：ComfyUI、MiniMax、SiliconFlow 实现 `resume`；合成 provider 没有。假的合成 provider 丢任务影响有限，但 journal 恢复路径需要 Day 11/39 验证。
4. EDL 的 filter graph 注入面已做边界处理：控制字符拒绝、字幕路径转义、ffmpeg 以 argv 执行并记录完整命令；Day 11 继续追其它模型输入。
5. 客户端与服务端共享同一项目文档，没有第二状态库；studio 只读，损坏的账本/journal 不会遮住项目文档。这是 H10/项目一致性的正向证据。
6. `video-bundle` 是纯数据组合层，六个技能与八种 locale；preset 漂移留到 Day 19 对照。

## 假设验证/推翻

- H04：**出现正向证据**。`media generate` 提交前检查预算，账本按 `taskId` 幂等，交付检查取项目费用与账本的较大值；跨进程冲突仍是乐观检测，Day 11/39 继续。
- H05：**部分处理**。EDL 控制字符与字幕引号已处理，ffmpeg 以 argv 执行；其余 provider/路径输入留到 Day 11。
- H10：**定向支持**。`media` 工具结果包含任务与 artifact，项目文档与 journal 可重建；provider 原始响应是否需要单独落会话事件，Day 11/40 判断。
- H06：`video-mode` 13 个测试文件/7.4k 行、`ui-video-studio` 4/1.4k、`video-bundle` 1；Day 31 按高风险表面核对。
- H09：preset 挂载 video-mode 与六个技能；Day 19 对照包清单与 preset。

## 未决问题

1. 跨进程冲突的用户可见行为：`MEDIA_PROJECT_CONFLICT` 是否可重试、是否需要文件锁，留到 Day 39。
2. 合成 provider 不支持 `resume`，重启后的 journal 记录会怎样失败，留到 Day 11/39。
3. `video_deliver` 用 `max(projectCost, ledgerCost)` 判预算；镜头费用若被手改可能低估或高估，留到 Day 39。

## 明日第一件事

Day 6：进入 A 安全维度，先看 `patent-data` 与 `patent-tools` 的外部输入到危险汇点：CNIPR/nuo 请求参数、ego-browser 子进程的 argv/env、PDF 下载脚本与文件路径。
