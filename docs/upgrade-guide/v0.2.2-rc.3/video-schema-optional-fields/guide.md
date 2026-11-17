---
kind: upgrade-guide
description: "Optional fields on the published video project and EDL types now include undefined, matching the schema output."
---

# Video project and EDL optional fields include undefined

English | [中文](guide.zh.md)

## Change

`VideoShot`, `VideoRender`, `VideoProject`, `EdlVisualClip`, `EdlAudioClip`, and `Edl` from `@deepseek-ai/dsh-video-mode` type each schema-optional field as `T | undefined`. Parsed JSON is unchanged: a missing field stays absent, and an in-memory `undefined` still passes the schema. A program compiled with `exactOptionalPropertyTypes` cannot assign these values to a parameter whose matching field is only `prop?: T`.

## Migration

1. On a local copy of `keyframePath`, `clipPath`, `provider`, `model`, `costCny`, `durationSec`, `inSec`, `outSec`, `gainDb`, `audio`, or `subtitles`, write `prop?: T | undefined` before assigning a `VideoShot`, `VideoRender`, `EdlVisualClip`, `EdlAudioClip`, or `Edl`.
2. Confirm with `pnpm exec vitest run packages/experimental/video-mode/tests/project.spec.ts packages/experimental/video-mode/tests/edl.spec.ts`.
