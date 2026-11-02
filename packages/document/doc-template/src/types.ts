/**
 * Vocabulary of `@deepseek-ai/dsh-doc-template`: the template model rewritten
 * from `domains/doctmpl/{loader,vars,store,format,renderer_registry}.go` of the
 * Go project Mady, its closed value sets and tables, and the renderer seam the
 * format renderers implement.
 *
 * `src/types.ts` is the one module exempt from the per-file coverage gate, so it
 * holds types, constants, and the package's error class only.
 * @module @deepseek-ai/dsh-doc-template/types
 */

/**
 * The variable constraints of one template's body, as the template seam exposes
 * them. `vars.ts` implements this surface as a class; the interface lives here so
 * `DocTemplate` does not have to name a runtime module.
 */
export interface VarSchema {
  /** The definitions, in declaration order. */
  readonly definitions: readonly VarDefinition[]
  /** Every declared variable name, in declaration order. */
  names(): readonly string[]
  /** The names of the variables that must be supplied, in declaration order. */
  requiredNames(): readonly string[]
  /** One variable definition, or `undefined` when the name is not declared. */
  get(name: string): VarDefinition | undefined
  /** Validate the supplied values against the definitions. */
  validate(vars: Readonly<Record<string, string>>): readonly VarIssue[]
  /** Fill in the declared defaults, leaving every other value untouched. */
  applyDefaults(vars: Readonly<Record<string, string>>): Record<string, string>
}

/** Output formats a template may declare support for. */
export const OUTPUT_FORMATS = ['markdown', 'html', 'docx'] as const

/** One render target. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/**
 * File extension per format, from `OutputFormat.Ext()` upstream. The upstream
 * `pdf` and `email` formats are not ported: the harness already owns two PDF
 * paths (Chrome and LibreOffice) and no email render path.
 */
export const FORMAT_EXTENSIONS: Readonly<Record<OutputFormat, string>> = {
  markdown: '.md',
  html: '.html',
  docx: '.docx',
}

/** MIME type per format, from `OutputFormat.MIME()` upstream. */
export const FORMAT_MIME_TYPES: Readonly<Record<OutputFormat, string>> = {
  markdown: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/**
 * How the rendered content is encoded in a tool result. A DOCX package is
 * binary, so it travels base64-encoded; the two text formats travel as UTF-8.
 */
export const FORMAT_ENCODINGS: Readonly<Record<OutputFormat, RenderEncoding>> = {
  markdown: 'utf8',
  html: 'utf8',
  docx: 'base64',
}

/** Encoding of rendered content in a tool result. */
export type RenderEncoding = 'utf8' | 'base64'

/**
 * Format a template is rendered in when its front-matter declares none, from the
 * upstream loader's fallback.
 */
export const FALLBACK_FORMAT: OutputFormat = 'markdown'

/** Data types a template variable may declare. */
export const VAR_TYPES = ['string', 'multiline', 'number', 'bool'] as const

/** One template variable data type. */
export type VarType = (typeof VAR_TYPES)[number]

/** The type a variable takes when its declaration omits one. */
export const DEFAULT_VAR_TYPE: VarType = 'string'

/** Validation outcomes a variable can produce. */
export const VAR_ISSUE_CODES = ['missing_required', 'invalid_type'] as const

/** One variable validation outcome. */
export type VarIssueCode = (typeof VAR_ISSUE_CODES)[number]

/** One non-blocking variable validation issue. */
export interface VarIssue {
  /** Variable name, without its `{{}}` wrapping. */
  readonly variable: string
  /** Stable issue kind. */
  readonly code: VarIssueCode
  /** What is wrong with the supplied value. */
  readonly message: string
}

/** The constraints on one template variable. */
export interface VarDefinition {
  /** Variable name, without its `{{}}` wrapping. */
  readonly name: string
  /** Declared data type. */
  readonly type: VarType
  /** Whether the variable must be supplied. */
  readonly required: boolean
  /** Value used when the variable is absent; absent means no default. */
  readonly default?: string
  /** What the variable means, shown to the model. */
  readonly description: string
}

/**
 * One parsed document template: the front-matter metadata plus the Markdown body
 * whose `{{snake_case}}` placeholders the variables fill.
 */
export interface DocTemplate {
  /** Template name, unique within a loaded set. */
  readonly name: string
  /** Document title. */
  readonly title: string
  /** Document category, e.g. `specification` or `oa-response`. */
  readonly category: string
  /** One-line description. */
  readonly description: string
  /** Domain the template belongs to, e.g. `patent`. */
  readonly domain: string
  /** Template version. */
  readonly version: string
  /** Language the body is written in; the empty string means the deployment default applies. */
  readonly language: string
  /** Writing style name the template is composed with; empty means no style applies. */
  readonly styleName: string
  /** When the template should be used. */
  readonly useWhen: string
  /** Formats this template may be rendered to. */
  readonly supportedFormats: readonly OutputFormat[]
  /** Variable constraints of the body's placeholders. */
  readonly varSchema: VarSchema
  /** Absolute path of the asset the template was read from. */
  readonly filePath: string
  /** Markdown body after the front-matter, trimmed. */
  readonly body: string
}

/**
 * The render-time projection of a document style. `@deepseek-ai/dsh-doc-style`
 * declares the same record, so the two packages meet structurally.
 */
export interface RenderStyle {
  /** Style name, which selects the HTML stylesheet. */
  readonly name: string
  /** Disclaimer injected before the body; empty when none applies. */
  readonly disclaimer: string
}

/** Metadata a renderer receives beside the resolved Markdown body. */
export interface RenderMeta {
  /** Style projection; absent when the template declares no style. */
  readonly style?: RenderStyle
  /** Document title, rendered as a level-1 heading when the body has none. */
  readonly title?: string
  /** Author or attorney. */
  readonly author?: string
  /** Document date, as the caller records it. */
  readonly date?: string
  /** Suggested file name without extension. */
  readonly filename?: string
  /**
   * Document language tag, which becomes the HTML `lang` attribute. Required, so
   * the deployment's default language has exactly one owner: the caller that
   * resolved `Config.defaultLanguage`.
   */
  readonly language: string
}

/** Rendered document content: text for the text formats, bytes for DOCX. */
export type RenderedDocument = string | Uint8Array

/** One output-format renderer. */
export interface Renderer {
  /** The format this renderer produces. */
  readonly format: OutputFormat
  /**
   * Render a resolved Markdown body.
   * @param markdown - the resolved body.
   * @param meta - rendering metadata.
   * @returns the rendered content.
   */
  render(markdown: string, meta: RenderMeta): RenderedDocument
}

/** The output of a validated variable resolution. */
export interface ResolveResult {
  /** The body with every supplied variable substituted. */
  readonly output: string
  /** Non-blocking validation issues, in declaration order. */
  readonly warnings: readonly VarIssue[]
  /** Placement holders still present after substitution, in first-occurrence order. */
  readonly residual: readonly string[]
}

/** Marker the upstream renderers prefixed to a disclaimer line. */
export const DISCLAIMER_PREFIX = '> ⚠️ '

/** Separator the upstream renderers put between the disclaimer and the body. */
export const DISCLAIMER_SEPARATOR = '\n\n---\n\n'

/**
 * Category order used when listing templates, from the upstream `DocIndex`
 * ordering, restricted to the categories this deployment ships.
 */
export const TEMPLATE_CATEGORY_ORDER = ['specification', 'claims', 'oa-response', 'disclosure'] as const

/** Failure kinds a `DocTemplateError` reports. */
export const TEMPLATE_ERROR_CODES = [
  'asset-invalid',
  'template-not-found',
  'style-not-found',
  'format-unsupported',
  'variable-missing',
  'variable-invalid',
  'duplicate-template',
  'renderer-missing',
  'output-path-required',
] as const

/** One failure kind. */
export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[number]

/**
 * Mark an unreachable variant of a closed union.
 * @param value - the variant no branch handled.
 * @returns never; the call always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`)
}

/** Thrown when a template, variable set, style, or format cannot be satisfied. */
export class DocTemplateError extends Error {
  /** Stable failure kind, for callers that branch on it. */
  readonly code: TemplateErrorCode

  /**
   * @param code - stable failure kind.
   * @param message - what could not be satisfied.
   */
  constructor(code: TemplateErrorCode, message: string) {
    super(message)
    this.name = 'DocTemplateError'
    this.code = code
  }
}
