---
description: "在插件管理器中开启实验性视频制作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-video-bundle

[English](README.md) | 中文

## 概述

这个可选组合包组合了 `video` Agent 预设、六个制作技能、媒体工具与 Web 视频工作室。随附的 profile 默认不启用它。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Web 侧边栏打开“插件”，启用带蓝色胶片图标的“视频工作室”。下一个会话即可使用“视频”对话视图与视频预设。制作需要主机上的 `ffmpeg` 和 `ffprobe`，以及已配置的模型提供方；凭据与本地服务见预设指南。停用组合包会隐藏该视图与预设。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`cordis.patch.yml` 插入客户端工作室行，`presets/video.patch.yml` 插入 `video` 预设及其技能根目录。预设通过自身包位置解析六个技能。作为可选组合包，实验性视频服务与客户端工作室位于默认产品的依赖图之外。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[视频预设指南](presets/video.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `video` 预设：选择该预设的会话会获得视频制作人格、六个技能，以及 `media`、`video_project`、`video_assemble`、`video_deliver` 四个工具。

#### KV Cache 影响

对默认会话无直接影响；视频预设以独立组合启动，拥有自己的系统提示与工具目录。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 所有 profile 模板都默认停用该组合包。云端提供方需要各自的 API 密钥，本地生成需要运行中的 ComfyUI 服务。
- 发布仍在 Harness 之外；交付止于文件与清单。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
