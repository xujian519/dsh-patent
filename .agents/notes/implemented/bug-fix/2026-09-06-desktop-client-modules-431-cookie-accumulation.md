# Agent Note: Desktop client-modules bundle fails with 431 from per-port cookie accumulation

Status: implemented

English | [中文](2026-09-06-desktop-client-modules-431-cookie-accumulation.zh.md)

## Problem

The packaged desktop app failed to load its renderer with `Failed to load plugins / failed to import loader entry … client-modules: bundle script /plugins/??… failed to load`. Every client plugin is composed into one immutable bundle URL served at `/plugins/??<pkg>/client.js,…&rev=<hash>`; the renderer loads it as an async `<script>`, and a nonzero HTTP status surfaced as that loader failure.

Every launch binds a fresh random port and mints a new, 30-day, port-scoped session cookie named after that port (the authority `127.0.0.1:<port>` is hashed into the cookie name). Cookies persist across launches in the Electron session and are sent to `127.0.0.1` regardless of port, so each boot adds another name to the jar. After enough launches the accumulated cookie head (~14.8 KB across ~63 cookies) plus the ~2.7 KB `/plugins/??` request line exceeded Node's 16 KB default `maxHeaderSize`, so the webserver returned 431 (header too large) for the bundle while short-URL requests stayed under the limit. A TCP-proxy capture showed every bundle request carried the full cookie set, and clearing the cookies then reloading the token URL made every `/plugins/` request return 200.

## Decision

Reset the Electron default-session cookie jar at startup, before the window is created, in `apps/desktop-patent/src/main.ts` with `await session.defaultSession.clearStorageData({ storages: ['cookies'] })`.

The desktop shell always rebuilds its browser session from the per-launch token URL in the readiness line, so it never needs a cookie to survive a boot; clearing the jar removes the accumulated per-port names that pushed the bundle request over the header limit.

## Alternatives considered

**Bound the number of cookies in `packages/host/authentication-token/src/browser-auth.ts`.** The root cause is unbounded cookie minting, so a bounded jar would help the browser `dsh web` path with random ports too. Rejected for this change: it is a multi-file change — `ConnectionIndexResponse.writeHead` would widen from `Record<string,string>` headers to `string | readonly string[]`, touching the browser-auth host tests and the two gateway test fakes — for a defect the desktop shell can fix locally and fully. Deferred as a follow-up; the desktop reset solves the shipped app without a shared-contract change.

**Raise the Node `maxHeaderSize`.** Masks the accumulation instead of removing it, and the browser path would still drift toward 431.

**Scope cookies to the bound port so they are not sent cross-port.** Cookie heads cannot carry or honor a port constraint, so the names would still accumulate in the jar.

**Clear on quit or tray exit.** More surface than a startup reset, and the shell already rebuilds session state from the token URL each launch.

## Consequences

- Each launch starts with a clean cookie jar; the bundle request stays under the header limit and the renderer loads.
- The desktop shell clears the persistent browser session at startup, which is safe because auth is re-established from the per-launch token URL.
- A process kept alive by hiding to tray does not re-run the startup reset, so a stale instance still shows the error until it is fully quit (⌘Q, not window close).
