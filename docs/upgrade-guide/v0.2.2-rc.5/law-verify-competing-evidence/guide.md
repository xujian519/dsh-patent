---
kind: upgrade-guide
description: "law_verify reports a paraphrase as undecided instead of mismatch, and the competing-entry helper is renamed."
---

# A shared topic word no longer proves a citation wrong

English | [中文](guide.zh.md)

## Change

`law_verify` and `legal_law_verify` reported 与所引命题不符 when another entry shared one topic keyword with the proposition. That misread an overview-style paraphrase as a wrong reference: a claim about one article commonly contains 申请日, 申请人, or 申请文件, each of which is a topic of several other entries. A mismatch now requires positive evidence. Another entry must carry the claim with its transcribed text, or with a topic keyword that names at least a quarter of the proposition; a citation narrowed to a paragraph or item is contradicted only by another entry's transcribed text. The reason quotes the carrying text or topic keyword, so a wording problem is distinguishable from a wrong reference. A paraphrase or one compound proposition shared by several citations now comes back 未与条文对应（未判定） and warns instead of blocking.

The same change renames a helper in the published packages `@deepseek-ai/dsh-law-core` and `@deepseek-ai/dsh-patent-core`: `findCompetingLabels(entries, index, proposition, threshold, cited, covered?)` returned `string[]`; `findCompetingEntries(...)` returns `PropositionCarrier[]`, each with `label`, `textBacked`, and `evidence`. `supportMismatchReason(law, proposition, elsewhere)` now takes those carriers instead of label strings.

No configuration key or decision vocabulary changes. `onMismatch` and `onUnmatched` keep their meaning and defaults.

## Migration

1. In code that calls `findCompetingLabels`, call `findCompetingEntries` and read `.label` where the old result was a string list. Use `.textBacked` to tell a transcribed-text carrier from a topic-keyword carrier, and `.evidence` for the sentence a reason should quote.
2. Pass the returned carriers to `supportMismatchReason`; a caller that passed labels must build `{ label, textBacked, evidence }` objects instead.
3. In prompts and skills that handle 与所引命题不符, rewrite the citation only after reading the quoted evidence. Treat 未与条文对应（未判定） as a wording or compound-proposition gap: pass one proposition per citation and follow the cited text's wording, then verify again.
4. Confirm the migration with `pnpm exec vitest run packages/law/law-core packages/patent/patent-law packages/legal/legal-law` and `pnpm run typecheck`.
