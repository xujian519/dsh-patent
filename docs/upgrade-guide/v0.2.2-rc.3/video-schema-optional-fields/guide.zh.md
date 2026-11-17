---
kind: upgrade-guide
description: "已发布的视频项目与 EDL 类型里，可选字段现在包含 undefined，与 schema 的解析结果一致。"
---

# 视频项目与 EDL 的可选字段包含 undefined

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-video-mode` 的 `VideoShot`、`VideoRender`、`VideoProject`、`EdlVisualClip`、`EdlAudioClip` 与 `Edl` 把每个 schema 可选字段写成 `T | undefined`。解析 JSON 的结果不变：缺字段仍然缺席，内存里的 `undefined` 仍能通过 schema。用 `exactOptionalPropertyTypes` 编译的程序不能把这些值赋给对应字段仅为 `prop?: T` 的参数。

## 迁移

1. 本地复写 `keyframePath`、`clipPath`、`provider`、`model`、`costCny`、`durationSec`、`inSec`、`outSec`、`gainDb`、`audio` 或 `subtitles` 时，在赋给 `VideoShot`、`VideoRender`、`EdlVisualClip`、`EdlAudioClip` 或 `Edl` 之前写成 `prop?: T | undefined`。
2. 用 `pnpm exec vitest run packages/experimental/video-mode/tests/project.spec.ts packages/experimental/video-mode/tests/edl.spec.ts` 确认。
