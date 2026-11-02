---
name: document-report
description: |
  长报告/手册管线：模板或自建 Markdown 源 → 单页 HTML 渲染（目录、页码、引用）→
  交付 md + html（含 docx），并按需提供 PDF 导出说明。面向多章节文档：报告、PRD、
  方案书、调研报告、手册、FAQ。
whenToUse: 需要交付多章节文档（报告、PRD、手册、FAQ、方案书）。
---

# 长报告管线

交付 `report.md`（源）与 `report.html`（渲染成品），两者内容一致；HTML 为
单文件自包含，带目录、章节锚点与页脚。需要 Word 版本时同源再出 `report.docx`。

## 流程

1. 读 brief；无则先跑 document-brief。
2. `list_doc_templates` 找匹配模板（检索报告/分析报告等）；有模板时用
   `render_doc_template` 生成骨架（传 `output_path` 落盘，结果只回路径与字节数），把模板变量填成真实内容；无模板时按下面的结构自建。
3. 写大纲：章节树（H1→H3 不超过三层）、每章一句话要点；用 ask_user_question 确认。
4. 按章撰写 Markdown：真实内容、事实附来源、代码/表格用规范语法。
5. 渲染 HTML：
   - 目录：生成于正文前，锚点跳转；
   - 章节：`<h2 id="...">` 锚点；表格、代码块、引用语义化；
   - 页脚：文档名 + 日期 + 版本；
   - 样式：文档排版基线（衬线正文/无衬线标题、1.6 行高、窄列 70ch）。
6. 自检（document-quality-gate）后交付：`report.md` + `report.html` 路径与摘要；
   登记时一并列出 docx（若有）。
7. PDF：若用户需要，说明可用浏览器打印或交付工作室的打印按钮导出。

## 硬性规则

- 事实性陈述必须带来源（URL / 文件路径 / 引文）。
- 目录与正文锚点一一对应；改大纲必须同步目录。自建 HTML 的锚点用显式 `id=`，
  不要依赖渲染器自动生成的标题 slug。
- HTML 中正文纯文本可被选中复制，不用图片代替文字段落。
