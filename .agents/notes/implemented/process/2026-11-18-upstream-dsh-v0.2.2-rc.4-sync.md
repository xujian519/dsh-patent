# Agent Note: upstream dsh-v0.2.2-rc.4 sync

Status: implemented

English | [中文](2026-11-18-upstream-dsh-v0.2.2-rc.4-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.2-rc.4` three days after `dsh-v0.2.2-rc.3`, eight commits later. The fork's merge base against the tag is the rc.3 tag commit itself, so the release needs one content merge and no ancestry repair. The release carries three user-visible changes — DeepSeek streamed refusals now fail with `CONTENT_REFUSED` after reporting billed usage, the LiveShare tunnel worker inherits the Host's Electron Node mode, and the owner-credential horizon spec derives its instants from the clock — plus the usual version bump across every published manifest and one new upgrade guide.

The merge collides with fork-owned code on five paths: the LiveShare horizon spec, the `llm-deepseek` README pair and its translation record, and the `tool-lsp` manifest. Separately, `pnpm run doc-sync` already fails on the pre-merge master: `verify-export-jsdoc` reports that `buildVectorFigure` in `packages/patent/patent-tools/src/figure/vector-figure-build.ts` has no JSDoc, so the sync cannot turn the gate green on its own.

## Decision

- **Merge forward in one content merge and land the pull request as a merge commit.** The merge base already sits on the rc.3 tag, so a single merge keeps the tag reachable from master and leaves the next release's base correct.
- **Adopt the refusal handling as upstream ships it, and keep the fork's transport clause in the same paragraph.** The release adds `CONTENT_REFUSED` to `LLM_FAILURE_CODES`, reports final usage before throwing, and keeps the provider's explanation such as blocked images. Both sides edited the `llm-deepseek` failures paragraph: the fork's `TRANSPORT` sentence names the coded wire error in `diagnostic`, so the merged paragraph carries that clause inside upstream's new text and the pairing record is re-recorded.
- **Take the release's clock-relative horizon spec as the same decision the fork already made.** The fork replaced the fixed `START` date with a `NOW` constant after #827; upstream derives `PAST` and `LIVE` from `Date.now()` the same way. The merge keeps the fork's block, which is already reviewed and tested.
- **Keep the fork's literal em dash in the `tool-lsp` description and take the release version.** The description is unchanged text; only the escape form differs.
- **Move the fork-owned manifests to `0.2.2-rc.4`.** The root version moved with the release, and `pnpm run constraints` requires every workspace manifest to match it. The 55 fork-only patent, legal, document, desktop, self-evolve, video, and client manifests follow; vendor, native, examples, and benchmarks keep their own version lines because the release touched no vendor version.
- **Re-pin the nine ACP expected outputs to `0.2.2-rc.4`.** `agentInfo.version` is read from the package manifest, so every handshake pin carries the release version.
- **Add the missing JSDoc for `buildVectorFigure` in the same pull request.** Master's `doc-sync` aggregate is red on that export, and the sync branch cannot pass the same aggregate without it.
- **Record no new fork configuration.** The release's intermediate `safetyCheck` switch and the always-on `safety_check` request field were withdrawn inside the same release; the tag's final state sends no such field and only asserts its absence.

## Alternatives considered

- **Take upstream's horizon rewrite instead of the fork's block.** Rejected: both express the same decision, and the fork's names are already reviewed and covered.
- **Re-record the ACP outputs with `DSH_SNAPSHOT=refresh`.** Rejected: the only mismatch is the version string, so a recording pass would rewrite unrelated pins for no benefit.
- **Leave the export-JSDoc failure to a separate pull request.** Rejected: `doc-sync` is a required gate, master is already red on it, and the sync cannot land green while it fails.
- **Move the new upgrade guide under `docs/upgrade-guide/v0.2.2-rc.4/`.** Rejected: upstream files the refusal guide under `v0.2.2-rc.3`, the version whose behavior it changes, and the fork keeps upstream's path.

## Consequences

Master shares a reachable merge base with the rc.4 tag. Sessions now record `CONTENT_REFUSED` attempts with billed usage instead of `MALFORMED_RESPONSE`, and the Web client drops the streamed reply for that failure. A Desktop Host starts its LiveShare tunnel worker in Electron's Node mode, so the shell's single-instance lock no longer ends the worker. Fork-owned manifests stay in the `0.2.2-rc.4` release family, and the export-JSDoc gap that kept master's documentation aggregate red is closed.

## Testing

`pnpm run build:artifacts` regenerated the catalogs, module graph, client metadata, and bundles (8 gates), and `pnpm run build:check` compiled both aggregates against that output (2 gates). `pnpm run typecheck` (5 gates), `pnpm run lint` (0 warnings, 0 errors over 8577 files), `pnpm run duplication` (0 clones), `pnpm run constraints`, and `pnpm run hygiene` (26 gates) pass. `pnpm run doc-sync` passes all 53 gates with `NODE_OPTIONS=--max-old-space-size=8192`, because `verify-doc-graphs` exceeds the default local heap on this tree. `pnpm run test:snapshot` replays 275 session and ACP cases (2 skipped). Focused suites for `llm`, `llm-deepseek`, `liveshare`, and `patent-tools` pass 5207 cases with one failure in `packages/experimental/liveshare/tests/host-relay-checks.spec.ts` (`reports an address that does not answer with its transport cause and the relay prefix`), whose `afterEach` times out after ten seconds; the same case fails on the pre-merge master, so it is an environment failure of this machine and not part of the sync.
