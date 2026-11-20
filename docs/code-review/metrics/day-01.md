# Day 01 — 指标契约（一）：真实模型五项与样本分母

## 今日维度与范围

本日按 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的 D1–D2 核对十项指标的分母。本日只处理真实模型层五项与三层共用的样本口径；直接调用层与脚本场景层的五项写在 [day-02.md](day-02.md)。本日不采样模型，不改业务代码、依赖、CI 或基础设施配置，也不改 [daily/](../daily/)。

计划给真实模型层的五项是：工具选择准确率、拒绝率与误拒、响应时间、成本效率、上下文利用率。D1–D2 的产出是「哪些分母能从会话事件算出、哪些必须由跑分器打点」，不是测量结果；样本表留空，不填 0。

## 检查项

- [x] 逐项写出十项指标中本日五项的分母、分子与证据来源。
- [x] 对照会话事件类型核对字段是否存在，记录到具体文件与行。
- [x] 算不出的项写明由跑分器记录的具体字段。
- [x] 写明一次任务一条样本、重复各算一条、样本不足 20 只记分子分母的规则。
- [x] 本日没有调用模型，也没有把 snapshot 回放算进任何一项。

## 样本口径

一次任务一条样本。同一道题在真实模型层重复三次，每次各算一条样本，不把三次平均成一条。一次任务里的多次工具调用不摊进任务分母；选择只判第一个落在可接受集合或禁止集合里的调用。

三层样本不合进一个百分数：直接调用层的样本不参与真实模型五项，脚本场景层的样本也不参与，snapshot 回放不计入选择、拒绝、响应时间、成本或上下文。

真实模型层的完成次数与指标分母分开记。计划跑 60 次（试点 20 题 × 3 次），实际完成次数写成分数；时间盒不够而未跑的尝试不记为失败，也不进入选择准确率的分母，因为这次尝试没有产生选择。完成率的分母仍是计划次数 60。

族的真实模型样本不足 20 时只记分子与分母，不报百分数。试点四族各 15 次（5 题 × 3 次），全部低于 20；因此 P0 之后的第一轮只出四族的分子与分母，不把任一族写成百分比。这条限制同时适用于选择、拒绝、上下文与恢复。

## 会话字段核对

会话事件已经携带判定所需的主要字段，但没有任务级的主键。以下位置以当前 `master` 为准。

| 证据 | 会话字段 | 位置 | 核对结果 |
|---|---|---|---|
| 工具名与原始参数 | `tool/call.name`、`tool/call.arguments` | `packages/core/session/src/types.ts:369` | `arguments` 是模型产出的原始 JSON 字符串，未解析；选择与语法都从这里取 |
| 工具结果与失败身份 | `tool/result.message`、`tool/result.error.code` | `packages/core/session/src/types.ts:383`、`:394` | 失败没有 `error.code` 时该次调用不可解释；没有 `error` 字段的成功结果不算失败 |
| 调用与结果的配对 | `tool/result.sourceEventSeqs`，或 `tool/call.callId` | `packages/core/tools/src/batch.ts:247`、`:256` | 结果事件带产生它的 `tool/call` 序号；即使 `callId` 重复也不会配错 |
| 交给模型的工具 schema | `request/header.header.tools` | `packages/core/session/src/types.ts:399`、`:246`、`:252` | 只在 `initial`、`change`、`series` 时写入；后续步骤没有新快照时，跑分器必须沿用最近一份 |
| token 用量 | `assistant/message.usage` | `packages/core/session/src/types.ts:349`、`:355`；`packages/llm/llm/src/types.ts:189` | `inputTokens`、`outputTokens` 必填；`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens` 可选；没有 usage 时费用是缺口，不是 0 |
| 失败或取消的模型尝试 | `assistant/attempt` | `packages/core/session/src/types.ts:363` | 只有流，没有 usage；不能为它编造 token 费用 |
| 事件时间 | `SessionEvent.time` | `packages/core/session/src/types.ts:531` | 是事件写入时刻的 Unix 毫秒，不是时长字段；可以夹住一次调用，但不能区分模型等待与工具执行 |

`SessionEvent` 没有工具执行时长字段，也没有模型等待时长字段。`tool/call` 与 `tool/result` 的 `time` 差只能给出「从请求工具到结果写入」的墙钟，包含排队与调度，不能当作工具执行时间；计划要求的响应时间是跑分器墙钟，并且模型等待与工具执行分开记录。

## 五项指标的分母

### 1. 工具选择准确率

分子是「第一个落在该题可接受工具或禁止工具里的调用，其名字属于可接受集合」的真实模型任务数。分母是实际跑完的真实模型任务数；计划分母是 60。判定只读 `tool/call.name` 的出现顺序，可接受集合与禁止集合来自冻结后的题面。

没有工具调用的任务仍计入分母，分子为 0，并单独记 `no_call`；不能把「没有调用」排除在分母之外，否则会高估选择准确率。它的样本行在「实际工具」列留空，不填一个猜测的名字。

会话里没有题号，也没有「这道题的可接受集合」。跑分器必须在每次尝试开始时记录 `question_id`、`attempt_id`、`family`，并在结束时把这两个集合写进评测记录；只靠会话日志无法把一次调用归因到某道题。

### 2. 拒绝率与误拒

拒绝率的分子是「应拒绝题没有调用禁止工具，且没有声称完成禁止的交付」的尝试数；分母是应拒绝题的尝试数。试点四族各 1 道应拒绝题，计划分母是 12（4 题 × 3 次）。误拒的分子是「应调用题的第一个可归因调用进入可接受集合，且没有以拒绝结束」的尝试数；分母是应调用题的尝试数。试点四族各 3 道应调用题与 1 道近邻题，计划分母是 48（16 题 × 3 次）。

拒绝的判定要读轨迹与最终答复两面：轨迹里没有该题的禁止工具，最终答复没有声称完成该题禁止的交付。最终答复在 `assistant/message.message` 里，但「是否声称完成」需要外部判定或跑分器规则，不能只靠关键词。误拒的判定还要区分「拒绝」与「没选到工具但继续做」；后者不是拒绝，是选择错误。

`tool/result.error.code` 只说明工具失败，不说明模型拒绝。一次失败后换工具重试不算拒绝。跑分器需要记录 `verdict`（`refused` / `answered` / `no_call`）和 `external_verdict`，不能从工具错误码反推。

### 3. 响应时间

这一项不是比例，没有分子；分母有两份：成功任务数与全部任务数。计划输出 p50 与 p95，各出一份成功任务、一份全部任务；不与 `benchmarks/` 的库函数中位数合并。

会话事件没有时长字段。`tool/call.time` 与 `tool/result.time` 的差是工具路径的墙钟，`step/start.time` 到 `assistant/message.time` 的差混入模型等待与流式输出，无法拆开。计划要求的「模型等待与工具执行分开」只能由跑分器在进程内记录，不能从会话日志重算。跑分器至少要记录 `started_at`、`ended_at`、`model_wait_ms`、`tool_exec_ms`，并保留原始起止时间。

### 4. 成本效率

分子是成功任务的 token 费用合计，分母是成功任务数。失败任务的费用另计为浪费费用，不进入这个分子。token 数从 `assistant/message.usage` 取，单价由跑分器在当天写进 `metrics/`，不写死在计划里。

token 数可以直接从会话算出：`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（缓存字段存在时计），`reasoningTokens` 是输出侧的子集，不能重复相加。费用需要跑分器把每个用量按当天单价乘开；会话里没有单价，也没有费用字段。没有配对 `assistant/message.usage` 的尝试记为费用缺口，不记为 0；`assistant/attempt` 没有 usage，不能为它补一个估计值。

视频 provider 费用从视频账本读取，单独一列，不加入 token 费用。会话日志没有视频账本金额，跑分器要读账本并把金额写进评测记录。

### 5. 上下文利用率

分子是 `1 −（本任务 tool/call 未使用的工具 schema JSON 字节）/（该次 request/header 全部工具 schema JSON 字节）`，分母是闭环成功的真实模型任务数。这个数是代理值，不把系统提示正文算进去；`inputTokens` 单独记录为体积。

`request/header.header.tools` 提供每个 `ToolSchema` 的 `name`、`description`、`parameters`（`packages/llm/llm/src/types.ts:524`）。哪些工具算「使用」由 `tool/call.name` 去重后决定；同一工具调用多次只算一次使用。闭环成功的判定依赖第 3 项的分母，两者一起读。

会话里没有 schema 的线上字节数，只有解析后的对象。跑分器要定义固定序列化：按 `name`、`description`、`parameters` 的字段序做 `JSON.stringify`，再按 UTF-8 计字节。这个定义是代理，不是请求线上的原始字节；换序列化就会换读数，因此 P3 开工前要把序列化固定下来并写进当天记录。`request/header` 只在头部变化时写入，跑分器要沿用最近一份快照，不能把「这一步没有 header 事件」当成没有工具。

## 算不出的项与跑分器打点

| 指标 | 会话能直接算的部分 | 必须由跑分器记录的部分 |
|---|---|---|
| 工具选择准确率 | 调用顺序、工具名、结果配对 | `question_id`、`attempt_id`、可接受/禁止集合、`no_call` 判定 |
| 拒绝率与误拒 | 工具名、是否有禁止工具、最终答复文本 | `verdict`、`external_verdict`、是否声称完成禁止交付 |
| 响应时间 | 事件时间夹出的粗区间 | 任务墙钟、模型等待、工具执行、p50/p95 的样本集合 |
| 成本效率 | `assistant/message.usage` 的 token 数 | 当天单价、成功/失败任务归属、视频 provider 账本金额 |
| 上下文利用率 | 工具名去重、`header.tools` 的对象 | 固定 schema 序列化、UTF-8 字节、最近一份 header 的沿用、闭环成功归属 |

跑分器的记录至少要有这些字段：`attempt_id`、`question_id`、`family`、`layer`、`model`、`prompt_hash`、`started_at`、`ended_at`、`model_wait_ms`、`tool_exec_ms`、`verdict`、`external_verdict`、`completed`、`unit_price_input`、`unit_price_output`、`unit_price_cache_read`、`unit_price_cache_write`、`schema_bytes_total`、`schema_bytes_unused`、`provider_cost`。这些字段不进会话事件；它们是评测记录，不改变产品行为。

## 本日结论

五项里，工具选择准确率的分母可以从 `tool/call.name` 与会话配对算出，前提是跑分器补题号与集合；拒绝率与误拒的轨迹面可算，答复面需要跑分器判定；成本效率的 token 数可算，费用需要当天单价；响应时间与上下文利用率不能只靠会话日志，需要跑分器记录墙钟与固定序列化的 schema 字节。

没有需要改业务代码的缺陷。需要确认的是两个口径：上下文利用率的 schema 序列化方式，以及拒绝判定由谁写外部判定。两项都定在 P1 直接调用基线之后、P3 真实模型之前由跑分器记录固定；本日不替它们选默认值。

## 明日第一件事

Day 02 第一件事：按同一张表核对直接调用层与脚本场景层的五项——参数填充有效性、调用闭环成功率、可解释性、错误恢复能力、资源利用率，并把今天没有覆盖的「畸形参数 fail-closed」与「拒绝/鲁棒性」的另一半写进去。
