# Agent Note: TRIZ 矛盾产出候选 PFIE 单元，且不进锚定表

Status: implemented

[English](2026-11-26-triz-candidate-pfie-units.md) | 中文

## 问题

`triz_contradiction_analysis` 止步于发明人侧。它报出已核验的矛盾、该矛盾格子的推荐发明原理与模型给出的方案方向，再加参数完备性缺口，而管线没有把这些内容留下任何一项作为撰写的输入。一条值得写进权利要求的方向，只能由 agent 重新抄进 PFIE 表——而那正是摘录锚点校验与 `groundedness` 唯一读取的表——方案方向却没有可供核验的交底书锚点。

两类内容对证据的要求也不一致。矛盾只有其 `evidence` 能在交底书原文逐字定位时才保留，而方向是模型针对该矛盾提出的手段假设。把二者同等对待，要么丢掉全部方向，要么让无锚文本进入 `pfe_triples`。

## 决策

`packages/patent/patent-core/src/triz/candidates.ts` 里的 `buildTrizCandidateUnits(contradictions)` 把落格有推荐原理的矛盾的每条非空白方案方向转成一个 `TrizCandidateUnit`：`problem` 沿用已核验的矛盾表述，`insight` 点名原理并对照改善／恶化参数名称，`effect` 写明该候选要化解的参数取舍，`feature` 是方向文本，`principles` 与 `contradictionEvidence` 携带该格的完整推荐与已核验原文片段，`id` 跨矛盾连续编号为 `K1..Kn`，`status` 取唯一值 `TRIZ_CANDIDATE_STATUS`（`pending-inventor-confirmation`）。

有方向但无原理可依的矛盾只贡献一条 `TrizCandidateSkip`（`contradictionId`、`matrixStatus`、`directionCount`），不产出候选：候选的发明认知必须由点名的原理支撑，否则候选只是换了名字的模型猜测。对角格（物理矛盾）与空格（矩阵转录空缺）都不带原理，因此都落在这里。

改动只落在工具表面。`triz_contradiction_analysis` 在 canonical 值与输出 schema 中加入 `candidate_units` 和 `candidate_skips`，模型可见文本在矛盾段之后加 `## 候选 PFIE 单元（待发明人确认，未进四元组表）`。不新增原子、阶段、预算或模型调用，因此 `patent_flexible_plan` 的原子清单与 `patent_disclosure_v1` 的阶段数不变。

候选不进锚定表。没有 handler 读 `candidate_units`，也没有任何地方把它写进 `pfe_triples`；该值的 `insight` 与 `feature` 按构造就没有锚点。转正沿用既有通路：发明人确认该方向后，调用方把它作为已确认特征交给 `claim-strategy`，同一份清单也用于[交底书理解技能](../../../../packages/bundle/web-app/skills/patent/patent-disclosure-understanding/SKILL.md)要求的补强清单。

## 考虑过的替代方案

**新增一个阶段，把候选带着 `synthetic` 标记写进 `pfe_triples`。** 拒绝：这会把 `patent_disclosure_v1` 从 29 个阶段变成 30 个，从而移动 `DEFAULT_WORKFLOW_STAGE_BUDGET` 并需要一条升级指南，而五个 `pfe_triples` 消费方每一个都要排除带标记的行——[父子链接 note](2026-11-26-pfie-group-parent-link.zh.md) 里拒绝合成根分组的理由相同。

**只在文本里给候选，PFIE 行由 agent 自己写。** 拒绝：锚定纪律就只剩提示词措辞撑着，被抄进去的行也不带任何状态读数，后来的读者无法区分模型建议与发明人陈述。

**用 `claim-strategy` 的 `confirmed_features` 输入承载候选。** 拒绝：该输入的语义是发明人已确认该特征，未经确认的建议走这条路会反过来污染它的含义；它是候选确认之后的去处，不是确认之前的容器。

**只在渲染文本里给候选，不写进 canonical 值。** 拒绝：模型可见的内容必须能从日志里的值还原，因此候选段与矛盾段一样从 canonical 值派生。

## 后果

工具描述与输出 schema 变了，因此 `docs/tool-catalog.md` 重新生成，`snapshots/session/patent-oa-response/tool-schemas.expected.json` 重新录制。刷新该文件不需要密钥（`DSH_SNAPSHOT=refresh`），因为不涉及模型请求。不写升级指南：包 API 仍是 pre-stable、消费方全部在本次改动内更新，Session 格式、`pfe_triples` 与阶段数都没动。

转换是确定性的，同一批矛盾跑两次得到同样的候选；剩下的不确定性仍留在原处——模型提出哪些方向。`K` 编号依赖矛盾顺序，因此重跑若识别出不同的矛盾集合，候选会重新编号；稳定的引用是 `contradictionId` 加方向文本。

确认本身仍在管线之外。这里没有任何东西能证明发明人同意，所以工具结果恒报 `pending-inventor-confirmation`，确认的记录照旧落在案卷与补强清单里。

## 测试

`packages/patent/patent-core/tests/triz/candidates.spec.ts` 覆盖一条方向一个候选及其全部派生字段、跨矛盾连续的 `K` 编号、两项负控制（对角格与空格带方向只出 skip 不出候选、无原理且无方向的矛盾两者都不出）、空白方向剔除、原理名缺失时退化为纯编号，以及空输入。

`packages/patent/patent-tools/tests/triz-contradiction-analysis.spec.ts` 从头到尾覆盖工具路径：矩阵有推荐原理的矛盾对应的 canonical `candidate_units` 条目与候选段渲染，对角格矛盾对应的 skip 行与空 `candidate_units`，空产物的零候选措辞，以及 null 条目、缺 id、非数字方向计数、未知矩阵状态这几处防御分支。

改动后 `pnpm run typecheck`、专利各套件、`pnpm run doc-sync`、`pnpm run build` 与 `pnpm run test:snapshot` 均通过。`ptc-script-imports` 的 headless 重放在同一台主机上有无本改动都以同样方式失败，不计入上述结论。
