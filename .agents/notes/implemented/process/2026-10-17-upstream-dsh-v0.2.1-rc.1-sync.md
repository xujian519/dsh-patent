# Agent Note: upstream dsh-v0.2.1-rc.1 sync

Status: implemented

English | [中文](2026-10-17-upstream-dsh-v0.2.1-rc.1-sync.zh.md)

## Problem

The fork moved from upstream's `dsh-v0.2.1-alpha.5` tag to `dsh-v0.2.1-rc.1`: 4 commits (2 non-merge), 355 files, +355/−355 lines. The merge base is the alpha.5 release commit the previous sync landed, so one `git merge` reaches the tag. `git merge-tree` predicted one conflicting file and the merge produced exactly one.

This release is a version roll. Every upstream-changed file is a `package.json` whose only changed line is `version`: `release(dsh): 0.2.1-rc.1` raises the DSH family to `0.2.1-rc.1`, and `release(vendor): cordis 4.0.5, …` promotes the nine vendored Cordis packages from their `-alpha.2` builds to final versions (cordis 4.0.5, cosmokit 1.8.6, group 1.0.5, hmr 1.0.20, include 1.0.10, loader 1.0.6, logger-console 1.0.5, schemastery 3.18.5, timer 1.1.7). No runtime source, documentation, snapshot, or lockfile changes accompany them. The published notes describe the 0.2.1 feature set since `v0.2.0-rc.2`; the fork already carried that behavior through the alpha syncs, and none of it arrives in this delta.

## Decision

- **The sync branch merge-forwards the release tag.** `sync/upstream-dsh-v0.2.1-rc.1` carries the merge; landing it as a merge commit whose first parent is the fork's `master` keeps upstream's commits in the fork's graph and keeps this tag as the next sync's merge base. A squash would do neither.
- **The single conflict is resolved by class.** `packages/lsp/tool-lsp/package.json` keeps the fork's manifest, including the literal em dash in its description, with the version raised to `0.2.1-rc.1`; the release's side supplies only the escaped dash and the new version.
- **The version is pinned across the fork's own surface.** The root manifest, 47 fork-only manifests, and `SIDEBAR_SERVICE_VERSION` in the since-removed better-sidebar package's `service.ts` move to `0.2.1-rc.1`. `pnpm exec tsx scripts/release/verify.ts --family dsh` resolves 388 family members at that version with no unordered peer declaration, and `pnpm install --lockfile-only` reports "Already up to date" without touching `pnpm-lock.yaml`.
- **Nine ACP goldens re-pin `agentInfo.version`.** The handshake response in `snapshots/acp/*/stdout.expected.jsonl` carries the release version as a literal string, so the expected files move with the manifests instead of waiting for the replay to report drift.

## Consequences

The fork ships upstream's `dsh-v0.2.1-rc.1` baseline with its patent, self-evolve, desktop, better-sidebar, and document surfaces unchanged, because the release changes no behavior. The 412 files in the merged tree's diff against the pre-sync `master` are 355 upstream manifest versions plus 57 fork version pins (47 manifests, one constant, nine goldens).

Three divergences still need attention at each release, unchanged: the fork's presets are the merge's landing place for upstream's composition changes, the archived-note seals must match upstream's for the notes it retires, and the fork's notes must track upstream's workflow paths into `workflows-disabled/`.

## Alternatives considered

- **Taking the release's `tool-lsp` manifest.** Rejected: it would replace the fork's literal em dash with an escaped sequence for a version-only change, adding a diff the release does not require.
- **Bumping only the manifests upstream names.** Rejected: 47 fork-only manifests and the sidebar constant would stay at `0.2.1-alpha.5`, and `scripts/release/verify.ts --family dsh` resolves the family at a single version.
- **Leaving the ACP goldens for a replay to discover.** Rejected: the drift is deterministic and the expected files are checked in, so recording it in the version commit keeps the replay's failure signal meaningful.

## Testing

`pnpm run build:artifacts` passes 7 of 7 gates. `pnpm run typecheck` passes all five gates — Host Typert, the host and client compilers, and both aggregates — and `pnpm run build:check` passes both aggregate checks on the built output.

`pnpm run lint` exits 0 with the one pre-existing unused-disable warning in `packages/experimental/client-ui-cot-translation/src/index.ts`. `pnpm run hygiene` reports 22 of 22 gates passing, which confirms the final vendor versions leave no dangling reference.

`pnpm run doc-sync` reports 51 of 51 gates passing, including agent-note format, translation pairing, upgrade guides, and the documentation build.

`pnpm run test:snapshot` replays 223 keyless cases across the session, sdk, acp, and web lanes with 2 skipped and no failures in 4 test files. The ACP lane is what proves the nine re-pinned goldens match the version the runtime reports.

`pnpm run test:coverage` was not selected: the release changes no executable source, and the version commit touches only manifests, one constant, and expected JSON.
