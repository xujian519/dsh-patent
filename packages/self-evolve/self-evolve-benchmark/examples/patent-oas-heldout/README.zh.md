# patent-oas-heldout 示例基准

[English](README.md) | 中文

`patent-oas` 示例基准的留出对照,属于 `@deepseek-ai/dsh-self-evolve-benchmark`,benchmark id 为 `patent-oas-heldout`。它的 `benchmark_config.yaml` 声明 `optimizable: false`,`optimizeLoop` 在加载之后、创建快照与候选之前直接拒绝:优化器永远看不到它的 statement 与逐 case 分数。测量不受影响——`establishBaseline` 照常运行。

## 为什么需要它

`patent-oas` 同时是门禁基准和优化目标:优化回路读全部 case 的 statement 与逐 case 分数,门禁分数上涨可能只是 agent state 被调到了这七个固定 case 上,而不是工作本身变好。本基准是控制测量:优化只在 dev 面(`patent-oas`)上进行,优化前后各读一次本基准,看增益是否迁移到优化器从未见过的 case。case 的 statement 取自 `patent-oas` 语料记录的公开授权文本(CN202023432U 用于 OA case,CN213535478U 用于撰写 case),按 dev case 同样的自足形式转述;rubric 按同一维度拆分人工编写。

## Cases

| case | 任务 | 评分维度 |
|---|---|---|
| `heldout-oa-answer` | 锁具结构的 OA 答复,与 dev `oa-answer` 同为两轮(脚本化第二次审查意见在 `rounds/02/statement`) | 区别特征、技术问题、技术启示、结论与法条、检索与格式、修改接地 |
| `heldout-claim-drafting` | 折叠箱交底书 → 权利要求:独权 + 从权布局 | 必要技术特征、保护范围、从权布局、引用层次、形式与支持 |

两个 case 只支持方向性的前后对照:不当门槛、不设阈值、不作统计结论;专家校准集是后续工作。

## 边界:只保证 prompt/history 隔离,不是密封集

`optimizable: false` 只保证优化回路的 prompt 面(statement)与 history(逐 case 分数)不含本基准,不保证数据根不可达:带文件工具的 agent 进程仍可能读到 `~/.dsh/self-evolve-benchmark/patent-oas-heldout`。读数应按「抗污染」而非「防污染」对待;真正的密封集放在仓库之外。

## 播种与测量

```sh
node seed.mjs [baseDir]
pnpm dsh --profile self-evolve \
  --patch packages/self-evolve/self-evolve-benchmark/examples/patent-oas-heldout/baseline.overlay.yml \
  baseline
```

`seed.mjs` 把 `benchmark_config.yaml` 原样复制(保留 `optimizable: false`),并把每个 case 的 `statement`/`rubric` 写进 `<baseDir>/benchmarks/patent-oas-heldout/`;它不播种 agent state——测量复用 dev 基准优化的同一个 `patent-state` 目录(overlay 的 `agentStateDir` 指向它),前后两次读数因此测的是同一份状态。测量口径:`optimizeLoop('patent-oas', …)` 前跑一次 baseline,后再跑一次,比较两条 scoreboard 记录。held-out 分数不进门禁阈值,也不作 optimize 的 reference。
