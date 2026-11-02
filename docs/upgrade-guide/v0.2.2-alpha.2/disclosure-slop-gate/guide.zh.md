---
kind: upgrade-guide
description: "patent_disclosure_v1 的 slop_clean 改为评说明书正文并只报告；确定性权利要求不再回退重跑。"
---

# 披露链的反套话门改评说明书

[English](guide.md) | 中文

## 变更

`patent_disclosure_v1` 的 `slop_clean` 不再评 `claims_draft`，改为 `params: { text_keys: ['specification'] }`，并删除 `retry`。此前该阶段在「需修订」时回退到 `draft_claims`，最多重跑一次；而披露链的权利要求由 `draft_claims` 按策略表确定性渲染，重跑同一份策略表不会改变文本或分数，第二次失败必然产生 `[WORKFLOW_RETRY_EXHAUSTED]`，把 `completed` 判成 false。

权利要求文本天然缺少意见陈述书的争点开头与引证段落，面向答复正文的 directness/evidence 维度最高只能到 34 分（通过线 35），因此该门在旧配置下对披露链恒不可满足。现在它评的是说明书正文；未通过只在 `slop_report` / `slop_score` 里报告，不再阻断交付，`degradedSteps` 也不再列出 `slop_clean`。权利要求的形式与范围仍由 `draft_claims` 的 `claim_lint`、`claimCountViolations` 与 rubric 维度把关。

受影响的是运行 `patent_disclosure_v1` 的调用方：阶段总数仍为 26，模型调用阶段仍为 13，仅 `slop_clean` 的输入与失败语义变化。

## 迁移

1. 自定义 manifest 若复制了披露链的 `slop_clean` 配置，同步改为 `text_keys: ['specification']` 并删除 `retry`；继续评权项草稿时，门在标准权项文本上无法达到 35 分。
2. 原本把 `slop_clean` 的降级或 `[WORKFLOW_RETRY_EXHAUSTED]` 当作阻断信号的工具，改为读取 `slop_report` 与 `slop_score`；`completed` 不再因该阶段为 false。
3. 需要保留硬阻断的调用方，从运行记录读取 `slop_score` 自行判定；`legal_gaps` 与 `review_gate` 都不消费该键，自定义 manifest 要自己补这一步。
4. 确认：说明书总分低于 35 时，运行仍以 26/26 阶段完成，`degradedSteps` 为空，`slop_clean` 输出含「需修订」。
