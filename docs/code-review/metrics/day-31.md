# Day 31 — 扩域题库冻结与覆盖

## 今日维度与范围

P4 从本日开始，范围是 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的扩域七族：附图、费用与期限、工作流与团队、文档交付、法律检索与证据、视频、知识与分析。每族 5 题、共 35 题，写入 [extended-questions.md](extended-questions.md) 并于 2026-11-22 冻结。

本日不改 `daily/`、业务代码、依赖、CI 或基础设施配置，也不把试点与扩域样本合成百分数。阶段 issue 是 [#936](https://github.com/xujian519/dsh-patent/issues/936)。

## 出题结构

七个族按 3 道应调用、1 道近邻、1 道应拒绝出题。法律族因 issue 点名两组近邻对（`evaluate_evidence` 与 `evaluate_legal_evidence`、`law_search` 与 `legal_knowledge_search`），改为 2 道应调用、2 道近邻、1 道应拒绝；总数仍是 5 题。

每题在题库里固定六项：题干、可接受工具、必填参数、外部判定、禁止工具、冻结日期。近邻题把易混工具写进禁止集合；应拒绝题不给可接受工具，只检查轨迹与最终答复。真实模型不参与出题，冻结后题干与标准答案不得由被测模型改写。

## 族与题面覆盖

下表的分母是 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md#工具族) 的族工具数，分子是 35 道题在「可接受工具」里直接点名的工具数。5 题覆盖不了一个大族的全部工具，未点名的工具在本阶段没有题面读数。

| 族 | 族工具数 | 题面直接点名 | 未直接出题 |
|---|---:|---:|---|
| 附图 | 9 | 4：`generate_patent_figure`、`check_patent_figure_consistency`、`add_patent_figure_references`、`verify_patent_figure` | 5：`analyze_patent_figure`、`compare_patent_figure_analysis`、`search_patent_figure`、`generate_structure_figure`、`recognize_chemical_structure` |
| 费用与期限 | 2 | 2：`patent_fees`、`patent_deadlines` | 无 |
| 工作流与团队 | 17 | 3：`patent_plan_task`、`patent_teams_create`、`flexible_plan` | 14：`patent_workflow`、`patent_workflow_run`、`patent_worker_validate` 与 11 个未出题的 `patent_teams_*` |
| 文档交付 | 4 | 2：`document_deliver`、`office_convert` | 2：`office_recalculate`、`office_render` |
| 法律检索与证据 | 4 | 4：`evaluate_evidence`、`evaluate_legal_evidence`、`legal_law_verify`、`legal_knowledge_search` | 无 |
| 视频 | 4 | 3：`video_project`、`video_assemble`、`media` | 1：`video_deliver` |
| 知识与分析 | 7 | 3：`parse_office_action`、`matter_log_append`、`knowledge_note_save` | 4：`patent_kg_query`、`patent_analysis_report`、`workbench_link_patent_case`、`triz_contradiction_analysis` |

合计 47 个族工具里，35 道题直接点名 21 个，未点名 26 个。未点名的工具不是「已通过」，本阶段记为未测，不记 0。

## 层与未测

- 28 道题进入直接调用层：六族各 4 道，法律族 4 道。应拒绝的 7 道只在真实模型层测量。
- `office_convert` 只在 Office skill 载入后声明；本机没有 Office Kit，DOC-03 记未测。直接调用层会发起一次调用，得到的 `unknown tool` 作为工具不可用的证据，不作为 0 分。
- 视频族的 `video_assemble` 在没有音频片段的 EDL 下仍写出含静音轨的 MP4。VID-02 的外部判定按「含音轨」记录，不按「无音频」判定。

## 检查项

- [x] 七族各 5 题，共 35 题，题号 `P4-FIG`、`P4-FEE`、`P4-WF`、`P4-DOC`、`P4-LGL`、`P4-VID`、`P4-KNW` 连续编号。
- [x] 每题都有可接受工具、必填参数、外部判定与禁止工具；应拒绝题的可接受工具为空，并写明「无」。
- [x] 近邻题的禁止集合含同域易混工具；法律族两组近邻对都已落到题面。
- [x] DOC-03 标「未测（工具不可用）」，没有写成 0 或失败。
- [x] 题库冻结后不改题面；改题或改工具行为时，[day-32.md](day-32.md) 的直接调用读数作废并重跑。
- [x] 试点 20 题与扩域 35 题分列记录，不合成一个百分数。

## 与试点题库的衔接

试点题库的题号、判定口径与通过线不变，见 [pilot-questions.md](pilot-questions.md) 与 [day-09.md](day-09.md) 至 [day-30.md](day-30.md)。扩域题库另立文件，原因是试点题库冻结在 2026-11-21，而扩域的族、工具面与未测处置不同；合在一个文件里会让两份冻结日期互相覆盖。

11 族共 55 题的合并视图只做记分表，仍在 [scorecard.md](scorecard.md) 维护，两批分列，不折算总计百分比。

## 下一步

直接调用按 [day-32.md](day-32.md)（附图、费用与期限、工作流与团队）与 [day-33.md](day-33.md)（文档交付、法律检索与证据、视频、知识与分析）推进；脚本注入见 [day-35.md](day-35.md) 与 [day-36.md](day-36.md)；真实模型三轮见 [day-37.md](day-37.md)。
