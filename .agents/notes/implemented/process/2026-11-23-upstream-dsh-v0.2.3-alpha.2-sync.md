# Agent Note: upstream dsh-v0.2.3-alpha.2 sync

Status: implemented

English | [中文](2026-11-23-upstream-dsh-v0.2.3-alpha.2-sync.zh.md)

## Problem

Upstream published `dsh-v0.2.3-alpha.2` on 2026-11-22, five commits after the fork's sync at `dsh-v0.2.3-alpha.1`. That tag is exactly `git merge-base origin/master dsh-v0.2.3-alpha.2`, so the release needs one content merge and no ancestry repair.

The release carries no feature work: 488 files, +806/−707 lines, almost all manifest version bumps. What it does change is the supported runtime:

- `engines.node` moves to `^24.22.3 || >=26.13.1`, the first releases whose bundled undici carries the November 2026 security fixes. The root instructions, the Python SDK's `node` carrier check, `BUILD_BACKED_NODE_COMPAT_VERSION`, and the primary-runtime lock follow.
- The vendored Cordis family moves to `cordis 4.2.0-alpha.1`, `cosmokit 1.10.0-alpha.1`, `group`/`hmr`/`include`/`loader`/`logger-console 1.2.0-alpha.1`, `schemastery 3.20.0-alpha.1`, and `timer 1.3.0-alpha.1`; only their manifests change.
- Desktop moves to Electron 44.11.5 with `node-addon-require-builtin 0.1.10`, and `pnpm-workspace.yaml` pins undici per major behind overrides.
- The Python SDK executable now embeds the primary runtime's exact Node release instead of a `node24` range, so `scripts/build-exe-for-python-sdk.ts` reads `nodeVersion` from that lock.

## Decision

- **Merge forward in one content merge and land the pull request as a merge commit.** The merge base is the alpha.1 tag, so a single merge keeps that tag reachable and leaves the next release's base correct; a squash would detach upstream history from the DAG again.
- **Adopt the runtime floor and dependency bumps in full.** The fork ships the same Node floor in `engines`, the same vendored Cordis family, the same Electron and addon fingerprints, the undici overrides, and the lock-derived Python executable version, because each is a security or packaging requirement rather than a fork-specific choice.
- **Keep the fork's additions in the two conflicted manifests.** `tool-lsp` and `web-fetch-http` keep their `@deepseek-ai/dsh-value` dependency while taking upstream's version and `undici 8.12.4`; the runbook note keeps the fork's `workflows-disabled/` links while taking upstream's Node 24.22.3 wording.
- **Keep the fork's CI archive arrangement.** `scripts/preview-workflow.spec.ts` stays deleted with the workflow it checks, and the nineteen `.github/workflows-disabled/` archives need no manual copy: git matches them to their upstream counterparts as renames, so the release's workflow edits apply there automatically.
- **Move the whole workspace to `0.2.3-alpha.2`.** The root manifest follows the release, and the 55 fork-only manifests (patent, legal, law, document, desktop, self-evolve, video, client, and the fork's util packages) follow, because `pnpm run constraints` requires one version line.
- **Re-record generated baselines instead of hand-editing them.** The nine ACP `agentInfo.version` pins are refreshed from their replay, and the runbook's translation-pairing section record is rewritten by `verify-translation-pairing --write`.

## Alternatives considered

- **Skip the release because it only bumps versions.** Rejected: the Node floor exists so the bundled undici carries the November 2026 security fixes, and staying on 24.9 would keep fork users on an unsupported runtime.
- **Copy the upstream workflow files into `.github/workflows-disabled/` by hand.** Rejected: git already tracks each archive as a rename of its upstream path, so a manual copy would duplicate what the merge produced and drift on the next release.
- **Hold the fork's manifests at `0.2.3-alpha.1` and relax `constraints`.** Rejected: one version line across the workspace is what the constraint exists to enforce, and the fork manifests are not independently published.

## Consequences

A source checkout, a container, and any CI job that builds DSH now need Node 24.22.3 or a newer 24.x release, or Node 26.13.1 or newer; packaged desktop applications and the Python SDK's bundled executable carry their own 24.22.3 runtime. The next release syncs from the alpha.2 tag as its base.

## Testing

`pnpm run constraints` passes with the root and all 55 fork-only manifests on `0.2.3-alpha.2`, and `pnpm install --frozen-lockfile` reports the lockfile up to date. `pnpm run typecheck` passes all five gates. `pnpm run doc-sync` passes all 53 gates with `NODE_OPTIONS=--max-old-space-size=16384`, and `verify-translation-pairing` reports 1887 pairs consistent after the rewrite. `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/acp --update` replays 16 cases and re-pins the nine handshake versions to `0.2.3-alpha.2`.
