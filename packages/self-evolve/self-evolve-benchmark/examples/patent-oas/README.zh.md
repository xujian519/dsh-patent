# patent-oas 示例 Benchmark

[English](README.md) | 中文

面向专利实务的示例 benchmark,供 `@deepseek-ai/dsh-self-evolve-benchmark` 使用。基准 ID 为 `patent-oas`。每个 case 把公开的 `statement`(给执行 agent 的任务)与私密的 `rubric`(评分标准)物理分离,满足引擎的 statement/rubric 隔离约束(C2):执行、优化、应用角色只接触 statement;只有 evaluator 拿到 rubric。

## Cases

| case | 任务 | 评分维度 |
|---|---|---|
| `oa-answer` | 审查意见答复:检索→区别特征→实际解决的技术问题→技术启示→结论→修改权利要求书(六步) | 区别特征认定、技术问题、技术启示、结论与法条、检索与格式、修改接地与幅度 |
| `claim-drafting` | 交底书→权利要求书:独立权利要求+从属权利要求+引用关系 | 必要技术特征、保护范围、从权布局、引用层次、形式支持 |
| `disclosure-drafting` | 交底书→权利要求书+说明书(五部分与摘要),交底书刻意留有未展开内容,供 A26.3/A26.4 判定 | 必要技术特征、保护范围、从权布局、引用层次、形式支持、充分公开、概括得到支持 |
| `infringement-comparison` | 侵权比对:全面覆盖原则+等同原则,逐特征比对+风险定级 | 比对完整性、等同运用、结论明确性、风险定级、法律依据 |
| `novelty-creative` | 新颖性/创造性分析:A22.2 单独对比 + A22.3 三步法 | 单独对比、区别特征、技术问题、结合启示、结论与法条 |

每个 case 目录必须含 `statement` 与 `rubric`;多轮 case 额外有一个 `rounds/02/statement` 文件:

```
cases/<case-id>/
├── statement             # 公开的第 1 轮任务文本 —— 目标 agent 唯一可见的输入
├── rubric                # 私密评分标准 —— 与 statement 物理隔离
└── rounds/02/statement   # 可选:第 2 轮脚本化审查意见
```

`disclosure-drafting` 是唯一给 A26.3 与 A26.4 打分(对应节点 `enablement-implementable` 与 `claim-breadth-supported`)的 case。它的交底书刻意留了一条不可实施的路线(只有"深度学习模型"的说法,没有结构、训练数据与标注口径),同时为权利要求的概括给出两条具体路线;把不可实施的路线写进独权,就会丢掉充分公开维度的分。随仓样本是合成的:计划中的 15 件语料(10 件去法律化授权文本 + 5 件真实交底与代理师改稿)不在仓库里。真实案卷材料不能提交,伪造"真实"样本又会歪曲读数,因此这里记录缺口而不是补假样本。合成交底会高估"写专利腔",低估"从残缺交底挖保护范围";这个 case 的分数不能替代那批语料的读数。

多轮 case 固定为两轮:执行者先作答,再收到作为新公开输入的脚本化审查意见,并修订上一轮交付物——运行器以 `previous-deliverable.md` 把它交给执行者。两轮用同一份 rubric 评分,门禁只判最后一轮。把审查意见写进 case 使第二回合可复现,而不是引入一个会变动的第二审查模型。

`patent-state/guidance.md` 是初始 agent state 种子:一份 model-visible 的专利作业规范(checklist),executor 按它完成交付物,optimize loop 以它为编辑对象。它只含通用作业方法,不含任何 case 的答案,不破坏 rubric 隔离。

## 问题空间 DAG 与回归门禁

`problem-space.yaml` 把这份金标覆盖的专利实务问题空间建成一张有向无环图:节点是交付物会被判定的切面,`dependsOn` 记录先决关系(检索先于区别特征认定,区别特征先于实际解决的技术问题,逐特征比对先于等同分析),每个 rubric 维度按自己的满分拆到它观测的节点上。`gate.yaml` 钉住金标内容摘要与分数门槛。

`pnpm run verify-patent-oas-gold`(CI,无需 key)校验:金标与 DAG 互相钉住(维度全部有映射、映射权重等于 rubric 满分、节点都有观测面、先决边无环)、已记录的金标摘要相符、已记录的基线能满足自己的门槛。`--run <record.json>` 按门槛判定一次实测记录,并把失败归因到问题空间节点;记录带逐次观测时,输出同时给出逐 case 与逐节点的极差和样本标准差;`--accept <record.json>` 把校验通过的实测记录提升为基线,并要求每个 case 都带 `retrieval`,防止旧格式记录把基线悄悄退回未标注状态;金标被有意修改后用 `--write` 重录摘要。

run 记录是「测量」与「门槛」之间的契约:它只保存逐维度的原始观测分,case 分与节点分由 DAG 现算,因此不存在第二份会漂移的副本。字段为 `{ benchmarkId, recordedAt, execution?, workflowId?, runsPerCase, provider?, modelId?, cost?, tokens?: { input, output }, cases: [{ caseId, retrieval, dimensions: [{ index, label, points, score, scores? }], rounds?: [{ round, statementDigest?, dimensions: [{ index, score, scores? }], deliverableDigests, claimVersions?, concision? }], concision? }] }`。`retrieval` 是该 case 的检索设置:`oracle` 把对比文件放进 statement(`oa-answer`、`novelty-creative`),`none` 表示该 case 不依赖现有技术检索(`claim-drafting`、`disclosure-drafting`、`infringement-comparison`),`simulation` 留给受控语料运行。门禁拒绝与基线逐 case 设置不同的比对:检索质量分与 oracle 答复分不能共用一套阈值;没有该字段的旧记录只与同样没有该字段的基线比较。采集器遇到与基线不同的设置时仍写出记录,但跳过判定并以非 0 退出;仓库尚未收录 simulation 语料,因此 `simulation` 运行没有可比的基线。`execution` 是被测面:`prompt` 是 profile 的提示词调用,`workflow` 跑 `workflowId` 点名的 manifest。被测面按整次采集记录,因为一次采集只起一类进程;工作流设置落地之前写下的记录没有该字段,读作 `prompt`——那时采集器只有这一条路径。`workflow` 记录必须带 `workflowId`,且它观测的每个 case 都要在 `problem-space.yaml` 里声明同一 manifest。`runsPerCase > 1` 时,`scores` 保留每次运行的原始分数,读者可据此复算方差与区间,而不必只信一个均值;`tokens` 与 `cost` 累计整次采集的每次调用(`tokens.input` 是计费输入,含缓存命中与缓存写入):每次调用都报告成本时取 provider 报告值,否则在 token 合计完整时按调用方给出的每百万 token 单价换算;只有部分调用报告用量时省略合计,不写部分值。单一输入单价统一适用于含缓存在内的计费输入;需要区分缓存价格时由接缝直接报告成本。多轮 case 的 `dimensions` 是终局维度,`rounds` 则保留每一轮的逐维度观测、开启该轮的脚本化审查意见摘要(`statementDigest`;第 1 轮没有)、该轮每次运行的交付物摘要,以及——工作流设置下——每次运行的 `claimVersions`:该轮交付物在 `_matter-log.md` 取代链上的深度,由日志复算而不是执行者自报。链每轮必须前进一格;某轮的留档没有取代任何在档产物,读出的就是两轮同一版权项。门禁仍只判终局,并打印逐轮总分,因此修订是进步还是回退一目了然,而判定规则不变。`concision` 记录每份交付物有多长——`{ proseChars, budget?, overBudget?, paragraphs, sections, emptySections, repeatedSentences }`,每次运行一条——而且**只记录、不计分**:没有任何维度分、节点分、case 分或聚合分读它,写得长在这一轴上仍然不付出代价。多轮 case 挂在逐轮观测上,单轮 case 挂在 case 上,与其他逐次观测同处。`proseChars` 与 `slop-gate`、`tighten` 数同一批可见字符,但先剔除表格行:答复正文的篇幅预算不含表格与权利要求全文,把表格算进去会把每一份合规答复都判成超预算;`budget` 是该 case 自己声明的预算(`oa-answer` 取 manifest 的 4000);门禁只核对 `overBudget` 是否等于 `max(0, proseChars - budget)`——手写的数不照单全收。`gate.yaml` 在 `baselines` 下按被测面各声明一条基线,以 `execution` 与 `workflowId` 为键;`--accept` 与 `--run` 把记录路由到它自己那条基线,没有声明该被测面时拒绝落基线,工作流分数因此不会用提示词门槛来判。提示词基线落在 `packages/self-evolve/evaluation/patent-oas-baseline.json`;已声明的基线文件不存在时门禁以非 0 退出并打印记录基线的命令——「没比对过」与「比对通过」不能共用一个退出码;本 fork 的必过 CI 车道会运行该门禁,退出码因此能拦住 PR。

`pnpm run gate:patent-oas` 负责采集。`--dry-run` 只打印计划(case、轮次、运行次数、agent 调用总数,工作流设置下还有每轮阶段数与阶段执行总数)与整次采集的墙钟预算、单次调用上限,不做任何模型调用;真实运行需要 `DEEPSEEK_API_KEY`(或声明该键的 `.env`),没有则以 0 退出并跳过。它每次调用起一个 `dsh --profile` 进程——每个 case 每轮一个执行者,在 agent state 的私有副本里工作并把交付物写进 `deliverable.md`;每个 rubric 维度每轮一个评估者,把 `{"score": n}` 形状的 JSON 对象写进 `score.json`——随后写出 run 记录,把所有产物与 agent 日志留在 `.artifacts/patent-oas/<stamp>/`,并按门槛判定本次运行。多轮 case 的第 2 轮在 `run-N/round-2/` 下执行:运行器复制第 1 轮的 agent state,把该轮交付物保留为 `previous-deliverable.md`,并删除旧的 `deliverable.md` 与 `agent.log`,以促使执行者写出新交付物、日志各轮分开。`headless` profile 的每次调用还带 `--json`,采集器因此能读取 `step_end` 事件里的 usage 并累计整次采集的 token。`--case <id>` 与 `--runs <n>` 用来缩小范围与重复运行;`--timeout-ms` 限单次调用、`--budget-ms` 限整次采集;`--input-usd-per-mtok` 与 `--output-usd-per-mtok` 在 provider 只报告 usage、不报告成本时提供 token 单价;仓库不维护单价表,因为单价随合同变化,写死的数字会悄悄过期。基线由门禁提升,而不是由采集器。

`--execution workflow` 换的是被测面,不是提示词:运行器给每次 `dsh` 调用加上 `patent-workflow.patch.yml`,执行者每轮经产品自己的接缝作答——一次 `patent_workflow_run` 跑 `problem-space.yaml` 为该 case 声明的 manifest,然后一次 `matter_log_append` 留档。阶段顺序、上游产出注入与 `requireAllSteps` 判定都留在工作流引擎里,评测器不自己点名阶段。交付物由哪几个阶段组成,取自 `problem-space.yaml` 的逐 case 声明(`workflowDeliverable`),不按 manifest 猜:同一份 manifest 可以交付答复书,也可以交付权利要求书加说明书——`oa-answer` 取 `draft`,`disclosure-drafting` 按顺序取 `draft_claims` 与 `draft_specification`。执行者把这些阶段的正文原样转存到 `outputs/<artifact>-r<N>.md`,该文件就是逐维度打分的交付物。审批门按阶段 id 显式放行(`approveStageIds`),因为采集无人值守,而停在人工确认的运行不算完成;评测器不提供跳过阶段——它会读回运行记录,工作流有降级或中断时整次采集失败,而不是带着残缺产物继续打分。每轮交付物另存新路径让取代链前进,case id 按运行固定(`patent-oas-<case>-run<N>`),权项版本因此从日志复算,而不是听执行者自报。`patent_workflow_run` 的 `claims` 与 `input` 分开传,`claims` 只放本轮待答复的权利要求原文:要素级阶段缺 `claims` 时按 `input` 全文切分权项段,而任务文本里审查员论点与步骤列表都是行首编号,会被当成权项段,逐字子串校验因此全量失败。

每个被测面只判它自己产得出证据的切面。一条 `workflow` 记录必须覆盖的 case,是 `problem-space.yaml` 为该 manifest 声明过工作流的那些——其余 case 没有该工作流可跑,按金标全集要求会让这一面永远落不了基线。`gate.yaml` 的 `surfaces` 还能把该面不评的节点请出判定:被豁免的节点同时退出节点、case 与聚合三层加权,判定输出用一行 `[not-assessed]` 说明豁免了什么。只有当清单结构上不产出该节点的证据时才声明它:分数低不是豁免的理由,把该面全部可评节点豁免掉的配置会被门禁拒绝。这里没有声明任何豁免:`patent_oa_response_v1` 的 `generate_keywords` 阶段生成检索关键词,`draft` 阶段的指导把这套检索方案写进交付物,所以 `prior-art-search` 与 `deliverable-format` 在两个面上都由真实读数得出。

成本口径:一轮工作流把整份 manifest 跑完——`patent_oa_response_v1` 为 15 个阶段、其中 5 个由模型执行,`patent_disclosure_v1` 为 27 个阶段、其中 14 个由模型执行——一次采集的模型调用数比一轮提示词调用高一个量级以上,所以该设置下 `--runs` 缺省 1;`--budget-ms` 仍然限住整次采集,计划行在做任何调用之前就把阶段数打出来。

采集到的分数测的是「调用方传入的 profile(缺省 `headless`)下的模型 + 作业规范」;工作流设置测的是工作流阶段与审计链,不含 preset 的人设与技能层——preset 是 agent 平面,只有 `dsh-agent-preset-registry` 能挂它,而 headless 组合不装配该注册器。因此记录之间只在同一 profile、同一被测面下可比——`provider`、`modelId`、`execution` 与 `workflowId` 四个字段就是为这条留的。

随仓提交的提示词面基线是 2026-11-02 的一次 keyed 实测:`headless` profile 并传入 `--provider deepseek-official --model deepseek-flash`、5 个 case 各三次运行。聚合 96.14,五个 case 分别为 98.0、93.4、97.8、98.1、93.3。每个 case 记录检索设置:`oa-answer` 与 `novelty-creative` 为 `oracle`,其余三个为 `none`。记录保留每个维度的 `scores`(每次运行一条原始分)、`provider`、`modelId` 与 `tokens`——120 次调用合计输入 26,985,964(含缓存读写)、输出 648,753;`cost` 仍为空,因为 provider 不报告成本且调用方没有传每百万 token 单价。`oa-answer` 是多轮 case:终局轮 93.3 对第 1 轮 95.5,「修改接地与幅度」为 79.0;`technical-teaching` 为 93.0。新案的 26.3 与 26.4 节点分别为 89.0 与 87.7,保护范围节点为 96.8。本次实测按 B7 测量协议预注册的 `--runs=3` 执行。除模型调用之外的一切另有覆盖:采集接缝可注入,spec 用桩把整条链路跑通并写出那两种产物,覆盖提示词、产物契约、逐维度聚合、两轮交接、真实启动参数,以及记录能被门禁接受。工作流设置按同样方式覆盖——桩写出运行记录、交付物与留档条目,spec 钉住提示词契约、链深复算,以及工作流降级或中断时的失败。该设置按 manifest 各有一条 keyed 基线。第一条是清单补上 `generate_keywords` 阶段后于 2026-10-25T17:54Z 重录的:`oa-answer` 单 case、每 case 一次运行、两轮,聚合 94.76,case 94.8(逐轮 92.3 → 94.8),逐轮权项版本 1 → 2,第 5 维 100.0——正是首次采集不得不豁免的那个切面;`_matter-log.md` 里建案与修订两条条目的时间戳连续,第 2 轮的工作目录是第 1 轮的整份副本,取代链因此没有断在两轮之间。该次采集早于泛化后的执行者提示词:OA 任务文本不含申请日,新增的 `filingDate` 指令对它不生效;按轮区分的权项摘录措辞未变,因此没有重录基线。工作流面另有 `patent_disclosure_v1` 的基线:`disclosure-drafting` 单 case、一次运行,2026-11-04 采集,聚合 93.00,七个维度依次为 100、100、95、82、88、85、90,记录 4,220,332 计费输入与 58,923 输出 token;一轮执行 27 个阶段、其中 14 个由模型执行,该面因此保持 `--runs` 为 1。

## 播种

```sh
node seed.mjs [baseDir]
```

`baseDir` 缺省为 `~/.dsh/self-evolve-benchmark`(与引擎默认 `baseDir` 对齐;`$DSH_HOME` 覆盖 `~/.dsh`)。脚本幂等:重跑会原位覆盖 case 文件。

播种后的布局:

```
<baseDir>/benchmarks/patent-oas/
├── benchmark_config.yaml
├── oa-answer/statement|rubric
├── claim-drafting/statement|rubric
├── disclosure-drafting/statement|rubric
├── infringement-comparison/statement|rubric
└── novelty-creative/statement|rubric
<baseDir>/patent-state/
└── guidance.md   # 初始 agent state 种子
```

## 使用

播种后即可通过引擎公共方法跑闭环。引擎的 `baseDir` 应指向同一数据根,`agentStateDir` 指向播种出的 `patent-state` 工作副本:

```ts
await engine.establishBaseline('patent-oas', { runsPerCase: 1 })
await engine.optimizeLoop('patent-oas', {
  maxRounds: 3,
  targetScore: 80,
  runsPerCase: 1,
})
```

`agentStateDir` 默认指向 `patent-state` 工作副本(见专利 preset 装配);**不要**把真实案卷目录当作 `agentStateDir`——那会把真实产物整包打快照并允许优化器就地改写。
