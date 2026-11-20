# Day 10 — 直接调用（二）：可解释性

## 今日维度与范围

本日用 [day-09.md](day-09.md) 同一次直接调用的会话事件判定可解释性。口径在 [day-02.md](day-02.md)：每次 `tool/call` 有配对的 `tool/result`，失败时有 `error.code`，`arguments` 仍是原始字符串。三个条件都成立才算可解释。成功结果没有 `error` 字段是正常的，不算缺口。

本日不新增调用，不调用模型，不用 snapshot 回放。样本表里本日没有别的采样列，那些列留空。

## 检查项

- [x] 15 次调用都配对，`sourceEventSeqs` 指向同一次 `tool/call`，`arguments` 都是字符串。
- [x] 唯一的题面失败是 P-SPC-03。`isError` 为真，`tool/result.error` 为空，记为不可解释。
- [x] 可解释的调用是 14/15。这个比例是观察值，不是通过线。
- [x] 失败没有 `error.code` 的原因写入 [F-CROSS-005](../05-findings.md)。不改 [06-priority.md](../06-priority.md) 的顺序。

## 样本表

可解释性不是样本表的一列。下表只重复题号，测量列留空；判定见后面的调用表。

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

## 调用表

| 题号 | 工具 | 配对 | arguments 为字符串 | 失败 | error.code | 可解释 |
|---|---|---|---|---|---|---|
| P-RET-01 | `patent_case_search` | 是 | 是 | 否 | 不适用 | 是 |
| P-RET-02 | `patent_legal_status` | 是 | 是 | 否 | 不适用 | 是 |
| P-RET-03 | `patent_search` | 是 | 是 | 否 | 不适用 | 是 |
| P-RET-04 | `patent_wiki_search` | 是 | 是 | 否 | 不适用 | 是 |
| P-LAW-01 | `law_verify` | 是 | 是 | 否 | 不适用 | 是 |
| P-LAW-02 | `law_search` | 是 | 是 | 否 | 不适用 | 是 |
| P-LAW-03 | `rule_check` | 是 | 是 | 否 | 不适用 | 是 |
| P-LAW-04 | `domain_check` | 是 | 是 | 否 | 不适用 | 是 |
| P-CLM-01 | `claim_lint` | 是 | 是 | 否 | 不适用 | 是 |
| P-CLM-03 | `draft_claims` | 是 | 是 | 否 | 不适用 | 是 |
| P-SPC-01 | `draft_specification` | 是 | 是 | 否 | 不适用 | 是 |
| P-SPC-02 | `validate_specification` | 是 | 是 | 否 | 不适用 | 是 |
| P-SPC-03 | `render_patent_document` | 是 | 是 | 是 | 缺失 | 否 |
| P-SPC-04 | `build_patent_filing` | 是 | 是 | 否 | 不适用 | 是 |
| P-SPC-04 | `verify_patent_filing` | 是 | 是 | 否 | 不适用 | 是 |

P-SPC-03 的工具文本以 `Error: 草案校验失败（16 项）` 开头，列出 patentability-opinion 缺少的 `fields.*` 与 `sections.*`。会话事件里 `isError` 为真，`error` 为空。抛出的是 `DraftValidationError`（`packages/patent/patent-core/src/draft/validate.ts`），它继承 `Error`，没有 `code`。题面草案本身不满足该模板，这是题库和工具要求之间的差；会话里没有 `error.code` 则另记 [F-CROSS-005](../05-findings.md)。

6 道未测题没有调用，不进入 14/15 的分母。

## 本日结论

可解释性的观察值是 14/15。成功调用都满足三条。唯一不可解释的是 P-SPC-03 的草案校验失败。

## 明日第一件事

Day 11 记残留：任务结束后的子进程和临时目录。成品 docx 与探测进程本身不记成残留，也不把残留平均进利用率。
