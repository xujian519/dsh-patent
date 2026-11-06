# Agent Note: 专利领域缺陷清单分开说明引擎能判定什么、哪些留给人工

Status: implemented

[English](2026-11-04-patent-domain-checklist-decisions.md) | 中文

## Problem

专利撰写流程交付前的最后一道复核由两张清单承担：机械撰写缺陷 30 项、软件/AI 缺陷 28 项。清单在本仓库之外，位于 `~/.agents/skills/patent-legal/patent-drafting-{mechanical,software}/02-缺陷检查清单.md`（v1.0，2026-07-19）。其 Y/N 列回答的是「该缺陷能否写成正则表达式」，而交付检查问的不是这个问题：正则表达不出的缺陷仍可能由结构化解析器判定，正则能命中的缺陷也可能没有可靠的机器判据。`claim_lint` 与 `validate_specification` 报告发现时不带清单项 id，因此两个引擎都跑过之后，每一项清单的状态仍然无人说明；而最省事的映射——某项因它的规则没命中而继承「通过」——会给规则只覆盖缺陷一部分的项报出通过。

## Decision

`packages/patent/patent-tools` 的 `domain_check` 按领域把一张清单跑过 `claim_lint` 与 `validate_specification`，并按清单顺序报告每一项。项映射的规则实际运行过且没有命中时报 `pass`，命中时报 `hit`（发现带引擎、规则 id、严重级别、说明与法律依据），其余一律 `manual`。输入决定可用性：`claims` 门控权利要求类项，`abstract` 门控摘要项，`patent_type` 门控实用新型类项，`figure_analysis` 只在至少一张附图可用时才算数——附图原子在跳过分析时写的正是空数组，因此空数组不能读作「已核、没发现问题」。

### The three statuses

`manual` 有两个来源，两者都不是通过。没有引擎规则的项之所以是 `manual`，是因为其判据属于法律或事实判断：`MECH-DC-003`（漏标注附图标记）需要先有部件清单，才能判断某个标记是否漏了。规则只覆盖缺陷一部分的项即使规则没命中也是 `manual`，且 `reason` 点明覆盖到哪一部分：`MECH-DC-002` 只比对 `名称（标号）` 配对，无标号的「一物多名」仍开放。缺输入产生的 `manual` 会点名该字段，因此只传了 `text` 的调用方能看出机械域那 25 项为何没关上；若映射规则已经由另一份输入命中，`reason` 会同时点名该规则，命中不会被缺字段掩盖。

### What each domain decides

机械域 15 项有引擎规则、15 项没有。有规则的 15 项里 9 项决定该项（`MECH-DC-001/004/009/010/014/020/021/022/025`），6 项带 `partial`（`002/013/018/024/026/030`）。软件域 18 项有规则、10 项没有；4 项决定（`SOFT-DC-004/005/013/014`），14 项带 `partial`。这一分类沿用映射源清单时记录的四分类：已有覆盖、覆盖缺失或不完整、没有检查类型能表达的能力、需人工判断。

软件域在 `packages/patent/patent-tools/src/tool/spec-software.ts` 新增 7 条规则，全部以 `tech_domain: 'software'` 为门控：以算法或程序作为主题（`software_algorithm_subject`）与以信号或比特流作为载体（`software_signal_medium`）报 error；缺技术载体（`software_no_technical_means`）、出现商业规则词汇（`software_business_rule_feature`）、未公开训练数据（`software_training_data_disclosure`）、未公开模型结构（`software_model_structure_disclosure`）、缩写未定义（`software_abbreviation_undefined`）报 warning。每条规则都是风险信号而非排除结论：方案是否落入专利法第二十五条第一款第二项仍属法律判断，这也是四项客体类项都带 `partial` 的原因。

### Domain scopes in rule_check

`rule_check` 增加域 scope `patent-mechanical` 与 `patent-software`：完整的 assets 加上 `packages/patent/patent-rule/assets/rules/domains/` 下该域的规则包。`MECH-INV-001` 增加 premise（`等效`、`等同`、`实质相同`、`相同的作用`），不再对从未讨论等同的文字报出——对 66 份文档的回放曾产生 53 次命中，几乎全部落在无关文本上。软件包增加 `SOFT-INV-001`，即客体答辩的三要素（技术问题、技术手段、技术效果），并配有自己的 premise。

## Alternatives considered

**为每项清单各写一条 YAML 规则。** 否决：多数项的判据依赖规则引擎拿不到的文档结构（部件清单、实施例与特征的对应关系），而只按词汇命中的规则会把通过报得和缺陷一样笃定。

**只报 error 级发现，其余一律算通过。** 否决：这把「没检查」变成「检查干净」，正是清单要防的失效。

**把源清单的 Y/N 列当作自动化名单。** 否决：该列问的是正则能否表达该缺陷。机械域 30 项中有 14 项标 Y，其中若干并没有可靠的机器判据；而若干标 N 的项，已上线的结构化解析器就能判定。

**把化学域清单与修改超范围检查放进同一次改动。** 否决：issue 已明确将其排除在范围之外，且两者背后都还没有引擎。

## Consequences

- 只有当具名规则真的运行过时才报 `pass`，因此修改规则的词表会改变哪些项通过；规则改动必须同批更新清单测试。
- 新工具改变了模型可见的工具集：专利场景的工具 schema 金标新增 `domain_check`，专利 preset 声明 37 个模型工具而非 36 个。
- `manual` 项仍需源清单所述的人工复核；工具收窄的是必须重读的范围，不是必须判断的范围。
- `domain_check` 由 `domain` 推导 `tech_domain`，因此 `domain=software` 无需额外参数就会跑客体与公开充分性规则。只调 `validate_specification` 却想要这些规则的调用方必须自行声明 `tech_domain: 'software'`。

## Testing

`packages/patent/patent-tools/tests/domain-check.spec.ts` 固定两个领域的状态计数、含 `patent_type` 的缺输入原因、跳过分析的空数组、「标为可用但没有部件清单」、未归入清单项发现的段落，以及渲染出的汇总。`spec-software.spec.ts` 覆盖每条软件规则与误报护栏（训练人员的句子、通用词代替模型结构、只有英文全称的括号）。`claim-lint.spec.ts` 与 `spec-description-extras.spec.ts` 固定步骤顺序与实用新型客体两条规则对从属项的排除。工具 schema 金标是 `snapshots/session/patent-oa-response/tool-schemas.expected.json`。
