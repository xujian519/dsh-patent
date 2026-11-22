# Agent Note: Read-only plugin-market discovery in the Web settings

Status: implemented

English | [中文](2026-08-31-plugin-market-discovery-ui.zh.md)

## Problem

The plugin-market seam ([`@deepseek-ai/dsh-host-plugin-market`](../../../../packages/host/plugin-market/README.md)) was only reachable through the operator-driven `dsh plugin` CLI. The [model-facing half](2026-08-31-plugin-market-agent-tools.md) wrapped the sealed verbs as tools, so an agent can answer *what sources exist*, *what matches a query*, and *does this pin resolve*. But a human in the Web UI had no in-browser discovery surface: enumerating the registered catalog sources, searching one, or previewing a `name@version` all still required a terminal. The browser needed a read-only projection of the same seam so the discovery step does not depend on a shell.

## Decision

Bridge the seam to the browser with a **read-only Remote controller** and drop the projection into the Settings page as its own **section**, so discovery is available in-product while every write stays on the CLI.

- [`@deepseek-ai/dsh-api-plugin-market-controller`](../../../../packages/api/plugin-market-controller/README.md) extends `TypertRemoteService` under the `pluginCatalog` namespace and forwards only the read-only verbs `listSources` / `search` / `preview`. It projects a host `PluginMarketError` to a `TypertRemoteFailure` business code and reports the actionable configuration error when no provider is mounted.
- [`@deepseek-ai/dsh-client-ui-plugin-catalog`](../../../../packages/client/ui-plugin-catalog/README.md) registers a localized `settings.section` contribution (`id: 'pluginCatalog'`, `order: 30`) while the Settings shell owns the navigation entry and page chrome. It lists sources, searches a selected source with `q` / `category` / `capability`, and previews a `name@version` reference. Every string goes through a typed locale dictionary; the component consumes injected pure functions and never touches `ctx` or the Remote directly.
- `@deepseek-ai/dsh-api-remotes` mounts the controller (`pluginCatalogRemote`), so the browser resolves `ctx.remote.pluginCatalog` against the same namespace the CLI verbs use.

Both read-only by construction: no method can write a profile, edit `cordis.yml`, or install a package. Installation and uninstallation remain on the operator-driven `dsh plugin` CLI.

### Typed contracts

The controller and UI import the plugin-market contract types (`PluginMarketSource` / `CatalogQuery` / `CatalogPage` / `InstallPreview`) from `@deepseek-ai/dsh-host-plugin-market/types` rather than restating them, so a wire-schema change cannot drift a mirror. Those types are classified in the generated Cordis catalog (see the type-link exemptions in `scripts/gen-cordis-catalog.ts`).

## Alternatives considered

- **No model-facing install/uninstall in the browser.** Writing to a profile needs approval and durable receipts; it stays on the CLI. The in-browser surface is discovery and a sanity preview only.
- **No re-declared contracts.** Both packages reuse the plugin-market service types instead of introducing parallel mirrors.
- **Not a model tool.** The browser projection is the operator-facing half; the [model tools](2026-08-31-plugin-market-agent-tools.md) remain the agent-facing half. Their alternatives-entry defers this as a separate surface, which this note now ships.

## Consequences

A human in the Web UI can now enumerate catalog sources, search one, and preview a pin without reaching for a terminal, reusing the exact seam the CLI and the model tools drive. Every verb is read-only by construction, so a browser session cannot write a profile or install a package — the write path stays on the operator-driven CLI. The cost is a new Remote controller projecting a `pluginCatalog` namespace, an extra dependency in the web-app composition, and a UI tab that is deliberately read-only: there is no install/uninstall affordance and none is planned. The catalog source is initially the bundled offline `builtin-deepseek` snapshot; a live public HTTPS source remains an outstanding gap tracked in the host package README.
