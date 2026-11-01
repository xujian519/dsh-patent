# Agent Note: This fork removes `@deepseek-ai/dsh-better-sidebar`

Status: implemented

English | [中文](2026-11-01-fork-removes-better-sidebar.zh.md)

## Problem

The workspace sidebar package remained a first-party optional plugin with a large test surface and desktop overlay row (`disabled: true`), while patent-domain compositions never mount it and already rely on `ui-sidebar-right` for the product right Sidebar. Keeping the package forced dependency, catalog, and gate cost for a surface this fork does not ship.

## Decision

Delete `packages/client/better-sidebar` from this fork. Drop the desktop overlay insert, CLI/desktop-host dependencies, product-package-policy entry, tsconfig paths, release version mirror, and regenerate Cordis/config/module graphs. Right-hand UI stays on `@deepseek-ai/dsh-client-ui-sidebar-right`.

External readers who still insert the module get a load failure; the upgrade guide `docs/upgrade-guide/v0.2.2-alpha.2/remove-better-sidebar/` states the migration.

## Consequences

- No `ctx.betterSidebar` service, no `/sidebar/*` host routes, no workbench tools (`sidebar_open`, opt-in `terminal_*`) from that package.
- Plugin-manager tests may still use the string `dsh-better-sidebar` as a fixture package name; that is unrelated to the removed workspace package.
- Upstream syncs that reintroduce the package need an explicit fork decision to keep or re-delete it.
