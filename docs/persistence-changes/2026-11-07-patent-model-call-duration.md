---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-patent-model-call-duration

English | [中文](2026-11-07-patent-model-call-duration.zh.md)

## Summary

Adds an optional `durationMs` to `patent/model-call`: the wall-clock time the model stream took, from request to its last event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-patent-model-call-duration
baseline: false
changes:
  - root: "event:patent/model-call"
    previous: "2026-09-21-patent-model-call"
    after: "51f9e4dc4f832e4da517baeacb732861e29ccd1a08290c18a449e5dd2a03f9e2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The field is optional and additive. Old records read by new code simply lack it, and a missing value means unmeasured, distinct from a measured `0` (under one millisecond), so no reader can mistake an unmeasured call for an instant one. New records read by older code carry one extra JSON property that such a reader does not name and therefore ignores; no existing field changes meaning, and the discriminator (`llmStreamCall`) is unchanged. Replay normalization deletes the field, so keyless snapshots compare equal without re-recording.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/patent/patent-workflow/tests/model-call-log.spec.ts: 8 tests passed, including a 30 ms delayed port asserting the recorded value is a whole number of at least 20. pnpm run test:snapshot -t patent: 11 passed without re-recording; removing the normalization rule reproduced 5 failures, which shows the drop rule is what keeps the goldens stable.

<a id="dev-note"></a>
## Dev Note

None.
