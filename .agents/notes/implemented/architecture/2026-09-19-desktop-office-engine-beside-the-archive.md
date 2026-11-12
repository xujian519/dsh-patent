# Agent Note: Deliver the Office engine beside the Desktop archive

Status: implemented

English | [中文](2026-09-19-desktop-office-engine-beside-the-archive.zh.md)

## Problem

Office previews failed in the packaged Desktop application. Every conversion returned `document-render/failed` with reason `unavailable`, which the right Sidebar renders as "Office previews are unavailable. Enable the document preview service on the computer running DeepSeek Harness", and a source install of the same version converted the same documents.

The [Office conversion provider](../../../../packages/document/office-kit/README.md) delegates rendering to `@deepseek-ai/libreoffice-kit`, whose `resolveEngine` and `engineAsset` resolve the engine package with `require.resolve('@deepseek-ai/libreoffice-kit-<target>/package.json')` and then treat every path below that package root as an ordinary file tree. In the Desktop package that root is `resources/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit-<target>`:

- `stat()` on any path inside `app.asar` returns Electron's synthetic archive mode, so `bin/libreoffice-kit` reads as `0644` and the kit's executable check (`mode & 0o111`) rejects the engine before conversion starts. Marking the file unpacked does not change that: `@electron/asar` writes `unpacked` entries without the `executable` header flag, and Electron does not stat the unpacked twin for an archive path.
- The kit spawns `bin/libreoffice-kit` with `--program-directory <engine>/program/...`. That helper is a separate native process with no archive support, so an archive path names a LibreOffice tree it cannot open.

Both facts belong to addressing files through `app.asar`, so no unpack pattern can restore Office previews while the engine is packed.

## Decision

The Desktop package excludes the engine package from both runtime mappings and delivers it beside the archive at `resources/node_modules/@deepseek-ai/libreoffice-kit-<target>`. Every other runtime package stays in `app.asar/dsh`.

Node's resolution from a module inside the archive reaches that directory, because the ancestor walk of `app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js` includes `Contents/Resources/node_modules`. The kit therefore loads the engine as ordinary files: the helper reports its real `0755` mode, its executable path is a real path, and the LibreOffice tree it reads is a real directory. The macOS signer ignores the new location, because runtime preparation signs those files before packaging, and the installed-update verifier reads the packaged runtime as the archive's `dsh` tree plus the packages under `resources/node_modules`, so a beside-archive package keeps participating in the frozen-input comparison and its executables still reach signature re-verification.

## Alternatives considered

**Unpack the whole engine beside the archive and keep it packed.** Rejected by measurement: the archive path still reports `0644`, and the spawned helper would still receive an archive path for `--program-directory`.

**Map archive paths to `app.asar.unpacked` inside the kit.** Rejected for this change: engine resolution and engine paths are the kit's ownership, and the [kit ownership decision](2026-09-14-independent-libreoffice-kit.md) keeps engine fixes on its own release cycle, so a Desktop fix cannot wait for a kit release. The measured facts above are the input to such a kit change.

**Deliver the whole runtime beside the archive (`resources/dsh`).** Rejected: it removes the archive address space for every runtime file, which diverges from upstream's package layout far beyond the one package that needs it, and the archive's integrity check still covers the rest of the tree.

**Redirect resolution in the Host process.** Rejected: patching `Module._resolveFilename`, adding `NODE_PATH`, or shimming `fs` would make the engine a hidden exception in a process-wide seam and still leave the helper a non-archive path contract to honour.

## Consequences

Office previews work in the packaged application; source installs are unchanged.

The engine package leaves the archive's integrity record. It remains a signed runtime file on macOS, stays in the runtime descriptor's final inventory, and is compared against prepared inputs by the installed-update verifier.

The fork diverges from upstream in the two `files` filters, the `resources/node_modules` mapping, the macOS signer's ignore list, and the beside-archive handling both verifiers apply: the runtime inventory comparison and the Windows ASAR unpack check. The engine resolves through Node's parent-directory walk out of the archive, so a future Electron or Node change to archive-path resolution would invalidate the placement before it invalidated anything else.

## Testing

`npx vitest run apps/desktop/tests/macos-signature.spec.ts apps/desktop/tests/installed-update-package-content.spec.ts` pins the exclusion filters, the resource mapping, the signer's ignore entry, and the runtime comparison for a package delivered beside the archive, including changed bytes and a missing package.

`npx vitest run apps/desktop/tests/windows-asar-unpack.spec.ts` pins the same placement for Windows PE files: the unpack check accepts the engine the archive omits while its prepared bytes sit unchanged beside the archive, and still rejects an inline, linked, absent, or changed file.

A packaged macOS arm64 directory build (unsigned, `electron-builder --dir` over the prepared target tree) converts a real DOCX through the packaged kit under `ELECTRON_RUN_AS_NODE=1`: the engine resolves to `Contents/Resources/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64`, and the conversion produces the same 355612-byte PDF as the repository's own engine. The pre-change package reports `Installed LibreOfficeKit executable is not executable` for the same probe.

## Related

- [Node Office conversion with independently packaged engines](../../archived/architecture/2026-09-11-node-office-kit.md) — the kit boundary this placement serves.
- [Independent LibreOffice kit ownership](2026-09-14-independent-libreoffice-kit.md) — why engine-path handling belongs to the kit.
- [Electron desktop packaging and updates](2026-08-25-electron-desktop-packaging-and-updates.md) — the release layout this change extends.
