---
kind: upgrade-guide
description: "专利预设在前台工作流审批门处直接询问审批服务，并拒绝自报 approveStageIds。"
---

# 专利工作流审批门改为运行中取用户决策

[English](guide.md) | 中文

## 变更

专利预设在 `@deepseek-ai/dsh-patent-tools` 上开启 `approveStageGates: true`。前台 `patent_workflow_run` 到达 `approval-gate` 时，改为向本部署的 `approval` 服务取一次用户决策，不再暂停等待再次调用。放行即继续运行；`rejected`、`cancelled`、`unavailable` 或 `never` 策略会带结果名暂停，结果写进工具返回值。

开关打开时，前台运行传入 `approveStageIds` 会以 `invalid_tool_input` 失败：该阶段 id 等于由模型自行声明放行。审批问题附带审批门阶段 `review_keys` 所列产出的限长摘要，放行决定能看到待确认正文。

后台运行（`run_in_background: true`）与关闭该开关的部署仍保持「暂停后用 `approveStageIds` 续跑」的契约；打开开关但未挂载 `approval` 服务的部署也按该契约运行。

受影响：使用专利预设的会话、打开该开关的部署，以及用 `approveStageIds` 续跑 manifest 的脚本或提示词。

## 迁移

1. 从前后台 `patent_workflow_run` 调用中去掉 `approveStageIds`，让审批门自行询问用户。

   ```diff
   - {"manifestId": "patent_oa_response_v1", "approveStageIds": ["approval"]}
   + {"manifestId": "patent_oa_response_v1"}
   ```

2. 只在后台运行，或部署关闭 `approveStageGates` 时保留该参数。
3. 用一份短 manifest 跑到审批门（例如 `patent_workflow_run` 传 `manifestId: patent_novelty_v1`），确认审批卡片写明待确认产出，且放行后整链完成。
