# Agent Note: A problem-space DAG and a thresholded regression gate for the patent-oas gold benchmark

Status: implemented

[English](2026-09-26-patent-oas-problem-space-gate.md) | 中文

## Problem

[2026-08-26 的笔记](../feature/2026-08-26-self-evolve-benchmark-output-scoring-patent-preset.zh.md)交付了 `patent-oas` 这个可运行示例 benchmark:四个金标 case,每个把公开的 `statement` 与私密的 `rubric` 配对,由只看到私密那一半的评估者按 case 打 0–100 分。要让它成为一份标准而不是一个演示,还缺两件事。

其一,没有任何东西把金标钉住。rubric 可以被放宽、case 可以被删掉、statement 可以向自己的答案漂移,而仓库里每一道门禁仍然全绿——此后这份 benchmark 的分数就在指向别的东西。其二,对专利实务而言 case 均值是很差的回归信号:掉几分只说明交付物变差了,说不清是检索、区别特征认定、实际解决的技术问题、技术启示论证,还是交付物形式出了问题。rubric 文本里本来就有这层结构——每个维度既点名一个切面,也写出自己的分值——但此前没有任何东西去读它。

## Decision

**这份 benchmark 的问题空间是一张有向无环图,与金标一起入库。** `examples/patent-oas/problem-space.yaml` 声明 17 个节点,每个对应交付物会被判定的一个切面;`dependsOn` 边承载先决结构:检索先于区别特征认定,区别特征先于实际解决的技术问题,技术问题先于技术启示分析,逐特征比对先于等同分析,依此类推。这些边决定了节点判定何时可信:先决节点已经失败的节点,它的分数不应被单独解读。节点只在有 rubric 维度观测它时才存在;不被打分的前置概念(最接近的现有技术选取)只作为边,不立成没有观测面的节点。

**每个 rubric 维度按自己的分值拆到它观测的节点上。** 这层映射是标准两半之间唯一的连接,而且可以机械校验:逐维度看,映射权重必须等于 rubric 自己写明的满分;逐 case 看,映射权重合计必须是 100;每个权重还必须为正——负权重能从别处抵消出一个看似正确的合计,而它喂出来的节点分是错的,零权重则声称了一个不计权重的观测面。正是这一点把「有人改了 rubric」变成门禁失败而不是无声改写含义——无论改的是 rubric 还是映射,只要对不上就会被抓到。

**门槛是策略,与测量分离。** `examples/patent-oas/gate.yaml` 持有三层门槛。`node` 是逐切面的下限与允许回退量;`case` 与 `aggregate` 是逐 case 与 case 均值的两层,它们的 `maxDrop` 刻意更紧(3 对 5),因为 case 分本身已是五个维度观测的均值、聚合分又是四个 case 的均值,这些估计的抽样噪声更小,容忍回退的理由也更少。没有 case 层时,单个 case 的整体下滑会被共享节点背后的跨 case 均值摊薄;spec 用一次「case 判定回退、而所有节点判定通过」的运行把这个形状钉住。两条逐节点覆盖抬高脊柱节点(`distinguishing-features`、`technical-problem`)的下限,因为在那里失败会向下游传播。

**完整性、门槛与判定共用一个无 key 模块。** `scripts/patent-oas-gate-core.ts` 解析 rubric 维度、计算金标摘要、双向校验 DAG 与金标、校验门槛与 run 记录、推导 case 分与节点分、判定一次运行。`scripts/verify-patent-oas-gold.ts` 是它之上的 CLI,挂在 `ciSharedStaticGates` 聚合里,与 `verify-self-evolve-eval` 并列。run 记录只保存逐维度的原始观测——`{ benchmarkId, recordedAt, provider?, modelId?, runsPerCase, cases: [{ caseId, dimensions: [{ index, label, points, score, scores? }], rounds?: [{ round, statementDigest?, dimensions: [{ index, score, scores? }], deliverableDigests }] }] }`——因此 case 分与节点分只有一处计算,不会出现会漂移的第二份副本。

**金标由内容摘要钉住。** `gate.yaml` 记录覆盖每个 case 的 `statement` 与 `rubric`、以及每个后续轮次审查意见的 `sha256`。修改金标是允许的,但在用 `--write` 重录摘要之前门禁一直红,这让意图显式落在 diff 里而不是悄悄生效。

**实测采集是一个独立、可注入的运行器。** `scripts/run-patent-oas.ts`(`pnpm run gate:patent-oas`)每次调用起一个 `dsh --profile` 进程,与 `self-evolve-eval` 的 campaign 运行器同形;编排放在 `scripts/patent-oas-run-core.ts` 的 `RunAgents` 接缝之后,CLI 提供真实子进程作为该接缝的实现。每次运行把 agent state 复制成该次运行私有的目录,执行者在副本里工作,金标的 `patent-state/` 始终只读;每轮一个执行者把 `deliverable.md` 写在这份副本里,每轮每个 rubric 维度一个评估者在自己的调用目录里写出 `score.json`,因此评估者只看到一个维度、永远看不到整份 rubric。后续轮次复制上一轮的工作目录,把上一轮交付物保留为 `previous-deliverable.md`,并删除旧的 `deliverable.md` 与 `agent.log`。交付物在被复制进这么多条提示词之前先做字节上限检查;`--dry-run` 只打印计划与逐 case 维度数、不花掉任何一次调用;`--timeout-ms` 与 `--budget-ms` 分别限单次调用与整次采集。运行器不是门禁叶:它需要 key、没有 key 时跳过,而拒绝「与金标不符的记录」的始终是门禁。

**基线缺失时门禁失败,而不是读绿。** `--accept <record.json>` 先校验一次 run 记录,拒绝把已经不满足自己门槛的记录提升为基线,否则把它复制到 `packages/self-evolve/evaluation/patent-oas-baseline.json`。该文件不存在期间,门禁打印记录基线的命令并以 1 退出:退出码必须把「没比对过」与「比对通过」分开,因此它没有沿用 `scripts/verify-self-evolve-eval.ts` 面对缺失评估记录时的跳过姿态。`--run <record.json>` 按同一套门槛判定任意 run 记录,并把每处失败归因到对应的问题空间节点。

## Alternatives considered

**只判聚合分。** 不采纳:那正是 benchmark 本来就在产生的信号,它说不清专利实务的哪一部分动了。需求是按节点归因,不是再要一个数字。

**让引擎的评估者直接返回逐维度分数。** 不采纳:评估者 prompt 是 model-visible 的,其输出契约是引擎的公开接缝(`EvaluateCaseResult.score`,持久化在 `ScoreboardEntry` 里)。为一道仓库门禁去拆它,等于同时改动 pre-stable 公开 API、评估者可见指令与持久化计分板格式。把明细存进记录、由本门禁推导分数,引擎可以完全不动。

**把门禁做成新包。** 不采纳:按仓库「抽象要有当前属主与需求」的规则,消费者只有这一个门禁;仓库其余校验门禁也都在 `scripts/`。

**保留扁平 case 列表,让 rubric 自己承载结构。** 不采纳:rubric 只给出维度权重、不含关系,既分不清「技术问题表述错」与「结论错但权重低」,也没有任何东西能把标准的两半钉在一起。

**加一个仅供测试用的环境变量覆盖基线路径,好让 spec 从 CLI 走通回归分支。** 不采纳:为了让测试够得着而存在的钩子不是可配置性;回归分支已经在做决定的那一层(`evaluateRun`)被钉住。

**从运行器的 stdout 抓交付物。** 不采纳:一次性 `dsh --profile` 运行不把助手正文打到 stdout,可靠的观测面只有 agent 写出的文件或持久化会话日志。用产物文件让运行器不依赖持久化格式,也不依赖帧解压。

**把作业规范内联进执行者提示词。** 不采纳:引擎交给执行者的是一份 agent state *目录*,并要求它去读其中的指导文档。内联正文抹掉了执行者被要求去读的那个文件,测出来的行为就与引擎不同,而门禁看不见这种差异。运行器改为每次运行复制一份 agent state。

**把 `self-evolve-eval` 的 campaign 运行器扩成两者共用。** 不采纳:那套脚手架是围绕数据集清单与逐任务「通过/不通过」配对判定建的,而专利 case 按 rubric 打分并需要逐维度观测;强行共用会把清单模型与判定模型都掰成彼此都不需要的形状。

## Consequences

- `pnpm run verify-patent-oas-gold` 现在会因下列情形失败:rubric 维度没有映射、映射权重不等于该维度满分、映射到未声明的节点或没有观测面的节点、先决关系成环、rubric 满分合计不为 100、金标摘要过期或未记录、门槛取值越界、逐节点覆盖指向不存在的节点、基线无法满足自己的门槛、run 记录的维度与金标不符,以及——基线记录之后——任何节点、case 或聚合超过各自门槛。
- 与基线的回归比对跑在一次已记录的 keyed 实测上:2026-11-07、`headless` profile 并传入 `--provider deepseek-official --model deepseek-flash`、7 个 case 各三次运行、聚合 96.43,记录落在 `packages/self-evolve/evaluation/patent-oas-baseline.json`。
- 固定的 `maxDrop` 现在是下限而不是全部规则:[2026-11-07 的记录](2026-11-07-patent-oas-noise-aware-thresholds.zh.md)在实测噪声更大时把允许回退量抬到噪声上,因为同一批 case 的重复测量摆动超过了这些门槛。
- 验证:`scripts/patent-oas-gate.spec.ts` 跑 63 条用例、`scripts/patent-oas-run.spec.ts` 跑 52 条,合起来覆盖每条拒绝路径各一条负例、CLI 退出码、经桩接缝驱动的整条采集链路,以及真实子进程接缝的超时与非零退出路径;门禁挂在 `ciSharedStaticGates`,因此进入 `ci-primary`、`ci-static` 与 `hygiene`,而本 fork 承载静态门禁的那条必过车道 `node-checks` 直接运行 `pnpm run verify-patent-oas-gold`——那些聚合没有任何工作流调用。
- case 层门槛来自实测到的摊薄效应,不是为了对称:spec 里那一幕在 case 层失败、在每个节点上通过,正是只有节点层的门禁会漏掉的形状。
