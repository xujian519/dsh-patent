---
kind: upgrade-guide
description: "patent_disclosure_v1 在 draft_claims 前新增带原文锚点的 claim_strategy 阶段；draft_claims 改为按策略表确定性成文，不再接受自由撰写路径。"
---

# 先定权利要求策略，再成文

[English](guide.md) | 中文

## 变更

`patent_disclosure_v1` 现在在 `report` 与 `draft_claims` 之间运行 `claim_strategy`（原子 `claim-strategy`）。该阶段写入 `claim_strategy`（JSON）与 `claim_strategy_report`：必要特征表、可选特征表、从权树与最接近现有技术编号。每条特征都带一段交底书原文摘录，由锚点校验器复核；摘录未命中交底书，或 `prior_art_ref` 未出现在新颖性结论/已过滤文献中，都会使阶段失败——既不会降级成空表，也不会编造文献编号。调用方可向 state 注入 `confirmed_features` 直接提供该表；阶段按同一路径校验后使用，不再调用模型。

`draft_claims` 不再让模型自由撰写权项全文。它读取 `claim_strategy`，调用确定性 `draftClaims` 引擎渲染独立权利要求与多路从权树，并保持独权文本固定；从权专员只能重排或补充从权。任一 `claim_lint` error 否决本轮草稿，`claims_draft` 不会被半成品覆盖。`draft_claims_result` 改为 JSON 记录（策略表编号、从权专员状态、形式违规、lint 发现与权利要求）；说明性文字不再进入 `claims_draft`。

`confirmed_features` 接受与模型输出同构的形状：`essential_features` 与 `optional_features` 数组（每项需 `id`、`text` 与从交底书复制的 `anchor`），以及可选的 `dependent_tree` 与 `prior_art_ref`。

该阶段把特征表、从权树与权利要求草稿写入 `review_context`，披露 manifest 的 `review_gate` 不再设置静态 `review_context` 参数。manifest 由 25 个阶段增至 26 个，模型调用阶段由 12 个增至 13 个；默认 `workflowStageBudget` / `workflowLlmStageBudget` 由 25/12 提高到 26/13。

确定性引擎从 `@deepseek-ai/dsh-patent-tools` 迁入 `@deepseek-ai/dsh-patent-core`（`draftClaims`、`validateClaims`、`claimCountViolations`、`DOMAIN_KEYWORDS`）。工具包继续导出同名符号，模型可见的 `draft_claims` 工具保持原 schema、输出与互斥输入的 `invalid_tool_input` 错误。

## 迁移

1. 部署显式设置 `workflowStageBudget` 或 `workflowLlmStageBudget` 时，至少提高到 26 与 13，否则插件加载会拒绝 `patent_disclosure_v1`。
2. 自定义 manifest 若运行 `draft-claims`，必须在它之前放入 `claim-strategy` 并把 `claim_strategy` 接入 state；缺少时 handler 直接降级。
3. 不要再把 `draft_claims_result` 当自由文本解析。读取 JSON 记录，或继续用 `claims_draft` 取渲染后的权利要求。
4. 原先通过 `draft-claims` 的提示词输入（`merge_result`、`novelty_conclusion`、`slop_revision_hint`）提供权项文本的调用方，改为提供 `claim_strategy`，或注入 `confirmed_features` 交给 `claim-strategy` 建表。
5. 重录固定 `patent_workflow_run` / `patent_flexible_plan` 工具描述的快照，并复核运行输出中的新阶段行。
