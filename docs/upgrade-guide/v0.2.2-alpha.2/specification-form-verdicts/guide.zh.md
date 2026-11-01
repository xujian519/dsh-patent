---
kind: upgrade-guide
description: "validate_specification 返回分项判定与 not_assessed，标题长度规则与默认工作流门禁开始拦截未完成或违法的说明书。"
---

# 说明书检查改为分项判定

[English](guide.md) | 中文

## 变更

`validate_specification` 的每条违规新增必填 `family`，结果新增 `not_assessed` 列表。`passed` 字段保留名称，但只表示已运行的确定性规则未发现 error；报告不再读作“符合专利法”。

默认的 `patent_disclosure_v1` 与 `patent_patentability_v1` 工作流现在会阻断：模板占位（`【撰写指引】`、`待补充`、`TODO`、`TBD`）、空章节、引用权利要求（`如权利要求1所述`）、商业宣传语、内部流程标记、实用新型无附图、图号缺号或重复、正文引用附图说明中不存在的图、附图说明条目无图名。无附图发明按四部分通过。

`spec-check` 现在从工作流状态读取 `title`、`abstract`、`patent_type`、`has_drawings`、`figure_analysis`、`drawing_count`、`abstract_figure_number`，并写出 `spec_form_check_passed`、`spec_claims_check_passed`、`spec_figure_check_passed`、`spec_prohibitions_check_passed` 与 `spec_not_assessed`。`legal-gaps` 把 `spec-form` 与 `claim-support` 映射到这些分项，不再把形式检查通过当作 A26.3 充分公开：只有 `enablement_report` 与 `enablement_passed` 判定同时存在，`enablement` 才可能通过。同样，`claim-support-breadth` 不再列入 `not_assessed`，`legal-gaps` 读取新 `claim-breadth` 原子产出的 `claim_breadth_report` 与 `claim_breadth_passed`（warn 级，A26.4 判定未通过会出现在报告里，但不阻断交付）。`patent_disclosure_v1` 在 `spec_check` 之后新增 `enablement_report` 与 `claim_breadth` 阶段，`validate_specification` 接受 `claim_breadth_report` 作为评估输入。

发明名称 26–40 字由 error 改为 warning；超过 40 字仍为 error。

同一版本还：

- 让 `draft_specification` 返回确定性 `abstract`；两个撰写工作流在撰写前运行 `figure_analysis`（sub_agent）与 `figure_analysis_parse`，`figure_files` 为空或输出 `[SKIP]` 时写 `figure_analysis_skipped`。
- 给 `validate_specification` 增加启发式 warning：背景技术引证要素、效果对比、序列表、正文图片/表格、术语与标记一致性、实用新型附图内容。
- 给 `verify_patent_figure` 增加 `delivery_review`、给 `generate_patent_figure` 增加 `abstract_figure`，并让 `build_patent_filing`/`verify_patent_filing` 支持无附图申请（`figureFiles: []`，三节成品）。

读取 `validate_specification` 结果、`spec-check` 状态或 `legal-gaps` 报告的人、此前会放行未完成草案的工作流，以及构建无附图申请文件的人，都受影响。

## 迁移

1. 把用于 A26.3 的 `specification_check_passed` 读取改为 `enablement_report`/`enablement_passed`；`specification_check_passed` 只保留为形式与权项的总判定。
2. 把对 `not_assessed` 中 `claim-support-breadth` 的存在判断改为读取 `claim_breadth_report`/`claim_breadth_passed`；只有报告仍记未评估。若显式配置的 `workflowStageBudget` 低于 25，请上调，因为 `patent_disclosure_v1` 现在有 25 个阶段。
3. 在 `legal-gaps` 消费方读取 `spec_form_check_passed` 与 `spec_claims_check_passed`；`spec-form` 的 `failed` 现在是阻断项。
4. 在原先声称完全合规的报告中展示 `not_assessed`（或 `spec_not_assessed`）。
5. 申请中有对应信息时，向 `patent_workflow_run` 传入 `patent_type`、`title`、`abstract`、`has_drawings`、`figure_analysis`、`figureFiles`、`drawing_count`、`abstract_figure_number`；未传项列为 `not_assessed`。
6. 无附图发明传 `figureFiles: []` 与空的 `drawingDescriptions`，不要给 `abstractFigure`；不要沿用“五部分 + 空附图说明”的旧草案。
7. 附图分析阶段没能运行时（无附图、无视觉能力或未产出结果），先读 `figure_analysis_skipped`，再把图文一致性视为已核。
8. 运行 `pnpm exec vitest run packages/patent/patent-tools/tests packages/patent/patent-filing/tests`，确认占位草案失败、无附图发明按四部分通过、无附图申请按三节成文。
