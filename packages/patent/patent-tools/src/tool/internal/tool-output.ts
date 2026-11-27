/**
 * Shared output schema and Markdown rendering for model-visible warning lists.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/tool-output
 */

/** JSON schema for a required list of model-visible warnings. */
export const WARNINGS_SCHEMA = {
  type: 'array',
  required: true,
  items: { type: 'string' },
} as const

/**
 * Render one `## heading` section; produces no lines when the list is empty.
 * @param title - section heading.
 * @param lines - the section's rendered lines, already bulleted or prose.
 * @returns a blank separator, the heading, and the lines; empty when there are none.
 */
export function reportSection(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, ...lines]
}

/**
 * Collapse a report body and its rendered sections into one text result.
 * @param lines - the report body lines.
 * @param sections - section lines assembled with {@link reportSection}.
 * @returns the single text block a tool's `render` returns.
 */
export function textReport(lines: readonly string[], sections: readonly string[]): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: [...lines, ...sections].join('\n') }]
}

/**
 * Render a warning list as a Markdown section.
 * @param warnings - model-visible warnings.
 * @param heading - heading text used when the list is non-empty.
 * @returns a blank separator, the heading, and one bullet per warning; empty when there are none.
 */
export function warningSection(warnings: readonly string[], heading = '警告'): string[] {
  if (warnings.length === 0) return []
  return ['', `## ${heading}`, ...warnings.map(warning => `- ${warning}`)]
}
