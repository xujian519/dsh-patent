/**
 * Figure-mark consistency and drawing-description checks: the drawing
 * description, the figure analysis, the specification body, and the claims must
 * agree on the same reference marks and figure numbers.
 */

import { parseCnNumber } from '@deepseek-ai/dsh-patent-core'
import type { FigureAnalysisResult, SpecViolation } from './spec-types.ts'
import { sectionBodies } from './spec-placeholder.ts'

/** Figure number token: Arabic digits or a Chinese numeral up to 999. */
const FIGURE_NUMBER_SOURCE = '(?:\\d{1,3}|[零一二三四五六七八九十百]{1,6})'

/** A figure reference (`图1`, `图 一`) anywhere in the text. */
const FIGURE_REFERENCE_RE = new RegExp(`图\\s*(${FIGURE_NUMBER_SOURCE})`, 'g')

/**
 * Parse an Arabic or Chinese figure number.
 * @param raw - the number token.
 * @returns the number, or undefined when the token is not a numeral.
 */
export function parseFigureNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return Number.isInteger(value) ? value : undefined
  }
  return parseCnNumber(raw) ?? undefined
}

/**
 * Figure numbers in text order, including duplicates.
 * @param text - the text to scan.
 * @returns the parsed figure numbers.
 */
export function figureNumbersIn(text: string): number[] {
  const numbers: number[] = []
  for (const match of text.matchAll(FIGURE_REFERENCE_RE)) {
    const raw = match[1]
    /* v8 ignore next -- the pattern always captures the number group. */
    if (raw === undefined) continue
    const value = parseFigureNumber(raw)
    /* v8 ignore next -- the source only matches numeral tokens, so parsing succeeds. */
    if (value !== undefined) numbers.push(value)
  }
  return numbers
}

/** One drawing-description entry. */
type DrawingEntry = {
  /** Parsed figure number. */
  number: number
  /** Text after the figure number, with leading connectors removed. */
  name: string
}

/** A separator that starts a new drawing-description entry. */
const ENTRY_SEPARATOR = /[；;。\n，,、]/

/** A connector that joins two figure numbers into one range (`图1至图3`). */
const RANGE_CONNECTOR = /^\s*(?:至|到|[-—–~～])\s*$/

/** One figure label inside the drawing description. */
type FigureLabel = {
  /** Parsed figure number. */
  number: number
  /** Offset of the `图` token. */
  start: number
  /** Offset just past the number token. */
  end: number
  /** Whether the label opens an entry, closes a range, or only appears inside the previous entry's name. */
  role: 'entry' | 'range' | 'reference'
}

/**
 * Parse the drawing-description entries (`图N为…`, `图N：…`, `图1，图2…`, `图1至图3…`).
 * A figure label followed by a separator opens a new entry, a label that closes a
 * range (`至`/`到`/`-`/`—`/`~`/`～`) adds every number up to it, and any other
 * label (such as `图2为图1中A处的放大图`) belongs to the entry being described.
 * @param section - the drawing-description body.
 * @returns one entry per described figure, in text order.
 */
export function drawingEntries(section: string): DrawingEntry[] {
  const labels: FigureLabel[] = []
  let labelEnd = 0
  for (const match of section.matchAll(FIGURE_REFERENCE_RE)) {
    const raw = match[1]
    /* v8 ignore next -- the pattern always captures the number group. */
    if (raw === undefined) continue
    const number = parseFigureNumber(raw)
    /* v8 ignore next -- the source only matches numeral tokens. */
    if (number === undefined) continue
    const start = match.index
    const end = start + match[0].length
    const gap = section.slice(labelEnd, start)
    const role: FigureLabel['role'] = labels.length === 0
      ? 'entry'
      : RANGE_CONNECTOR.test(gap)
        ? 'range'
        : ENTRY_SEPARATOR.test(gap)
          ? 'entry'
          : 'reference'
    labels.push({ number, start, end, role })
    labelEnd = end
  }

  const groups: { numbers: number[]; start: number; nameStart: number }[] = []
  for (const label of labels) {
    if (label.role === 'entry') {
      groups.push({ numbers: [label.number], start: label.start, nameStart: label.end })
      continue
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-first label always follows an entry, which opened a group.
    const group = groups[groups.length - 1]!
    if (label.role === 'range') {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- every group carries at least one number.
      const last = group.numbers[group.numbers.length - 1]!
      const from = Math.min(last, label.number)
      const to = Math.max(last, label.number)
      for (let n = from; n <= to; n += 1) {
        if (!group.numbers.includes(n)) group.numbers.push(n)
      }
      group.nameStart = label.end
    }
  }

  return groups.flatMap((group, index) => {
    const next = groups[index + 1]
    const [name = ''] = section
      .slice(group.nameStart, next === undefined ? section.length : next.start)
      .split(/[；;。\n]/, 1)
    const cleaned = name.replace(/^[\s为是：:、，,。；;]*/, '')
    return group.numbers.map(number => ({ number, name: cleaned }))
  })
}

/**
 * Figure-mark consistency: drawing-description marks vs. figure-analysis marks.
 * Unusable figures are skipped per-figure (no all-or-nothing); a mark present in
 * the figure but absent from the drawing description is a warning (漏标), and a
 * mark listed in the description but absent from the figure is an error (悬空).
 * @param text - the specification text (drawing-description section).
 * @param figureAnalysis - the figure-analysis results.
 * @param claims - the claims text (optional); bracketed marks there must exist in a figure.
 * @returns the consistency violations found.
 */
export function checkFigureMarkConsistency(
  text: string,
  figureAnalysis: FigureAnalysisResult[],
  claims?: string,
): SpecViolation[] {
  if (figureAnalysis.length === 0) return []
  const violations: SpecViolation[] = []

  const unusable = figureAnalysis.filter(f => !f.usable)
  if (unusable.length > 0) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'warning',
      message: `附图分析结果不可用（${unusable.length} 张），请人工核对图面标号与附图说明`,
    })
  }

  const figureMarks = new Set<string>()
  for (const f of figureAnalysis) {
    if (!f.usable) continue
    for (const c of f.components) {
      if (/^\d+$/.test(c.refNumber)) figureMarks.add(c.refNumber)
    }
  }
  if (figureMarks.size === 0) return violations

  const drawingSection = getDrawingSection(text)
  if (!drawingSection) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'warning',
      message: '说明书缺少附图说明章节，无法核验附图标记与图面一致性',
      suggestion: '补充附图说明章节，逐图列出标号对应的部件',
    })
    return violations
  }

  const listedMarks = new Set<string>()
  const markPattern = /(?:^|[；;\n，,：:])\s*(\d+)\s*[-–—]/g
  let match: RegExpExecArray | null
  while ((match = markPattern.exec(drawingSection)) !== null) {
    const mark = match[1]
    /* v8 ignore next -- the mark pattern always captures the mark group. */
    if (mark !== undefined) listedMarks.add(mark)
  }

  const missing = [...figureMarks].filter(n => !listedMarks.has(n))
  if (missing.length > 0) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'warning',
      section: '附图说明',
      message: `附图标记 ${missing.join('、')} 未在附图说明中列出`,
      suggestion: '在附图说明中补充对应标号的部件说明',
    })
  }

  const dangling = [...listedMarks].filter(n => !figureMarks.has(n))
  if (dangling.length > 0) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'error',
      section: '附图说明',
      message: `附图说明中的标记 ${dangling.join('、')} 在附图中不存在`,
      suggestion: '核对图面标号，删除或更正附图说明中不存在的标号',
    })
  }

  // 细则第二十一条第二款要求文字部分与附图双向对应：图面上出现的标号必须在
  // 具体实施方式等正文中提及，权利要求中带括号引用的标号也必须出现在图面上。
  const outsideDrawingDescription = withoutDrawingSection(text)
  const unmentioned = [...figureMarks].filter(n => !mentionedAsToken(outsideDrawingDescription, n) && !mentionedAsToken(claims ?? '', n))
  if (unmentioned.length > 0) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'warning',
      section: '具体实施方式',
      message: `附图标记 ${unmentioned.join('、')} 未在说明书正文（具体实施方式）或权利要求中提及`,
      suggestion: '在具体实施方式中对照附图标记说明对应部件，保持图文一致',
    })
  }
  const claimedMarks = extractClaimMarks(claims)
  const claimedMissing = claimedMarks.filter(n => !figureMarks.has(n))
  if (claimedMissing.length > 0) {
    violations.push({
      rule: 'figure_mark_consistency',
      family: 'figures',
      severity: 'warning',
      section: '权利要求书',
      message: `权利要求引用的附图标记 ${claimedMissing.join('、')} 在附图中不存在`,
      suggestion: '核对权利要求中的括号标号与图面标号，删除或更正不存在的标号',
    })
  }

  return violations
}

/**
 * Figure numbers must start at 1 and stay contiguous (实施细则第二十一条第一款；
 * 指南第一部分第一章 4.3).
 * @param text - the specification text.
 * @returns the sequence violation, or empty when the numbers are contiguous.
 */
export function checkFigureNumberSequence(text: string): SpecViolation[] {
  const numbers = drawingEntries(getDrawingSection(text)).map(entry => entry.number)
  if (numbers.length === 0) return []
  const unique = [...new Set(numbers)]
  const max = Math.max(...unique)
  const missing: number[] = []
  for (let n = 1; n <= max; n += 1) {
    if (!unique.includes(n)) missing.push(n)
  }
  if (missing.length === 0) return []
  return [{
    rule: 'figure_number_sequence',
    family: 'figures',
    severity: 'error',
    section: '附图说明',
    message: `附图编号不连续，缺少图${missing.join('、图')}（《专利法实施细则》第二十一条第一款：附图应当按顺序编号）`,
    suggestion: `按图1至图${max}连续编号，或补上缺失的附图`,
  }]
}

/**
 * One figure number must not label two drawings.
 * @param text - the specification text.
 * @returns the duplicate violation, or empty when every number is unique.
 */
export function checkFigureNumberDuplicate(text: string): SpecViolation[] {
  const numbers = drawingEntries(getDrawingSection(text)).map(entry => entry.number)
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const number of numbers) {
    if (seen.has(number)) duplicates.add(number)
    seen.add(number)
  }
  if (duplicates.size === 0) return []
  return [{
    rule: 'figure_number_duplicate',
    family: 'figures',
    severity: 'error',
    section: '附图说明',
    message: `附图编号重复：图${[...duplicates].join('、图')}`,
    suggestion: '为每幅附图分配唯一图号，并同步修改正文引用',
  }]
}

/**
 * Body references must name a figure the drawing description defines.
 * @param text - the specification text.
 * @returns the missing-reference violation, or empty when every reference resolves.
 */
export function checkFigureReferenceMissing(text: string): SpecViolation[] {
  const section = getDrawingSection(text)
  if (section.trim().length === 0) return []
  const described = new Set(drawingEntries(section).map(entry => entry.number))
  const bodyNumbers = figureNumbersIn(withoutDrawingSection(text))
  const missing = [...new Set(bodyNumbers)].filter(number => !described.has(number))
  if (missing.length === 0) return []
  return [{
    rule: 'figure_reference_missing',
    family: 'figures',
    severity: 'error',
    message: `正文引用的图${missing.join('、图')}不在附图说明中`,
    suggestion: '在附图说明中补充这些附图的图名，或更正正文中的图号',
  }]
}

/**
 * Every drawing-description entry must name what the figure shows.
 * @param text - the specification text.
 * @returns one violation per unnamed entry.
 */
export function checkFigureDescriptionName(text: string): SpecViolation[] {
  return drawingEntries(getDrawingSection(text))
    .filter(entry => entry.name.trim().length === 0)
    .map(entry => ({
      rule: 'figure_description_name',
      family: 'figures' as const,
      severity: 'error' as const,
      section: '附图说明',
      message: `图${entry.number}未写明图名（《专利审查指南》第二部分第二章 2.2.5：附图说明应写明各幅附图的图名和内容）`,
      suggestion: `写作「图${entry.number}为……示意图」，说明该图展示的内容`,
    }))
}

/**
 * The declared drawing count must match the drawing-description entries.
 * @param text - the specification text.
 * @param declared - the caller-supplied drawing count.
 * @returns the count violation, or empty when the count matches or is absent.
 */
export function checkDrawingCount(text: string, declared: number | undefined): SpecViolation[] {
  if (declared === undefined) return []
  const actual = new Set(drawingEntries(getDrawingSection(text)).map(entry => entry.number)).size
  if (actual === declared) return []
  return [{
    rule: 'drawing_count',
    family: 'figures',
    severity: 'error',
    section: '附图说明',
    message: `声明的附图数量为 ${declared} 幅，附图说明实际列出 ${actual} 幅`,
    suggestion: '核对附图清单，保证声明的附图数量与附图说明、图面一致',
  }]
}

/**
 * Non-numeric figure suffixes (`图1A`) are outside the first deterministic
 * rule set; callers list them as not assessed instead of guessing.
 * @param text - the specification text.
 * @returns whether any figure number carries a letter suffix.
 */
export function hasFigureNumberSuffix(text: string): boolean {
  return /图\s*\d+\s*[A-Za-z]/.test(text)
}

/**
 * 本申请已有的图号集合：优先取附图分析结果中的图号，其次从附图说明章节的「图N」提取。
 * @param text - 说明书全文。
 * @param figureAnalysis - 附图分析结果（可选）。
 * @returns 升序去重的图号列表。
 */
export function knownFigureNumbers(text: string, figureAnalysis?: FigureAnalysisResult[]): number[] {
  const numbers = new Set<number>()
  for (const figure of figureAnalysis ?? []) {
    if (figure.figureNumber !== undefined) numbers.add(figure.figureNumber)
  }
  const section = getDrawingSection(text)
  if (numbers.size === 0 && section !== '') {
    for (const number of drawingEntries(section).map(entry => entry.number)) numbers.add(number)
  }
  return [...numbers].sort((a, b) => a - b)
}

/** 标号是否以独立数字 token 出现在给定文本中（避免把 2100 里的 100 当作标号）。 */
function mentionedAsToken(text: string, numeral: string): boolean {
  if (text === '') return false
  return new RegExp(`(^|[^\\d])${numeral}([^\\d]|$)`).test(text)
}

/**
 * 提取权利要求中带括号引用的附图标记（细则第二十二条第四款规定的引用形式）。
 * @param claims - 权利要求书全文；缺省时返回空数组。
 * @returns 去重后的标号列表（保持首次出现顺序）。
 */
export function extractClaimMarks(claims: string | undefined): string[] {
  if (claims === undefined || claims === '') return []
  const marks: string[] = []
  const pattern = /[（(]\s*(\d{1,4})\s*[）)]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(claims)) !== null) {
    const mark = match[1]
    /* v8 ignore next -- the mark pattern always captures the mark group. */
    if (mark !== undefined && !marks.includes(mark)) marks.push(mark)
  }
  return marks
}

/**
 * Extract the drawing-description section body.
 * @param text - the specification text.
 * @returns the section body, or an empty string when the section is absent.
 */
export function getDrawingSection(text: string): string {
  return sectionBodies(text).find(section => section.name === '附图说明')?.body ?? ''
}

/**
 * Remove the drawing-description body from the text, leaving the body and the
 * claims as the places that reference figures.
 * @param text - the specification text.
 * @returns the text without the drawing-description body.
 */
export function withoutDrawingSection(text: string): string {
  const body = getDrawingSection(text)
  return body === '' ? text : text.replace(body, '')
}

/**
 * Count figure references inside the drawing-description section.
 * @param text - the specification text.
 * @returns the number of references inside that section.
 */
export function countInDrawingSection(text: string): number {
  return figureNumbersIn(getDrawingSection(text)).length
}

/**
 * Whether the text declares that the application has no drawings.
 * @param text - the specification text.
 * @returns true when the drawing section or body says so.
 */
export function declaresNoDrawings(text: string): boolean {
  return /无附图|没有附图|不含附图/.test(text)
}

/**
 * Whether the drawing-description section holds at least one figure entry.
 * @param text - the specification text.
 * @returns true when a figure number appears under the section heading.
 */
export function drawingSectionHasFigures(text: string): boolean {
  const section = sectionBodies(text).find(body => body.name === '附图说明')
  if (section === undefined) return false
  return drawingEntries(section.body).length > 0
}
