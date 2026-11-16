# Day 27 — 2026-12-11

## 今日维度与范围

- 维度：D 测试缺口
- 范围：专利域-1：patent-tools、patent-core
- 时间盒：90 分钟
- 预期产出：D 维度专利域候选发现；daily/day-27.md

## 检查项

- [x] 按高风险表面列出 happy path 覆盖。
- [x] 列出错误路径与边界测试缺口。
- [x] 评估断言强度。
- [x] 列出完全未测模块。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：测量时工作区在 Day 27 分支，本日记录还没写入。Node `v24.19.0`。不改业务代码。`vitest.config.ts` 的覆盖率包含 `packages/*/*/src/**/*.{ts,tsx}`，阈值是语句、分支、函数、行都为 100。豁免清单按包逐个写，其中没有 `patent-tools` 和 `patent-core`（`vitest.config.ts:289`–`:294`）。`patent-tools` 的 `src` 148 个文件、40687 行，`tests` 121 个文件、38411 行。`patent-core` 的 `src` 165 个文件、32794 行，`tests` 100 个文件、24169 行。今日没有重跑全仓 `test:coverage`。

**高风险表面（20 分钟）**：沿 Day 26 的交接先看渲染与立案。渲染在 `patent-tools` 的 `figure/`。立案在 `patent-filing`，完整审阅留给 Day 29，今日只回答「测试是否只覆盖成功退出」。两边都有失败分类。Graphviz：超时 `figure-graphviz-renderer.spec.ts:351`，信号终止 `:402`，调用方取消 `:415`，非零退出 `:508`，零退出但没有产物 `:495`。Inkscape：非零退出 `figure-inkscape-renderer.spec.ts:407`，调用方取消 `:426`，产物仍含文字 `:244`，临时目录删除失败仍保留结果 `:346`。FreeCAD：超时 `figure-freecad-renderer.spec.ts:388`，信号终止 `:321`，调用方取消 `:334`，成功路径断言 `graceMs` 为 3000 `:256`。立案：已取消则不起进程 `patent-filing/tests/engine.spec.ts:494`，非 JSON 时带上退出码 `:360`，被信号终止 `:370`，报告字段畸形 `:380` 起。真实二进制的 spec 在缺 `dot`、Inkscape 或 FreeCAD 时整组跳过，今日没有复跑那些进程。

**断言强度（30 分钟）**：失败码和宽限常量已经被用例钉住。`startRenderDeadline` 的 `dispose`（`subprocess-render.ts:210`–`:213`）会 `clearTimeout` 并摘掉调用方 abort 监听，三处 `finally` 都调用它（`graphviz-renderer.ts:252`、`freecad-renderer.ts:300`、`inkscape-renderer.ts:303` 与 `:363`）。附图测试没有断言 `deadline.dispose` 或监听数。删掉某一处 `finally` 里的调用，超时、取消和非零退出用例仍然通过。这是 F-PAT-033。`patent_pdf_download` 的续传、强制重下、清单损坏和 fetch 超时都有用例。成功落盘会把 `sha1` 写入 `.MANIFEST.jsonl`（`patent-pdf-download.ts:613`），`packages/patent/patent-tools/tests` 里没有 `sha1`。fetch 兜底用例只断言工具文本含「fetch 兜底」（`patent-pdf-download.spec.ts:130`–`:154`）。续传只比较文件大小（`:264`–`:269`）。这是 F-PAT-034。

**纯库抽样（20 分钟）**：`pnpm exec vitest run packages/patent/patent-core/tests --coverage.enabled --coverage.include=packages/patent/patent-core/src/atoms/handlers/builtin/state-keys.ts`，退出码 0，89 个文件、1751 个用例，3.73 秒。`state-keys.ts` 的语句、分支、函数、行都是 100%。非空字符串数组的合并由 `numeric-range-atom.spec.ts:113` 锁住：`features` 为 `['温度为 50-80℃', '厚度为 5mm']` 时期望区间是 `50-80` 与 `5`。空数组路径在同文件 `:183`。F-PAT-019 里「`readStateText` 的数组分支没有用例」已经和这段对不上，那条发现的正文今日不改。`assertSafeId` 的行为用例仍在 `patent-data/tests/persist-utils.spec.ts`，归 F-PAT-007 的尾项，不另开编号。`rule_check` 丢掉同义词资产警告仍是 F-PAT-002，它已经写了缺资产用例，今日不另开编号。`pdf-download.spec.ts` 对 HTML、过小体、魔数和日期目录有直接断言。

**完全未测模块**：两包的 `src` 不在覆盖率豁免里。今日没有全仓覆盖率数字，不能把「每个文件都是 100%」写成今日测量。抽样到的渲染、下载、状态读取和 PDF 体校验都有测试文件触及。完全未测的模块清单为空。新缺口是断言没有锁住清理和清单摘要。

## 发现

- [F-PAT-033](../05-findings.md)：附图渲染截止期的 `dispose` 没有用例锁住监听清理。
- [F-PAT-034](../05-findings.md)：`patent_pdf_download` 成功落盘后不检查清单里的 sha1。

下面两条不够格单列：

1. 渲染与立案的成功退出旁边已经有超时、取消、非零退出和信号终止的分类断言。Day 26 交接的「只覆盖成功退出」在这两条包装上不成立。
2. `readStateText` 的非空数组合并由数值范围原子的 `features` 用例锁住两个区间。F-PAT-019 的相关句子过时，正文留在原处。

## 假设验证/推翻

H06 仍待验证。今日两包的缺口在渲染监听清理和 PDF 清单摘要，provider 与 CLI 留到后续日。H01–H05、H07–H10 的验证点不在今日，状态不改。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。`state-keys.ts` 的 100% 只来自 `patent-core` 这 1751 个用例。
2. 真实 `dot`、Inkscape、FreeCAD 的 spec 在缺二进制时整组跳过。今日没有启动这几个进程。
3. `patent-filing` 只抽了引擎包装的失败与取消。包内其余表面留给 Day 29。

## 明日第一件事

Day 28（D 测试缺口：`patent-workflow`、`patent-rule`、`patent-teams`）第一件事：按高风险表面列 happy path，先看审批拒绝、阶段超时和运行恢复的用例是否只断言成功结束。渲染分类、立案解析和今日这两条发现不要重测。
