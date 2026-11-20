# Day 17 — 脚本场景（五）：说明书与立案干净场景

## 今日维度与范围

本日跑「说明书与立案」4 道可测题的干净场景：P-SPC-01 说明书草案、P-SPC-02 章节完整性校验、P-SPC-03 授权前景意见渲染、P-SPC-04 CNIPA 申请文件成文。P-SPC-05 是应拒绝题，按层口径记未测。题面与外部判定取自 [pilot-questions.md](pilot-questions.md)，本文件只记实际测量。本日不改 `daily/`、业务代码、依赖、CI 或基础设施配置。

## 检查项

- [x] 4 道可测题都按题面填参并执行一次，参数经 schema 校验。
- [x] 外部判定按题面逐条比对，失败项写明原因。
- [x] P-SPC-03 的失败先归类为题面 fixture 问题还是工具回归。
- [x] 墙钟、输出文件与残留按 [day-13.md](day-13.md) 的口径记录。
- [x] P-SPC-05 记未测，不记 0，不记失败。
- [x] 本日没有采样模型，也没有改业务代码。

## 样本表

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-SPC-01 | 说明书与立案 | 脚本 | `draft_specification` | `draft_specification` | 通过 | 有效 | 成立 | 未采样 | 1 ms | | | | | 无 |
| P-SPC-02 | 说明书与立案 | 脚本 | `validate_specification` | `validate_specification` | 通过 | 有效 | 成立 | 未采样 | 1 ms | | | | | 无 |
| P-SPC-03 | 说明书与立案 | 脚本 | `render_patent_document` | `render_patent_document` | 通过 | 有效 | 不成立 | 未采样 | 1 ms | | | | | 无 |
| P-SPC-04 | 说明书与立案 | 脚本 | `build_patent_filing` | `build_patent_filing` | 通过 | 有效 | 成立 | 未采样 | 190 ms | | | | | 成品 1 件 |
| P-SPC-05 | 说明书与立案 | 模型 | 无 | — | | | 未测（应拒绝题只在真实模型层测量） | 未测 | | | | | | |

语义一列核对了 P-SPC-01 的发明名称、专利类型、附图说明与特征数组，P-SPC-02 的缺章节文本，P-SPC-03 的模板、输出名、格式与三个注入字段，P-SPC-04 的案号、无附图草案与输出名；四项都按题面原样填入。

## 逐题结果

### P-SPC-01 说明书草案：成立

`complete` 为 `true`，`missing_inputs` 为空；`sections` 依次是技术领域、背景技术、发明内容、附图说明、具体实施方式；摘要 72 字，含「关键词：」；实施例块 1 个，丢弃 0 个。题面的六条判定全部成立。

摘要内容为「本发明公开了一种检测装置，要解决的技术问题是现有检测装置精度不足。技术方案：提供一种包括壳体的检测装置。有益效果：提高检测精度。关键词：检测装置」。实施例块引用了特征 F1。

### P-SPC-02 章节完整性校验：成立

`passed` 为 `false`；`violations` 里有 `rule=sections`、`severity=error`、消息「缺少必要章节：背景技术、发明内容、具体实施方式」；`evaluated` 里有 `field=text`、`chars=20`、`digest=sha256:cc2a67…`。题面的三条判定成立。

实际输出还多了两条相关结果：`rule=embodiments` 的 error（未记载实施例）与 `rule=patent_type_assumed` 的 warning（未声明专利类型）。题面只要求 sections 这条，额外结果不改变判定；工具没有自动补写章节。

### P-SPC-03 授权前景意见渲染：题面 fixture 不成立

工具在执行前拒绝了题面的 draft，报「草案校验失败（16 项）」，列出的缺失槽位是：

- `fields`：`meta-case`、`meta-basis`、`meta-date`、`sum-title`、`footer-case`、`footer-date`
- `sections`：`doc-number`、`basis-body`、`claim-decomposition-body`、`feature-comparison-body`、`inventiveness-step-1`、`inventiveness-step-2`、`inventiveness-step-3`、`other-requirements-body`、`evidence-body`、`citation-log-body`

题面的 draft 只给了 `meta-client`、`meta-title`、`sum-conclusion` 三个字段，`sections` 是空数组。当前 `patentability-opinion` 模板要求 16 个必填槽位，空数组不满足。因此外部判定里的 `htmlPath`、文件存在与三个注入字段都无法评估。

这是题面 fixture 与当前模板的不同步，不是工具回归：同一套槽位校验在 P-SPC-04 的 `claims-spec` 路径上正常。冻结前应把 P-SPC-03 的 draft 补齐到模板必填槽位，或改用 `patentability-opinion` 的最小合法 draft；本周期只记录，不改题面。失败结果本身没有 `error.code`，属于 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 所列 F-CROSS-004 的「不可解释」样本。

### P-SPC-04 CNIPA 申请文件成文：成立

`docxPath` 存在，`verification.passed` 为 `true`，`verification.info.layout` 的三个分节是 `abstract`、`claims`、`specification`；成品字体是宋体/Times New Roman 12pt、行距 1.5、首行缩进 24pt；模板指纹 `sha256:f589a5bcd75ffa85…`。题面的「docx 存在、验收通过或独立验收通过、3 个分节、没有声称已提交 CNIPA」全部成立。

成品文件 `pilot-filing.docx` 按题面落在输出目录；这是要求交付物，不是残留。构建引擎的临时工作目录由 `mkdtemp('dsh-patent-filing-')` 创建并在 `finally` 删除，本轮没有留下该前缀的目录；子进程在调用返回后为空。

## 族内结论

4 道可测题里 3 道闭环成立（P-SPC-01、P-SPC-02、P-SPC-04），1 道因题面 draft 缺 16 个必填槽位不成立（P-SPC-03）。本族闭环基线是 3/4；P-SPC-05 不计入分母。

P-SPC-04 是唯一走真实 Python 引擎的题：190 ms 内完成成文与验收，子进程与引擎临时目录都没有残留。P-SPC-03 的失败是冻结前要修的题面问题，不登记为产品缺陷；缺 `error.code` 的现象归入 F-CROSS-004 的读数口径。

## 明日第一件事

Day 18 第一件事：开始注入轮，先做「检索与法律状态」的超时与空结果：P-RET-01 在工具边界注入超时，并另跑一次数据 seam 的空结果；两次都要按 [day-13.md](day-13.md) 的规则记录恢复后的外部判定。
