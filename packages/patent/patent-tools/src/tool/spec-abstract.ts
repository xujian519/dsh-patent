/**
 * Abstract checks: length, keywords, claim references, reference-mark
 * parentheses, commercial advertising, and the requested abstract figure.
 *
 * The abstract figure number comes from the request form
 * (`abstract_figure_number`); it is never inferred from a phrase in the abstract
 * body, because that phrase is not part of the abstract text.
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-abstract
 */

import { knownFigureNumbers } from './spec-figure-marks.ts'
import { COMMERCIAL_ADVERTISING_TERMS } from './spec-prohibitions.ts'
import type { SpecViolation, ValidateSpecificationInput } from './spec-types.ts'

/**
 * Chinese words that commonly precede a quantity rather than a reference mark.
 * A name followed by digits is only a reference mark when it names a component.
 */
const QUANTITY_WORDS = [
  '长度', '宽度', '高度', '厚度', '深度', '温度', '压力', '浓度', '速度',
  '时间', '距离', '重量', '质量', '比例', '含量', '电压', '电流', '功率',
  '频率', '数量', '次数', '直径', '半径', '面积', '体积', '角度', '百分比',
] as const

/** Name-plus-digits that are figure references or procedural labels, not component marks. */
const NON_MARK_NAME = /^(?:图|附图|权利要求|实施例|步骤|表|式)$|(?:图|权利要求|实施例|步骤|方案|方式)$/

/**
 * Find a component mark written without parentheses in the abstract.
 * `壳体1` is a defect; `图1` and `长度为2` are not.
 * @param abstract - the abstract text.
 * @returns the offending phrase, or undefined when every mark is parenthesized.
 */
function unparenthesizedMark(abstract: string): string | undefined {
  const pattern = /([\u4e00-\u9fff]{2,10})(\d{1,3})(?=[，。；、\s]|$)/g
  for (const match of abstract.matchAll(pattern)) {
    /* v8 ignore next -- the pattern always captures the name group. */
    const name = match[1] ?? ''
    if (NON_MARK_NAME.test(name)) continue
    if (QUANTITY_WORDS.some(word => name.includes(word))) continue
    // A parenthesized mark is correct and already ends with `）`; the pattern
    // only reaches the digits when no closing parenthesis follows.
    return match[0]
  }
  return undefined
}

/**
 * Check the abstract against the formal requirements that deterministic rules
 * can decide.
 * @param input - the specification input under validation.
 * @param hasDrawings - whether the application has drawings.
 * @returns abstract violations, in report order.
 */
export function checkAbstract(input: ValidateSpecificationInput, hasDrawings: boolean): SpecViolation[] {
  const violations: SpecViolation[] = []
  const abstract = input.abstract?.trim() ?? ''
  if (abstract.length === 0) return violations

  if (Array.from(abstract).length > 300) {
    violations.push({
      rule: 'abstract_length',
      family: 'abstract',
      severity: 'error',
      section: '摘要',
      message: `摘要超过 300 字限制（${Array.from(abstract).length} 字）`,
      suggestion: '请压缩至 300 字以内',
    })
  }
  if (!/关键词|关键字/.test(abstract)) {
    violations.push({
      rule: 'abstract_keywords',
      family: 'abstract',
      severity: 'warning',
      section: '摘要',
      message: '摘要未包含关键词',
      suggestion: '在摘要末尾添加关键词，如“关键词：…；…”，便于检索分类',
    })
  }
  const claimReference = /权利要求\s*[\d一二三四五六七八九十百]+/.exec(abstract)
  if (claimReference !== null) {
    violations.push({
      rule: 'abstract_claim_reference',
      family: 'abstract',
      severity: 'warning',
      section: '摘要',
      message: `摘要引用权利要求「${claimReference[0]}」，未独立反映技术方案（《专利审查指南》第一部分第一章 4.5.1：摘要应当写明发明公开的内容）`,
      suggestion: '摘要独立写明技术方案，不依赖权利要求编号',
    })
  }
  const unparenthesized = unparenthesizedMark(abstract)
  if (unparenthesized !== undefined) {
    violations.push({
      rule: 'abstract_mark_parentheses',
      family: 'abstract',
      severity: 'error',
      section: '摘要',
      message: `摘要中的附图标记未加括号：「${unparenthesized}」（《专利审查指南》第二部分第二章 2.4：摘要中出现的附图标记应当加括号）`,
      suggestion: '把摘要中的附图标记改写为「部件名（标号）」',
    })
  }
  const advertising = COMMERCIAL_ADVERTISING_TERMS.filter(term => abstract.includes(term))
  if (advertising.length > 0) {
    violations.push({
      rule: 'abstract_commercial_advertising',
      family: 'abstract',
      severity: 'error',
      section: '摘要',
      message: `摘要使用商业性宣传用语：${advertising.join('、')}（《专利审查指南》第一部分第一章 4.5.1、2.4）`,
      suggestion: '删除宣传性评价，只用技术事实概述方案',
    })
  }
  if (hasDrawings && input.abstract_figure_number !== undefined) {
    const known = knownFigureNumbers(input.text ?? '', input.figure_analysis)
    if (known.length > 0 && !known.includes(input.abstract_figure_number)) {
      violations.push({
        rule: 'abstract_drawing_number',
        family: 'abstract',
        severity: 'error',
        section: '摘要',
        message: `摘要附图指定的图${input.abstract_figure_number}在附图中不存在（本申请附图为图${known.join('、图')}）`,
        suggestion: '把摘要附图改为实际存在的某一幅附图，或核对附图说明中的图号',
      })
    }
  }
  return violations
}
