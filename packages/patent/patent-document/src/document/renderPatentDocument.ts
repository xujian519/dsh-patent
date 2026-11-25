/**
 * 专利文书渲染核心：模板 HTML + 品牌注入 + 按 id 替换内容 + HTML/PDF 落盘。
 * @module @deepseek-ai/dsh-patent-document/document/renderPatentDocument
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertDeliverableName, resolveConfinedPath, resolvePatentOutputDir, type MatterLayoutDir } from '@deepseek-ai/dsh-patent-core'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { buildBrandStyle, loadBrandFromPath, mergeBrand } from './brandInjector.ts'
import { checkDocumentCompliance } from './documentCompliance.ts'
import { DocumentRenderError } from './errors.ts'
import { findMatchingCloseTag } from './htmlScan.ts'
import { applyParagraphNumbering } from './paragraphNumbering.ts'
import { DEFAULT_PDF_TIMEOUT_MS, renderPdf } from './pdfRenderer.ts'
import { foldEmptyOptionalSections, renumberSections } from './sectionFold.ts'
import { isInternalRecordTemplate, readTemplateHtml } from './templateResolver.ts'
import type { DocumentRenderInput, DocumentRenderResult, DocumentTemplateId, RenderFormat } from './types.ts'
import { isFormTemplateId, isGenericTemplateId } from './draftSchema/index.ts'
import { groundsSectionStyles } from './draftSchema/generic.ts'
import { injectTemplateDraft, renderGenericTemplateSections, renderSpecDraftSections } from './draftConverter/index.ts'

/**
 * 历史输出目录 `.dsh/documents`。
 * 只在调用方显式传入 `outputDir` 或 `outputRoot` 时使用，不会自动成为写入根。
 */
export const DEFAULT_OUTPUT_DIR = '.dsh/documents'

/**
 * 模板对应的案卷布局子目录。名字都来自 patent-workspace-layout：
 * 检索报告在 `01-检索`，申请文件在 `04-撰写`，分析与比对意见在 `03-分析`，
 * 答复、补正与复审文书在 `05-答复`。诉讼文书与无效意见归入 `03-分析`。
 */
const TEMPLATE_LAYOUT_DIR: Record<DocumentTemplateId, MatterLayoutDir> = {
  'patentability-opinion': '03-分析',
  'search-report': '01-检索',
  'oa-response': '05-答复',
  'claims-spec': '04-撰写',
  'invalidation-opinion': '03-分析',
  'invalidation-analysis': '03-分析',
  'invalidation-defense': '05-答复',
  'rectification-response': '05-答复',
  're-examination-request': '05-答复',
  'infringement-opinion': '03-分析',
  'litigation-pleading': '03-分析',
  'right-evaluation-report': '03-分析',
  'search-report-form': '01-检索',
}

/**
 * 渲染专利文书所需的运行期依赖与写入根。
 */
export interface RenderPatentDocumentOptions {
  /** 注入的 subprocess 服务（ctx.subprocess），用于 headless Chrome 打印 PDF。 */
  subprocess: SubprocessRuntime
  /** Chrome 可执行文件覆盖；缺省时按 DSH_CHROME_PATH/CHROME_PATH/内置候选探测。 */
  chromePath?: string
  /** `workbenchCaseRoot`。与案号一起解析案卷目录。 */
  workRoot?: string
  /**
   * 显式部署覆盖。案卷目录无法解析、且调用未传 outputDir、也未点名案号时使用。
   * 缺省不回落 `.dsh/documents`。
   */
  outputRoot?: string
  /** 调用方取消信号；触发后终止 headless Chrome 进程树。 */
  signal?: AbortSignal
  /** Chrome 无头打印超时（毫秒）；缺省取 pdfRenderer 的导出默认值。 */
  pdfTimeoutMs?: number
}

/**
 * 校验输入字符串是合法的交付名，否则抛出 DocumentRenderError。
 * @param value - 待校验字符串。
 * @param label - 错误消息中的字段名（输出文件名 / 案卷号）。
 * @returns 通过校验的字符串。
 */
function assertSafeName(value: string, label: string): string {
  assertDeliverableName(value, label, message => new DocumentRenderError(message))
  return value
}

/**
 * 解析品牌配置路径。
 *
 * brandPath 的真实位置必须留在 cwd 内：模型控制的路径若允许任意绝对路径，
 * 会读取任意文件并作为 CSS 注入（信息泄露）。cwd 内的绝对路径照常接受。
 * @param input - 渲染输入。
 * @param cwd - 相对路径基准目录。
 * @returns 品牌配置绝对路径，未提供时 undefined。
 * @throws DocumentRenderError 当 brandPath 解析后的真实路径落在 cwd 之外。
 */
function resolveBrandPath(input: DocumentRenderInput, cwd: string): string | undefined {
  if (input.brandPath === undefined) return undefined
  return resolveConfinedPath(input.brandPath, cwd, '品牌配置路径', message => new DocumentRenderError(message))
}

/**
 * 将品牌 CSS 注入到 HTML 的 <head>（放在现有 <style> 之前，确保覆盖默认变量）。
 * @param html - 模板 HTML。
 * @param brandCss - 品牌 CSS 文本。
 * @returns 注入后的 HTML。
 */
function injectBrandCss(html: string, brandCss: string): string {
  const style = `<style>\n${brandCss}\n</style>`
  const headMatch = html.match(/<head[^>]*>/i)
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length
    return html.slice(0, insertAt) + '\n' + style + '\n' + html.slice(insertAt)
  }
  return style + '\n' + html
}

/**
 * 将注入映射按元素 id 替换为 innerHTML（claims-spec 与通用文档草案的内部注入器）。
 *
 * 命中 `<section id="x">` 时替换的是该 section 的**全部**内层内容；映射只覆盖
 * 注册槽位 id，转换器生成的槽位内容不含骨架包装与章节标题，因此骨架保持原位。
 * @param html - 模板 HTML。
 * @param sections - id → 内容映射。
 * @returns 替换后的 HTML，以及被跳过（未命中/非法）的 id 列表。
 */
function injectSections(
  html: string,
  sections: Record<string, string>,
): { html: string; skippedIds: string[] } {
  let result = html
  const skippedIds: string[] = []
  for (const [id, content] of Object.entries(sections)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      skippedIds.push(id)
      continue
    }
    const openPattern = new RegExp(`<([A-Za-z][A-Za-z0-9]*)[^>]*id=["']${id}["'][^>]*>`, 'i')
    const openMatch = openPattern.exec(result)
    if (openMatch === null) {
      skippedIds.push(id)
      continue
    }
    const openTag = openMatch[0]
    const closeStart = findMatchingCloseTag(result, openMatch.index + openTag.length)
    if (closeStart === undefined) {
      skippedIds.push(id)
      continue
    }
    result = result.slice(0, openMatch.index) + openTag + content + result.slice(closeStart)
  }
  return { html: result, skippedIds }
}

/**
 * 解析本次渲染的受控草案注入：claims-spec 走 SpecDraft（转换器生成结构），
 * 其余十二个模板走 templateDraft（表单按 data-slot 注入，通用文档按元素 id 注入）。
 * 两种草案互斥；都不传时按模板骨架原样渲染。
 * @param html - 模板 HTML（品牌注入后）。
 * @param input - 渲染输入。
 * @returns 注入后的 HTML，以及未命中模板的草稿 section id。
 */
function resolveDraft(html: string, input: DocumentRenderInput): { html: string; skippedIds: string[] } {
  if (input.draft !== undefined) {
    if (input.templateDraft !== undefined) {
      throw new DocumentRenderError('draft 与 templateDraft 互斥：一次渲染只传一份草案')
    }
    if (input.template !== 'claims-spec') {
      throw new DocumentRenderError(`模板 ${input.template} 不接受 SpecDraft 草案：draft 的 claims-spec 结构仅用于 claims-spec；其余模板用表单/通用草案结构（同样走 draft 参数）`)
    }
    return injectSections(html, { ...renderSpecDraftSections(input.draft) })
  }
  if (input.templateDraft !== undefined) {
    if (input.template === 'claims-spec') {
      throw new DocumentRenderError('claims-spec 请用 draft 参数（SpecDraft 结构）：templateDraft 仅用于其余十二个模板')
    }
    if (isFormTemplateId(input.template)) {
      return { html: injectTemplateDraft(html, input.template, input.templateDraft), skippedIds: [] }
    }
    return injectSections(html, renderGenericTemplateSections(
      html,
      input.templateDraft,
      groundsSectionStyles(input.template),
    ))
  }
  return { html, skippedIds: [] }
}

/**
 * 折叠「槽位无内容」的可选块，并在确实折叠过时重编章节序号。
 *
 * 只有通用文档模板路径生效：表单模板按 data-slot 注入、claims-spec 由转换器重建结构，
 * 两者的章节由注册表决定，不存在「模板写了、草案没给」的空节。告警随渲染结果返回，
 * 让人工知道成品比模板少哪几节——少节是可感知的改动，不能悄悄发生。
 * @param html - 草案注入后的 HTML。
 * @param input - 渲染输入。
 * @param warnings - 渲染告警收集数组。
 * @returns 折叠（必要时重编号）后的 HTML。
 */
function foldDraftSections(html: string, input: DocumentRenderInput, warnings: string[]): string {
  if (input.templateDraft === undefined || !isGenericTemplateId(input.template)) return html
  const present = new Set(input.templateDraft.sections.map(section => section.id))
  const folded = foldEmptyOptionalSections(html, present)
  for (const block of folded.folded) {
    warnings.push(`已折叠空节：${block.title}（槽位 ${block.id} 无内容）`)
  }
  // 没折叠过就不重编号：其他模板的既有编号一个字符都不动。
  return folded.folded.length === 0 ? folded.html : renumberSections(folded.html)
}

/**
 * 渲染并落盘专利文书（HTML，可选 PDF）。
 * @param input - 渲染输入。
 * @param cwd - 相对路径基准目录。
 * @param options - 注入的 subprocess 服务与 Chrome/目录覆盖。
 * @returns 生成的 HTML/PDF 路径、PDF 错误与告警。
 */
export async function renderPatentDocument(
  input: DocumentRenderInput,
  cwd: string,
  options: RenderPatentDocumentOptions,
): Promise<DocumentRenderResult> {
  const warnings: string[] = []

  const outputDir = resolvePatentOutputDir(
    input,
    cwd,
    {
      layoutDir: TEMPLATE_LAYOUT_DIR[input.template],
      ...(options.workRoot === undefined ? {} : { workRoot: options.workRoot }),
      ...(options.outputRoot === undefined ? {} : { outputRoot: options.outputRoot }),
    },
    message => new DocumentRenderError(message),
  )
  await mkdir(outputDir, { recursive: true })

  const name = assertSafeName(input.outputName, '输出文件名')
  const htmlPath = join(outputDir, `${name}.html`)
  const pdfPath = join(outputDir, `${name}.pdf`)

  const brandPath = resolveBrandPath(input, cwd)
  const fromConfig = loadBrandFromPath(brandPath)
  const brand = mergeBrand(input.brand, fromConfig)

  let html = readTemplateHtml(input.template)
  html = injectBrandCss(html, buildBrandStyle(brand))
  const drafted = resolveDraft(html, input)
  html = drafted.html
  if (drafted.skippedIds.length > 0) {
    warnings.push(`以下 section id 未命中模板，内容已忽略: ${drafted.skippedIds.join(', ')}`)
  }
  html = foldDraftSections(html, input, warnings)
  // 段落编号由模板通过 data-paragraph-numbering 声明；引擎把编号写成字面文本，
  // 使 PDF 与下游 HTML→docx 转制读到同一串字符。
  html = applyParagraphNumbering(html).html
  // 内部记录模板（内部无效分析意见）正是内部评估与待办的存放处，只做章节编号检查。
  const complianceScope = isInternalRecordTemplate(input.template) ? 'internal-record' : 'external-filing'
  for (const issue of checkDocumentCompliance(html, complianceScope)) {
    warnings.push(issue.message)
  }

  await writeFileAtomic(htmlPath, html, { mode: 0o644 })

  const format: RenderFormat = input.format ?? 'both'
  let renderedPdfPath: string | undefined
  let pdfError: string | undefined
  if (format === 'pdf' || format === 'both') {
    const pdfResult = await renderPdf(
      options.subprocess,
      htmlPath,
      pdfPath,
      {
        ...(options.chromePath !== undefined ? { chromePath: options.chromePath } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        pdfTimeoutMs: options.pdfTimeoutMs ?? DEFAULT_PDF_TIMEOUT_MS,
      },
    )
    if (pdfResult.ok) {
      renderedPdfPath = pdfResult.path
    } else {
      pdfError = pdfResult.error
    }
  }

  const result: DocumentRenderResult = { htmlPath, warnings }
  if (renderedPdfPath !== undefined) result.pdfPath = renderedPdfPath
  if (pdfError !== undefined) result.pdfError = pdfError
  return result
}
