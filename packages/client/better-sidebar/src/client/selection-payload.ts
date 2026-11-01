/**
 * Pure payload builders for the "add selection to conversation" popup in the
 * text viewers (markdown preview + the catch-all code viewer). Everything
 * here is string math — no React, no ctx — so the unit tests cover it
 * directly.
 *
 * Insert shape (agreed with the product owner):
 * - Selection ≤ SELECTION_LIMIT characters: a fenced code block whose info
 *   line is `相对路径:起止行` and whose body is the selected text.
 * - Selection over the limit: a single plain-text line `相对路径:起止行`
 *   (no fence, no content).
 * - The path is relative to the session cwd (the same projection the
 *   explorer's @ button uses); an unknown cwd falls back to the absolute
 *   path.
 * - Line numbers: single-line selections write `path:12`, multi-line write
 *   `path:12-15`. The markdown preview cannot map rendered DOM back to
 *   source lines directly, so it reverse-searches the selected text in the
 *   source and only reports lines on an unambiguous hit (see
 *   {@link linesOfSelection}).
 */
import { relativeTo } from './paths.ts'

/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export const SELECTION_LIMIT = 500

/** The source line span a selection maps to (1-based, inclusive). */
interface SelectionLines {
  start: number
  end: number
}

/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown (the preview reverse-search missed).
 * @param path - Absolute file path.
 * @param cwd - Session cwd making the path relative; unknown keeps the absolute path.
 * @param lines - Selection line span, or undefined to omit line numbers.
 * @returns The `rel[:start[-end]]` header line.
 */
export function headerOf(path: string, cwd: string | undefined, lines?: SelectionLines): string {
  const rel = cwd !== undefined ? relativeTo(cwd, path) : path
  if (lines === undefined) return rel
  if (lines.end > lines.start) return `${rel}:${lines.start}-${lines.end}`
  return `${rel}:${lines.start}`
}

/**
 * The full text appended to the composer draft for one selection.
 * Over the limit the content is dropped: the plain path line is the whole
 * payload (an empty fenced block would just occupy the draft).
 * @param path - Absolute file path.
 * @param cwd - Session cwd making the path relative; unknown keeps the absolute path.
 * @param lines - Selection line span, or undefined when unknown.
 * @param selected - Selected text; over SELECTION_LIMIT only the header line is inserted.
 * @returns The fenced code block, or the bare header line when the selection exceeds the limit.
 */
export function buildSelectionInsert(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
): string {
  const header = headerOf(path, cwd, lines)
  if (selected.length > SELECTION_LIMIT) return header
  return `\`\`\`${header}\n${selected}\n\`\`\``
}

/** 1-based line number of a character index in a text. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/**
 * Reverse-map a rendered-DOM selection back to source line numbers. The
 * preview selection is plain text (block boundaries come out as `\n`), so
 * this is a best-effort substring search: a single trailing newline is
 * stripped first (DOM block selections tend to carry one), and only an
 * EXACTLY-ONE occurrence yields lines — an ambiguous or missing match
 * returns null (the header then carries the path without line numbers).
 * @param source - Full source text the preview rendered.
 * @param selected - Selected text as taken from the DOM (one trailing newline is stripped).
 * @returns The 1-based line span of the unique match, or null when the match is missing or ambiguous.
 */
export function linesOfSelection(source: string, selected: string): SelectionLines | null {
  const text = selected.endsWith('\n') ? selected.slice(0, -1) : selected
  if (text === '') return null
  const at = source.indexOf(text)
  if (at === -1) return null
  if (source.indexOf(text, at + 1) !== -1) return null
  return {
    start: lineAt(source, at),
    end: lineAt(source, at + Math.max(text.length - 1, 0)),
  }
}
