---
description: "**`BasicSelfEvolveEngine`** 是 `ctx.selfEvolve` 的默认提供方。它连接 `failure-patterns` 投影单元，在 idle 或显式请求时触发进化循环，并通过可逆 Cordis effect 提交窄范围的 L1（技能）与 L2（提示片段）提案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-self-evolve-basic

[English](README.md) | 中文

## 概述

**`BasicSelfEvolveEngine`** 是 `ctx.selfEvolve` 的默认提供方。它连接 `failure-patterns` 投影单元，把进化请求排队并在 agent 的 idle 边界驱动，再通过可逆 Cordis effect 提交窄范围的 L1（技能）与 L2（提示片段）提案。


## 目录

- [角色](#role)
- [触发器与队列](#triggers-and-queue)
- [配置](#configuration)
- [验证管线（Phase 1）](#validation-pipeline-phase-1)
- [负面结果（P1.7b）](#negative-results-p17b)
- [L2 prompt-section persistence](#l2-prompt-section-persistence)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="role"></a>
## 角色

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-self-evolve` | Service Definition：抽象 `SelfEvolveEngine` + 持久事件 |
| `@deepseek-ai/dsh-self-evolve-basic`（本包） | Service Provider：基于投影的 idle 压力策略 + 基础提案/验证器 |
| `@deepseek-ai/dsh-tool-self-evolve` | Consumer：面向模型的工具与提示片段 |

<a id="triggers-and-queue"></a>
## 触发器与队列

四条触发链都能到达循环。`idle-maintenance` 在 agent 上报 `agent/status` 为 `idle` 且会话不是 subagent（origin 为 `subagent`、存在父会话或委派深度大于零）时启动。`pressure` 在 `compaction/start` 的 `turn` 非空时启动，因此自动压缩计入、手动 `/compact` 不计入。`user-command` 由 `requestEvolve` 启动，调用者是 `self_evolve_now`；它绕过 `minIntervalMs` 与 `maxDailyLoopsPerSession`，且永不被淘汰。`validation-retry` 由提供方自身启动：一次 `low-confidence` 拒绝为每个 pattern 排一次重试，上限为 `maxValidationRetriesPerPattern`，其他拒绝原因一律不排队。

`requestEvolve` 维护 per-session 的内存 FIFO，优先级为 `user-command` > `validation-retry` > `pressure` > `idle-maintenance`。level 集合相同则合并并返回 `status: 'coalesced'`；队列达到 `maxPendingEvolveRequests` 时淘汰最旧的自主请求，保留所有显式请求。每次 drain 最多启动一个请求，进程退出时仍在排队的请求会丢失。drain 在启动维护前重新检查 `agent.status === 'idle'` 与会话打开状态，agent 忙时请求留在队列里等下一个 idle 边界。

显式请求完成后，若启用了 `notifyOnExplicitRun` 且该次运行产生了提案或提交，则发送一条 follow-up 消息；自主运行从不通知。

<a id="configuration"></a>
## 配置

`BasicSelfEvolveConfig` 控制触发策略、速率限制、默认编辑面与验证容差：

| 字段 | 默认值 | 语义 |
|---|---|---|
| `maxDailyLoopsPerSession` | `4` | 每会话每 24 小时窗口内最多启动的自主循环次数；显式 `user-command` 循环不受此限制。 |
| `triggers` | 全部启用 | 每个触发器 `{ enabled, minIntervalMs }` 策略，包括 `idle-maintenance`、`pressure`、`user-command` 与 `validation-retry`。 |
| `defaultLevels` | `['L1-skill', 'L2-context']` | 提案默认允许瞄准的编辑面。 |
| `minPatternOccurrences` | `2` | 模式成为提案目标前所需的最小出现次数（`tool-runtime` 模式需要额外一次）。 |
| `maxProposalsPerLoop` | `2` | 每次循环最多生成的提案数。 |
| `requireDualVerification` | `true` | Held-in 双验证器门（翁荔挑战 1）：当两个验证器信号都可用时，重放与工作区检查必须同时通过才放行；单边通过视为不确定并直接拒绝，不计入 regression。任一收集器无信号时，该维度计为缺失而非通过，提案以 `verifier-unavailable` 拒绝。 |
| `minAcceptConfidence` | `0.5` | 验收门：`min(deconstructedScores) × heldInRate × heldOutRate` 必须达到该值。任一维度缺失信号都会把乘积压到 0.3 及以下，因此这类提案在该比较之前就以 `verifier-unavailable` 拒绝——任何阈值都不会把缺失的证据变成验收。 |
| `maxHeldOutCases` | `5` | 每个提案作为 held-out 案例搜索并重放的相似历史事件数（P1.3）。 |
| `heldOutSessionIds` | `[]` | 提供 held-out 案例的会话 id（P1.3）。留空则回退到提案会话本身——那是自证而非独立探针；请填该循环未干预过的会话。 |
| `minHeldOutPassRate` | `0.6` | held-out 通过率阈值（P1.3）：相似历史重放达到或超过该比例才计为 held-out 通过。 |
| `proposerTarget` | 无 | 提案 LLM 调用可选的 `{ provider, model }` 路由。 |
| `validatorTarget` | 无 | 验证 LLM judge（P1.4）可选的 `{ provider, model }` 路由；未配置时 judge 维度无信号，所有提案都以 `verifier-unavailable` 拒绝。与 `proposerTarget` 相同时加载失败。 |
| `maxDirtyLinesAddedPerCommit` | `2` | held-in 工作区验证器（P1.9b）允许的脏行容差；重放最多可净新增这么多脏行，超过即作为工作区回归被拒绝。 |
| `workspaceVerifier` | `{ enabled: true }` | held-in 工作区验证器策略（P1.9b）：`enabled` 为总开关；`buildCommand`（如 `pnpm run build`）为重放后运行的项目构建命令；`gitTimeoutMs`（默认 30000）与 `buildTimeoutMs`（默认 300000）约束 git 与 build 运行。未配置 `buildCommand` 时信号保持不可用，循环退化为弱路径。 |
| `maxPromptInflationBytesPerWeek` | `2048` | 长视界提示膨胀预算（翁荔挑战 7），按 UTF-8 字节计量：存活 self-evolve L2 片段总字节超限时，pruning job 把最旧的归档到 `$DSH_HOME/self-evolve/l2-archive/`、把退休记录写入 `l2-committed.jsonl`，并撤销其 effect，直到总量回到预算内（P1.9）。片段按注册时间排序；基于使用情况的排序尚未实现。 |
| `l4ReapprovalHours` | `24` | L4 复审节奏（P2.3）：本提供方驱动过的插件，当当前提案与上次已批准提案不同或批准时间超过该窗口时，强制再次走人工审批——即使存在 `approveFutureVersions` 授权。 |
| `maxStepReflectionsPerTurn` | `1` | 步骤反思节流（P3.1）：失败步骤上的低成本 LLM 反思每轮最多运行这么多次；`0` 关闭。 |
| `reflectionMinConfidence` | `0.85` | 步骤反思强化模式的模型置信度下限（P3.1），低于此值丢弃；命中后追加 `self-evolve/reflection` 事件。 |
| `patternFreezeHours` | `24` | 每模式提案冻结（P3.3）：同一模式被提案两次后在该窗口内跳过（多样性坍缩防护）。 |
| `maxBudgetCharsPerLoop` | `32768` | 单循环 LLM 调用与搜索的字节预算（P3.4）；超限以 `budget-exceeded` 中止循环并以错误关闭括号。 |
| `allowUnverifiedAutonomousRuns` | `false` | 部署无法验证提案（未配置 `workspaceVerifier.buildCommand` 或 `validatorTarget`）时，自主触发是否仍可运行。`user-command` 请求无论此项如何都执行，并报告 `verifier-unavailable`。 |
| `maxValidationRetriesPerPattern` | `1` | 每个 pattern 的 `validation-retry` 上限；`0` 关闭该触发器。 |
| `maxPendingEvolveRequests` | `8` | 每会话排队请求数上限；超出时丢弃最旧的自主请求，显式请求永不被丢弃。 |
| `notifyOnExplicitRun` | `true` | 显式请求完成且产生提案或提交后，发送一条 follow-up 摘要。 |
| `maxNegativeResultRows` | `500` | `negative-results.jsonl` 保留行数；超限后以原子重写保留最新行。 |
| `maxGlobalPatternRows` | `1000` | `global-patterns.jsonl` 保留行数，同样原子裁剪。 |
| `maxTrackedSessions` | `64` | 会话级速率、反思、提案、回归与重试状态保留数量，超出按最近最少使用淘汰。 |
| `maxTrackedPatternsPerSession` | `256` | 上述 map 中每会话保留的 pattern 键控条目数。 |
| `maxLiveSkills` | `32` | 本提供方可拥有的存活 runtime 技能数；新增 L1 提交超出上限时以 `apply-failed` 拒绝，而不淘汰存活技能。 |

L3 与 L4 提案不在此基础提供方中实现；下游提供方可以安全地子类化 `proposeForPatterns()` 与 `validateProposal()`。

<a id="validation-pipeline-phase-1"></a>
## 验证管线（Phase 1）

`validateProposal` 运行 Phase 1 管线：held-in 双验证（fork 重放 P1.2 + 工作区验证器 P1.9b）、`sessionQuery.searchEvents` 命中事件的 held-out 相似性重放（P1.3）、`validatorTarget` 上的 LLM judge（P1.4）与聚合置信度门。工作区验证器先采集重放前基线，再测量重放的净 git 脏增量（`git diff HEAD --numstat` 加未跟踪文件行数，排除 harness 自营的 `.dsh/` 路径）并运行配置的 `buildCommand`；两者都需在 `maxDirtyLinesAddedPerCommit` 容差内通过。每个无信号的维度都按弱路径 0.3 计并记名，因此验证器无法评判的提案在该阈值比较之前就以 `verifier-unavailable` 拒绝——这与 `low-confidence`（验证器评判其不佳）有本质区别。held-out 案例只从提案会话自身的历史中检索，并排除该模式的 supporting seq。被拒提案落入负面结果日志（P1.7b）；同一模式连续两次回归会回滚已归档的 champion（P1.8）。

<a id="negative-results-p17b"></a>
## 负面结果（P1.7b）

被拒绝的提案以每行一条 JSON 的形式追加到 `$DSH_HOME/self-evolve/negative-results.jsonl`（`{ts, patternId, proposalId, reason, diagnostic, deconstructedScores?, nextRoundSuggestion}`）。`readNegativeResults(patternId, limit)` 加载某个模式最近的结果行，模板提案器会把它们摘要进生成的提示片段文本，避免反复提出已失败的同款方案；`readPatterns` 也会把最近失败注入每个模式的 `verifierMeta.failedProposals`（P1.6）。

## L2 prompt-section persistence

已接受的 L2 片段会追加到 `$DSH_HOME/self-evolve/l2-committed.jsonl`，提供方在启动时按 `maxPromptInflationBytesPerWeek` 预算重新注册每个片段名的最新一行。pruning 与回滚会为片段名追加退休行，因此已退休的片段不会被恢复。

## Model Experience

### 稳定的 self-evolve 引导

#### 模型看到什么

`@deepseek-ai/dsh-tool-self-evolve` 注册了一个稳定的提示片段，告诉模型何时调用 `self_evolve_inspect_patterns` 与 `self_evolve_now`。本提供方还会为已接受的 L1/L2 提案注册运行时技能与提示片段；这些贡献被限定在提供方 fiber 内，并在验证失败或 disposal 时回滚。

#### Token 效果

已接受的提示片段提案会在后续轮次中向系统提示追加文本。已接受的技能提案会增加可检索技能内容，当技能注册表匹配到当前轮次上下文时可能会被纳入。

#### KV Cache 效果

只要消费者处于加载状态，稳定的 tool-self-evolve 提示片段就会出现在每次请求中，因此参与请求前缀。提案驱动的提示片段与技能从它们提交生效的轮次起加入前缀。

## Known Limitations and Deferred Work

- **仅 L1/L2** — provider 面向技能（L1）与提示词段落（L2）提案；L3-workflow 与 L4-harness 请求暂不产生提案。
- **三个维度全部有信号之前不会发生提交** — held-in 工作区验证器（P1.9b）只对配置了 `workspaceVerifier.buildCommand` 的 git 仓库产生信号；judge 只在设置了 `validatorTarget` 时产生信号；held-out 探针只在存在相似的、非 supporting 的历史时才产生信号。任一维度缺失都会把聚合压到弱路径，`minAcceptConfidence`（0.5）永远无法达到，因此随附默认会把每个提案都以 `verifier-unavailable` 拒绝。启用全部三维是显式的组合步骤，不是随附默认。
- **held-out 默认限于本会话** — 除非用 `heldOutSessionIds` 指定其他会话，`collectHeldOutSignal` 只检索提案会话自身的事件历史，因此默认配置无法提供独立分布；新会话中集中的失败模式常常一条命中都没有。
- **重放证明"确实做过"，而非"确实修好"** — `replayCase` 要求子代理正常结束、至少执行过一次工具调用、且未重新触发任何失败模式。三者都读自持久事件，但都不能证明原失败真的被修复：跑错命令的子代理同样会通过。客观评判需要失败模式携带可重放的命令与预期结果。
- **L4 仅由人工审批授权** — `validateL4Proposal` 记录 `L4_APPROVAL_SCORES` 并把 `confidence` 固定为 1；聚合门不评估 L4，人工审批流是它唯一的防线。
- **L1 与 L2 可跨重启存活；L3/L4 不可** — 已接受的 L1 技能是 `<cwd>/.dsh/skills/` 下的文件，已接受的 L2 片段是 `$DSH_HOME/self-evolve/l2-committed.jsonl` 中启动时重放的提交行。L3 workflow 脚本与 L4 harness 插件是进程内 effect，随提供方 fiber 结束而消失。
- **无 keyed 端到端验证** — 提案效果是可逆提交，由单元测试覆盖；实机 `dsh --profile` 循环运行需要 keyed 环境。
- **首次提交回滚写入 tombstone** — 回滚本提供方首次提交的技能时，运行时会恢复技能，但 `.dsh/skills/<name>/SKILL.md` 被重写为无 frontmatter 的内容，因为 `fs` seam 没有删除原语；skill 文件系统会忽略该文件并记一条扫描 warning。回滚到 champion 时则用 champion 内容重写该文件。
- **队列状态在内存中** — 活过进程的排队请求会丢失；`self-evolve/start|end` 与工具回执作为持久记录留在 session log 中。

### 开发备注

无。
