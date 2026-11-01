/**
 * Specification structure: which parts are required for the application's
 * patent type and drawing situation, and whether the text actually carries
 * them.
 *
 * 《专利审查指南》第二部分第二章 2.3 allows an invention without drawings; a
 * utility model must have drawings (《专利法》第二十七条；指南第一部分第二章
 * 6.1). The required-section set is therefore computed per application instead of
 * being the fixed five parts.
 */

import type { PatentType } from './draft-claims.ts'
import type { FigureAnalysisResult, SpecViolation, ValidateSpecificationInput } from './spec-types.ts'
import {
  declaresNoDrawings,
  drawingSectionHasFigures,
  figureNumbersIn,
  withoutDrawingSection,
} from './spec-figure-marks.ts'
import { SPEC_SECTION_HEADINGS } from './spec-style.ts'

/**
 * Sections required for one application.
 * @param patentType - invention or utility model.
 * @param hasDrawings - whether the application has drawings.
 * @returns the required section names in the prescribed order.
 */
export function requiredSections(patentType: PatentType, hasDrawings: boolean): readonly string[] {
  return SPEC_SECTION_HEADINGS.filter(name => name !== '附图说明' || hasDrawings || patentType === 'utility_model')
}

/**
 * Infer whether the application has drawings from the text and supplied analysis.
 * @param text - the specification text.
 * @param figureAnalysis - the figure-analysis results, when supplied.
 * @returns true when a drawing section declares figures, analysis covers a figure, or the body references one.
 */
export function inferHasDrawings(text: string, figureAnalysis?: FigureAnalysisResult[]): boolean {
  if (figureAnalysis !== undefined && figureAnalysis.length > 0) return true
  if (drawingSectionHasFigures(text)) return true
  if (declaresNoDrawings(text)) return false
  return figureNumbersIn(text).length > 0
}

/**
 * Resolve structure inputs and report missing/invalid parts.
 * @param input - the specification input under validation.
 * @param text - the specification text.
 * @param present - the recognized section names present in the text.
 * @returns structure violations plus the resolved type and drawing state.
 */
export function checkStructure(
  input: ValidateSpecificationInput,
  text: string,
  present: ReadonlySet<string>,
): { violations: SpecViolation[]; patentType: PatentType; hasDrawings: boolean } {
  const violations: SpecViolation[] = []
  const patentType = input.patent_type ?? 'invention'
  if (input.patent_type === undefined) {
    violations.push({
      rule: 'patent_type_assumed',
      family: 'structure',
      severity: 'warning',
      message: '未声明专利类型，按发明专利检查；实用新型的结构要求更严格',
      suggestion: '传入 patent_type（invention / utility_model），避免把实用新型按发明放行',
    })
  }
  const hasDrawings = input.has_drawings ?? inferHasDrawings(text, input.figure_analysis)
  const required = requiredSections(patentType, hasDrawings)

  if (text.trim().length === 0) {
    violations.push({
      rule: 'sections',
      family: 'structure',
      severity: 'error',
      message: '说明书缺少所有必要章节（text 为空）',
      suggestion: '请提供说明书全文',
    })
    return { violations, patentType, hasDrawings }
  }

  const missing = required.filter(name => !present.has(name))
  if (missing.length > 0) {
    violations.push({
      rule: 'sections',
      family: 'structure',
      severity: 'error',
      message: `缺少必要章节：${missing.join('、')}`,
      suggestion: `请按顺序撰写${required.join('、')}`,
    })
  }

  if (patentType === 'utility_model' && !hasDrawings) {
    violations.push({
      rule: 'utility_model_drawings',
      family: 'structure',
      severity: 'error',
      message: '实用新型必须附带附图，但当前文本没有附图（《专利法》第二十七条；《专利审查指南》第一部分第二章 7.3）',
      suggestion: '补充至少一幅附图并在附图说明中列出图名',
    })
  }

  if (present.has('附图说明') && !drawingSectionHasFigures(text) && !declaresNoDrawings(text)) {
    violations.push({
      rule: 'drawing_section_without_drawings',
      family: 'structure',
      severity: 'error',
      section: '附图说明',
      message: '说明书列有「附图说明」章节，但没有任何图号或附图内容',
      suggestion: '按图序补充各幅附图的图名，或删除该章节并在申请中声明无附图',
    })
  }

  if (input.has_drawings === false) {
    const bodyRefs = figureNumbersIn(withoutDrawingSection(text))
    if (bodyRefs.length > 0) {
      violations.push({
        rule: 'declared_no_drawings_with_refs',
        family: 'structure',
        severity: 'error',
        message: `已声明本申请无附图，但正文仍引用${[...new Set(bodyRefs)].map(n => `图${n}`).join('、')}`,
        suggestion: '删除正文中的图号引用，或改为有附图并补充附图说明与图面',
      })
    }
  }

  return { violations, patentType, hasDrawings }
}
