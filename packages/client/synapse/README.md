---
description: "Browser half of the Synapse session map for `dsh web`: the **对话/会话地图** view switch and the full-surface iframe at `/synapse/`, bridged to the client session and workspace services. From the map you can browse, fork, continue, and create sessions without leaving the canvas; the native chat follows the current session in both directions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-synapse

English | [中文](README.zh.md)

## Summary

Browser half of the Synapse session map for `dsh web`: the **对话/会话地图** view switch and the full-surface iframe at `/synapse/`, bridged to the client session and workspace services. From the map you can browse, fork, continue, and create sessions without leaving the canvas; the native chat follows the current session in both directions.

The host half (`@deepseek-ai/dsh-host-synapse`) owns the canvas page and projection; this package only renders chrome and forwards bridge messages.


## Table of Contents

- [Registration](#registration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Registration

The web bundle mounts this package as `dsh.client` row `synapse-client` (node half is an empty Loader entry). The map switch appears on the chat surface once the host row `synapse` is also mounted; without it the iframe shows nothing.

## Model Experience

None, as the browser half never touches a model request; it reads client-side session/workspace snapshots and live partials only after the host commits them.

#### KV Cache effect

None: it sends no model requests and mutates no request headers.

## Known Limitations and Deferred Work

- The map runs inside an iframe with its own DOM/Markdown stack; it is not part of the React slot system, so theme tokens and accessibility conventions of the host chrome do not apply inside the canvas.
- The switch is plain DOM, not a slot occupant. It assigns the CSS anchor name `--dsh-synapse-switch` to the conversation tab row (`data-conversation-tab-row`, otherwise `data-conversation-tabs`) and aligns to that box's right and bottom edges; a blank Session with no row anchors to `data-conversation-session`, 40px below its top. A missing or collapsed anchor uses the stylesheet corner. A column resize, including a right Sidebar drag, moves the switch with the anchor and does not read layout.
- The exposed bridge surface (create/fork/send/open/activate) is a deliberate minimal RPC contract with the canvas; adding verbs means extending both `src/client/index.ts` and the canvas app.

### Dev Note
