# Day 7 — 2026-11-21

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-21）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：专利域-2：patent-knowledge、patent-rule、patent-law、patent-fees
- 时间盒：90 分钟
- 预期产出：A 维度专利域候选发现；daily/day-07.md

## 检查项

- [x] 检查 SQL/FTS 查询是否参数化，输入是否来自模型或文件。
- [x] 检查索引与规则资产路径是否可被输入影响。
- [x] 检查引用核验失败是否 fail closed。
- [x] 检查费用与法条读取的权限与边界。
- [x] 记录候选发现与证据。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 扫 SQL 构造 | `prepare(\`…\`)`/`exec(\`…\`)` 共 20 处；逐处确认插值来源为包内字面量、闭集常量或已转义路径 |
| 扫 FTS/LIKE | `MATCH ?` 与 `LIKE ?` 全部绑定；多词 LIKE 的 OR 子句按词数生成占位符 |
| 查资产路径 | 四个包的模型可见工具没有路径参数；`rulesDir`/`baselineDir`/费用目录只来自 `Config` |
| 追引用门禁 | `citation-gate.ts` 的 `BLOCKING` 集合、`patent-rule` 的 `isBlockedResult`，以及 preset 里 `citationGate`/`deliveryGate` 的实际条目 |
| 查费用失败方向 | `DEFAULT_FEE_POLICY.failOnUnverified = true`，`Config` 默认同样为 true |

## 发现

- **F-PAT-017**（High，A/E）：交付前引用门禁只有 `render_patent_document` 一条，`build_patent_filing` 的 `deliveryGate` 只要求本会话跑过一次未 `blocked` 的 `law_verify`；而 `patent-law` 默认把 `notIndexed`/`unverified` 判为 `warn`，不产生 `blocked`。申请文件 draft 里的伪造或未收录引用不会被阻断。

定向结论中确认已处理、不立发现的项见 [05-findings.md](../05-findings.md) 的「Day 7 定向结论」。

## 假设验证/推翻

- H07：**部分推翻**。工具层的 `law_verify` 默认对 `notIndexed`/`unverified` 只警告，但渲染路径的交付门禁单独维护了一份更严的 `BLOCKING` 集合，把两者都算作阻断——「未核验被上层当作通过」在 render 路径不成立。缺口在立案构建路径（F-PAT-017）。
- H02：**新增观察**。`patent-rule` 的引用门禁同时消费 `patent-law` 与 `legal-law` 两个索引（专利法系走前者，民法典与民事诉讼法走后者），共享机制在门禁层被直接复用，未见单域特化分支。
- H05：本轮未扩大攻击面；四个包的输入都只进入 SQL 绑定与内存查询。

## 未决问题

1. `build_patent_filing` 是否应纳入 `citationGate`，取决于申请文件是否允许引用法条——preset 的门禁注释认为申请文件「可以合法地不引用法条」，但「不引用」与「引用了错的」是两件事，需要在 Day 38 一起定。
2. `unmatched`（没有条目承载命题）不在阻断集合里，是刻意保留的弱信号；是否需要按交付类型区分，留到 Day 38。
3. `patent-knowledge` 的 install 路径只经 CLI 与显式 API，不注册为工具；若将来挂成工具，需要重新审它的目标路径约束。

## 明日第一件事

Day 8：专利域-3，检查 `patent-workflow` 的 HITL 审批是否可被绕过或伪造、`patent-teams` 的 mailbox 与任务板身份边界、`patent-document`/`patent-filing` 的模板注入与路径穿越。
