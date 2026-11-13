---
description: "Experimental video production mode: a media provider seam, a durable project document, a reproducible EDL rendered by ffmpeg, four model-facing tools, a deterministic synthetic provider, a local ComfyUI provider for Wan 2.2 video and Z-Image images, and cloud MiniMax-H3, MiniMax speech, and SiliconFlow Wan2.2 providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-video-mode

English | [中文](README.zh.md)

## Summary

This package is the first host slice of the video mode. It provides `ctx.media`, a provider registry for image, video, and speech generation, a durable project document under `video/<id>/project.json` with a task journal and budget ledger, a validated edit decision list (EDL) rendered by ffmpeg, and four model-facing tools: `media`, `video_project`, `video_assemble`, and `video_deliver`. Five providers ship: a deterministic synthetic provider for credential-free runs, a local ComfyUI provider for Wan 2.2 video and Z-Image keyframes, and cloud MiniMax-H3 video, MiniMax speech, and SiliconFlow Wan2.2 image-to-video providers.

## Table of Contents

- [What it mounts](#what-it-mounts)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-mounts"></a>
## What it mounts

- **`ctx.media`** — a provider registry and one execution path per capability. It selects a provider by configured default model or by an explicit `model`, resolves the model at execution time, rejects unavailable and ambiguous selections with stable `MediaFailure` codes, retains a bounded number of task records, journals in-flight tasks beside the project so a restart can resume them, and waits up to `waitMs` for settlement.
- **The `media` tool** — one action-discriminated tool (`models`, `estimate`, `generate`, `status`, `cancel`) that lists models and prices, previews cost, submits a generation, writes the artifact through `ctx.fs`, reads or cancels a task, and with `project_path` recovers a journaled task after a restart.
- **The `video_project` tool** — creates, reads, and mutates the project document. Every mutation validates the complete document before writing it; the project file is the single source of truth for shots, selected clips, renders, and the budget. Mutations are serialized per project inside the host and retried when the file changed underneath them.
- **The `video_assemble` tool** — validates an EDL, renders it through ffmpeg with a normalized filter graph (canvas, fps, aspect-fit padding, concat, audio mix, subtitle burn-in, faststart), and returns measured duration, resolution, and audio presence.
- **The `video_deliver` tool** — declares final files and returns machine checks. It refuses a missing video, an incomplete shot list, a video without a readable stream, and a reported cost above the budget; it warns on a duration mismatch and a missing audio stream.
- **The synthetic provider** — deterministic PNG, WAV, and MP4 fixtures with fixed prices. It is enabled by `fakeProvider: true`.
- **The ComfyUI provider** — submits an API-format workflow to a local ComfyUI server, polls its history, downloads the produced file, and settles the task with inline bytes. The bundled graphs render Wan 2.2 TI2V-5B video and Z-Image Turbo images; `comfyui.video.workflowPath` and `comfyui.image.workflowPath` accept a deployment's own workflow. Local compute has no per-generation charge, so every estimate reports zero CNY.
- **The MiniMax provider** — submits one MiniMax-H3 video task to `https://api.minimax.cn/v2/video_generation`, polls `/v2/query/video_generation/<id>`, downloads the settled MP4, and settles with inline bytes. Text, first-frame, last-frame, and reference-image inputs are supported; local image files travel as data URIs. Estimates use the published CNY rates: 0.50 per generated second at 768P and 0.80 at 2K.
- **The SiliconFlow provider** — submits one Wan2.2 image-to-video job to `https://api.siliconflow.cn/v1/video/submit` with a first-frame image as a data URI, polls `/v1/video/status`, and downloads the settled MP4. `Wan-AI/Wan2.2-I2V-A14B` produces a fixed five-second clip at `1280x720`, `720x1280`, or `960x960`; the API has no duration field, so a request for another length is rejected. SiliconFlow bills per completed video: 2.00 CNY on the mainland site and 0.29 USD on the international site, both configurable because the API returns no price.
- **The MiniMax speech provider** — sends one synchronous text-to-audio request to `https://api.minimax.cn/v1/t2a_v2` and settles with inline MP3 bytes. It shares the parent `minimax` credential and origin, accepts any system voice per request, and defaults to `speech-2.8-turbo` with the `Chinese (Mandarin)_News_Anchor` voice. One Han character bills as two characters; the published rates are 2.00 CNY per 10,000 characters for `speech-2.8-turbo` and 3.50 for `speech-2.8-hd`. A request with `subtitles: true` also downloads MiniMax's word-level timing file and returns caption lines; `media generate` writes them as an `.srt` beside the audio.

<a id="use-this-package"></a>
## Use this package

Mount the service in a composition that also provides `ctx.tools`, `ctx.fs`, and `ctx.subprocess`:

```yaml
- id: video-mode
  name: '@deepseek-ai/dsh-video-mode'
  config:
    fakeProvider: true
    waitMs: 30000
    ffmpegPath: ffmpeg
    ffprobePath: ffprobe
```

The video preset renders keyframes locally and video in the cloud:

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

MiniMax prerequisites: a MiniMax API key stored through the credentials service or exported as `MINIMAX_API_KEY`, and H3 video access on the account or M Plan. The preset names the reference through `minimax.apiKeyEnv`; the provider resolves it on every request, so a rotated key applies without a restart. A missing key leaves the preset usable for ComfyUI work and makes a MiniMax request fail with the remedy to store or export `MINIMAX_API_KEY`; an unauthorized or unpaid key fails the first submission with the provider's message. MiniMax-H3 accepts 4–15 second clips at 768P or 2K; a first or last frame forces `ratio: adaptive`.

SiliconFlow prerequisites: a SiliconFlow API key stored through the credentials service or exported as `SILICONFLOW_API_KEY`. The preset names the reference through `siliconflow.apiKeyEnv`; a missing key reports the same style of remedy, and the provider registers as unavailable so another video backend still serves the request. The account needs access to `Wan-AI/Wan2.2-I2V-A14B`. The model accepts one first-frame image and produces five seconds of silent video; generate the keyframe with ComfyUI or the image provider first. The mainland site bills 2.00 CNY per completed video and the international site 0.29 USD; set `siliconflow.pricePerVideo` and `siliconflow.currency` to the site that issued the key. The public API has no cancellation endpoint, so `media cancel` stops local polling while a remote job may still finish and bill.

The speech provider uses the same key and origin. The account needs text-to-audio access; without it the first speech request fails with the provider's message. Speech requests are synchronous and accept up to 10,000 characters, so a long narration is split by sentence or shot. A missing key reports the same remedy as video, and the preset still boots for image and video work.

ComfyUI prerequisites for keyframes: ComfyUI 0.38 or newer reachable at `comfyui.baseUrl`, with Z-Image Turbo, the `qwen_3_4b` text encoder, and `ae.safetensors` under `models/`. The Wan 2.2 files remain optional for deployments that select `wan2.2-ti2v-5b` explicitly. Any missing file fails at the first submission with ComfyUI's node error, and a wrong file name in the config fails the same way.

| Field | Default | Meaning |
|---|---|---|
| `fakeProvider` | `true` | Mount the synthetic provider. Set false when a real provider is mounted. |
| `imageModel` | `synthetic/image` | Default image model id. |
| `videoModel` | `synthetic/video` | Default video model id. |
| `speechModel` | `synthetic/speech` | Default speech model id; the video preset sets `speech-2.8-turbo`. |
| `waitMs` | `30000` | How long `media generate` waits before returning a running task id. |
| `pollMs` | `250` | Poll interval while waiting. |
| `maxArtifactBytes` | `536870912` | Largest accepted artifact size. |
| `maxTasks` | `64` | Retained task records. |
| `ffmpegPath` | `ffmpeg` | ffmpeg executable name or path. |
| `ffprobePath` | `ffprobe` | ffprobe executable name or path. |
| `syntheticLatencyMs` | `0` | Synthetic provider delay before settlement. |
| `subtitleFont` | empty | Font family for burned subtitles; empty uses ffmpeg's default. |
| `approvalThresholdCny` | `10` | A generation whose estimate exceeds this requires `confirm_cost` and a user confirmation. |
| `comfyui.enabled` | `false` | Register the local ComfyUI provider. |
| `comfyui.baseUrl` | `http://127.0.0.1:8188` | ComfyUI HTTP origin. |
| `comfyui.pollMs` | `2000` | Minimum gap between two history polls for one task. |
| `comfyui.timeoutMs` | `3600000` | Failure deadline measured from submission. |
| `comfyui.outputPrefix` | `dsh` | Output subdirectory the server writes into. |
| `comfyui.video.model` | `wan2.2-ti2v-5b` | Video model id reported to consumers. |
| `comfyui.video.workflowPath` | empty | API-format workflow file; empty uses the bundled Wan 2.2 graph. |
| `comfyui.video.checkpoint` | `wan2.2_ti2v_5B_fp16.safetensors` | UNET file under `models/diffusion_models`. |
| `comfyui.video.textEncoder` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | Text encoder under `models/text_encoders`. |
| `comfyui.video.vae` | `wan2.2_vae.safetensors` | VAE under `models/vae`. |
| `comfyui.video.resolution` | `480p` | Canvas short side as a `<n>p` label. |
| `comfyui.video.fps` | `24` | Output frame rate. |
| `comfyui.video.defaultDurationSec` | `5` | Duration used when the request omits one. |
| `comfyui.video.maxDurationSec` | `10` | Longest accepted request duration. |
| `comfyui.video.negativePrompt` | quality and text terms | Negative prompt used when the request omits one. |
| `comfyui.image.model` | `z-image-turbo` | Image model id reported to consumers. |
| `comfyui.image.workflowPath` | empty | API-format workflow file; empty uses the bundled Z-Image graph. |
| `comfyui.image.checkpoint` | `z_image_turbo_bf16.safetensors` | UNET file under `models/diffusion_models`. |
| `comfyui.image.textEncoder` | `qwen_3_4b.safetensors` | Text encoder under `models/text_encoders`. |
| `comfyui.image.vae` | `ae.safetensors` | VAE under `models/vae`. |
| `comfyui.image.size` | `1024` | Long side of a generated image. |
| `minimax.enabled` | `false` | Register the MiniMax cloud video provider. |
| `minimax.apiKey` | empty | Direct bearer API key for programmatic configuration. |
| `minimax.apiKeyEnv` | empty | Credential reference resolved through `ctx.credentials` on every request; the shipped preset uses `MINIMAX_API_KEY`. |
| `minimax.baseUrl` | `https://api.minimax.cn` | MiniMax API origin. |
| `minimax.pollMs` | `10000` | Minimum gap between two status polls for one task. |
| `minimax.timeoutMs` | `3600000` | Failure deadline measured from submission. |
| `minimax.model` | `MiniMax-H3` | Video model id reported and submitted. |
| `minimax.resolution` | `768P` | `768P` or `2K`. |
| `minimax.defaultDurationSec` | `5` | Duration used when the request omits one. |
| `minimax.maxDurationSec` | `15` | Longest accepted request duration. |
| `minimax.aspectRatio` | `9:16` | Text-to-video ratio when the request omits one. |
| `minimax.speech.enabled` | `false` | Register the MiniMax speech provider. |
| `minimax.speech.model` | `speech-2.8-turbo` | Speech model id; `speech-2.8-hd` costs more and renders higher quality. |
| `minimax.speech.voiceId` | `Chinese (Mandarin)_News_Anchor` | Default system voice; a request may override it. |
| `minimax.speech.speed` | `1` | Speech speed in `[0.5, 2]`. |
| `minimax.speech.vol` | `1` | Volume in `(0, 10]`. |
| `minimax.speech.pitch` | `0` | Pitch offset in `[-12, 12]`. |
| `minimax.speech.emotion` | empty | Fixed emotion label; empty lets the model infer it. |
| `siliconflow.enabled` | `false` | Register the SiliconFlow cloud video provider. |
| `siliconflow.apiKey` | empty | Direct bearer API key for programmatic configuration. |
| `siliconflow.apiKeyEnv` | empty | Credential reference resolved through `ctx.credentials` on every request; the shipped preset uses `SILICONFLOW_API_KEY`. |
| `siliconflow.baseUrl` | `https://api.siliconflow.cn/v1` | SiliconFlow API origin, including `/v1`. |
| `siliconflow.pollMs` | `10000` | Minimum gap between two status polls for one task. |
| `siliconflow.timeoutMs` | `3600000` | Failure deadline measured from submission. |
| `siliconflow.model` | `Wan-AI/Wan2.2-I2V-A14B` | Image-to-video model id reported and submitted. |
| `siliconflow.aspectRatio` | `9:16` | Ratio used when the request omits one; `16:9`, `9:16`, or `1:1`. |
| `siliconflow.pricePerVideo` | `2` | Price of one completed video in major currency units. |
| `siliconflow.currency` | `CNY` | Currency of the per-video price; use `USD` with `0.29` on the international site. |

A complete shot cycle:

```text
video_project init { title: "One Shot", budget_cny: 50 }
media generate { kind: "video", prompt: "a door opens", duration_sec: 4, output_path: "shots/s01.mp4" }
video_project upsert_shot { shot: { id: "s01", index: 1, prompt: "a door opens", duration_sec: 4, status: "ready", clip_path: "shots/s01.mp4" } }
video_assemble { edl: { version: 1, canvas: { width: 320, height: 568, fps: 30 }, clips: [{ kind: "video", source: "shots/s01.mp4", outSec: 1 }], output: "out/ep01.mp4" } }
video_deliver { files: [{ path: "out/ep01.mp4", format: "video" }] }
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The media runtime is a Cordis service registered as `ctx.media`. Providers register with `register()`; the returned disposer removes the provider on fiber unload. Selection reads the configured default model for the requested kind, then accepts only a provider whose `models()` advertises that id and capability. The runtime owns task retention and the bounded wait, while each provider owns transport, cancellation, and cost accounting. A task recorded as cancelled stays cancelled when a later poll settles. When a poll does not settle within the remaining `waitMs`, the wait returns the running task and does not apply that poll. The synthetic provider settles during submission; the ComfyUI provider returns `submitted` and settles through `poll`.

The ComfyUI provider fills the workflow's `{{name}}` placeholders with the prompt, seed, canvas, frame count, and model file names. A placeholder that occupies a whole string keeps its JSON type, so `width`, `length`, and `seed` arrive as integers. A `first_frame_path` reference is uploaded to `/upload/image`, a `LoadImage` node is added, and its output is wired to the Wan latent node's `start_image`. `submit` posts to `/prompt`, `poll` reads `/history/<id>` and falls back to `/queue` for the running or queued state, and a completed entry downloads its file through `/view` into artifact bytes. `cancel` deletes a queued prompt and interrupts a running one. A submission older than `timeoutMs` fails with `MEDIA_TASK_TIMEOUT`.

The bundled Wan graph runs classifier-free guidance at 1. On Apple MPS the CFG>1 batch corrupts the decoded colors while the composition survives; CFG 1 keeps the colors intact, makes the negative prompt inert, and still leaves local clips prone to smearing and drift within a few seconds. A CUDA deployment can mount its own workflow with CFG 5 through `comfyui.video.workflowPath`.

The MiniMax provider sends a `content` array: one text item, then zero or more `image_url` items. A first-frame or last-frame reference sets `ratio: adaptive`; a text-only request uses the configured ratio. `submit` returns `submitted` with a runtime id prefixed by the remote `task_id`, `poll` reads the query endpoint and throttles to `pollMs`, and a succeeded task downloads `content.url` before the runtime writes it. A negative prompt has no API field, so it is appended to the positive prompt as an `Avoid:` sentence. The provider caps image files at 30 MB, references at nine, prompts at 7000 characters, and one request body at 64 MiB including base64 images.

The SiliconFlow provider posts `model`, `prompt`, `image_size`, and the first-frame `image` as a data URI; `negative_prompt` and `seed` travel in their own fields. The aspect ratio selects `1280x720`, `720x1280`, or `960x960`, and the local task id is prefixed with the remote `requestId`. `poll` posts the id to `/video/status` and maps `InQueue`, `InProgress`, `Succeed`, and `Failed`; a succeeded task downloads `results.videos[0].url` before the runtime writes it. Image files are capped at 10 MB and prompts at 7000 characters. The provider validates the model id, rejects any reference set other than one first-frame image, and rejects a duration other than the fixed five seconds instead of silently shortening the clip.

The MiniMax speech provider posts `text` with `stream: false` and settles in the same call. It decodes `data.audio` from hex, reads `extra_info.audio_length` as milliseconds and `extra_info.usage_characters` as the billed character count, and prices the task from the published per-10,000-character rate. One Han character counts as two billing characters; `billingCharsOf` applies the same rule to an estimate. A business error in `base_resp` maps to a provider-unavailable, budget-exceeded, or task-failed code, and malformed hex fails as an invalid artifact before any bytes reach the workspace.

A `subtitles: true` speech request sets `subtitle_enable` with `subtitle_type: word`, downloads the signed `data.subtitle_file`, and groups the per-character timings into caption lines: a sentence terminator closes a line, a clause comma closes one at 12 characters or more, and a line reaching 13 characters breaks at the current token. The `media` tool formats those lines as SubRip and writes them beside the audio, so `voice/s01-01.mp3` gains `voice/s01-01.srt`. A missing, unreadable, oversized, or malformed timing file fails the task with `MEDIA_ARTIFACT_INVALID` rather than settling audio without captions.

The project document has a strict schema (`schemaVersion: 1`) with title, aspect, target duration, budget, shots, and renders. `video_project` reads the document, applies one mutation, validates the whole result, and writes it atomically through `ctx.fs.writeText`. Mutations take an in-process lock per project path and publish only when the file still matches the text they mutated; a concurrent rewrite from another process is retried up to three times, then fails with `MEDIA_PROJECT_CONFLICT`.

The `media` tool journals every non-terminal generation in `video/<id>/tasks.json`: task id, provider, model, submission time, the request fields a provider needs to resume, and the declared output path. `media status` with `project_path` finds a record the runtime no longer holds, asks the provider to rebuild its pending state through `resume`, and continues polling; a settled task removes its record. Every settlement priced in CNY appends one charge to `video/<id>/budget.json`, keyed by task id, so a repeated status call cannot double-charge. The budget gate and `video_deliver` take the larger of the recorded shot costs and the ledger total.

The EDL is the reproducible render contract. `buildFfmpegArgs` emits one filter graph: every visual clip is trimmed, aspect-fit padded to the canvas, resampled to the canvas fps, and concatenated; optional audio clips are trimmed, gained, and mixed; subtitles are burned with a style that keeps text inside a safe area; the output is H.264/AAC with `+faststart`. The assembler publishes an empty output placeholder through `ctx.fs` so the parent directory exists under the same write policy.

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees four tools. `media` carries one action discriminator and the shared kind/model/prompt/output vocabulary; `video_project` carries the project actions and the shot/render objects; `video_assemble` accepts the complete EDL object; `video_deliver` accepts files with a format tag and the project path. The exact descriptions and parameters are in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-video-mode).

#### Token effect

Four fixed tool definitions on every request, plus the result text of the calls the model makes. The project summary is compact; `read` returns the complete JSON and is intended for recovery, not routine turns.

#### KV Cache effect

Prefix-stable while the registered tool set and descriptions are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The cloud video providers serve video only** — MiniMax-H3 and SiliconFlow Wan2.2 return MP4 clips; keyframes still come from ComfyUI or another image provider. `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, and `MiniMax-H3-Max` are not selectable because the provider validates the configured model id, and SiliconFlow serves only `Wan-AI/Wan2.2-I2V-A14B`.
- **MiniMax bills per generated second** — a 5-second 768P clip costs 2.50 CNY and a 5-second 2K clip costs 4.00 CNY before any image overage. The estimate is exact for the requested duration; the provider does not refund a failed task in the task record.
- **SiliconFlow bills per completed video at a fixed length** — Wan2.2-I2V-A14B always returns five seconds, so `media generate` must omit `duration_sec` or pass `5`; the estimate is one configured price (2.00 CNY or 0.29 USD) regardless of the shot plan, and the EDL trims the clip to the planned duration. The service rounds the output to its model grid (observed 736×1280 for a 9:16 frame and 1184×768 for a 16:9 frame); the EDL normalizes the canvas. The public API has no cancellation endpoint: `media cancel` stops local polling, and the remote job may still finish and bill.
- **A blank first frame is rejected without a reason** — SiliconFlow returns `Failed` with an empty `reason` when the first-frame image carries no visible structure, including a solid-color test image. The provider reports the raw status body and points at the image. Use a detailed keyframe; PNG and JPEG data URIs both work once the image has structure.
- **A non-CNY estimate needs explicit confirmation** — the project budget and confirmation threshold are denominated in CNY. An international SiliconFlow price in USD cannot be compared with them, so `media generate` requires `confirm_cost: true` and reports the USD estimate; the ledger records only CNY settlements.
- **The ComfyUI workflows take a prompt and one first frame** — `media generate` with `first_frame_path` uploads that image and starts the clip from it; without one the bundled Wan graph starts from noise. First-last-frame conditioning, style references, and character references need a deployment workflow.
- **Caption line breaks follow punctuation** — the speech provider groups word timestamps at sentence punctuation, clause commas, and a 13-character budget sized to keep a burned line inside a 720-pixel-wide vertical frame, so a long sentence breaks at a fixed width rather than at an editor's chosen point. Adjust the SRT when a line must break elsewhere; a hand-edited line longer than 13 Han characters can clip at the edge of a 720-pixel-wide vertical frame.
- **The bundled Wan graph ignores the negative prompt** — it runs CFG 1 because the CFG>1 batch corrupts colors on Apple MPS. A workflow with CFG 5 restores the negative branch on hardware and runtimes that decode it correctly.
- **Local Wan clips are drafts** — a keyframe-first clip through `first_frame_path` avoids the CFG>1 color corruption, but measured 480p clips on Apple MPS still smear and drift within a few seconds; CFG 5 corrupts colors outright. Use MiniMax-H3 for production clips and local Wan for drafts and wiring checks. The video-mode persona and `video-generate` skill keep the keyframe step.
- **Local generation time grows with resolution and duration** — an Apple-silicon laptop at 480p takes minutes per clip and longer at 720p; `comfyui.timeoutMs` bounds the wait, and `comfyui.video.resolution` trades quality for turnaround.
- **One workflow per kind** — `comfyui.video.workflowPath` replaces the bundled graph wholesale; two video backends need two provider rows under separate ids.
- **The journal needs `project_path`** — `media generate` and `media status` only journal and recover when the call names the project. A generation without it stays memory-only, and the synthetic provider settles during submission so it needs no journal. The journal and ledger are JSON files beside the project, not the storage service; a second host writing the same project is not coordinated.
- **No transcript, MV, or clip-cutting pipeline** — the first slice covers generated image/video/speech and ffmpeg assembly. Word-level transcription, beat grids, source-video ingestion, and 9:16 reframing are planned.
- **The Web studio is read-only** — the `Video` tab (`dsh-client-ui-video-studio`) discovers projects from settled `video_project` results, shows shots, renders, pending tasks, and the ledger, and previews keyframes, clips, and renders through `/api/file` Range responses. Editing stays with the tools, a project edited outside them needs the tab's Refresh, and a session recorded before the result metadata existed shows no project.
- **Providers must download URLs before settling** — the artifact write path accepts bytes only. MiniMax, SiliconFlow, and ComfyUI fetch their own signed output URLs first; a new provider must do the same.
- **The synthetic MP4 is one second** — a longer EDL using it will hold the last frame or end early; use the synthetic provider for wiring, not for timing tests.
- **ffmpeg is a host prerequisite** — the assembler fails with `MEDIA_FFMPEG_MISSING` when the executable cannot be resolved. `libass` and a CJK font are required for burned Chinese subtitles.
- **The budget gate takes the larger of two records** — `media generate` compares its estimate with `project.budgetCny` minus the greater of the shot costs recorded by `video_project` and the media ledger. A forgotten write-back cannot under-count, and a manually lowered shot cost cannot lower the gate below what the ledger already charged.
- **The budget gate is not a reservation** — two generations started before either settles compare against the same ledger, so concurrent submissions can overspend; run them one at a time when the budget is tight.
- **Cancellation stays cancelled** — a poll that settles after `cancel` does not replace the cancelled task.
- **A poll is bounded by `waitMs`** — when the poll does not settle in the remaining wait, `generate` returns the running task. A later `status` polls again.
- **Cross-process project writes can still race** — mutations are serialized inside one host and published only when the file still matches the text they read, but a write from another process landing between that check and the write can still be lost. Three failed attempts report `MEDIA_PROJECT_CONFLICT`.
- **ffmpeg runs in the Host execution world** — the assembler resolves the output through `ctx.fs` but runs the binary beside it; a remote filesystem provider needs a matching subprocess provider.
- **No session event** — the project file is the source of truth; tool calls and results are the audit trail. A client projection will be added with the studio if the file proves insufficient.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package is intentionally one experimental unit for the first slice. The provider seam, project document, and EDL are designed for promotion into separate `media/` and `video/` packages once the real provider set and the Web studio stabilize. Keep the synthetic provider deterministic: tests and keyless snapshots depend on fixed prices and fixed bytes.

`tests/minimax-speech.e2e.ts` drives real T2A requests and spends a few fen per run; it self-skips without `MINIMAX_API_KEY`. Run it with `pnpm run test:e2e packages/experimental/video-mode/tests/minimax-speech.e2e.ts`.

`tests/store.spec.ts` owns the journal and ledger contract, and the tool suite simulates a restart by disposing one runtime and recovering through a second. `tests/minimax-video.e2e.ts` drives real H3 requests; each case bills 2.00 CNY and a four-second clip takes about twelve minutes. It self-skips without `MINIMAX_API_KEY` and needs a funded account. Run it with `pnpm run test:e2e packages/experimental/video-mode/tests/minimax-video.e2e.ts`.

`tests/siliconflow-video.e2e.ts` drives one real Wan2.2 image-to-video request from a generated first frame; it bills 2.00 CNY on the mainland site, and the clip is always five seconds. It self-skips without `SILICONFLOW_API_KEY` and needs a funded account. Run it with `pnpm run test:e2e packages/experimental/video-mode/tests/siliconflow-video.e2e.ts`.

</details>
