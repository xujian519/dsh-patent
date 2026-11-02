---
kind: upgrade-guide
description: "撰写链新增换位审查阶段：在审批门前最多回退两次重写，仍失败则交法条缺口与人工复核。"
---

# 撰写链在法条缺口前新增换位审查

[English](guide.md) | 中文

## 变更

`patent_disclosure_v1` 在 `slop_clean` 之后、`legal_gaps` 之前运行 `draft_review`（原子 `draft-review`），manifest 由 26 个阶段增至 27 个，模型调用阶段由 13 个增至 14 个；默认预算相应变为 27/14。

该阶段只读 `specification`、`claims_draft`、`pfe_triples`/`features` 与 `prior_art`，写入 `draft_review_report`、`draft_review_disputes` 与 `draft_review_passed`，并按争议类别各发一条 `RetrySignal`：充分公开、支持与修改依据回退到 `draft_specification`，清楚性回退到 `draft_claims`，单一性回退到 `claim_strategy`。最多允许两次回退。第三次执行仍发现争议时保留 `draft_review_passed: false`，经 `legal_gaps` 进入 `review_gate`，不再循环；`legal_gaps` 以 `revisionTarget: false` 的 warn 级检查项报告该失败。

受影响的是运行 `patent_disclosure_v1`、读取其阶段列表或 `revisions`、或固定阶段与模型预算的调用方。

## 迁移

1. 若显式设置了工作流预算，提高到至少 27 个阶段与 14 个模型调用阶段，或沿用新默认值。
2. 自定义 manifest 若复制披露链，加入 `atom: draft-review` 阶段及以下回退块：`whenRevisionRequested: true`、`rewindTo: draft_specification`、`maxRetries: 2`，路由为 `draft-review:enablement`/`support`/`amendment` → `draft_specification`、`draft-review:clarity` → `draft_claims`、`draft-review:unity` → `claim_strategy`。
3. 读取 `revisions` 的工具应按最多两条 `applied` 与一条最终 `exhausted` 处理该阶段；耗尽后阶段保留产出，不标记降级。
4. 确认：干净的披露稿以 27/27 阶段完成且 `draft_review_passed: true`；存在充分公开争议的草稿最多回退两次，随后到达 `review_gate`。
