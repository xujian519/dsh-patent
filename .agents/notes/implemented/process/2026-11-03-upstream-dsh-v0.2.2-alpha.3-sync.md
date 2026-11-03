# Agent Note: upstream v0.2.2-alpha.3 sync

Status: implemented

English | [中文](2026-11-03-upstream-dsh-v0.2.2-alpha.3-sync.zh.md)

## Problem

The fork sat on upstream's `dsh-v0.2.2-alpha.2` tag while `dsh-v0.2.2-alpha.3` shipped a large release surface: unified context menus, file-preview directory trees, experimental change-request/worktree unification, schedule task prefill and timing fixes, temporarily-disabled default `apply_patch`, Cordis/Loader vendor bumps, on-demand CUA delivery, and hundreds of supporting fixes. Absorbing the tag requires a one-way merge-forward that keeps the patent, legal, document, and self-evolve fork surfaces on the release's structure without rewriting history or publishing the release's `dsh-v*` tags onto the fork.

## Decision

- **Merge-forward from the fork master tip onto `dsh-v0.2.2-alpha.3`.** Branch `sync/upstream-dsh-v0.2.2-alpha.3` merges the annotated tag (not a rebase or cherry-pick). Conflicts resolve by category: shared package manifests take the release then restore the fork dependency union; docs/snapshots/lockfiles prefer the release; code conflicts synthesize both parents' contracts.
- **Version family follows `0.2.2-alpha.3`.** Root and workspace manifests move with the release; fork-only packages join that family. The fork does not push the upstream `dsh-v*` tag.
- **`timeout-guard` becomes `timeout-policy` / `@deepseek-ai/dsh-tool-call-timeout-policy`.** The rename lands with the release; the npm name no longer matches the directory, so `tsconfig.base.json` keeps a hand-written alias outside the generated region, and consumers follow the new package id.
- **Fork FS write-bytes and client `dsh-value` inline stay.** Local/sandbox/SSH providers and RecordingFileSystem fixtures keep `writeBytes` / `FsTextWriteOutcome` and the abstract `patchText`/`deleteFile`/`moveFile` stubs. `INLINE_SAFE` retains the fork's `|value` arm beside the release's `util-time` and `commands/builtin` entries so client bundles may still inline `@deepseek-ai/dsh-value`.
- **`system-prompt` keeps the `./prompt-cache` subpath export** the fork's consumers already resolve.
- **On-demand CUA leaves the DSH installation graph.** `@deepseek-ai/dsh-cua-bundle` joins `ON_DEMAND_BUNDLES` and must not appear in `@deepseek-ai/dsh` (`apps/cli`) runtime dependencies; the fork's earlier direct install edge is removed so `gen-official-bundle-catalog` can embed package-owned metadata.
- **Upstream CI workflows that the fork cannot run stay archived.** Refresh `.github/workflows-disabled/` with the release's `ci-windows.yml`, `ci-python.yml`, and related hosted pipelines; active fork workflows under `.github/workflows/` remain the ones that can dispatch here.
- **Generated surfaces are regenerated, not hand-merged.** Config/tool/persistence/plugin catalogs, module graphs, Cordis/client inspect catalogs, CLI help, session-format catalog, dependency catalog, official on-demand catalog, and tsconfig path aliases come from their generators after `build:artifacts`.
- **Session-log-export stays on the release's local `messageOf` helper.** The fork's `@deepseek-ai/dsh-value` import in that client controller violated bundle purity before `|value` was restored; the release's file-local helper is the smaller surface for that package.

## Alternatives considered

- **Rebase the fork onto the release tag.** Rejected: the fork's patent and legal history must remain merge-reachable from master, and rebase would rewrite the published stack.
- **Cherry-pick only the release notes' headline commits.** Rejected: alpha.3 is ~460 commits with interlocking catalog, vendor, and client changes; a selective pick would miss generated surfaces and rename fallout.
- **Keep `@deepseek-ai/dsh-cua-bundle` as a direct `apps/cli` dependency.** Rejected: the release's on-demand installer owns delivery, and the official-bundle catalog gate forbids on-demand providers from appearing in the DSH installation closure.
- **Drop `|value` from `INLINE_SAFE` and rewrite every client import to `@deepseek-ai/dsh-util-values`.** Rejected for this sync: the fork already sinks shared predicates into `dsh-value`, and restoring the wire-layer allowlist preserves that decision without a mass import migration.

## Consequences

The sync branch carries the release plus the fork's patent/legal/document/self-evolve surfaces. `pnpm run typecheck` and `pnpm run build:artifacts` pass on the merged tree. Snapshot replay, hygiene, and a full `test:snapshot` pass remain the next verification gates before merge. Landing must use a merge commit (not squash) so both parents stay visible.

## Testing

`pnpm run typecheck` exits 0 through Host Typert, host/client compilers, and both aggregate programs. `pnpm run build:artifacts` completes all eight gates, including Client bundle and Web build. Catalog generators listed under Decision rewrite their owned artifacts; `gen-tsconfig-paths` and `gen-official-bundle-catalog` succeed after the timeout-policy hand-written alias and the CUA install-edge removal. Keyless snapshot replay and `pnpm run hygiene` are still outstanding on this branch.
