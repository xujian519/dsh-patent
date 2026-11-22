# Agent Note: upstream dsh-v0.2.3-alpha.1 sync

Status: implemented

English | [中文](2026-11-22-upstream-dsh-v0.2.3-alpha.1-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.3-alpha.1` on 2026-11-21, 2343 commits after the fork's last sync at `dsh-v0.2.2-rc.5`. That tag is exactly `git merge-base origin/master dsh-v0.2.3-alpha.1`, so the release needs one content merge and no ancestry repair.

The release is a full alpha cycle, not a patch between releases: 7260 files, +302202/−83093 lines, and 329 content conflicts across `packages/*/tests` (86), `packages/*/src` (59), manifests (26), `docs` (25), Chinese pages (25), `.i18n.yaml` records (38), snapshots (17), `scripts` (15), and `.agents` (6). It carries breaking renames and removals that the fork consumes directly:

- Cordis moves to `4.0.0-rc.12` (Loader and Include API), so every fork-owned plugin and profile patch is re-checked against the vendored source.
- `packages/experimental/ptc-runtime-python` and `packages/experimental/personalized-recommendations` are removed outright, together with the Python PTC lane the fork referenced from bundles, profiles, snapshots, and docs.
- Twenty-six packages arrive, including `account/deepseek-auth`, `client/ui-session-status`, the nine `connector/*` providers, `host/authentication-desktop`, `host/authentication-token`, `session/session-persistence-sqlite`, and `util/text-search`.
- Several seams the fork's own packages call change: DeepSeek requests resolve through one `ctx.deepseekAuth`, `list_agents` returns its rows under `agents`, tool failures use structured error codes, package entries drop test-only exports and legacy subpaths, session working directory and worktrees move to `enter_worktree`/`exit_worktree` with the `working_directory` tool removed, and client plugin artifacts install their own styles with different CSS Modules class names.

## Decision

- **Merge forward in one content merge and land the pull request as a merge commit.** The merge base sits on the rc.5 tag, so a single merge keeps the tag reachable and leaves the next release's base correct; a squash here would detach upstream history from the DAG a second time.
- **Adopt both upstream removals and clean every fork reference in the same change.** `ptc-runtime-python` disappears from `vendor` consumers, bundle and profile patches, PTC snapshots, and the Python runtime docs; the implemented fd-3 protocol note moves to `.agents/notes/archived/` with the code it describes. `personalized-recommendations` leaves with the default bundle row it shipped.
- **Keep the fork's own product surfaces and migrate them to the renamed seams.** `packages/patent`, `packages/legal`, `packages/law`, `packages/self-evolve`, the desktop `bridge` architecture and brand layer, and the fork-only gates stay. Where upstream renamed what they call — `agents` on `list_agents`, structured tool error codes, the session-status package, `ctx.deepseekAuth` — the call sites follow upstream rather than pinning a local copy.
- **Keep the fork's `dsh-entry-lifecycle` state machine and wire `Session` back to it.** Upstream re-aggregated `Session` into `core/session`'s entry and inlined the announcement, dispatch, and deferred-removal fields the fork had extracted; taking that inline copy would restore the duplicated state machines that `entry-lifecycle` exists to remove. The merged entry keeps upstream's single-file layout but holds one `EntryLifecycle` per entry, so `enter`, `commit`, `detach`, and `announce` delegate the state transitions to the package's owner.
- **Take upstream's package names where the fork never held a fork-only rename.** `packages/guard/timeout-policy` already carried upstream's `@deepseek-ai/dsh-tool-call-timeout-policy` on the merge base, so the release's manifest updates apply unchanged.
- **Move the whole workspace to `0.2.3-alpha.1`.** The root manifest follows the release; the fork-only manifests (patent, legal, document, desktop, self-evolve, video, client) and `SIDEBAR_SERVICE_VERSION` follow, because `pnpm run constraints` requires one version line.
- **Give `standard` upstream's new `tool-cordis` row and record an explained absence in the three delivery presets.** `packages/extensions/tool-cordis` is read-only runtime API discovery for agents that write or configure plugins; a document, legal, or patent delivery has no plugin-authoring step, and the preset row alone registers no provider because the host composition mounts `@deepseek-ai/dsh-tool-cordis/host` once for every web preset. `scripts/preset-mode-baseline.json` now states that reason per preset instead of widening the baseline.
- **Re-record generated baselines instead of relaxing their gates.** `scripts/preset-divergence-baseline.json`, the translation-pairing records, `docs/TECH_DEBT.md`'s counter table, the module graph, the Cordis catalog, and the client metadata all move to what the merged tree actually produces.
- **Bridge the persistence-change chain with a release-named record.** Upstream's five new records hang off its own predecessor, so a same-version record `2026-11-22-v023-alpha1-sync` declares `previous: 2026-11-19-cua-input-notices` and re-confirms the event roots the fork adds (`patent-rule-gate`, `patent-teams-report`, `self-evolve`), which keeps them from reading as new generations.
- **Absorb upstream's entire `docs/upgrade-guide/v0.2.2-rc.1` through `v0.2.2-rc.5` trees.** Fork master never carried those guides; they are the checklist every fork-side consumer migration above was verified against.

## Alternatives considered

- **Rebase the fork's commits onto the release.** Rejected: it rewrites the fork's published history and the release's own merge base, and the fork's branches carry reviewed commits other sessions build on.
- **Point upstream's newest persistence record at the fork chain instead of adding a bridge record.** Rejected: committed generations are immutable, so a new record names the actual predecessor rather than editing the release's.
- **Squash the merge to keep master linear.** Rejected: the fork's own upgrade guides record why the tag must stay reachable, and the rc.2 incident is the cost of losing it.
- **Mount `tool-cordis` in the document, legal, and patent presets.** Rejected: none of the three has a plugin-authoring step, and the row would advertise a tool whose provider the host already registers for every preset.
- **Raise the structure counters' thresholds or drop `requiredRows` entries to clear the gates.** Rejected: the counts moved because upstream added files, not because the fork's standards changed; the report records the checked numbers and the attribution instead.

## Consequences

The fork now runs Cordis 4 and resolves DeepSeek credentials through one service, and its Python PTC lane is gone with the package that carried it. Twenty-six packages arrive, including the SQLite persistence backend, the connector providers, and the desktop and token authentication rows. The session folds and session-object extractions recorded in the god-file-split note no longer exist as modules — `Session` and `SessionStore` live in `core/session`'s entry again, and `SurfaceManager` owns the folds — so that note's history is archived. Entry lifecycle state stays in `packages/util/entry-lifecycle`: `SessionEntry` carries one `EntryLifecycle` and the entry module keeps no announcement, dispatch, or detach flag of its own.

The debt ledger grew with upstream's files: 208 functions above 150 lines, 102 source files above 800 lines, and 1348 `v8 ignore` comments, while the patent domain stays at 9 large files. Master keeps a reachable merge base with the alpha.1 tag, and the next release syncs from the tag as its base.

## Testing

`pnpm run typecheck` passes all five gates (Host Typert, the host and client compilers, and both aggregate checks). `pnpm run build:artifacts` rebuilds the catalogs, the client bundles, and the Web build (8 gates, 399 client artifacts), and `pnpm run build:check` passes against that output. `pnpm run lint`, `pnpm run duplication` (0 clones), `pnpm run constraints`, and `pnpm run hygiene` pass. `pnpm run test:docs` passes 30 gates and `pnpm run doc-sync` all 53 with `NODE_OPTIONS=--max-old-space-size=16384`.

`pnpm exec vitest run` on darwin runs 10442 suites and 73040 cases: 72806 pass, 231 skip, and three cases reach the 5 s timeout under full parallelism (HMR watch-config, plugin-manager Git reinstall, browser-use-runtime MCP discovery) while passing when their file runs alone (213/213); `pnpm run verify-test-skips --report <darwin json> --update` records the platform budget at 73040 cases and 231 skipped. `pnpm run test:snapshot` replays 330 cases with 2 skipped and pins the nine ACP `agentInfo.version` values to `0.2.3-alpha.1`; `pnpm run test:web:built snapshot` replays 27; the `self-evolve` and `tool-cordis` files run 464, all passing.

`verify-cordis-config` accepts 448 config files and `pnpm run persistence-changes --check` closes 90 roots against 49 history records. `verify-translation-pairing` reports 1886 pairs consistent, `verify-tech-debt-counters` accepts the six declared counters with `structure.long-functions` at 207 and `structure.large-files` at 102, and `verify-doc-budgets` keeps all seven budgeted docs within ceiling.
