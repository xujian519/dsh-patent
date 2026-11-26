# Agent Note: 父子链接把 PFIE 分组列表变成森林

Status: implemented

[English](2026-11-26-pfie-group-parent-link.md) | 中文

## 问题

`patent_disclosure_v1` 把技术问题提取成一份扁平列表。一份先陈述总构思、再给出下位实现的交底书，抵达时仍是同级条目：`merge` 把它们编号为 `T1..Tn`，而"这个问题是那个问题的拆解"这一读数在任何后续阶段运行之前就已经消失。

两项下游判断需要这层关系。`pfe-consistency` 会在特征位于其下位实现分组里的上位分组上报 `pfe-problem-without-solution`，于是正确的拆解被读成缺口。`claim-strategy` 则没有任何信号说明哪一组是要保护的构思、哪一组只是它的实现途径之一，因此独权可能对着下位问题撰写，从权体系也失去它存在的理由。

[insight 槽位 note](2026-10-17-pfie-insight-slot-and-consistency-atom.zh.md) 把 `insight` 设为可选，于是不做认知提取的计划照样能跑。层级是同一决策的另一半：一旦某组被引为上位，管线就断言它之上存在机制，同一份宽容不能再让该槽位为空。

## 决策

`ProblemInsightEntry.parent?: string` 点名同一份配对输出内的上位条目——该配对输出由[配对决策](../bug-fix/2026-10-28-disclosure-extraction-pairs-by-problem.zh.md)引入——因此成层不消耗额外的模型调用。`parseProblemInsight` 要求这些引用构成森林：自指、悬空 id 或成环，与畸形条目一样让整组失败，而 `null` 或空白按顶层读取。`MergeHandler` 把条目 id 改写成它发出的分组上的 `PFETriple.parentId?`。

不合成容器分组：没有 `parentId` 的三元组就是顶层构思，`readPfeHierarchy` 按需从三元组导出 `{ roots, maxDepth, children }`。索引路径（`problems[i] ↔ features[i]`）不含父子信息，因此不报层级；`merge_result` 只在 `problem_insight` 路径上给出顶层组数与最长链。

`pfe-consistency` 现在按子树判定承接：该组或其任一后代携带特征时 `S⊨P` 与 `I⇒S` 即成立，且父组明细会点名它的子组（`（含子组 T2、T3）`），以便回退重跑时能定位到它们。叶子组的文案保持不变。封闭集合新增第四个 id：

| id | 判据 |
|---|---|
| `pfe-parent-without-insight` | 该组至少有一个子组且没有发明认知 |

单一性是一个读数，不是违规。顶层组多于一组属于重跑 `extract_problem` 也定不下来的撰写判断，而 `consistency` 只有一次重试可花，所以 `roots` 与 `maxDepth` 走 `pfe_consistency_report`，而不是进 `PFE_CONSISTENCY_VIOLATION_IDS`。`pfe_consistency_summary` 只在 `maxDepth > 1` 时才提到层级，因为合规摘要必须继续一个都不命中 `不一致|矛盾|缺少|孤立`。

`claim-strategy` 声明 `pfe_consistency_report` 为输入并直接读那两个数字，而不是第二次走父子链。它的报告新增一行层级读数，并在顶层组超过一组时新增单一性提示。其提示词写明撰写规则：必要技术特征覆盖每一个顶层条目，下位条目的特征进入承载其父组的那项权利要求下的可选特征表，不共享特定技术特征的顶层条目只留一条独权，其余记入 `notes` 作为分案候选。

## 考虑过的替代方案

**新增一个模型阶段，给每组分配 parent 键。** 否决：这原本是初始方案，它为一个已有的配对调用就能给出的成层信息多花一个阶段。多一个阶段会把 `patent_disclosure_v1` 从 29 变成 30，从而动 `DEFAULT_WORKFLOW_STAGE_BUDGET` 并需要一条升级指南；新原子还得进 `patent-flexible-plan.ts` 的清单，该清单的工具描述被钉在 `snapshots/session/patent-oa-response/tool-schemas.expected.json` 里，改动需要带密钥重录。

**合成一个持有顶层分组的 `T0` 根。** 否决：一个没有问题、特征、效果的容器分组第一趟就触发 `pfe-problem-without-solution`，于是它得在每个读 `pfe_triples` 的地方开豁免——五个消费该值的 handler、draft-review 的 isolation 清单，另有两处 atom 声明——只为换取一行只用来被指向的记录。

**在根上写 `parentId: null`。** 否决：三元组其余可选字段都以"缺席"表示"无父"，显式 `null` 会让读者为一个事实测两种状态。

**把多根算作违规 id。** 否决：它会触发的回退重跑提取的是问题与发明认知，而单一性问题不是这样回答的，且那一次重试预算属于重跑能修的违规。

**要求每组都有发明认知。** 否决：改进型发明本就可能没有机制陈述，必填会让从不配对问题与认知的计划降级。该义务只落在层级自己声称"上面有机制"的地方。

## 后果

该表示无需迁移即向前兼容。一份不含 `parent` 的已录制 `problem_insight` 数组照样解析、产出扁平三元组列表，并给出它此前的违规集合与摘要；只有模型输出声明了父级的那次 run 才可能产出 `parentId` 或第四个违规 id。

模型可见文本只在配对路径上增长：`extract_problem` 的提示词多了森林规则与示例键，这让它三次抽取的提示词合计仍低于 `disclosure-extract-cost.spec.ts` 为 8,000 字符交底书钉住的四次调用基线 32,613 字符。`JSON.stringify(pfe_triples)` 会喂给引用类阶段，所以 `parentId` 进入那些提示词，并且可以从 merge 读过的那条 `problem_insight` 输出中重建。

成层不进入关键词生成：`formatPfeTriples` 给 `keywords` 与 `search` 提示词每组渲染扁平一行，因此那些阶段看到的仍是无序列表。扩展该渲染器是另一处改动，需要它自己的提示词预算证据。

某个子组是否真的是其父组的下位拆解，不由确定性规则判定，仍归交底书理解技能要求的发明人确认步骤。层级行与单一性提示是给代理师的撰写提示，而错误的成层会表现为分错层的从权体系，`draft-review` 仍按 A26.4 与 A31.1 读它。

## 测试

`packages/patent/patent-core/tests/extract-atom.spec.ts` 在解析器一侧覆盖森林规则：非字符串、悬空、自指或成环的 `parent` 会让阶段降级并点名条目 id，而 `null` 与空白会剔除该键，合法的父级则原样通过。

`packages/patent/patent-core/tests/atoms.spec.ts` 在 merge 一侧覆盖同样的失败、条目 id 到三元组 id 的转换、根上不出现该键，以及索引路径不输出层级句。

`packages/patent/patent-core/tests/pfe-consistency.spec.ts` 覆盖一层与两层的子树承接、整棵子树缺口且明细点名子组、新 id 与其余三个彼此的隔离、无认知的叶子组不受影响、扁平输入不出现层级措辞、手工构造的环状 `parentId` 可以终止，以及 handler 的 `roots`/`maxDepth` 报告字段和一份仍不命中回退信号的多层合规摘要。

`packages/patent/patent-core/tests/claim-strategy-atom.spec.ts` 覆盖分层、单层、缺失与不可读读数下的报告渲染，以及提示词规则。`packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` 用一条伪造的模型输出串起 `extract` → `merge` → `pfe-consistency` → `claim-strategy`，并钉住 `claim-strategy` 声明一致性报告为输入且排在其后。

改动后 `pnpm run typecheck`、专利各套件与 `pnpm run test:snapshot` 均通过。`ptc-script-imports` 的 headless 重放在同一台主机上有无本改动都以同样方式失败，不计入上述结论。
