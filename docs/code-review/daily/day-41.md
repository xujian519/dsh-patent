# Day 41 — 2026-12-25

## 今日维度与范围

- 维度：收敛
- 范围：去重与合并。缩短为只复核尚未进入主干、且下一轮要改代码的 E 项
- 时间盒：90 分钟
- 预期产出：05-findings.md 的状态对齐；daily/day-41.md

## 检查项

- [x] 复核下一轮要改代码的 E 项是否仍在 `origin/master`。
- [x] 把已落地的合并组移出队列，保留仍开着的根因组。
- [x] 关闭误报并写明理由。本轮没有新的误报。F-PAT-047 维持 deferred。
- [x] 更新状态。
- [x] 输出去重后的清单。排序写在 Day 42 与 [06-priority.md](../06-priority.md)。

## 实际执行

**口径（10 分钟）**：2026-11-17 对照 `origin/master` `d138898f90`。不改业务代码。不重跑 d36–d40 的复现脚本，不重测已修的 37 条。复核方式是读当前实现里原先失败的判定。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。

**已落地的合并组（10 分钟）**：Day 40 的六个合并组里，F-PAT-040/041/046、F-PAT-042/048/049、F-LEG-011/012 的详情状态已是 fixed。F-PAT-052 已是 fixed。这四组留在修复记录里，不进入剩余队列。

**F-PAT-051（15 分钟）**：`citator.ts:146` 仍调用 `queryArticleLineage(lineage, reference.article)`，比较的是条号，不比较 `lineage.law` 与 `reference.law`。`lineage.ts:87`–`:91` 仍按 `articleId` 查找。`index.ts:200` 仍加载一份快照。指南节走 `decideSectionValidity`，那是 F-PAT-052 的路径。本条改为 confirmed。

**F-DOC-008、F-DOC-009（10 分钟）**：`doc-template` 的 `markdown.ts:38` 在正文以 `# ` 开头时不注入标题；`html.ts:173` 与 `docx.ts:24` 仍注入 `meta.title`。`docx-kit` 的 `markdown.ts:110`–`:112` 仍按每个 `|` 切分单元格，`isTableSeparator`（`:100`）仍把整行破折号当分隔行。两条改为 confirmed。

**F-VID-011、F-VID-012、F-VID-013（15 分钟）**：`tools/media.ts:386`–`:393` 先读账本再比较余额，`submit` 在检查之后，成功路径的 `settleTask` 在 `:449`。`:467` 只接住 `MEDIA_TASK_NOT_FOUND`；`media.ts:889` 对未注册 provider 抛 `MEDIA_PROVIDER_UNAVAILABLE`，工具侧没有对应的 `forgetTask`。`status` 在 `:475`–`:479` 见到 `artifacts !== undefined` 就结算，不看数组长度；`generate` 在 `:446`–`:447` 对空数组抛 `MEDIA_ARTIFACT_INVALID`。三条改为 confirmed。F-VID-002 的补丁在 #881，本轮不在主干上重写。

**F-PAT-053、F-PAT-054、F-LEG-014（10 分钟）**：`patent-fees` 的 `compute.ts:213` 仍把同一个 `query.lateMonths` 传给每个年度。`deadline-entries.ts:628` 仍用 `notice.designatedMonths ?? variant?.months ?? args.months`。`knowledge-core` 的 `validity.ts:40` 仍取 `toISOString().slice(0, 10)`。三条改为 confirmed。

**F-CROSS-004（10 分钟）**：`PatentToolError`、`DocTemplateError`、`OfficeKitError`、`LegalLawVerifyToolError` 仍 `extends Error`。单独成批，改为 confirmed。

**总表对齐（10 分钟）**：F-PAT-002、F-LEG-001、F-DOC-001 的实现已在主干（批次 E9、E7、E10），总表与详情从 confirmed 改为 fixed。没有重跑这三条的用例。

**命令**：`git grep` 与 `git show` 读取上述文件，退出码 0。未执行 `pnpm exec tsx` 复现脚本。

## 发现

无新编号。状态变更：F-PAT-051、F-PAT-053、F-PAT-054、F-DOC-008、F-DOC-009、F-VID-011、F-VID-012、F-VID-013、F-LEG-014、F-CROSS-004 改为 confirmed。F-PAT-002、F-LEG-001、F-DOC-001 改为 fixed。

## 假设验证/推翻

H01–H10 今日不改。

## 未决问题

1. F-CROSS-004 是让错误类继承 `HarnessError`，还是在工具边界转换。两个方案都还成立，留给 R-E5 开工时定。
2. F-PAT-047 的真实续接仍未立项。
3. #887（F-PAT-016）可以合并的检查里，coverage 仍失败。本轮不修、不合。

## 明日第一件事

Day 42 把剩余项写成修复顺序。下一轮从 R-E1（F-DOC-008、F-DOC-009）开始。
