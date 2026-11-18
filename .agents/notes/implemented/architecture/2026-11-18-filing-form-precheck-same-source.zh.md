# Agent Note: 申请文件的形式预检读的就是将被写出的草案

Status: implemented

[English](2026-11-18-filing-form-precheck-same-source.md) | 中文

## Problem

`build_patent_filing` 写出的是交给 CNIPA 的申请文件 DOCX。它此前只校验草案结构（`validateSpecDraft`），不跑形式规则，于是专利局据此退案的形式项——章节标题集合与顺序、带括号的附图标记、写成「图 1」的图号、长度不合要求的摘要——进入了交付件。专利 preset 的交付门禁把 `validate_specification` 列为前置，但交付门禁记的是「本会话内某个工具返回过通过的结果」，记不了模型交给它的文本就是本次调用要写出的文本：模型可以校验一份副本、先校验再重写草案，或每次调用递不同的草案。

## Decision

- `@deepseek-ai/dsh-patent-tools` 注册一个 `tools.guard`，拒绝 `build_patent_filing`。调用执行前，guard 用 `contentFromDraft`——docx 通道用的同一份映射——从 `args.draft` 重建说明书，再对该文本、权项与摘要跑 `validateSpecification`。被检查的文本与将被写出的文本出自同一份映射，标题行、权项编号与图号在检查与交付件之间不可能分叉。
- 只有 `structure`、`figures`、`abstract`、`prohibitions`、`title` 五族的 `error` 级结论拒绝调用。`description` 与 `claims` 族不拒绝：实施例存在性、数值范围端点与特征覆盖属于实质撰写判断，一份合法说明书也会命中，把它们变成交付阻断会拒掉专利局本会受理的申请。这些结论留在模型自己调用 `validate_specification` 时看到的完整报告里。warning 一律不拒绝。
- 过不了 `validateSpecDraft` 的草案不由 guard 拒绝。此时副本取为 undefined，调用照常进入工具，工具本来就按字段逐条报告结构缺陷；在这里拦会把同一条缺陷以两种格式报两遍。
- 拒绝理由逐条列出规则 id、行号、说明与修法，并写明被拒的调用没有写出 DOCX。guard 在下次调用时重新运行，因此改好的草案直接放行，没有需要重置的会话状态。
- `validate_specification` 继续留在 preset 的交付门禁前置里。guard 执行的是形式族的硬拦；门禁保证模型看过完整报告，其中包括 guard 刻意不阻断的 warning 与 `not_assessed` 项。
- 依赖边是 `patent-tools` → `patent-filing`。反向会让 DOCX 引擎依赖本包的规则资产，并经其 peer 拖入 `llm`、`law`、`knowledge` 与 `approval`；两者共用的只有形式规则与 `contentFromDraft`。

## Alternatives considered

- **把形式规则搬进 `patent-core`**，让两个包都从共同叶子导入。`validate_specification` 的实现加规则表约 1200 行；搬过去要么产生两份实现，要么让共享词汇包 `patent-core` 拥有一个说明书校验器。评估过这次抽取的成本后，改为复用既有导出。
- **把检查放进 `patent-filing` 的 `build_patent_filing` 内。** 这会把依赖方向颠倒：`patent-filing` 要导入 `patent-tools` 的 `validateSpecification`，并经该包的 peer 把一个 LLM、法条、知识库与审批依赖链拉进「写一个 DOCX」。
- **只靠 preset 的交付门禁。** 门禁证明的是本会话跑过一次通过的检查，不是校验了哪份文本。这正是本记录要闭合的缺口；门禁因它强制的那份报告而保留。
- **对报告里所有 `error` 都拒绝，含 `description` 与 `claims`。** 单是 `embodiments` 规则，就会让一份从未按规则识别的写法写下「实施例」的说明书失败，而合法公开内容可以这样写；把撰写质量项变成交付阻断会拒掉形式合规的申请。

## Consequences

- 违反形式规则的申请文件写不出来，即便模型从未调用 `validate_specification`。guard 与 preset 门禁现在各管一件事，两者都不冗余。
- 形式规则经 `validate_specification` 自身实现进入交付路径，因此改动一条规则会同时改变报告工具与阻断器，且只有一处。`FORM_FAMILIES` 是显式清单：新增在某族下的形式规则若不在清单内，只会报告、不会阻断，把该族加进清单属于一次有意的策略变更。
- 本包增加对 `@deepseek-ai/dsh-patent-filing` 的 peer 与 dev 依赖及一条 tsconfig reference；`docs/module-graph.md` 与 `pnpm-lock.yaml` 重新生成。
- guard 在每次 `build_patent_filing` 调用时运行，因此模型若同时调用 `validate_specification`，同一份说明书会被扫描两次。规则集是纯内存字符串匹配、无 I/O，第二遍不产生 I/O，也不消耗模型 token。

## Testing

- 单测（`packages/patent/patent-tools/tests/filing-form-audit.spec.ts`，9 个用例）：重建文本含五个标题行、`图1为…`、`1. ` 形式的权项编号与摘要；形式正确的草案零违规；带括号的附图标记与「图 1」空格各自被拒；读起来像标题的正文段落不被当成标题行；拒绝文本点名规则、修法与未写出 DOCX。两个集成用例挂载真实插件、注册一个替身 `build_patent_filing`，断言执行前被拒与改好的草案进入工具；第三个用例释放插件 fiber 后断言 guard 不再拒绝。
- Preset（`packages/bundle/web-app/tests/patent-preset.spec.ts`）：精确断言 `build_patent_filing` 条目的前置清单与 `validate_specification` 的 `passed: true` 证据。
- 门禁：本次改动上 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test:docs`、`pnpm run hygiene`、`pnpm run build`（产物加聚合检查）与 `pnpm run verify-module-graph` 全部通过。
