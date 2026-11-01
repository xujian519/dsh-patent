---
kind: upgrade-guide
description: "Removes the published `@deepseek-ai/dsh-better-sidebar` package and its cordis insert from this fork."
---

# Workspace sidebar package removed

English | [中文](guide.zh.md)

## Change

This fork no longer ships `@deepseek-ai/dsh-better-sidebar`. Profiles and overlays that insert that module name fail at load. The desktop host overlay no longer carries a `better-sidebar` row. Right-hand workspace UI stays on `@deepseek-ai/dsh-client-ui-sidebar-right` (and its file/document tabs). Deployments that relied on the workbench (explorer, embedded editor/terminal, side chat, `sidebar_open` / opt-in `terminal_*` tools) lose those surfaces.

## Migration

1. Search every `cordis.yml`, overlay, and patch for `id: better-sidebar` or `name: '@deepseek-ai/dsh-better-sidebar'` and delete those rows.
2. Remove `@deepseek-ai/dsh-better-sidebar` from any `package.json` `dependencies` / `devDependencies` and reinstall.
3. Drop TypeScript imports of `@deepseek-ai/dsh-better-sidebar` and `ctx.betterSidebar` usage; register tabs on the product right Sidebar instead, or drop the feature.
4. Confirm with `pnpm dsh web` (or desktop): the process boots without a missing-plugin error, and only one right Sidebar mounts.
