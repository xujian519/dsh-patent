---
kind: upgrade-guide
description: "一次 `lateMonths` 覆盖多个年度时，patent_fees 把滞纳金列为待补项。"
---

# 每个 `patent_fees` 调用只描述一个年度的超期

[English](guide.md) | 中文

## 变更

`patent_fees` 与 `computeFees` 过去把同一个 `lateMonths` 套到 `annuityYears` 的每个年度：以 `lateMonths: 3` 计价第 4、5 年度会得到两条 3 个月滞纳金，并把合计标为完整，尽管两个年度的应缴日相隔 12 个月。现在一次给出多个年度又带 `lateMonths` 时不再输出滞纳金行：报告在 `pending` 下列出 `annual-fee-late-payment`（需要各年度自己的 `lateMonths`）并扣留合计，各年度年费行照常计价。

## 迁移

1. 把带 `lateMonths` 的多年度 `patent_fees` 调用拆成每个超期年度一次，例如先 `annuityYears: [4], lateMonths: 3`，再 `annuityYears: [5], lateMonths: 1`。
2. 用 `pnpm exec vitest run packages/patent/patent-fees/tests/compute.spec.ts packages/patent/patent-fees/tests/deadline-consistency.spec.ts` 确认迁移完成。
