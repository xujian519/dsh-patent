---
description: "DSH Patent brand occupants for the sidebar mark and the blank-session hero, registered unconditionally so a fork build shows its own mark instead of the official whale; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-patent

English | [中文](README.zh.md)

## Summary

This package gives a fork build its own mark and product name in the sidebar, plus the blank-session hero mark. `BRAND_GUIDELINES.md` permits the `DSH` abbreviation in a project name but asks it not to present official artwork as though DeepSeek endorsed it; a fork named `DSH Patent` that ships the whale does exactly that. Choose it for a deployment with its own identity. Unlike `dsh-client-ui-brand-official` it registers on every build profile, because a fork's profile is never `official` and a gate would leave the official fallbacks in place. It has no runtime state and does not affect model requests.

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

Mount this plugin in the browser roster of a deployment with its own identity. It occupies `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark`, replacing the three fallbacks those slots otherwise render: the shared `FishLogo`, the local-build product name, and the animated `HeroFish`.

### Why it registers without a profile gate

`dsh-client-ui-brand-official` returns early unless `DSH_CLIENT_BUILD_PROFILE === 'official'`. A fork builds with `local`, so that package contributes nothing and the shell falls back to the whale — the arrangement `BRAND_GUIDELINES.md` asks projects to avoid. This package therefore registers unconditionally. A build that wants the official marks instead composes the official package and leaves this one out; a single-occupant slot takes whichever the composition loads.

### The mark

Two interlocking hooks: `harness` in its literal sense, a coupling. The left half reads as handing work in and the right half as acceptance coming back, which is the product rule that an agent cannot close a task — only the user's acceptance does. The two tips end past the canvas centreline, so the halves read as one object's two parts rather than as two brackets.

`brand/assets/` holds the SVG sources for the installed icons; this package draws the same geometry for the in-app surfaces, so both must change together. `scripts/verify-brand-assets.ts` pins that geometry and fails a change that moves it without updating the pin.

### Sizes and stroke weight

`strokeForSize()` returns 8 below 32 px and 6 above it, mirroring the `mark.svg` / `mark-small.svg` split the icon generator already relies on: at 16 px the standard stroke thins until the crossing tips disappear and the mark collapses into a small diamond.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half is [`src/client/index.ts`](src/client/index.ts), which declares `inject = ['slots']` — without that declaration the runtime refuses to activate the entry and the whole web boot fails, so it is load-bearing rather than documentation. Each occupant registers through `ctx.slots.inject()`, so it waits on the declaring package and withdraws when that declaration collapses, leaving no partial brand mix during HMR. The components live in [`src/client/occupants.tsx`](src/client/occupants.tsx) with the geometry in [`src/client/Mark.tsx`](src/client/Mark.tsx); the node half is an empty Loader seat.

The right hook paints through `var(--dsw-alias-state-business-primary)` rather than a literal, so it follows the active palette (DeepSeek 500 in light, 400 in dark) instead of pinning one theme's value.

The hero occupant deliberately does not animate. The official hero fish morphs its outline on hover; the two hooks have no equivalent deformation that keeps the coupling readable at 34 px, so a morph would trade the mark's meaning for motion.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [ui-brand-official](../ui-brand-official/README.md) — the profile-gated official occupants this package replaces.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how this fork's brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The hero occupant is static** — the hover morph the official fish performs is not reproduced, because no deformation of the hooks keeps the coupling readable at 34 px.
- **The mark is maintained in two places** — the SVG sources under `brand/assets/` and the path constants in `src/client/Mark.tsx` describe the same geometry and must move together; the asset gate pins only the SVG side.
- **No build version in the brand area** — neither this occupant nor the shell fallback renders a version chip next to the product name; build identity stays in packaging metadata and diagnostics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
