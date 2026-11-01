/**
 * Content prohibitions of the specification and the invention title.
 *
 * 《专利法实施细则》第二十条第三款 forbids commercial advertising in the
 * specification and forbids citing the claims from the description. The word
 * list below mirrors rule `CON-COMP-0105` in
 * `@deepseek-ai/dsh-patent-rule`; a contract test keeps the two in step.
 */

import { locateMatch } from '@deepseek-ai/dsh-patent-core'
import type { SpecViolation } from './spec-types.ts'

/** Commercial-advertising terms shared with rule `CON-COMP-0105`. */
export const COMMERCIAL_ADVERTISING_TERMS = [
  '世界领先', '行业首创', '独一无二', '前所未有', '最先进', '革命性', '颠覆性', '突破性',
] as const

/** Internal-process markers that must not reach a filed specification. */
const INTERNAL_LEAKAGE_TERMS = ['内部复核稿', 'AI 辅助生成', 'AI辅助生成', 'HITL', '内部使用'] as const

/** A description citing a claim by number, which 细则第二十条第三款 forbids. */
const CLAIM_CITATION_RE = /(?:如|根据|按照|依据)\s*权利要求\s*[\d一二三四五六七八九十百或至、,\s]+\s*所述/

/** Product-model wording that does not belong in an invention title. */
const MODEL_NUMBER_RE = /[A-Za-z]{2,}[-\s]?\d{2,}/

/**
 * Report prohibited content in the specification body.
 * @param text - the specification text.
 * @returns one violation per distinct term found, in declaration order.
 */
export function checkSpecProhibitions(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  const citation = CLAIM_CITATION_RE.exec(text)
  if (citation !== null) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the match is a substring of text, so a location exists
    const location = locateMatch(text, [citation[0]])!
    violations.push({
      rule: 'claim_citation_phrase',
      family: 'prohibitions',
      severity: 'error',
      message: `说明书引用了权利要求：「${citation[0]}」（《专利法实施细则》第二十条第三款：说明书中不得使用“如权利要求……所述的……”一类的引用语）`,
      suggestion: '在说明书中直接记载技术特征本身，删除对权利要求编号的引用',
      line: location.line,
      matchedSentence: location.matchedSentence,
    })
  }
  violations.push(
    ...keywordViolations(
      text,
      COMMERCIAL_ADVERTISING_TERMS,
      'commercial_advertising',
      term => `说明书使用商业性宣传用语「${term}」（《专利法实施细则》第二十条第三款；《专利审查指南》第二部分第二章 2.2.7）`,
      '删除宣传性评价，改用可验证的技术效果和实验数据',
    ),
    ...keywordViolations(
      text,
      INTERNAL_LEAKAGE_TERMS,
      'internal_leakage',
      term => `说明书残留内部流程标记「${term}」，不应出现在提交文本中`,
      '删除内部流程标记，只保留面向公众的技术内容',
    ),
  )
  return violations
}

/**
 * Report one violation per listed term present in the text.
 * @param text - the text to scan.
 * @param terms - the prohibited terms.
 * @param rule - rule id reported for each hit.
 * @param message - builds the message for one term.
 * @param suggestion - the repair suggestion.
 * @returns violations in term order.
 */
function keywordViolations(
  text: string,
  terms: readonly string[],
  rule: string,
  message: (term: string) => string,
  suggestion: string,
): SpecViolation[] {
  return terms.filter(term => text.includes(term)).map((term) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the term is a substring of text, so a location exists
    const location = locateMatch(text, [term])!
    return {
      rule,
      family: 'prohibitions' as const,
      severity: 'error' as const,
      message: message(term),
      suggestion,
      line: location.line,
      matchedSentence: location.matchedSentence,
    }
  })
}

/**
 * Check the invention title's length and prohibited wording.
 *
 * 《专利审查指南》第一部分第一章 4.1.1 asks for a title of generally no more
 * than 25 characters and allows up to 40 in special cases; names, place names,
 * and marketing words are prohibited. Only length and mechanically recognizable
 * words are decided here; whether a name is a technical term stays not assessed.
 * @param title - the trimmed invention title.
 * @returns title violations.
 */
export function checkTitle(title: string): SpecViolation[] {
  if (title.length === 0) return []
  const violations: SpecViolation[] = []
  const length = Array.from(title).length
  if (length > 40) {
    violations.push({
      rule: 'title_length',
      family: 'title',
      severity: 'error',
      section: '发明名称',
      message: `发明名称 ${length} 字，超过 40 字上限（《专利审查指南》第一部分第一章 4.1.1：一般不超过 25 字，特殊情况可到 40 字）`,
      suggestion: '缩短至 25 字以内，使用通用技术术语',
    })
  } else if (length > 25) {
    violations.push({
      rule: 'title_length',
      family: 'title',
      severity: 'warning',
      section: '发明名称',
      message: `发明名称 ${length} 字，超过一般要求的 25 字（特殊情况可到 40 字）`,
      suggestion: '核对是否属于允许的特殊情况；否则缩短至 25 字以内',
    })
  }
  const prohibited = (message: string, suggestion: string): void => {
    violations.push({
      rule: 'title_prohibited_word',
      family: 'title',
      severity: 'error',
      section: '发明名称',
      message,
      suggestion,
    })
  }
  if (/[®™]/.test(title)) {
    prohibited('发明名称含商标标记（®/™），不得使用（《专利审查指南》第一部分第一章 4.1.1）', '删除商标标记，只保留技术名称')
  }
  const advertising = COMMERCIAL_ADVERTISING_TERMS.filter(term => title.includes(term))
  if (advertising.length > 0) {
    prohibited(`发明名称含商业性宣传用语：${advertising.join('、')}`, '改用中性的技术名称')
  }
  if (MODEL_NUMBER_RE.test(title)) {
    prohibited('发明名称含型号样式（字母加数字），不应使用产品型号命名', '删除型号，改用该产品的通用技术名称')
  }
  return violations
}
