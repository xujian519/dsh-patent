---
name: patent-infringement
description: 侵权比对分析：全面覆盖原则 + 等同原则（三要素/禁止反悔/捐献/现有技术抗辩），逐特征比对与风险定级。用户要求侵权分析、判断是否落入专利保护范围时使用。
---

# 侵权比对

用全面覆盖原则和等同原则判断被控方案是否落入专利权保护范围，结论为字面侵权 / 等同侵权 / 不侵权三态之一。

## 必查清单（先查再分析）

- 用 claim_chart_build（mode=infringement）把权利要求拆成编号要素并逐要素映射到被控产品：targets 用 kind=accused-product，有材料文件时给 source_path（pin-cite 与逐字引用会对着源文核验）。行级 mapping=doe 表示主张等同，仅侵权模式允许。
- 用 patent_wiki_search 查等同侵权审查标准卡片：三要素测试法、全部要素规则、禁止反悔原则、捐献原则、现有技术抗辩、数值范围特征的等同。
- 用 patent_case_search / patent_kg_query 追查等同侵权判例与裁判规则。

## 分析流程

1. 解析权利要求确定保护范围：考虑修改历史、禁止反悔、捐献规则对范围的限制。
2. 覆盖结论以 claim_chart_build 输出为准，不要另行口算：缺任一要素即不落入（not-covered）；判为 equivalence-required 的要素必须逐项做等同论证；工具报出的矛盾（如三要素全否却记 doe、等同项指向别的目标）要先解决再下结论。
3. 等同认定逐项走三要素（手段/功能/效果基本相同 + 本领域技术人员无需创造性劳动），并把认定记录写进 risk.equivalents，让风险等级出自可复核的输入。
4. 现有技术抗辩检查：被控方案与申请日前公知技术实质相同则不侵权。
5. 风险定级只由 claim_chart_build 的 risk 事实推出（defenses / remedyExposureRatio / estoppelApplied / dedicationApplied / equivalents）；工具不接受直接给的分数或等级，未提供 risk 时明写"未计算风险等级"，不得自行编造等级。
6. 收口必经：用 patent_workflow_run（manifestId=patent_infringement_v1；input=被控产品材料，claims=权利要求书，chartTargets 传目标对象 JSON）一次跑完"对照表 → 全面覆盖/等同核验 → 报告"并留下可复核的 stage 记录：report 阶段同时读到对照表与覆盖核验结论。本预设的前台运行在审批门直接询问用户：放行即继续，拒绝则带结果名暂停（此时传入 approveStageIds 会被拒绝）；后台运行仍暂停，并以 approveStageIds 续跑。未收口的比对分析不得进入文档交付。

## 约束

等同原则不得使保护范围与现有技术重叠；禁止反悔原则、捐献规则约束等同认定；等同认定逐项论证，不得凭直觉。

## 输出

特征对比表 + 侵权结论（字面/等同/不侵权）+ 法律依据 + 风险定级。

## 质量门禁与人工确认

对比表逐特征附引用位置；结论附免责声明；交付前经 patent-quality-gate。
