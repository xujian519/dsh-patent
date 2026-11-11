---
kind: upgrade-guide
description: "专利或法律引用中无法读出的款号或项号不再按裸条核验：写在 text 里列入未识别片段，写在 references 里则是输入错误。"
---

# 无法读取的款号与项号会被拒绝

[English](guide.md) | 中文

## 变更

`parseLawReference`、`parseLegalLawReference`、`law_verify` 与 `legal_law_verify` 以前会丢掉读不出的款号或项号，只核验剩下的条。`专利法第22条第十十款`、其后的 `第十十项` 以及 `第（十十）项` 因此会作为已核验的条或款返回，`narrowed` 对读不出的字段返回空对象。这些引用现在被拒绝。解析器返回 null；被点名的字段不是正整数（含 `0`）时，`narrowed` 返回 null。写在 `text` 里时，工具不给出 finding，把片段列入 `unrecognized`，且该列表不会置 `blocked`。写在 `references` 里时，同一文本是输入错误（`unparsable_reference`），不会列入 `unrecognized`。片段只有落在已解析引用的跨度内才从 `unrecognized` 略去，因此已解析的 `第22条第3款` 旁边若还有 `第22条第十十款`，后者的 `第22条` 仍会列出。索引条目只是没有 `paragraphs` 时，判定不变。

## 迁移

1. 若调用方把 `专利法第22条第十十款` 当成第 22 条，重写数字。写法正确的 `第22条第3款` 不变。引用来自 `text` 时阅读 `unrecognized`。引用来自 `references` 时处理 `unparsable_reference` 错误。

2. 若代码把 `narrowed` 的结果展开进引用，结果为 null 时丢弃该引用。

3. 用 `pnpm exec vitest run packages/law/law-core/tests/citation-text.spec.ts packages/law/law-core/tests/citation-extract.spec.ts packages/patent/patent-law/tests/reference.spec.ts packages/patent/patent-law/tests/tool.spec.ts packages/legal/legal-law/tests/reference.spec.ts packages/legal/legal-law/tests/tool.spec.ts` 确认。
