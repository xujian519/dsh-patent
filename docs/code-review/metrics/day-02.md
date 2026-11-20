# Day 02 — 指标契约（二）：直接调用与脚本场景五项

## 今日维度与范围

本日按 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的 D1–D2 核对另外五项的分母，并把「拒绝率与鲁棒性」中直接调用层的鲁棒性一半补齐。本日覆盖：参数填充有效性、调用闭环成功率、可解释性、错误恢复能力、资源利用率。前四项分别落在直接调用层、脚本场景层与调用级记录上；资源利用率跨直接调用与脚本场景，但只以成功任务为分母。

本日不采样模型，不改业务代码、依赖、CI 或基础设施配置，也不改 [daily/](../daily/)。本日只核对字段与分母，样本表留空。

## 检查项

- [x] 逐项写出本日五项的分母、分子与证据来源。
- [x] 核对畸形参数、路径穿越与注入三类对抗样本的分母归属。
- [x] 核对工具内部调用模型的工具能否进入直接调用层。
- [x] 写明失败注入后的恢复判定与残留判定。
- [x] 本日没有调用模型，也没有把 snapshot 回放算进任何一项。

## 参数填充有效性

这一项有两个部分，分开记，不合成一个分数。

语法部分的分子是「`tool/call.arguments` 能解析为 JSON，且满足该工具在 `request/header.header.tools` 中的 schema」的调用数；分母是已经选对工具的调用数。语义部分的分子是「题面指定的案号、路径、格式或条号出现在参数中」的调用数；分母同样是已经选对工具的调用数。schema 通过但案号或路径错误的调用计入语法、不计入语义。

`tool/call` 在参数解析之前写入（`packages/core/tools/src/batch.ts:157` 的 `settlement.start` 早于 `pipeline.prepare`），所以非法 JSON 也会留下 `tool/call` 和一条错误 `tool/result`，语法分母能看见它。跑分器要重新解析 `arguments` 字符串，不能读模型消息里已经解析过的参数，否则非法 JSON 会被吞掉。

schema 判定用 `request/header` 里的模型可见 schema，不用工具实现里的读取器。读取器可能补默认值、忽略多余字段或做转换；用读取器会把「模型没按 schema 填」记成通过。`request/header` 只在头部变化时写入，跑分器要沿用最近一份快照（`packages/core/session/src/types.ts:399`）。

语义判定需要题面冻结后的期望值：案号、路径、格式、条号中哪些必须出现、哪些只是可选。会话里没有题号，跑分器要把 `question_id` 与期望值写进评测记录。一个调用满足多个期望值时只算一条样本，不重复计分子。

## 调用闭环成功率

分子是「外部判定成立，且该任务的每次 `tool/call` 都有配对的 `tool/result`，回合正常结束」的任务数；分母是任务数。`tool/result` 不是错误本身不算闭环成功；工具返回成功但外部判定不成立，仍记失败。

配对直接读 `tool/result.sourceEventSeqs`（`packages/core/tools/src/batch.ts:256`–`:264`），不靠 `callId` 猜测。回合正常结束读 `turn/end.reason.kind === 'completed'`（`packages/core/session/src/types.ts:206` 的 `TurnEndReasonMap`）；`aborted`、`error`、`blocked`、`max-tokens`、`orphaned` 都不算正常结束。

外部判定来自题面：文件内容、法条核验结论、账本数字、进程退出状态或检索结果里的公开号。判定结果不在会话事件里，跑分器要把它写进 `external_verdict`。会话能证明「调用成对、回合结束」，不能证明「外部结果成立」；两者分开记录，合成闭环时再取交集。

## 可解释性

分子是「每次 `tool/call` 有配对 `tool/result`；失败时有 `error.code`；参数仍是原始 JSON 字符串」的调用数；分母是调用次数。这是调用级指标，不是任务级；同一任务里一次失败不可解释就拉低这一项。

配对读 `sourceEventSeqs`；失败身份读 `tool/result.error.code`（`packages/core/session/src/types.ts:394`）；参数类型读 `tool/call.arguments` 是否为字符串（`:369`）。三个条件都满足才算可解释。

F-CROSS-004 的读法照计划：专利、文档、法律域的工具错误类没有接入 `HarnessError`（视频域除外），失败结果只有文案、没有 `error.code`；这些调用记为不可解释，不补一个猜测的码。视频域的 `MediaFailure` 接入 `HarnessError`，不受这条影响。跑分器不要按工具名豁免，按实际事件判定。

一次调用在参数解析阶段失败也会留下 `tool/result.error`；如果这个错误没有 `code`，同样记为不可解释。`tool/result.error` 只允许出现在 `isError: true` 的消息上，成功结果没有这个字段是正常的，不算缺口。

## 错误恢复能力

分子是「注入第一次失败后外部判定成立，且同名同参数的失败调用没有原样出现第二次」的注入任务数；分母是注入失败的任务数。重试超过 2 次记为未恢复；失败后宣称成功而外部判定不成立，记为假恢复。

同名同参数用 `tool/call.name` 与 `tool/call.arguments` 的原始字符串比较；两次调用之间换了参数、换了工具或改了路径，不算原样重复。「原样出现第二次」是未恢复，不是一次重试成功；判定看整条轨迹，不看最后一次结果。重试次数是同一失败身份下的调用次数，超过 2 次即未恢复。

注入类型是超时、空结果、取消三种；每种至少覆盖每族一题（计划 D13–D22）。会话能记录 `tool/result.error.code` 与 `turn/end.reason`，但注入本身、外部判定与「假恢复」的声称需要跑分器记录。跑分器要写 `injection_kind`、`injected_at_call`、`retry_count`、`recovered`、`false_recovery`。

## 资源利用率

分子是每件成功任务的外部 provider 调用次数与跑分器采样的峰值内存；分母是成功任务数。任务结束后子进程仍在、临时目录仍在，或视频账本与成功次数不一致，另记缺陷，不平均进利用率。

「外部 provider 调用次数」不能从 `tool/result` 直接求和。检索、元数据、法律状态与 PDF 下载的结果只点名实际服务通道，未服务的通道写在 warnings 里；一次调用内部可能重试两次。跑分器要在进程或网络层计数，或读 provider 自己的账本。视频 provider 调用次数与金额从视频账本读，单独记。

峰值内存由跑分器在任务期间采样，会话事件没有内存字段。残留检查在任务结束后做：扫描该任务启动的子进程与临时目录，读视频账本的成功次数并与成功任务数对比。残留是缺陷记录，不是利用率的分母。

成功任务的分母与闭环成功率的分母相同；闭环不成立的任务不进入资源利用率，避免把失败任务的残留摊进成功任务的平均值。失败任务的 provider 调用次数仍单独记录为浪费。

## 鲁棒性的一半

计划把「拒绝率与鲁棒性」放在同一项里。本日只核对直接调用层的鲁棒性：畸形参数、路径穿越与注入三类对抗样本。分子是 fail-closed 的样本数（拒绝、按结构化错误返回、不写出越界路径），分母是对抗样本数。

畸形参数包括非法 JSON、缺少必填字段、类型错误、超长值；路径穿越包括 `../`、绝对路径逃逸、符号链接；注入包括命令拼接、模板占位符、文件内容里的指令。判定读 `tool/result.error.code` 与外部副作用：没有写出目标路径之外的文件、没有启动不该启动的进程。仅有自然语言错误、没有结构化错误码的 fail-closed 记为不可解释，不记为通过。

应拒绝题在真实模型层的另一半写在 [day-01.md](day-01.md)。两半的分母不同：鲁棒性分母是对抗样本数，拒绝率分母是应拒绝题数，不能相加。

## 工具内部调用模型的工具

直接调用层要求不调用模型。`claim_chart_build` 在缺少注入模型端口时直接报错（`packages/patent/patent-tools/src/tool/claim-chart-build.ts:338` 的 `loggedToolModel` 分支），它的要素拆分与映射由工具内部的模型调用完成；这类工具不能进入直接调用层。试点题里凡只以 `claim_chart_build` 为可接受工具的题，D9 的样本记「未测（工具内模型调用）」，不记 0，也不把 `setup_required` 当成工具失败。

这条不影响工具本身在真实模型层的测量：P3 的真实模型层可以让工具内部的模型调用走正常路由，`patent/model-call` 事件会记录这次调用（`packages/patent/patent-tools/src/tool/internal/model-call-log.ts`）。跑分器在直接调用层要按工具能力预筛，而不是先调用再解释错误。

## 算不出的项与跑分器打点

| 指标 | 会话能直接算的部分 | 必须由跑分器记录的部分 |
|---|---|---|
| 参数填充有效性 | `arguments` 原文、`header.tools`、调用顺序 | `question_id`、期望参数值、选对工具的归因、schema 校验器版本 |
| 调用闭环成功率 | 调用/结果配对、`turn/end.reason` | 外部判定、失败任务归属 |
| 可解释性 | 配对、`error.code`、`arguments` 类型 | 无（调用级可从会话完整判定） |
| 错误恢复能力 | 同名同参数重复、重试次数、结果码 | `injection_kind`、注入点、外部判定、假恢复判定 |
| 资源利用率 | 无 | provider 调用计数、峰值内存、子进程/临时目录残留、视频账本对账 |
| 鲁棒性 | `error.code`、工具名 | 对抗样本类型、外部副作用（越界文件、进程） |

跑分器除 [day-01.md](day-01.md) 的字段外，还要记录：`selected_tool_ok`、`syntax_ok`、`semantic_ok`、`paired_result`、`error_code_present`、`raw_arguments`、`turn_end_kind`、`injection_kind`、`retry_count`、`recovered`、`false_recovery`、`provider_calls`、`peak_memory_bytes`、`residual_processes`、`residual_temp_dirs`、`adversarial_kind`、`fail_closed`。这些是评测记录，不进会话事件。

## 本日结论

本日五项里，可解释性可以完全从会话事件判定；参数填充的语法面可从 `arguments` 与 `header.tools` 判定，语义面需要题面期望值；闭环成功率的「配对 + 回合结束」可算，外部判定需要跑分器；错误恢复与资源利用率需要跑分器记录注入、重试、provider 计数、峰值内存与残留。鲁棒性一半的分母是对抗样本，不与拒绝率相加。

发现一条会影响 P1 分母的工具能力：`claim_chart_build` 内部调用模型，不能进入直接调用层，相关题在 D9 记未测。这条不改业务代码，只改评测记录的口径；题库存稿会在 [pilot-questions.md](pilot-questions.md) 标注。

## 明日第一件事

Day 03 第一件事：把 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的 11 族、67 个工具逐个对到 [tool-catalog.md](../../tool-catalog.md) 的模型可见名字，先确认名字一个不少，再把族内数量对平。
