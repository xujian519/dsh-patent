/**
 * The model-facing writing-pattern section: the stable instruction prose plus
 * the compiled `<writing_skills>` block of the patterns this deployment injects.
 * @module @deepseek-ai/dsh-writing-patterns/prompt
 */

/** Name of the system-prompt section this package contributes. */
export const WRITING_PATTERNS_SECTION_NAME = 'writing-patterns:skills'

/**
 * Stable system-prompt prose: what the injected block is, and when the model
 * should reach for the tool instead of reading it.
 */
export const WRITING_PATTERNS_PROMPT_TEXT = [
  'The <pattern_index> block below lists the writing patterns of this deployment by id, category, and name; it is an index, not the pattern text.',
  'Call query_writing_patterns with the case category, the case features, or search keywords to retrieve the matching patterns with their ordered steps and the rules to follow or avoid. When the case at hand is already covered by one of the indexed patterns, retrieve that pattern before drafting.',
].join('\n\n')

/**
 * The section text: the instruction prose, then the compiled pattern index when
 * the deployment injects any.
 *
 * The compiled block is fenced so the section reads as instruction prose plus
 * one quoted data block: a bare multi-line XML run would parse as a prose
 * paragraph of the prompt itself, which both obscures where the data starts and
 * violates the one-physical-line-per-paragraph convention for prompt text. The
 * fence is longer than any backtick run in the block, so authored text cannot
 * close it early.
 * @param skills - the compiled `<writing_skills>` block, or `''` for none.
 * @returns the section text.
 */
export function renderWritingSkillsSection(skills: string): string {
  if (skills === '') return WRITING_PATTERNS_PROMPT_TEXT
  const fence = fenceFor(skills)
  return `${WRITING_PATTERNS_PROMPT_TEXT}\n\n${fence}xml\n${skills}\n${fence}`
}

/** A backtick fence longer than any backtick run in `text`. */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}
