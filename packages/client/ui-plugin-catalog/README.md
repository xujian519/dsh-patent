---
description: "Read-only plugin discovery page in Web Settings for the dsh web client: catalog sources, search, and install preview over the plugin-market Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-catalog

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-plugin-catalog` contributes the read-only **Plugin catalog** page to Web Settings. The page lazily calls the `ctx.remote.pluginCatalog` namespace the first time it is selected and renders a source picker, a search form, and an install-preview control. It lists the catalog sources the Host has registered (marking built-in ones), searches one source by free text, category, and capability, and previews a `name@version` reference against the registry — all without touching a profile. Loading, empty, no-match, preview, and generic failure states stay local to the mounted component, and a failed source read can be retried without exposing transport details.


## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Settings and select the **Plugin catalog** entry to discover plugins the Host can reach. The page reads no Remote during plugin activation — selecting it for the first time mounts the component and lazily calls `ctx.remote.pluginCatalog.listSources()` through `api-remotes`.

### Listing catalog sources

The source picker lists every source the Host has registered; a built-in source carries a `Built-in` suffix. With no source registered the section shows a local empty hint.

### Searching a source

Select a source and enter free text, a category, or a capability, then search. Empty filters are omitted from the Catalog query, and the results are rendered as compact cards in a two-column grid, each showing the plugin name, package reference, description, source tag, and capability/ category tags. A local free-text box filters the fetched page further without another Remote call.

### Previewing a reference

Either the preview button on a card or the dedicated `name@version` input calls `ctx.remote.pluginCatalog.preview()` to check the reference against the registry. A verified reference shows its version; a rejected one shows a failure seat. Preview never installs.

### Retrying a failed read

A failed source read renders a generic failure state inside the page; retrying re-runs the lazy `listSources()` call without exposing transport details.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page is a read-only projection of Host-owned plugin-market state; it performs no Remote read during plugin activation and takes the source list on first selection.

### Registration

The browser plugin registers one localized `settings.section` contribution with id `pluginCatalog` and order `30`. The Settings shell owns the navigation entry and page chrome. Registration uses `ctx.slots.inject()`, so it follows late section declaration, redeclaration, locale changes, and teardown without importing the section owner.

### Remote face

`inject` declares `slots`, `locale`, `remote`, and `remote.pluginCatalog`. The injected face wraps the three read-only Remote methods — `listSources`, `search`, and `preview` — and throws a shallow `pluginCatalog.<method> failed: <code>: <message>` error when a Remote returns `ok: false`, so the component never handles the transport envelope.

### Rendering

The component takes only the injected functions and locale key set; it holds no `ctx`. It models source loading as a `ViewState` union (loading / error / ready), search results as a `CatalogPage`, and preview as a `PreviewState` union (idle / pending / rejected / ready). A `current` flag guards each async result against post-unmount stale writes, and the failure seat exposes no transport detail.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the Remote surface, and the Host-side seam.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.section`.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `pluginCatalog.*`.
- [plugin-market-controller](../../api/plugin-market-controller/README.md) — the Host controller projecting the read-only seam onto `pluginCatalog`.
- [plugin-market](../../host/plugin-market/README.md) — the Host-side catalog and install-preview seam this tab renders.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side discovery projection that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the freshness and reach of the discovery view; they are current package constraints.

- **One source list per Settings mount or retry** — the page does not subscribe to catalog changes or automatically refetch after reconnect; switching sections preserves the current source list, while reopening Settings obtains a new one.
- **Read-only discovery, no install** — this page never installs or uninstalls a plugin; `dsh plugin install` stays CLI-only. The browser only discovers and previews.
- **Public HTTPS catalog sources remain to be wired** — the shipped composition supplies a built-in offline catalog source, so discovery works without a network catalog endpoint, but a remote HTTPS `dsh-plugin` directory is still future work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

</details>
