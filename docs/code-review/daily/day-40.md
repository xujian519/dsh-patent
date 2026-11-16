# Day 40 — 2026-12-24

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：跨域：错误处理、静默降级、模型可见性与会话日志一致性
- 时间盒：90 分钟
- 预期产出：E 维度汇总与去重结果；daily/day-40.md

## 检查项

- [x] 汇总四域的错误处理与静默降级。
- [x] 检查模型可见输入是否可从会话日志重建。
- [x] 检查会话事件覆盖。
- [x] 检查用户可见报告。
- [x] 汇总 E 维度并更新假设状态。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-014、F-VID-001 至 F-VID-015、F-CROSS-003 不重测。H09 的旧数字不改。复现脚本 `d40-repro.mts` 放在仓库根（裸包名要从仓根解析），未跟踪，跑完已删除；另跑了两个聚焦用例。今日不改 H04，新增的状态更新写在 H07 与 H10。

**错误处理与静默降级汇总（30 分钟）**：读 `packages/core/tools/src/pipeline.ts`、`batch.ts`、`packages/core/session/src/types.ts`，再对照四域的工具错误类与代表性 catch 点。核心的错误身份只认 `HarnessError`（`pipeline.ts:690`–`:694`），`batch.ts:256`–`:263` 只在 `result.error.info` 存在时把它写进 `tool/result`；`tools.spec.ts:2959` 与 `:2975` 分别锁住「HarnessError 保留 name/code」与「非 HarnessError 只保留 message」。四域里只有视频的 `MediaFailure` 继承 `HarnessError`；专利、文献、文档、法律的工具错误类都是普通 `Error` 子类，部分带 `code`、部分只有文案。发现 F-CROSS-004。静默降级逐项核对的结果是：`patent-data` 的 `parseJsonArray` 把非法 JSON 收成空数组、`patent-document` 的品牌注入把损坏的 `theme.json` 收成默认品牌、`legal-knowledge` 的 `findRow`/`findRowsLike` 把查询失败收成 `undefined`/空数组并只写日志、`ui-video-studio` 把损坏的账本/journal 收成 0 与空 pending；前两处是显式声明的宽松解析，后两处有注释说明取舍，均作为观察，不单列编号。

**模型可见性与会话日志（20 分钟）**：逐面对齐。系统提示由 `agent.ts:492` 落 `system/message`；工具 schema 由 `EpochHeader.tools` 落 `request/header`（`session/types.ts:246`）；用户与合成上下文落 `user/message`；工具调用与结果由 `batch.ts:245`–`:267` 落 `tool/call`、`tool/result`；专利工具内的模型调用由 `loggedPatentModel` 在流结束后落 `patent/model-call`（`model-call-log.ts:60`）。`document`、`legal`、`video-mode` 三域没有工具内的模型生成调用（`tool-office` 只读 `llm.resolveModelInfo` 判断图像输入能力，不产生模型可见文本），因此不需要对应的调用事件。外部 provider 的原始响应不直接进入模型请求，模型看到的是映射后的工具结果，已随 `tool/result` 落盘；视频 journal 也不是模型可见面，`media status` 通过 `tool/result` 返回。唯一残留是 F-PAT-010：工具内模型调用在流异常时不落事件。

**会话事件覆盖（15 分钟）**：`patent-workflow` 声明并追加 `patent/workflow-run`、`patent/evidence-ledger`、`patent/legal-gaps`、`patent/plantask`、`patent/model-call`；`patent-teams` 的团队事件全部标 `ignorable: true`，以磁盘团队状态为权威，会话追加失败只写日志。文档、法律、视频没有自定义会话事件；它们的模型可见输出都走 `tool/result`。视频项目文档、journal、账本不是会话事件，但 `video_project`/`media` 的结果里带模型需要看的字段，已随工具结果落盘。没有发现新的模型可见面遗漏。

**用户可见报告（15 分钟）**：抽查 `patent-metadata`、`document-deliver`、`paper-search`、`media`、`legal_knowledge_search` 的 render。`patent-metadata` 在成功与失败两个分支都渲染「通道告警」（`patent-metadata.ts:261`–`:269`）；`document-deliver` 把不可读文件报成 `status: unreadable` 并带原因（`tool.ts:365`–`:378`）；`paper-search` 把源站失败转成可行动提示（`paper-search.ts:123`–`:133`）；`media` 的失败走 `MediaFailure` 抛出，模型看到 `Error: <message>`；`legal_knowledge_search` 的空结果摘要明确说明「空结果表示本部署的知识库未命中」（`tool/search.ts:103`）。这些报告的文案与降级语义一致；缺的是失败分类在边界处丢失，归入 F-CROSS-004。

**E 维度汇总（10 分钟）**：D34–D40 的 29 条 E 编号加今日 1 条共 30 条，按主题归为六组（缺值/未知值当满足、同一事实两套解析、持久状态未对账、法定期限与日期口径、上游数据形状、校验条件与错误身份），明细与 Day 41 合并候选写在 [05-findings.md](../05-findings.md) 的「E 维度汇总（Day 40）」。H07 与 H10 据此更新。

**命令**：`pnpm exec tsx d40-repro.mts` 退出码 0。八个错误类里 `MediaFailure` 的 `instanceof HarnessError` 为 `true`；`PatentToolError`、`LiteratureToolError`、`DocTemplateError`、`DocumentStyleError`、`OfficeKitError`、`LegalLawVerifyToolError`、`EvaluateLegalEvidenceToolError` 全为 `false`，其中除 `DocumentStyleError` 外都带 `code`。`pnpm exec vitest run packages/core/tools/tests/tools.spec.ts -t "a non-HarnessError throw retains only its message"` 退出码 0（1 passed，153 skipped）；同一文件跑 `-t "a tool throwing a HarnessError surfaces its name and code"` 退出码 0（1 passed，153 skipped）。

## 发现

F-CROSS-004。

下面这些不够格单列：

1. `patent-data` 的 `parseJsonArray` 对空串、非法 JSON 与非数组都返回 `[]`（`mapper.ts:16`–`:24`），上游字段损坏时 `inventors`、`assignees`、`classifications`、引证会静默变空，结果里没有告警。函数 JSDoc 明写「leniently parse」，与 F-PAT-055 的 null 元素是不同入口，作为观察。
2. `patent-document` 的 `readBrandFromConfig` 吞掉 `theme.json` 的读取与 JSON 解析错误并回退默认品牌（`brandInjector.ts:50`–`:57`），注释说明这是有意降级。品牌错误不会阻断渲染，也不进工具结果，作为观察。
3. `legal-knowledge` 的 `SqliteFtsTable.findRow`/`findRowsLike`/`findRowsLikeAny`/`count` 在查询失败时返回 `undefined`/空数组/0，并只调用 `warnQueryFailure`（`shared/sqlite-search.ts:151`–`:215`）。直接调用这些 helper 的按 id/按名查询无法区分「没有该行」与「查询失败」；`legal_knowledge_search` 走的是 `runFtsSearch` 阶梯，LIKE 也失败时会抛出，所以影响面限于服务方法。Day 38 已记为观察，今天不升级。
4. `ui-video-studio` 的 `optionalJson` 把损坏的账本/journal 当成不存在（`project-reads.ts:343`–`:354`），工作室显示已花 0 元、无 pending；同一份账本损坏时 `video_deliver` 会以 `MEDIA_STORE_INVALID` 阻断。注释说明「不能因为账本坏了就不显示工程」，取舍合理，但两个界面对同一状态给出不同结论，作为观察。
5. `patent/model-call` 只记录输出与调用序号，请求侧靠工具参数、manifest 与阶段状态重建（`types.ts:69`–`:74`、`model-call-log.ts:60`–`:68`）。流在产出任何可见文本前失败时没有事件，这正是 F-PAT-010；今天不重开。
6. `patent-teams` 的会话记录追加失败只写日志（`events.ts:37`–`:45`），但团队状态以 `team.json` 与邮箱为准，工具结果也带同一状态；不构成模型可见面遗漏。

## 假设验证/推翻

H01–H06、H08、H09 今日不改，也没有重跑覆盖率或测试套件。H04 的 Day 39 验证点已完成，今天没有新证据。

H07 从「部分推翻（Day 7）」改为「部分确认（Day 40）」。渲染与交付门禁仍对 `not-indexed`/`unverified`/`out-of-range`/`mismatch` 阻断；但 E 维度在其他上层找到同一失败方向：F-PAT-042（未提取到技术问题时阻断级法条缺口记为通过）、F-PAT-045（省略 `parallel_lower_levels` 仍判概括范围通过）、F-PAT-048（解析不出驳回理由时双输入规则判通过）、F-PAT-049（结构/引用门禁不核对 `textArgs`）、F-LEG-011（证人利害关系未填写时关键规则判通过）。这些门禁把缺失或未知的输入当作满足，F-PAT-017 的立案路径缺口仍在。

H10 从「确认缺口（Day 5b）」改为「部分确认（Day 40）」。主可见面已覆盖：系统提示、工具 schema、用户/合成上下文、工具调用与结果、专利工具内模型调用都有事件。原假设点名的两个「尤其」不成立：外部 provider 原始响应不直接进入模型请求，视频 journal 也不是模型可见面，二者都通过 `tool/result` 间接落盘。残留缺口只有 F-PAT-010；F-VID-001 是 journal 的持久性缺陷，不改变「模型可见 ⟺ logged」的判断。Day 18 的 `lock.ts` 复核仍成立，但与本假设无关。

## 未决问题

1. 域内错误类应统一继承 `HarnessError`，还是在工具注册边界做一次转换？前者让错误类与 `dsh-llm` 绑定（`doc-style`、`office-kit` 还要补依赖），后者保留纯库的独立性但多一层包装。
2. `tool/result.error.info` 目前只有 `name` 与 `code`；域内错误携带的 `details`（专利号、数据库名、路径）要不要进事件？进的话需要定义稳定的 `details` 白名单，避免把大对象写进会话。
3. 工作室对损坏账本显示 0 元，`video_deliver` 却阻断；是让工作室也显示「账本不可读」并停止预算展示，还是保留当前「先显示工程」的取舍并在 UI 上标注？这需要产品口径确认。

## 明日第一件事

Day 41（收敛：去重与合并）第一件事：把 D34–D40 的 30 条 E 编号按「同一根因、同一修法、同一测试」合并成可执行条目，先处理「缺值/未知值当满足」与「同一事实两套解析」两组；保留 F-CROSS-004 作为独立的可观测性条目，不并入域内错误处理。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-001 至 F-LEG-014、F-VID-001 至 F-VID-015、F-CROSS-003、F-CROSS-004 不要重测。H09 的旧数字不要改。
