/**
 * Markdown block and inline parsing for the writer, ported from
 * `domains/doctmpl/renderer_docx.go` of the Go project Mady.
 *
 * Accepted syntax: `#`-prefixed headings up to level 6, plain paragraphs,
 * `-` or `*` list items, pipe tables, fenced code blocks, and inline `**bold**`
 * and `` `code` `` spans. Anything else stays paragraph text instead of failing.
 */

import { HEADING_MARKER, headingLevelOf, type DocxBlock, type DocxInlineRun, type DocxTableRow, type HeadingLevel } from './types.ts'

/** Marker opening and closing a bold span. */
const BOLD_MARKER = '**'

/** Marker opening and closing a code span. */
const CODE_MARKER = '`'

/** Markers that end a plain run, in the order the upstream scanner tests them. */
const INLINE_MARKERS = [BOLD_MARKER, CODE_MARKER] as const

/**
 * Find where the next inline marker starts.
 * @param text - the line being scanned.
 * @param cursor - the position the run starts at.
 * @returns the earliest marker position, or the position after `cursor` when the cursor itself is one.
 */
function nextMarkerOffset(text: string, cursor: number): number {
  let next = text.length
  for (const marker of INLINE_MARKERS) {
    const found = text.indexOf(marker, cursor)
    if (found >= 0 && found < next) next = found
  }
  return next <= cursor ? cursor + 1 : next
}

/**
 * Split one line into its decorated spans.
 * An unpaired marker stays literal text; a paired marker with no text between
 * its markers yields an empty run, which the renderer drops.
 * @param text - one line of block text.
 * @returns the spans in line order.
 */
export function parseInline(text: string): readonly DocxInlineRun[] {
  const runs: DocxInlineRun[] = []
  let cursor = 0
  while (cursor < text.length) {
    if (text.startsWith(BOLD_MARKER, cursor)) {
      const end = text.indexOf(BOLD_MARKER, cursor + BOLD_MARKER.length)
      if (end >= 0) {
        runs.push({ text: text.slice(cursor + BOLD_MARKER.length, end), bold: true, code: false })
        cursor = end + BOLD_MARKER.length
        continue
      }
    }
    if (text.startsWith(CODE_MARKER, cursor)) {
      const end = text.indexOf(CODE_MARKER, cursor + CODE_MARKER.length)
      if (end >= 0) {
        runs.push({ text: text.slice(cursor + CODE_MARKER.length, end), bold: false, code: true })
        cursor = end + CODE_MARKER.length
        continue
      }
    }
    const next = nextMarkerOffset(text, cursor)
    runs.push({ text: text.slice(cursor, next), bold: false, code: false })
    cursor = next
  }
  return runs
}

/**
 * Read a heading line.
 * @param line - trimmed line.
 * @returns the level and text, or `undefined` when the line is not a heading of level 1 through 6.
 */
function parseHeading(line: string): { readonly level: HeadingLevel; readonly text: string } | undefined {
  if (!line.startsWith(HEADING_MARKER)) return undefined
  let hashes = 0
  while (hashes < line.length && line.charAt(hashes) === HEADING_MARKER) hashes += 1
  const rest = line.slice(hashes)
  if (!rest.startsWith(' ')) return undefined
  const level = headingLevelOf(hashes)
  return level === undefined ? undefined : { level, text: rest.trim() }
}

/**
 * Whether a line opens a list item.
 * @param line - trimmed line.
 * @returns whether the line starts with the `- ` or `* ` marker.
 */
function isListItem(line: string): boolean {
  return line.startsWith('- ') || line.startsWith('* ')
}

/**
 * Whether a table line is its separator row.
 * Only lines starting with `|` reach this predicate, so the upstream pipe test is implied.
 * @param line - trimmed table line.
 * @returns whether the line holds only hyphens, pipes, and spaces, and at least one hyphen.
 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false
  return line.replaceAll(' ', '').replaceAll('-', '').replaceAll('|', '') === ''
}

/**
 * Split one table line into its cells.
 * @param line - trimmed table line.
 * @returns the trimmed cell texts between the outer pipes.
 */
function parseTableRow(line: string): DocxTableRow {
  const inner = line.replace(/^\|/u, '').replace(/\|$/u, '')
  return inner.split('|').map(cell => parseInline(cell.trim()))
}

/** Fence marker characters; CommonMark accepts both. */
const FENCE_MARKERS = ['`', '~'] as const

/** A fence marker character. */
type FenceMarker = (typeof FENCE_MARKERS)[number]

/** Indentation a fence line may carry before its marker. */
const FENCE_MAX_INDENT = 3

/** Open fenced block: its marker character and the marker run that opened it. */
type Fence = { readonly marker: FenceMarker; readonly length: number }

/**
 * Read a line that opens a fenced code block.
 * An info string follows the opening run; a backtick fence cannot carry a
 * backtick in that string, because the same characters would close it.
 * @param line - one source line, without its line ending.
 * @returns the open fence, or `undefined` when the line opens none.
 */
function fenceOpening(line: string): Fence | undefined {
  const leading = line.length - line.trimStart().length
  if (leading > FENCE_MAX_INDENT) return undefined
  const content = line.slice(leading)
  const marker: string = content.charAt(0)
  if (marker !== '`' && marker !== '~') return undefined
  let run = 0
  while (run < content.length && content.charAt(run) === marker) run += 1
  if (run < 3) return undefined
  if (marker === '`' && content.slice(run).includes('`')) return undefined
  return { marker, length: run }
}

/**
 * Whether a line closes the open fenced block.
 * The closing run uses the same character, is at least as long as the opening
 * run, and carries nothing but spaces after it.
 * @param line - one source line, without its line ending.
 * @param fence - the open fence.
 * @returns whether the line closes it.
 */
function closesFence(line: string, fence: Fence): boolean {
  const leading = line.length - line.trimStart().length
  if (leading > FENCE_MAX_INDENT) return false
  const content = line.trim()
  let run = 0
  while (run < content.length && content.charAt(run) === fence.marker) run += 1
  return run >= fence.length && content.slice(run) === ''
}

/**
 * Render one fenced code line as a monospace paragraph run.
 *
 * Markers inside a fence are code, so the line is taken verbatim: parsing
 * inline decoration would turn `**` or a backtick in the sample into formatting
 * and change the text the reviewer sees.
 * @param line - the source line, verbatim.
 * @returns the paragraph block for that line.
 */
function codeLineBlock(line: string): DocxBlock {
  return { kind: 'paragraph', runs: [{ text: line, bold: false, code: true }] }
}

/**
 * Parse Markdown into the block model the writer renders.
 * A line ending opens a new block only as the upstream renderer did: consecutive
 * plain lines join into one paragraph, a separator row inside a table run is
 * dropped, and an empty table contributes no block. A fenced code block keeps
 * every line verbatim as a monospace paragraph, so `#`, `|`, or `**` inside a
 * sample stay text; its info string is not rendered.
 * @param markdown - the Markdown source.
 * @returns the blocks in source order.
 */
export function parseMarkdown(markdown: string): readonly DocxBlock[] {
  const blocks: DocxBlock[] = []
  let paragraph: string[] = []
  let table: DocxTableRow[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ')) })
    paragraph = []
  }

  const flushTable = (): void => {
    if (table.length === 0) return
    blocks.push({ kind: 'table', rows: table })
    table = []
  }

  let fence: Fence | undefined
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\r+$/u, '')
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined
        continue
      }
      flushParagraph()
      flushTable()
      blocks.push(codeLineBlock(line))
      continue
    }
    const opening = fenceOpening(line)
    if (opening !== undefined) {
      flushParagraph()
      flushTable()
      fence = opening
      continue
    }
    const text = line.trim()
    if (text.startsWith('|')) {
      flushParagraph()
      if (!isTableSeparator(text)) table.push(parseTableRow(text))
      continue
    }
    flushTable()
    const heading = parseHeading(text)
    if (heading !== undefined) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading.level, text: heading.text })
      continue
    }
    if (isListItem(text)) {
      flushParagraph()
      blocks.push({ kind: 'listItem', runs: parseInline(text.slice(2).trim()) })
      continue
    }
    if (text === '') {
      flushParagraph()
      continue
    }
    paragraph.push(text)
  }
  flushTable()
  flushParagraph()
  return blocks
}
