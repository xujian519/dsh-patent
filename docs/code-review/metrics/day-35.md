# Day 35 — 脚本场景闭环

## 今日维度与范围

本日把 [extended-questions.md](extended-questions.md) 的 16 道可调用题改成两步脚本场景：第一次调用注入一个可预期的失败，第二次调用给出正确参数。目的是看工具在失败后能否被同一会话继续使用，以及失败前有没有写出半成品。

样本由 `/tmp/p4-questions-script.json` 固定，provider 只回放两次 `tool_use` 与一句收尾文本，不参与判断。场景覆盖附图 3、费用与期限 2、工作流与团队 2、文档交付 2、法律 3、视频 2、知识 2。本日不改 `daily/`、业务代码、依赖、CI 或基础设施配置。

## 样本表

| 场景 | 首调注入 | 首调结果 | 首调可解释 | 二调 | 闭环 |
|---|---|---|---|---|---|
| P4S-FIG-02 | 两张附图都用图号 1 | `figure_number 重复：1` | `PatentToolError` / `invalid_tool_input` | 通过 | 是 |
| P4S-FIG-03 | SVG 路径不存在 | `SVG 文件不存在` | `PatentToolError` / `file_not_found` | 通过 | 是 |
| P4S-FIG-04 | SVG 路径不存在 | `SVG 文件不存在` | `PatentToolError` / `file_not_found` | 通过 | 是 |
| P4S-FEE-01 | `claims: -1` | `claims 必须是非负整数` | 无 `error` 对象 | 通过 | 是 |
| P4S-FEE-02 | `filingDate: "2024-13-40"` | `CalendarDateError` | 无 `error` 对象 | 通过 | 是 |
| P4S-WF-02 | 缺 `name` | `missing required property "name"` | `ToolArgsError` / `INVALID_ARGS` | 通过 | 是 |
| P4S-WF-03 | 缺 `caseId` | `missing required property "caseId"` | `ToolArgsError` / `INVALID_ARGS` | 通过 | 是 |
| P4S-DOC-01 | 交付文件不存在 | `以下交付文件在工作区中不存在` | 无 `error` 对象 | 通过 | 是 |
| P4S-DOC-02 | 文件含残余占位符 | `确定性核验未通过` | 无 `error` 对象 | 通过 | 是 |
| P4S-LGL-02 | `text` 为空 | `text 不能为空白` | `LegalLawVerifyToolError` / `no_input` | 通过 | 是 |
| P4S-LGL-03 | 缺 `evidenceType` | `missing required property "evidenceType"` | `ToolArgsError` / `INVALID_ARGS` | 通过 | 是 |
| P4S-LGL-04 | `limit: 0` | 空结果说明，不是错误 | 无错误对象 | 仍为空结果 | 否（空库是有效状态） |
| P4S-VID-01 | `aspect: "99:1"` | `must be one of ["9:16","16:9","1:1"]` | `ToolArgsError` / `INVALID_ARGS` | 通过 | 是 |
| P4S-VID-02 | EDL `clips: []` | `expected array to have >=1 items` | `MediaFailure` / `MEDIA_EDL_INVALID` | 通过 | 是 |
| P4S-KNW-02 | 缺 `case_dir` | `missing required property "case_dir"` | `ToolArgsError` / `INVALID_ARGS` | 通过 | 是 |
| P4S-KNW-03 | 标题为空 | `笔记跳过（title 与 content 均不能为空）` | 无错误对象，`isError` 为假 | 通过 | 是（软跳过） |

## 读数

- 16 个场景里 15 个首调失败或跳过，1 个首调没有失败（LGL-04 的空库是有效状态）。
- 15 个首调失败或跳过的场景里，14 个在二调恢复；LGL-04 的二调仍是空结果，不能算恢复，也不能算失败。
- 首调失败后没有出现会话不可继续的情况：同一会话的第二次调用都进入工具层，没有重复初始化错误。
- 10 个首调失败带结构化 `name`/`code`；4 个只有文案（FEE-01、FEE-02、DOC-01、DOC-02），登记为 [F-CROSS-006](../05-findings.md#f-cross-006-patent_feespatent_deadlinesdocument_deliver-的预期失败仍抛普通-error失败事件没有-errorcode)；KNW-03 的软跳过没有错误对象。

## 场景明细

- 附图：图号重复在参数校验阶段被拦住，没有读取任何文件；两个缺失路径都在打开文件前失败，没有创建输出。二调分别得到冲突 1 处、缺图号 2、标注 2 个标号、量测 120×80 毫米。
- 费用与期限：负数权项与非法日期都在金额或日期计算前失败；二调给出 1330.00 CNY 与 5 项可计算期限。
- 团队与计划：缺 `name`、缺 `caseId` 由 schema 拦截，二调创建 `p4-team-demo` 与 `p4-flex-demo`。
- 文档交付：缺失文件与占位符都在登记前失败，没有留下交付记录；二调登记成功。
- 法律：空文本被 `no_input` 拦截；缺 `evidenceType` 由 schema 拦截；空库检索两次都返回同一句空结果说明。
- 视频：非法画幅由 schema 枚举拦截；空 EDL 在 ffmpeg 启动前被 `MEDIA_EDL_INVALID` 拒绝；二调写出 5150 字节 MP4。
- 知识：缺 `case_dir` 由 schema 拦截，日志未创建；空标题返回「笔记跳过」，二调写出 30 字符笔记。

## 未测

DOC-03 的 `office_convert` 不在工具面，不能构造脚本场景，本日不记入 16 个场景。应拒绝的 7 题只在真实模型层测量。

## 下一步

[day-36.md](day-36.md) 汇总注入恢复的分类、半成品检查与错误可解释性。
