# Day 34 — 2026-12-18

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：专利域-1：patent-tools、patent-core
- 时间盒：90 分钟
- 预期产出：E 维度专利域候选发现；daily/day-34.md

## 检查项

- [x] 检查类型边界与 unknown 输入。
- [x] 检查 claim 与 evidence 的业务不变量。
- [x] 检查错误码与失败报告。
- [x] 检查静默降级。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。复现脚本在 `/tmp/d34-repro.mts`，只作当场证据，不进仓库。

**类型边界（15 分钟）**：`rg -c "as unknown"` 在 `patent-core/src` 命中 3 个文件共 4 处，在 `patent-tools/src` 命中 17 个文件。这批已由 F-PAT-012 登记，今日不重数、不另开编号。`JSON.parse(...) as` 抽到索引、图表回读、黑板、创造性与充分公开的模型 JSON。索引路径在 `index-store.ts:74`–`:86`：版本或结构不对、JSON 损坏都带回 `warning`，不是空成功。`claim-chart-build.ts:363` 把同一进程里原子刚写出的 `claim_chart_doc` 再解析回来，失败会在前面的 `_error` 分支抛 `PatentToolError`。`tryParseJson` 解析失败返回 `undefined`。这些不够格单列。

**权利要求（30 分钟）**：对照 `deriveClaimRefs` 与 `parseClaimDocument`。区间跨度大于 30、倒序区间、全角数字、「如权利要求」四句的独立／从属结论不一致，见 F-PAT-039。`validateElements` 对不存在的权 5 接受了权 1 的文本，见 F-PAT-044。`ClaimBreadthHandler` 在模型省略 `parallel_lower_levels` 时仍返回通过，见 F-PAT-045。无行首编号的缺省仍归 F-PAT-020，今日不改那条。

**证据与对比表（25 分钟）**：空 `quote` 的 `literal` 行得到 `covered: true`，见 F-PAT-040。权 1 没有要素、权 2 只覆盖自身附加特征时，结论仍写「已并入所引用权利要求 1 的全部要素」和「无区别特征」，见 F-PAT-041。同一格同时有 `literal` 与 `not-found` 时，缺口列表与全覆盖同时成立，见 F-PAT-046。空 pin-cite 在带段号标记的源文上被 `validatePinCite` 拒绝，见 F-PAT-043。`validateChart` 未导出，整图路径没有进进程。

**失败方向（15 分钟）**：`diff: '区别特征是壳体为金属。'` 使 `problem_check_passed` 为 true，报告写「无法校验（不阻断）」。`profile: 'inventiveness'` 的 `LegalGapsHandler` 把专利法第 22 条第 3 款这一阻断项记为 `passed`，`legal_gaps_passed` 为 true，见 F-PAT-042。证据清单缺失时 `evidence_check_passed` 也是 true，但报告含「未执行」，`legal-gaps.ts:194`–`:197` 记成未评估，不另开编号。`loadEvidenceRulesEngine` 在资产缺失时把警告放进返回值，调用方是否展示留到用到该引擎的包再看。

**命令**：`pnpm exec tsx /tmp/d34-repro.mts`，退出码 0。决定性结果：`1-35` 与 `3-1` 在 `deriveClaimRefs` 中为 `independent`，在 `parseClaimDocument` 中为从属；「如权利要求 1」相反；全角「１」相反。空 quote 的权 2 `covered: true`。无权 1 要素时结论文本含「已并入所引用权利要求 1 的全部要素」。`problem` 项 `status: passed`。省略并列下位时 `claim_breadth_passed: true`，报告含「未列出并列下位；效果一致：是」。权 5 借用权 1 文本时 `validateElements` 为 `ok: true`。同格两行时 `gaps` 为 `not-found` 且覆盖 `covered: true`。`validatePinCite('')` 为 `ok: false`。

## 发现

F-PAT-039、F-PAT-040、F-PAT-041、F-PAT-042、F-PAT-043、F-PAT-044、F-PAT-045、F-PAT-046。

下面这些不够格单列：

1. `as unknown` 与图表文档的同进程再解析已有登记或有前置 `_error` 分支。
2. 证据清单缺失时布尔值是 true，法条缺口另看报告里的「未执行」，结果是未评估。
3. 损坏的附图或化学索引返回 `warning`，并在覆盖写入前尝试备份。

## 假设验证/推翻

H01–H10 今日不改。H07 仍是 Day 7 的部分推翻：它说的是未核验引用被当成通过。今日的 F-PAT-042 是另一条失败方向，技术问题文本没提取到，阻断项仍记通过。未核验引用留到 Day 38。H09 的旧数字维持 Day 19 的写法。

## 未决问题

1. `validateChart` 没有导出。空 pin-cite 在整图里被拒绝，来自 `chart.ts:299` 的无条件调用，加上 `validatePinCite('')` 返回 `ok: false`。没有把 `ClaimChartHandler` 配上可读源文再跑一遍。
2. 没有重跑 `patent-core` 与 `patent-tools` 的测试套件。结论只覆盖脚本里的输入。
3. 没有统计交底里「如权利要求」和全角数字的出现次数。可能性按这两句是常见撰写句式来定。

## 明日第一件事

Day 35（E 正确性与边界：专利域-2，`patent-workflow`、`patent-rule`、`patent-teams`）第一件事：检查状态机不变量、审批与恢复、规则失败的传播、团队任务一致性，并附证据。F-PAT-032 至 F-PAT-046 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 和 Chrome。H09 的旧数字不要改。
