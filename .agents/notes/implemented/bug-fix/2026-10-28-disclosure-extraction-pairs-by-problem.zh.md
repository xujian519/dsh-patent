# Agent Note: 交底书的问题与发明认知由同一次抽取调用产出

Status: implemented

[English](2026-10-28-disclosure-extraction-pairs-by-problem.md) | 中文

## 问题

`patent_disclosure_v1` 跑四次独立的 `extract` 调用——问题、特征、效果、发明认知——再由 `merge` 按数组下标配对。发明认知那一路的提示词要求“逐条按 problems 的顺序对应”，但该调用从不接收 `problems`；顺序是提示词兑现不了的承诺。模型返回的认知顺序或条数一旦不同，`MergeHandler` 就把认知挂到错误的问题上，或静默丢弃多余项。

四次调用还各自重发整份交底书：在 8000 字符截断上限处，四份提示词合计 32,613 字符，其中 24,051 字符是同一原文的三份重复（73.7%）。

## 决策

`extract` 新增 `output_mode` 参数，唯一取值为 `problem_insight`。一次调用返回配对，`ExtractHandler` 写入 `problem_insight` 并派生 `problems` 投影：

```json
{"problem_insight": [{"id": "P1", "problem": "…", "insight": "…"}]}
```

每条条目的 `insight` 可选：没有问题对应的机制层认知是正常结果，不是抽取失败。`id` 由模型给出，须在同一输出内唯一，用于校验与诊断；`merge` 仍分配 `T{n}`，使快照与违规文案不跟随模型自选的名称。`parent` 可选，点名同一列表内的上位条目，该列表因此是一棵森林；[父子链接](../architecture/2026-11-26-pfie-group-parent-link.zh.md)记录该层级规则与它驱动的读数。

非数组、非对象条目、`id`/`problem` 缺失或为空、`id` 重复、`insight` 非字符串，以及自指、指向缺失 id 或成环的 `parent`，任一情况都判整个阶段降级。保留合法条目会让 `merge` 用半份抽取构造分组，而摘要看上去仍然完整。

`merge` 优先读 `problem_insight`：每条条目构造一个 `PFETriple`，问题与认知取自同一入口，特征与效果仍按下标对应；多出的特征与效果并入末组。没有 `problem_insight` 时——历史 state，或只跑分键抽取的计划——保留索引路径。存在但非法时，merge 直接降级而不回退，畸形配对不能冒充索引配对。`merge_result` 末尾标 `（配对: problem_insight）` 或 `（配对: index）`，运行记录因此写明分组由哪条路径产生。

`patent_disclosure_v1` 退休 `extract_insight`（22 → 21 个阶段，10 → 9 个模型调用阶段）。`extract_problem` 携带 `output_mode: problem_insight`，两条回退目标（`consistency`、`legal_gaps`）仍指向它，因此回退时用一次调用重抽问题与认知。

MTU 规则只在 `output_key` 为 `features` 时注入，不再按 `extraction_type` 文本是否含“特征”判断。文本判断会给任何提到特征的指令加上 MTU 规则，包括配对抽取。

`output_key: 'insight'` 保留给独立抽取槽位的计划；其 schema 不再声称按 problems 顺序对齐，`insight` 也留在 merge 的索引路径里供该模式写入的 state 使用。

## 考虑过的替代方案

**保留四次调用，把 problems 注入发明认知提示词。** 这能修复承诺，但省不下调用，还在并行提取窗口里插入串行屏障：认知必须等问题先完成。

**四路全部合并为一次调用。** 省下的字符最多，但把产出集中到一次响应里，截断风险更高，MTU 规则必须重新界定或丢弃，且仓库没有证据表明单次抽取能保持质量。

**用跨两次调用重复的 id 配对。** 问题与认知仍分开生成；两次独立生成保持 id 一致，比一次生成同时产出两个字段的保证更弱。

**`problems` 投影与 `problem_insight` 不一致时让 merge 失败。** 投影由同一 handler 从配对派生，不一致只来自陈旧或被手改的 state；以配对清单为准。

## 后果

一次披露运行少一次模型调用，提示词字符约减四分之一；回退重发三次抽取而非四次。问题与认知不可能再因数组顺序错配，因为认知与问题同行。

问题那一路的输出变长，畸形配对输出会降级整次抽取，而不是只丢一条认知。保留 `problems` 投影是因为 `draft-specification` 与法条缺口反哺采集读 `state.problems`。

## 测试

`packages/patent/patent-core/tests/extract-atom.spec.ts` 覆盖配对产出、`problems` 投影、非法条目表、反哺组合，以及 `output_mode`/`output_key` 冲突配置。

`packages/patent/patent-core/tests/atoms.spec.ts` 覆盖与条目顺序无关的配对、对 `problems`/`insight` 投影的优先级、多余特征与效果、缺省认知、畸形输入降级与两种配对标记。`workflow/stage-outputs.spec.ts` 钉住回退会清理 `problem_insight`、`problems` 与 `revision_coverage`。

`packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` 用倒序返回的配对跑真实 extract → merge 交接，`disclosure-extract-cost.spec.ts` 钉住三次调用、每条提示词一份原文、总量低于四路基线。`packages/patent/patent-tools/tests/patent-workflow-run.spec.ts` 端到端跑内置 manifest，断言三路抽取与 merge 不降级。

## 相关

[Insight 槽位与 PFIE 一致性原子](../architecture/2026-10-17-pfie-insight-slot-and-consistency-atom.zh.md)记录该槽位为何存在；本记录说明披露 manifest 如何产出并配对它。
