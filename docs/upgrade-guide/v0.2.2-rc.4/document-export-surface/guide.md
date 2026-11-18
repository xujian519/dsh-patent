---
kind: upgrade-guide
description: "@deepseek-ai/dsh-doc-style, @deepseek-ai/dsh-doc-template, and @deepseek-ai/dsh-client-ui-document-studio stop exporting names no consumer imported."
---

# Document packages drop exports and store members no consumer imports

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-doc-style` no longer exports `systemPromptForTemplate`, `stylesForDomain`, or the `TemplateContext` type. The entry keeps `systemPrompt`, `toRenderStyle`, `disclaimerFor`, `findStyleByName`, the loader, and the placeholder helpers.

`@deepseek-ai/dsh-doc-template` no longer exports the `VersionConflict` type, and `TemplateStore` no longer offers `allTemplates`, `count`, `rendererRegistry`, `findByNameAndLanguage`, or `listConflicts`. `list`, `findByName`, `languageOf`, and `render` are unchanged, so a store still answers every query its consumers made.

`@deepseek-ai/dsh-client-ui-document-studio` no longer exports `DELIVERABLE_EXTENSIONS`; `isDeliverablePath` and `parentDir` stay.

Anyone importing a removed name from one of these packages is affected. No package in this repository imports one.

## Migration

1. Replace `systemPromptForTemplate(style, template)` with `systemPrompt(style)` and append the template's name, title, category, and `disclaimerFor(style, template.category)` yourself.
2. Replace `stylesForDomain(styles, domain)` with `styles.filter(style => style.domain === domain)`, and drop `TemplateContext` imports in favour of the name, title, and category a caller already holds.
3. Replace `store.findByNameAndLanguage(name, language)` with a `findByName` call and a `store.languageOf(template)` comparison. Read the loaded templates through `store.list()` instead of `allTemplates`, and construct the store with the render formats the deployment ships instead of registering through `rendererRegistry`.
4. Replace `DELIVERABLE_EXTENSIONS` with `isDeliverablePath(path)`; the extension list is now private to that package.
5. Run `pnpm run typecheck`, or rebuild against the new packages. A removed name reports as a missing export.
