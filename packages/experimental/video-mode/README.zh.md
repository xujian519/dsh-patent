---
description: "实验性视频模式：媒体 provider 能力缝、持久项目文档、由 ffmpeg 渲染的可复现 EDL、四个模型工具、确定性合成 provider、渲染 Wan 2.2 视频与 Z-Image 图像的本地 ComfyUI provider，以及云端 MiniMax-H3 视频、MiniMax 语音与 SiliconFlow Wan2.2 provider。"
kind: "package-reference"
---

# @deepseek-ai/dsh-video-mode

[English](README.md) | 中文

## 概述

本包是视频模式的第一个 Host 切片。它提供 `ctx.media`（图像、视频、语音生成的 provider 注册表）、`video/<id>/project.json` 持久项目文档（旁边带任务日志与预算账本）、经校验并由 ffmpeg 渲染的编辑决策表（EDL），以及四个模型工具：`media`、`video_project`、`video_assemble`、`video_deliver`。随包提供五个 provider：无需凭据的确定性合成 provider、渲染 Wan 2.2 视频与 Z-Image 关键帧的本地 ComfyUI provider，以及云端 MiniMax-H3 视频、MiniMax 语音与 SiliconFlow Wan2.2 图生视频 provider。

## 目录

- [挂载内容](#what-it-mounts)
- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-mounts"></a>
## 挂载内容

- **`ctx.media`** —— 能力缝的 provider 注册表与统一执行路径。它按配置的默认模型或显式 `model` 选择 provider，在执行时解析模型，用稳定的 `MediaFailure` 码拒绝不可用与歧义选择，保留有界数量的任务记录，把进行中任务记入项目旁的日志以便重启后恢复，并最多等待 `waitMs` 让任务结算。
- **`media` 工具** —— 一个按 action 分派的工具（`models`、`estimate`、`generate`、`status`、`cancel`）：列出模型与价格、预估成本、提交生成、通过 `ctx.fs` 写入产物、读取或取消任务，并在带 `project_path` 时于重启后恢复日志中的任务。
- **`video_project` 工具** —— 创建、读取与修改项目文档。每次修改先校验完整文档再写入；项目文件是镜头、选中片段、成片与预算的唯一事实源。同一 Host 内按项目串行化修改，若文件在读取后被改动则重试。
- **`video_assemble` 工具** —— 校验 EDL，经 ffmpeg 以归一化滤镜图渲染（画布、帧率、等比补边、拼接、混音、烧字幕、faststart），返回实测时长、分辨率与是否有音轨。
- **`video_deliver` 工具** —— 登记最终文件并返回机器检查。缺视频、镜头不完整、视频无可读流、上报成本超预算会拒绝登记；时长偏差与缺音轨只告警。
- **合成 provider** —— 确定性的 PNG、WAV、MP4 素材与固定价格。由 `fakeProvider: true` 启用。
- **ComfyUI provider** —— 向本地 ComfyUI 提交 API 格式工作流，轮询其历史记录，下载产物文件，并以内联字节结算任务。随包工作流渲染 Wan 2.2 TI2V-5B 视频与 Z-Image Turbo 图像；`comfyui.video.workflowPath` 与 `comfyui.image.workflowPath` 可换成部署自有工作流。本地算力没有按次计费，因此预估成本恒为 0 元。
- **MiniMax provider** —— 向 `https://api.minimax.cn/v2/video_generation` 提交一个 MiniMax-H3 视频任务，轮询 `/v2/query/video_generation/<id>`，下载结算后的 MP4，并以内联字节返回。支持文本、首帧、尾帧与参考图输入；本地图片以 data URI 传输。预估算使用公布的元/秒价：768P 每秒 0.50 元，2K 每秒 0.80 元。
- **SiliconFlow provider** —— 向 `https://api.siliconflow.cn/v1/video/submit` 提交一个 Wan2.2 图生视频任务，首帧以 data URI 传入，轮询 `/v1/video/status`，并下载结算后的 MP4。`Wan-AI/Wan2.2-I2V-A14B` 固定生成 5 秒、`1280x720`／`720x1280`／`960x960` 的片段；API 没有时长字段，请求其他时长会被拒绝。硅基流动按条计费：国内站每条 2.00 元，国际站每条 0.29 美元；API 不返回价格，因此两项都可配置。
- **MiniMax 语音 provider** —— 向 `https://api.minimax.cn/v1/t2a_v2` 发送一次同步语音合成请求，并以内联 MP3 字节结算。它与父级 `minimax` 共用凭据与 API 源，单次请求可指定任意系统音色，默认使用 `speech-2.8-turbo` 与 `Chinese (Mandarin)_News_Anchor`。一个汉字按两个字符计费；公布价格为 `speech-2.8-turbo` 每万字符 2.00 元、`speech-2.8-hd` 每万字符 3.50 元。请求带 `subtitles: true` 时还会下载 MiniMax 的词级时间戳文件并返回字幕行；`media generate` 将其写成音频旁的 `.srt`。

<a id="use-this-package"></a>
## 使用本包

在同时提供 `ctx.tools`、`ctx.fs`、`ctx.subprocess` 的组合中挂载：

```yaml
- id: video-mode
  name: '@deepseek-ai/dsh-video-mode'
  config:
    fakeProvider: true
    waitMs: 30000
    ffmpegPath: ffmpeg
    ffprobePath: ffprobe
```

视频模式预设则在本机生成关键帧、在云端生成视频：

```yaml
- id: video-mode
  name: '@deepseek-ai/dsh-video-mode'
  config:
    fakeProvider: false
    imageModel: z-image-turbo
    videoModel: MiniMax-H3
    speechModel: speech-2.8-turbo
    comfyui:
      enabled: true
      baseUrl: http://127.0.0.1:8188
      image:
        size: 1024
    minimax:
      enabled: true
      apiKeyEnv: MINIMAX_API_KEY
      resolution: 768P
      aspectRatio: 9:16
      speech:
        enabled: true
        model: speech-2.8-turbo
        voiceId: Chinese (Mandarin)_News_Anchor
    siliconflow:
      enabled: true
      apiKeyEnv: SILICONFLOW_API_KEY
      model: Wan-AI/Wan2.2-I2V-A14B
      aspectRatio: 9:16
      pricePerVideo: 2
      currency: CNY
```

MiniMax 前置条件：通过 credentials 服务保存 `MINIMAX_API_KEY`，或将其导出到环境，且账号或 M Plan 具备 H3 视频权限。预设通过 `minimax.apiKeyEnv` 命名该凭据引用；provider 每次请求都重新解析，因此轮换密钥无需重启。缺少密钥时预设仍可使用 ComfyUI，MiniMax 请求会返回保存或导出 `MINIMAX_API_KEY` 的修复提示；密钥未授权或余额不足会在首次提交时返回 provider 的错误消息。MiniMax-H3 支持 768P 或 2K、4–15 秒的片段；传入首帧或尾帧时 `ratio` 强制为 `adaptive`。

SiliconFlow 前置条件：通过 credentials 服务保存 `SILICONFLOW_API_KEY`，或将其导出到环境。预设通过 `siliconflow.apiKeyEnv` 命名该凭据引用；缺少密钥时返回同类修复提示，provider 注册为不可用，其他视频后端仍可服务请求。账号需要具备 `Wan-AI/Wan2.2-I2V-A14B` 的调用权限。该模型只接受一张首帧图，固定生成 5 秒无声视频；先用 ComfyUI 或图像 provider 生成关键帧。国内站每条成片 2.00 元，国际站每条 0.29 美元；按签发密钥的站点设置 `siliconflow.pricePerVideo` 与 `siliconflow.currency`。公开 API 没有取消接口，`media cancel` 只停止本地轮询，远端任务仍可能完成并计费。

语音 provider 使用同一把密钥与同一个 API 源。账号需要具备语音合成权限；缺少权限时首次语音请求会返回 provider 的错误消息。语音请求为同步调用，单次最多 10,000 字符，长口播按句或按镜头拆分。缺少密钥时返回与视频相同的修复提示，预设仍可启动并完成图像与视频工作。

ComfyUI 关键帧前置条件：0.38 或更新版本可从 `comfyui.baseUrl` 访问，且 `models/` 下已放置 Z-Image Turbo、`qwen_3_4b` 文本编码器与 `ae.safetensors`。显式选择 `wan2.2-ti2v-5b` 的部署才需要 Wan 2.2 文件。缺少文件会在首次提交时以 ComfyUI 的节点错误失败；配置中的文件名写错也同样失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fakeProvider` | `true` | 挂载合成 provider。接入真实 provider 时设为 false。 |
| `imageModel` | `synthetic/image` | 默认图像模型 id。 |
| `videoModel` | `synthetic/video` | 默认视频模型 id。 |
| `speechModel` | `synthetic/speech` | 默认语音模型 id；视频预设设为 `speech-2.8-turbo`。 |
| `waitMs` | `30000` | `media generate` 在返回运行中任务 id 前的最长等待。 |
| `pollMs` | `250` | 等待期间的轮询间隔。 |
| `maxArtifactBytes` | `536870912` | 单个产物的大小上限。 |
| `maxTasks` | `64` | 保留的任务记录数。 |
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件名或路径。 |
| `ffprobePath` | `ffprobe` | ffprobe 可执行文件名或路径。 |
| `syntheticLatencyMs` | `0` | 合成 provider 结算前的延迟。 |
| `subtitleFont` | 空 | 烧字幕使用的字体族；空表示使用 ffmpeg 默认值。 |
| `approvalThresholdCny` | `10` | 单次生成估算超过该值时需要 `confirm_cost` 与用户确认。 |
| `comfyui.enabled` | `false` | 挂载本地 ComfyUI provider。 |
| `comfyui.baseUrl` | `http://127.0.0.1:8188` | ComfyUI 的 HTTP 地址。 |
| `comfyui.pollMs` | `2000` | 同一任务两次历史轮询之间的最短间隔。 |
| `comfyui.timeoutMs` | `3600000` | 从提交开始计算的失败期限。 |
| `comfyui.outputPrefix` | `dsh` | 服务端写入的输出子目录。 |
| `comfyui.video.model` | `wan2.2-ti2v-5b` | 暴露给调用方的视频模型 id。 |
| `comfyui.video.workflowPath` | 空 | API 格式工作流文件；空则使用随包的 Wan 2.2 图。 |
| `comfyui.video.checkpoint` | `wan2.2_ti2v_5B_fp16.safetensors` | `models/diffusion_models` 下的 UNET 文件名。 |
| `comfyui.video.textEncoder` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders` 下的文本编码器。 |
| `comfyui.video.vae` | `wan2.2_vae.safetensors` | `models/vae` 下的 VAE。 |
| `comfyui.video.resolution` | `480p` | 画布短边，形如 `<n>p`。 |
| `comfyui.video.fps` | `24` | 输出帧率。 |
| `comfyui.video.defaultDurationSec` | `5` | 请求未给时长时使用的时长。 |
| `comfyui.video.maxDurationSec` | `10` | 允许的最长请求时长。 |
| `comfyui.video.negativePrompt` | 质量与文字类词 | 请求未给负向提示时使用的内容。 |
| `comfyui.image.model` | `z-image-turbo` | 暴露给调用方的图像模型 id。 |
| `comfyui.image.workflowPath` | 空 | API 格式工作流文件；空则使用随包的 Z-Image 图。 |
| `comfyui.image.checkpoint` | `z_image_turbo_bf16.safetensors` | `models/diffusion_models` 下的 UNET 文件名。 |
| `comfyui.image.textEncoder` | `qwen_3_4b.safetensors` | `models/text_encoders` 下的文本编码器。 |
| `comfyui.image.vae` | `ae.safetensors` | `models/vae` 下的 VAE。 |
| `comfyui.image.size` | `1024` | 生成图像的长边。 |
| `minimax.enabled` | `false` | 挂载 MiniMax 云端视频 provider。 |
| `minimax.apiKey` | 空 | 供程序化配置使用的直接 Bearer 密钥。 |
| `minimax.apiKeyEnv` | 空 | 每次请求都通过 `ctx.credentials` 解析的凭据引用；随包预设使用 `MINIMAX_API_KEY`。 |
| `minimax.baseUrl` | `https://api.minimax.cn` | MiniMax API 地址。 |
| `minimax.pollMs` | `10000` | 同一任务两次状态轮询之间的最短间隔。 |
| `minimax.timeoutMs` | `3600000` | 从提交开始计算的失败期限。 |
| `minimax.model` | `MiniMax-H3` | 暴露并提交的视频模型 id。 |
| `minimax.resolution` | `768P` | `768P` 或 `2K`。 |
| `minimax.defaultDurationSec` | `5` | 请求未给时长时使用的时长。 |
| `minimax.maxDurationSec` | `15` | 允许的最长请求时长。 |
| `minimax.aspectRatio` | `9:16` | 文生视频未指定比例时使用的画幅。 |
| `minimax.speech.enabled` | `false` | 注册 MiniMax 语音 provider。 |
| `minimax.speech.model` | `speech-2.8-turbo` | 语音模型 id；`speech-2.8-hd` 价格更高、音质更好。 |
| `minimax.speech.voiceId` | `Chinese (Mandarin)_News_Anchor` | 默认系统音色；单次请求可覆盖。 |
| `minimax.speech.speed` | `1` | 语速，范围 `[0.5, 2]`。 |
| `minimax.speech.vol` | `1` | 音量，范围 `(0, 10]`。 |
| `minimax.speech.pitch` | `0` | 音调偏移，范围 `[-12, 12]`。 |
| `minimax.speech.emotion` | 空 | 固定情绪标签；留空由模型按文本推断。 |
| `siliconflow.enabled` | `false` | 注册 SiliconFlow 云端视频 provider。 |
| `siliconflow.apiKey` | 空 | 用于程序化配置的直接 bearer 密钥。 |
| `siliconflow.apiKeyEnv` | 空 | 每次请求经 `ctx.credentials` 解析的凭据引用；随包预设使用 `SILICONFLOW_API_KEY`。 |
| `siliconflow.baseUrl` | `https://api.siliconflow.cn/v1` | SiliconFlow API 源，包含 `/v1`。 |
| `siliconflow.pollMs` | `10000` | 同一任务两次状态轮询的最小间隔。 |
| `siliconflow.timeoutMs` | `3600000` | 从提交起算的失败期限。 |
| `siliconflow.model` | `Wan-AI/Wan2.2-I2V-A14B` | 暴露并提交的图生视频模型 id。 |
| `siliconflow.aspectRatio` | `9:16` | 请求未指定时使用的比例；`16:9`、`9:16` 或 `1:1`。 |
| `siliconflow.pricePerVideo` | `2` | 每条成片的价格，主币种单位。 |
| `siliconflow.currency` | `CNY` | 按条计价的币种；国际站用 `USD` 配 `0.29`。 |

一次完整镜头循环：

```text
video_project init { title: "One Shot", budget_cny: 50 }
media generate { kind: "video", prompt: "a door opens", duration_sec: 4, output_path: "shots/s01.mp4" }
video_project upsert_shot { shot: { id: "s01", index: 1, prompt: "a door opens", duration_sec: 4, status: "ready", clip_path: "shots/s01.mp4" } }
video_assemble { edl: { version: 1, canvas: { width: 320, height: 568, fps: 30 }, clips: [{ kind: "video", source: "shots/s01.mp4", outSec: 1 }], output: "out/ep01.mp4" } }
video_deliver { files: [{ path: "out/ep01.mp4", format: "video" }] }
```

<a id="understand-the-implementation"></a>
## 实现说明

媒体运行时是注册为 `ctx.media` 的 Cordis 服务。provider 通过 `register()` 注册；返回的 disposer 在 fiber 卸载时移除它。选择时先读取请求 capability 的默认模型，再只接受 `models()` 中声明了该 id 与 capability 的 provider。运行时负责任务保留与有界等待，provider 负责传输、取消与计费。已记为取消的任务在之后的轮询结束时仍保持取消。轮询未在剩余 `waitMs` 内结束时，等待返回运行中的任务，并且不采用这次轮询的结果。合成 provider 在提交时结算；ComfyUI provider 返回 `submitted`，再通过 `poll` 结算。

ComfyUI provider 用提示词、种子、画布、帧数与模型文件名填充工作流中的 `{{name}}` 占位符。整串占位符保留 JSON 类型，因此 `width`、`length`、`seed` 以整数送达。`first_frame_path` 参考会经 `/upload/image` 上传，新增 `LoadImage` 节点，并把输出接到 Wan latent 节点的 `start_image`。`submit` 向 `/prompt` 提交，`poll` 读取 `/history/<id>`，必要时回落到 `/queue` 判断 running 或 queued；完成条目经 `/view` 下载为产物字节。`cancel` 删除排队任务并中断运行中任务。提交超过 `timeoutMs` 的任务以 `MEDIA_TASK_TIMEOUT` 失败。

随包 Wan 工作流把无分类器引导固定为 1。在 Apple MPS 上，CFG>1 的批量分支会让解码后的颜色失真（构图仍在）；CFG 1 保持颜色正常、使负向提示失效，但本地片段在数秒内仍会出现拖影与漂移。CUDA 部署可通过 `comfyui.video.workflowPath` 挂载自己的 CFG 5 工作流。

MiniMax provider 发送 `content` 数组：一个 text 项，随后零个或多个 `image_url` 项。首帧或尾帧参考会把 `ratio` 设为 `adaptive`；纯文本请求使用配置的画幅。`submit` 返回 `submitted`，运行时任务 id 带远端 `task_id` 前缀；`poll` 读取查询接口并按 `pollMs` 节流；成功任务先下载 `content.url`，再交给运行时写入。API 没有负向提示字段，因此负向提示会以 `Avoid:` 句式追加到正向提示后。provider 限制图片 30 MB、参考图 9 张、提示词 7000 字符，单次请求体（含 base64 图片）为 64 MiB。

SiliconFlow provider 提交 `model`、`prompt`、`image_size`，并把首帧 `image` 作为 data URI 发送；`negative_prompt` 与 `seed` 使用各自的字段。画幅比例决定 `1280x720`、`720x1280` 或 `960x960`，本地任务 id 带远端 `requestId` 前缀。`poll` 把 id 发到 `/video/status`，映射 `InQueue`、`InProgress`、`Succeed` 与 `Failed`；成功任务先下载 `results.videos[0].url`，再交给运行时写入。图片上限 10 MB，提示词上限 7000 字符。provider 校验模型 id，拒绝“恰好一张首帧图”之外的参考组合，并拒绝 5 秒以外的时长，而不是静默截短片长。

MiniMax 语音 provider 以 `stream: false` 提交 `text`，并在同一次调用内结算。它把 `data.audio` 从 hex 解码，读取 `extra_info.audio_length` 作为毫秒时长、`extra_info.usage_characters` 作为计费字符数，并按公布的每万字符价格计算成本。一个汉字按两个计费字符计算；`billingCharsOf` 对预估应用同一规则。`base_resp` 中的业务错误会映射为 provider 不可用、预算超限或任务失败码；非法 hex 会在字节写入工作区之前以无效产物失败。

带 `subtitles: true` 的语音请求会以 `subtitle_type: word` 打开 `subtitle_enable`，下载签名后的 `data.subtitle_file`，并把逐字时间戳分组为字幕行：句末标点结束一行，逗号在整行达到 12 个字符后结束一行，整行达到 13 个字符时在当前词处分行。`media` 工具把这些行格式化为 SubRip，写在音频旁边，因此 `voice/s01-01.mp3` 会得到 `voice/s01-01.srt`。时间戳文件缺失、不可读、超大或格式错误时，任务以 `MEDIA_ARTIFACT_INVALID` 失败，不会在不带字幕的情况下结算音频。

项目文档使用严格 schema（`schemaVersion: 1`），包含标题、画幅、目标时长、预算、镜头与成片。`video_project` 读取文档、应用一次修改、校验完整结果，再通过 `ctx.fs.writeText` 原子写入。修改按项目路径取进程内锁，并且只在文件仍与读取时的文本一致时发布；其他进程的并发改写最多重试三次，随后以 `MEDIA_PROJECT_CONFLICT` 失败。

`media` 工具把每个未终结的生成任务记入 `video/<id>/tasks.json`：任务 id、provider、模型、提交时间、恢复所需的请求字段，以及声明的输出路径。带 `project_path` 的 `media status` 在运行时不再持有该任务时找到记录，让 provider 通过 `resume` 重建待轮询状态并继续轮询；任务结算后删除记录。每次以人民币计价的结算都按任务 id 追加一条到 `video/<id>/budget.json`，因此重复调用 status 不会重复计费。预算门与 `video_deliver` 取已记录镜头成本与账本总额中的较大者。

EDL 是可复现的渲染契约。`buildFfmpegArgs` 生成一张滤镜图：每个视觉片段裁切、等比补边到画布、重采样到画布帧率并拼接；可选音频片段裁切、增益并混音；字幕按安全区样式烧录；输出 H.264/AAC 并带 `+faststart`。汇编器先通过 `ctx.fs` 发布空输出占位文件，让父目录在同一写入策略下存在。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到四个工具。`media` 带一个 action 判别字段与共享的 kind/model/prompt/output 词汇；`video_project` 带项目 action 与镜头/成片对象；`video_assemble` 接受完整 EDL 对象；`video_deliver` 接受带格式标记的文件与项目路径。准确的描述与参数见生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-video-mode)。

#### Token 影响

每次请求有四个固定工具定义，外加模型实际调用产生的结果文本。项目摘要紧凑；`read` 返回完整 JSON，面向恢复而不是日常回合。

#### KV Cache 影响

在工具集合与描述不变时前缀稳定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **云端 provider 只服务视频** —— MiniMax-H3 与 SiliconFlow Wan2.2 返回 MP4 片段；关键帧仍来自 ComfyUI 或其他图像 provider。`MiniMax-H3-Highspeed`、`MiniMax-H3-Lite` 与 `MiniMax-H3-Max` 暂不可选，provider 只接受 `MiniMax-H3`；SiliconFlow 只服务 `Wan-AI/Wan2.2-I2V-A14B`。
- **MiniMax 按生成秒数计费** —— 5 秒 768P 片段为 2.50 元，5 秒 2K 片段为 4.00 元，尚未计入图片超额。估算对请求时长是精确的；失败任务不会在任务记录中退款。
- **SiliconFlow 按条计费且时长固定** —— Wan2.2-I2V-A14B 固定返回 5 秒，`media generate` 必须省略 `duration_sec` 或传 `5`；估算与镜头计划无关，只取配置的单条价格（2.00 元或 0.29 美元），由 EDL 把片段裁到计划时长。服务会把输出对齐到模型网格（实测 9:16 首帧得到 736×1280，16:9 首帧得到 1184×768）；EDL 会归一化画布。公开 API 没有取消接口：`media cancel` 只停止本地轮询，远端任务仍可能完成并计费。
- **空白首帧会被无原因拒绝** —— 首帧没有可见结构时（包括纯色测试图），SiliconFlow 返回 `Failed` 且 `reason` 为空。provider 会报告原始状态体并指向图片。请使用细节丰富的关键帧；只要画面有结构，PNG 与 JPEG 的 data URI 都可以工作。
- **非人民币估算需要显式确认** —— 项目预算与确认阈值以人民币计价。国际站 SiliconFlow 的美元价格无法与二者比较，因此 `media generate` 要求 `confirm_cost: true` 并原样报告美元估算；账本只登记人民币结算。
- **ComfyUI 工作流接收提示词与一张首帧** —— `media generate` 传 `first_frame_path` 时上传该图并从它开始生成；不传时随包 Wan 图从噪声开始。首尾帧条件、风格参考与角色参考需要部署自有工作流。
- **字幕换行由标点决定** —— 语音 provider 按句末标点、逗号与 13 字符预算（保证烧录字幕不超出 720 像素宽的竖屏画面）对词级时间戳分组，长句会在固定宽度处分行，而非编辑器指定的位置。需要在别处分行时直接调整 SRT；手工编辑的行超过 13 个汉字时，在 720 像素宽的竖屏画面上可能被裁切。
- **随包 Wan 工作流忽略负向提示** —— 它使用 CFG 1，因为在 Apple MPS 上 CFG>1 的批量分支会让颜色失真。硬件与运行时能正确解码 CFG 5 时，可用自定义工作流恢复负向分支。
- **本地 Wan 片段只作草稿** —— 通过 `first_frame_path` 的首帧片段能避开 CFG>1 的颜色失真，但实测在 Apple MPS 上 480p 片段数秒内仍会出现拖影与漂移，CFG 5 则直接破坏颜色。生产片段用 MiniMax-H3，本地 Wan 用于草稿和链路验证。视频模式 persona 与 `video-generate` 技能仍要求先出关键帧。
- **本地生成时间随分辨率与时长增长** —— Apple 芯片笔记本 480p 每条片段需数分钟，720p 更久；`comfyui.timeoutMs` 限制等待，`comfyui.video.resolution` 用于在质量与周转间取舍。
- **每种能力一个工作流** —— `comfyui.video.workflowPath` 整体替换随包图；两个视频后端需要在不同 id 下挂两行 provider。
- **任务日志依赖 `project_path`** —— 只有调用里带项目路径时，`media generate` 与 `media status` 才会写日志并恢复。不带路径的生成只留在内存；合成 provider 在提交时即结算，无需日志。日志与账本是项目旁的 JSON 文件，不是 storage 服务；第二个 Host 写入同一项目时不协调。
- **没有转写、MV 与切片流水线** —— 第一切片覆盖生成式图像/视频/语音与 ffmpeg 合成。词级转写、节拍网格、源视频导入与 9:16 重构已规划。
- **Web 工作台只读** —— `视频` 标签（`dsh-client-ui-video-studio`）从落定的 `video_project` 结果发现项目，展示分镜、成片、进行中任务与账本，并通过 `/api/file` 的 Range 响应预览关键帧、片段与成片。编辑仍由工具完成；在工具之外修改的项目需要点击标签内的刷新；结果元数据出现之前记录的会话不显示项目。
- **Provider 必须先下载 URL 再结算** —— 产物写入路径只接受字节。MiniMax、SiliconFlow 与 ComfyUI 会自行下载签名输出 URL；新增 provider 必须遵循同一约定。
- **合成 MP4 只有一秒** —— 使用它的更长 EDL 会停最后一帧或提前结束；合成 provider 用于打通链路，不用于时长测试。
- **ffmpeg 是 Host 前置条件** —— 可执行文件无法解析时，汇编器以 `MEDIA_FFMPEG_MISSING` 失败。烧录中文字幕需要 libass 与 CJK 字体。
- **预算门取两份记录中的较大者** —— `media generate` 用估算值与 `project.budgetCny` 减去“`video_project` 记录的镜头成本”与“媒体账本”中的较大者比较。忘记回写不会少算，手工调低镜头成本也不能把门限降到账本已计费额度以下。
- **预算门不是预留额度** —— 两个生成在任一结算前同时启动时，会读到同一份账本，因此并发提交可能超支；预算紧张时逐个执行。
- **取消之后保持取消** —— `cancel` 之后才结束的轮询不会替换已取消的任务。
- **单次轮询受 `waitMs` 限制** —— 轮询未在剩余等待时间内结束时，`generate` 返回运行中的任务。之后的 `status` 会再次轮询。
- **跨进程项目写入仍可能竞争** —— 修改在同一 Host 内串行化，并且只在文件仍与读取时的文本一致时发布；但其他进程的写入若恰好落在此检查与写入之间，仍可能丢失。三次失败后报告 `MEDIA_PROJECT_CONFLICT`。
- **ffmpeg 运行在 Host 执行世界** —— 汇编器通过 `ctx.fs` 解析输出，但在其旁边运行二进制；远程文件系统 provider 需要匹配的 subprocess provider。
- **没有新的 Session 事件** —— 项目文件是事实源，工具调用与结果是审计面。如果文件不足，客户端投影随工作台一起加入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包在第一切片中有意保持为单个实验单元。等真实 provider 集合与 Web 工作台稳定后，provider 能力缝、项目文档与 EDL 将拆分到独立的 `media/` 与 `video/` 包。保持合成 provider 的确定性：测试与 keyless 快照依赖固定价格与固定字节。

`tests/minimax-speech.e2e.ts` 发起真实 T2A 请求，每次运行花费几分钱；缺少 `MINIMAX_API_KEY` 时自动跳过。运行命令：`pnpm run test:e2e packages/experimental/video-mode/tests/minimax-speech.e2e.ts`。

`tests/store.spec.ts` 负责日志与账本契约，工具测试通过销毁一个运行时、再由第二个运行时恢复来模拟重启。`tests/minimax-video.e2e.ts` 发起真实 H3 请求，每个用例计费 2.00 元，四秒片段约需十二分钟；缺少 `MINIMAX_API_KEY` 时自动跳过，且账号需要有余额。运行命令：`pnpm run test:e2e packages/experimental/video-mode/tests/minimax-video.e2e.ts`。

`tests/siliconflow-video.e2e.ts` 从生成的首帧发起一次真实 Wan2.2 图生视频请求；国内站计费 2.00 元，片段固定 5 秒。缺少 `SILICONFLOW_API_KEY` 时自动跳过，且账号需要有余额。运行命令：`pnpm run test:e2e packages/experimental/video-mode/tests/siliconflow-video.e2e.ts`。

</details>
