---
kind: upgrade-guide
description: "Foreground patent approval cards stay documented in the v0.2.2-alpha.3 guide; this rc.1 page only points there."
---

# Patent stage-gate live approval (pointer)

English | [中文](guide.zh.md)

## Change

Canonical text remains [the alpha.3 guide](../../v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.md). Decision (2026-11-09): keep the `alpha.3` body; this `rc.1` path is a pointer only — do not move or copy the original.

Root package version is now `0.2.2-rc.1`. With foreground `approveStageGates: true`, the session shows an approval card. There is no separate approvals route. The behavior summary lives in that alpha.3 guide.

## Migration

1. Read [the alpha.3 guide](../../v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.md) and apply its steps. This directory does not hold a second copy of that text.
2. Confirm a foreground run shows the in-session approval card and does not open a separate approvals route.
