# Agent Note: One numeric-range vocabulary for specification validation and novelty analysis

Status: implemented

[English](2026-09-21-patent-numeric-range-shared-vocabulary.md) | 中文

## Problem

「数值范围」是专利域两处都需要的词汇,而它被写了两遍,两份副本之间存在三处分歧。novelty 轨的 `packages/patent/patent-core/src/novelty/numeric-range.ts` 匹配的范围其单位可选,单位在匹配片段之后另行读取,连接符接受 `- – — ~ ～ 至 到`。规格校验侧则用自己的 `UNITS` 交替集拼装 pattern,并要求尾随单位,只接受 `~ ～ 至 - —`。两者的单位归一也不同:novelty 侧归一 `℃ / °c / °`,工具侧归一 `℃ / °C / °` 且不含 `°c`。

每一处分歧都让两个生产消费方对同一句话给出相反结论。`patent-core/src/graph/domains/novelty.ts` 消费 novelty 侧提取结果,为新颖性阶段构建图证据;规格校验侧消费工具侧提取结果,对说明书草案作出报告。

- `温度为20℃至90℃`:单位夹在数字与连接符之间,novelty 侧 pattern 不匹配,文本退化到弱「独立数值」路径——得到两个强数值点而非一个区间;规格校验侧识别为一个区间。
- `重量比50-80`:规格校验侧 pattern 要求尾随单位,因此完全不识别该区间;novelty 侧识别。
- `25°c`:novelty 侧归一生效;规格校验侧既未归一,也未把它当作单位匹配。

定级依据是「哪个消费方错了」而非分歧幅度:novelty 侧喂给审查结论,一个区间变成两个数值点,会改变 novelty 节点能做的比较。

## Decision

`packages/patent/patent-core/src/novelty/numeric-vocabulary.ts` 持有这份词汇,两侧从 `@deepseek-ai/dsh-patent-core` import。

- **`NUMERIC_RANGE_SEPARATOR_CLASS`**——连接符字符类 `~～至到–—-`,写法面向嵌入更大的 pattern,连字符放末位以免被读成字符范围。
- **`NUMERIC_ANY_UNIT_ALTERNATION`**——中文、拉丁与符号单位的合并交替集,长者在前,否则 `5mg` 会被读成 `m`、`0.1-2MPa` 会被读成 `m`。其中含 `毫米` 等中文单位与摄氏度四种写法 `°C`、`℃`、`°c`、`°`。
- **`normalizeNumericUnit`**——单位归一,把摄氏度四种写法统一为 `°`,其余单位原样返回。

在这份词汇之上,两侧各自保留自己的 pattern 与接受条件。novelty 侧在 `numeric-range.ts` 里用共享字符类与合并交替集构造 `RANGE_PATTERN`,对尾随单位保持宽松,因为经连接符写出的无单位区间仍是新颖性证据。规格校验侧在 `packages/patent/patent-tools/src/tool/spec-numeric.ts` 里构造自己的 pattern,并保留尾随单位的硬要求,因为端点与中点覆盖要用同单位的单值比对,需要区间单位被写明。

## Verification

`pnpm exec vitest run packages/patent/patent-core/tests/novelty/numeric-range.spec.ts packages/patent/patent-tools/tests/validate-specification.spec.ts` 通过。规格校验套件里的 `SHARED_VOCABULARY_CASES` 持有 12 条文本,逐条断言 novelty 侧提取与规格校验侧提取得到相同的区间端点与相同的归一单位,并把规格校验侧的尾随单位要求写成每条用例的显式字段,而不是它 pattern 的偶然结果。用例钉住的是字面端点与字面单位,不是共享常量,因此连接符集、单位表或归一规则中任何改变任一侧读法的改动都会让该套件失败。

## Alternatives considered

**让规格校验解析器直接 import novelty 解析器。** 否决:两处的接受条件确实不同——规格校验侧确实需要单位,因为草案里的无单位比较是值得报告的撰写缺陷;而 novelty 侧必须保持宽松,以免丢失证据。共享语法同时保留各处约束,比共享一个解析器并在每个调用点参数化其严格度更小。

**保留两个 pattern,加一条测试把他们当时的差异钉住。** 否决:这个差异不是任何人选定的契约。钉住它等于把缺陷文档化,并让下一次分歧看起来是有意为之。

**让 novelty 侧采用规格校验的 pattern。** 否决:在 novelty 侧要求尾随单位会丢掉无单位区间——在为审查结论提供依据的消费方里静默丢失证据。

## Consequences

共享词汇消掉的是这一类分歧而非其中一例:凡两侧必须一致的连接符、单位写法或归一规则,现在只有一处定义,两侧之间只剩各自真正需要的约束。两侧都接受中文单位与 `–`、`—` 连接符;只有规格校验侧要求尾随单位。

提案偏好的更强形态——共享同一个范围 pattern——没有落地。两处各自保留 pattern,也就是提案记录的退路,因此全部保证由一致性套件承担,而不是由 pattern 的构造承担。这也正是用例表记录字面端点与归一单位、而不从常量派生的原因:共享 pattern 本会让两处按构造保持一致,没有它,测试是唯一能发现漂移的东西。

新增第三个消费方意味着 import 同样的词汇取值并保留自己的接受条件,而不是再写一份词汇。
