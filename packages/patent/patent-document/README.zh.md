---
description: "函数插件，将 Sati 专利文书渲染器移植进 DeepSeek Harness：十三个随包分发的专利律师交付物中文 HTML 模板、品牌注入、经 ctx.subprocess 调用 Chrome headless 的 PDF 渲染、render_patent_document 工具（全部十三个模板已接入受控草案转换器），以及 verify_deliverable 交付件一致性核对。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-document

[English](README.md) | 中文

## 概述

函数插件，将 Sati 专利文书渲染器移植进 DeepSeek Harness：十三个随包分发的专利律师交付物中文 HTML 模板、品牌注入、经 ctx.subprocess 调用 Chrome headless 的 PDF 渲染、render_patent_document 工具（全部十三个模板已接入受控草案转换器），以及 verify_deliverable 交付件一致性核对。

## 目录

- [render_patent_document 工具](#render_patent_document-tool)
- [受控草案](#controlled-drafts)
- [verify_deliverable 工具](#verify_deliverable-tool)
- [文档引擎（库 API）](#document-engine-library-api)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="render_patent_document-tool"></a>
## render_patent_document 工具

claims-spec 申请文件传受控草案（`draft` 参数，由 `dsh-patent-core` 的 `validateSpecDraft` 校验）：著录项 `meta`、不带项号的 `claims`、多段 `abstract`、`figureFiles`、摘要附图号（`abstractFigure`，缺省 1），以及按五部分组织的 `paragraph`/`list`/`table` 块——附图说明部分恰每幅附图一条列表项（条数须等于 `figureFiles` 项数）；每项只写图名与描述文字，不含图号前缀与句末标点，因为渲染器会补上「图N为」与 `。`/`；` 分隔。`draftConverter` 模块按该结构生成全部标题、权项项号、图号（`图N为……`）与表题（`表 N · 名称`，全文档连续编号）并转义全部模型文本，因此合法渲染不会携带模型撰写的标记；表格只允许出现在具体实施方式。槽位只替换自身元素的内容：两个机制下分区标题与骨架包装都留在模板里，填空正文容器不会吞掉标题，被省略的可选槽位也不贡献任何文本。两个表单模板（right-evaluation-report 与 search-report-form）改传表单草案（`validateTemplateDraft` + `draftSchema` 注册表）：`fields` 文本槽填充 `.fill` 值位（同一 id 可出现多处，如检索人在抬头与落款各一处），`choice` 选项槽按选项 id 渲染 `.cb` 勾选状态（模板中复选框带 `data-slot="<组>:<选项>"`，多选组传 id 数组），`sections` 支持 `blocks`（paragraph/list，每段或每项克隆一行，多余模板空行自动移除）与 `rows`（等宽字符串数组按行数克隆表单数据行，如六列的相关文件表）。其余十个文档模板（patentability-opinion、search-report、oa-response、invalidation-opinion、invalidation-analysis、invalidation-defense、rectification-response、re-examination-request、infringement-opinion、litigation-pleading）传 id 键控草案：`fields` 填叶级文本槽（meta 与页脚 id），`sections` 传 `blocks`（paragraph/list/table，表题自动生成且全文档连续编号）、`rows`（等宽字符串数组，按各表体占位行克隆）或 `grounds`（无效理由项——`article`、`ground`、`claimNos`、`facts`、`evidence`、`conclusion`；节标题 `4.N 权利要求 …不具备…（法条）` 与四段式小标题由这些字段生成）。`invalidation-opinion` 出对外请求书，`invalidation-analysis` 出内部无效分析意见（可载引用日志、结论分档与缺口披露），`invalidation-defense` 出被请求人（专利权人）侧的对外意见陈述书——它的逐项答辩节与请求人侧共用同一理由节骨架，关系词换成模板自己的「的」（写「权利要求 1 的创造性」而不是「权利要求 1 不具备创造性」）。全部模板都要求受控草案；旧的 `sections` innerHTML 参数已删除，传它的调用会被参数校验拒绝。

render_patent_document 将十三个随包模板之一（patentability-opinion、search-report、oa-response、claims-spec、invalidation-opinion、invalidation-analysis、invalidation-defense、rectification-response、re-examination-request、infringement-opinion、litigation-pleading、right-evaluation-report 或 search-report-form）渲染为 HTML 文件，默认同时生成 PDF。选定一个模板 id 与 outputName，再传受控草案（结构见下）；sections 旧参数已删除，传它的调用会被参数校验拒绝。结果以模型可读文本返回写出的 htmlPath、pdfPath、可能的 pdfError 与 warnings；当 PDF 失败时，HTML 仍然存在。

渲染器还会检查装配后的文书，把每处发现写进 `warnings`：`一、` 式编号出现在章节级标题之外的层级（章节层级取文档中第一个带编号的标题所在层级，随包模板中带该编号的都用 `h2`，因此带编号的 `h3` 或 `h4` 会与骨架冲突）、章节编号重复、章节编号未按递增顺序、标题使用内部工作记录用语、以及正文含内部工作记录用语（成功概率分档、缺口汇总、待办、`source_path` 一类内部数据键）。证据编号与证据清单还须相互覆盖：正文在清单表之外引用的编号必须已登记，清单登记的编号必须在正文被引用过，编号单元格未填的行单独报出。编号形态取自清单自身的编号列（`D1` 的 `D`、`对比文件1` 的 `对比文件`），因此专利号与附图标记不会被当成编号；`D1–D4` 一类区间按逐个编号展开，编号列写成纯数字的清单只报未填的行。草案槽位只替换槽位元素的内层内容：骨架包装与其章节标题保持原位，标题、编号与表题都由转换器在槽位内生成。渲染器所检查的规则与两张用语表在 `document/documentCompliance.ts`；`scripts/verify-patent-document-output.ts` 对产出的文件或随包模板样例离线施加同样的检查。内部工作记录属于清单 `internalRecords` 列出的模板（`invalidation-analysis`），这类模板跳过内部工作记录检查，证据编号核对在两种范围都做；渲染器按 `input.template` 取检查范围，离线门禁按文书所在模板目录取。检查只报告不拒绝，因此带发现的文书仍会交到调用方。

模板可用 `data-paragraph-numbering` 在某个容器上声明段落编号，属性值即编号形态（`[0001]` 表示方括号、四位、左补零）。《专利法》《专利法实施细则》与《专利审查指南》均未要求段落编号，因此 claims-spec 的说明书节默认不带该声明；提交体例使用编号时自行加到相应节上，该节内每个 `<p>` 与 `<li>` 就会被写入字面的 `[0001]`、`[0002]`……编号，从 1 起连续；标题、表格内容与只有图片的段落不编号。编号写成字面文本而非 CSS 计数器，是为了让 PDF 与下游的 HTML→docx 转制读到同一串字符。既有编号会先被剥掉再重写，因此重复渲染幂等，手写的编号也不会叠加——请勿手写编号。

<a id="controlled-drafts"></a>
## 受控草案

`renderSpecDraftSections(draft)` 把校验过的 `SpecDraft` 转换为渲染器注入的 id → innerHTML 映射：`meta-*` 槽位与页脚槽位（`footer-date`、`footer-case`）接收转义后的著录项文本；`claims-body`（权利要求书正文容器，分区标题 `权利要求书` 留在模板里）每项生成一个 `.claim-item` 并自动连续编号；`specification-body`（说明书正文容器，分区标题 `说明书` 留在模板里）按 `SPEC_PART_HEADINGS` 顺序生成五个 `h3` 部分，附图说明列表项改写为「图N为……」，具体实施方式的表格带「表 N · 名称」表题；`abstract` 生成 `.abstract-box`，每段一个 `<p>` 并附 `abstractFigure` 行（缺省 `1`）。两个表单模板（right-evaluation-report、search-report-form）改传表单草案（`validateTemplateDraft` + `draftSchema` 注册表校验）：`fields` 文本槽填充 `.fill` 值位（同一 id 可出现多处，如检索人在抬头与落款各一处，全部填充同一值）；`choice` 选项槽按选项 id 渲染 `.cb` 勾选状态（模板中复选框带 `data-slot="<组>:<选项>"`，多选组传 id 数组）；`sections` 支持 `blocks`（paragraph/list 每段或每项克隆一行，多余模板空行自动移除）与 `rows`（等宽字符串数组按行数克隆表单数据行，如六列的相关文件表）。`injectTemplateDraft(html, template, draft)` 直接填充 `data-slot` 属性，成品不携带任何 `data-slot` 标记。每个表单模板随附 `references/slots.md` 槽位清单（注册表的事实源）、`assets/example-draft.json` 示例草案与由它渲染的 `example.html`；`tests/draft-schema-conformance.spec.ts` 把注册表与模板中的每个 `data-slot` 机械锁定。10 个文档模板由同一一致性测试锁定：模板中每个元素 id 要么是注册槽位、要么是 staticElements 登记的包装元素，rows 槽位列数与各表占位行单元格数一致。它们的抬头编号行（`doc-number`）与页脚编号（`footer-case`）同样是必填槽位，因此成品里不会出现模板自造的编号。槽位只替换自身元素的内容，两个机制下分区标题与骨架包装都留在模板里（填空正文容器不会连标题一起吞掉），被省略的可选槽位不向成品贡献任何文本；草案里的附图说明部分恰每幅附图一条列表项，条数须等于 `figureFiles` 项数。渲染管线会拒绝：claims-spec 之外的模板传 SpecDraft、claims-spec 传 templateDraft、draft 与 templateDraft 同传；工具调用一律要求 draft。

<a id="verify_deliverable-tool"></a>
## verify_deliverable 工具

verify_deliverable 判定一次交付是不是案卷主路径所呈现的那一版。传入 artifacts（每组给一个角色、案卷主路径 `canonical_path` 与交付版 `delivered_path`），可另传 figures 与 rendered。每组逐字节比对，rendered 与本次读到的全部输入件按修改时间排序。每个路径必须是普通文件且不超过 64 MiB：目录、设备、管道或超限文件按违规项报告，不会被读取。返回 passed、manifest（角色 + 路径 + SHA-256 + mtime）与违规项：`artifact_mismatch` 表示读者打开案卷主路径看到的是被取代的旧版，`render_order` 表示渲染件早于它呈现的某个输入件。可选 requirements（每条给指令原话与证据文件路径）把本工具变成交付验收的**要求核对表**：要求没有证据、或证据文件不存在即判未通过，返回结果按条给出 requirement/evidence/satisfied，交付报告直接引用它，不用「已按要求复核」这类概括句。

<a id="document-engine-library-api"></a>
## 文档引擎（库 API）

包重新导出移植的引擎供直接调用方使用：renderPatentDocument、renderPdf、findChrome、buildBrandStyle、mergeBrand、loadBrandFromPath、readTemplateManifest、resolveTemplate、readTemplateHtml、getTemplateRoot 与 DocumentRenderError。这些是无需密钥的纯函数；不会有任何东西自动挂载它们。

<a id="configuration"></a>
## 配置

Schemastery 配置，所有字段均可选。

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| chromePath | string | 无 | 用于 PDF 的 Chrome 可执行文件绝对路径；覆盖 DSH_CHROME_PATH/CHROME_PATH 探测。 |
| outputRoot | string | .dsh/documents | 既未给出 outputDir 也未给出 caseId 时的默认输出目录（相对进程工作目录）。 |
| pdfTimeoutMs | number | 120000 | 单次 headless Chrome 打印的超时；部署较慢时可上调，而 SIGTERM->SIGKILL 宽限（3 秒）与单流输出上限（100000 字节）保持固定，分别是收尾对称与内存边界。 |

<a id="model-experience"></a>
## 模型体验

<a id="render_patent_document-tool"></a>
### render_patent_document 工具

#### 模型看到的内容

一个名为 `render_patent_document` 的已注册工具，含必需的 `template` 枚举（十三个 id：`patentability-opinion`、`search-report`、`oa-response`、`claims-spec`、`invalidation-opinion`、`invalidation-analysis`、`invalidation-defense`、`rectification-response`、`re-examination-request`、`infringement-opinion`、`litigation-pleading`、`right-evaluation-report`、`search-report-form`）、必需的 `outputName`，必需的 `draft`，以及可选的 `caseId`、`outputDir`、`format`、`brand` 与 `brandPath`。结果以 Markdown 文本渲染，列出写出的 `htmlPath`、`pdfPath`、可能的 `pdfError` 与 `warnings`。

#### Token 影响

工具启用期间，每次请求承担固定定义成本；每次结果是几行简短的文件路径文本，仅在压缩前重发。

#### KV Cache 影响

只追加；新可见的结果文本接在可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

<a id="verify_deliverable-tool-model-experience"></a>
### verify_deliverable 工具

#### 模型看到的内容

一个名为 `verify_deliverable` 的已注册工具，含必需的 `artifacts` 数组（`role`、`canonical_path`、`delivered_path`）、可选的 `figures`、可选的 `rendered` 路径与可选的 `requirements`（`requirement` 用指令原话，另给 `evidence` 文件路径）。结果以 Markdown 文本渲染：一行通过/未通过标题、逐一列出文件名与 SHA-256、mtime 的交付清单、给出 requirements 时的逐条核对表，随后是各项违规与其建议。

#### Token 影响

工具启用期间，每次请求承担固定定义成本；每次结果为每个读到的文件一行清单。

#### KV Cache 影响

只追加；新可见的结果文本接在可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **不随包分发默认品牌 theme.json** — 移除了 Sati 的 products/_example/brand/theme.json 默认品牌回退；调用方必须显式传入 brand 或 brandPath，否则使用模板 tokens.css 中的默认值。
- **PDF 需要可探测的 Chrome** — headless PDF 打印经 ctx.subprocess 派生 Chrome（取代 Sati 的 execFile）；当探测不到 Chrome（或未设置 chromePath/DSH_CHROME_PATH）时，渲染降级为仅 HTML，结果携带 pdfError。
- **默认输出目录为 .dsh/documents** — 相对进程工作目录（取代 Sati 的 .sati/documents）；给定 caseId 时仍采用 data/cases/<caseId>/outputs 约定。
- **brandPath 读取 Sati 形态的 theme.json** — 加载器读取该文件的 documents.patent 命名空间；不支持其他主题 schema。
- **草案硬切换已完成** — 全部 13 个模板都要求 `draft`，旧 `sections` innerHTML 参数已删除，传它的调用会被参数校验拒绝。10 个文档模板走 id 键控草案：fields 填叶级文本槽（meta、footer 等），sections 传 blocks（paragraph/list/table 块，表题自动连续编号）或 rows（等宽字符串数组，按各表占位行克隆）。表单模板的页脚页码（逐页不同）、评价报告专用章与诉讼文书签名槽刻意不由草案驱动或非必填，定稿时人工处理。
- **无附图页与图片嵌入** — 模板只承载附图说明文字段，渲染出的文档不含附图图像，附图因此以调用方自行命名并随渲染文件一同交付的独立附件到达客户。
- **段落编号是可选体例且依赖渲染器** — `data-paragraph-numbering` 是声明而非标记，只有 render_patent_document 会解释它。《专利法》《专利法实施细则》与《专利审查指南》均未要求段落编号，因此 claims-spec 模板默认不声明；声明了编号的模板依赖渲染路径，且撰写方不得手写编号。

### 开发备注

无。

本包不发布 invariant 伴生组件：render_patent_document 将交付文件写入工作树，除常规 tools/result 日志外不写入包属持久会话事件；模板资产在解析时 fail-loud 校验。
