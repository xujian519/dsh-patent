---
kind: upgrade-guide
description: "法定期间的三类通知不再接受通知书指定期限。"
---

# 法定期间的通知拒绝 `designatedMonths`

[English](guide.md) | 中文

## 变更

`patent_deadlines` 及其下的 `evaluateDeadlines` 过去对每种通知都接受 `notices[].designatedMonths`：一份 2026-01-05 送达的驳回决定配上 `designatedMonths: 1`，会算出 2026-02-05 的复审请求期限，而该行标签仍写着 3 个月。现在指定期限只适用于 `office-action-first`、`office-action-subsequent`、`reexamination-notice` 与 `invalidation-transfer`。进入实质审查阶段通知书（专利法实施细则第57条第1款）、驳回决定（专利法第41条第1款）与授权通知（专利法实施细则第60条第1款）起算的是法定期间，在这几类通知上给出指定期限会抛 `DeadlineQueryError`，工具侧回 `invalid_query` 并点名对应法条。

## 迁移

1. 在构造 `patent_deadlines` 调用的提示词、夹具与案件输入里，删除 `kind` 为 `substantive-exam-notice`、`rejection-decision` 或 `grant-notice` 的 `notices` 条目上的 `designatedMonths`。
2. 用 `pnpm exec vitest run packages/patent/patent-deadline/tests/statutes.spec.ts packages/patent/patent-deadline/tests/tool.spec.ts` 确认迁移完成。
