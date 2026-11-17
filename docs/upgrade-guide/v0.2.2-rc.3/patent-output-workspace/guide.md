---
kind: upgrade-guide
description: "Unset patent note, figure, and chemistry output paths resolve from the deployment workspace root instead of the process directory."
---

# Patent output paths use the workspace root

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-patent-tools` used to place an unset `noteDir`, `figureIndexFile`, `chemistryIndexFile`, or `figureOutputDir` under `process.cwd()`, and it resolved a relative value against that directory. Those four paths now use `sandboxPolicy.workspaceRoot`. An absolute Config value is unchanged. Plugin load throws `setup_required` when a path still needs a root and the service is absent, the root is empty, or the root is not absolute. A profile that already sets `workspaceRoot` to the process directory keeps the same locations.

## Migration

1. In `cordis.yml`, set the `sandbox-policy` plugin's `workspaceRoot` to the absolute directory that should hold `99-知识库`, `.sati/figures-index.json`, `.sati/chemistry-index.json`, and `patent/figures`. A profile that already sets this key needs no new patent-tools key.

2. A relative value of one of those four keys is now relative to that workspace root. Set an absolute path to keep a location that used to follow the process directory.

3. Confirm with `pnpm exec vitest run packages/patent/patent-tools/tests/wiring-composition.spec.ts -t '输出路径'`.
