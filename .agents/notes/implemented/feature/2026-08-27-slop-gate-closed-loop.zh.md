# Agent Note: slop-gate 闭环

Status: implemented

[English](2026-08-27-slop-gate-closed-loop.md) | 中文

## 问题

dsh 专利域已带确定性反套话引擎（`patent_eval`、内联 `slop-engine`），但撰写工作流没有门控：`patent_disclosure_v1` manifest 产出 `claims_draft` 后继续前进，因此写出的权利要求/说明书可能满是填充词与空洞结构而无人检查。Sati 以 `slop-gate` 原子加工作流 `retry`（失败回退到撰写阶段）闭环。dsh 缺的正是这段工程接线，且有一条硬约束：重写 prompt 绝不能收到评分数字。告诉模型哪个维度得分最低，等于邀请它优化指标而非改善产出——重试只能携带评审者实际看到的证据（命中短语与建议替换、行级结构问题）。

## 决定

`patent-tools` 现在提供 `slop-gate` 原子与 handler。handler 放在本包而非 `patent-core`，因为它依赖本包的 slop 引擎；`apply()` 在 `registerBuiltinAtoms()` 之上，将 `slopGateAtom` 与 `SlopGateHandler` 注册进全局注册表（`src/index.ts` 第 283-284 行）。

`slopGateAtom` 声明 `inputSchema: ['claims_draft', 'draft', 'draft_tightened', 'specification', 'text_keys', 'char_budget']` 与 `outputSchema: ['slop_report', 'slop_score']`。`SlopGateHandler` 对草稿确定性运行 `analyzeSlop`，写入 `slop_report`（✅ 通过 / ⚠️ 需修订，附总分与通过线）与 `slop_score`（总分）；当草稿未通过时，额外写入由新 `buildSlopRevisionHint`（`src/internal/retry-hints.ts`）构造的 `slop_revision_hint`。草稿为空或全空白时降级（`degraded('slop-gate', '输入为空…')`），而非抛错。

`buildSlopRevisionHint` 在构造层面执行保密契约：只输出命中短语变更（上限 8 条）与结构问题（上限 3 条）及余量统计，外加一句固定修订方向，绝不输出评分数字、总分、通过线或任何 checklist 判定。无任何可引证据时返回 `undefined`，handler 便不写 hint——未通过但无证据的草稿照常过不了门，却不会注入空提示的语义噪音。

闭环复用既有的工作流 `retry` 机制：`patent_oa_response_v1` 的 `slop_gate` 阶段声明 `retry: { whenOutputMatches: '需修订', rewindTo: 'draft', maxRetries: 1 }`。命中失败信号时回退阶段输出到 `draft`；回退移除 stage-id 状态键但保留非 stage 键，故 `slop_revision_hint` 存活，重写 prompt 以「上一轮反套话评审意见（仅修订提示，不含评分）」收到它。第二次失败耗尽重试并降级为 `[WORKFLOW_RETRY_EXHAUSTED]`，以显式「需修订」报告收尾，而非静默通过。

`patent_disclosure_v1` 的 `slop_clean` 阶段沿用同一原子，但不声明 `retry`：披露链的权利要求由策略表确定性渲染，回退到 `draft_claims` 既改不了文本也改不了分数，第二次失败只会耗尽重试、把运行判成未完成。该阶段现在评 `specification`，未通过只经 `slop_report` / `slop_score` 报告，不降级。

`patent-core` 现经两个 atom barrel 导出 `degraded`；slop-gate handler 是它的首个消费者。通过线保持为固定常量（`SLOP_GATE_PASS_THRESHOLD = 35`，已导出），因为它是移植 slop 引擎的校准阈值，而非随部署变化的可调项。

## 曾考虑的替代方案

- **把门放进 `patent-core`。** 门需要 slop 引擎，而 `patent-core` 不能依赖 `patent-tools`（工具包才是消费者）。把原子与 handler 留在 `patent-tools` 保持依赖方向；`patent-workflow`——不依赖 `patent-tools`——在其 manifest 校验测试中注册契约 stub 而非导入真实原子。
- **把失败维度告诉模型。** 把最低分维度或总分回喂给重写 prompt，会邀请模型优化指标。仅含证据的提示（评审者实际看到的）保持重写诚实，也正是 Sati retry-hints 移植的做法。
- **模型判分的 slop 门。** 用 LLM 节点打分会给确定性引擎已能回答的检查重新引入不确定、延迟与成本。引擎的结构问题与短语规则是精确的；缺的只是门控接线。
- **工具层手写回退循环。** 工作流 `retry` 机制已实现 splice-back 回退与耗尽降级；再造一个循环会重复状态回滚语义并偏离 manifest 契约。

## 影响

- 答复正文现受门控：套话草稿先带仅含证据的指引重写一次，仍失败则降级为显式「需修订」报告——模型无可追逐的伪分数上限。披露链上同一道门只报告：说明书未达通过线不阻断交付。
- 模型可见面只携带证据（短语→替换、行号→原文→建议）加一句固定修订方向；评分数字、总分与通过线永不进入模型请求。因 hint 是模型可见输入，它属于撰写 prompt 的一部分，可从 session log 重建（`Model-visible ⟺ logged`）。
- `slop_clean` 阶段给 disclosure manifest 增加一次确定性、无 LLM 的检查（廉价），`patent_workflow_run` 无需新配置即可运行。
- `patent-workflow` 的 manifest 校验测试现注册 `slop-gate` 契约 stub，因为该包不能依赖 `patent-tools`；真实原子由 `patent-tools` 测试与 `apply()` 覆盖。

## 测试

`slop-gate.spec.ts`（patent-tools）覆盖 handler 通过/未通过/空输入降级路径、保密契约（hint 绝不含评分词汇）、无证据 `undefined` 情形、上限截断与余量统计、替换型渲染，以及无建议的 issue。`atoms.spec.ts`（patent-core）覆盖 `slop_revision_hint` 注入撰写 prompt（存在与缺失两种）且注入的 hint 不泄漏评分。`workflow-retry.spec.ts`（patent-workflow）以注册 stub 断言 `slop_clean` 阶段声明与顺序。`patent-workflow-run.spec.ts`（patent-tools）注册真实 slop-gate 原子与 handler，使 disclosure manifest 经工具完成校验与运行。被触及的包保持每文件 100% 语句/分支覆盖率。
