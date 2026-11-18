---
kind: upgrade-guide
description: "@deepseek-ai/dsh-doc-style、@deepseek-ai/dsh-doc-template 与 @deepseek-ai/dsh-client-ui-document-studio 不再导出无人引用的名字。"
---

# 文档包移除无人引用的导出与存储成员

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-doc-style` 不再导出 `systemPromptForTemplate`、`stylesForDomain` 与 `TemplateContext` 类型。入口仍导出 `systemPrompt`、`toRenderStyle`、`disclaimerFor`、`findStyleByName`、加载器与占位符助手。

`@deepseek-ai/dsh-doc-template` 不再导出 `VersionConflict` 类型，`TemplateStore` 也不再提供 `allTemplates`、`count`、`rendererRegistry`、`findByNameAndLanguage` 与 `listConflicts`。`list`、`findByName`、`languageOf` 与 `render` 保持不变，存储仍能回答消费方提出的每种查询。

`@deepseek-ai/dsh-client-ui-document-studio` 不再导出 `DELIVERABLE_EXTENSIONS`；`isDeliverablePath` 与 `parentDir` 保留。

从上述任一包导入被移除名字的调用方会受影响。本仓库内没有任何包导入这些名字。

## 迁移

1. 把 `systemPromptForTemplate(style, template)` 换成 `systemPrompt(style)`，并自行追加模板的名称、标题、分类以及 `disclaimerFor(style, template.category)`。
2. 把 `stylesForDomain(styles, domain)` 换成 `styles.filter(style => style.domain === domain)`；不再导入 `TemplateContext`，改用手上已有的名称、标题与分类字段。
3. 把 `store.findByNameAndLanguage(name, language)` 换成先调 `findByName`、再比较 `store.languageOf(template)`。读取已加载模板改用 `store.list()`，不再用 `allTemplates`；渲染格式改为构造 store 时传入，不再经 `rendererRegistry` 注册。
4. 把 `DELIVERABLE_EXTENSIONS` 换成 `isDeliverablePath(path)`；扩展名列表已成为该包的私有值。
5. 运行 `pnpm run typecheck`，或针对新包重新构建。被移除的名字会报为缺失导出。
