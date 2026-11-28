/**
 * Deterministic document checks behind the `document_deliver` gate.
 *
 * The model declares which quality checks it ran; these functions read the
 * delivered bytes themselves, so the gate reports machine-derived findings
 * beside that declaration instead of taking it as evidence. Every check is a
 * pure function over one document's text, so a caller can run it on a rendered
 * Markdown or HTML file and on the text projected out of a DOCX package alike.
 *
 * Finding levels. `block` refuses the registration and is reserved for the two
 * findings the shipped quality gate calls P0 with no legitimate reading: a
 * residual placeholder outside quoted text (a code fence or an inline code
 * span), and a word the selected style forbids outright outside quoted text.
 * Everything else is `warn` — an empty section, a fragment no declared anchor
 * serves, a word the style only discourages, a forbidden word quoted as text
 * the document talks about or sample code the document shows, a format with no
 * text reader, and a declared character budget the document misses. A `warn`
 * finding is reported and the registration proceeds, because each of them has a
 * reading a reviewer may accept (a placeholder shown inside a code sample or
 * quoted in inline code while the document talks about that placeholder, an
 * anchor a renderer derives differently, an intentionally short summary). A
 * deployment that needs a forbidden word allowed overrides the style asset
 * instead of silencing the check.
 *
 * A declared character budget measures body text. Markdown and DOCX-projected
 * text are body text already; an HTML document's markup, comments, and the
 * contents of its `script` and `style` elements are not, so `format: 'html'`
 * measures the text a renderer shows.
 * @module @deepseek-ai/dsh-document-deliver/checks
 */

import { residualPlaceholderPatterns, type AntiPattern, type DocumentStyle } from '@deepseek-ai/dsh-doc-style'

/** Every check this module can report. */
export const DOCUMENT_CHECK_IDS = [
  'placeholder',
  'broken_anchor',
  'empty_section',
  'anti_pattern',
  'length_budget',
] as const

/** One check's identifier. */
export type DocumentCheckId = (typeof DOCUMENT_CHECK_IDS)[number]

/** Whether a finding refuses the registration (`block`) or only reports it (`warn`). */
export type DocumentCheckLevel = 'block' | 'warn'

/** One machine-derived finding about a delivered document. */
export interface DocumentCheckFinding {
  /** The check that produced the finding. */
  readonly check: DocumentCheckId
  /** `block` refuses the registration; `warn` reports it and registers anyway. */
  readonly level: DocumentCheckLevel
  /** One line naming what was found and where, phrased for the model to act on. */
  readonly detail: string
  /** 1-based line of the checked text; absent for a finding with no position. */
  readonly line?: number
}

/** Input of {@link checkDocumentText}: what a style and a declared budget add. */
export interface DocumentTextCheckOptions {
  /** The style whose forbidden words are enforced; absent when no style applies. */
  readonly style?: DocumentStyle
  /** Declared character budget, in non-whitespace characters; absent when none was declared. */
  readonly charBudget?: number
  /**
   * The format of the checked bytes, when it changes how the text is measured.
   * `html` measures the body text a renderer shows, with markup stripped; the
   * default measures the delivered text, which for Markdown and for DOCX
   * projection is body text already.
   */
  readonly format?: 'markdown' | 'html'
  /**
   * Fraction of the declared budget the document may fall short of or exceed.
   * Defaults to {@link DEFAULT_LENGTH_TOLERANCE}; `document_deliver` always
   * supplies its configured value.
   */
  readonly lengthTolerance?: number
  /**
   * Findings kept per check before the rest are summarized into one line.
   * Defaults to {@link DEFAULT_MAX_FINDINGS_PER_CHECK}; `document_deliver`
   * always supplies its configured value.
   */
  readonly maxFindingsPerCheck?: number
}

/** One finding before {@link report} attributes it to a check. */
interface DraftFinding {
  /** One line naming what was found and where. */
  readonly detail: string
  /** The finding's own level, overriding the check's default. */
  readonly level?: DocumentCheckLevel
  /** 1-based line of the checked text, or 0 for a finding with no position. */
  readonly line: number
}

/**
 * One draft before the display cap decides whether it is rendered.
 *
 * The line and the detail stay unrendered until a collector keeps the draft, so
 * a document repeating one match hundreds of thousands of times pays a counter
 * per occurrence instead of a line lookup and a rendered line.
 */
interface DraftHead {
  /** The 1-based line of the checked text, or 0 for a finding with no position; called only for a kept draft. */
  readonly line: () => number
  /** The draft's own level, overriding the check's default. */
  readonly level?: DocumentCheckLevel
  /** The finding's one-line detail for a resolved line; called only for a kept draft. */
  readonly detail: (line: number) => string
}

/** The drafts one check keeps under its display cap, plus what the cap dropped. */
interface DraftBatch {
  /** The drafts to show, in the check's own order. */
  readonly drafts: readonly DraftFinding[]
  /** Drafts past the cap: counted and leveled, with no line or detail rendered. */
  readonly dropped: number
  /** Whether a dropped draft would block, which the summary line carries. */
  readonly droppedBlock: boolean
}

/** One check's drafts under a display cap. */
interface DraftCollector {
  /** Keep the draft when the cap allows it; otherwise count it and record its level. */
  add(head: DraftHead): void
  /** The kept drafts and what the cap dropped. */
  batch(): DraftBatch
}

/** Findings kept per check before the rest are summarized into one line; the shipped quality gate's default cap. */
export const DEFAULT_MAX_FINDINGS_PER_CHECK = 5

/** Tolerance the shipped quality gate applies to a declared character budget. */
export const DEFAULT_LENGTH_TOLERANCE = 0.2

/**
 * Residual placeholder forms: the unfilled-variable braces plus the marker list
 * an unfinished draft carries. Both come from the style package the render side
 * reads, so a form cannot be rejected by the gate and fillable by no variable.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = residualPlaceholderPatterns()

/**
 * Fragments a renderer answers without a heading or an explicit anchor. `top`
 * is the document top: browsers resolve it with no element declaring it, and
 * renderers conventionally emit `#top` back-links.
 */
const RENDERER_ANCHORS: readonly string[] = ['top']

/** A Markdown ATX heading line. */
const MARKDOWN_HEADING = /^#{1,6}[ \t]+(\S.*?)[ \t]*$/gmu

/** An HTML heading element. */
const HTML_HEADING = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/giu

/** A fenced code block's opening or closing line. */
const FENCE = /^[ \t]*(?:```|~~~).*$/gmu

/** A Markdown link or image whose target is a same-document fragment. */
const MARKDOWN_FRAGMENT = /\]\(#([^)\s]+)\)/gu

/** An HTML attribute whose value is a same-document fragment. */
const HTML_FRAGMENT = /(?:href|src)\s*=\s*"#([^"]*)"/giu

/** An explicit HTML anchor: an element id or a named anchor. */
const EXPLICIT_ANCHOR = /\s(?:id|name)\s*=\s*"([^"]+)"/giu

/**
 * A tag opening, closing slash included; sticky, so a scan resumes at one tag.
 * The element name is the match's suffix, so the scan reads it from the matched
 * text rather than from a capture group that could be absent.
 */
const TAG_OPENING = /<[ \t]*\/?[ \t]*[a-z][a-z0-9-]*/iuy

/** The `<`, whitespace, and closing slash a tag opening carries before its element name. */
const TAG_PREFIX = /^<[ \t]*\/?[ \t]*/u

/** The character references a document's prose carries. */
const CHARACTER_REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/gu

/** The named character references worth decoding; an unknown name stays source text. */
const NAMED_CHARACTER_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

/** Elements whose content is code for the renderer rather than document body text. */
const NON_TEXT_ELEMENTS: readonly string[] = ['script', 'style']

/**
 * An HTML element whose content the document shows as code rather than asserts
 * as prose. Its content is quoted text: a placeholder named inside it is a
 * sample, not a residual placeholder.
 */
const QUOTED_ELEMENTS: readonly string[] = ['pre', 'code', 'kbd', 'samp']

/** An HTML comment. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu

/**
 * An HTML tag, with its attributes.
 *
 * A `>` inside a quoted attribute value does not end the tag, so the value is
 * consumed whole. A tag cut at that `>` would leave the attributes behind it
 * outside every range, and a placeholder named in one of them would read as
 * visible body text.
 */
const HTML_TAG = /<[ \t]*\/?[ \t]*[a-z](?:[^"'>]|"[^"]*"|'[^']*')*>/giu

/** The value of one quoted HTML attribute. */
const HTML_ATTRIBUTE_VALUE = /=[ \t]*(?:"([^"]*)"|'([^']*)')/gu

/** A character range of the checked text. */
interface TextRange {
  readonly start: number
  readonly end: number
}

/** One heading occurrence: where it sits, what it renders to, and its outline level. */
interface HeadingSpan extends TextRange {
  /** The heading text with its Markdown or HTML markup removed. */
  readonly text: string
  /** Outline level: the `#` count of an ATX heading or the digit of an `h` element. */
  readonly level: number
}

/** One occurrence of a global expression: where it starts, what it matched, and its first group. */
interface TextMatch {
  readonly index: number
  readonly text: string
  readonly group: string
}

/**
 * Every occurrence of one global expression, in text order.
 *
 * `exec` is used instead of `matchAll` because its result types `index` as a
 * definite number, while `matchAll` types it optional and forces a fallback no
 * caller can reach. The expression's `lastIndex` is reset on entry, so a shared
 * constant expression stays safe to reuse after an interrupted scan.
 * @param text - the text to scan.
 * @param pattern - a global expression.
 * @returns one entry per occurrence.
 */
function matches(text: string, pattern: RegExp): TextMatch[] {
  pattern.lastIndex = 0
  const found: TextMatch[] = []
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push({ index: match.index, text: match[0], group: match[1] ?? '' })
  }
  return found
}

/** A literal string as a case-insensitive global expression. */
function literal(pattern: string): RegExp {
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
}

/** Whether an index falls inside any of the given ranges. */
function within(ranges: readonly TextRange[], index: number): boolean {
  return ranges.some(range => index >= range.start && index < range.end)
}

/** Line-start offsets of one text, for naming a finding's line. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/**
 * The 1-based line holding one text offset.
 * @param starts - the line-start offsets of the text.
 * @param offset - the offset to locate.
 * @returns the line number.
 */
function lineOf(starts: readonly number[], offset: number): number {
  let line = 1
  for (const [index, start] of starts.entries()) {
    if (start > offset) break
    line = index + 1
  }
  return line
}

/** Fenced code blocks of the text, paired by consecutive fence lines. */
function fenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  let start: number | undefined
  for (const match of matches(text, FENCE)) {
    if (start === undefined) {
      start = match.index
      continue
    }
    ranges.push({ start, end: match.index + match.text.length })
    start = undefined
  }
  if (start !== undefined) ranges.push({ start, end: text.length })
  return ranges
}

/** Inline code spans: a backtick run closed by an equally long run on the same line. */
const INLINE_CODE = /(`+)([^`\n]*?)\1/gu

/**
 * Quoted spans the checks treat as displayed text rather than content the
 * document asserts: fenced blocks plus inline code spans.
 *
 * A document that quotes the checks — a delivery checklist naming `[TBD]` or
 * `{{variable}}` inside inline code — carries the very strings these checks look
 * for, and quoting them is the way such a document talks about them. Both are
 * reported at `warn` instead of blocking.
 * @param text - the checked text.
 * @returns the ranges, in no particular order.
 */
function quotedRanges(text: string): TextRange[] {
  const inline = matches(text, INLINE_CODE).map(match => ({ start: match.index, end: match.index + match.text.length }))
  return [...fenceRanges(text), ...inline]
}

/**
 * The closing tag of one element at or after an index.
 * @param html - the document text.
 * @param name - the element name, lowercased.
 * @param from - the index to start the search at.
 * @returns the match, or null when the element is never closed.
 */
function closingTag(html: string, name: string, from: number): RegExpExecArray | null {
  const closing = new RegExp(`</${name}\\s*>`, 'giu')
  closing.lastIndex = from
  return closing.exec(html)
}

/** The prefix of a tag that closes an element, up to its name. */
const CLOSING_PREFIX = /^<[ \t]*\/[ \t]*/u

/**
 * The element name one tag opens, lowercased.
 *
 * A closing tag names no element: it ends a range rather than opening one, and
 * treating it as an opening tag would extend that element's content to the end
 * of the document.
 *
 * @param tag - The matched tag text.
 * @returns The element name, or undefined for a closing tag.
 */
function openedElementName(tag: string): string | undefined {
  // The closing slash is read from the tag itself: the prefix that strips it
  // would strip it from the name that follows too.
  if (tag.includes('/')) return undefined
  const opening = tag.replace(TAG_PREFIX, '').toLowerCase()
  // A tag always names an element: the tag expression requires a letter here.
  return opening.match(/^[a-z][a-z0-9-]*/u)?.[0]
}

/**
 * The element name one tag closes, lowercased.
 *
 * A tag that opens an element names none: it starts a range rather than ending
 * one. The prefix is stripped before the name is read, because a tag carrying a
 * slash anywhere else (`<img src="a/b">`) opens an element as usual.
 * @param tag - The matched tag text.
 * @returns The element name, or undefined for a tag that opens an element.
 */
function closingElementName(tag: string): string | undefined {
  if (!CLOSING_PREFIX.test(tag)) return undefined
  const closing = tag.replace(CLOSING_PREFIX, '').toLowerCase()
  return closing.match(/^[a-z][a-z0-9-]*/u)?.[0]
}

/** One open element whose content range is still being resolved. */
interface OpenElement {
  /** Index just past the opening tag. */
  readonly contentStart: number
}

/**
 * Append the content ranges of the named elements.
 *
 * One pass pairs every closing tag with the nearest open element of the same
 * name. Rescanning from each opening tag instead costs a full document scan per
 * unclosed element, which a document repeating `<code>` turns into minutes.
 *
 * An element that never closes has no content end the document states. The
 * `unclosed` argument decides what the callers do with it: `document` runs the
 * range to the document end, which is where a renderer ends such an element and
 * what {@link visibleText} already does for `script` and `style`; `none`
 * records no range, which leaves the text after the opening tag as body text.
 * Quoted elements take `none`: a truncated document must not turn every
 * remaining placeholder into a sample the gate only warns about.
 * @param html - the document text.
 * @param names - element names whose contents are recorded.
 * @param ranges - the list to append to.
 * @param unclosed - whether an element without a closing tag runs to the
 * document end (`document`) or records no range (`none`).
 */
function appendNamedContents(
  html: string, names: readonly string[], ranges: TextRange[], unclosed: 'document' | 'none',
): void {
  const open = new Map<string, OpenElement[]>()
  for (const tag of matches(html, HTML_TAG)) {
    const opened = openedElementName(tag.text)
    if (opened !== undefined) {
      if (!names.includes(opened)) continue
      const stack = open.get(opened) ?? []
      stack.push({ contentStart: tag.index + tag.text.length })
      open.set(opened, stack)
      continue
    }
    const closing = closingElementName(tag.text)
    if (closing === undefined || !names.includes(closing)) continue
    const element = open.get(closing)?.pop()
    if (element === undefined) continue
    ranges.push({ start: element.contentStart, end: tag.index })
  }
  if (unclosed === 'none') return
  for (const stack of open.values()) {
    for (const element of stack) ranges.push({ start: element.contentStart, end: html.length })
  }
}

/**
 * The quoted ranges of an HTML document: the contents of the elements that show
 * code or a keystroke rather than assert prose.
 *
 * An HTML delivery carries the same quoted text a Markdown delivery carries in
 * a fenced block or an inline code span, so a placeholder named inside a
 * `<pre>` or `<code>` element is a sample rather than a residual placeholder.
 * Without this, the same content passes as Markdown and is refused as HTML,
 * which makes the verdict depend on the export format instead of the document.
 *
 * Only an element with a closing tag quotes anything. A truncated document that
 * leaves a `<code>` open does not state where its sample ends, so treating the
 * rest of the file as quoted would let a residual placeholder anywhere after it
 * pass as a sample; the text stays body text and still blocks.
 * @param html - the document text.
 * @returns the ranges, in no particular order.
 */
function htmlQuotedRanges(html: string): TextRange[] {
  const ranges: TextRange[] = []
  appendNamedContents(html, QUOTED_ELEMENTS, ranges, 'none')
  return ranges
}

/**
 * The ranges of an HTML document that carry no visible text: comments, tags,
 * the values of attributes, and the contents of the elements whose text is for
 * the renderer rather than the reader.
 *
 * A reader sees none of it, so a placeholder named in an editing comment, in an
 * attribute such as `alt`, or in a script body is not content the document still
 * owes a reader. The element list is {@link NON_TEXT_ELEMENTS}, the same list
 * {@link visibleText} already treats this way.
 * @param html - the document text.
 * @returns the ranges, in no particular order.
 */
function htmlMarkupRanges(html: string): TextRange[] {
  const ranges: TextRange[] = matches(html, HTML_COMMENT)
    .map(match => ({ start: match.index, end: match.index + match.text.length }))
  for (const tag of matches(html, HTML_TAG)) {
    ranges.push({ start: tag.index, end: tag.index + tag.text.length })
    for (const value of matches(tag.text, HTML_ATTRIBUTE_VALUE)) {
      const valueStart = value.index + value.text.length - value.group.length
      ranges.push({ start: tag.index + valueStart, end: tag.index + valueStart + value.group.length })
    }
  }
  appendNamedContents(html, NON_TEXT_ELEMENTS, ranges, 'document')
  return ranges
}

/**
 * The index just past the closing tag of one non-text element.
 * @param html - the document text.
 * @param from - the index just past the element's opening tag.
 * @param name - the element name, as the tag carried it.
 * @returns the index after `</name>`, or the document end when the element is
 * never closed, which is how a renderer treats the rest of such a document.
 */
function endOfNonTextElement(html: string, from: number, name: string): number {
  const match = closingTag(html, name, from)
  return match === null ? html.length : match.index + match[0].length
}

/**
 * Decode the character references a document's prose carries, so `AT&amp;T`
 * measures as five characters rather than seven.
 * @param text - the text, with markup already removed.
 * @returns the text a reader sees; an unknown reference or an out-of-range code
 * point stays as written.
 */
function decodeCharacterReferences(text: string): string {
  return text.replace(
    CHARACTER_REFERENCE,
    (reference: string, decimal?: string, hexadecimal?: string, named?: string) => {
      if (named !== undefined) return NAMED_CHARACTER_REFERENCES[named.toLowerCase()] ?? reference
      // The two numeric alternatives are exclusive: `hexadecimal` is present
      // exactly when `decimal` is absent, so the fallback always carries digits.
      const codePoint = Number(decimal ?? `0x${hexadecimal}`)
      return codePoint > 0 && codePoint <= 0x10_ffff ? String.fromCodePoint(codePoint) : reference
    },
  )
}

/** The character an HTML tag name must be followed by, for a `<` in Markdown text to open a tag. */
const TAG_NAME_END = /^[ \t/>]/u

/**
 * The body text of one document: comments, declarations, tags, and the contents
 * of the elements that carry code for the renderer rather than text for a
 * reader (`script`, `style`) removed, character references decoded.
 *
 * The scan stays deliberately small because the checker reads a document, not a
 * browser's build of one: a stray `<` that opens no element stays prose, an
 * unclosed comment, declaration, or non-text element runs to the end the way a
 * renderer takes it, and quoted attributes holding `>` are out of scope.
 *
 * `language` decides what a `<` followed by letters means. In `html` it opens a
 * tag, which is how a browser tokenizes a bogus name too. In `markdown` it must
 * name a tag the way HTML does — the name ends at whitespace, `/`, or `>` — so
 * an autolink such as `<https://example.com>` stays the link text a reader sees
 * instead of being removed as markup and leaving its section empty.
 * @param text - the document text.
 * @param language - the document language, which decides what counts as a tag.
 * @returns the text a reader sees.
 */
function visibleText(text: string, language: 'html' | 'markdown'): string {
  let body = ''
  let index = 0
  while (index < text.length) {
    const opening = text.indexOf('<', index)
    if (opening === -1) {
      body += text.slice(index)
      break
    }
    body += text.slice(index, opening)
    if (text.startsWith('<!--', opening)) {
      const commentEnd = text.indexOf('-->', opening)
      index = commentEnd === -1 ? text.length : commentEnd + 3
      continue
    }
    if (text.startsWith('<!', opening)) {
      // A declaration (`<!doctype html>`) is markup, never prose.
      const declarationEnd = text.indexOf('>', opening)
      index = declarationEnd === -1 ? text.length : declarationEnd + 1
      continue
    }
    TAG_OPENING.lastIndex = opening
    const tag = TAG_OPENING.exec(text)
    const named = tag !== null && (language === 'html' || TAG_NAME_END.test(text.charAt(TAG_OPENING.lastIndex)))
    if (!named) {
      // No element name follows the `<`, so it is prose, as in "a < b".
      body += '<'
      index = opening + 1
      continue
    }
    const tagEnd = text.indexOf('>', TAG_OPENING.lastIndex)
    if (tagEnd === -1) {
      body += text.slice(opening)
      break
    }
    index = tagEnd + 1
    const tagOpening = tag[0]
    const name = tagOpening.replace(TAG_PREFIX, '').toLowerCase()
    // A closing tag of a non-text element carries no opening of its own.
    if (tagOpening.includes('/') || !NON_TEXT_ELEMENTS.includes(name)) continue
    index = endOfNonTextElement(text, index, name)
  }
  return decodeCharacterReferences(body)
}

/** Strip the markup a heading may carry, so its slug matches what a renderer shows. */
function renderedHeading(text: string): string {
  return text
    .replace(/<[^>]*>/gu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[`*~]/gu, '')
    .trim()
}

/**
 * The anchor a renderer assigns to a heading: GitHub's rule of lowercasing and
 * dropping everything but letters, numbers, underscores, spaces, and hyphens,
 * with spaces becoming hyphens.
 * @param heading - the rendered heading text.
 * @returns the heading's slug.
 */
function headingSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

/**
 * The length of a Markdown heading line's `#` run.
 * @param line - a matched ATX heading line.
 * @returns the outline level.
 */
function markdownLevel(line: string): number {
  return line.length - line.replace(/^#+/u, '').length
}

/**
 * The digit of an HTML heading element.
 * @param element - a matched `<h1>`…`<h6>` element.
 * @returns the outline level.
 */
function htmlLevel(element: string): number {
  return Number(element.charAt(2))
}

/**
 * Every heading of the text, in order, as the document language spells one.
 *
 * A `#` line inside a fence, and any heading inside quoted text, is a sample
 * rather than an outline entry. An HTML document's outline is its `h` elements
 * only: Markdown syntax is not in play there, so a `#` line in prose or in a
 * `<pre>` sample must not become a heading with its own slug and section.
 * @param text - the document text.
 * @param fences - the fenced code ranges.
 * @param quoted - the quoted ranges, whose contents the document shows as samples.
 * @param format - the document's format; `html` reads `h` elements only.
 * @returns the headings, in text order.
 */
function headingSpans(
  text: string, fences: readonly TextRange[], quoted: readonly TextRange[],
  format: DocumentTextCheckOptions['format'],
): HeadingSpan[] {
  const spans: HeadingSpan[] = []
  const collect = (pattern: RegExp, levelOf: (line: string) => number): void => {
    for (const match of matches(text, pattern)) {
      if (within(fences, match.index) || within(quoted, match.index)) continue
      spans.push({
        start: match.index,
        end: match.index + match.text.length,
        text: renderedHeading(match.group),
        level: levelOf(match.text),
      })
    }
  }
  if (format === 'html') collect(HTML_HEADING, htmlLevel)
  else {
    collect(MARKDOWN_HEADING, markdownLevel)
    collect(HTML_HEADING, htmlLevel)
  }
  return spans.sort((left, right) => left.start - right.start)
}

/**
 * Every fragment the text declares: each heading's slug with GitHub's
 * collision suffixes, plus every explicit id or named anchor outside a fence.
 */
function declaredAnchors(text: string, fences: readonly TextRange[], headings: readonly HeadingSpan[]): Set<string> {
  const anchors = new Set<string>()
  const bumps = new Map<string, number>()
  for (const heading of headings) {
    const base = headingSlug(heading.text)
    let bump = bumps.get(base) ?? 0
    let candidate = bump === 0 ? base : `${base}-${bump}`
    while (anchors.has(candidate)) {
      bump += 1
      candidate = `${base}-${bump}`
    }
    // The next heading with this slug starts past the suffix just taken, so a
    // document repeating one heading does not re-probe every earlier suffix.
    bumps.set(base, bump + 1)
    anchors.add(candidate)
  }
  for (const match of matches(text, EXPLICIT_ANCHOR)) {
    if (within(fences, match.index)) continue
    anchors.add(match.group)
  }
  return anchors
}

/**
 * Append one check's findings, capped so a badly broken document does not flood
 * the result: the cap is reported as its own line rather than silently dropping
 * the remainder.
 *
 * The summary line carries the level of the worst dropped draft, not the check's
 * default: a blocking style word ranked after the cap must still block, and a run
 * of merely-reported drafts (a fenced placeholder) must not start blocking just
 * because it is long.
 * @param into - the finding list to append to.
 * @param check - the check the drafts belong to.
 * @param level - the level a draft without its own carries.
 * @param batch - the drafts the check kept and what its cap dropped.
 */
function report(
  into: DocumentCheckFinding[], check: DocumentCheckId, level: DocumentCheckLevel, batch: DraftBatch,
): void {
  for (const draft of batch.drafts) {
    into.push({
      check,
      level: draft.level ?? level,
      detail: draft.detail,
      ...draft.line === 0 ? {} : { line: draft.line },
    })
  }
  if (batch.dropped === 0) return
  into.push({
    check,
    level: batch.droppedBlock ? 'block' : 'warn',
    detail: `另有 ${String(batch.dropped)} 处同类问题未逐条列出`,
  })
}

/**
 * Collect one check's drafts under its display cap.
 *
 * A draft past the cap is counted without rendering its line or detail: a
 * delivered document can repeat one match hundreds of thousands of times, and
 * rendering findings the result never shows is what made the scan quadratic.
 * @param limit - drafts kept before the rest are summarized into one line.
 * @param defaultLevel - the level a draft without its own carries.
 * @returns the collector.
 */
function draftCollector(limit: number, defaultLevel: DocumentCheckLevel): DraftCollector {
  const drafts: DraftFinding[] = []
  let dropped = 0
  let droppedBlock = false
  return {
    add(head: DraftHead): void {
      if (drafts.length >= limit) {
        dropped += 1
        if ((head.level ?? defaultLevel) === 'block') droppedBlock = true
        return
      }
      const line = head.line()
      drafts.push({
        detail: head.detail(line),
        line,
        ...head.level === undefined ? {} : { level: head.level },
      })
    },
    batch: (): DraftBatch => ({ drafts, dropped, droppedBlock }),
  }
}

/**
 * Residual placeholders; one shown as quoted text (fenced block or inline code) is
 * only reported, everything else blocks.
 */
function placeholderDrafts(
  text: string, starts: readonly number[], quoted: readonly TextRange[], limit: number,
): DraftBatch {
  const outside = draftCollector(limit, 'block')
  const inside = draftCollector(limit, 'warn')
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const match of matches(text, pattern)) {
      const head: DraftHead = {
        line: () => lineOf(starts, match.index),
        detail: line => `第 ${String(line)} 行仍有残余占位符 ${JSON.stringify(match.text)}`,
      }
      if (within(quoted, match.index)) inside.add({ ...head, level: 'warn' })
      else outside.add(head)
    }
  }
  const unquoted = outside.batch()
  const fenced = inside.batch()
  const merged = [...unquoted.drafts, ...fenced.drafts]
  return {
    // Unquoted drafts come first and are already capped, so whatever this slice
    // drops is a quoted draft, which only ever warns.
    drafts: merged.slice(0, limit),
    dropped: unquoted.dropped + fenced.dropped + Math.max(0, merged.length - limit),
    droppedBlock: unquoted.droppedBlock || fenced.droppedBlock,
  }
}

/** Same-document fragments the text links to but does not declare. */
function anchorDrafts(
  text: string, starts: readonly number[], fences: readonly TextRange[], headings: readonly HeadingSpan[],
  limit: number,
): DraftBatch {
  const anchors = declaredAnchors(text, fences, headings)
  const collector = draftCollector(limit, 'warn')
  const seen = new Set<string>()
  for (const pattern of [MARKDOWN_FRAGMENT, HTML_FRAGMENT]) {
    for (const match of matches(text, pattern)) {
      if (within(fences, match.index)) continue
      let fragment = match.group
      try {
        fragment = decodeURIComponent(match.group)
      } catch {
        // A malformed escape names no anchor the document could declare, so the
        // raw text is what the lookup reports missing.
        fragment = match.group
      }
      if (fragment === '' || RENDERER_ANCHORS.includes(fragment) || anchors.has(fragment) || seen.has(fragment)) continue
      seen.add(fragment)
      collector.add({
        line: () => lineOf(starts, match.index),
        detail: line => `第 ${String(line)} 行链接到本文档未声明的锚点 "#${fragment}"`,
      })
    }
  }
  return lineOrderedBatch(collector)
}

/**
 * A collector's batch with its drafts in text order.
 *
 * The anchor and forbidden-word checks report matches in whatever order their
 * scans produce, which is not text order across several patterns; the
 * placeholder check keeps its own order so unfenced findings stay ahead of
 * fenced ones.
 * @param collector - the check's collector.
 * @returns the kept drafts sorted by line, and what the display cap dropped.
 */
function lineOrderedBatch(collector: DraftCollector): DraftBatch {
  const batch = collector.batch()
  return { ...batch, drafts: [...batch.drafts].sort((left, right) => left.line - right.line) }
}

/**
 * Headings whose section holds no content before the next heading.
 *
 * An H1 is the document title, and a document conventionally writes it directly
 * above its first section heading; the content under that deeper heading is the
 * H1's own section, so the pair is not an empty section. An H1 with no heading
 * after it, and one followed by another H1, still are empty sections, and a
 * deeper heading keeps the rule it always had.
 *
 * The body is read the way the document's language says: an HTML document
 * removes its markup, while a Markdown document keeps text that only looks like
 * markup, such as an autolink, so a link-only section is not reported empty.
 * @param text - the document text.
 * @param starts - the line-start indices of the text.
 * @param headings - the headings to test.
 * @param format - the document's format, which decides how much markup the body scan removes.
 * @param limit - drafts kept before the rest are summarized into one line.
 * @returns the drafts and what the display cap dropped.
 */
function emptySectionDrafts(
  text: string, starts: readonly number[], headings: readonly HeadingSpan[],
  format: DocumentTextCheckOptions['format'], limit: number,
): DraftBatch {
  const collector = draftCollector(limit, 'warn')
  for (const [index, heading] of headings.entries()) {
    const next = headings[index + 1]
    if (heading.level === 1 && next !== undefined && next.level > 1) continue
    const body = text.slice(heading.end, next?.start ?? text.length)
    if (visibleText(body, format === 'html' ? 'html' : 'markdown').trim() !== '') continue
    collector.add({
      line: () => lineOf(starts, heading.start),
      detail: line => `第 ${String(line)} 行的标题 ${JSON.stringify(heading.text)} 下没有任何内容`,
    })
  }
  return collector.batch()
}

/** Occurrences of the style's forbidden words, at the severity the style declares. */
function antiPatternDrafts(
  text: string, starts: readonly number[], patterns: readonly AntiPattern[], quoted: readonly TextRange[],
  limit: number,
): DraftBatch {
  const collector = draftCollector(limit, 'warn')
  for (const pattern of patterns) {
    for (const match of matches(text, literal(pattern.word))) {
      const quotedHit = within(quoted, match.index)
      collector.add({
        line: () => lineOf(starts, match.index),
        level: pattern.severity === 'block' && !quotedHit ? 'block' : 'warn',
        detail: line => quotedHit
          ? `第 ${String(line)} 行引用文本中出现样式禁用词 ${JSON.stringify(pattern.word)}（不影响判定）`
          : `第 ${String(line)} 行出现样式禁用词 ${JSON.stringify(pattern.word)}，建议改用 ${JSON.stringify(pattern.replace)}`,
      })
    }
  }
  return lineOrderedBatch(collector)
}

/**
 * The declared character budget against the body text's non-whitespace
 * character count. An HTML document is measured after {@link visibleText}, so
 * its markup, stylesheet, and script never inflate the count.
 */
function budgetDrafts(
  text: string, charBudget: number, tolerance: number, format: DocumentTextCheckOptions['format'],
): DraftBatch {
  const actual = (format === 'html' ? visibleText(text, 'html') : text).replace(/\s/gu, '').length
  const minimum = Math.floor(charBudget * (1 - tolerance))
  const maximum = Math.ceil(charBudget * (1 + tolerance))
  if (actual >= minimum && actual <= maximum) return { drafts: [], dropped: 0, droppedBlock: false }
  return {
    drafts: [{
      detail: `全文 ${String(actual)} 字，${actual < minimum ? '低于' : '超出'}声明的 ${String(charBudget)} 字预算（允许 ${String(minimum)}–${String(maximum)} 字）`,
      line: 0,
    }],
    dropped: 0,
    droppedBlock: false,
  }
}

/**
 * Run every deterministic check over one document's text.
 * @param text - the document text: a rendered Markdown or HTML file, or the text projected out of a DOCX package.
 * @param options - the style whose forbidden words are enforced, the declared
 * character budget, and the format when it changes how the text is measured.
 * @returns the findings in check order, empty for a document that passes every check.
 */
export function checkDocumentText(text: string, options: DocumentTextCheckOptions = {}): DocumentCheckFinding[] {
  const starts = lineStarts(text)
  const fences = fenceRanges(text)
  const isHtml = options.format === 'html'
  // A heading is excluded by the quoted ranges, not by the markup ranges: an
  // HTML heading starts at its own tag, which the markup scan records.
  const quotedText = isHtml ? htmlQuotedRanges(text) : quotedRanges(text)
  const quoted = isHtml ? [...quotedText, ...htmlMarkupRanges(text)] : quotedText
  const headings = headingSpans(text, fences, quotedText, options.format)
  const findings: DocumentCheckFinding[] = []
  const maxFindings = options.maxFindingsPerCheck ?? DEFAULT_MAX_FINDINGS_PER_CHECK
  report(findings, 'placeholder', 'block', placeholderDrafts(text, starts, quoted, maxFindings))
  report(findings, 'broken_anchor', 'warn', anchorDrafts(text, starts, fences, headings, maxFindings))
  report(findings, 'empty_section', 'warn', emptySectionDrafts(text, starts, headings, options.format, maxFindings))
  report(
    findings, 'anti_pattern', 'warn',
    antiPatternDrafts(text, starts, options.style?.sections.antiPatterns ?? [], quoted, maxFindings),
  )
  if (options.charBudget !== undefined) {
    report(
      findings, 'length_budget', 'warn',
      budgetDrafts(text, options.charBudget, options.lengthTolerance ?? DEFAULT_LENGTH_TOLERANCE, options.format),
    )
  }
  return findings
}
