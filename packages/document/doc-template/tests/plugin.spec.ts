// 上游来源：Mady 项目 `domains/doctmpl/store.go` 的 `NewTemplateStore`
// （内嵌模板在前、用户目录在后覆盖）。本包把装配搬到 Cordis 插件：
// 资产在加载期装入，故资产错误会让部署加载失败。

import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Pkg from '../src/index.ts'
import { STYLED_TEMPLATE_VARIABLES, styledTemplateRoot } from './styled-template.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

let roots: string[] = []

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

/** Create a temporary directory tracked for teardown. */
async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doc-template-plugin-'))
  roots.push(root)
  return root
}

/** A context with the tool registry and a host filesystem, before the plugin is applied. */
async function toolContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem)
  return ctx
}

/** Install the plugin through the Loader-equivalent config path. */
async function install(config: Record<string, unknown> = {}) {
  const ctx = await toolContext()
  const fiber = await ctx.plugin(Pkg, config)
  return { ctx, fiber }
}

/** The names of the registered tool schemas. */
function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

describe('@deepseek-ai/dsh-doc-template plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('doc-template')
    expect(Pkg.inject).toEqual(['tools', 'systemPrompt', 'fs'])
    expect(Pkg.STYLE_GUIDE_SECTION_NAME).toBe('doc-template:style-guide')
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
  })

  it('exports the library API', () => {
    expect(Pkg.OUTPUT_FORMATS).toEqual(['markdown', 'html', 'docx'])
    expect(Pkg.VAR_TYPES).toEqual(['string', 'multiline', 'number', 'bool'])
    expect(Pkg.FALLBACK_FORMAT).toBe('markdown')
    expect(Pkg.TEMPLATE_CATEGORY_ORDER[0]).toBe('specification')
    expect(Pkg.DISCLAIMER_PREFIX).toBe('> ⚠️ ')
    expect(Pkg.DEFAULT_TEMPLATE_LANGUAGE).toBe('zh-CN')
    expect(Pkg.FORMAT_EXTENSIONS.docx).toBe('.docx')
    expect(Pkg.FORMAT_MIME_TYPES.markdown).toBe('text/markdown')
    expect(Pkg.FORMAT_ENCODINGS.docx).toBe('base64')
    expect(typeof Pkg.DocTemplateError).toBe('function')
    expect(typeof Pkg.createTemplateStore).toBe('function')
    expect(typeof Pkg.createVarSchema).toBe('function')
    expect(typeof Pkg.validatedResolve).toBe('function')
    expect(typeof Pkg.parseTemplate).toBe('function')
    expect(typeof Pkg.loadTemplateDirectory).toBe('function')
    expect(typeof Pkg.TEMPLATE_FILE_SUFFIX).toBe('string')
    expect(typeof Pkg.templatesDirectory).toBe('function')
    expect(typeof Pkg.createRendererRegistry).toBe('function')
    expect(typeof Pkg.markdownRenderer.render).toBe('function')
    expect(typeof Pkg.htmlRenderer.render).toBe('function')
    expect(typeof Pkg.docxRenderer.render).toBe('function')
    expect(typeof Pkg.escapeHtmlText).toBe('function')
    expect(typeof Pkg.isPatentStyle).toBe('function')
    expect(typeof Pkg.applyDisclaimer).toBe('function')
    expect(typeof Pkg.listDocTemplates).toBe('function')
    expect(typeof Pkg.renderDocTemplate).toBe('function')
    expect(typeof Pkg.createListDocTemplatesTool).toBe('function')
    expect(typeof Pkg.createRenderDocTemplateTool).toBe('function')
    expect(Pkg.TEMPLATE_ERROR_CODES).toContain('style-not-found')
    expect(Pkg.VAR_ISSUE_CODES).toEqual(['missing_required', 'invalid_type'])
    expect(() => Pkg.assertNever('x' as never)).toThrow(/unreachable variant/)
  })

  it('registers both tools and unregisters them on dispose (HMR-safety)', async () => {
    const { ctx, fiber } = await install()
    expect(toolNames(ctx)).toContain('list_doc_templates')
    expect(toolNames(ctx)).toContain('render_doc_template')
    await fiber.dispose()
    expect(toolNames(ctx)).not.toContain('list_doc_templates')
    expect(toolNames(ctx)).not.toContain('render_doc_template')
  })

  it('registers through apply directly, taking the defaults', async () => {
    const ctx = await toolContext()
    Pkg.apply(ctx, Pkg.Config({}))
    expect(toolNames(ctx)).toContain('render_doc_template')
    const listed = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: 'list_doc_templates' as never,
      name: 'list_doc_templates',
      arguments: {},
    })
    expect(listed.isError).toBe(false)
  })

  it('layers a configured template root and style directory over the packaged ones', async () => {
    const templates = await tempDir()
    const styles = await tempDir()
    await writeFile(join(templates, 'search-report.md'), [
      '---',
      'name: search-report',
      'title: 自定义检索报告',
      'category: patent-report',
      'domain: patent',
      'style: patent-standard',
      'formats:',
      '  - markdown',
      '---',
      '# 自定义',
      '',
    ].join('\n'))
    await writeFile(join(styles, 'patent-standard.yaml'), [
      'name: patent-standard',
      'domain: patent',
      'version: "2.0"',
      'sections:',
      '  disclaimers:',
      '    patent_analysis: 部署自备免责声明。',
      '',
    ].join('\n'))
    const { ctx } = await install({ templateDirs: [templates], styleDirs: [styles], defaultLanguage: 'en-US' })
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: 'render_doc_template' as never,
      name: 'render_doc_template',
      arguments: { template: 'search-report', variables: {} },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('> ⚠️ 部署自备免责声明。')
    expect(text).toContain('# 自定义')
  })

  it('drops the disclaimer when the deployment disables it', async () => {
    // The patent-report bodies carry their own `> ⚠️ {{disclaimer}}` line, so the
    // check is the style's own disclaimer text rather than the marker.
    const { ctx } = await install({ templateDirs: [await styledTemplateRoot()], includeDisclaimer: false })
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: 'render_doc_template' as never,
      name: 'render_doc_template',
      arguments: { template: 'search-report', variables: STYLED_TEMPLATE_VARIABLES },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).not.toContain('专利申请和法律判断应由具备资质的专利代理人或律师确认')
  })

  it('fails loud at load when a configured asset directory is unusable', async () => {
    const missing = join(await tempDir(), 'no-such-dir')
    await expect(install({ templateDirs: [missing] })).rejects.toThrow(/不可用/)
    await expect(install({ styleDirs: [missing] })).rejects.toThrow(/不可用/)
  })

  it('injects the configured style guide and omits the section when none is configured', async () => {
    const absent = await install()
    const sections = (await absent.ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(sections).not.toContain(Pkg.STYLE_GUIDE_SECTION_NAME)

    const { ctx, fiber } = await install({ styleGuide: 'patent-standard', styleSectionOrder: 42 })
    // A later probe section proves the configured order reached the registry:
    // assembled sections come out in ascending order.
    ctx.systemPrompt.section({ name: 'test:probe', order: 200, text: 'probe' })
    const assembled = (await ctx.systemPrompt.assemble()).sections
    expect(assembled.map(section => section.name)).toContain(Pkg.STYLE_GUIDE_SECTION_NAME)
    expect(assembled.findIndex(section => section.name === Pkg.STYLE_GUIDE_SECTION_NAME)).toBeLessThan(assembled.findIndex(section => section.name === 'test:probe'))
    const guide = assembled.find(section => section.name === Pkg.STYLE_GUIDE_SECTION_NAME)?.text ?? ''
    expect(guide).toContain('Style: patent-standard (domain: patent, version: 1.0)')
    expect(guide).toContain('Never use "绝对" → use "通常" instead')

    await fiber.dispose()
    const after = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(after).not.toContain(Pkg.STYLE_GUIDE_SECTION_NAME)
  })

  it('fails loud when the configured style guide is not loaded', async () => {
    await expect(install({ styleGuide: 'no-such-style' })).rejects.toThrow(/样式指南 "no-such-style" 未加载/)
  })
})
