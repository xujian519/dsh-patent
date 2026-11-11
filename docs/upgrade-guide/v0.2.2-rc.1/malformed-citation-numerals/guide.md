---
kind: upgrade-guide
description: "A patent or legal citation whose paragraph or item numeral cannot be read is unrecognized in text, and an input error in references, instead of checked as the bare article."
---

# Malformed paragraph and item numerals are rejected

English | [中文](guide.zh.md)

## Change

`parseLawReference`, `parseLegalLawReference`, `law_verify`, and `legal_law_verify` used to drop a 款 or 项 numeral they could not read and check the remaining article. `专利法第22条第十十款`, a following `第十十项`, and `第（十十）项` therefore came back as a checked article or paragraph citation, and `narrowed` returned an empty object for an unreadable field. Those citations are now rejected. The parsers return null, and `narrowed` returns null when a named field is not a positive integer, including `0`. Passed in `text`, the tools leave the citation out of the findings and list its fragments in `unrecognized`; that list does not set `blocked`. Passed in `references`, the same text is an input error (`unparsable_reference`) and is not listed in `unrecognized`. A fragment is omitted from `unrecognized` only when its span lies inside a citation the parser resolved, so a later `第22条第十十款` still lists `第22条` beside a resolved `第22条第3款`. A citation whose indexed entry simply omits `paragraphs` is unchanged.

## Migration

1. If a caller treated `专利法第22条第十十款` as article 22, rewrite the numeral. A well-formed `第22条第3款` is unchanged. When the citation arrives in `text`, read `unrecognized`. When it arrives in `references`, handle the `unparsable_reference` error.

2. If code spreads the result of `narrowed` into a reference, discard the citation when the result is null.

3. Confirm with `pnpm exec vitest run packages/law/law-core/tests/citation-text.spec.ts packages/law/law-core/tests/citation-extract.spec.ts packages/patent/patent-law/tests/reference.spec.ts packages/patent/patent-law/tests/tool.spec.ts packages/legal/legal-law/tests/reference.spec.ts packages/legal/legal-law/tests/tool.spec.ts`.
