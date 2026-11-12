# Video agent preset

English | [中文](video.zh.md)

The `video` agent preset composes a video-production agent on the DeepSeek Harness. It builds on the `standard` preset, replaces the persona and plan-mode section with video-production ones, adds six production skills, and mounts the experimental video mode's four tools. The mode produces a project document, per-shot media, an EDL, and an assembled MP4 with an explicit delivery check.

## What it mounts

Beyond the standard coding rows a video workflow needs (shell, filesystem, jobs, schedules, skills, goals, plan mode, compaction, delegation, ask-user, todo, and web), the preset contributes:

- Six production skills in `skills/video/`: `video-brief` (specification), `video-storyboard` (shots and assets), `video-generate` (keyframe-first media), `video-voice` (voice, BGM, subtitles), `video-assemble` (EDL and ffmpeg), and `video-deliver` (machine checks and registration).
- One `video-mode` row from `@deepseek-ai/dsh-video-mode`. It provides `ctx.media`, the cloud MiniMax-H3 video provider, the cloud SiliconFlow Wan2.2 image-to-video provider, the cloud MiniMax speech provider, the local ComfyUI provider (Z-Image Turbo keyframes; Wan 2.2 remains selectable as `wan2.2-ti2v-5b`), and four model-facing tools: `media`, `video_project`, `video_assemble`, and `video_deliver`. In-flight tasks are journaled beside the project and every settlement priced in CNY is ledgered, so a restart can resume polling and the budget gate cannot under-count a forgotten cost write-back.
- A video-production persona (specification first, assets before shots, keyframes before clips, estimate before spending, machine checks before delivery) and a video-flavored plan-mode section: platform, duration, aspect, budget, script, storyboard, asset plan, and delivery list are "plans" — no paid generation or final render before approval.

Against the row set `standard` carries, this preset deliberately omits four rows — `tool-plugin-market`, `present`, `tool-plugin-manager`, and `openviking`. `tool-plugin-market` is read-only catalog browsing; installing a plugin is a deployment action. `present` declares an arbitrary accessible file as a deliverable; this mode declares its deliverables through `video_deliver`, which carries the machine checks the studio will render. `tool-plugin-manager` writes profile configuration and the host patch ships it disabled. `openviking` is opt-in external memory over an HTTP service this composition does not run.

## Prerequisites

- `ffmpeg` and `ffprobe` on the host. The assembler fails with `MEDIA_FFMPEG_MISSING` when either cannot be resolved. Burned Chinese subtitles need `libass` and a CJK font.
- A MiniMax API key with H3 video access, named by `minimax.apiKeyEnv` as `MINIMAX_API_KEY`, stored through the credentials service or exported in the launch environment. Without it the preset still boots and ComfyUI works; a MiniMax request reports how to store or export the key. An unauthorized or unpaid key fails the first video submission with the provider's message.
- A SiliconFlow API key with access to `Wan-AI/Wan2.2-I2V-A14B`, named by `siliconflow.apiKeyEnv` as `SILICONFLOW_API_KEY`, stored through the credentials service or exported in the launch environment. The model takes one first-frame image and returns a fixed five-second clip; the mainland site bills 2.00 CNY per video and the international site 0.29 USD. Without a key the preset still boots, the provider registers as unavailable, and other video backends still serve requests.
- Speech synthesis uses the same key and origin and needs text-to-audio access on the account. The provider defaults to `speech-2.8-turbo` at 2.00 CNY per 10,000 characters; `speech-2.8-hd` costs 3.50. A missing key fails the first speech request with the same remedy. Pass `subtitles: true` to `media generate` to receive an `.srt` sidecar with timings from MiniMax's word-level file.
- A local ComfyUI server (0.38 or newer) at `http://127.0.0.1:8188`, with Z-Image Turbo under `models/`. Keyframes come from this row. The Wan 2.2 TI2V-5B files are optional and used only when a caller selects `wan2.2-ti2v-5b` explicitly.
- The preset runs `fakeProvider: false`, so every artifact comes from MiniMax, SiliconFlow, or ComfyUI. For a credential-free demo, set `fakeProvider: true` and select a `synthetic/*` model; the synthetic provider produces one-second clips and fixed prices.

## Model Experience

The model sees the video-production persona, the video plan-mode section, the six preset skills, and the four video tools alongside the standard tools. The persona states the budget (50 CNY default), the 10 CNY single-generation confirmation threshold, the keyframe-first discipline, the machine-check rule, and the honest degradation rules (no vision model means "not reviewed"; no ffmpeg means "cannot assemble").

The tools carry the production vocabulary: `media` selects a model and writes an artifact, `video_project` owns the project document, `video_assemble` renders an EDL, and `video_deliver` checks the declared files and refuses incomplete or over-budget work.

## Known Limitations and Deferred Work

- **The Web studio is read-only** — the `Video` tab shows discovered projects, shots, renders, pending tasks, the ledger, and a media preview through the file route's Range responses. Editing and re-discovery after an outside change stay with the tools and the tab's Refresh gesture.
- **Cloud video is the default** — MiniMax-H3 serves video and bills per generated second (0.50 CNY at 768P, 0.80 at 2K). A 5-second 768P clip estimates at 2.50 CNY; clips above the 10 CNY confirmation threshold need user approval.
- **SiliconFlow is the cheap fixed-length path** — `Wan-AI/Wan2.2-I2V-A14B` returns five seconds at 2.00 CNY per video (0.29 USD on the international site), needs a first-frame image, and has no cancellation endpoint. Omit `duration_sec` or pass `5`; the EDL trims the clip to the shot plan. A USD price cannot be compared with the CNY budget, so `media generate` asks for `confirm_cost: true` and leaves the ledger untouched.
- **The bundled Wan graph runs CFG 1** — the CFG>1 batch corrupts colors on Apple MPS, so the negative prompt has no effect. A deployment on a compatible runtime mounts its own workflow with CFG 5.
- **Local Wan video is a draft path** — when a caller selects `wan2.2-ti2v-5b`, `video-generate` passes the shot keyframe as `first_frame_path`. Measured 480p clips on Apple MPS still smear and drift within a few seconds, and CFG 5 corrupts colors outright; use MiniMax-H3 or SiliconFlow for production clips. Both cloud providers accept a keyframe, and the skill still sends one for cross-shot consistency.
- **Caption line breaks follow punctuation** — the speech provider groups MiniMax word timestamps at sentence punctuation, clause commas, and a 13-character budget, so a long sentence breaks at a fixed width. Adjust the SRT when a line must break elsewhere.
- **No transcript, MV, or clip-cutting pipeline** — the preset's persona names those workflows, but word-level transcription, beat grids, source-video ingestion, and 9:16 reframing are planned; the assistant must say so when asked.
- **No digital-human lip sync** — talking-head work uses a host image, B-roll, and voice-over.
- **No automatic publishing** — delivery ends at files and a manifest; publishing stays with the user.
