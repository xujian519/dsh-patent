# 视频模式 Agent 预设

[English](video.md) | 中文

`video` 预设把视频生产 Agent 组合到 DeepSeek Harness 上。它以 `standard` 为基础，替换 persona 与计划模式章节为视频生产版本，加入六个生产技能，并挂载实验性视频模式的四个工具。该模式产出项目文档、逐镜素材、EDL，以及一条经过显式交付检查的 MP4 成片。

## 挂载内容

在视频工作流需要的 standard 通用行（shell、文件系统、后台任务、排程、技能、目标、计划模式、压缩、委派、ask-user、todo 与 web）之外，预设还提供：

- `skills/video/` 下的六个生产技能：`video-brief`（规格）、`video-storyboard`（分镜与资产）、`video-generate`（关键帧优先的媒体生成）、`video-voice`（配音、BGM、字幕）、`video-assemble`（EDL 与 ffmpeg）、`video-deliver`（机器检查与登记）。
- 一行 `video-mode`，来自 `@deepseek-ai/dsh-video-mode`。它提供 `ctx.media`、云端 MiniMax-H3 视频 provider、云端 SiliconFlow Wan2.2 图生视频 provider、云端 MiniMax 语音 provider、本地 ComfyUI provider（Z-Image Turbo 关键帧；Wan 2.2 仍可以 `wan2.2-ti2v-5b` 显式选择），以及四个模型工具：`media`、`video_project`、`video_assemble`、`video_deliver`。 进行中的任务会记入项目旁的日志，每次以人民币计价的结算写入账本，因此重启后可以接回轮询，预算门也不会因忘记回写成本而少算。
- 视频生产 persona（规格先行、资产先于镜头、关键帧先于片段、先估后生成、机器检查先于交付）与视频版计划模式章节：平台、时长、画幅、预算、脚本、分镜、资产方案与交付清单都属于“计划”；获批前不生成付费媒体或对外成片。

相对 `standard` 的行集，本预设有意省略四行：`tool-plugin-market`、`present`、`tool-plugin-manager`、`openviking`。`tool-plugin-market` 是只读目录浏览，安装插件属于部署动作；`present` 把任意可访问文件声明为交付物，本模式通过 `video_deliver` 声明交付物并携带机器检查；`tool-plugin-manager` 写 profile 配置，Host patch 默认禁用；`openviking` 是面向 HTTP 服务的外部记忆，本组合不运行该服务。

## 前置条件

- Host 上有 `ffmpeg` 与 `ffprobe`。任一无法解析时汇编器以 `MEDIA_FFMPEG_MISSING` 失败。烧录中文字幕需要 `libass` 与 CJK 字体。
- 具备 H3 视频权限的 MiniMax API 密钥，由 `minimax.apiKeyEnv` 命名为 `MINIMAX_API_KEY`，通过 credentials 服务保存或从启动环境导出。缺少密钥时预设仍可启动并使用 ComfyUI；MiniMax 请求会提示如何保存或导出密钥。密钥未授权或余额不足会在首次视频提交时返回 provider 的错误消息。
- 具备 `Wan-AI/Wan2.2-I2V-A14B` 调用权限的 SiliconFlow API 密钥，由 `siliconflow.apiKeyEnv` 命名为 `SILICONFLOW_API_KEY`，通过 credentials 服务保存或从启动环境导出。该模型只接受一张首帧图，固定返回 5 秒片段；国内站每条 2.00 元，国际站每条 0.29 美元。缺少密钥时预设仍可启动，provider 注册为不可用，其他视频后端仍可服务请求。
- 语音合成使用同一把密钥与同一个 API 源，账号需要具备语音合成权限。provider 默认使用 `speech-2.8-turbo`，每万字符 2.00 元；`speech-2.8-hd` 为每万字符 3.50 元。缺少密钥时首次语音请求会返回相同的修复提示。给 `media generate` 传 `subtitles: true` 可获得 `.srt` 旁挂文件，时间轴来自 MiniMax 的词级时间戳。
- `http://127.0.0.1:8188` 上有本地 ComfyUI（0.38 或更新），且 `models/` 下已放置 Z-Image Turbo。关键帧来自这一行。Wan 2.2 TI2V-5B 文件是可选项，仅在调用方显式选择 `wan2.2-ti2v-5b` 时使用。
- 预设运行 `fakeProvider: false`，所有产物都来自 MiniMax、SiliconFlow 或 ComfyUI。需要免凭据演示时，把 `fakeProvider` 设为 true 并选择 `synthetic/*` 模型；合成 provider 产出一秒片段与固定价格。

## 模型体验

模型看到视频生产 persona、视频版计划模式章节、六个预设技能，以及标准工具之外的四个视频工具。persona 写明预算（默认 50 元）、单次生成 10 元的确认阈值、关键帧优先纪律、机器检查规则，以及诚实降级规则（没有视觉模型就写“未做画面审阅”；没有 ffmpeg 就写“无法合成”）。

工具承载生产词汇：`media` 选择模型并写入产物，`video_project` 拥有项目文档，`video_assemble` 渲染 EDL，`video_deliver` 检查声明文件并拒绝不完整或超预算的交付。

## 已知限制与后续工作

- **Web 工作台只读** —— `视频` 标签展示已发现的项目、分镜、成片、进行中任务、账本，以及经文件路由 Range 响应的媒体预览。编辑及外部改动后的重新发现仍由工具与标签内的刷新手势完成。
- **云端视频是默认路径** —— MiniMax-H3 服务视频并按生成秒数计费（768P 每秒 0.50 元，2K 每秒 0.80 元）。5 秒 768P 片段预估 2.50 元；超过 10 元确认阈值的片段需要用户批准。
- **SiliconFlow 是低价的固定时长路径** —— `Wan-AI/Wan2.2-I2V-A14B` 每条 2.00 元（国际站 0.29 美元），固定返回 5 秒，需要首帧图，且没有取消接口。省略 `duration_sec` 或传 `5`；EDL 会把片段裁到镜头计划。美元价格无法与人民币预算比较，`media generate` 会要求 `confirm_cost: true`，且不写入账本。
- **随包 Wan 工作流使用 CFG 1** —— 在 Apple MPS 上 CFG>1 的批量分支会让颜色失真，因此负向提示不生效。兼容运行时上的部署可挂载自己的 CFG 5 工作流。
- **本地 Wan 视频只作草稿** —— 调用方选择 `wan2.2-ti2v-5b` 时，`video-generate` 把镜头关键帧作为 `first_frame_path` 传入。实测在 Apple MPS 上 480p 片段数秒内仍会出现拖影与漂移，CFG 5 则直接破坏颜色；生产片段请用 MiniMax-H3 或 SiliconFlow。两者同样接受关键帧，技能仍会传入以保持跨镜一致。
- **字幕换行由标点决定** —— 语音 provider 按句末标点、逗号与 13 字符预算对 MiniMax 词级时间戳分组，长句会在固定宽度处分行。需要在别处分行时直接调整 SRT。
- **没有转写、MV 与切片流水线** —— persona 提到这些工作流，但词级转写、节拍网格、源视频导入与 9:16 重构仍在规划；被问到时助手必须如实说明。
- **没有数字人口型同步** —— 口播使用主播静帧、B-roll 与配音。
- **不自动发布** —— 交付止于文件与清单，发布由用户完成。
