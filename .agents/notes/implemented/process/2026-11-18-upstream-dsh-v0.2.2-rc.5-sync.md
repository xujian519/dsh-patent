# Agent Note: upstream dsh-v0.2.2-rc.5 sync

Status: implemented

English | [中文](2026-11-18-upstream-dsh-v0.2.2-rc.5-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.2-rc.5` five commits after `dsh-v0.2.2-rc.4`. The fork's merge base against the tag is the rc.4 tag commit itself, so the release needs one content merge and no ancestry repair. The release carries two user-visible changes — a search with no configured provider now prefers Messages search in a conversation on a DeepSeek model route, and a Messages search result uses its own `snippet` before falling back to a citation excerpt — plus the usual version bump across every published manifest and one new upgrade guide.

The merge collides with fork-owned code on two paths: the `web` service, where the fork had extracted a shared `selectProvider` helper, and the `tool-lsp` manifest, which carries a fork-added dependency and a literal-em-dash description.

## Decision

- **Merge forward in one content merge and land the pull request as a merge commit.** The merge base already sits on the rc.4 tag, so a single merge keeps the tag reachable from master and leaves the next release's base correct.
- **Carry the release's `preferredId` through the fork's `selectProvider` helper.** Upstream computes the preferred search provider in `selectSearchProvider` and passes it to `resolveProvider` directly. The fork's `selectSearchProvider`, `selectFetchProvider`, and `resolveFetchProvider` share one private helper, so the helper takes an optional `preferredId` and the search path passes the route-derived value while the two fetch paths pass none.
- **Adopt the route-based search default as upstream ships it.** With no configured `searchProvider`, a search serving a `deepseek-official` or `deepseek-account` model request uses the `deepseek-official` provider (Messages search, no per-search charge), and every other route uses `deepseek-search-api`. A configured provider id still wins.
- **Keep the fork's literal em dash and added dependency in the `tool-lsp` manifest, and take the release version.** The description is unchanged text; only the escape form differs, and `dsh-value` is a fork dependency.
- **Take upstream's clock-relative horizon spec where the fork already made the same change.** Upstream replaced a hardcoded live horizon with one derived from `Date.now()` under #8465; the fork made the same call after #827 with a `NOW` constant. Git's three-way merge keeps the fork block without a conflict, and the suite passes.
- **Move the fork-owned manifests to `0.2.2-rc.5`.** The root version moved with the release, and `pnpm run constraints` requires every workspace manifest to match it. The 55 fork-only patent, legal, document, desktop, self-evolve, video, and client manifests follow; vendor, native, examples, and benchmarks keep their own version lines because the release touched no vendor version.
- **Re-pin the nine ACP expected outputs to `0.2.2-rc.5`.** `agentInfo.version` is read from the package manifest, so every handshake pin carries the release version.
- **Keep the upgrade guide under the path upstream chose.** Upstream files the search-default guide under `docs/upgrade-guide/v0.2.2-rc.4/`, the release whose behavior it changes, and the fork keeps upstream's path.

## Alternatives considered

- **Restore the direct `resolveProvider` calls in `selectSearchProvider` and `selectFetchProvider`.** Rejected: the fork's `resolveFetchProvider` needs the shared helper, and restoring the direct calls would duplicate the selection rules a third time.
- **Re-record the ACP outputs with `DSH_SNAPSHOT=refresh`.** Rejected: the only mismatch is the version string, so a recording pass would rewrite unrelated pins for no benefit.
- **Take upstream's `DAY`-constant form of the horizon spec.** Rejected: both express the same decision, and the fork's block is already reviewed and covered.

## Consequences

A conversation on a DeepSeek model route that has saved no search selection now searches through Messages search, billed as model tokens, while every other route searches through the Search API. A Messages search result keeps its own snippet when the result carries one. Fork-owned manifests stay in the `0.2.2-rc.5` release family, and master shares a reachable merge base with the rc.5 tag.

## Testing

`pnpm run build:artifacts` rebuilt the catalogs, module graph, client metadata, and bundles (8 gates, 387 client artifacts) and left no tracked file changed; `pnpm run build:check` compiled both aggregates against that output (2 gates). `pnpm run typecheck` (5 gates), `pnpm run lint` (exit 0, no warnings or errors), `pnpm run duplication` (0 clones), `pnpm run constraints`, and `pnpm run hygiene` (26 gates) pass. `pnpm run doc-sync` passes all 53 gates with `NODE_OPTIONS=--max-old-space-size=16384`, because `verify-doc-graphs` exceeds the default local heap on this tree. `pnpm run test:snapshot` replays 275 session and ACP cases (2 skipped), with the nine ACP pins refreshed first. Focused suites for `web`, `web-search-deepseek`, `web-deepseek-api`, `tool-web`, `ui-settings-web-search`, and `liveshare` pass 2090 cases.
