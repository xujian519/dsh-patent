---
kind: upgrade-guide
description: "A notice's designated length is rejected on the three kinds whose period the law fixes."
---

# `designatedMonths` is rejected on statutory notice periods

English | [中文](guide.zh.md)

## Change

`patent_deadlines`, and `evaluateDeadlines` beneath it, used to accept `notices[].designatedMonths` on every notice kind: a rejection decision delivered on 2026-01-05 with `designatedMonths: 1` produced a 2026-02-05 reexamination request deadline while the entry's label still said three months. A designated length now applies only to `office-action-first`, `office-action-subsequent`, `reexamination-notice`, and `invalidation-transfer`. `substantive-exam-notice` (专利法实施细则第57条第1款), `rejection-decision` (专利法第41条第1款), and `grant-notice` (专利法实施细则第60条第1款) start periods the law fixes, so a length on those kinds raises `DeadlineQueryError`, which the tool reports as `invalid_query` naming the article.

## Migration

1. Remove `designatedMonths` from every `notices` entry whose `kind` is `substantive-exam-notice`, `rejection-decision`, or `grant-notice`, in the prompts, fixtures, and case inputs that build a `patent_deadlines` call.
2. Confirm with `pnpm exec vitest run packages/patent/patent-deadline/tests/statutes.spec.ts packages/patent/patent-deadline/tests/tool.spec.ts`.
