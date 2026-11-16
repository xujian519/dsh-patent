# Agent Note: Development CUA helper in locally packaged Desktop applications

Status: implemented

English | [中文](2026-11-16-installed-cua-helper-variant.zh.md)

## Problem

A Desktop package built on a machine without Apple Developer credentials is signed ad hoc and cannot obtain the notarized Computer Use helper. Packaging staged neither variant, so the packed provider carried no `native/bin` directory: every such build produced an application whose Computer Use plugin failed to activate with “Computer use helper application is missing”, even though the provider had been packed and installed correctly. Nothing in the packaging chain compared the provider’s required payload with what the package actually contained.

## Decision

An installed provider resolves its helper from the release application when one exists, and from the development variant otherwise. `prepareNativeExecutable` reads the receipt once per variant name and reports the missing directory only when both are absent, so the [development bundle identity](2026-10-29-cua-dev-signing-identity.md) that source checkouts already use also serves locally packaged applications. Release takes precedence wherever a payload carries both.

`apps/desktop/scripts/prepare-cua-helper.ts` runs in `package-target.ts` after the build and before `pack()`, because the provider manifest’s `files` field decides the tarball contents during packing. It skips non-macOS targets and sources whose CLI does not depend on `@deepseek-ai/dsh-cua-bundle`, reuses an existing receipt, stages the notarized artifact through `scripts/cua-helper/package.ts` and `stage.ts` for a release build, and compiles the development variant directly into `native/bin/darwin-<arch>` for `--unsigned`. A release build that reaches packing without a staged helper fails with the two ways to supply one, instead of publishing an application that cannot activate Computer Use.

A local package therefore carries an ad-hoc-signed, unnotarized `.dev` helper inside `app.asar.unpacked`. macOS grants Accessibility and Screen Recording to that application on first use, and `native/bin` remains outside the archive so LaunchServices can open it. The development builder’s `sources/` index still reuses a generation when the sources and signing identity are unchanged.

## Alternatives considered

**Report the missing helper without shipping one.** The original diagnosis. Every local package would fail activation with an accurate message and remain unusable, which is the same defect with better wording.

**Sign the release variant ad hoc for local builds.** The release bundle identifier is the identity that holds users’ existing grants; a locally built same-identifier helper would replace the notarized entry’s designated requirement. The development variant exists to keep those separate.

**Stage only in CI.** CI already stages the notarized artifact, and a build without credentials is exactly the case that never runs there.

**Compile the helper on first activation inside the installed application.** This requires Xcode on the user’s machine and changes the ad-hoc code hash on every rebuild, so grants would not survive between builds.

## Consequences

A locally packaged Desktop application now activates Computer Use, and the first grant binds to an ad-hoc requirement: a rebuild that changes the binary requires granting again, which the `sources/` reuse limits to genuine source changes. Release packaging gains a gate it did not have — a release build without a staged helper stops before packing rather than shipping a package with an inert plugin. Both variants remain indistinguishable to the model; the provider and permission pages report whichever application it launches.
