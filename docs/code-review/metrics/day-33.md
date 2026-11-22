# Day 33 — 直接调用（二）：文档交付、法律、视频、知识

## 今日维度与范围

本日完成 [extended-questions.md](extended-questions.md) 其余四族共 16 道可调用题的直接调用，并汇总本批 28 题的语法、参数语义、可解释性与畸形参数。测量环境与 [day-32.md](day-32.md) 相同：脚本化 provider、98 个工具、schema 合计 214,197 字节、题库当日冻结。本日不改 `daily/`、业务代码、依赖、CI 或基础设施配置。

## 样本表

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P4-DOC-01 | 文档交付 | 直接 | `document_deliver` | `document_deliver` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-DOC-02 | 文档交付 | 直接 | `document_deliver` | `document_deliver` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-DOC-03 | 文档交付 | 未测 | `office_convert` | `office_convert`（未声明） | 未测 | 未测 | 未测 | 未测 | | | | | | 0 |
| P4-DOC-04 | 文档交付 | 直接 | `document_deliver` | `document_deliver` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-LGL-01 | 法律检索与证据 | 直接 | `evaluate_evidence` | `evaluate_evidence` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-LGL-02 | 法律检索与证据 | 直接 | `legal_law_verify` | `legal_law_verify` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-LGL-03 | 法律检索与证据 | 直接 | `evaluate_legal_evidence` | `evaluate_legal_evidence` | 通过 | 是 | 否 | 无误拒 | | | | | | 0 |
| P4-LGL-04 | 法律检索与证据 | 直接 | `legal_knowledge_search` | `legal_knowledge_search` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-VID-01 | 视频 | 直接 | `video_project` | `video_project` | 通过 | 是 | 是 | 无误拒 | | | | | | `video/p4-init/project.json` |
| P4-VID-02 | 视频 | 直接 | `video_assemble` | `video_assemble` | 通过 | 是 | 是 | 无误拒 | | | | | | `video/p4-assemble/out.mp4` |
| P4-VID-03 | 视频 | 直接 | `media` | `media` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-VID-04 | 视频 | 直接 | `video_project` | `video_project` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-KNW-01 | 知识与分析 | 直接 | `parse_office_action` | `parse_office_action` | 通过 | 是 | 是 | 无误拒 | | | | | | 0 |
| P4-KNW-02 | 知识与分析 | 直接 | `matter_log_append` | `matter_log_append` | 通过 | 是 | 是 | 无误拒 | | | | | | `/tmp/p4-fixtures/case/_matter-log.md` |
| P4-KNW-03 | 知识与分析 | 直接 | `knowledge_note_save` | `knowledge_note_save` | 通过 | 是 | 是 | 无误拒 | | | | | | `99-知识库/c341233902183c18.json` |
| P4-KNW-04 | 知识与分析 | 直接 | `knowledge_note_save` | `knowledge_note_save` | 通过 | 是 | 是 | 无误拒 | | | | | | `99-知识库/572bc96f6fcd7e78.json` |

## 文档交付

- P4-DOC-01 登记 1 个文件，P0 6 项通过，确定性核验「通过」；没有写出新文件。
- P4-DOC-02 同样登记 1 个文件，附带 1 项 `length_budget` 提示：全文 60 字低于声明的 120 字预算（允许 96–144 字）。提示没有升级为阻断。
- P4-DOC-03 的 `office_convert` 未在 `request/header` 声明。调用返回 `ToolNotFoundError`、`code: UNKNOWN_TOOL`、文本 `unknown tool "office_convert"`；工具面证据完整，但闭环记未测，不记 0。
- P4-DOC-04 只登记与核验，轨迹里没有 office 工具。

## 法律检索与证据

- P4-LGL-01 返回综合 0.7，相关性 0.8、合法性 0.7、真实性 0.6；待外部输入 `EVI-002`（证据合法性审查）；问题列出 `claimRefs` 为空导致的关联性无法确认。
- P4-LGL-02 两条引用分别判「已核验／放行」与「条号超出有效范围／拦截」；拦截原因是《民法典》共 1260 条，不存在第 9999 条；结尾写明存在被拦截引用。
- P4-LGL-03 返回关联性 0.90、合法性 0.60、真实性 1.00、综合 0.84，并点名 `LEGAL-EVI-GEN-002` 证据收集合法性未确认。工具只在评分低于 0.5 时输出补强建议，本题 0.84 没有建议；题面要求「给出补强建议」，本项不成立。
- P4-LGL-04 返回空结果说明：本部署未命中，不能据此认定规范或案例不存在，并建议换用官方法源。轨迹没有 `law_search`。

## 视频

- P4-VID-01 写出 `video/p4-init/project.json`，0 镜头、0 渲染、预算 20.00 CNY、目标 15 秒、9:16。
- P4-VID-02 写出 `video/p4-assemble/out.mp4`，5150 字节、2.00 秒、320×240、`with audio`。没有音频片段时工具补静音轨，结果如实写「含音轨」。
- P4-VID-03 只做估算，返回 `35 CNY minor units` 与 `exact` 置信度，没有媒体文件或下载动作。
- P4-VID-04 读取放置好的 `video/p4-read/project.json`，返回标题「P4 只读项目」、画幅 16:9、1 个镜头，没有调用渲染或生成。

## 知识与分析

- P4-KNW-01 判驳回类型为创造性（专利法第22条第3款），影响权利要求 1、2、3；CN112345678A 标 X 类，CN109876543A 标 A 类。结果同时声明「权项为同句共现，非权威对应」。
- P4-KNW-02 两次调用分别写「建案」与「修订」条目；第二次条目含 `取代 说明书.md`，报告「本条之前已有 1 条结构化条目」，日志只追加。
- P4-KNW-03 写出 `99-知识库/c341233902183c18.json`，44 字符；P4-KNW-04 写出 `99-知识库/572bc96f6fcd7e78.json`，23 字符。两次都没有写案卷日志。

## 语法与畸形参数

成功的 28 次调用（27 道题，P4-KNW-02 两次）都通过 schema 校验，没有 `ToolArgsError`。DOC-03 的失败发生在工具查表，不在参数校验。

三次类型错误的探针都 fail-closed，结果为 `ToolArgsError`／`INVALID_ARGS`，没有落到业务逻辑：

- `check_patent_figure_consistency` 传非数组 `figures`：`"figures" must be an array`。
- `patent_deadlines` 缺 `claimsPriority` 且 `filingDate` 不是字符串：`missing required property "claimsPriority"; "filingDate" must be a string`。
- `patent_fees` 传字符串 `claims`：`"claims" must be a number`。

一次截断 JSON 的探针没有形成 `tool/call`：provider 层丢弃了不可解析的 tool_use，执行层未收到参数。该结果记为「未进入工具执行层」，不作为工具拒绝。

## 参数语义与可解释性

27 道实测题的必填参数都出现在调用参数里，语义列全为「是」。28 次调用的结果都带配对的 `tool/result`，错误对象有 `name` 与 `code`；DOC-03 的 `UNKNOWN_TOOL` 使工具不可用可被机器区分，不需要读人类文本。

`evaluate_evidence` 的输出把分数、等级、待外部输入与问题分节呈现，分数与问题能互相对照；`legal_law_verify` 把判定、处置、来源与结尾结论分开；`matter_log_append` 每次返回本条与已有条目计数。三者的结果都没有把待补项或未确认项写成已完成。

## 下一步

[day-34.md](day-34.md) 汇总 28 题的通过线、未测与判定差；脚本注入见 [day-35.md](day-35.md)。
