---
name: patent-claims-specification
description: |
  权利要求书与说明书模板（专利律师场景交付物）。将技术交底书转化为符合中国专利法
  及专利审查指南格式的权利要求书、说明书、摘要，支持内部审稿版与正式提交版切换。
triggers:
  - "权利要求书"
  - "说明书"
  - "专利申请文件"
  - "patent claims specification"
template:
  kind: patent-document
  mode: draft
  scenario: patent-drafting
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 权利要求书与说明书模板

将技术交底书转化为**符合中国专利法及专利审查指南格式的权利要求书、说明书与摘要**。本模板同时输出内部审稿版（带密级/免责声明）与正式提交版（去除内部标识）。

## 输入要求

渲染前必须已具备：

1. 技术交底书（技术领域、背景技术、发明内容、附图、实施例）。
2. 技术方案分解表（PFIE 四元组）与特征层级。
3. 现有技术检索结果（用于撰写背景技术和权利要求时避让）。
4. 附图清单（图号、图名、对应说明）。
5. 申请人信息、发明人信息（用于扉页）。

## 工作流

1. 读 `references/conventions.md`。
2. **用 `render_patent_document` 渲染**（`template: claims-spec`），把内容作为**受控草案 `draft`** 传入（结构化 JSON：著录项 `meta`（案卷号 `caseNumber`、发明名称、申请人、发明人、代理人、撰写日期）、不带项号的 `claims`、多段 `abstract`、按图序排列的 `figureFiles`、摘要附图号 `abstractFigure`（1 起，缺省第 1 幅）、按五部分组织的 `sections` 块序列——附图说明部分恰每幅附图一条列表项，条数须等于 `figureFiles` 项数，列表项**只写图名与描述文字**，不要写「图N为」前缀，也不要写句末「；/。」（两者都由渲染器生成）；块只有 paragraph/list/table 三种）。`权利要求书`/`说明书` 等分区标题留在模板里，权项编号、图号（「图N为……」）与表题（「表 N · 名称」）由渲染器从结构自动生成，模型不撰写 HTML。抬头编号行与页脚的案卷号取 `meta.caseNumber`。表格只允许放在具体实施方式。
   **不要手工复制 `assets/template.html` 另存再填**：模板的样式、品牌注入点与槽位 `id` 都由渲染引擎解释，手工复制再填会丢掉这些处理（含可选的段落编号声明）。
   渲染后再编辑产物以补模板没有的槽位（状态框、额外的信息行）是安全的。
3. 填充：案件信息（`meta`）→ 权利要求书（`claims`）→ 说明书五部分（`sections`，顺序固定：技术领域 → 背景技术 → 发明内容 → 附图说明 → 具体实施方式）→ 摘要（`abstract`/`abstractFigure`）→ 落款/页脚随 `meta.date` 自动注入。
4. 权利要求书采用层级递进：独立权利要求 → 从属权利要求；从属引用用「如权利要求 X 所述的……」；`claims` 每项**不带项号**，编号由渲染器自动生成。
5. 说明书五部分顺序固定：技术领域 → 背景技术 → 发明内容 → 附图说明 → 具体实施方式；正文（含要解决的技术问题、技术方案、有益效果、实施例）不加小标题，表格仅出现在具体实施方式。
6. **说明书默认不写段落编号**：法条与《专利审查指南》均未要求段落编号，模板默认不声明，渲染件因此不带编号；确需编号时按 `references/conventions.md` 第 7 节在模板上声明，不要手写编号。
7. 按 `references/checklist.md` 自查后定稿。

## 输出契约

```
文件：claims-spec.html（单文件、内联 CSS）
可选：claims-spec.pdf（A4 打印）
     claims-spec.md（源稿）

模式切换：
- 内部审稿版：默认渲染，保留抬头密级与免责声明。
- 正式提交版：渲染前覆盖 `--sati-doc-confidential` 为空字符串，并删除页脚 disclaimer 区块。
```

品牌变量由 `assets/templates/patent/tokens.css` 注入；agent 不修改样式。
