/**
 * `render_doc_template` tool: render one template with supplied variables.
 *
 * The result always carries the residual placeholders and the validation
 * warnings beside the document, because they are what a caller (human or gate)
 * reads to decide whether the rendered document is complete. A required variable
 * the call did not supply fails the call instead of producing a document with a
 * hole in it.
 * @module @deepseek-ai/dsh-doc-template/tool/render-doc-template
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { RenderRequest, TemplateStore } from '../store.ts'
import {
  DocTemplateError,
  OUTPUT_FORMATS,
  VAR_ISSUE_CODES,
  type OutputFormat,
  type RenderEncoding,
  type VarIssue,
} from '../types.ts'

/** The model's render request. */
export interface RenderDocTemplateInput {
  /** Template name, from `list_doc_templates`. */
  readonly template: string
  /** Variable values, keyed by variable name without braces. */
  readonly variables: Readonly<Record<string, string>>
  /** Target format; the template's fallback format when omitted. */
  readonly format?: OutputFormat
  /** Document title override; the template title when omitted. */
  readonly title?: string
  /** Author or attorney recorded in the HTML metadata. */
  readonly author?: string
  /** Document date recorded in the HTML metadata. */
  readonly date?: string
  /** Suggested file name without extension; the template name when omitted. */
  readonly filename?: string
  /** Write the rendered document to this path instead of returning only its content. */
  readonly outputPath?: string
}

/** The rendered document as the model receives it. */
export interface RenderDocTemplateOutput {
  /** The template that was rendered. */
  readonly template: string
  /** The format rendered to. */
  readonly format: OutputFormat
  /** Suggested file name including the format's extension. */
  readonly fileName: string
  /** Content type of the rendered document. */
  readonly mimeType: string
  /** How `content` is encoded. */
  readonly encoding: RenderEncoding
  /**
   * The rendered document: text, or a base64 DOCX package. Absent when the
   * document was written to `path`, because the file itself is then the copy
   * the caller reads.
   */
  readonly content?: string
  /**
   * The resolved Markdown body before the injected title and style disclaimer;
   * `content` is the document a caller saves. Absent when the document was
   * written to `path`.
   */
  readonly markdown?: string
  /** Placeholders left unfilled, in first-occurrence order. */
  readonly residual: string[]
  /** Non-blocking variable validation issues. */
  readonly warnings: VarIssue[]
  /** Canonical path the document was written to; present only when `outputPath` was supplied. */
  readonly path?: string
  /** Bytes written to `path`; present only when `outputPath` was supplied. */
  readonly bytes?: number
}

/** A render that has not touched the filesystem, so both body fields are present. */
export type InlineRenderedDocument = RenderDocTemplateOutput & {
  readonly content: string
  readonly markdown: string
}

/** A mutable render request under construction. */
type MutableRenderRequest = { -readonly [K in keyof RenderRequest]: RenderRequest[K] }

/**
 * Render one template.
 * @param store - the loaded templates and styles.
 * @param input - the template, variables, format, and metadata overrides.
 * @returns the rendered document with its residual placeholders and warnings.
 * @throws DocTemplateError when the template, style, format, or required variables cannot be satisfied.
 */
export function renderDocTemplate(store: TemplateStore, input: RenderDocTemplateInput): InlineRenderedDocument {
  const request: MutableRenderRequest = { template: input.template, variables: input.variables }
  if (input.format !== undefined) request.format = input.format
  if (input.title !== undefined && input.title !== '') request.title = input.title
  if (input.author !== undefined && input.author !== '') request.author = input.author
  if (input.date !== undefined && input.date !== '') request.date = input.date
  if (input.filename !== undefined && input.filename !== '') request.filename = input.filename
  const outcome = store.render(request)
  return {
    template: outcome.template.name,
    format: outcome.format,
    fileName: outcome.fileName,
    mimeType: outcome.mimeType,
    encoding: outcome.encoding,
    content: outcome.content,
    markdown: outcome.markdown,
    residual: [...outcome.residual],
    warnings: outcome.warnings.map(issue => ({
      variable: issue.variable,
      code: issue.code,
      message: issue.message,
    })),
  }
}

/**
 * Write one rendered document through the calling session's filesystem.
 *
 * Text formats go through `writeText` and a DOCX package through `writeBytes`,
 * so a binary deliverable reaches disk intact instead of travelling as base64
 * the model would have to decode itself. No per-call sandbox policy is passed:
 * the write runs under the deployment's resolved policy for this session. The
 * returned value names the file instead of carrying it: the document was the
 * render call's whole cost, and repeating it in the result would put it back
 * into every later request.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent cwd).
 * @param rendered - the rendered document.
 * @param outputPath - the caller's absolute or workspace-relative destination.
 * @returns the file's canonical path and bytes beside the render diagnostics.
 */
async function writeRenderedDocument(
  ctx: Context, exec: ToolRunContext, rendered: InlineRenderedDocument, outputPath: string,
): Promise<RenderDocTemplateOutput> {
  const cwd = exec.agent?.session.header.cwd
  const target = await ctx.fs.resolve(outputPath, {
    ...cwd === undefined ? {} : { cwd },
    signal: exec.signal,
  })
  const bytes = rendered.format === 'docx'
    ? Buffer.from(rendered.content, 'base64')
    : Buffer.from(rendered.content, 'utf8')
  if (rendered.format === 'docx') {
    await ctx.fs.writeBytes(target, bytes, undefined, exec.signal)
  } else {
    await ctx.fs.writeText(target, rendered.content, undefined, exec.signal)
  }
  return {
    template: rendered.template,
    format: rendered.format,
    fileName: rendered.fileName,
    mimeType: rendered.mimeType,
    encoding: rendered.encoding,
    residual: rendered.residual,
    warnings: rendered.warnings,
    path: ctx.fs.processPath(target),
    bytes: bytes.length,
  }
}

/**
 * Convert the model's variable object into string values.
 * The parameter schema cannot express a string-valued map, so the values are
 * checked here; a non-string value would otherwise be substituted into the
 * document as its JSON form.
 * @param value - the model's variable object, or `undefined` when it was omitted.
 * @returns the variable values.
 * @throws DocTemplateError when a value is not a string.
 */
export function coerceStringRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  const variables: Record<string, string> = {}
  if (value === undefined) return variables
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new DocTemplateError('variable-invalid', `变量 ${JSON.stringify(name)} 的值必须是字符串。`)
    }
    variables[name] = entry
  }
  return variables
}

/**
 * Render the result for the model. A written document is reported by path and
 * size, with no body: repeating it here would carry the whole document into
 * every later request. An inline render (no `outputPath`) still shows the
 * document, because that is the only copy the caller receives.
 * @param value - the rendered document.
 * @returns the model-facing text.
 */
export function renderDocumentResult(value: RenderDocTemplateOutput): string {
  const lines: string[] = [
    `${value.template} · ${value.format} · ${value.fileName} · ${value.mimeType} · ${value.encoding}`,
    '',
  ]
  if (value.path !== undefined) {
    lines.push(
      `Written to ${value.path} (${String(value.bytes ?? 0)} bytes).`,
      '',
      'The document body is on disk. Read the file to review it; it is not repeated here.',
      '',
    )
  }
  lines.push(
    value.residual.length === 0
      ? 'Residual placeholders: none'
      : `Residual placeholders (${String(value.residual.length)}): ${value.residual.join(', ')}`,
  )
  lines.push(
    value.warnings.length === 0
      ? 'Warnings: none'
      : `Warnings:\n${value.warnings.map(issue => `- ${issue.variable}: ${issue.message}`).join('\n')}`,
  )
  if (value.path !== undefined) return lines.join('\n')
  const body = value.encoding === 'utf8' ? value.content : value.markdown
  if (body !== undefined) lines.push('', '--- document ---', body)
  return lines.join('\n')
}

const DESCRIPTION = [
  '- Renders one document template with supplied variables and reports the written file, or the inline document, beside the placeholders that stayed unfilled and the variable warnings.',
  '- Get the template name and its variables from `list_doc_templates` first. Every required variable must be supplied: a missing one fails the call and names it, rather than returning a document with a hole in it.',
  '- `format` defaults to the template\'s fallback format; a template only renders to the formats it lists. `markdown` is the resolved body before the injected document title and style disclaimer.',
  '- Deliverables pass `output_path` (workspace-relative or absolute): the document is written through the session filesystem and the result reports `path`, `bytes`, `residual`, and `warnings` without repeating the body. Read the file with `read` when you need to review or verify it. Text formats write UTF-8; `docx` writes the package bytes.',
  '- `docx` requires `output_path`. The package is never returned in the result, base64 or otherwise.',
  '- Omit `output_path` only for a small inline render of `markdown` or `html`; the result then carries `content` and `markdown`. Use `output_path` for anything delivered to a user.',
  '- Variables are substituted by name; a placeholder with no supplied value stays in the document and is reported under `residual` instead of being erased. Both residual placeholders and warnings are returned for every successful render: read them before treating a document as final.',
  '',
  'Usage notes:',
  '  - Offline; renders the packaged template assets, the configured override directories, and the packaged styles.',
  '  - A template that declares a writing style carries that style\'s disclaimer into the rendered document when the deployment enabled disclaimers.',
  '  - A write is governed by the deployment\'s file policy; a denied `output_path` fails the call with the filesystem error.',
].join('\n')

const WARNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    variable: { type: 'string', required: true },
    code: { type: 'string', required: true, enum: VAR_ISSUE_CODES },
    message: { type: 'string', required: true },
  },
} as const

/**
 * Build the `render_doc_template` tool.
 * @param ctx - plugin context carrying `ctx.fs` for a write to `output_path`.
 * @param store - the loaded templates and styles.
 * @returns the tool definition.
 */
export function createRenderDocTemplateTool(ctx: Context, store: TemplateStore): ToolDefinition {
  return defineTool({
    name: 'render_doc_template',
    description: DESCRIPTION,
    parameters: {
      template: { type: 'string', required: true, description: 'Template name from list_doc_templates' },
      variables: {
        type: 'object',
        additionalProperties: true,
        description: 'Variable values keyed by variable name, without the {{}} wrapping; values are strings',
      },
      format: {
        type: 'string',
        enum: OUTPUT_FORMATS,
        description: 'Output format: markdown, html, or docx (default markdown)',
      },
      title: { type: 'string', description: 'Document title override; defaults to the template title' },
      author: { type: 'string', description: 'Author or attorney, written into the HTML metadata' },
      date: { type: 'string', description: 'Document date, written into the HTML metadata' },
      filename: { type: 'string', description: 'Suggested file name stem without extension; defaults to the template name' },
      output_path: {
        type: 'string',
        description: 'Write the rendered document here (workspace-relative or absolute) and report path and bytes; required for docx, and the normal choice for any delivered file',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: OUTPUT_FORMATS },
          fileName: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          encoding: { type: 'string', required: true, enum: ['utf8', 'base64'] },
          content: { type: 'string', description: 'Inline render only: the rendered text; absent when the document was written to path' },
          markdown: { type: 'string', description: 'Inline render only: the resolved Markdown body; absent when the document was written to path' },
          residual: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: WARNING_SCHEMA },
          path: { type: 'string', description: 'Canonical path written, when output_path was supplied' },
          bytes: { type: 'number', description: 'Bytes written to path, when output_path was supplied' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDocumentResult(value) }],
    },
    async execute(args, exec) {
      const input: RenderDocTemplateInput = {
        template: args.template,
        variables: coerceStringRecord(args.variables),
        ...(args.format === undefined ? {} : { format: args.format }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.author === undefined ? {} : { author: args.author }),
        ...(args.date === undefined ? {} : { date: args.date }),
        ...(args.filename === undefined ? {} : { filename: args.filename }),
        ...(args.output_path === undefined ? {} : { outputPath: args.output_path }),
      }
      // Rendering is pure over the loaded assets; only an explicit output_path
      // turns this call into a filesystem mutation.
      const rendered = renderDocTemplate(store, input)
      if (input.outputPath === undefined) {
        // A DOCX package has no inline form the model can use: base64 in the
        // result would be re-sent on every later request, and the model cannot
        // decode it. Requiring the write keeps the package on disk.
        if (rendered.format === 'docx') {
          throw new DocTemplateError(
            'output-path-required',
            'docx 结果必须传 output_path 由工具写盘；结果里不返回包内容。',
          )
        }
        return rendered
      }
      return writeRenderedDocument(ctx, exec, rendered, input.outputPath)
    },
  })
}
