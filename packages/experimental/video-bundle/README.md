---
description: "Enable experimental video production from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-video-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes the `video` agent preset, its six production skills, the media tools, and the Web Video studio. Shipped profiles leave it disabled.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Plugins in the Web sidebar and enable Video studio, marked by a blue film icon. The Video conversation view and the video preset become available on the next Session. Production needs `ffmpeg` and `ffprobe` on the host plus a configured video provider; the preset guide lists the credentials and local server. Disabling the bundle hides the view and the preset.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts the client studio row, and `presets/video.patch.yml` inserts the `video` preset with its skill root. The preset resolves the six skills through this package's own location. As an optional bundle, the experimental video service and client studio stay outside the default product's dependency graph.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Video preset guide](presets/video.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `video` preset, which adds the video-production persona, six skills, and the `media`, `video_project`, `video_assemble`, and `video_deliver` tools to a Session that selects it.

#### KV Cache effect

No direct effect on default Sessions; the video preset starts a separate composition with its own system prompt and tool catalog.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Every profile template ships the bundle disabled. Cloud providers need their own API keys, and local generation needs a running ComfyUI server.
- Publishing stays outside the harness; delivery ends at files and a manifest.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
