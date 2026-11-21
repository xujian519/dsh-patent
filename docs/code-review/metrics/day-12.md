# Day 12 — 直接调用（四）：畸形参数与观察基线

## 今日维度与范围

本日补直接调用层的鲁棒性一半：畸形参数、路径穿越、注入。口径在 [day-02.md](day-02.md)。fail-closed 指拒绝或返回带 `error.code` 的结构化错误，并且不写出越界路径。只有自然语言、没有 `error.code` 的拒绝记为不可解释，不记通过。注入若被当成字面量、没有越界写入，另记 contained，不并进畸形参数通过率。

对抗样本打在 15 个已调用工具上：`patent_case_search`、`patent_legal_status`、`patent_search`、`patent_wiki_search`、`law_verify`、`law_search`、`rule_check`、`domain_check`、`claim_lint`、`draft_claims`、`draft_specification`、`validate_specification`、`render_patent_document`、`build_patent_filing`、`verify_patent_filing`。不是 11 族的全部工具。

本日不调用模型，不用 snapshot 回放，不改 [daily/](../daily/)，不改 [pilot-questions.md](pilot-questions.md) 的冻结清单，也不把通过线写进 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md)。

## 检查项

- [x] 非法 JSON、类型错误、缺必填、超长、路径、注入都有会话里的 `tool/call` 与 `tool/result`。
- [x] 没有 `error.code` 的拒绝没有记成通过。
- [x] 注入的字面量处理记为 contained，没有并进通过率。
- [x] 通过线一节保持空白，并写明原因。
- [x] 当天不采样的样本表列留空。路径探针的残留是 0，记在对抗表，不回填到未采样的题面残留列。

## 样本表

对抗样本不是 20 道题面。题面表本日不新增采样列。

| 题号 | 族 | 层 | 可接受工具 | 实际工具 | 语法 | 语义 | 外部判定 | 拒绝或误拒 | 墙钟 | token 费用 | provider 费用 | 未使用 schema 字节 | 恢复 | 残留 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-RET-01 | 检索与法律状态 | 直接 | `patent_case_search` | | | | | | | | | | | |
| P-RET-02 | 检索与法律状态 | 直接 | `patent_legal_status` | | | | | | | | | | | |
| P-RET-03 | 检索与法律状态 | 直接 | `patent_search` | | | | | | | | | | | |
| P-RET-04 | 检索与法律状态 | 直接 | `patent_wiki_search` | | | | | | | | | | | |
| P-RET-05 | 检索与法律状态 | 未测 | 无 | | | | | | | | | | | |
| P-LAW-01 | 法条核验与规则 | 直接 | `law_verify` | | | | | | | | | | | |
| P-LAW-02 | 法条核验与规则 | 直接 | `law_search` | | | | | | | | | | | |
| P-LAW-03 | 法条核验与规则 | 直接 | `rule_check` | | | | | | | | | | | |
| P-LAW-04 | 法条核验与规则 | 直接 | `domain_check` | | | | | | | | | | | |
| P-LAW-05 | 法条核验与规则 | 未测 | 无 | | | | | | | | | | | |
| P-CLM-01 | 权利要求 | 直接 | `claim_lint` | | | | | | | | | | | |
| P-CLM-02 | 权利要求 | 未测 | `claim_chart_build` | | | | | | | | | | | |
| P-CLM-03 | 权利要求 | 直接 | `draft_claims` | | | | | | | | | | | |
| P-CLM-04 | 权利要求 | 未测 | `claim_chart_build` | | | | | | | | | | | |
| P-CLM-05 | 权利要求 | 未测 | 无 | | | | | | | | | | | |
| P-SPC-01 | 说明书与立案 | 直接 | `draft_specification` | | | | | | | | | | | |
| P-SPC-02 | 说明书与立案 | 直接 | `validate_specification` | | | | | | | | | | | |
| P-SPC-03 | 说明书与立案 | 直接 | `render_patent_document` | | | | | | | | | | | |
| P-SPC-04 | 说明书与立案 | 直接 | `build_patent_filing`、`verify_patent_filing` | | | | | | | | | | | |
| P-SPC-05 | 说明书与立案 | 未测 | 无 | | | | | | | | | | | |

## 对抗样本

| 类别 | 样本数 | 结果 | 记入 fail-closed 通过 |
|---|---|---|---|
| 非法 JSON，参数为 `{` | 15 | 全部 `syntax` 否、`isError` 真、`ToolArgsError` / `INVALID_ARGS`，文本是 arguments must be an object | 15 |
| 类型错误 | 15 | 全部 `INVALID_ARGS` | 15 |
| 缺必填，参数为 `{}` | 15 | 13 次 `INVALID_ARGS`。`law_verify` 语法通过后拒绝，无 `error.code`。`validate_specification` 语法通过且 `isError` 为假 | 13 |
| 超长 | 2 | `claim_lint` 与 `validate_specification` 的 schema 接受参数。正文在短句后重复「甲」8 万次。两次都返回未通过的校验报告，`isError` 为假，无新文件 | 0 |
| 路径 | 3 | 三次都没有写出越界路径，也都没有 `error.code` | 0 |
| 注入 | 4 | 见下。不并进上一列的通过数 | 不并进 |

缺必填的两个例外：

- `law_verify` 的 `text` 与 `references` 都不是 schema 必填（`packages/law/law-core/src/citation-tool.ts` 的 `citationVerifyParameters`）。空对象通过 schema 后，`LawVerifyToolError` 报「至少要给出 text 或 references 之一」。异常对象上的 code 是 `no_input`，会话里的 `tool/result.error` 为空。行为是拒绝，按日卡口径不可解释，不记通过。
- `validate_specification` 的 `text` 不是 schema 必填。空对象被当成一次校验，报告未通过，得分 0.65，error 写着说明书缺少所有必要章节（text 为空）。这是成功的工具结果，不是 `INVALID_ARGS`，不记畸形参数通过。

路径三条的工具文本：

- `render_patent_document` 仍死在「草案校验失败（16 项）」，没有走到输出路径，工作目录没有新文件。
- `build_patent_filing` 的输出目录是 `../p1-outside-probe`。文本是「输出目录 越出工作目录: "../p1-outside-probe" 解析为 /private/tmp/p1-outside-probe」。该目录没有创建。
- `verify_patent_filing` 的 docx 是 `/tmp/p1-outside-probe/missing.docx`。文本是「待验收文件不存在」。没有 `error.code`。

这三条都继承普通 `Error` 的 `PatentFilingError` 或 `DraftValidationError`。同 [F-CROSS-005](../05-findings.md)。

注入四条用的是无害字符串 `$(printf p1canary)` 与 `{{system}}`：

- `patent_case_search`、`law_verify`、`claim_lint` 把这些字符留在检索式或权利要求文本里，`isError` 为假，没有新文件。记 contained。
- `render_patent_document` 的输出名里夹了同一字符串，但仍先死在草案校验，无 `error.code`。不记 contained，也不记通过。

超长两条记 schema 无长度上限，处理停在校验报告内，无残留。这是 contained，不是 fail-closed 通过。

路径与注入扫描到的进程命令仍只有探测用的 `ps`。排除后子进程是 0，越界目录未创建。

## 观察基线

下列比例只描述 2026-11-21 这一次测量。题库未冻结，所以它们不是通过线。

| 项 | 观察 | 分母 |
|---|---|---|
| 参数语法 | 15/15 通过 | 已发起的题面调用。6 题未测，不在分母里 |
| 可解释性 | 14/15 | 同上。不可解释的是 P-SPC-03 |
| 子进程与越界目录残留 | 0 | 已发起的调用，排除探测用的 `ps`。6 题未测，样本表留空 |
| 非法 JSON 与类型错误 | 15/15 与 15/15 为 `INVALID_ARGS` | 各 15 个工具 |
| 缺必填 | 13/15 为 `INVALID_ARGS` | `law_verify` 拒绝但无 code；`validate_specification` 返回成功的校验结果 |
| 路径 | 0/3 记通过 | 三次都未写出越界路径，但都没有 `error.code` |
| 超长 | 0/2 记通过 | schema 接受，工具返回校验报告 |
| 注入 | 3 条 contained，1 条无 code | 不并进畸形参数通过率 |

P-RET-03 在 `limit` 为 5 时渲染出 10 条，见 [F-PAT-056](../05-findings.md)。这条是工具结果和题面外部判定的差，外部判定列仍留空。

冻结时要由人处理、本批不改题面的三处：

- P-SPC-03 的草案缺少 patentability-opinion 所要求的 16 个字段，工具按现有校验拒绝。
- P-LAW-02 的题面路径写有 `审查指南_md/`，本次 `sourcePath` 是 `审查指南/...`。
- P-RET-03 的题面外部判定是不超过 5 条，本次渲染是 10 条。

## 通过线

留空。

原因有两条，缺一不可。其一，[pilot-questions.md](pilot-questions.md) 的冻结清单还没有勾选，[day-08.md](day-08.md) 写明未冻结时不能出通过线。其二，[10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的待确认第 1 条要求通过线写在 metrics 记录里，不回填计划文件；在题库冻结并且人采纳上表之前，本文件也不填数字。

本阶段议题因此不能当作已经完成而关闭。

## 本日结论

直接调用记录已经齐：14 题 15 次会话事件，6 题未测，对抗样本 54 条。观察基线写在上表。通过线留空。两处代码缺陷是 [F-PAT-056](../05-findings.md) 与 [F-CROSS-005](../05-findings.md)，修复不在本批，[06-priority.md](../06-priority.md) 的顺序不改。

## 明日第一件事

D13 进入脚本场景之前，先由人冻结 20 题，并决定是否把上表采纳为通过线。未采纳前不把比例写进计划文件。
