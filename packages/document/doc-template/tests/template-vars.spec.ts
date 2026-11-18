// 回归：catalog 报出的变量名必须足以填满模板正文——对每个随包模板，
// "按 list_doc_templates 给出的变量名逐个赋值 → residual 为空"。
// 这钉住"正文里的 {{...}} 与 front-matter 的 vars 同源"：删掉任一模板的 vars
// 声明，变量表与正文占位符就不再相等，测试立即变红。

import { describe, expect, it } from 'vitest'
import { loadStyles, stylesDirectory } from '@deepseek-ai/dsh-doc-style'
import { templatesDirectory } from '../src/asset-location.ts'
import { createTemplateStore, type TemplateStore } from '../src/store.ts'
import { listDocTemplates, type DocTemplateVariable } from '../src/tool/list-doc-templates.ts'
import { extractPlaceholders } from '../src/vars.ts'
import type { VarType } from '../src/types.ts'

/** A type-valid sample value per declared variable type. */
const SAMPLE_BY_TYPE: Readonly<Record<VarType, string>> = {
  string: '示例值',
  multiline: '示例段落。',
  number: '1',
  bool: 'true',
}

/** The packaged store with the same deployment defaults the plugin uses. */
function storeOf(): TemplateStore {
  return createTemplateStore({
    templateDirs: [templatesDirectory()],
    styles: loadStyles([stylesDirectory()]),
    defaultLanguage: 'zh-CN',
    includeDisclaimer: true,
  })
}

/** The catalog and store every case reads. */
const store = storeOf()
const catalog = listDocTemplates(store, {})

/** A value for one catalog variable, chosen by its declared type. */
function valueFor(variable: DocTemplateVariable): string {
  return SAMPLE_BY_TYPE[variable.type]
}

describe('template variable catalog', () => {
  it('ships seventeen templates that each declare at least one variable', () => {
    expect(catalog.count).toBe(17)
    for (const summary of catalog.templates) {
      expect(summary.variables.length, summary.name).toBeGreaterThan(0)
    }
  })

  it('renders every template from the catalog variable names with no residual placeholder', () => {
    for (const summary of catalog.templates) {
      const variables = Object.fromEntries(summary.variables.map(variable => [variable.name, valueFor(variable)]))
      const outcome = store.render({ template: summary.name, variables })
      expect(outcome.residual, summary.name).toEqual([])
      expect(outcome.warnings, summary.name).toEqual([])
    }
  })

  it('keeps the declared variables and the body placeholders in the same name set', () => {
    for (const template of store.list()) {
      const declared = [...template.varSchema.names()].sort()
      const used = [...extractPlaceholders(template.body)].sort()
      expect(declared, template.name).toEqual(used)
    }
  })

  it('ships the five document-domain templates', () => {
    expect(catalog.templates.filter(summary => summary.domain === 'document').map(summary => summary.name).sort())
      .toEqual(['faq', 'meeting-notes', 'prd', 'release-notes', 'report'])
  })
})
