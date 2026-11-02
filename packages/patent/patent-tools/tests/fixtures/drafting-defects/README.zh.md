# 起草缺陷夹具

[English](README.md) | 中文

每条夹具固定说明书片段、权利要求片段与桩 provider 返回的记录。`drafting-defects.spec.ts` 先运行 `enablement-report` 与 `claim-breadth`，再把输出交给 `legal-gaps`，断言汇总状态。夹具不调用真实模型。

## 目录

| 文件 | 内容 |
|---|---|
| `types.ts` | 夹具与桩记录类型 |
| `a263.ts` | D01–D05，A26.3 充分公开缺陷 |
| `a264.ts` | D06–D09 与 D11，A26.4 概括范围缺陷 |
| `clean.ts` | D10，两条法条都通过的对照例 |
| `index.ts` | 导出的夹具列表 |

D11 是锚点探针：桩模型给出 `defect: 'none'`，但摘录与说明书差一个字，只有程序侧锚点复核能把它判为未通过。

## 新增一条夹具

1. 在 `a263.ts` 或 `a264.ts` 中新增夹具，或新建文件并在 `index.ts` 导出数组。
2. 用 `checks` 指定要断言的 `legal-gaps` 项：`enablement`、`claim-support-breadth` 或两者。
3. `enablement` 记录的特征 ID 必须与原子派生结果一致：`C{权项号}F{特征序号}`，特征是特征部按 `，`、`；`、`。` 切分后的顺序。
4. `quote` 必须逐字复制 `specification`。即使桩模型写 `enabled: true` 或 `defect: 'none'`，改写过的摘录也会被锚点复核判为未命中。
5. 运行 `pnpm exec vitest run packages/patent/patent-tools/tests/drafting-defects.spec.ts`。测试会遍历全部导出夹具并断言其 `legal-gaps` 状态。

两项判定都是 warn 级，因此失败夹具必须让 `legal_gaps_passed` 保持 true，且 `claim-support-breadth` 不出现在 `revision_targets`。D10 必须同时通过两项检查，证明夹具不会误杀有支撑的样本。
