---
kind: upgrade-guide
description: "@deepseek-ai/dsh-patent-tools 在 approveStageGates 开启时拒绝任何运行方式的 approveStageIds，包括后台运行。"
---

# 后台工作流不再接受自报的审批放行

[English](guide.md) | 中文

## 变更

`approveStageGates: true` 时，`patent_workflow_run` 现在对任何运行方式都拒绝非空的 `approveStageIds`。后台运行原先保留「暂停后用 `approveStageIds` 续跑」的契约；现在它与无应答者的前台运行一样，在审批门暂停，模型不能通过改传 `run_in_background: true` 自行放行审批门。`approveStageGates` 关闭的部署保持原契约。

受影响：在开启审批服务的部署里启动后台工作流、再用 `approveStageIds` 继续的调用方。

## 迁移

1. 从后台调用中去掉 `approveStageIds`。运行会在 `approval-gate` 阶段暂停并报告阶段 id。

2. 改在前台重跑工作流，让审批门向本部署的 approval 服务取用户决策，并在那里放行或拒绝。

3. 如果该部署本来就不设人工审批步骤，在 `patent-tools` 的配置里设 `approveStageGates: false`，`approveStageIds` 会重新被接受。

4. 用一次不带 `approveStageIds` 的后台调用确认：运行在审批门暂停而不是跑完；带自报列表调用时，错误信息包含 `approveStageIds 不再作为放行依据`。
