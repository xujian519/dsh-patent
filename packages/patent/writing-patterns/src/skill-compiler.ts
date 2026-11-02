/**
 * The skill compiler: renders selected patterns as the one `<writing_skills>`
 * XML block that a system prompt or a tool result injects.
 *
 * The output is a pure function of the patterns, so a caller can assert the
 * exact injected text. Layout and element names are those of the Go source
 * (`skill_compiler.go`), which is what prompts already trained against it expect.
 * @module @deepseek-ai/dsh-writing-patterns/skill-compiler
 */

import type { WritingPattern } from './types.ts'

/** Indentation of one nesting level. */
const INDENT = '  '

/**
 * Compile patterns into a `<writing_skills>` block.
 * @param patterns - the patterns to compile, in the order they should be read.
 * @returns the XML block, or `''` when there is no pattern to compile.
 */
export function compileWritingSkills(patterns: readonly WritingPattern[]): string {
  if (patterns.length === 0) return ''
  const lines = ['<writing_skills>']
  for (const pattern of patterns) appendPattern(lines, pattern)
  lines.push('</writing_skills>')
  return lines.join('\n')
}

/**
 * Compile patterns into the compact `<pattern_index>` block a system prompt
 * carries by default: one line per pattern with its id, category, and name.
 * Full steps and rules stay behind `query_writing_patterns`, so an always-on
 * section does not resend the whole corpus on every request.
 * @param patterns - the patterns to index, in the order they should be read.
 * @returns the XML block, or `''` when there is no pattern to index.
 */
export function compileWritingPatternIndex(patterns: readonly WritingPattern[]): string {
  if (patterns.length === 0) return ''
  const lines = ['<pattern_index>']
  for (const pattern of patterns) {
    // The category is a validated member of the closed set, so it needs no escaping.
    lines.push(`${INDENT}<pattern id="${escapeXmlText(pattern.id)}" category="${pattern.category}">${escapeXmlText(pattern.name)}</pattern>`)
  }
  lines.push('</pattern_index>')
  return lines.join('\n')
}

/**
 * Escape text for an XML text node or attribute value.
 * @param value - the raw text.
 * @returns the text with the five predefined XML entities escaped.
 */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;')
}

/** Append one `<skill>` element. */
function appendPattern(lines: string[], pattern: WritingPattern): void {
  lines.push(`${INDENT}<skill id="${escapeXmlText(pattern.id)}">`)
  lines.push(`${INDENT}${INDENT}<name>${escapeXmlText(pattern.name)}</name>`)
  // The category is a validated member of the closed set, so it needs no escaping.
  lines.push(`${INDENT}${INDENT}<category>${pattern.category}</category>`)
  lines.push(`${INDENT}${INDENT}<summary>${escapeXmlText(pattern.summary)}</summary>`)
  if (pattern.context !== undefined) {
    lines.push(`${INDENT}${INDENT}<context>${escapeXmlText(pattern.context)}</context>`)
  }
  if (pattern.steps.length > 0) {
    lines.push(`${INDENT}${INDENT}<steps>`)
    for (const step of pattern.steps) {
      lines.push(`${INDENT}${INDENT}${INDENT}<step order="${String(step.order)}">`)
      lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}<name>${escapeXmlText(step.name)}</name>`)
      lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}<instruction>${escapeXmlText(step.instruction)}</instruction>`)
      if (step.example !== undefined) {
        lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}<example>${escapeXmlText(step.example)}</example>`)
      }
      lines.push(`${INDENT}${INDENT}${INDENT}</step>`)
    }
    lines.push(`${INDENT}${INDENT}</steps>`)
  }
  appendPrinciples(lines, 'dos', pattern.dos.map(principle => principle.rule))
  appendPrinciples(lines, 'donts', pattern.donts.map(principle => principle.rule))
  lines.push(`${INDENT}</skill>`)
}

/** Append one `<dos>` or `<donts>` element. */
function appendPrinciples(lines: string[], tag: 'dos' | 'donts', rules: readonly string[]): void {
  if (rules.length === 0) return
  lines.push(`${INDENT}${INDENT}<${tag}>`)
  for (const rule of rules) {
    lines.push(`${INDENT}${INDENT}${INDENT}<principle>${escapeXmlText(rule)}</principle>`)
  }
  lines.push(`${INDENT}${INDENT}</${tag}>`)
}
