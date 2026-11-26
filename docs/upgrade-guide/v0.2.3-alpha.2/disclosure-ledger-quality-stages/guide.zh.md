---
kind: upgrade-guide
description: "披露链新增两个确定性账本阶段，并把 draft-review 的回退上限提高到三次，缺省阶段预算随之为 29。"
---

# 披露链逐条对账审查轮次并给出质量标量

[English](guide.md) | 中文

## 变更

`patent_disclosure_v1` 新增两个确定性阶段：紧跟 `draft_review` 的 `revision_ledger`（原子 `revision-ledger`），以及位于 `legal_gaps` 之后、`review_gate` 之前的 `draft_quality`（原子 `draft-quality-ledger`）。该 manifest 的阶段数由 27 提高到 29，调用模型的阶段仍为 14，因此插件配置缺省值改为 `workflowStageBudget: 29`（原 27）、`workflowLlmStageBudget: 14`（不变）。固定的预算低于该值时插件加载失败。

`draft_review` 的回退上限由两次提高到三次（`retry.maxRetries: 3`）；第四次执行仍有争议时该阶段保持 `draft_review_passed: false` 并继续向下走。

`draft_review` 每次执行都把当轮可执行争议点追加到 `_revision_ledger_rounds`，该状态键不写进任何原子的 `outputSchema`，因此回退清理不会删除它。`revision-ledger` 把各轮折叠为 `revision_ledger_summary`、`revision_ledger_report` 与 `revision_ledger_reconciliation`，逐条 finding id 判定已销账、仍存在或修订过程新增。`draft-quality-ledger` 依据 `spec_check`、`enablement-report`、`claim-breadth`、修订账本与 `legal-gaps` 的判定写出 `draft_quality_summary`、`draft_quality_report` 与 `draft_quality_matrix`：0–100 标量等于通过行数除以已判定行数，没有运行的门列为未评估而不计入通过；`slop_score` 只作信息行，通过线仍归 `slop-gate` 所有。

`patent_flexible_plan` 的可选原子新增 `revision-ledger` 与 `draft-quality-ledger`，内嵌该参数说明的已录工具 schema 期望在本变更后即已过期。

受影响的是运行 `patent_disclosure_v1`、固定其预算、读取阶段列表或 `revisions`、或比对已录工具 schema 的调用方。

## 迁移

1. 部署在 `@deepseek-ai/dsh-patent-tools` 下固定了 `workflowStageBudget` 的，提高到至少 29；`workflowLlmStageBudget` 保持 14。两项都不写即使用新缺省值。
2. 复制披露链的自定义 manifest：在审查阶段后加 `{ id: revision_ledger, atom: revision-ledger }`，在 `legal_gaps` 后加 `{ id: draft_quality, atom: draft-quality-ledger }`，并把 `draft_review` 的 retry `maxRetries` 同步为 3。两个新阶段都不声明 `retry`——回退所有权仍属于 `draft_review` 的类别级信号。
3. 读取 `revisions` 的工具：`draft_review` 最多出现三条 `applied` 记录加一条 `exhausted`。
4. 无需凭据即可刷新内嵌的原子目录：`pnpm run test:snapshot:refresh` 重放已录制的会话并重写各场景的期望输出，其中包括 `tool-schemas.expected.json`。只刷单个场景时运行 `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t <场景名>`。随后 `pnpm run test:snapshot` 复核该 pin。
5. 确认：干净的稿件以 29/29 阶段完成，`revision_ledger_summary` 写明没有未销账条目，`draft_quality_report` 列出五行判定。
