---
kind: upgrade-guide
description: "A patent or legal citation whose paragraph or item numeral cannot be read is unrecognized instead of checked as the bare article."
---

# Malformed paragraph and item numerals are rejected

English | [中文](guide.zh.md)

## Change

`parseLawReference`, `parseLegalLawReference`, `law_verify`, and `legal_law_verify` used to drop a 款 or 项 numeral they could not read and check the remaining article. `专利法第22条第十十款`, a following `第十十项`, and `第（十十）项` therefore came back as a checked article or paragraph citation, and `narrowed` returned an empty object for an unreadable field. Those citations are now rejected: the parsers return null, and the tools list the fragment in `unrecognized` instead of a `valid` finding. `narrowed` returns null when a named field is not a positive integer, including `0`. A citation whose indexed entry simply omits `paragraphs` is unchanged.

## Migration

1. If a caller treated `专利法第22条第十十款` as article 22, read `unrecognized` and rewrite the numeral. A well-formed `第22条第3款` is unchanged.

2. If code spreads the result of `narrowed` into a reference, discard the citation when the result is null.

3. Confirm with `pnpm exec vitest run packages/law/law-core/tests/citation-text.spec.ts packages/patent/patent-law/tests/reference.spec.ts packages/legal/legal-law/tests/reference.spec.ts`.
