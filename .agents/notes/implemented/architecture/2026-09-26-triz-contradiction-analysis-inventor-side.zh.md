# Agent Note: 发明人侧的 TRIZ 矛盾分析

Status: implemented

[English](2026-09-26-triz-contradiction-analysis-inventor-side.md) | 中文

## Problem

专利预设挂载了 `@deepseek-ai/dsh-methodology`，它的 `triz` 工具读取 40 条发明原理与 39x39 矛盾矩阵——而域内没有任何东西用它。`patent-core` 对它零引用，persona 没有针对它的规则，`patent-disclosure-understanding` 产出 PFE 三元组、特征编号与发明点分级，却从不问交底书牺牲了什么。

于是交底书侧有两个缺口。其一是没有对发明人所作取舍的结构化读法，而这正是讨论替代手段或规避设计的材料。其二是没有一份"交底书点名却未量化"的工程参数清单：一个真实案件的交底书质量评估判定技术问题"清楚"，而每一项效果数据（响应时间、精度、良率提升）都是无测试口径的报告值——发明人真正需要补的，恰恰是一份逐参数的缺口清单，而此前没有任何东西产出它。

## Decision

**接发明人侧，绝不接三步法的 diff 节点。** `graph/domains/inventiveness.ts` 的 `diff` 节点产出 `actual_technical_problem`，那是一个法定概念：它相对最接近现有技术、由区别特征确定，且 `checkAtomic` 要求它不含解决手段。TRIZ 矛盾是两个工程参数之间的设计层取舍，读起来就是手段；写进该字段既通不过 `INVENTIVENESS-PROBLEM-*` 检验，又等于把"本领域常规取舍"递到审查员手里，削弱它本要支撑的论证。第三步的技术启示来源是法定封闭列表——改进动机、结合启示、公知常识、逻辑推理与有限试验——40 条原理不在其中，原理编号在审查意见答复里不构成论证。工具描述、persona 的工具段与技能三处都写明了这条边界。

**识别交给模型，可核验的判断全部交给代码。** `extractTrizContradictions` 在提示级 JSON schema 下做一次模型调用并返回原始结果。随后 `buildTrizAnalysis` 只接受 1-39 的整数参数编号，逐对落格到 `methodology` 随包的矩阵（对角格是物理矛盾，非对角空格是转录缺口），参数与原理名称一律取随包资产而非模型输出，并丢弃证据无法在交底书原文中逐字定位的矛盾、计入 `dropped_for_evidence`。

**归属。** 引擎放在 `patent-core/src/triz/`，是纯计算；参数表、发明原理与矩阵留在 `methodology`，`patent-core` 新增对该包的依赖。引擎与工具都要用的 JSON 取值守卫移入共享的 `llm-json.ts`，因为收紧后的重复检测把这两人份判为克隆。

## Consequences

`triz_contradiction_analysis` 是 `patent-tools` 的第 30 个模型可见工具；工具目录、预设 README、两个包的 README，以及 `patent-oa-response` 的工具 schema 快照（`patent-jobs` class 的 schema owner）随之更新。

产物只喂方案探索与交底书补强清单，到此为止。它不产出问题依赖图、不产出幻觉率指标、不做跨文档问题合并，矛盾对也绝不进入交付文书的法定论证段。`buildTrizCandidateUnits` 还会把有原理可依的矛盾的每条方案方向转成工具结果里一个 `pending-inventor-confirmation` 状态的候选 PFIE 单元；那份清单是发明人确认材料，仍不进 `pfe_triples`（[候选单元](2026-11-26-triz-candidate-pfie-units.zh.md)）。

矩阵 1521 格中有 331 格没有推荐——39 个对角物理矛盾与 292 个非对角转录缺口——工具把它们报成空缺，而不是编一条原理；`unmapped` 承接模型无法映射到 1-39 的表述，而不是硬凑一个编号。

## Alternatives considered

**把矛盾喂给 `diff` 节点。** 这是"用上那个已经挂载的工具"最短的路径，也是本记录存在的原因。它输在该字段的法定含义与那条会拒绝它的规则上，理由见 Decision。

**在 `methodology` 里扩展 `triz` 工具，加一个交底书入口。** 该包本来就持有数据，不必新增依赖。它输在 `methodology` 是通用推理方法论包（八个组件、关键词匹配、提示注入），没有 `PatentModelPort` 词汇，而交底书解读是专利域的工作。

**把矩阵与参数表复制进 `patent-core`。** 自包含，也不用争论跨包依赖方向。它输在 `methodology` 已随包分发这些资产（`files: ["assets"]`），第二份副本会把一张表分叉成两条维护路径。

**直接采信模型报出的参数编号。** 更简单，模型对的时候也没问题。它输在本仓库已经在执行的证据上：模型的自报置信度不作为输入（`claim-coverage` 对自身判定就写明了这条纪律），越界编号与编造证据必须由代码拦住，而不是等人读出来。

**做成 `patent_disclosure_v1` 的工作流阶段。** 那会把能力放上确定性管线。这是暂缓而非否决：一个阶段需要新原子，会牵动内置 handler 计数与其测试，而当前唯一的消费者——交底书理解流程——用工具与技能已经够用。

## Testing

`packages/patent/patent-core/tests/triz/analysis.spec.ts` 覆盖矩阵状态、编号校验、证据丢弃、缺口合并与形状容错；`extract.spec.ts` 覆盖端口结果与提示中的参数清单。`packages/patent/patent-tools/tests/triz-contradiction-analysis.spec.ts` 用假端口端到端执行工具，并覆盖传输层失败。
