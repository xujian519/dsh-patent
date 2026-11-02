// 上游来源：Mady 项目 `domains/doctmpl/tools.go`（`list_doc_templates` 与
// `render_doc_template` 的参数、默认格式、错误分支）与 `tools_test.go`。
// 上游以 JSON 字符串返回结果；本包改为 canonical 值 + 纯 render 投影，
// 并保留“未知模板 / 不支持的格式 / 缺必填变量 / 非法变量值”四类失败。

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadStyles, stylesDirectory } from '@deepseek-ai/dsh-doc-style'
import { templatesDirectory } from '../src/asset-location.ts'
import { createTemplateStore } from '../src/store.ts'
import { listDocTemplates, renderTemplateList, toTemplateFilter } from '../src/tool/list-doc-templates.ts'
import {
  coerceStringRecord,
  renderDocTemplate,
  renderDocumentResult,
  type RenderDocTemplateOutput,
} from '../src/tool/render-doc-template.ts'
import { createListDocTemplatesTool } from '../src/tool/list-doc-templates.ts'
import { createRenderDocTemplateTool } from '../src/tool/render-doc-template.ts'
import { STYLED_TEMPLATE_VARIABLES, styledTemplateRoot } from './styled-template.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let roots: string[] = []

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

/** A store over the packaged assets plus optional override roots. */
function storeOf(templateDirs: readonly string[] = [templatesDirectory()]) {
  return createTemplateStore({
    templateDirs,
    styles: loadStyles([stylesDirectory()]),
    defaultLanguage: 'zh-CN',
    includeDisclaimer: true,
  })
}

/** A host registering both tools. */
async function host(templateDirs?: readonly string[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const store = storeOf(templateDirs)
  ctx.tools.register(createListDocTemplatesTool(store))
  ctx.tools.register(createRenderDocTemplateTool(ctx, store))
  return ctx
}

/** Execute one registered tool. */
function execute(ctx: Context, name: string, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(name),
    name,
    arguments: args,
  })
}

/** The text of a tool result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

const SIMPLIFIED_DISCLOSURE_VARIABLES = {
  invention_title: '图像处理',
  existing_problems: 'p',
  tech_solution: 's',
  tech_effects: 'e',
  innovation_1: 'i1',
  innovation_2: 'i2',
  innovation_3: 'i3',
  figures: 'f',
  notes: 'n',
}

describe('toTemplateFilter', () => {
  it('drops every empty or absent filter', () => {
    expect(toTemplateFilter({})).toEqual({})
    expect(toTemplateFilter({ category: '', domain: '', language: '', query: '' })).toEqual({})
  })

  it('keeps the supplied filters', () => {
    expect(toTemplateFilter({ category: 'claims', domain: 'patent', language: 'zh-CN', query: '方法' }))
      .toEqual({ category: 'claims', domain: 'patent', language: 'zh-CN', query: '方法' })
  })
})

describe('listDocTemplates', () => {
  it('orders the catalog by category then name', () => {
    const catalog = listDocTemplates(storeOf(), {})
    expect(catalog.count).toBe(17)
    expect(catalog.templates.map(template => template.name)).toEqual([
      'chemical-spec',
      'electrical-spec',
      'mechanical-spec',
      'software-spec',
      'apparatus-claim',
      'method-claim',
      'system-claim',
      'clarity-amendment',
      'inventiveness-defense',
      'novelty-defense',
      'simplified-disclosure',
      'standard-9-section',
      'faq',
      'meeting-notes',
      'prd',
      'release-notes',
      'report',
    ])
  })

  it('reports each template with its effective language, style, formats, and variables', async () => {
    const store = storeOf([templatesDirectory(), await styledTemplateRoot()])
    const searchReport = listDocTemplates(store, { query: 'search-report' }).templates[0]
    expect(searchReport).toMatchObject({
      name: 'search-report',
      category: 'patent-report',
      domain: 'patent',
      version: '1.0.0',
      language: 'zh-CN',
      style: 'patent-standard',
      formats: ['markdown', 'html'],
    })
    expect(searchReport?.variables.map(definition => definition.name)).toEqual([
      'firm_name',
      'doc_no',
      'case_no',
      'invention_title',
      'search_type',
      'search_strategy',
      'databases_covered',
      'key_hits',
      'analysis',
      'conclusion',
      'disclaimer',
    ])
    expect(searchReport?.variables.filter(definition => definition.required).map(definition => definition.name)).toEqual([
      'firm_name',
      'invention_title',
      'search_type',
      'search_strategy',
      'databases_covered',
      'key_hits',
      'analysis',
      'conclusion',
    ])
    expect(searchReport?.variables.find(definition => definition.name === 'disclaimer'))
      .toMatchObject({ required: false, default: '本报告由 AI 辅助生成，不构成正式法律意见。检索结果可能存在遗漏，仅供人工复核。' })
  })

  it('applies the model filters', () => {
    expect(listDocTemplates(storeOf(), { category: 'disclosure' }).count).toBe(2)
    expect(listDocTemplates(storeOf(), { category: 'document' }).count).toBe(5)
    expect(listDocTemplates(storeOf(), { domain: 'document' }).count).toBe(5)
    expect(listDocTemplates(storeOf(), { domain: 'legal' }).count).toBe(0)
    expect(listDocTemplates(storeOf(), { language: 'en-US' }).count).toBe(0)
    expect(listDocTemplates(storeOf(), { query: '三步法' }).templates.map(template => template.name)).toEqual([
      'inventiveness-defense',
    ])
  })

  it('sorts a template of an unlisted category after the listed ones, by name among its peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doc-template-tools-'))
    roots.push(root)
    await writeFile(join(root, 'legal.md'), '---\nname: legal-brief\ncategory: legal\n---\n正文\n')
    const catalog = listDocTemplates(storeOf([templatesDirectory(), root]), {})
    const names = catalog.templates.map(template => template.name)
    // The four listed categories hold the first twelve rows; the unlisted
    // `document` and `legal` categories follow, ordered by name among themselves.
    expect(names.slice(12)).toEqual(['faq', 'legal-brief', 'meeting-notes', 'prd', 'release-notes', 'report'])
  })
})

describe('renderTemplateList', () => {
  it('reports an empty result', () => {
    expect(renderTemplateList({ templates: [], count: 0 })).toBe('No document template matches the filters.')
  })

  it('renders every template with its variables', () => {
    const text = renderTemplateList(listDocTemplates(storeOf(), { query: 'method-claim' }))
    expect(text).toContain('1 document templates')
    expect(text).toContain('- [claims] method-claim — 方法权利要求')
    expect(text).toContain('description: 方法类发明专利权利要求模板')
    expect(text).toContain('formats: markdown, html, docx · language: zh-CN · style: none')
    expect(text).toContain('variables: method_name: string; step_1: multiline;')
  })

  it('renders a template that declares no variables as none', () => {
    const text = renderTemplateList({
      count: 1,
      templates: [{
        name: 'bare',
        title: 'Bare',
        category: 'claims',
        description: 'd',
        domain: 'patent',
        version: '1',
        language: 'zh-CN',
        style: '',
        useWhen: '',
        formats: ['markdown'],
        variables: [],
      }],
    })
    expect(text).toContain('variables: none')
  })

  it('renders requiredness, defaults, and the use-when line', () => {
    const text = renderTemplateList({
      count: 1,
      templates: [{
        name: 't',
        title: 'T',
        category: 'claims',
        description: 'd',
        domain: 'patent',
        version: '1',
        language: 'zh-CN',
        style: 'patent-standard',
        useWhen: '需要时',
        formats: ['markdown'],
        variables: [
          { name: 'a', type: 'string', required: true, description: 'A' },
          { name: 'b', type: 'number', required: false, default: '1', description: 'B' },
        ],
      }],
    })
    expect(text).toContain('variables: a: string, required; b: number, default "1"')
    expect(text).toContain('use when: 需要时')
  })
})

describe('renderDocTemplate', () => {
  it('renders with the template defaults for format, title, and file name', () => {
    const value = renderDocTemplate(storeOf(), { template: 'simplified-disclosure', variables: SIMPLIFIED_DISCLOSURE_VARIABLES })
    expect(value).toMatchObject({
      template: 'simplified-disclosure',
      format: 'markdown',
      fileName: 'simplified-disclosure.md',
      encoding: 'utf8',
      residual: [],
      warnings: [],
    })
  })

  it('carries the format and metadata overrides into the document', () => {
    const value = renderDocTemplate(storeOf(), {
      template: 'simplified-disclosure',
      variables: SIMPLIFIED_DISCLOSURE_VARIABLES,
      format: 'html',
      title: '自定义',
      author: '甲',
      date: '2026-01-01',
      filename: 'out',
    })
    expect(value.fileName).toBe('out.html')
    expect(value.content).toContain('<h1>自定义</h1>')
    expect(value.content).toContain('content="甲"')
    expect(value.markdown).toContain('图像处理')
  })

  it('keeps a type mismatch as a warning and still renders the document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doc-template-tools-warn-'))
    roots.push(root)
    await writeFile(join(root, 'typed.md'), '---\nname: typed\nvars:\n  - name: count\n    type: number\n---\n# 正文 {{count}}\n')
    const value = renderDocTemplate(storeOf([templatesDirectory(), root]), { template: 'typed', variables: { count: 'abc' } })
    expect(value.warnings).toEqual([{ variable: 'count', code: 'invalid_type', message: '期望 number 类型，实际值: "abc"' }])
    expect(value.markdown).toContain('正文 abc')
    expect(renderDocumentResult(value)).toContain('Warnings:\n- count: 期望 number 类型，实际值: "abc"')
  })
})

describe('renderDocumentResult', () => {
  const base: RenderDocTemplateOutput = {
    template: 't',
    format: 'markdown',
    fileName: 't.md',
    mimeType: 'text/markdown',
    encoding: 'utf8',
    content: '正文',
    markdown: '正文',
    residual: [],
    warnings: [],
  }

  it('renders a clean text document', () => {
    const text = renderDocumentResult(base)
    expect(text).toContain('t · markdown · t.md · text/markdown · utf8')
    expect(text).toContain('Residual placeholders: none')
    expect(text).toContain('Warnings: none')
    expect(text).toContain('--- document ---\n正文')
  })

  it('reports a written document by path without repeating its body', () => {
    const text = renderDocumentResult({
      ...base,
      path: 'out/t.md',
      bytes: 12,
    })
    expect(text).toContain('Written to out/t.md (12 bytes).')
    expect(text).toContain('The document body is on disk.')
    expect(text).not.toContain('--- document ---')
    expect(text).not.toContain('正文')
  })

  it('renders a written path even when the byte count is absent', () => {
    const text = renderDocumentResult({ ...base, path: 'out/t.md' })
    expect(text).toContain('Written to out/t.md (0 bytes).')
  })

  it('renders the diagnostics alone when an inline value carries no body', () => {
    const text = renderDocumentResult({
      template: base.template,
      format: base.format,
      fileName: base.fileName,
      mimeType: base.mimeType,
      encoding: base.encoding,
      residual: base.residual,
      warnings: base.warnings,
    })
    expect(text).toContain('Residual placeholders: none')
    expect(text).not.toContain('--- document ---')
  })

  it('renders the residual placeholders, the warnings, and the inline package body', () => {
    const text = renderDocumentResult({
      ...base,
      format: 'docx',
      encoding: 'base64',
      content: 'UEsDBA==',
      residual: ['a', 'b'],
      warnings: [{ variable: 'n', code: 'invalid_type', message: '期望 number 类型' }],
    })
    expect(text).toContain('Residual placeholders (2): a, b')
    expect(text).toContain('Warnings:\n- n: 期望 number 类型')
    expect(text).toContain('--- document ---\n正文')
  })
})

describe('coerceStringRecord', () => {
  it('reads a string map and an absent value', () => {
    expect(coerceStringRecord(undefined)).toEqual({})
    expect(coerceStringRecord({ a: 'x', b: '' })).toEqual({ a: 'x', b: '' })
  })

  it('rejects a non-string value', () => {
    expect(() => coerceStringRecord({ a: 1 })).toThrow(/变量 "a" 的值必须是字符串/)
  })
})

describe('list_doc_templates tool', () => {
  it('lists the catalog through the registry', async () => {
    const ctx = await host()
    const result = await execute(ctx, 'list_doc_templates', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(textOf(result)).toContain('17 document templates')
    expect(textOf(result)).toContain('- [specification] chemical-spec — 化学领域说明书')
    expect(textOf(result)).toContain('- [document] prd — 产品需求文档')
    expect(textOf(result)).toContain('variables: product_name: string;')
    const value = result.value as { count: number; templates: { name: string; domain: string; variables: unknown[] }[] }
    expect(value.count).toBe(17)
    // The structured value carries the domain and a non-empty variable table per row.
    expect(value.templates.filter(template => template.domain === 'document').map(template => template.name).sort())
      .toEqual(['faq', 'meeting-notes', 'prd', 'release-notes', 'report'])
    expect(value.templates.filter(template => template.variables.length === 0)).toEqual([])
  })

  it('filters the catalog by domain', async () => {
    const ctx = await host()
    const result = await execute(ctx, 'list_doc_templates', { domain: 'document' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect((result.value as { count: number }).count).toBe(5)
    expect(textOf(result)).toContain('- [document] meeting-notes — 会议纪要')
    expect(textOf(result)).not.toContain('chemical-spec')
  })

  it('reports no match and rejects malformed arguments', async () => {
    const ctx = await host()
    const empty = await execute(ctx, 'list_doc_templates', { category: 'legal' })
    expect(empty.isError).toBe(false)
    if (empty.isError) throw new Error('expected success')
    expect(textOf(empty)).toBe('No document template matches the filters.')
    expect((await execute(ctx, 'list_doc_templates', { category: 1 })).isError).toBe(true)
  })
})

describe('render_doc_template tool', () => {
  it('renders a document through the registry and reports its residual placeholders', async () => {
    const ctx = await host([templatesDirectory(), await styledTemplateRoot()])
    const result = await execute(ctx, 'render_doc_template', {
      template: 'search-report',
      variables: STYLED_TEMPLATE_VARIABLES,
      format: 'html',
      title: '交付件',
      author: '代理人甲',
      date: '2026-09-20',
      filename: 'delivery',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as unknown as RenderDocTemplateOutput
    expect(value.fileName).toBe('delivery.html')
    expect(value.content).toContain('<h1>交付件</h1>')
    expect(value.content).toContain('content="代理人甲"')
    expect(value.markdown).toContain('**机构：** 某所')
    expect(textOf(result)).toContain('Residual placeholders (2): doc_no, case_no')
    expect(textOf(result)).toContain('--- document ---')
  })

  it('fails the call when a required variable is missing', async () => {
    const ctx = await host([templatesDirectory(), await styledTemplateRoot()])
    const result = await execute(ctx, 'render_doc_template', { template: 'search-report', variables: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('缺少必填变量：firm_name')
  })

  it('fails the call when a variable value is not a string', async () => {
    const ctx = await host()
    const result = await execute(ctx, 'render_doc_template', { template: 'search-report', variables: { firm_name: 7 } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('变量 "firm_name" 的值必须是字符串')
  })

  it('fails the call when the template or the format is not supported', async () => {
    const ctx = await host([templatesDirectory(), await styledTemplateRoot()])
    expect((await execute(ctx, 'render_doc_template', { template: 'nope', variables: {} })).isError).toBe(true)
    const unsupported = await execute(ctx, 'render_doc_template', {
      template: 'search-report',
      variables: STYLED_TEMPLATE_VARIABLES,
      format: 'docx',
    })
    expect(unsupported.isError).toBe(true)
    expect(textOf(unsupported)).toContain('不支持 docx 格式')
  })

  it('refuses a DOCX render that names no output_path', async () => {
    const ctx = await host()
    const result = await execute(ctx, 'render_doc_template', { template: 'method-claim', variables: {}, format: 'docx' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('output_path')
  })
})
