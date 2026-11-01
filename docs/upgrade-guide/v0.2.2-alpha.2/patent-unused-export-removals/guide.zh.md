---
kind: upgrade-guide
description: "专利包移除六个零消费公开导出，且 patent_plan_task 接受案卷条目。"
---

# 专利包移除未使用的公开导出

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-patent-workflow` 不再导出 `CheckerVerdict`、`parseCheckerVerdict`、`CheckerVerdictParseError`、`CHECKER_VERDICT_REQUIRED_FIELDS` 与 `checker-verdict.ts` 模块：随包的 checker worker 不产出该解析器所接受的 JSON。`@deepseek-ai/dsh-patent-core` 不再导出 `RuleEngine.rankResults`、`RankedRiskItem`、`SEVERITY_WEIGHTS` 与 `STATUTE_WEIGHTS`。`@deepseek-ai/dsh-patent-tools` 不再导出 `extractAbstractDrawingNumber` 与 `BASE_SECTIONS`。`isElectricalIpc` 与 `isElectricalCase` 从 `@deepseek-ai/dsh-patent-workflow` 消失。

`patent_plan_task` 现在接受案卷条目：`issues`（每条含 `id`、`summary`、`kind`，可选 `disposition`、`blocking`、`status`、`round_opened`、`anchor`）、`round`（与 `issues` 同时必填）、`rounds` 与 `maxRounds`。迁移会按随包的 kind → 处置表解析每个草案、回显解析后的 `issues`；存在未闭合阻塞条目时拒绝 `executing`，存在未闭合终态条目或已达上限时拒绝 `replanning`。

导入被移除符号的调用方，以及通过 `patent_plan_task` 派工与重规划的调用方，会受影响。

## 迁移

1. 删除对已移除符号的导入。用 `SPEC_SECTION_HEADINGS`（或 `requiredSections()`）替代 `BASE_SECTIONS`，用 `parseFigureNumber` 与 `knownFigureNumbers` 替代 `extractAbstractDrawingNumber`，用 `inferTechnicalField` 已返回的 IPC 分类替代 `isElectricalIpc` 与 `isElectricalCase`。
2. 需要风险排序时，在调用方基于 `RuleEngine.evaluate()` 的结果自行排序；严重度与法条权重不再随包。
3. 用你的 checker worker 实际返回的复核结论替代 `parseCheckerVerdict`，并在你自己的模型 JSON 边界校验它。
4. 计划携带案卷条目时，用 1 起的 `round` 传入 `issues`，并在下一次迁移把每条条目的 `status` 与 `round_opened` 带回；闭合阻塞条目才会解除对 `executing` 的阻止。
5. 运行 `pnpm exec vitest run packages/patent/patent-core packages/patent/patent-workflow packages/patent/patent-tools`，并在改完导入后确认构建通过类型检查。
