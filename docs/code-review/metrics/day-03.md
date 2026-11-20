# Day 03 — 族清单（一）：11 族与 67 个工具的目录核对

## 今日维度与范围

本日按 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的 D3–D4 核对 11 个工具族是否仍覆盖计划列出的 67 个工具。本日只读 [tool-catalog.md](../../tool-catalog.md) 与计划表，不改业务代码、依赖、CI 或基础设施配置，也不改 [daily/](../daily/)。

核对口径是模型可见名字：计划表里每个反引号名字必须能在目录里找到同名工具，且 11 族的数量相加等于 67。目录里的包名、实现路径和能力描述不参与这一步；那属于 D5–D8 的题面设计与 P1 的直接调用。

## 检查项

- [x] 从计划表提取 11 族与全部工具名，确认没有重复。
- [x] 从目录的 Tool Package Map 提取模型可见名字，逐个比对。
- [x] 按族与按包两个方向对平数量。
- [x] 记录缺失、重名与目录多出的同域工具。
- [x] 本日没有改业务代码、依赖、CI 或基础设施配置。

## 方法

计划表是 [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 的「工具族」表。目录表是 [tool-catalog.md](../../tool-catalog.md) 的 Tool Package Map；该表由 `scripts/gen-tool-catalog.ts` 从真实 boot 的 `ctx.tools.schemas()` 生成，不是手写清单。

核对用一段只读 Node 脚本：解析计划表的 `| 族 | 阶段 | 工具 |` 行，取每个反引号名字；解析目录表的 `| 工具包 | 模型可见名字 |` 行，取第二列的名字；再做集合差与重复检查。脚本不写文件，不启动插件，不调用模型。目录新鲜度另由 `pnpm run verify-tool-catalog` 校验，结果记在 [day-04.md](day-04.md)。

## 结果

计划表共 11 族、67 个工具；没有重复名字，67 个名字全部在目录里找到同名工具。

| 族 | 阶段 | 计划工具数 | 目录命中 | 缺失 |
|---|---|---:|---:|---|
| 检索与法律状态 | 试点 | 6 | 6 | 无 |
| 法条核验与规则 | 试点 | 5 | 5 | 无 |
| 权利要求 | 试点 | 3 | 3 | 无 |
| 说明书与立案 | 试点 | 6 | 6 | 无 |
| 附图 | 扩域 | 9 | 9 | 无 |
| 费用与期限 | 扩域 | 2 | 2 | 无 |
| 工作流与团队 | 扩域 | 17 | 17 | 无 |
| 文档交付 | 扩域 | 4 | 4 | 无 |
| 法律检索与证据 | 扩域 | 4 | 4 | 无 |
| 视频 | 扩域 | 4 | 4 | 无 |
| 知识与分析 | 扩域 | 7 | 7 | 无 |
| **合计** | — | **67** | **67** | **无** |

按包对平也能闭合。计划里的 67 个工具落在 13 个模型可见工具包上：

| 包 | 目录工具数 | 计划覆盖 | 说明 |
|---|---:|---:|---|
| `@deepseek-ai/dsh-patent-tools` | 37 | 37 | 检索、法条、规则、权利要求、说明书、附图、工作流、知识、分析 |
| `@deepseek-ai/dsh-patent-document` | 2 | 2 | `render_patent_document`、`verify_deliverable` |
| `@deepseek-ai/dsh-patent-filing` | 2 | 2 | `build_patent_filing`、`verify_patent_filing` |
| `@deepseek-ai/dsh-patent-deadline` | 1 | 1 | `patent_deadlines` |
| `@deepseek-ai/dsh-patent-fees` | 1 | 1 | `patent_fees` |
| `@deepseek-ai/dsh-patent-law` | 1 | 1 | `law_verify` |
| `@deepseek-ai/dsh-legal-law` | 1 | 1 | `legal_law_verify` |
| `@deepseek-ai/dsh-legal-evidence` | 1 | 1 | `evaluate_legal_evidence` |
| `@deepseek-ai/dsh-legal-knowledge/tool` | 1 | 1 | `legal_knowledge_search` |
| `@deepseek-ai/dsh-patent-teams` | 12 | 12 | 团队 12 个工具 |
| `@deepseek-ai/dsh-document-deliver` | 1 | 1 | `document_deliver` |
| `@deepseek-ai/dsh-tool-office` | 3 | 3 | `office_convert`、`office_recalculate`、`office_render` |
| `@deepseek-ai/dsh-video-mode` | 4 | 4 | `media`、`video_assemble`、`video_deliver`、`video_project` |
| **合计** | **67** | **67** | — |

`@deepseek-ai/dsh-patent-tools` 的 37 个名字与计划表完全一致；目录里该包也是 37 个。`evaluate_evidence` 在本包只出现一次，计划把它放在「法律检索与证据」族，数量仍然闭合。

## 族内抽查

试点四族的工具名与目录描述对得上：

- 检索与法律状态：`patent_search`、`patent_metadata`、`patent_legal_status`、`patent_case_search`、`patent_pdf_download`、`patent_wiki_search` 六个都在目录里；`patent_case_search` 与 `patent_wiki_search` 是两条不同的通道，前者查判例全文，后者查审查标准卡片。
- 法条核验与规则：`law_verify`、`law_search`、`rule_check`、`domain_check`、`patent_eval` 五个都在；`law_verify` 判引用，`law_search` 取原文，`rule_check` 跑单条规则，`domain_check` 跑领域清单，`patent_eval` 给评分。
- 权利要求：`claim_lint`、`claim_chart_build`、`draft_claims` 三个都在；`claim_lint` 是纯函数，`claim_chart_build` 内部有模型调用，`draft_claims` 是纯函数。这个差异会影响 P1 的直接调用口径，写在 [day-02.md](day-02.md)。
- 说明书与立案：`draft_specification`、`validate_specification`、`render_patent_document`、`verify_deliverable`、`build_patent_filing`、`verify_patent_filing` 六个都在。

扩域七族的名字也在目录里，没有需要改名的项。`patent_teams_*` 的 12 个名字一次列全，没有只写族名。

## 结论

11 族、67 个工具在当前 `docs/tool-catalog.md` 上全部命中，没有缺失、重名或改名。族清单可以继续作为 D5–D8 与 P1 的输入；本日不改计划表里的任何族名或工具名。

目录的同一域里还有 4 个模型可见工具不在计划表内：`triz`、`query_writing_patterns`、`list_doc_templates`、`render_doc_template`。它们不影响 67 个的闭合，但计划说「现有的 67 个工具」需要把范围口径写清楚；这一条留到 [day-04.md](day-04.md) 处理。

## 明日第一件事

Day 04 第一件事：核对 `pnpm run verify-tool-catalog` 的新鲜度，确认目录没有在计划写定后漂移；再把 4 个范围外工具写进计划的范围说明，避免下一轮把 71 当成 67。
