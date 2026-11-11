/**
 * `render_patent_document` tool: render a patent-attorney deliverable from one
 * of the thirteen shipped Chinese HTML templates into an HTML file and, by default,
 * a headless-Chrome PDF.
 * @module @deepseek-ai/dsh-patent-document/tool/render-patent-document
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SPEC_DRAFT_SCHEMA, TEMPLATE_DRAFT_SCHEMA, validateSpecDraft, validateTemplateDraft, type SpecDraft, type TemplateDraft } from '@deepseek-ai/dsh-patent-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { DocumentRenderError } from '../document/errors.ts'
import { FORM_TEMPLATE_SCHEMAS, GENERIC_TEMPLATE_SCHEMAS, isFormTemplateId } from '../document/draftSchema/index.ts'
import { renderPatentDocument } from '../document/renderPatentDocument.ts'
import type { DocumentRenderResult } from '../document/types.ts'

/** 十三个随包分发的模板 id，与 manifest.json 的 templates 列表一致。 */
export const TEMPLATE_IDS = [
  'patentability-opinion',
  'search-report',
  'oa-response',
  'claims-spec',
  'invalidation-opinion',
  'invalidation-analysis',
  'invalidation-defense',
  'rectification-response',
  're-examination-request',
  'infringement-opinion',
  'litigation-pleading',
  'right-evaluation-report',
  'search-report-form',
] as const

const DESCRIPTION = [
  'Render a patent-attorney deliverable (patentability opinion, search report, OA response, claims-spec chart, invalidation request, internal invalidation analysis, invalidation defense, rectification response, re-examination request, infringement opinion, litigation pleading, right-evaluation report, or search report form) from a shipped Chinese HTML template into files on disk. Pick a template id and an outputName; all thirteen templates accept a controlled draft (the draft parameter). The claims-spec filing document takes the SpecDraft structure: bibliographic meta, unnumbered claims, multi-paragraph abstract, figureFiles, the abstract figure number, and the five specification parts as paragraph/list/table blocks; the drawing-description part lists one entry per figure, and that entry count must equal the figureFiles count; each entry carries only the figure name and description text, with no figure number prefix or terminal punctuation (the renderer adds 「图N为」 and 。/；). The ten document templates take id-keyed drafts: fields fill leaf text slots (meta, footer), and sections carry blocks (paragraph/list/table, table captions generated), rows (equal-width string arrays cloned into the template table body), or grounds (reason entries: article, ground name, contested claim numbers, and the four-part body; the section heading joins the contested claims and the reason with the template\'s own relation word — the requester side reads "权利要求 1 不具备创造性", the patentee side "权利要求 1 的创造性" — and the four-part sub-headings are generated, so the draft never authors a reason heading). invalidation-opinion renders the external request; invalidation-analysis renders the internal opinion that may carry the citation log, outcome tiers, and gap disclosure; invalidation-defense renders the patentee-side reply, whose per-reason answers reuse that generated section skeleton with the template\'s relation word. The two form templates take form drafts with text and checkbox choice slots plus blocks/rows sections. Draft-driven templates generate headings, claim numbers, figure numbers, table captions, and checkbox states from the structure — never author markup. draft is required for every template; the legacy sections innerHTML parameter is gone, and callers passing it are rejected at the argument gate. Writes an HTML file, and by default also a PDF through headless Chrome (format: html, pdf, or both; default both). Returns the written file paths plus any warnings or the PDF failure reason (the HTML still exists when the PDF fails).',
].join('\n')
/** 输出 canonical 值的 JSON schema（与 DocumentRenderResult 对应）。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    htmlPath: { type: 'string', required: true },
    pdfPath: { type: 'string' },
    pdfError: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

/**
 * 将渲染结果渲染为模型可读文本。
 * @param value - 渲染结果。
 * @returns 多行路径 + 告警 + PDF 失败说明。
 */
export function renderDocumentResult(value: DocumentRenderResult): string {
  const lines: string[] = [`HTML written: ${value.htmlPath}`]
  if (value.pdfPath !== undefined) lines.push(`PDF written: ${value.pdfPath}`)
  if (value.pdfError !== undefined) lines.push(`PDF not written: ${value.pdfError} (the HTML file is still available)`)
  for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
  return lines.join('\n')
}

/**
 * 将 JSON 对象记录强转为字符串值记录。
 * @param value - 待强转的记录。
 * @param field - 参数字段名（用于报错）。
 * @returns 字符串值记录；非字符串值抛输入契约错误。
 */
function coerceStringRecord(value: Record<string, JsonValue>, field: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new DocumentRenderError(`${field} 的键 "${key}" 必须是字符串`)
    }
    result[key] = entry
  }
  return result
}

/** 工具工厂依赖：subprocess 服务与 Chrome/目录覆盖。 */
export interface RenderPatentDocumentToolOptions {
  /** 注入的 subprocess 服务（ctx.subprocess）。 */
  subprocess: SubprocessRuntime
  /** Chrome 可执行文件覆盖。 */
  chromePath?: string
  /** 缺省输出目录（相对 cwd）。 */
  defaultOutputDir?: string
  /** Chrome 无头打印超时（毫秒；与 Config.pdfTimeoutMs 同源）。 */
  pdfTimeoutMs?: number
}

/**
 * 构造 render_patent_document 工具。
 * @param options - 工具依赖与覆盖。
 * @returns 可注册的工具定义。
 */
export function createRenderPatentDocumentTool(options: RenderPatentDocumentToolOptions): ToolDefinition {
  return defineTool({
    name: 'render_patent_document',
    description: DESCRIPTION,
    parameters: {
      template: {
        type: 'string',
        required: true,
        enum: TEMPLATE_IDS,
        description: 'Template id to render (one of the thirteen shipped patent templates).',
      },
      outputName: {
        type: 'string',
        required: true,
        description: 'Output filename stem (no extension); letters, digits, underscore, hyphen, dot, parentheses, Chinese characters, circled numerals (①–⑳), and common Chinese punctuation (a Chinese draft name is accepted as written). No spaces, no path separators, no "..".',
      },
      caseId: {
        type: 'string',
        description: 'Optional case id; when given the result lands in data/cases/<caseId>/outputs/ instead of the default directory.',
      },
      outputDir: {
        type: 'string',
        description: 'Optional explicit output directory, resolved against the working directory. Paths whose real location leaves the working directory are rejected.',
      },
      format: {
        type: 'string',
        enum: ['html', 'pdf', 'both'] as const,
        description: 'Output format: html, pdf, or both (default both).',
      },
      draft: {
        oneOf: [SPEC_DRAFT_SCHEMA, TEMPLATE_DRAFT_SCHEMA],
        required: true,
        description: 'Controlled draft. Exactly one branch: SpecDraft when template is claims-spec (meta, claims, abstract, figureFiles, optional abstractFigure, and sections as an object of five JSON arrays of blocks), or a template draft for every other template (optional fields object, sections as a JSON array of blocks, rows, or grounds entries). List fields are JSON arrays. Submit each array itself. If validation reports that the draft matched 0 oneOf branches, remove any object wrapper whose key is item. Claims stay unnumbered. The drawing-description part lists one entry per figure, with no 图N为 prefix and no terminal punctuation. Tables are allowed only in embodiment. For a drawing-free invention pass empty figureFiles and drawingDescriptions arrays and omit abstractFigure. Unknown or missing slots still fail with the slot list.',
      },
      brand: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional inline brand overrides (keys map to the --sati-doc-* CSS variables, e.g. firm, accent).',
      },
      brandPath: {
        type: 'string',
        description: 'Optional path to a theme.json whose documents.patent namespace supplies brand overrides. Must stay inside the working directory.',
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDocumentResult(value) }],
    },
    async execute(args, exec) {
      const brand = args.brand === undefined ? undefined : coerceStringRecord(args.brand, 'brand')
      // 旧 sections 参数已从 schema 删除：执行器的参数校验会以防缺 required draft 拒绝，到不了这里。
      let draft: SpecDraft | undefined
      let templateDraft: TemplateDraft | undefined
      if (args.template === 'claims-spec') {
        // validateSpecDraft 的契约是只抛 DraftValidationError（消息已列出可用槽位），直接传播。
        draft = validateSpecDraft(args.draft)
      } else if (isFormTemplateId(args.template)) {
        templateDraft = validateTemplateDraft(args.draft, FORM_TEMPLATE_SCHEMAS[args.template])
      } else {
        templateDraft = validateTemplateDraft(args.draft, GENERIC_TEMPLATE_SCHEMAS[args.template])
      }
      const result = await renderPatentDocument(
        {
          template: args.template,
          outputName: args.outputName,
          ...(args.caseId !== undefined ? { caseId: args.caseId } : {}),
          ...(args.outputDir !== undefined ? { outputDir: args.outputDir } : {}),
          ...(args.format !== undefined ? { format: args.format } : {}),
          ...(draft !== undefined ? { draft } : {}),
          ...(templateDraft !== undefined ? { templateDraft } : {}),
          ...(brand !== undefined ? { brand } : {}),
          ...(args.brandPath !== undefined ? { brandPath: args.brandPath } : {}),
        },
        process.cwd(),
        {
          subprocess: options.subprocess,
          ...(options.chromePath !== undefined ? { chromePath: options.chromePath } : {}),
          ...(options.defaultOutputDir !== undefined ? { defaultOutputDir: options.defaultOutputDir } : {}),
          ...(options.pdfTimeoutMs !== undefined ? { pdfTimeoutMs: options.pdfTimeoutMs } : {}),
          signal: exec.signal,
        },
      )
      const out: { htmlPath: string; pdfPath?: string; pdfError?: string; warnings: string[] } = {
        htmlPath: result.htmlPath,
        warnings: result.warnings,
      }
      if (result.pdfPath !== undefined) out.pdfPath = result.pdfPath
      if (result.pdfError !== undefined) out.pdfError = result.pdfError
      return out
    },
  })
}
