/**
 * src/draft — 受控草案模型与校验（patent 域共享）。
 *
 * 模型不再产出 HTML（标题、表格标记、innerHTML），而是提交结构化草案；
 * 标题与表格由转换器按结构生成（by construction），渲染层不再接受模型可控标签。
 * claims-spec 申请文件使用 {@link SpecDraft}，其余模板使用 {@link TemplateDraft}；
 * 两通道（claims-spec HTML/PDF 与 build_patent_filing docx）共用同一份草案。
 */

export {
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  type DraftBlock,
  type DraftGroundItem,
  type SpecDraft,
  type SpecDraftMeta,
  type SpecPartId,
  type TemplateChoiceOption,
  type TemplateDraft,
  type TemplateDraftSchema,
  type TemplateDraftSection,
  type TemplateFieldSlot,
  type TemplateSectionSlot,
} from './types.ts'
export {
  numberedFigureDescriptions,
  type NumberedFigureDescription,
} from './figureDescriptions.ts'
export { formatTableCaption } from './tableCaption.ts'
export { SPEC_DRAFT_SCHEMA, TEMPLATE_DRAFT_SCHEMA } from './schema.ts'
export { DraftValidationError, validateSpecDraft, validateTemplateDraft } from './validate.ts'
