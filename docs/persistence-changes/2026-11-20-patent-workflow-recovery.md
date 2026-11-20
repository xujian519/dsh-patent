---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-20-patent-workflow-recovery

English | [中文](2026-11-20-patent-workflow-recovery.zh.md)

## Summary

Adds an optional recovery point to interrupted patent workflow-run events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-patent-workflow-recovery
baseline: false
changes:
  - root: "event:patent/workflow-run"
    previous: "2026-10-24-adversary-review-input-scope"
    after: "7167c69150588529dd8be7754bd3066d77bf7331a2c8756e7b8e4d687ce67f02"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records without recovery remain valid. Completed runs omit the field, and readers that do not resume can ignore it. Resume uses the field only after validating the manifest, case type, completed stage prefix, and interrupted stage.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/patent/patent-workflow/tests/workflow-recovery.spec.ts packages/patent/patent-workflow/tests/workflow-store.spec.ts packages/patent/patent-tools/tests/patent-workflow-run.spec.ts: 3 files and 102 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
