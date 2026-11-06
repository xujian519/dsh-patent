---
kind: upgrade-guide
description: "OA 链路在 `draft` 与 `slop_gate` 之间新增模型阶段 `tighten`：正文先压进篇幅预算、再按字数机械核对，下游改读 `draft_tightened`。"
---

# 答复正文先压进预算，再受检查

[English](guide.md) | 中文

## 变更

`patent_oa_response_v1` 由 14 个阶段增至 15 个：`tighten` 紧跟 `draft`、排在 `slop_gate` 之前；它调用模型，故模型阶段由四个增至五个。

```ts ignore-check
{ id: 'tighten', atom: 'tighten',
  params: { text_key: 'draft', plan_key: 'response-plan', char_budget: OA_RESPONSE_DRAFT_BUDGET.total } }
```

本阶段读已写完的正文（`text_key`，缺省 `draft`）、答复计划（`plan_key`，缺省 `response-plan`）与预算，写三个键：`draft_tightened`、`tighten_report`（逐条删除项：删了什么、为什么可删）、`tighten_violations`。

它与「只靠提示词的润色」不同：不采信模型对自己工作的说明。判定用 `visibleChars`——反套话门用的同一口径，现已从 `slop-engine.ts` 导出，两处不会再各算一套——分别数删减前后。结果比输入短且在预算内才算通过。正文为空、反而变长、或仍超预算，一律转 `[WORKFLOW_DEGRADED]` 并写明还差多少字；超预算一项另写 `tighten_violations`。自称「已删减」而一字未减的，不算删减。正文本来就在预算内时原样交付，不调用模型。

提示词很窄：只删不写，不新增论证、不改写结论、不动事实编号（F/P）、规则编号（R）、证据标号与段落号；保留节序，某节删空则整节删除，不留占位句。删减顺序为：复述审查意见 → 复述法条原文 → 与争点无关的事实 → 同一论点的第二遍表述。

格式只做容错，不做强制：`{ tightened, removed }` 对象按原样采用，只交正文也收，此时报告如实写明清单缺失。算数的只有字数。

下游读取位置随之移动：门判 `draft_tightened`，`response_check` 取 `response_key: 'draft_tightened'`，`adversary-review` 依次读 `draft_tightened`、`draft`、`final_draft`。三者都留了回落——`tighten` 降级时损失的是删减，不是检查。

## 迁移

1. 任何数这条链路阶段数的地方——看板、快照期望、`workflow status`——现在看到 15 个阶段、5 个模型阶段。两个快照场景均已重录，回放会变。
2. 自己的 manifest 不会自动获得 `tighten`：在 `draft` 之后补这一阶段，或用 `text_key` 指向自己的键。
3. 若你在下游读 `draft`，改为读 `draft_tightened` 并保留 `draft` 作回落；本阶段降级是正常情形。
4. 阶段降级不等于运行失败：流程以 `draft` 代 `draft_tightened` 走完。读 `tighten_violations` 看残留超标多少，再改造成超标的那一节。
5. `char_budget` 取自 `OA_RESPONSE_DRAFT_BUDGET.total`（4000 可见字符，初版标定值）。要改就改那里，不要按案调；`patent-oa-slot-quotas` 的槽位配额也由同一张表推导。
