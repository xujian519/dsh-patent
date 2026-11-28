---
kind: upgrade-guide
description: "The shipped patent preset denies a filing or claims-spec render whose prerequisite checks read a different draft revision."
---

# Patent delivery gate enforces draft digest matches

English | [中文](guide.zh.md)

## Change

The shipped `patent` preset previously ran its delivery digest check in `shadow`: a `build_patent_filing` call, or a `claims-spec` render, whose `rule_check` / `validate_specification` evidence came from another draft revision was delivered anyway and only logged. It now runs `enforce`, so those calls are denied. The denial names the mismatched projection (`text`, `claims`, or `abstract`) and the prerequisite to re-run.

Sessions that edit a draft after running the checks and then deliver it without re-running them are now refused. Deliveries whose evidence already covers the draft being delivered are unaffected.

## Migration

1. In a patent session, after changing claims, specification, or abstract, re-run `rule_check` on the draft's specification projection and `validate_specification` with the same `text`, `claims`, and `abstract` projections, then call `build_patent_filing` or the `claims-spec` render again.
2. Confirm the gate: change one claim character, call `build_patent_filing` without re-running the checks, and expect a denial naming `claims`; re-run the checks and expect the delivery to succeed.
3. To keep observation only, set `deliveryGateDigestMode: shadow` on `@deepseek-ai/dsh-patent-rule` in the profile patch. That mode logs the mismatch; the log reaches compositions that export the logger.
