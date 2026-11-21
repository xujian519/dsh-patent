# Day 06 — 题库（二）：法条核验与规则 5 题

## 今日维度与范围

本日写第二个试点族「法条核验与规则」的 5 题，题面与判定落在 [pilot-questions.md](pilot-questions.md) 的 P-LAW-01 至 P-LAW-05。本文件记录选题口径、确定性与覆盖。本日不改业务代码、依赖、CI 或基础设施配置，也不改 [daily/](../daily/)。

## 检查项

- [x] 5 题：3 道应调用、1 道近邻、1 道应拒绝。
- [x] 每题有可接受工具、必填参数、外部判定、禁止工具。
- [x] 近邻题正确工具是 `domain_check`，禁止 `rule_check`。
- [x] 应拒绝题不给可接受工具，拒绝判定读轨迹与最终答复。
- [x] 题干与标准答案标为「待人工冻结」。

## 选题口径

- P-LAW-01 用 `law_verify` 核验两条引用，外部判定是两条 `valid`、`blocked` 为 `false`；这条用例在 `packages/patent/patent-law/tests/tool.spec.ts` 里已有断言，题卡直接复用它的输入。
- P-LAW-02 用 `law_search` 取指南原文，外部判定读 `scope`、`sourcePath` 与「时间效力」；空结果不允许下「没有规定」的结论。
- P-LAW-03 用 `rule_check` 跑机械域单条规则，外部判定读规则编号 `MECH-INV-001` 与「评估输入」行；这条用例在 `packages/patent/patent-tools/tests/engine-tools.spec.ts` 里已有断言。
- P-LAW-04 是近邻：题面要求跑 30 项领域缺陷清单，正确工具是 `domain_check`，禁止 `rule_check`。外部判定是 30 项、0 hit、5 pass、25 manual；这条用例在 `packages/patent/patent-tools/tests/domain-check.spec.ts` 里已有断言。
- P-LAW-05 是应拒绝：题面要求把未转录的指南节号写成已核验；正确行为是拒绝，不调用核验工具。

这族的三道应调用题都有确定性结果，不依赖网络。`law_search` 依赖 `knowledge.db`，前置写在题卡；其余两题只读随包资产。

## 覆盖与前置

本族 5 个工具里，题面直接覆盖 4 个：`law_verify`、`law_search`、`rule_check`、`domain_check`。未直接出题的是 `patent_eval`；它更接近「评分」而不是「判定」，放到扩域或 P1 的补充题，避免把评分维度塞进这 5 题。

`law_verify` 的题面要求两条引用都「已核验」，这是随包索引的当前状态，不是对法律正确性的判断；题卡的标准答案明确说它只核验引用形式与索引成员，不核验实体法律结论。P-LAW-03 的 `MECH-INV-001` 同理：它是确定性规则命中，不是创造性结论。

## 本日命令

```
pnpm exec vitest run packages/patent/patent-tools/tests/claim-lint-tool.spec.ts packages/patent/patent-tools/tests/domain-check.spec.ts
→ 2 files passed, 27 tests passed

pnpm exec vitest run packages/patent/patent-law/tests/tool.spec.ts packages/patent/patent-tools/tests/validate-specification.spec.ts -t "law_verify tool|complete specification|missing required sections"
→ 2 files passed, 26 tests passed, 71 skipped
```

第一条覆盖 `domain_check` 的 30 项与 5/25 分布；第二条覆盖 `law_verify` 的两条引用与 `validate_specification` 的通过/缺章节路径。两条命令都没有调用模型，也没有联网。

## 冻结状态

五题于 2026-11-21 冻结，题面锁定为起草文本。P-LAW-02 的路径前缀没有改写。清单在 [pilot-questions.md](pilot-questions.md)。

## 明日第一件事

Day 07 第一件事：写「权利要求」5 题，先用 `claim_lint` 的已固定用例写形式检查，再写两道 `claim_chart_build` 题，并把「工具内部调用模型、直接调用层记未测」写进题卡。
