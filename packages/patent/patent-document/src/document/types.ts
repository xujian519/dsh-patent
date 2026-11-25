/**
 * 专利律师交付物 HTML/PDF 渲染管线类型（自 Sati src/patent/document/types.ts 移植）。
 * @module @deepseek-ai/dsh-patent-document/document/types
 */

import type { SpecDraft, TemplateDraft } from '@deepseek-ai/dsh-patent-core'

/** 受 manifest.json 支持的模板 id。 */
export type DocumentTemplateId =
  | 'patentability-opinion'
  | 'search-report'
  | 'oa-response'
  | 'claims-spec'
  | 'invalidation-opinion'
  | 'invalidation-analysis'
  | 'invalidation-defense'
  | 'rectification-response'
  | 're-examination-request'
  | 'infringement-opinion'
  | 'litigation-pleading'
  | 'right-evaluation-report'
  | 'search-report-form'

/** 渲染输出格式。 */
export type RenderFormat = 'html' | 'pdf' | 'both'

/** 品牌覆盖：键名对应 assets/templates/patent/tokens.css 中的 --sati-doc-* 变量。 */
export type DocumentBrand = Partial<Record<string, string>>

/** 渲染请求输入。 */
export type DocumentRenderInput = {
  /** 模板 id（需存在于 assets/templates/patent/manifest.json）。 */
  template: DocumentTemplateId
  /** 输出文件名主干（不含扩展名）。 */
  outputName: string
  /**
   * 案号。与 `workRoot`（`workbenchCaseRoot`）一起选定案卷目录。
   * 未传 `outputDir` 时，成品写在该案卷目录的既有布局子目录内。
   */
  caseId?: string
  /** 显式输出目录。优先于案卷目录；真实位置必须留在工作目录内。 */
  outputDir?: string
  /** 输出格式：html / pdf / both（默认 both）。 */
  format?: RenderFormat
  /**
   * claims-spec 受控草案（已通过 validateSpecDraft）：标题、权项编号与表题由
   * 转换器生成。仅 claims-spec 接受；与 templateDraft 互斥。
   */
  draft?: SpecDraft
  /**
   * 表单与通用文档模板的受控草案（已通过 validateTemplateDraft + 注册表 schema
   * 校验）：表单模板的 text/choice/rows/blocks 槽位按 data-slot 注入，通用文档
   * 模板的 fields/sections 槽位按元素 id 注入。与 draft 互斥。
   */
  templateDraft?: TemplateDraft
  /** 内联品牌覆盖（优先级高于 brandPath）。 */
  brand?: DocumentBrand
  /** 指向 theme.json 的显式路径；本包不随包分发默认品牌文件。 */
  brandPath?: string
}

/** 渲染结果。 */
export type DocumentRenderResult = {
  /** 生成的 HTML 文件绝对路径。 */
  htmlPath: string
  /** 生成的 PDF 文件绝对路径（format=html 时不生成）。 */
  pdfPath?: string
  /** PDF 生成失败原因（HTML 已生成时的降级提示）。 */
  pdfError?: string
  /** 非致命告警（未命中的 section id、品牌配置缺失等）。 */
  warnings: string[]
}
