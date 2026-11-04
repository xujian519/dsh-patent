# Agent Note: upstream v0.2.2-rc.1 sync

Status: implemented

English | [中文](2026-11-05-upstream-dsh-v0.2.2-rc.1-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.2-rc.1` as the first release candidate of the 0.2.2 series. Its ancestry runs directly through `dsh-v0.2.2-alpha.3`, which the fork already absorbed, so the release adds only 387 one-line manifest changes: the root, 377 workspace packages, and nine vendor packages move from the alpha.3 version family to `0.2.2-rc.1` and to the Cordis 4.1.0 vendor family. The fork's alpha.3 absorption landed as a [squash commit](https://github.com/xujian519/dsh-patent/pull/719), so the tag's ancestry is not reachable from master and a content merge against the old merge base reports 468 conflicts that the fork already resolved during that sync.

## Decision

- **Record the tag as a merge parent with the ours strategy, then apply the release delta in a follow-up commit.** `git merge -s ours dsh-v0.2.2-rc.1` preserves both parents without replaying conflicts whose answers are already in master. Replaying them would present fork decisions as merge conflict resolutions and risk reverting the squash.
- **Apply the version family mechanically.** Every tracked manifest at `0.2.2-alpha.3` moves to `0.2.2-rc.1`, including the fork-only patent, legal, document, and self-evolve packages, matching the previous rule that fork-only packages join the release family.
- **Vendor manifests follow the release's published versions** (`cordis` 4.1.0, `cosmokit` 1.9.0, `group`/`hmr`/`include`/`loader`/`logger-console` 1.1.0, `schemastery` 3.19.0, `timer` 1.2.0). The release changes versions only; the vendored source pins in `vendor/README.md` stay at their recorded upstream commits.
- **ACP handshake snapshots move with the version.** `agentInfo.version` is read from the package manifest, so the nine ACP expected outputs that embed it are updated in the same commit.
- **No upgrade guide and no persistence record.** The release carries no externally perceptible behavior change, no new session event, and no persistence-type change relative to alpha.3.

## Alternatives considered

- **Replay the content merge and resolve all 468 conflicts.** Rejected: every conflict is an artifact of the squash-landed alpha.3 sync. Resolving them would mean choosing between the fork's already-merged rewrite and an ancestor snapshot of the same files, with no upstream change to reconcile.
- **Cherry-pick the four release commits.** Rejected: a cherry-pick records no upstream ancestry, so the next sync would face the same broken merge base. The merge parent is the durable part of the sync.
- **Skip the version bump because no code changed.** Rejected: the ACP handshake advertises the package version, release artifacts and published manifests carry it, and the fork-only packages must not drift from the release family.
- **Update the vendored sources to the 4.1.0 pins.** Rejected: the release bumps manifest versions without source changes; replacing vendored source belongs to a vendor sync with the procedure in `vendor/README.md`.

## Consequences

The fork's master now has `dsh-v0.2.2-rc.1` as a merge parent, so later release tags share a reachable merge base with the fork without another ours merge. All 431 tracked manifests report `0.2.2-rc.1`; vendor manifests report the release versions while their source remains the alpha.3 pin. The next upstream tag can be merged normally.

## Testing

`pnpm run build:artifacts` regenerated the catalogs and client metadata after the version change, and `pnpm run build:check` compiled the aggregate checks against that output. The ACP snapshot replay (`pnpm run test:snapshot -t handshake`) confirms the handshake advertises `0.2.2-rc.1`, and `pnpm run hygiene` validates the published manifests.
