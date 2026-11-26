# Agent Note: 交底书管线中的 Insight 槽位与确定性的 PFIE 一致性原子

Status: implemented

[English](2026-10-17-pfie-insight-slot-and-consistency-atom.md) | 中文

## 问题

`patent-disclosure-understanding` 把交底书转成 PFE 三元组——问题、特征、效果——该三元组是检索、新颖性/创造性分析与撰写的输入基线。有两处缺口。

管线中没有任何环节问"特征组合为什么成立"。使该组合非显而易见的机制层认知没有槽位，只存在于后续阶段读不到的正文里。

`patent_disclosure_v1` 的 `consistency` 阶段声明"PFE 一致性检查（特征-效果因果链闭合、无孤立特征）"，却不声明 `atom`。`runStageOnce` 会把没有 `atom` 的阶段交给调用方的 executor，因此这项检查是一段没有判据的自由文本自述。`MergeHandler` 按数组索引配对提取结果，即**构造**而非**校验** `problem[i] ↔ features[i]`：问题数多于特征数时，多出的分组拿到空特征列表，而没有任何东西报告它。

Insight 槽位不得进入三步法的"实际解决的技术问题"。《专利审查指南》第二部分第四章 3.2.1.1 要求该问题相对区别特征确定且不含解决手段，`INVENTIVENESS-PROBLEM-SOLUTION-BINDING` 已通过 `checkAtomic` 拦截该产物。交底书层需要在更早的、另一段文本上拦成因。

## 决策

`PFETriple` 承载 `insight?: string`——该组特征之所以奏效的机制层理由。它是可选的：`keywords`、`novelty` 与 `draft-claims` 只读问题与特征，不跑 Insight 提取的 manifest 不应因此降级。

`patent_disclosure_v1` 让发明认知与它所解释的问题在同一次抽取中产出：`extract_problem` 以 `output_mode: 'problem_insight'` 运行 `extract`，handler 写入配对数组 `problem_insight` 与派生投影 `problems`。`MergeHandler` 把每条配对当作一组读取，因此认知不需要单独抽取，也不会与问题顺序错位；[配对决策](../bug-fix/2026-10-28-disclosure-extraction-pairs-by-problem.zh.md)记录该改动与代价。`output_key: 'insight'` 保留给独立抽取该槽位的计划，merge 的索引路径仍按 `insight[i]` 配 `problem[i]` 处理由该模式写入的 state。

`consistency` 阶段改用确定性原子 `pfe-consistency`（`PfeConsistencyHandler`），即对合并后分组的纯函数。它报告四类违规，构成封闭集合 `PFE_CONSISTENCY_VIOLATION_IDS`：

| id | 判据 |
|---|---|
| `pfe-problem-without-solution` | 该组写了技术问题，而它与其任何后代都不带特征（`S⊨P`） |
| `pfe-insight-without-solution` | 该组带发明认知，而它与其任何后代都不带特征（`I⇒S`） |
| `insight-encroaches-problem` | 该组的问题文本未通过 `checkAtomic(problem).checks.noSolutionBinding` |
| `pfe-parent-without-insight` | 该组至少有一个子组且没有发明认知 |

后代这一条款与第四个 id 来自[父子链接](2026-11-26-pfie-group-parent-link.zh.md)；三元组都不带 `parentId` 时，两个判据都退回这里记录的单组读法。

`insight-encroaches-problem` 复用 `checkAtomic` 的不绑方案判据而不新增第二套模式：一个判据，两个层级，两段不同文本——此处是交底书的问题表述，`INVENTIVENESS-PROBLEM-SOLUTION-BINDING` 处是三步法的问题表述。

`consistency` 不再声明 `consumes`。只有无原子阶段的 executor 组装提示词时读 `consumes`，故它落在原子阶段上就是死数据；`manifest-atoms.spec.ts` 本就拒绝这种组合。

`pfe_consistency_summary` 是本原子的首个输出，也就是 `workflow.ts` 用来匹配 `retry.whenOutputMatches`（`不一致|矛盾|缺少|孤立`）的文本。`signalMatches` 会跳过命中点前 12 字符内含句界或否定词的位置，故摘要必须以信号词开头：违规摘要以 `四元组承接缺少结构支撑：…` 起头，计数与逐条明细后置；合规摘要不含这四个词中的任何一个。

交底书理解技能、团队与 worker 与角色契约、专利预置 persona、`patent-mode-design.md`，以及点名该输入表的模板技能，一律改读「PFIE 四元组」并列出 Insight 槽位。`patent-team-composition` 与 `docs/patent-workbench-tasks.md` 列出它的四个槽位。

## 生效范围

`patent-disclosure-understanding`、团队契约与专利预置随 `@deepseek-ai/dsh-web-app` 交付；原子与 manifest 随 `@deepseek-ai/dsh-patent-core` 与 `@deepseek-ai/dsh-patent-workflow` 交付。打包版 App 全部从 `app.asar` 解析，故仓库改动只有经 App 重新构建并重新打包才会到达运行中的 App。

全局层的技能提供者无法覆盖随包技能。`SkillRegistry.collectFresh` 以 `merged.set` 合并 `[global, ...chainLayers]`，因此更近的层会替换更远层的条目，与 rank 无关；而预置那行 `skill-filesystem` 挂在预置层。rank 只在同一层内裁决重复，而该行的 `customSkillDirs` 根落在 rank 300——高于 400 与 500 的用户根。故放在 `~/.agents/skills` 的同名技能会输给随包版本，改名则只是多出一个技能，而不是覆盖。

## 考虑过的替代方案

**把一致性检查留给 LLM 阶段。** 生产上本就是这一安排，而专利域交付门禁对纯提示词义务的实测成功率是 0。阶段描述不是判据，留着它不会改变任何可测的事。

**改判发明认知文本是否越位，而不判问题文本。** 发明认知本就该点出机制（`通过设置限位凸台…`），按构造必然没过 `noSolutionBinding`，该判据会在每一条写得合规的发明认知上触发。要拦的槽位混淆是发明认知被写进了**问题**槽位，那是问题文本的属性。

**现在就加 `pise` 会话事件与单调 guard。** 暂缓而非否决：它需要一个承载判定的产物事件，因为 `deliveryGate` 记录的是调用成功而非结论通过；且它以"Insight 槽位确有收益"为前提。该证据未能取得（见下）。

**用 profile patch 覆写 `preset-patent` 以投送到运行中的 App。** 暂不采用。loader patch 会**整体替换** `config`，而 `@deepseek-ai/dsh-agent-preset` 不是 `cordis:group`，其 `plugins` 列表内的行无法按 id 寻址；覆写必须重述整个预置。那会把 App 的预置钉在当前内容上，并遮蔽后续的预置与交付门禁改动——App 随包的预置与本 checkout 已经差一处 `structuralGate`。

**把 `insight` 设为必填。** `MergeHandler` 服务于每个做 PFE 提取的 manifest，必填会让从不提取发明认知的 run 降级或失败，而该槽位的收益尚未测量。

## 后果

结构性判定是刻意的。`I⇒S` 与 `S⊨P` 陈述的是字段存在与交叉引用事实；机制是否真的承接了特征、特征集是否真的解决了问题，不由确定性规则判定，仍归技能已要求的发明人确认步骤。本原子从不在语义上阻断，其输出也这样说。

`insight` 在随包 manifest 里有生产者、消费者与用例。没有任何阶段填充的字段会是死数据。

把发明认知与问题放在同一次抽取中配对，代价是一次模型调用而非两次。违规会回退到 `extract_problem` 一次（`maxRetries: 1`），重跑三路提取与 `merge`；问题与认知来自同一次重跑调用。提示词字符预算用例由配对决策记录持有。

`patent-workflow-run.ts` 的英文工具描述仍把该管线概括为 "PFE extraction"。该文本被钉在 `snapshots/session/patent-oa-response/tool-schemas.expected.json` 里，改动它会作废一份无密钥录制；该概括仍然成立，因为管线依旧提取问题、特征与效果。`flexible_plan` 的原子清单确实点出了 `pfe-consistency`，因为 `registration.spec.ts` 要求该清单覆盖每个已注册原子，而 `docs/tool-catalog.md` 由它重新生成。

## 测试

`packages/patent/patent-core/tests/pfe-consistency.spec.ts` 覆盖每一类违规、它们彼此的隔离、封闭集合漂移守卫、降级路径，以及回退契约：违规摘要命中 manifest 声明的信号，合规摘要不命中。

`packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` 钉住 `consistency` 点名该原子、不携带 `consumes`、其输出命中它自己声明的 `whenOutputMatches`，以及 `extract_problem` 携带配对模式并排在 `merge` 之前。

`packages/patent/patent-core/tests/atoms.spec.ts` 覆盖发明认知配对、键缺失的情形、多余发明认知，以及一组以空特征列表收尾。`packages/patent/patent-tools/tests/registration.spec.ts` 覆盖注册表与 `flexible_plan` 描述。

改动后 `pnpm run typecheck`、专利各套件与 `pnpm run test:snapshot` 均通过。

## 待办

证据阶段没有合格案子。对比 Insight 槽位前后的 `SPEC-CONTENT-TRIPLE` 触发次数与返工次数需要两到三个已结案案子，且同时具备交底书、定稿权利要求书与检索报告；现有案件目录最多具备三项中的两项，`patent-workspace/CN2026-0904-01/04-撰写` 为空。强制出席阶段在该证据出现前不建。
