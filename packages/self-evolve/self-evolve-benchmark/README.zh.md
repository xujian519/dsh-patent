---
description: "**`BenchmarkEvolveEngine`** 是 `ctx.selfEvolveBenchmark` 的提供方。它为 self-evolve 能力补充一个量化目标维度:benchmark 是一组有界用例,每个用例按私有评分标准(rubric)打分,提供方在严格的 improve-or-rollback 策略下优化 agent 状态,并以整版快照版本化为支撑。这与 `ctx.selfEvolve` 从会话流挖掘失败模式形成互补,给优化循环一个可以追逐的客观分数。"
kind: "package-reference"
---

# @deepseek-ai/dsh-self-evolve-benchmark

[English](README.md) | 中文

## 概述

**`BenchmarkEvolveEngine`** 是 `ctx.selfEvolveBenchmark` 的提供方。它为 self-evolve 能力补充一个量化目标维度:benchmark 是一组有界用例,每个用例按私有评分标准(rubric)打分,提供方在严格的 improve-or-rollback 策略下优化 agent 状态,并以整版快照版本化为支撑。这与 `ctx.selfEvolve` 从会话流挖掘失败模式形成互补,给优化循环一个可以追逐的客观分数。


## 目录

- [Role](#role)
- [Configuration](#configuration)
- [Public API](#public-api)
- [On-disk layout](#on-disk-layout)
- [Optimization loop (C1 + C3)](#optimization-loop-c1--c3)
- [Statement/rubric 分离(C2)](#statementrubric-separation-c2)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Role

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-self-evolve` | Service Definition:抽象 `SelfEvolveEngine` + 持久事件 |
| `@deepseek-ai/dsh-self-evolve-basic` | Service Provider:基于 failure-pattern projection 的空闲压力演化 |
| `@deepseek-ai/dsh-self-evolve-benchmark`(本包) | Service Provider:benchmark 驱动的目标演化 + 快照版本化 |

## Configuration

`BenchmarkEvolveConfig` 控制 benchmark 数据存放位置以及公共方法的默认值:

| 字段 | 默认值 | 语义 |
|---|---|---|
| `baseDir` | `~/.dsh/self-evolve-benchmark` | benchmark 存储与快照的数据根目录(`$DSH_HOME` 覆盖 `~/.dsh`)。 |
| `agentStateDir` | 必填 | agent 状态目录,每轮候选前打快照、被拒绝时恢复。构造时拒绝相对路径、不是目录的路径,以及与 `baseDir`、`cwd`、home 目录或文件系统根相同的路径;非空目录必须带有 `.self-evolve-benchmark` 标记。 |
| `runsPerCase` | `1` | 方法未指定时每个用例的 run 次数。 |
| `maxRoundsPerLoop` | `1` | 每次 optimize loop 的默认最大候选轮数。 |
| `targetScore` | 无 | optimize loop 的默认分数目标;缺省禁用提前接受。 |
| `minImprovement` | `0` | optimize 轮次被接受所需的、相对参考的最小聚合提分。`0` 表示任何严格提分都接受;构造时拒绝负数与非有限值。 |
| `candidatesPerRound` | `1` | 每轮提出的候选数。每个候选都从该轮起始状态出发并单独评估,只保留分数最高的合格候选。构造时拒绝不是大于等于 1 的整数的值。 |

## Public API

所有工作都经过一个注入 seams 的 `BenchmarkEngineCore`;真实默认 seams 运行在 `fork` subagent provider 之上。

| 方法 | 契约 |
|---|---|
| `runBenchmark(benchmarkId, options)` | 对当前 agent 状态评估每个用例 × `runsPerCase`,并持久化聚合的 `ScoreboardEntry`。 |
| `establishBaseline(benchmarkId, options)` | 单 run 的 benchmark entry,是 optimize loop 必须严格超越的参考。 |
| `optimizeLoop(benchmarkId, options)` | 在 improve-or-rollback 下优化,仅当提分达到 `minImprovement`(默认 `0`,即任何严格提分)时才接受该轮;没有参考 entry(显式或 scoreboard 最新)时 fail loud。 |
| `readScoreboard(benchmarkId)` | 返回某 benchmark 的全部持久化 entry,旧到新。 |

该服务只供程序调用,因此包还以子路径导出一个 function plugin:`@deepseek-ai/dsh-self-evolve-benchmark/baseline-driver`。把它挂到 provider 旁边,即可从 profile 跑一轮基线而无需交互会话:它等 loader 就绪,为 `fork` seams 创建一个空闲的父 Agent,用 profile 当前的模型选择调用 `establishBaseline`,把 scoreboard 条目以 JSON 打到 stdout,并请求进程退出——运行失败时以退出码 1 收尾,并在 stderr 打一行 `dsh:` 诊断。其配置为 `benchmarkId`(必填)与 `runsPerCase`(默认 1)。[examples/patent-oas](examples/patent-oas/README.zh.md) 提供了在 shipped `self-evolve` profile 上启动它的 overlay。

## On-disk layout

```
<baseDir>/
├── benchmarks/<id>/
│   ├── benchmark_config.yaml   # { title }
│   ├── <caseId>/statement      # public task text — the only input a target agent sees
│   ├── <caseId>/rubric         # private scoring standard — a physically separate file
│   └── scoreboard.yaml         # versioned entry history
└── snapshots/v<version>.tar.gz # whole agent-state snapshot, excluding .vault.toml
```

## Optimization loop (C1 + C3)

`optimizeLoop` 的每一轮先铸造该轮的起始快照,然后只基于公共 statement 面对参考提出 `candidatesPerRound` 个候选:每个候选都从该起始状态出发,依次被应用、铸造为自己的快照版本并评估完整矩阵,因此 scoreboard 条目的 `version` 始终指向保存着它被打分状态的归档(版本只增不减、永不回收)。候选分数相对参考的提分达到 `minImprovement`(默认 `0`,即任何严格提分)即为合格,该轮保留分数最高的合格候选,其余条目在写入时标记 `rejected: true`。被保留的候选成为新的参考;其余候选、以及没有任何合格候选的一轮,都会被回滚。条目只在该轮提交状态之后才追加,因此没有任何持久条目会指向一个磁盘上并不存在的状态;在该提交前抛出异常的一轮不追加任何条目,而追加本身失败时,已提交的状态会领先于账本,直到用 `runBenchmark` 重新测量为止。未显式提供 `reference` 时,循环以最后一条未标记为 `rejected` 的条目为参考,全部条目都被拒时 fail loud。交给优化者的 statement 带有各自的 `[caseId]` 标签,因此回灌的每一条逐例得分都能对应到具体任务。默认 apply seam fork 一个返回待写文件内容的 applier——子代理继承父会话的 `workspace-write` 沙箱,该沙箱拒绝写 home 目录——由 seam 在 harness 进程内、拒绝绝对路径/`..`/home 相对路径之后写盘。seam 在写盘前后对 agent 状态目录取指纹:内容与现有文件完全一致时指纹不变,该轮直接失败,循环不会去评估一个未变化的状态。被拒绝的候选回滚到该轮起始快照,而一轮在该快照与该轮定夺之间抛出异常时,也会在错误向上传播前恢复它。达到 `targetScore` 时,该轮不再提出剩余候选,并在已有被保留候选的前提下结束循环。回滚会恢复快照内容并删除被拒候选新增的文件,同时保留 `.vault.toml` 与 `.self-evolve-benchmark` 标记;解包前会校验归档条目的绝对路径、`..` 与路径穿越。铸造快照与追加 scoreboard 都持有 benchmark 级文件锁,因此并发写入方看到的是完整的旧文件或新文件,而不是部分内容。从磁盘加载的 case id 与 benchmark id 必须是安全路径段(`^[A-Za-z0-9][A-Za-z0-9._-]*$`),evaluator 返回的 score 必须是 0–100 内的有限数——超出范围以类型化错误拒绝,而不做 clamp。

<a id="statementrubric-separation-c2"></a>
## Statement/rubric 分离(C2)

用例的 `statement` 是 target 或优化 agent 能看到的唯一 benchmark 内容;`rubric` 是私有的,存为物理上不同的文件。optimizer prompt 声明评分标准不存在,并指示子代理如果看到评分标准就停止并上报污染;`publicBenchmarkView`/`assertNoPrivateLeak` 从面向 optimizer 的面上机械地剔除并守护私有词汇(`rubric`、`rubrics`、`gold`、`goldAnswer`、`expectedAnswer`)。evaluator 是唯一允许接收 rubric 的角色。

## Model Experience

### 默认 seam prompts

#### What the model sees

本提供方不注册稳定的 prompt section 或 tool schema;每个模型可见的贡献都来自其默认 seams fork 出的子请求。每个用例 run 先 fork 一个 executor 子代理,告知它是任务执行者,交给它 `statement` 与 agent 状态目录中的作业规范,并指示它直接产出交付物文本。随后引擎 fork 一个 evaluator 子代理,告知它是 benchmark evaluator,交给它 `statement`、交付物、私有 `rubric`(在这里是合法的,也仅在这里),以及只输出一个带数字 `score` 的 JSON 对象的指令。每轮优化为每个候选各 fork 一个 optimizer,交给它参考分数、合并后的公共 statements、参考的逐例均分及其截断到 200 字符的 evaluator 评语、以及本 loop 已评测过的每个候选(其分数、评测时的参考分数、逐例均分)——明确告知上下文不含 rubric——并为每个候选各 fork 一个 applier,拿到候选与 agent 状态目录、被告知只能读取该目录、并被要求返回待写文件。

#### Token effect

`runBenchmark` 与 `establishBaseline` 每个用例 run 花费一次 executor 与一次 evaluator 请求。每轮优化花费 `candidatesPerRound` 次 optimizer 请求与 `candidatesPerRound` 次 applier 请求,外加每个候选的每个用例 run 一次 executor 与一次 evaluator 请求;同时铸造 `candidatesPerRound` + 1 份文件系统快照,最多恢复 `candidatesPerRound` 次。optimizer prompt 会随用例数与本 loop 已评测的候选数增长。evaluator 的答案里取不出可恢复的 JSON 对象时,会多花一次 evaluator 请求。

#### KV Cache effect

这些子请求的 prompt 是请求局部的:内容随用例、轮次和参考变化,永远不会成为主请求的稳定前缀。主请求前缀不受本提供方影响。

## Known Limitations and Deferred Work

- **默认 seams 需要活运行时**——执行、评估、提议与应用通过 `ctx.subagents` fork 子代理,需要 `fork` provider 以及通过 `sessionId` 解析出的 live parent agent;没有它们时循环 fail loud 而不是降级。没有 subagent 运行时的调用方必须注入自己的 seams。
- **只有无法解析的 evaluator 答案会重新 fork**——evaluator 的回复取不出可恢复的 JSON 对象时重试一次,仍取不到才使该轮失败;其他任何子代理失败(在 `completed` 之前结束、score 缺失或越界、applier 什么都没改)都立即失败。executor 的交付物是自由文本(无 JSON 包装),只有 evaluator 必须输出 JSON。
- **单 run 分数带有数分级噪声** — 对同一未改动 agent 状态的同一用例重复评估三次,得到 94、100、98,因此逐用例几分的差异可能只是噪声。判定候选质量应使用至少 3 的 `runsPerCase` 并按均值比较,用同样的 `runsPerCase` 评估参考,并把 `minImprovement` 设到观测噪声之上;默认的 `runsPerCase: 1` 与 `minImprovement: 0` 会因任何严格聚合提分接受一轮,单凭它们无法区分真实增益与噪声。
- **多候选会挑到噪声最大的最大值**——保留 `candidatesPerRound` 个聚合分中的最高者,等于对 N 个带噪测量取最大值;`runsPerCase: 1` 时这会把被保留的分数系统性抬高。提高 `candidatesPerRound` 之前先提高 `runsPerCase` 或 `minImprovement`。
- **evaluator 评语未经过滤就到达 optimizer**——评语会被原样(截断后)复述给下一个候选,而私有词汇守卫只匹配键名,因此复述了 rubric 内容的评语能够通过。评语应针对交付物,而不是评分标准。
- **全部条目被拒的 scoreboard 需要显式参考**——当所有持久化条目都标记为 `rejected` 时,默认参考解析会 fail loud,而不是退回到某个被丢弃的分数;此时显式传入 `reference`。
- **`rejected` 标记出现之前写入的条目会被当作保留条目**——旧 scoreboard 的行不带该标记,而单候选轮即使被回滚也仍会追加自己的条目,因此这类行可能指向一个已不在磁盘上的状态。把既有 scoreboard 当作参考之前,先用 `runBenchmark` 重新测量。
- **快照版本永不回收**——单调的 `max + 1` 铸造是刻意的(被拒绝轮的归档留在磁盘上作为证据),所以长期运行的循环会积累归档,直到调用方自行清理。
- **无 UI 或 CLI 面**——这是一个编程接口服务;`dsh` 里还没有任何东西暴露它。
- **无 keyed 端到端验证**——默认 seams 由 mock 掉 subagent 运行时的单元测试覆盖;真实的 `dsh --profile` 循环运行需要 keyed 环境。
- **live parent agent 必须能通过 session id 解析**——引擎通过 seams 传递的是 `sessionId`,不是直接的 agent 引用;持有 `Agent` 的调用方必须先把它映射为 session。

### 开发备注

无。
