---
kind: upgrade-guide
description: "专利或法律引用中无法读出的款号或项号不再按裸条核验，改为列入未识别片段。"
---

# 无法读取的款号与项号会被拒绝

[English](guide.md) | 中文

## 变更

`parseLawReference`、`parseLegalLawReference`、`law_verify` 与 `legal_law_verify` 以前会丢掉读不出的款号或项号，只核验剩下的条。`专利法第22条第十十款`、其后的 `第十十项` 以及 `第（十十）项` 因此会作为已核验的条或款返回，`narrowed` 对读不出的字段返回空对象。这些引用现在被拒绝：解析器返回 null，工具把片段列入 `unrecognized`，不再给出 `valid`。被点名的字段不是正整数（含 `0`）时，`narrowed` 返回 null。索引条目只是没有 `paragraphs` 时，判定不变。

## 迁移

1. 若调用方把 `专利法第22条第十十款` 当成第 22 条，改为阅读 `unrecognized` 并重写数字。写法正确的 `第22条第3款` 不变。

2. 若代码把 `narrowed` 的结果展开进引用，结果为 null 时丢弃该引用。

3. 用 `pnpm exec vitest run packages/law/law-core/tests/citation-text.spec.ts packages/patent/patent-law/tests/reference.spec.ts packages/legal/legal-law/tests/reference.spec.ts` 确认。
