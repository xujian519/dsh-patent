---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-patent-model-call-truncated

English | [中文](2026-11-17-patent-model-call-truncated.zh.md)

## Summary

Adds optional truncated to patent/model-call when the model stream does not finish.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-patent-model-call-truncated
baseline: false
changes:
  - root: "event:patent/model-call"
    previous: "2026-11-07-patent-model-call-duration"
    after: "c53e3ced83c58e024f03a2d8aeb314be89a5cd76477737ce55d9a3e45eac46ec"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Old records omit truncated. New readers treat absence as a completed call, which is how those records were written. A new record may add truncated: true and still carries output as the text yielded before the stream settled. Older readers that ignore unknown properties still load the event and may treat that output as a full response. Current replay does not: it yields the prefix and then throws, so the prefix is not a normal stop. No existing field changes type, and llmStreamCall is unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/patent/patent-workflow/tests/model-call-log.spec.ts and packages/test-support/llm-replay/tests/llm-replay.spec.ts: 162 tests passed. model-call-log.ts and llm-replay/src/index.ts coverage is 100%.

<a id="dev-note"></a>
## Dev Note

None.
