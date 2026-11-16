# Agent Note: Development CUA helper in locally packaged Desktop applications

Status: implemented

[English](2026-11-16-installed-cua-helper-variant.md) | 中文

## Problem

在没有 Apple 开发者凭据的机器上打出的 Desktop 安装包只能临时签名，无法取得公证后的 Computer Use 辅助应用。打包流程两种变体都不暂存，于是包内的 provider 完全没有 `native/bin` 目录：这类构建产出的应用里，Computer Use 插件以「Computer use helper application is missing」启用失败，尽管 provider 本身已正确打包并安装。打包链路中没有任何环节核对 provider 所需的载荷与实际包内容。

## Decision

已安装的 provider 优先从 release 应用解析辅助应用，不存在时改用开发变体。`prepareNativeExecutable` 按变体名各读一次回执，两者都缺失时才报告目录缺失，因此源码检出已在使用的[开发版 bundle 身份](2026-10-29-cua-dev-signing-identity.zh.md)同样服务于本地打包的应用。载荷同时含两者时以 release 为准。

`apps/desktop/scripts/prepare-cua-helper.ts` 在 `package-target.ts` 中位于构建之后、`pack()` 之前，因为 provider manifest 的 `files` 字段在打包阶段决定 tarball 内容。它跳过非 macOS 目标以及 CLI 不依赖 `@deepseek-ai/dsh-cua-bundle` 的源码，复用已有回执，正式构建通过 `scripts/cua-helper/package.ts` 与 `stage.ts` 暂存公证产物，`--unsigned` 则直接把开发变体编译进 `native/bin/darwin-<arch>`。正式构建若无暂存的辅助应用就已到打包阶段，会带着两种补齐方式失败，而不是发布一个无法启用 Computer Use 的应用。

因此本地打出的包在 `app.asar.unpacked` 内携带临时签名、未公证的 `.dev` 辅助应用。macOS 在首次使用时把辅助功能与屏幕录制权限授予该应用，`native/bin` 保持在归档之外以便 LaunchServices 打开它。开发构建器的 `sources/` 索引在源码与签名身份未变时仍复用同一代产物。

## Alternatives considered

**只报告缺失而不随包提供。** 即最初的诊断结论。每个本地包都会带着准确的报错启用失败并保持不可用，等于同一个缺陷换了措辞。

**本地构建时对 release 变体临时签名。** release bundle 标识符正是持有用户既有授权的身份；本地构建的同标识符辅助应用会替换公证条目的指定要求。开发变体正是为此分离存在。

**只在 CI 暂存。** CI 本就暂存公证产物，而无凭据的构建恰恰不会在那里运行。

**在已安装应用内首次启用时编译辅助应用。** 这要求用户机器装有 Xcode，且每次重建都会改变临时签名的代码哈希，授权无法跨构建保留。

## Consequences

本地打出的 Desktop 应用现在可以启用 Computer Use，首次授权绑定到临时签名要求：改变二进制后重新构建需要重新授权，`sources/` 复用把这一点限制在真实源码变更上。正式打包获得了一项此前没有的门禁——未暂存辅助应用的正式构建在打包前停止，而不是发布一个插件形同虚设的包。两种变体对模型不可区分；provider 与权限页报告它实际启动的那个应用。
