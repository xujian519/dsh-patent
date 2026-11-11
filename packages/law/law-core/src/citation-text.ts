/**
 * 中文法条引用的文本归一化与编号渲染（纯函数）。
 *
 * 专利域与法律域的引用语法不同（专利法还有审查指南与 `A22.3` 紧凑形式），
 * 但「全角转 ASCII」「书名号/标点剥离」「中文数字渲染」「款/项窄化」这些
 * 文本步骤相同，收拢在这里避免两份实现漂移。
 * @module @deepseek-ai/dsh-law-core/citation-text
 */

import { parseCnNumber } from './cn-number.ts'

/** Chinese numeral digits, indexed by value; used for rendering. */
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/**
 * Normalize the forms a copied citation may carry before matching: full-width
 * digits, Latin letters, and full-width brackets become ASCII.
 * @param text - the text to normalize.
 * @returns the normalized text.
 */
export function normalizeCitationText(text: string): string {
  return text.normalize('NFKC')
}

/** Chinese numeral for one digit, used by {@link formatCnNumber}. */
function cnDigit(value: number): string {
  // formatCnNumber validates 0..999 and only passes a digit here.
  return CN_DIGITS[value] as string
}

/**
 * Render a number in Chinese numerals, the form a formal Chinese document uses.
 * @param value - an integer from 0 through 999.
 * @returns the Chinese numeral text.
 * @throws RangeError when the value is not an integer in that range.
 */
export function formatCnNumber(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    throw new RangeError(`formatCnNumber expects an integer in 0..999, received ${value}`)
  }
  if (value === 0) return '〇'
  if (value < 10) return cnDigit(value)
  const hundreds = Math.floor(value / 100)
  const tens = Math.floor((value % 100) / 10)
  const ones = value % 10
  const parts: string[] = []
  if (hundreds > 0) parts.push(`${cnDigit(hundreds)}百`)
  if (tens > 0) parts.push(tens === 1 && hundreds === 0 ? '十' : `${cnDigit(tens)}十`)
  // 一百零五 keeps the zero placeholder; 一百一十 must not gain one.
  else if (hundreds > 0 && ones > 0) parts.push('零')
  if (ones > 0) parts.push(cnDigit(ones))
  return parts.join('')
}

/**
 * Render a citation number in Chinese numerals when it is in the documented
 * range, and keep the digits otherwise. An out-of-range article is reported,
 * not thrown on, so a citation beyond the ceiling still gets a row.
 * @param value - the number to render.
 * @returns the Chinese numeral or the decimal digits.
 */
export function formatCitationNumber(value: number): string {
  return value >= 0 && value <= 999 ? formatCnNumber(value) : String(value)
}

/**
 * Read one optional 款 or 项 numeral.
 * @param raw - the numeral text, when the citation names that field.
 * @returns the positive integer, `undefined` when the citation names no such field, or null when the text is not a positive integer.
 */
function readNarrowedField(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  const value = parseCnNumber(raw)
  if (value === null || value < 1) return null
  return value
}

/**
 * Paragraph and item fields a reference carries.
 *
 * A field the citation does not name is omitted. A field it names with a numeral
 * the parser rejects, including `十十` and `0`, rejects the whole citation:
 * dropping the field would leave a broader reference that still looks checked.
 * @param paragraph - the paragraph text, when the reference names one.
 * @param item - the item text, when the reference names one.
 * @returns the parsed fields, or null when a named field is not a positive integer.
 */
export function narrowed(paragraph: string | undefined, item: string | undefined): {
  paragraph?: number
  item?: number
} | null {
  const paragraphValue = readNarrowedField(paragraph)
  const itemValue = readNarrowedField(item)
  if (paragraphValue === null || itemValue === null) return null
  return {
    ...(paragraphValue === undefined ? {} : { paragraph: paragraphValue }),
    ...(itemValue === undefined ? {} : { item: itemValue }),
  }
}

/**
 * Drop the closing book-title mark a citation may carry.
 * @param text - the citation text.
 * @returns the text without closing book-title marks.
 */
export function stripBookMarks(text: string): string {
  return text.replaceAll('》', '')
}

/**
 * Drop the punctuation or quotation marks a citation may be wrapped in.
 * @param text - the citation text.
 * @returns the trimmed text.
 */
export function trimPunctuation(text: string): string {
  return text
    .trim()
    .replace(/^[（(《【[“‘「『]+/, '')
    .replace(/[）)》】\];；,，.。、:：”’」』]+$/, '')
    .trim()
}

/**
 * Drop the layout spaces a citation may carry, for containment checks.
 * @param value - the citation text.
 * @returns the text without whitespace.
 */
export function compactCitation(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * Render one statute-article reference the way a formal Chinese document writes
 * it, e.g. `《专利法》第二十二条第三款`.
 * @param reference - the reference to render.
 * @returns the rendered text.
 */
export function formatArticleCitation(reference: {
  law: string
  article: number
  paragraph?: number
  item?: number
}): string {
  const paragraph = reference.paragraph === undefined ? '' : `第${formatCitationNumber(reference.paragraph)}款`
  const item = reference.item === undefined ? '' : `第${formatCitationNumber(reference.item)}项`
  return `《${reference.law}》第${formatCitationNumber(reference.article)}条${paragraph}${item}`
}

/**
 * Stable identity of one statute-article reference.
 * @param law - the law name.
 * @param article - the article number.
 * @param paragraph - the paragraph number, when the reference names one.
 * @param item - the item number, when the reference names one.
 * @returns a string equal for two references to the same provision.
 */
export function articleReferenceIdentity(
  law: string,
  article: number,
  paragraph: number | undefined,
  item: number | undefined,
): string {
  return `article:${law}:${article}:${paragraph ?? ''}:${item ?? ''}`
}
