---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-drop-sidechat-source

English | [中文](2026-11-07-drop-sidechat-source.zh.md)

## Summary

Removes the `sidechat` message-source variant when the better-sidebar package is deleted (PR #677); the matching `agent/inbox/spliced` payload variant goes with it.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-drop-sidechat-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "7dcd8a0682388dd373f72f13dd3ebc31fcf9da171a7b9a82dda9f99002fa7872"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "766b4cd2d47296bfacf02e98bc81521d655231e9bd6ffb489a87cc6fc753d784"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "9c339be75bfb0f2c173d8236c80dbcbe0e6742f975050942b48616017c116d42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "8079fc9efc7399d170858c37bd0b50fa4f3b305bae63adfcf622496e29578eba"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New reader, old records: a persisted session may still contain `source.kind: "sidechat"` and an `agent/inbox/spliced` payload of that variant. `MessageSource` is a merge-extensible union, and its consumers test `kind` for equality against known values rather than switching exhaustively — `auto-review`'s source predicates and the `action-cards` projection both fall through, so message content, ordering, and the remaining attribution stay readable; such a message simply carries no special attribution any more. Old reader, new records: the removed variant is the only change, every surviving variant is byte-identical, so an older reader sees a subset of what it already understood. No discriminator changed, and nothing writes the removed variant.

<a id="verification"></a>
## Verification

pnpm --silent run persistence-review --before <inventory generated at the 2026-10-28-v022-alpha2-sync record> --after docs/persistence-schema.json --json: four roots changed, and every change traces to the removed variant. pnpm exec vitest run packages/core/session packages/llm/llm: passed.

<a id="dev-note"></a>
## Dev Note

None.
