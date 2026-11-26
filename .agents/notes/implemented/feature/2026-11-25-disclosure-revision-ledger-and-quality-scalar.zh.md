# Agent Note: 逐条对账换位审查轮次并确定性给披露链打质量分

Status: implemented

[English](2026-11-25-disclosure-revision-ledger-and-quality-scalar.md) | 中文

## Problem

`patent_disclosure_v1` 的审查员回合（`draft_review`）原本只允许两次回退，但没有任何地方记录每轮提出过哪些争议点。运行只保留最后一轮的 `draft_review_disputes`，于是三种截然不同的历史在报告里长得一样：第二轮就修掉的争议点、从未被处理的争议点、修订本身引入的新争议点。`legal_gaps` 与 `review_gate` 处的人工复核只能看到审查未通过，看不到还剩哪几条没解决。

五个撰写门禁也没有统一的读数。`spec_check`、`enablement_report`、`claim_breadth`、`legal_gaps` 与换位审查各写各的判定键，调用方要么逐个读，要么问 `patent_eval`——而它的 rubric 分数把模型判断和确定性判定混在一起。没跑过的门与通过了的门无法区分。

## Decision

`draft-review` 把每轮可执行争议点追加进 `_revision_ledger_rounds`（`packages/patent/patent-core/src/draft-review/findings.ts`）。该键刻意不出现在 `draftReviewAtom.outputSchema` 里：[回退清理](../bug-fix/2026-09-20-rewind-clears-atom-output-keys.zh.md) 只删 stage-id 键与已声明的输出键，未声明键因此跨回退保留，与 `slop_revision_hint` 用的是同一条机制。前导下划线还让这条记录不进入会写进提示词的 state 文本。

id 分两层。`RetrySignal.gapId` 保持类别级（`draft-review:unity`），因为 `retry.routes` 按类别映射阶段。finding id 在此基础上加定位——`draft-review:enablement:claim1`、`feat-<id>` 或 `doc`——不含 anchor，因为模型每轮重新摘录那句话，措辞变化否则会被读成新问题。

`revision-ledger` 只运行一次，位置在审查循环收敛之后。发出回退信号的那一轮会在下游阶段执行前返回，所以账本运行时已经看到循环的全部轮次。它逐条报告已销账、仍存在、修订过程新增，并在汇总里区分「审查没标记任何问题」与「标记过的问题已全部销账」。

`draft-quality-ledger` 位于 `legal_gaps` 之后，把五门判定折叠成矩阵加一个只对已判定行计算的 0–100 标量。信号缺失或类型不符即判未评估并原样列出，未运行的门既不能抬高分数也不会被读成通过。`slop_score` 只作信息行：通过线仍归 `slop-gate` 所有。

两个新阶段都不调用模型、都不声明 `retry`；调用模型的阶段预算保持 14，阶段预算提高到 29。`draft_review.maxRetries` 由 2 提高到 3，依据正是这份账本——多出的那一轮只有在结果能逐条核验时才值回它的成本。

## Alternatives considered

**把账本键声明进 `outputSchema`。** 否决：那会把它放进回退清理集合，删掉的恰好是该阶段存在的理由——跨轮证据。

**给 `clearStageOutputs` 加保留名单。** 否决：为一个消费者改动共享的回退语义，而未声明键跨回退存活早就是其它修订提示依赖的既有机制；此后每个需要跨回退持久化的原子都得再去改那份名单。

**按 finding 而不是按类别路由重写。** 否决：重试表把类别映射到阶段，规模稳定，而 finding id 随模型输出增长；按 finding 发信号等于让一次模型回答就能扩大重试面。

**让模型自己说明上一轮哪些问题已解决。** 否决：该分类就是 harness 已经算好的 id 集合做差集，多一次调用只增加成本，还可能与自己拿到的 id 相矛盾。

**扩展 `patent_eval` 的 rubric 分数。** 否决：那是模型判分，而撰写链的这个数必须能从已记录的阶段输出复算出来。

**把两个原子合成一个阶段。** 否决：`legal_gaps` 夹在两者之间且自带反哺回退，质量折叠必须排在它之后随其重跑，而账本要留在它上游读审查判定。

## Consequences

一次披露运行会报告它起始于哪些争议点、销掉了哪些、修订又引入了哪些，审批门处则有一条质量读数说明哪些门从未评估。阶段序列与预算已变，记录在[升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.2/disclosure-ledger-quality-stages/guide.zh.md)；`patent_flexible_plan` 的原子目录新增两项，已录的工具 schema 期望随之重录。

`revision_ledger` 依赖 `draft-review` 确实运行过：没有轮次记录时它报告审查循环未执行，而不是把缺席当作通过。`draft-quality-ledger` 同样列出未评估行，而不是给一个零分。

## Testing

`packages/patent/patent-core/tests/draft-review-atom.spec.ts` 锁定账本键不在 `outputSchema`、首轮只记录可执行争议点、修订轮追加第二条并把上一轮问题写进提示词、记录在 14 轮处截断、降级轮不追加。

`packages/patent/patent-core/tests/revision-ledger.spec.ts` 与 `packages/patent/patent-core/tests/draft-quality-ledger.spec.ts` 覆盖对账结果、报告文本与畸形信号降级。`packages/patent/patent-workflow/tests/revision-ledger-loop.spec.ts` 用打桩的改稿阶段跑真实的 `draft-review` 回退循环，断言清理之后下游阶段仍读到两轮记录。
