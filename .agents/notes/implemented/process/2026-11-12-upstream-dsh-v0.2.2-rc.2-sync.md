# Agent Note: upstream v0.2.2-rc.2 sync

Status: implemented

English | [中文](2026-11-12-upstream-dsh-v0.2.2-rc.2-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.2-rc.2` as the second release candidate of the 0.2.2 series, carrying 1568 commits since `dsh-v0.2.2-rc.1`. Unlike the previous release, whose ancestry master only records through a follow-up `-s ours` merge, this tag's ancestry runs straight back to the rc.1 merge parent, so the merge base sits on maintained upstream history rather than on a squash flattening. A content merge against that base still collides with fork-owned code on 220 paths, and the release reorganizes packages the fork composes: `office-to-pdf` becomes `office-kit` beside a new `tool-office`, the experimental agent-team packages move to `team/`, both `web-search` provider packages are deleted, and the account packages are replaced.

## Decision

- **Merge forward in one content merge and land the pull request as a merge commit.** The merge records `dsh-v0.2.2-rc.2` as a parent, keeps the tag reachable from master for the next sync, and resolves each of the 220 conflicts against the three-way diff instead of replaying already-answered fork decisions.
- **Adopt upstream's package reorganizations wholesale** — `office-kit` plus `tool-office`, `team/agent-team` and `team/tool-agent-team` out of `experimental/`, `client/ui-agent-team`, the new `experimental/terminal-panel`, `mcp/mcp-manager`, `util/error`, `util/ripgrep`, `client/ui-account-notifications`, and the removals of `api/account-controller`, `credentials/deepseek-account-platform`, `web-search-exa`, and `web-search-perplexity`. The fork composes these through bundles and presets, so carrying the old directories would freeze a vendor snapshot of code upstream now maintains elsewhere.
- **Rebuild the `verify-plugin-entry-exports` baseline instead of exempting fork packages.** The gate is new in this release; its baseline file started with 566 upstream entries and now lists 1385 exports across 125 packages, including the fork-only patent, legal, and self-evolve entries, and drops two entries whose exports upstream removed.
- **Keep the jscpd justification above its ignore marker.** The release moved the explanation below `/* jscpd:ignore-start */`, which `verify-suppression-reasons` rejects because it only reads comments above the directive; the comment text stays upstream's.
- **Add three narrow `GENERIC_SKIPS` entries to `rescope-vendor`** for files where the release writes `cordis` as the agent-preset id rather than the package name — the creator-flow e2e and two copies of the subagent-interrupt upgrade guide. A blanket skip would stop catching real vendor residue; per-file entries preserve the check everywhere else.
- **Align fork-owned translations with their English sources** where the merge changed one side: the twelve fork service rows and the Mermaid block in `docs/capability-seams.zh.md`, the source map in `packages/client/web/README.zh.md`, and the regenerated `docs/event-producer-consumer` pair.
- **Track the renamed agent-team package in the patent preset** and separate the two channel claims it makes: generic subagent control tools address the subagent tree, while the official agent-team tools are simply not enabled in that composition. The package rename also moves the corresponding spec assertion.
- **Write no fork-authored upgrade guide.** The release backfills 45 guides under the release directories that introduced each change — including the office kit, subagent names, session append overloads, and web-search removals — and leaves no `docs/upgrade-guide/v0.2.2-rc.2/` directory of its own, so every externally perceptible breaking change already has its record.
- **Adopt upstream's client boot policy and archive the fork note that recorded the predecessor.** rc.2 replaces the fork's per-row `required` mark with one global `requiredClientEntryNames` list naming the seven core client packages. A row outside that list — including every package the active profile installed — may stay inactive without failing boot, so the tolerance the fork implemented per profile-installed row survives as a subset of the upstream rule and no boot behavior is lost. The fork note describing the per-row mark moves to `archived/` beside the implementation it documented.
- **Add one clone pair to the fork's duplication baseline.** The release introduces a jscpd clone between `office-kit`'s `queue.ts` and `types.ts`. `scripts/duplication-baseline.json` has no upstream counterpart, so the sync records that single pair instead of widening the thresholds or exempting the package.
- **Move all 433 tracked manifests to `0.2.2-rc.2`.** Vendor manifests keep the 4.1.0 family the rc.1 sync already recorded; this release changes versions only.

## Alternatives considered

- **Record the tag with `-s ours` and apply the delta separately.** Rejected: that was a workaround for the rc.1 squash flattening. The ancestry is intact here, so an ours merge would discard 1568 commits of real upstream work and leave the fork without the code it claims to track.
- **Squash the sync into master.** Rejected: it erases the second parent, which is what makes the next release's merge base correct.
- **Disable `verify-plugin-entry-exports` or list the fork packages as unloaded.** Rejected: the gate protects the loader contract that function plugins and service plugins keep distinct export forms. A baseline entry states the existing exception; disabling the rule would stop detecting new violations in every package.
- **Skip the `cordis` occurrences globally in the rescope check.** Rejected: `cordis` is a package name everywhere else, so a global skip would hide real residue in vendored composition files.
- **Author a `v0.2.2-rc.2` upgrade guide duplicating the backfilled topics.** Rejected: two guides for one change make the upgrade path ambiguous, and upstream's placement under the introducing release is the one shipped users will read.

## Consequences

Master shares a reachable merge base with the rc.2 tag, so the next release merges without a synthetic parent. Fork-only packages stay in the release family at `0.2.2-rc.2`. `scripts/plugin-entry-existing-exports.ts` now carries 125 packages; a fork package that adds a public export must extend it, and the gate names the missing entry. The patent preset composes `@deepseek-ai/dsh-tool-agent-team` only as a negative assertion, so the rename does not change which plugins the preset mounts.

## Testing

`pnpm run build:artifacts` regenerated the catalogs, module graph, capability seams, and client metadata, and `pnpm run build:check` compiled the aggregate checks against it. `pnpm run test` and `pnpm run test:snapshot` cover the merged behavior and the re-recorded expected outputs; `pnpm run test:docs` (30/0) and `pnpm run hygiene` (25/0, including the vendor rescope, suppression reasons, plugin entry exports, and unknown-cast gates) pass, as do `pnpm run duplication` (no clones) and `pnpm run gen-doc-graphs --check`.
