/**
 * The template store, rewritten from `store.go` of the Go project Mady: the
 * loaded templates, the lookup and listing operations over them, and the
 * resolution-then-render pipeline.
 *
 * The store is constructed once with explicit directories, the loaded styles,
 * and the deployment defaults, and is then read-only, so no lock is needed.
 * @module @deepseek-ai/dsh-doc-template/store
 */

import { resolve } from 'node:path'
import { findStyleByName, toRenderStyle, type DocumentStyle } from '@deepseek-ai/dsh-doc-style'
import { loadTemplateDirectory } from './loader.ts'
import { RendererRegistry, createRendererRegistry } from './renderer-registry.ts'
import { escapeHtmlText } from './renderers/html.ts'
import {
  DocTemplateError,
  FALLBACK_FORMAT,
  FORMAT_ENCODINGS,
  FORMAT_EXTENSIONS,
  FORMAT_MIME_TYPES,
  type DocTemplate,
  type OutputFormat,
  type RenderMeta,
  type RenderStyle,
  type ResolveResult,
  type VarIssue,
} from './types.ts'
import { validatedResolve } from './vars.ts'

/** Filters of a template listing; every filter is optional. */
export interface TemplateFilter {
  /** Exact category, e.g. `claims`. */
  readonly category?: string
  /** Exact domain, e.g. `patent`. */
  readonly domain?: string
  /** Exact effective language, e.g. `zh-CN`. */
  readonly language?: string
  /** Case-insensitive substring matched against name, title, description, and use-when. */
  readonly query?: string
}

/** Construction options of a template store. */
export interface TemplateStoreOptions {
  /**
   * Template asset roots in ascending precedence: the packaged root first, then
   * the configured overrides. A name repeated across roots is overridden.
   */
  readonly templateDirs: readonly string[]
  /** Loaded styles, used to resolve a template's `styleName`. */
  readonly styles: readonly DocumentStyle[]
  /** Language a template without a declared `language` is rendered in. */
  readonly defaultLanguage: string
  /** Whether the style disclaimer is injected into rendered documents. */
  readonly includeDisclaimer: boolean
  /** Renderer registry to use; the shipped Markdown, HTML, and DOCX renderers by default. */
  readonly renderers?: RendererRegistry
}

/** One render request. */
export interface RenderRequest {
  /** Template name. */
  readonly template: string
  /** Variable values, keyed by variable name without braces. */
  readonly variables: Readonly<Record<string, string>>
  /** Target format; the fallback format when omitted. */
  readonly format?: OutputFormat
  /** Document title override; the template title when omitted. */
  readonly title?: string
  /** Author or attorney recorded in the HTML metadata. */
  readonly author?: string
  /** Document date recorded in the HTML metadata. */
  readonly date?: string
  /** Suggested file name without extension; the template name when omitted. */
  readonly filename?: string
}

/** One rendered document. */
export interface RenderOutcome {
  /** The template that was rendered. */
  readonly template: DocTemplate
  /** The format rendered to. */
  readonly format: OutputFormat
  /** Suggested file name including the format's extension. */
  readonly fileName: string
  /** Content type of the rendered document. */
  readonly mimeType: string
  /** How `content` is encoded. */
  readonly encoding: 'utf8' | 'base64'
  /** The rendered document: text for the text formats, a base64 package for DOCX. */
  readonly content: string
  /**
   * The resolved Markdown body before the injected title and style disclaimer;
   * `content` is the document a caller saves.
   */
  readonly markdown: string
  /** Placeholders left unfilled, in first-occurrence order. */
  readonly residual: readonly string[]
  /** Non-blocking variable validation issues, in declaration order. */
  readonly warnings: readonly VarIssue[]
}

/** The loaded templates, their styles, and the render pipeline over them. */
export class TemplateStore {
  private readonly templates: readonly DocTemplate[]
  private readonly positionByName: ReadonlyMap<string, number>
  private readonly styles: readonly DocumentStyle[]
  private readonly defaultLanguage: string
  private readonly includeDisclaimer: boolean
  private readonly renderers: RendererRegistry

  /**
   * @param options - asset roots, styles, and deployment defaults.
   * @throws DocTemplateError when no root is given, a root is unavailable, an asset is invalid, or no template loaded.
   */
  constructor(options: TemplateStoreOptions) {
    if (options.templateDirs.length === 0) {
      throw new DocTemplateError('asset-invalid', '未提供模板目录：无法加载任何模板资产。')
    }
    const templates: DocTemplate[] = []
    const positions = new Map<string, number>()
    for (const directory of options.templateDirs) {
      for (const template of loadTemplateDirectory(directory)) {
        const existing = positions.get(template.name)
        if (existing === undefined) {
          positions.set(template.name, templates.length)
          templates.push(template)
          continue
        }
        templates[existing] = template
      }
    }
    if (templates.length === 0) {
      throw new DocTemplateError('asset-invalid', `模板目录 ${options.templateDirs.join('、')} 中没有 .md 模板资产。`)
    }
    this.templates = templates
    this.positionByName = positions
    this.styles = options.styles
    this.defaultLanguage = options.defaultLanguage
    this.includeDisclaimer = options.includeDisclaimer
    this.renderers = options.renderers ?? createRendererRegistry()
  }

  /**
   * The language a template renders in: its declaration, or the deployment default.
   * @param template - the template.
   * @returns the effective language tag.
   */
  languageOf(template: DocTemplate): string {
    return template.language === '' ? this.defaultLanguage : template.language
  }

  /**
   * List the templates matching a filter.
   * @param filter - the filters to apply; an empty filter returns every template.
   * @returns the matching templates, in load order.
   */
  list(filter: TemplateFilter = {}): readonly DocTemplate[] {
    const query = (filter.query ?? '').trim().toLowerCase()
    return this.templates.filter((template) => {
      if (filter.category !== undefined && template.category !== filter.category) return false
      if (filter.domain !== undefined && template.domain !== filter.domain) return false
      if (filter.language !== undefined && this.languageOf(template) !== filter.language) return false
      if (query === '') return true
      return [template.name, template.title, template.description, template.useWhen]
        .some(field => field.toLowerCase().includes(query))
    })
  }

  /**
   * Find a template by name.
   * @param name - the template name.
   * @returns the template, or `undefined` when no template has that name.
   */
  findByName(name: string): DocTemplate | undefined {
    const position = this.positionByName.get(name)
    return position === undefined ? undefined : this.templates[position]
  }

  /**
   * Resolve a template's variables and render it.
   *
   * Every failure that a caller cannot recover from is an error rather than a
   * degraded document: an unknown template or style name, a format the template
   * does not support, and a missing required variable. A value of the wrong type
   * stays a warning, and an unresolved placeholder stays in the residual list, so
   * the caller decides what to do with a document that rendered but is incomplete.
   * @param request - the template, variables, format, and metadata overrides.
   * @returns the rendered document with its residual placeholders and warnings.
   * @throws DocTemplateError when the template, style, format, or required variables cannot be satisfied.
   */
  render(request: RenderRequest): RenderOutcome {
    const template = this.findByName(request.template)
    if (template === undefined) {
      throw new DocTemplateError(
        'template-not-found',
        `未找到模板 ${JSON.stringify(request.template)}；可用模板见 list_doc_templates。`,
      )
    }
    const format = request.format ?? FALLBACK_FORMAT
    if (!template.supportedFormats.includes(format)) {
      throw new DocTemplateError(
        'format-unsupported',
        `模板 ${template.name} 不支持 ${format} 格式（支持 ${template.supportedFormats.join('/')}）。`,
      )
    }
    const style = this.resolveStyle(template)
    // HTML output passes raw template markup through, so a variable value is escaped first.
    const variables = format === 'html' ? escapeVariables(request.variables) : request.variables
    const resolved: ResolveResult = validatedResolve(template, variables)
    const missing = resolved.warnings.filter(warning => warning.code === 'missing_required')
    if (missing.length > 0) {
      throw new DocTemplateError(
        'variable-missing',
        `模板 ${template.name} 缺少必填变量：${missing.map(issue => issue.variable).join('、')}。`,
      )
    }
    const title = request.title ?? template.title
    const meta: RenderMeta = {
      ...(style === undefined ? {} : { style }),
      ...(title === '' ? {} : { title }),
      ...(request.author === undefined ? {} : { author: request.author }),
      ...(request.date === undefined ? {} : { date: request.date }),
      ...(request.filename === undefined ? {} : { filename: request.filename }),
      language: this.languageOf(template),
    }
    const rendered = this.renderers.render(format, resolved.output, meta)
    return {
      template,
      format,
      fileName: `${request.filename ?? template.name}${FORMAT_EXTENSIONS[format]}`,
      mimeType: FORMAT_MIME_TYPES[format],
      encoding: FORMAT_ENCODINGS[format],
      content: typeof rendered === 'string' ? rendered : Buffer.from(rendered).toString('base64'),
      markdown: resolved.output,
      residual: resolved.residual,
      warnings: resolved.warnings,
    }
  }

  /**
   * Resolve the render style a template names.
   * @param template - the template.
   * @returns the render style, or `undefined` when the template declares none.
   * @throws DocTemplateError when the declared style is not loaded.
   */
  private resolveStyle(template: DocTemplate): RenderStyle | undefined {
    if (template.styleName === '') return undefined
    const style = findStyleByName(this.styles, template.styleName)
    if (style === undefined) {
      throw new DocTemplateError(
        'style-not-found',
        `模板 ${template.name} 声明的样式 ${JSON.stringify(template.styleName)} 未加载；请检查样式资产目录。`,
      )
    }
    const renderStyle = toRenderStyle(style, template.category)
    return this.includeDisclaimer ? renderStyle : { name: renderStyle.name, disclaimer: '' }
  }
}

/**
 * Build a template store.
 * @param options - asset roots, styles, and deployment defaults.
 * @returns the store.
 */
export function createTemplateStore(options: TemplateStoreOptions): TemplateStore {
  return new TemplateStore(options)
}

/**
 * Resolve a configured directory against the process working directory.
 * @param directory - the configured directory.
 * @returns the absolute path.
 */
export function resolveTemplateDirectory(directory: string): string {
  return resolve(directory)
}

/**
 * Escape every variable value for HTML substitution.
 * @param variables - the supplied values.
 * @returns a new map with escaped values.
 */
function escapeVariables(variables: Readonly<Record<string, string>>): Record<string, string> {
  const escaped: Record<string, string> = {}
  for (const [name, value] of Object.entries(variables)) escaped[name] = escapeHtmlText(value)
  return escaped
}
