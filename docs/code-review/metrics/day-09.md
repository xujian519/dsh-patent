# Day 09 — 直接调用（一）：参数语法

## 今日维度与范围

本日对 [pilot-questions.md](pilot-questions.md) 的 20 道试点题做直接调用记录的第一项：参数语法。测量日是 2026-11-21。调用走带会话日志的工具执行，每次调用各自产生一对 `tool/call` 与 `tool/result`。没有模型步，因此没有 `request/header`；语法是否通过，看 `arguments` 能否解析为 JSON，以及结果是不是 `INVALID_ARGS`。`INVALID_ARGS` 来自执行前的 schema 校验。

本日不调用模型，不用 snapshot 回放，不改 [daily/](../daily/)，不改业务代码、依赖、CI 或基础设施配置。语义、外部判定、拒绝或误拒、墙钟、费用、未使用 schema 字节、恢复、残留都不是本日采样列，样本表里留空。

题库于 2026-11-21 按起草文本冻结。通过线写在 [day-12.md](day-12.md)，等于本次测量。

## 检查项

- [x] 14 道可直接调用题各有 `tool/call` 与配对的 `tool/result`。P-SPC-04 按题面加了一次 `verify_patent_filing`，共 15 次调用。
- [x] 6 题记未测，没有发起调用，所以没有这两类事件。
- [x] 15 次题面调用的 `arguments` 都是 JSON 对象，且结果不是 `INVALID_ARGS`。
- [x] 知识库与审查指南 wiki 本次可读；法律状态与专利检索走通了网络。这四题不记未测。
- [x] 未采样的列留空，没有填 0。

## 分母

直接调用分母按 [day-08.md](day-08.md)：14 题可以调用，6 题只在真实模型层测量。6 题是 P-CLM-02、P-CLM-04（`claim_chart_build` 内部调用模型）以及四道应拒绝题 P-RET-05、P-LAW-05、P-CLM-05、P-SPC-05。未测不记失败，也不记 0。

语法分子是题面参数通过 schema 的调用数，分母是这 15 次调用。6 道未测题不进入这个分母。

## 环境

工作目录是 `/tmp/p1-tool-metrics-cwd`。知识库解析到 `~/.dsh/knowledge/knowledge-lite.db`，wiki 解析到 `~/.dsh/knowledge/wiki`，两者都可读。检索结果来自本机库或 Google Patents（nuo）。没有调用模型，也没有把 snapshot 回放算进语法。

## 样本表

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-RET-01 | 检索与法律状态 | 直接 | `patent_case_search` | `patent_case_search` | 通过 | | | | | | | | | |
| P-RET-02 | 检索与法律状态 | 直接 | `patent_legal_status` | `patent_legal_status` | 通过 | | | | | | | | | |
| P-RET-03 | 检索与法律状态 | 直接 | `patent_search` | `patent_search` | 通过 | | | | | | | | | |
| P-RET-04 | 检索与法律状态 | 直接 | `patent_wiki_search` | `patent_wiki_search` | 通过 | | | | | | | | | |
| P-RET-05 | 检索与法律状态 | 未测 | 无 | 未测：应拒绝 | | | | | | | | | | |
| P-LAW-01 | 法条核验与规则 | 直接 | `law_verify` | `law_verify` | 通过 | | | | | | | | | |
| P-LAW-02 | 法条核验与规则 | 直接 | `law_search` | `law_search` | 通过 | | | | | | | | | |
| P-LAW-03 | 法条核验与规则 | 直接 | `rule_check` | `rule_check` | 通过 | | | | | | | | | |
| P-LAW-04 | 法条核验与规则 | 直接 | `domain_check` | `domain_check` | 通过 | | | | | | | | | |
| P-LAW-05 | 法条核验与规则 | 未测 | 无 | 未测：应拒绝 | | | | | | | | | | |
| P-CLM-01 | 权利要求 | 直接 | `claim_lint` | `claim_lint` | 通过 | | | | | | | | | |
| P-CLM-02 | 权利要求 | 未测 | `claim_chart_build` | 未测：工具内模型 | | | | | | | | | | |
| P-CLM-03 | 权利要求 | 直接 | `draft_claims` | `draft_claims` | 通过 | | | | | | | | | |
| P-CLM-04 | 权利要求 | 未测 | `claim_chart_build` | 未测：工具内模型 | | | | | | | | | | |
| P-CLM-05 | 权利要求 | 未测 | 无 | 未测：应拒绝 | | | | | | | | | | |
| P-SPC-01 | 说明书与立案 | 直接 | `draft_specification` | `draft_specification` | 通过 | | | | | | | | | |
| P-SPC-02 | 说明书与立案 | 直接 | `validate_specification` | `validate_specification` | 通过 | | | | | | | | | |
| P-SPC-03 | 说明书与立案 | 直接 | `render_patent_document` | `render_patent_document` | 通过 | | | | | | | | | |
| P-SPC-04 | 说明书与立案 | 直接 | `build_patent_filing`、`verify_patent_filing` | `build_patent_filing`；复核 `verify_patent_filing` | 通过（两次） | | | | | | | | | |
| P-SPC-05 | 说明书与立案 | 未测 | 无 | 未测：应拒绝 | | | | | | | | | | |

15 次调用的 `arguments` 都是字符串，配对的 `tool/result.sourceEventSeqs` 都指向同一次 `tool/call`。语法结果是 15/15 通过。P-SPC-03 的参数通过了 schema，随后草案校验失败；那是可解释性的失败，不是语法失败，见 [day-10.md](day-10.md)。

## 调用观察

下面只记工具文本里能读到的事实。外部判定不进直接调用分母，样本表的外部判定列留空。题面和工具文本不一致的四处随起草文本锁定，没有改题，见 [pilot-questions.md](pilot-questions.md)。

- P-RET-01 返回 2 条，检索通道写着 via fts，其中一条决定号是 20037。
- P-RET-02 返回 US2668287A，状态 Expired - Lifetime，到期日 1971-02-02，通道是 Google Patents（nuo 引擎）。
- P-RET-03 的参数 `limit` 是 5，渲染标题是 10 result(s)，通道是 Google Patents（nuo 引擎）。条数差记为 [F-PAT-056](../05-findings.md)。
- P-RET-04 返回 3 张卡片，路径在 `专利实务/说明书/` 下，查询词是充分公开。
- P-LAW-01 的渲染表有两行，都是已核验、放行：《专利法》第二十二条第三款，以及《专利审查指南》第二部分第四章 3.2.1.1。
- P-LAW-02 返回 3 条。第一条 `sourcePath` 是 `审查指南/第二部分-实质审查/第二章-说明书和权利要求书/审查-权利要求-说明书依据.md`，时间效力写着未核验（缺少施行/失效时间）。文本里没有题面写的 `审查指南_md/`。
- P-LAW-03 报告 11 条违规，其中有 MECH-INV-001。
- P-LAW-04 的清单是 30 项：自动化 5 项全部通过、命中 0，人工 25 项；0 项 error、1 项 warning，工具文本写通过。
- P-CLM-01 报告 4 项，1 项 error（权利要求 4 的 antecedent-basis，「所述气隙」没有在先引入），2 项 warning，未通过。
- P-CLM-03 渲染出 1 项独立权利要求和 2 项从属权利要求，文本里没有 error。
- P-SPC-01 完整度写完整，五个部分都在，摘要含「关键词：检测装置」。
- P-SPC-02 未通过，error 含「缺少必要章节：背景技术、发明内容、具体实施方式」。
- P-SPC-03 参数语法通过，执行结果是错误「草案校验失败（16 项）」，列出的是 patentability-opinion 缺少的字段。`tool/result.error` 为空。
- P-SPC-04 的 `build_patent_filing` 写出 `.dsh/documents/pilot-filing.docx`，文本写断言全部通过（分节 3、权项 1、附图 0）。随后的 `verify_patent_filing` 也写断言全部通过。这个 docx 是交付物，残留见 [day-11.md](day-11.md)。

## 本日结论

语法观察值是 15/15。6 题保持未测。这个比例还不是通过线。

## 明日第一件事

Day 10 用同一次调用的会话事件判定可解释性：配对、失败时的 `error.code`、`arguments` 仍是字符串。
