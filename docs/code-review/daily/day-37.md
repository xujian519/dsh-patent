# Day 37 — 2026-12-21

## 今日维度与范围

- 维度：E 正确性与边界
- 范围：专利域-4 与文档模式：patent-document、patent-filing、document 全域
- 时间盒：90 分钟
- 预期产出：E 维度文档域候选发现；daily/day-37.md

## 检查项

- [x] 检查渲染与格式断言。
- [x] 检查模板变量边界。
- [x] 检查 DOCX/OOXML 边界。
- [x] 检查交付记录一致性。
- [x] 附证据。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。H09 的旧数字不改。复现脚本 `d37-repro.mts` 放在仓库根（裸包名要从仓根 `node_modules` 解析）；`marked` 不是根依赖，脚本从 `doc-template/node_modules` 导入同一份实现。脚本未跟踪，跑完已删除。

**渲染与格式断言（25 分钟）**：读 `renderPatentDocument.ts`、`documentCompliance.ts`、`sectionFold.ts`、`paragraphNumbering.ts`、`htmlScan.ts` 与 `verify-deliverable.ts`。逐条核对合规规则：章节编号重复/乱序/层级、内部工作记录标题与正文用语、证据清单与正文引用双向覆盖、修改对照表与修改后独权全文对应、三张表空表；空节折叠只在模板显式标记 `data-omit-if-empty` 时发生，且只在确实折叠后重编号；段落编号先剥后写，重复渲染幂等；交付核对按主路径与交付版逐字节比 hash、按 mtime 判渲染晚于输入、按 requirements 逐条查证据。没有新的缺陷。`render_patent_document` 把合规问题作为 `warnings` 返回、仍写盘，这是工具契约的明示行为，作为观察记录，不单列。

**模板变量边界（20 分钟）**：读 `vars.ts`、`frontmatter.ts`、`store.ts`、`renderers/*` 与 `render-doc-template.ts`。必填、类型、默认值、残余占位符、HTML 变量转义与 `output_path` 的 `ctx.fs` 约束都与注释一致；未知变量被忽略但占位符会留在 `residual` 里，可见。发现 F-DOC-008（三种格式的标题数量不一致）。另观察到 HTML 渲染先转义变量再替换，`RenderOutcome.markdown` 因此带实体（`A &amp; B`），而 `content` 是正确的 HTML；字段注释称其为 Markdown 正文，属低度语义漂移，不单列。

**DOCX/OOXML 边界（25 分钟）**：读 `docx-kit` 的 `zip.ts`、`xml.ts`、`ooxml.ts`、`docx-read.ts`、`docx-write.ts`、`markdown.ts`。ZIP 侧的条目数、累计解压字节、CRC、ZIP64 拒绝与 stored/deflate 分支都 fail loud；XML 扫描覆盖注释、CDATA、处理指令、DOCTYPE 与实体；文本投影处理标题、表格、页眉页脚；写入侧转义五个 XML 字符并声明东亚字体。发现 F-DOC-009（表格转义竖线与破折号行）。`verify_patent_filing` 的 DOCX 读取仍无归档预算，是旧登记 R-87，本轮没有新证据，不另开编号。

**交付记录一致性（10 分钟）**：读 `verify-deliverable.ts` 与 `document-deliver/registration.ts`、`tool.ts`。交付清单记录交付版的 sha256 与 mtime，主路径不一致时两个短 hash 都进违规项；渲染件按 mtime 与全部输入件比较；requirements 的证据文件缺失即失败，同一路径只入清单一次。`document_deliver` 按扩展名决定读取器、`unreadable_ack` 按规范路径匹配、P0 稳定 id 缺失与未知项都会写入 warning。发现 F-DOC-010（HTML 占位符判定范围）。

**命令**：`pnpm exec tsx d37-repro.mts` 退出码 0。决定性结果：`prd` 模板的 Markdown 只有一行 `# {{product_name}} 产品需求文档`，HTML 有 2 个 `<h1>`，DOCX 投影出 2 条一级标题；`| A\|B |` 与 `| - | - |` 在 DOCX 解析里变成 3 列并丢掉破折号行，HTML 渲染保留 2 列 3 行；Markdown 围栏里的 `{{case_id}}` 是 `warn`，HTML 的 `<pre><code>`、`<code>`、注释与 `alt` 属性都是 `block`。

## 发现

F-DOC-008、F-DOC-009、F-DOC-010。

下面这些不够格单列：

1. R-87（`verify_patent_filing` 读取 DOCX 无归档与字节预算）仍是开放项：`verifyFiling` 只做 `existsSync`（`engine.ts:450`），Python 侧直接 `Document(str(docx_path))`（`verify.py:118`），没有条目数、累计解压字节或文件大小上限。旧登记已确认，本轮没有构造高压缩比样本，不另开编号。
2. `render_patent_document` 把合规问题（内部工作记录、空表、证据编号对不上）作为 `warnings` 返回并继续写盘；工具描述明示返回 warnings，交付门禁的职责在 F-PAT-017 已记录，不另开编号。
3. `doc-template` 的 HTML 渲染先把变量值转义再替换，`RenderOutcome.markdown` 因此是转义后的文本（变量 `A & B` 得到 `A &amp; B`），而 `content` 是正确的 HTML。字段注释称其为「resolved Markdown body」，属低度语义漂移。
4. `patent-filing` 的取消最终以 `PatentFilingError` 报出（消息带被终止的信号名），工具没有先调 `throwIfAborted`；这与 F-DOC-002 的 document-deliver 取消分类同形，不在本条重复。

## 假设验证/推翻

H01–H10 今日不改。H03 今天没有新的 Office 泄漏证据；`office-kit` 的取消与清理路径只读核对，未启动真实引擎。H05 没有新的外部输入到危险汇点证据；文书渲染对模型文本做 HTML/XML 转义，输出目录与品牌路径都走 `resolveConfinedPath`。H06 维持 Day 33 的部分推翻；今天的三条是 E 维度缺陷，不是测试缺口。H07 仍是 Day 7 的部分推翻；F-DOC-010 是门禁的误阻断（把引用文本当正文），方向与「未核验当通过」相反，不改变结论。H10 今天没有新增证据；`model-call-log.ts` 未改。H08、H09 维持原结论。

## 未决问题

1. 文档标题的单一真源应是模板 front-matter 的 `title`，还是正文第一行的一级标题？随包模板两者都有；F-DOC-008 的最小修复两个方向都能落地，需要产品定一个。
2. HTML 交付件里的代码示例与编辑注释，门禁应报 `warn` 还是继续 `block`？模块注释写的是 `warn`，但部署方可能希望 HTML 更严。
3. R-87 仍是 DOCX 读取边界唯一的开放项；`verify_patent_filing` 的归档预算与 `docx-kit`/`document-deliver` 对齐需要独立改动，本轮未做。

## 明日第一件事

Day 38（E 正确性与边界：法律模式与共享机制）第一件事：检查引用判定、效力与沿革、证据评分、检索上限与未核验语义，并附证据。F-PAT-032 至 F-PAT-055、F-DOC-001 至 F-DOC-010、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 和 Chrome。H09 的旧数字不要改。
