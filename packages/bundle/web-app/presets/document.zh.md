# 文档模式 preset（文档智能体）

[English](document.md) | 中文

`document` agent preset 在 DeepSeek Harness 上组装一个文档交付智能体。本 bundle 在 `presets/document.patch.yml` 中声明它，其六个交付技能随附在 `skills/document/` 下。它基于 `standard` preset，替换了 persona 与计划模式章节为文档交付版，并挂载一个隔离的 OpenDesign 技能源——当存在 OpenDesign checkout 时，为智能体提供完整的渲染模板与设计技能库。

## 挂载内容

在文档工作流所需的标准编码行（shell、filesystem、jobs、提醒、skills、goals 与 `/goal` 命令、plan mode、compaction、delegation、ask-user、todo、web，以及给出当前日期的时钟行）之外，本 preset 贡献：

- **六个交付技能**（`skills/document/`）：`document-brief`（需求→交付规范）、`document-html`（单文件 HTML 工件）、`document-report`（长报告：Markdown → HTML → 可 PDF）、`document-deck`（HTML Deck + 可选 PPTX）、`document-word`（先从模板生成 `.docx`，模板不覆盖的排版再交 officecli）、`document-quality-gate`（P0/P1 交付前检查清单 + 工具侧确定性核验）。
- **OpenDesign 技能源**：第二个 `skill-filesystem` 实例（名为 `open-design`），当 `OPEN_DESIGN_DIR` 设置时挂载 checkout 的 `skills/` 与 `design-templates/` 目录——与 `examples/opendesign` 相同的接线，已内建。未设置该变量时以零根注册（显式空目录），preset 可独立工作。
- **结构化交付登记**：`document_deliver` 工具把交付文件、导出格式与模型自己的 P0/P1 质量门自述记录进会话日志，并自行读取每个交付文件、在结果里给出确定性核验结论（残余占位符、未声明锚点、空章节、风格禁用词、声明字数预算）；阻断级问题直接拒绝登记，P0/P1 自述只记录、不核验。[交付工作室](../../../client/ui-document-studio/README.zh.md)据此从日志条目与结果元数据推导文件列表、质量门徽标与机器核验徽标——变更工具之外产出的二进制产物（经 officecli 的 `.docx`/`.pptx`、打印动作的 PDF）经登记后也能出现在工作室。
- **文档模板与样式行**：`doc-template` 基于随包模板资产注册 `list_doc_templates` 与 `render_doc_template`，并把 `assistant-neutral` 书写风格指南（`styleGuide`）注入为系统提示段落——与 `document_deliver` 核验所用的是同一份风格，因此"被告知要避开的词"与"门禁会检查的词"是同一张表。
- **文档交付 persona**（身份、六条作业纪律、标准作业流程、工具与技能四节）与文档版计划模式章节：交付规范、大纲、模板选择、导出清单都属于"计划"——获批前不生成任何对外交付文件。

相对 `standard` 携带的行集，本 preset 有意省略四行——`tool-plugin-market`、`present`、`tool-plugin-manager` 与 `openviking`。`tool-plugin-market` 是只读的插件目录浏览；安装或卸载插件是通过 `dsh plugin` CLI 执行的部署动作，不属于产出文档的步骤。`present` 把任意可读文件声明为客户端交付物，而本模式通过 `document_deliver` 声明交付物（工作室渲染的确定性核验结论就挂在它上面），另开一条声明通道会把这份状态拆成两处。`tool-plugin-manager` 写 profile 配置，宿主 patch 本就默认禁用它；文档交付没有编辑 profile 的步骤。`openviking` 是指向本组合不运行的外部记忆 HTTP 服务：文档交付以用户提供的文件与来源为依据，不依赖召回的历史会话。`scripts/preset-mode-baseline.json` 逐条记下理由，并把每个交付型模式扣在同一份共享行集上。

## 技能

`skills/document/` 下六个技能构成一条管线：`document-brief` → 大纲 → `document-html` / `document-report` / `document-deck` / `document-word` → `document-quality-gate` → 交付。

- `document-brief` — 捕获目标、受众、格式、设计系统、成功标准与约束，写入 `brief.md`；是其余所有技能的输入契约。
- `document-html` — 单文件 `index.html` 管线；优先使用 OpenDesign 渲染模板（web-prototype / saas-landing / dashboard），否则用内置基线。
- `document-report` — `report.md` 源 + `report.html` 渲染（目录、锚点、页脚）。
- `document-deck` — `deck.html` 横向滑动 Deck，杂志版式；officecli 可用时生成 `.pptx`。
- `document-word` — 用 `render_doc_template`（format 为 `docx`）生成 `.docx`：`output_path` 必填，由工具直接落盘，结果只回路径与字节数、不再重复包内容；页眉页脚、页码、目录字段继续用 officecli 加工同一文件。
- `document-quality-gate` — P0 与 P1 检查清单：命名、自包含、无占位残留、断链、事实来源、可访问性、移动端重排、篇幅预算；另附工具侧确定性核验表，命中阻断项时登记会被拒绝。「P0 不过不交付」是智能体自己的作业纪律：工具只把 P0/P1 自述与机器核验结论并列记录，不核验这份自述。

## 前提

无硬性依赖，preset 可独立完整工作。如需 OpenDesign 增强，克隆 OpenDesign 并导出其根目录：

```sh
git clone https://github.com/nexu-io/open-design.git
export OPEN_DESIGN_DIR="$PWD/open-design"
```

此时 `open-design` 技能源会把该 checkout 的 276 个技能/模板目录纳入目录（已对 open-design main 0.20.3 实测）。`document-word` 另受益于用户级 `officecli` 技能；缺失时智能体会交付 Markdown 并说明。

## 模型体验

模型看到中文文档交付 persona（四节：身份、作业纪律、标准作业流程、工具与技能；其中六条作业纪律是交付物即文件、无来源即撤回、不发明品牌、自包含输出、强制 HITL 确认点、强制质量门）、文档版计划模式章节、六个内置技能及（挂载时的）OpenDesign 技能、以及标准编码工具。

## 已知限制与待办

- **PDF 是导出指引而非渲染器**——`document-report` / `document-html` 交付自包含 HTML；PDF 导出经交付工作室的打印按钮（桌面端 print-to-PDF 或浏览器打印）完成，不在 preset 内部。Host 另有 Office→PDF 转换（`office-to-pdf`），供侧栏 Office 预览使用，不面向交付。
- **`document-word` 需要本 preset 不挂载的 Office 技能**——随包的 `skill-office` 行由 desktop 宿主组合装配，Web bundle 没有装配，因此 Web 会话依赖用户级 `officecli` 技能；两者都缺时回退 Markdown 并说明。
- **OpenDesign 技能为可选**——未设置 `OPEN_DESIGN_DIR` 时使用内置基线模板，模板多样性降低但交付不被阻塞。
- **面板内不内联渲染二进制**——工作室对 `.docx`/`.pptx`/`.pdf` 只给「在侧栏预览」，交接给 `ui-sidebar-documentpreview`；面板自己只内联 Markdown 与 HTML。
- **`document_deliver` 只登记不转换**——工具仅校验声明的文件存在于会话工作区；PDF 导出或二进制转换仍需要相应管线步骤（打印动作 / officecli），工作区外保存的文件无法登记。
- **不设交付门，与专利模式不同**——专利模式在规则、法条与留档三次运行成功前拒绝渲染与成文工具；本 preset 完全不声明 `deliveryGate`，会话可以在交付物未登记的情况下结束。字节在 `document_deliver` 被调用之前就已写好，其后没有工具会被调用，因此没有「后置调用」可供前置条件去先行。后果、被否决的两条设计与工具实际保证的部分记在[工具包 README](../../../document/document-deliver/README.zh.md)。
