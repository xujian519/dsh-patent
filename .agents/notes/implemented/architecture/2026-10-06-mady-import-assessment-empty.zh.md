# Agent Note: Mady 引入专利域的评估结论为候选集空

Status: implemented

[English](2026-10-06-mady-import-assessment-empty.md) | 中文

## Problem

Mady 是一个 Go 单体仓库（`github.com/xujian519/mady`，1689 个 `.go` 文件，`domains/` 下 33 个子包），自述为证据驱动的专利案件工作台。它的领域层与本仓专利域大面积重叠：确定性规则引擎、期限算术、claim chart 与 pin-cite 校验、IPC 审查标准、交底书分析管线、文档模板与审批门禁两侧都有。因此"Mady 的哪些能力可以引入 `@deepseek-ai/dsh-patent-*`"无法靠罗列目录回答，回答它消耗了一轮跨仓侦察——覆盖两个代码库、它们的 git 历史，以及资产的逐字节比对。

本仓已记录过若干"从 Mady 取"的决策：[阶段指导与 checker 判定 note](2026-09-03-patent-stage-guidance-and-checker-verdict.zh.md)引入了法律框架并否决了 trigger-keyword 模板路由（它不随包交付复核结论解析器，因为 checker 层只产出散文），[Mady 规则资产合并边界 note](2026-09-21-mady-rule-asset-merge-boundary.zh.md)确定了 313 条上游规则中哪些可转换、哪些不可。两者都没有记录 Mady 侧这些能力本身来自哪里，而这恰恰是决定该问题的那个事实。

## Decision

没有任何能力符合条件。九个候选领域中，五个在本仓已等价，其中三个本仓更强：数值范围重叠引擎多一档 `inside_without_endpoint` 判定，另有单位写在连接符前的读法与 LLM 双轨对照；pin-cite 校验多一层段号存在性核对，且源文无段号标记时跳过而非判失败；期限评估器覆盖 10 个期限族 20 个期限 id，哨兵是带 `requiredInput` 与 `reason` 的类型化 `PendingDeadline`，而上游 8 类中有 2 类是死枚举、完全没有节假日顺延、并把中文哨兵串写进声明为 ISO 8601 的字段。IPC 标准集在两仓逐字节相同，证据规则资产本仓是严格超集。

提交历史决定其余部分。Mady 在 2026-08-28 题为"引入 DeepSeek Harness 三批设计"的提交新增了 `domains/claimchart/pincite.go`、`domains/novelty/numeric_range.go`、`domains/rulekit/verdict.go` 与 `domains/slop/slop.go`。这四项是从本仓搬出的移植：它们出现在 Mady 侧，正是本仓早已有对应设计的证据。把它们引入，等于把本仓自己 2026-08 的工作搬回本仓。引入方向实际已反向发生三次：2026-08-17 的提交带入 `ipc-standards.yaml` 与 `evidence-rules.yaml`，2026-09-21 的提交带入侵权内核并在 `all-elements.ts`、`equivalence.ts`、`risk.ts` 的 JSDoc 中记录了有意改动，更早的提交带入了 checker 引擎、slop 引擎与质量评估器。

本仓是二者的下游，并维持这一位置。Mady 不再引入。

## Alternatives considered

**引入 Mady 的 Agent 框架。** Mady 跑在 `github.com/sky-valley/pi` 上，带自研 `agentcore`、自研 Pregel `graph` 引擎、35 个内置工具、8 层 Elm TUI 与 Wails 桌面壳。本仓跑在 Cordis 插件体系上，带 `agent-loop`、`packages/client` 与 `packages/core/tools`。两者同时采用意味着一个进程里两套 Agent 运行时、两套工具注册表与两套会话模型。

**引入 `domains/deadline`——唯一没有移植标记的区域。** 它是更弱的实现。8 类中的两类（`DeadlineReexamination`、`DeadlineInvalResponse`）在计算器里从未被 append；`deadline_extension.go` 全是 agentcore 适配胶水，没有任何节假日或顺延逻辑；"参见通知书"哨兵是靠字符串相等识别、塞在 `DueDate` 字段里的中文串。`patent-deadline` 的 20 个期限 id 在每个维度上都超过它。

**引入 `domains/rulekit` 的泛型规则抽象。** `Rule[T, C]` 的类型化上下文与基类是 Go 泛型的产物；TypeScript 的结构化类型已经提供同等收益且无需该抽象。此处引擎的上下文恒为 `text: string`，没有第二个消费者，这一层只在名义上满足"Require a current owner and need"。那个看似是缺口的可配聚合，其实只是两个整数字段 `ShouldBlockedAt` 与 `InfoRevisionAt`，其默认值已与 `checker/engine.ts` 中写死的阈值一致。

**引入 Mady 的 50 分制反套话评分。** 属于倒退。本仓的 43 分制与 `SLOP_PASS_LINE = 35` 是刻意设计；改用 50 分制需要连同五个维度基数与 `slop_clean` 阶段的 rewind 行为一起搬。

**引入 15 条侵权规则。** 其中能产出违规的 4 条本仓全部覆盖且更严格——等同矛盾 6 类对 1 类，禁止反悔与禁止捐献作为评分维度而非裸标记。其余 11 条在 Mady 侧运行时不可达：`RuleEngine.Check` 只回收 `!res.Passed` 的结果，而其中 8 条规则的 `Check` 完全忽略入参并无条件返回 `Passed: true`。

**引入证据规则资产或 IPC 标准资产。** 前者本仓是严格超集，后者逐字节相同。

## Consequences

今后关于"能否从 Mady 引入"的问题有据可依，且不必重跑跨仓侦察；候选清单并不短，其中四项的引入方向本身就是反的，这一点光看候选清单看不出来。

本次评估依赖的两项资产事实仍未处理。Mady 持有两份与本仓逐字节相同的 `ipc-standards.yaml`，两个仓库都没有门禁或共享生成器把三份副本对齐，因此[空卡片补齐](../bug-fix/2026-10-06-ipc-standards-empty-cards.zh.md)只改了其中一份。另有 21 张卡片在源库自身就是双空壳，两份副本皆然，无论怎么引入都改变不了。

本次未阅读的 Mady 区域仍然开放：`domains/analysiskit`、`graph/pregel.go` 的实现，以及 `domains/infringement` 中规则体之外的部分。Mady 自身的死代码——无调用方的 `evaluate.go`、加载器未绑定的 `weights:` 块、两套都注册且零共享代码的 slop 实现——是那个仓库的清理事项。

## Testing

本决策没有代码变更。评估依据是文件级比对与两个仓库的 `git log`：`evidence-rules.yaml` 的全文件比对给出三处差异，其中唯一实质改动在本仓一侧更具体；`ipc-standards.yaml` 的 `cmp` 返回 exit 0；`patent-core/src/atoms/handlers/builtin/extract.ts` 与 Mady `disclosure/types.go` 的结构比对显示两侧特征列表都是扁平的；`domains/infringement/rules.go` 中全部 15 个 `Check` 方法体连同调用点逐个读过；`git log` 用于区分三次 Mady→本仓的提交与一次本仓→Mady 的提交。
