/**
 * Function plugin registering `list_doc_templates` and `render_doc_template`:
 * the Chinese document templates shipped with the harness, resolved against
 * their declared variable schema and rendered to Markdown, HTML, or DOCX.
 *
 * Both asset roots load at plugin load, so a missing template directory, a
 * malformed template, an unsupported declared format, or an unavailable style
 * directory fails the deployment instead of leaving the tools with a partial
 * catalog.
 * @module @deepseek-ai/dsh-doc-template
 */

import type { Context } from '@deepseek-ai/cordis'
import { findStyleByName, loadStyles, styleDirectories, systemPrompt, type DocumentStyle } from '@deepseek-ai/dsh-doc-style'
import z from '@deepseek-ai/schemastery'
import { templatesDirectory } from './asset-location.ts'
import { createTemplateStore, resolveTemplateDirectory } from './store.ts'
import { createListDocTemplatesTool } from './tool/list-doc-templates.ts'
import { createRenderDocTemplateTool } from './tool/render-doc-template.ts'

// Public library API: the template model, its loader, the variable pipeline, the
// renderers, and both tool factories, so a consumer can load and render
// templates without going through the plugin.
export {
  assertNever,
  DEFAULT_VAR_TYPE,
  DISCLAIMER_PREFIX,
  DISCLAIMER_SEPARATOR,
  DocTemplateError,
  FALLBACK_FORMAT,
  FORMAT_ENCODINGS,
  FORMAT_EXTENSIONS,
  FORMAT_MIME_TYPES,
  OUTPUT_FORMATS,
  TEMPLATE_CATEGORY_ORDER,
  TEMPLATE_ERROR_CODES,
  VAR_ISSUE_CODES,
  VAR_TYPES,
} from './types.ts'
export type {
  DocTemplate,
  OutputFormat,
  RenderedDocument,
  RenderEncoding,
  Renderer,
  RenderMeta,
  RenderStyle,
  ResolveResult,
  TemplateErrorCode,
  VarDefinition,
  VarIssue,
  VarIssueCode,
  VarType,
} from './types.ts'
export { createVarSchema, extractPlaceholders, substitutePlaceholders, validatedResolve, VarSchema } from './vars.ts'
export { parseTemplate, splitFrontmatter } from './frontmatter.ts'
export type { FrontmatterSplit } from './frontmatter.ts'
export { loadTemplateDirectory, loadTemplateFile, TEMPLATE_FILE_SUFFIX } from './loader.ts'
export { createTemplateStore, resolveTemplateDirectory, TemplateStore } from './store.ts'
export type {
  RenderOutcome,
  RenderRequest,
  TemplateFilter,
  TemplateStoreOptions,
  VersionConflict,
} from './store.ts'
export { createRendererRegistry, RendererRegistry } from './renderer-registry.ts'
export { applyDisclaimer, markdownRenderer } from './renderers/markdown.ts'
export { docxRenderer } from './renderers/docx.ts'
export { escapeHtmlText, htmlRenderer, isPatentStyle } from './renderers/html.ts'
export { templatesDirectory } from './asset-location.ts'
export {
  createListDocTemplatesTool,
  listDocTemplates,
  renderTemplateList,
  toTemplateFilter,
} from './tool/list-doc-templates.ts'
export type {
  DocTemplateSummary,
  DocTemplateVariable,
  ListDocTemplatesInput,
  ListDocTemplatesOutput,
} from './tool/list-doc-templates.ts'
export {
  coerceStringRecord,
  createRenderDocTemplateTool,
  renderDocTemplate,
  renderDocumentResult,
} from './tool/render-doc-template.ts'
export type {
  InlineRenderedDocument, RenderDocTemplateInput, RenderDocTemplateOutput,
} from './tool/render-doc-template.ts'

/** Cordis plugin name. */
export const name = 'doc-template'

/** Services the plugin requires before registration. */
export const inject = ['tools', 'systemPrompt', 'fs']

/** Language a template that declares none renders in by default. */
export const DEFAULT_TEMPLATE_LANGUAGE = 'zh-CN'

/** Whether a rendered document carries its style's disclaimer by default. */
export const DEFAULT_INCLUDE_DISCLAIMER = true

/** Name of the system-prompt section the writing-style guide is registered under. */
export const STYLE_GUIDE_SECTION_NAME = 'doc-template:style-guide'

/** Position of the injected style guide: with the persona, ahead of the plan and tool sections. */
const DEFAULT_STYLE_SECTION_ORDER = 100

/** Model-facing document-template plugin configuration. */
export interface Config {
  /** Template roots layered over the packaged root; a later root overrides an earlier template of the same name. */
  templateDirs?: string[]
  /** Style directories layered over the packaged one, in ascending precedence. */
  styleDirs?: string[]
  /** Language a template that declares none renders in. */
  defaultLanguage?: string
  /** Whether the style disclaimer is injected into rendered documents. */
  includeDisclaimer?: boolean
  /** Loaded style name whose guide this agent reads before writing; empty for no section. */
  styleGuide?: string
  /** Position of the injected style guide in the assembled system prompt. */
  styleSectionOrder?: number
}

/** Schemastery configuration: asset roots, document defaults, and the optional style guide. */
export const Config: z<Config> = z.object({
  templateDirs: z.array(z.string()).default([]),
  styleDirs: z.array(z.string()).default([]),
  defaultLanguage: z.string().default(DEFAULT_TEMPLATE_LANGUAGE),
  includeDisclaimer: z.boolean().default(DEFAULT_INCLUDE_DISCLAIMER),
  styleGuide: z.string().default(''),
  styleSectionOrder: z.natural().default(DEFAULT_STYLE_SECTION_ORDER),
})

/**
 * Register the style guide as a system-prompt section, failing the deployment
 * when the configured name is not loaded: a guide that silently does not apply
 * would leave the model writing against a style no checker agrees with.
 * @param ctx - registrant context carrying the system-prompt registry.
 * @param styles - the loaded styles.
 * @param configured - the configured style name and section position.
 * @returns the section's disposer, or undefined when no guide was requested.
 */
function registerStyleGuide(
  ctx: Context, styles: readonly DocumentStyle[], configured: { name: string; order: number },
): (() => void) | undefined {
  if (configured.name === '') return undefined
  const style = findStyleByName(styles, configured.name)
  if (style === undefined) {
    throw new Error(`doc-template: 样式指南 ${JSON.stringify(configured.name)} 未加载；已加载：${styles.map(entry => entry.name).join('、')}`)
  }
  return ctx.systemPrompt.section({ name: STYLE_GUIDE_SECTION_NAME, order: configured.order, text: systemPrompt(style) })
}

/**
 * Load the template and style assets, register both tools, and inject the
 * configured writing-style guide.
 * @param ctx - registrant context carrying the tool and system-prompt registries.
 * @param config - asset root overrides, document defaults, and the style guide.
 */
export function apply(ctx: Context, config: Config): void {
  const templateDirs = [
    templatesDirectory(),
    ...(config.templateDirs ?? []).map(resolveTemplateDirectory),
  ]
  const styles = loadStyles(styleDirectories(config.styleDirs))
  const store = createTemplateStore({
    templateDirs,
    styles,
    defaultLanguage: config.defaultLanguage ?? DEFAULT_TEMPLATE_LANGUAGE,
    includeDisclaimer: config.includeDisclaimer ?? DEFAULT_INCLUDE_DISCLAIMER,
  })
  ctx.tools.register(createListDocTemplatesTool(store))
  ctx.tools.register(createRenderDocTemplateTool(ctx, store))
  registerStyleGuide(ctx, styles, {
    name: config.styleGuide ?? '',
    order: config.styleSectionOrder ?? DEFAULT_STYLE_SECTION_ORDER,
  })
}
