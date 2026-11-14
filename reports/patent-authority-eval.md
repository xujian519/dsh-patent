# 权威性评测

任务清单 `packages/patent/patent-law/assets/authority/authority-eval-tasks.yaml`，核对于 2026-11-14。30 个任务，六类案型各五个。评测不调用模型：条文引用交给索引核验，位阶按 `packages/patent/patent-law/assets/authority/authority-ranks.yaml` 取先。

## 与阶段 0 对比

| 指标 | 阶段 0 | 本次 |
| --- | --- | --- |
| 基准任务 | 0 | 30 |
| 已知引用错误 | 5 | 0 |
| 引用正确率 | 未测量 | 100.0% |
| 命题支撑率 | 未测量 | 100.0% |
| 时效正确率 | 未测量 | 100.0% |
| 拒答率 | 未测量 | 100.0% |
| 位阶冲突裁决正确率 | 未测量 | 100.0% |

## 分项

| 指标 | 命中 | 合计 | 比率 |
| --- | --- | --- | --- |
| 引用正确 | 35 | 35 | 100.0% |
| 命题支撑 | 35 | 35 | 100.0% |
| 时效正确 | 3 | 3 | 100.0% |
| 拒答 | 7 | 7 | 100.0% |
| 位阶裁决 | 6 | 6 | 100.0% |
| 错误口径 | 0 | 0 | 0 |

## 任务

| 任务 | 案型 | 引用 | 命题 | 时效 | 拒答 | 位阶 | 错误口径 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| drafting-01 | drafting | 1/1 | 1/1 | — | — | — | 0 |
| drafting-02 | drafting | 1/1 | 1/1 | — | — | — | 0 |
| drafting-03 | drafting | 1/1 | 1/1 | — | — | — | 0 |
| drafting-04 | drafting | 1/1 | 1/1 | — | 1/1 | — | 0 |
| drafting-05 | drafting | 1/1 | 1/1 | — | — | patent-law | 0 |
| prosecution-01 | prosecution-response | 1/1 | 1/1 | — | — | — | 0 |
| prosecution-02 | prosecution-response | 1/1 | 1/1 | — | — | — | 0 |
| prosecution-03 | prosecution-response | 2/2 | 2/2 | — | — | — | 0 |
| prosecution-04 | prosecution-response | 2/2 | 2/2 | — | 1/1 | — | 0 |
| prosecution-05 | prosecution-response | 1/1 | 1/1 | — | — | patent-law | 0 |
| reexamination-01 | reexamination | 1/1 | 1/1 | — | — | — | 0 |
| reexamination-02 | reexamination | 1/1 | 1/1 | — | — | — | 0 |
| reexamination-03 | reexamination | 1/1 | 1/1 | — | — | — | 0 |
| reexamination-04 | reexamination | 1/1 | 1/1 | — | 1/1 | — | 0 |
| reexamination-05 | reexamination | 1/1 | 1/1 | — | — | patent-law | 0 |
| invalidation-01 | invalidation | 1/1 | 1/1 | — | — | — | 0 |
| invalidation-02 | invalidation | 1/1 | 1/1 | — | — | — | 0 |
| invalidation-03 | invalidation | 2/2 | 2/2 | — | — | — | 0 |
| invalidation-04 | invalidation | 1/1 | 1/1 | — | 1/1 | — | 0 |
| invalidation-05 | invalidation | 1/1 | 1/1 | — | — | patent-law | 0 |
| infringement-01 | infringement | 1/1 | 1/1 | — | 1/1 | — | 0 |
| infringement-02 | infringement | 1/1 | 1/1 | — | — | — | 0 |
| infringement-03 | infringement | 2/2 | 2/2 | — | — | — | 0 |
| infringement-04 | infringement | 1/1 | 1/1 | — | 1/1 | — | 0 |
| infringement-05 | infringement | 1/1 | 1/1 | — | — | patent-law | 0 |
| search-01 | search-analysis | 1/1 | 1/1 | — | — | — | 0 |
| search-02 | search-analysis | 1/1 | 1/1 | — | — | — | 0 |
| search-03 | search-analysis | 2/2 | 2/2 | — | — | — | 0 |
| search-04 | search-analysis | 1/1 | 1/1 | 3/3 | 1/1 | — | 0 |
| search-05 | search-analysis | 1/1 | 1/1 | — | — | patent-law | 0 |
