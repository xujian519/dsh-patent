# Agent Note: Bound browser-session cookie count to keep the request head under the HTTP limit

Status: implemented

[English](2026-09-06-connection-cookie-count-bound.md) | 中文

## Problem

名为 `dsh-auth-<sha256(authority)>` 的浏览器会话 cookie 会无上限地累积。cookie 名哈希了授权域 `host:port`，每次启动一个 `dsh` web/desktop 进程都会绑定一个新的随机端口并签发一个全新 cookie，但 HTTP cookie 是按域名与路径而非端口生效的。因此该源上的每一个旧 `dsh-auth-*` cookie 都会随之后的每个请求一同发送，无论当前进程绑定的是哪个端口。启动足够多次后，jar 里的 cookie 头不断增长，直到加上一条很长的请求行（例如 client-modules bundle URL `/plugins/??…`）后超过 Node 16 KB 的默认 `maxHeaderSize`，服务器便对该请求返回 431（请求头过大）。

桌面 shell 的启动 cookie 重置（见本 `<bug-fix>` 目录下的桌面 client-modules 431 笔记）移除的是该 shell 的累积，但它帮不了跨启动持续使用 `dsh web` 的浏览器，且它是对症的表层重置，而不是对成因的约束。

## Decision

限制浏览器保留的 `dsh-auth-*` cookie 数量。在 `packages/host/authentication-token/src/browser-auth.ts` 中：

- `RETAINED_OTHER_COOKIES` 为 16。其他 16 个授权域各占一对 226 字符，使 `Cookie` 头保持在约 3.9 KB，留下约 50 次登录的余地（对不过期任何凭据的 Host 而言）。
- 在登录（签发）分支，`supersededCookieNames` 解析请求的 `Cookie` 头，收集符合生成名模式的 cookie，读取每个已签名负载声称的签发时间，返回 `RETAINED_OTHER_COOKIES` 个最近签发之外的其余名。当前授权域的 cookie 与不符合生成名模式的 cookie 永不清理；无法读取的值按签发时间为零处理，以便先削减超额字节。
- 每个超额名都用同名、`Max-Age=0` 的 `Set-Cookie` 清除，与新签发的 cookie 一并下发。
- `ConnectionIndexResponse.writeHead` 的头值放宽为 `Readonly<Record<string, string | string[]>>`，以便表达重复的 `Set-Cookie` 头。

约束在每次签发时生效，而签发正是新增 cookie 的地方，因此 jar 在两次启动之间永远不会超过上限。

## Alternatives considered

**不加约束，依赖桌面 shell 的启动重置。** 仅作为唯一修复不可取：浏览器 `dsh web` 路径从不重置自己的 jar，因此仍会漂向 431，且表层重置不触及成因。桌面重置仍作为该 shell 的纵深防御保留。

**调高 Node 的 `maxHeaderSize`。** 掩盖累积而非移除；请求头仍会无界增长。

**每次签发都清理全部非当前 `dsh-auth-*`。** 把上限压到 1，但破坏了多实例浏览器场景——用户在同一浏览器的多个标签页里运行多个不同端口的进程。有界保留能保住最近实例。

**超过上限即拒绝或硬失败。** 把可恢复的累积变成用户可见的失败；清理是无感的。

## Consequences

- 由同一源服务的每个表面其请求头都被限制（其他授权域的 cookie 约 3.9 KB），因此无论启动多少次都不会在长 URL 上重新引发 431。
- 多实例浏览器保留最近的 `RETAINED_OTHER_COOKIES` 条 cookie 并淘汰最旧的，而不是失败或把当前实例登出。
- 清理是签发响应上的一次性纠偏；普通的 cookie 认证请求不变，也不会重新签发。
- 桌面 shell 重置与本约束是不同包里的独立改动，二者互补而非重复。
