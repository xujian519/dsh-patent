# Agent Note: Desktop client-modules bundle fails with 431 from per-port cookie accumulation

Status: implemented

[English](2026-09-06-desktop-client-modules-431-cookie-accumulation.md) | 中文

## Problem

打包后的桌面应用无法加载渲染进程，提示 `Failed to load plugins / failed to import loader entry … client-modules: bundle script /plugins/??… failed to load`。所有客户端插件被组合成一个不可变的 bundle URL 由 `/plugins/??<pkg>/client.js,…&rev=<hash>` 提供；渲染进程将其作为异步 `<script>` 加载，非零 HTTP 状态码暴露为上述 loader 失败。

每次启动都会绑定一个新的随机端口，并签发一个新的、30 天、按端口命名的会话 cookie（授权域 `127.0.0.1:<port>` 被哈希进 cookie 名）。cookie 在多次启动间持久保留在 Electron 会话中，且无论端口如何都被发送给 `127.0.0.1`，因此每次启动都会往 jar 里再新增一个名字。积累足够多次后，累积的 cookie 请求头（约 63 个 cookie 约 14.8 KB）加上约 2.7 KB 的 `/plugins/??` 请求行，超过了 Node 16 KB 的默认 `maxHeaderSize`，于是 webserver 对 bundle 返回 431（请求头过大），而短 URL 请求则仍在限制以内。TCP 代理抓包显示每个 bundle 请求都携带完整 cookie 集合；清空 cookie 后重新加载 token URL，所有 `/plugins/` 请求都返回 200。

## Decision

在 `apps/desktop-patent/src/main.ts` 中，于窗口创建前、启动时通过 `await session.defaultSession.clearStorageData({ storages: ['cookies'] })` 重置 Electron 默认会话的 cookie jar。

桌面 shell 每次启动都会根据就绪行里的 per-launch token URL 重建浏览器会话，因此它从不需要保留一份跨启动的 cookie；清空 jar 移除了把 bundle 请求推过头限制的、积累的按端口 cookie 名。

## Alternatives considered

**在 `packages/host/authentication-token/src/browser-auth.ts` 中限制 cookie 数量。** 根因是 cookie 签发无上限，因此有界 jar 也能帮助使用随机端口的浏览器 `dsh web` 路径。本次未采纳：这是多文件改动——`ConnectionIndexResponse.writeHead` 要从 `Record<string,string>` 头拓宽为 `string | readonly string[]`，会波及 browser-auth 的 host 测试以及两个 gateway 测试 fake——而桌面 shell 可以在本地彻底修复该缺陷。留作后续；桌面重置在不动共享契约的情况下解决了已发布应用。

**调高 Node 的 `maxHeaderSize`。** 掩盖了积累而非移除它，浏览器路径仍会逐步漂向 431。

**把 cookie 限定到所绑定的端口，使其不被跨端口发送。** cookie 请求头无法携带端口约束，cookie 名仍会在 jar 中积累。

**在退出或托盘退出时清理。** 比启动重置覆盖面更大，而 shell 每次启动都会从 token URL 重建会话状态。

## Consequences

- 每次启动都以干净的 cookie jar 开始；bundle 请求保持在请求头限制以内，渲染进程正常加载。
- 桌面 shell 在启动时清空持久浏览器会话，这之所以安全，是因为认证由 per-launch token URL 重新建立。
- 通过隐藏到托盘保活的进程不会重跑启动重置，因此陈旧的实例在完全退出（⌘Q，而非关闭窗口）前仍会显示该错误。
