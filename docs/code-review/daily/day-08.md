# Day 8 — 2026-11-22

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-22）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：专利域-3：patent-workflow、patent-teams、patent-document、patent-filing
- 时间盒：90 分钟
- 预期产出：A 维度专利域候选发现；daily/day-08.md

## 检查项

- [x] 检查 HITL 审批是否可被绕过或伪造。
- [x] 检查团队 mailbox、任务板的身份与权限边界。
- [x] 检查文档渲染的模板注入与路径穿越。
- [x] 检查立案组装的输出目录与覆盖行为。
- [x] 记录候选发现与证据。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 追审批接线 | `wiring.ts:450` 的 `approveStageGates === true`、`LiveApprovalGateHandler`、`isBlockedResult`，以及 `patent-workflow-run.ts:442/446` 的拒绝条件 |
| 追状态机 | `plantask.ts` 的 `TRANSITIONS` 与 `patent_plan_task` 的无状态 `transition` 动作 |
| 查团队身份 | `service.ts` 的 `sendMessage` 身份校验、`member-runtime.ts` 的 `captainTeam`、成员更新的 `attempt_id` |
| 查模板注入 | `templateResolver.ts` 的白名单校验、`escape.ts` 与 `templateDraft.ts` 的槽位注入 |
| 查输出路径 | `outputName`/`outputDir`/`brandPath` 三处校验，以及 `build_patent_filing` 的目录约束 |

## 发现

- **F-PAT-018**（High，A）：后台运行接受模型自报的 `approveStageIds`，模型可选 `run_in_background` 绕过人工审批门；交付前置门禁只要求本会话成功跑过一次 `patent_workflow_run`，自批的收口记录同样满足。

定向结论中确认已处理、不立发现的项见 [05-findings.md](../05-findings.md) 的「Day 8 定向结论」。

## 假设验证/推翻

- 本条发现不落在 Day 1 的 10 条假设上。H05 覆盖的是「输入到危险汇点」，而这里是「审批决策的证明来源」——建议在 Day 41 复盘时补一条 H11：**高风险决策的证据必须由代码核对，不能由模型自报**。
- H07：本轮未扩大；`patent-law` 的 fail-open 默认值在 Day 7 已确认被渲染门禁覆盖。

## 未决问题

1. 后台续跑如果改成「到门即暂停」，长任务的后台体验会退化；替代方案是由审批服务在回合内签发一次性凭据，需要和 `dsh-user-approval` 的接口能力对齐后再定。
2. `patent_plan_task` 的无状态 `transition` 会把 `awaiting_approval → executing` 判为合法并返回 `ok`，虽然它不是权威状态机，但模型可能据此认为审批已通过。是否要在结果里加「仅供参考，不代表已获批」的标记，留到 Day 38。
3. `build_patent_filing` 重名输出会覆盖上一版成品；目前靠 `matter_log_append` 的纪律记录版本，没有执行点强制。留到 Day 39 评估是否需要版本号或拒绝覆盖。

## 明日第一件事

Day 9：文档模式，检查 `office-kit` 的子进程 argv、临时目录与清理，`docx-kit` 的 ZIP 解压路径穿越与大小限制，`doc-template` 的变量替换与 HTML/Markdown 注入。
