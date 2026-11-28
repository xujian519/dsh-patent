/**
 * Specification style checks: the heading set, the section order, and the
 * figure-reference forms of the specification body.
 *
 * The heading set and the section order come from 《专利法实施细则》第二十条:
 * the specification comprises the five parts 技术领域 / 背景技术 / 发明内容 /
 * 附图说明 / 具体实施方式, written in that order with a heading before each
 * part. The figure-reference forms come from 《专利审查指南》第二部分第二章
 * §2.2.6 (a mark follows the technical name it labels, without parentheses) and
 * from the filing convention that a figure number is written as 图1.
 *
 * Paragraph numbering has no basis in the Patent Law, the Implementing
 * Regulations, or the Examination Guidelines; it is reported as a warning so a
 * deployment whose filing template does not use it can drop it.
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-style
 */

import { locateMatch } from '@deepseek-ai/dsh-patent-core'
import type { SpecViolation } from './spec-types.ts'

/** The five specification parts whose headings 《专利法实施细则》第二十条 names. */
export const SPEC_SECTION_HEADINGS = ['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式'] as const

/** Document-level wrapper headings the rendering template writes around the five parts. */
const WRAPPER_HEADINGS = ['说明书']

/**
 * Suffixes that end a bracketed number's context but not a component name: they
 * introduce an enumeration or a reference rather than label a part of the
 * product, so 「实施例（1）」 and 「图（2）」 are not parenthesized figure marks.
 */
const NON_MARK_SUFFIXES = ['例', '骤', '式', '图', '表', '项', '条', '章', '节', '次', '者']

/**
 * Characters of the Chinese run before a bracketed number that the report
 * quotes. A longer run is the sentence the mark sits in, not the label's name.
 */
const MARK_CONTEXT_WINDOW = 12

/**
 * Words that end the context before a bracketed number. The check cannot
 * segment Chinese words, so it cuts the run at its last one of these and quotes
 * the suffix — the quote stays a verbatim substring of the document. A cut that
 * leaves fewer than two characters (「连接件（4）」) falls back to the window, so
 * a name the list does not cover is quoted whole rather than truncated.
 */
const NAME_BOUNDARIES = [
  '所述', '上述', '还有', '其中', '以及', '并且', '或者',
  '包括', '包含', '设有', '设置', '连接', '固定', '安装', '具有', '位于', '用于',
  '形成', '构成', '通过', '分别', '若干', '多个',
  '的', '与', '和', '及', '或',
]

/** Parenthesized figure mark in the specification body: a Chinese name, then a bracketed number in either width. */
const PARENTHESIZED_MARK = /[\u4e00-\u9fff]{2,20}[（(]\d{1,3}[）)]/g

/** Figure number written with a space after 图. */
const SPACED_FIGURE_NUMBER = /图[ \t]+[\d一二三四五六七八九十]+/g

/** Paragraph number of the `[0001]` form. */
const PARAGRAPH_NUMBER = /\[\d{4,5}\]/

/**
 * Heading lines with their 1-based line numbers.
 * @param text - the text to scan.
 * @returns each markdown heading and the line it sits on.
 */
function headings(text: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = []
  text.split('\n').forEach((line, i) => {
    if (/^#{1,6}[ \t]*\S/.test(line)) found.push({ line: i + 1, text: line.replace(/^#{1,6}[ \t]*/, '').trim() })
  })
  return found
}

/**
 * Headings other than the five parts 《专利法实施细则》第二十条 names, and
 * repeated headings of the allowed set.
 *
 * Drafting labels inside 发明内容 (要解决的技术问题 / 技术方案 / 有益效果) and
 * inside 具体实施方式 (实施例一, 替代实施方式) are content, not specification
 * parts; written as headings they are extra headings. A part written twice is
 * malformed in the same way: its content sits under two headings instead of one.
 * @param text - the specification text.
 * @returns one violation naming every heading outside the allowed set, and one
 * naming repeated allowed headings.
 */
export function checkHeadingSet(text: string): SpecViolation[] {
  if (text.trim().length === 0) return []
  const allowed = new Set<string>([...SPEC_SECTION_HEADINGS, ...WRAPPER_HEADINGS])
  const found = headings(text)
  const extra = found.filter(h => !allowed.has(h.text))
  const firstByName = new Map<string, { line: number; text: string }>()
  const duplicates: Array<{ name: string; second: { line: number; text: string } }> = []
  for (const heading of found) {
    const first = firstByName.get(heading.text)
    if (first === undefined) {
      firstByName.set(heading.text, heading)
      continue
    }
    if (duplicates.some(pair => pair.name === heading.text)) continue
    duplicates.push({ name: heading.text, second: heading })
  }
  const violations: SpecViolation[] = []
  const firstExtra = extra[0]
  if (firstExtra !== undefined) {
    violations.push({
      rule: 'heading_set',
      family: 'structure',
      severity: 'error',
      message: `说明书出现 ${extra.length} 个规定之外的标题：${extra.map(h => h.text).join('、')}（《专利法实施细则》第二十条只规定技术领域、背景技术、发明内容、附图说明、具体实施方式五部分标题）`,
      suggestion: '删除这些标题，其下内容以自然段落平铺书写；发明名称写在说明书首页正文上方居中，不作标题',
      line: firstExtra.line,
      matchedSentence: firstExtra.text,
    })
  }
  const firstDuplicate = duplicates[0]
  if (firstDuplicate !== undefined) {
    violations.push({
      rule: 'heading_duplicate',
      family: 'structure',
      severity: 'error',
      message: `说明书重复出现章节标题：${duplicates.map(pair => pair.name).join('、')}（每个章节只应有一个标题）`,
      suggestion: `删除重复的「${firstDuplicate.name}」标题，把该部分内容合并到唯一标题下`,
      line: firstDuplicate.second.line,
      matchedSentence: firstDuplicate.second.text,
    })
  }
  return violations
}

/**
 * The five parts in the order 《专利法实施细则》第二十条 requires. Reported
 * only when all five are present, so a missing part stays a `sections` error.
 * @param text - the specification text.
 * @param required - the section names this application requires.
 * @returns the order violation, empty when the parts are in order or incomplete.
 */
export function checkSectionOrder(
  text: string,
  required: readonly string[] = SPEC_SECTION_HEADINGS,
): SpecViolation[] {
  const lines = headings(text)
  const positions = SPEC_SECTION_HEADINGS.map(name => ({ name, index: lines.findIndex(h => h.text === name) }))
  if (required.some(name => !positions.some(position => position.name === name && position.index >= 0))) return []
  const present = positions.filter(position => position.index >= 0)
  const actual = [...present].sort((a, b) => a.index - b.index).map(p => p.name)
  const expected = SPEC_SECTION_HEADINGS.filter(name => present.some(position => position.name === name))
  if (actual.every((name, i) => name === expected[i])) return []
  return [
    {
      rule: 'section_order',
      family: 'structure',
      severity: 'error',
      message: `说明书各部分顺序不符：实际为 ${actual.join('、')}，应为 ${SPEC_SECTION_HEADINGS.join('、')}（《专利法实施细则》第二十条要求按该方式和顺序撰写）`,
      suggestion: `按${SPEC_SECTION_HEADINGS.join('、')}的顺序重排各部分`,
    },
  ]
}

/**
 * Name the mark labels: the Chinese run before the bracket is cut at its last
 * boundary word and the suffix returned, so the report quotes characters that
 * appear in the document rather than a per-character strip of them.
 * @param run - the Chinese characters immediately before the bracketed number.
 * @returns the name to report, at least two characters.
 */
function markName(run: string): string {
  const window = run.slice(-MARK_CONTEXT_WINDOW)
  let start = 0
  for (const word of NAME_BOUNDARIES) {
    const at = window.lastIndexOf(word)
    if (at >= 0) start = Math.max(start, at + word.length)
  }
  const name = window.slice(start)
  return name.length >= 2 ? name : window
}

/**
 * Figure marks written in parentheses in the specification body.
 *
 * 《专利审查指南》第二部分第二章 §2.2.6 requires a mark to follow the
 * technical name it labels without parentheses (「电阻 3 …」, not 「电阻（3）」).
 * The claims and the abstract are separate inputs, where brackets are the
 * prescribed form (《专利法实施细则》第二十二条; 指南 §2.4), so only the
 * specification text is scanned here.
 * @param text - the specification text.
 * @returns one violation per distinct parenthesized figure mark, in text order.
 */
export function checkFigureMarkParentheses(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  const seen = new Set<string>()
  for (const raw of text.match(PARENTHESIZED_MARK) ?? []) {
    const match = /^(.*?)[（(](\d{1,3})[）)]$/.exec(raw)
    /* v8 ignore next -- PARENTHESIZED_MARK guarantees the name and digits groups. */
    if (match === null) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern always captures the name group.
    const name = markName(match[1]!)
    if (NON_MARK_SUFFIXES.includes(name.slice(-1))) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the pattern always captures the digits group.
    const digits = match[2]!
    const mark = `${name}（${digits}）`
    if (seen.has(mark)) continue
    seen.add(mark)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the raw match is a substring of text, so a location always exists
    const location = locateMatch(text, [raw])!
    violations.push({
      rule: 'figure_mark_parentheses',
      family: 'figures',
      severity: 'error',
      message: `说明书正文给附图标记加括号：「${mark}」（《专利审查指南》第二部分第二章 §2.2.6：标记应当放在相应的技术名称的后面，不加括号）`,
      suggestion: `改写为「${name}${digits}」，把标记直接跟在技术名称后`,
      line: location.line,
      matchedSentence: location.matchedSentence,
    })
  }
  return violations
}

/**
 * Figure numbers written with a space between 图 and the number.
 * @param text - the specification text.
 * @returns one violation per distinct spaced figure number, in text order.
 */
export function checkFigureNumberSpacing(text: string): SpecViolation[] {
  return Array.from(new Set(text.match(SPACED_FIGURE_NUMBER) ?? [])).map(hit => ({
    rule: 'figure_number_spacing',
    family: 'figures' as const,
    severity: 'error' as const,
    message: `图号写作「${hit}」，不应在「图」与图号之间留空格`,
    suggestion: `改写为「${hit.replace(/[ \t]+/g, '')}」`,
  }))
}

/**
 * Paragraph numbers (`[0001]` and the like) in the specification text.
 *
 * No Patent Law, Implementing Regulations, or Examination Guidelines clause
 * requires or forbids paragraph numbering, so this is a warning: a deployment
 * whose filing template omits it (the CNIPA filing format this tool set
 * targets) should drop the numbering before filing.
 * @param text - the specification text.
 * @returns the paragraph-numbering warning, empty when the text carries none.
 */
export function checkParagraphNumbering(text: string): SpecViolation[] {
  const match = PARAGRAPH_NUMBER.exec(text)
  if (match === null) return []
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the match is a substring of text, so a location always exists
  const location = locateMatch(text, [match[0]])!
  return [
    {
      rule: 'paragraph_numbering',
      family: 'structure',
      severity: 'warning',
      message: `说明书出现段落编号「${match[0]}」，法条与《专利审查指南》均未要求段落编号`,
      suggestion: '若所在部署的提交体例不使用段落编号，删除全部段落编号；由渲染模板控制，不要在正文里手工增删',
      line: location.line,
      matchedSentence: location.matchedSentence,
    },
  ]
}

/**
 * Headings inside the abstract text.
 *
 * 《专利审查指南》第一部分第一章 §4.5.1 and 第一部分第二章 §7.5 state that the
 * abstract text must not use headings.
 * @param abstract - the abstract text, when supplied.
 * @returns the abstract-heading violation, empty when the abstract has none.
 */
export function checkAbstractHeading(abstract: string | undefined): SpecViolation[] {
  if (abstract === undefined || !/^#{1,6}[ \t]*\S/m.test(abstract)) return []
  return [
    {
      rule: 'abstract_heading',
      family: 'abstract',
      severity: 'error',
      section: '摘要',
      message: '摘要文字部分使用了标题（《专利审查指南》第一部分第一章 4.5.1、第一部分第二章 7.5：摘要文字部分不得使用标题）',
      suggestion: '删除摘要中的标题，改为一段连续文字；摘要不超过 300 字，正文中出现的附图标记加括号',
    },
  ]
}

/**
 * Every style violation of one specification, in the order the report lists
 * them: heading set, section order, figure-mark parentheses, figure-number
 * spacing, paragraph numbering, then the abstract heading.
 * @param text - the specification text.
 * @param abstract - the abstract text, when supplied.
 * @param required - the section names this application requires.
 * @returns the style violations.
 */
export function checkSpecStyle(
  text: string,
  abstract: string | undefined,
  required: readonly string[] = SPEC_SECTION_HEADINGS,
): SpecViolation[] {
  return [
    ...checkHeadingSet(text),
    ...checkSectionOrder(text, required),
    ...checkFigureMarkParentheses(text),
    ...checkFigureNumberSpacing(text),
    ...checkParagraphNumbering(text),
    ...checkAbstractHeading(abstract),
  ]
}
