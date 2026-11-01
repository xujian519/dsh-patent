# Agent Note: 工作流阶段法律指引与结构化复核结论

Status: implemented

[English](2026-09-03-patent-stage-guidance-and-checker-verdict.md) | 中文

## Problem

Mady 提示词系统对比揭示了专利域的两个落点缺口。其一，Mady 任务模板的法律操作深度（驳回类型解析表、三步法边界条件、禁止反悔与捐献规则等）无处安放：manifest 的无 atom 阶段由仅基于 `stage.description` 构建的通用提示词执行，逐阶段的法律框架无法声明为数据。其二，checker 层 worker 返回自由文本，下游门禁无法机读复核结论——尽管 patent-core checker 引擎聚合出的三级结论与模板词表本就同构。

## Decision

- `WorkflowStage` 新增可选 `guidance` 字段（校验非空）。通用收口阶段执行器（dsh-patent-tools 的 `createChainStageExecutor`）将其拼接在阶段描述与输入材料之间。指引文本以类型化数据的形式放在 `manifests.ts`；不引入模板注册表，也不引入触发词路由。后续 manifest（OA 答复、创造性、侵权）经此字段承载源自 Mady 的法律框架。
- 复核结论解析器未随包交付。`#655` 删除了 `checker-verdict.ts`（`CheckerVerdict`、`parseCheckerVerdict`、`CheckerVerdictParseError`、`CHECKER_VERDICT_REQUIRED_FIELDS`）：checker 层只产出散文，该模型 JSON 解析器没有生产消费者。结论是否降级或阻断任务仍由消费方门禁裁决。

## Alternatives considered

**Mady 的触发词模板路由（`FindPromptByTrigger`）。** 否决：关键词派发在运行时隐式选择提示词，违背 explicit > implicit 规则；本仓库提示词的家园是类型化 manifest 与 atom handler。

**独立的提示词模板包。** 否决：manifest 与 atom handler 已是模型可见提示词的类型化家园，平行的模板系统只会重复并漂移。

**在解析器内强制 `status=pass` 当且仅当 `issues` 为空。** 否决：这是门禁策略而非载荷的结构属性；归后续接线的消费方门禁（patent-teams 任务完成把关）所有。

## Consequences

- manifest 校验对空 `guidance` 的处理与空 `atom` 一致（拒绝）；现有 manifest 未声明 guidance，提示词在声明前保持逐字节不变。
- `SessionEventMap` 无成员变化，会话事件不携带提示词文本，无 `SESSION_FORMAT_VERSION` 义务；当前没有 recorded-session 快照用例运行这些 manifest，因此本次无重录义务（一旦有用例运行即产生）。
- 已经由这两条接缝交付的：OA/创造性/侵权三个 manifest 的阶段指引（驳回类型对照表与主策略选择、缺对比文件/软件方案/组合方案的三步法边界条件、等同侵权三项限制——禁止反悔、捐献、现有技术抗辩——及风险等级输出要求）、extract handler 的 MTU 抽取指引与 `[待确认]` 反幻觉标注（groundedness 打分器对无原文支撑的标记特征按低于阈值处理）、claim-chart 拆分要求（最小技术单元 + 方法步骤顺序与结构连接关系注意项）。
- 后续规划中的移植：说明书自检规则、slop 门之后的 LLM 改写层。

## Testing

patent-core、patent-tools、patent-workflow 三个包 `vitest run` 全绿。新增用例锁定 guidance 校验分支、执行器拼接位置（有/无 guidance 两种）、三个 manifest 的指引内容，以及 handler 提示词升级（仅特征抽取注入 MTU 标注、`[待确认]` 打分规则、chart 拆分要求）。解析器用例已随 `checker-verdict.ts` 一并删除。
