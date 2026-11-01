---
description: "面向 DeepSeek Harness 的申请文件出件：按随包模板（体例的唯一真相源）把 CNIPA 申请文件（摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图）成文为一件 DOCX，并对成品跑体例与内容断言。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-filing

[English](README.md) | 中文

## 概述

把一件 CNIPA 专利申请文件——说明书摘要、摘要附图、权利要求书、说明书、说明书附图——成文为一件 DOCX，并对成品跑断言。体例的唯一真相源是随包模板：字体、字号、行距、首行缩进、分节数与页眉都由模板反解，`style` 块与模板不一致会在成文之前失败。内容以结构化模型传入；段落编号按 spec 的节声明执行——声明 `paragraph` 时引擎先剥掉源稿编号再按自己的序号重写。

## 目录

- [build_patent_filing 工具](#build_patent_filing-tool)
- [草案映射](#draft-mapping)
- [verify_patent_filing 工具](#verify_patent_filing-tool)
- [随包资产](#filing-assets)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

-----

<a id="build_patent_filing-tool"></a>
## build_patent_filing 工具

build_patent_filing 接收受控 `draft`（与 `render_patent_document` 的 claims-spec 模板同一份 `SpecDraft`，由 `dsh-patent-core` 的 `validateSpecDraft` 校验）、`outputName`，以及可选的 `caseId`/`outputDir`，写出一件五节的 DOCX。结果返回成品路径、真正入文的位图、各节承载的段落与图片数、段落编号总数、从源稿读到并核对过的编号数、从模板反解出的体例，以及模板的 SHA-256。旧的 `content` 参数已删除：调用方再传它会在执行器参数校验处被「missing required property \"draft\"」拒绝。

五节即法定节序：说明书摘要、摘要附图、权利要求书、说明书、说明书附图。附图按 `draft.figureFiles` 给定的图序入文——第 1 张进摘要附图节，全部进说明书附图节且每图独占一页。`.svg` 源件先经 headless Chrome 栅格化，`.png`/`.jpg`/`.jpeg` 直接使用。

节标题、权项项号、附图说明图号与表题全部由草案结构生成、不由模型撰写：`contentFromDraft` 把五部分映射为法定 `h3` 标题、给权项加项号前缀、把附图说明列表项改写为「图N为……；/。」正文段，并在每个表格前生成「表 N · 名称」表题段——与 HTML 通道同一算法，两通道成文不可能分叉。段落编号按 spec 的节声明处理：声明 `paragraph` 时引擎写入 `[0001]` 形态的编号、剥掉正文里残留的源稿编号，编号与段落顺序不一致会报错（表题段既不计数也不占号）；随包 spec 的说明书节声明 `none`——没有法条要求段落编号——引擎既不写也不剥，段落原样入文。

<a id="draft-mapping"></a>
## 草案映射

`contentFromDraft(draft)` 是确定性的 `SpecDraft` → `FilingContent` 桥：内容模型没有列表节点，一个 `list` 块落成逐项正文段；表题全文档连续编号（「表 N · 名称」），表题段在前、`table` 节点（首行表头）在后。`tests/from-draft.spec.ts` 里的一致性测试把同一份草案的权项项号、表题与附图说明图号与 HTML 通道 `renderSpecDraftSections` 的输出逐一对齐钉住。

无附图发明（《专利审查指南》第二部分第二章 2.3）传 `figureFiles: []` 与空的 `drawingDescriptions` 部分：`contentFromDraft` 省略「附图说明」标题，成文时删掉「摘要附图」「说明书附图」两个可选节，验收按三节成品核对并把「附图说明」视为可选标题。实用新型仍必须有附图；该要求由 `spec-check` 执行，不在本包。

<a id="verify_patent_filing-tool"></a>
## verify_patent_filing 工具

verify_patent_filing 接收一个 `docx` 路径，返回 `passed`、未通过的断言明细与实测摘要。它断言的是读者平时看不见、只有复核时才暴露的体例缺陷——分节数、各节页眉、行距、首行缩进（图片段与说明书名称行按顶格核对）、字号（含表格）、以及是否出现任何非黑色文字（标题落进 Word 内置样式就是这样现形的）——加上内容断言：说明书五部分齐备、说明书名称（spec 声明 `specification_title` 时：首行等于权利要求 1 的主题名称、左右居中、其后空一行）、每一节都承载了内容、至少 1 项权利要求、段落编号从 1 起连续（按 spec 的节声明生效——没有节声明编号时该断言无主体）、`待补案卷号`／`内部复核稿` 一类内部痕迹已清除。逐节断言抓的是「内容没落进那一节」：分节数、页眉与编号连续性在一份少了一节正文的成品上照样通过。它同时反解模板体例，模板漂移会被判为失败。

<a id="filing-assets"></a>
## 随包资产

三份资产随包分发在包根，源码与打包两种执行位置都用 `import.meta.url` 定位。桌面打包时资产留在 `app.asar` 之外（`apps/desktop` 的 `asarUnpack`）：引擎、模板与 spec 都由 Python 子进程经真实文件系统读取，因此解析落在并列的 `app.asar.unpacked/`；资产未解包则解析失败，而不是把子进程读不到的路径交出去：

| 资产 | 职责 |
|---|---|
| `assets/template/申请文件模板.docx` | 体例的唯一真相源。`assets/template/TEMPLATE-IDENTITY.md` 记录该文件的指纹与 `docProps` 部件的去标识化动作。 |
| `assets/spec/申请文件.json` | 文书契约：节序、编号口径，以及验收要跑的断言。它的 `style` 块是模板体例的投影，`numbering_pattern` 是成文写入与验收核对共用的那一份匹配式。 |
| `assets/engine/` | Python 引擎：`style.py` 反解体例、`build.py` 成文、`verify.py` 验收、`render_figures.py` 栅格化 SVG 源件。 |

改体例就改模板。部署若自带模板，必须连同 `specPath` 一起核对：`style` 块与模板不一致会中断成文——这道检查正是本包存在的理由，用另一份模板悄悄排版出来的成品才是要防的缺陷。节的 `kind`、来源键或附图下标与内容对不上时同样中断成文，理由一样：空掉的那一节照样满足分节数、页眉与编号。

<a id="configuration"></a>
## 配置

Schemastery 配置，全部字段可选。

| 键 | 类型 | 缺省 | 含义 |
| --- | --- | --- | --- |
| pythonPath | string | 自动探测 | Python 解释器绝对路径。探测顺序：本字段、`DSH_PYTHON_PATH`、`DSH_PRIMARY_RUNTIME`、Harness home（`DSH_HOME`，缺省 `~/.dsh`）下的随包运行时、`PATH`。配置了却不存在时在加载期失败，不回落；什么都探测不到的主机仍会挂上本插件，由每次工具调用报出缺解释器。 |
| chromePath | string | 自动探测 | `.svg` 栅格化用的 Chrome 可执行文件绝对路径；覆盖 `DSH_CHROME_PATH`/`CHROME_PATH` 探测。 |
| templatePath | string | 随包模板 | 模板绝对路径；体例的唯一真相源。 |
| specPath | string | 随包 spec | spec 绝对路径；换模板时必须一并核对。 |
| outputRoot | string | `.dsh/documents` | 既未给 `outputDir` 也未给 `caseId` 时的输出目录（相对进程工作目录）。 |
| figureScale | number | 3 | 栅格化倍率，作用于附图自身的宽高。 |
| timeoutMs | number | 120000 | 单次引擎调用超时；SIGTERM→SIGKILL 宽限（3 秒）与单流输出上限固定不变。 |

引擎需要 `python-docx`，随包运行时载荷已带；解释器探测只判存在性、不预跑导入，因此应把它指向自带该库的解释器——第一次调用若撞上缺库的解释器，报错会点名是哪个解释器，而不是给一句看不出所以然的失败。`.svg` 栅格化需要可探测到的 Chrome，且只有 `figures` 里以 `.svg` 结尾的条目会走这条路。

<a id="model-experience"></a>
## 模型体验

<a id="build_patent_filing-tool-model-experience"></a>
### build_patent_filing 工具

#### What the model sees

一个名为 `build_patent_filing` 的注册工具，必填 `draft` 对象（共享的 `SpecDraft`：`meta`、不带项号的 `claims`、`abstract`、`figureFiles`、`abstractFigure`（哪幅附图进「摘要附图」节，缺省 1），以及按五部分组织的 `paragraph`/`list`/`table` 块（附图说明部分每幅附图一条列表项，每项只写图名与描述文字，不含图号前缀与句末标点））与 `outputName`，可选 `caseId` 与 `outputDir`。结果渲染为 Markdown 散文：成品路径、反解出的体例、各节段落与图片数、段落编号总数与其核对过的源稿编号、附图张数，以及截断的模板指纹。schema 本身见[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-patent-filing)。

#### Token effect

工具启用期间每个请求都有固定的定义成本；每次结果是约六行短文本，只在压缩之前重发。

#### KV Cache effect

追加式；新出现的结论文本跟在可复用的请求前缀之后，不会使既有 KV 缓存条目失效。

<a id="verify_patent_filing-tool-model-experience"></a>
### verify_patent_filing 工具

#### What the model sees

一个名为 `verify_patent_filing` 的注册工具，必填一个 `docx` 路径。结果渲染为 Markdown：通过/未通过的结论行、逐条未通过断言，然后是实测的分节数与页眉、段落/权项/编号/表格/附图计数、各节归属，以及截断的模板指纹。

#### Token effect

工具启用期间每个请求都有固定的定义成本；通过时结果只有几行，未通过时每个失败断言一行。

#### KV Cache effect

追加式；新出现的结论文本跟在可复用的请求前缀之后，不会使既有 KV 缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **附图以位图进入成品** — `.svg` 源件在入文前被栅格化，因此 DOCX 里是图片而非矢量图。改图后重跑成文即可；记录的模板指纹不覆盖附图源件。
- **复核稿 HTML 不是输入** — 上游 `claims-spec` 复核稿以结构化内容模型交付，交付方要交出内容而不是一个文件路径。刻意没做渲染 HTML 的导入器：迁移记录里的四个缺陷全部来自从该 HTML 里读元素结构。
- **不断言页数** — 验收比对的是体例参数、分节边界与内容；真实 Word 的分页受字体度量影响。LibreOffice 对同一份文件给出的页数明显不同，不能作仲裁。
- **开发机未在真实 Word 中打开过 DOCX** — 移植记录同样如此，当时的页数仲裁基准是 genoffice。
- **模板里没有表格，故表格字号无来源** — 随包模板不含表格，`table_size_pt` 是模板唯一无法反解的体例项；它在 spec 中声明，并由 `max_sizes_pt` 断言。
- **部署自带模板时必须连同 spec 一起复核** — 随包 spec 断言五个法定节与各节页眉；分节计划不同的模板会让成文失败，而不是自行适配。

### 开发备注

无。
