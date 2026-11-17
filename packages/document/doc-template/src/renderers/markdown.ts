/**
 * The Markdown renderer, rewritten from `renderer_markdown.go` of the Go project
 * Mady: the resolved body passes through with an optional disclaimer prefix and
 * an optional level-1 title.
 * @module @deepseek-ai/dsh-doc-template/renderers/markdown
 */

import {
  DISCLAIMER_PREFIX,
  DISCLAIMER_SEPARATOR,
  type Renderer,
  type RenderMeta,
  type RenderStyle,
} from '../types.ts'

/**
 * Prepend a style's disclaimer to a Markdown body. The marker and separator are
 * the upstream form, which the DOCX package of `@deepseek-ai/dsh-docx-kit` also
 * produces, so the two render paths agree.
 * @param style - the render style, absent when the template declares none.
 * @param markdown - the body.
 * @returns the body with the disclaimer in front, or the body unchanged.
 */
export function applyDisclaimer(style: RenderStyle | undefined, markdown: string): string {
  if (style === undefined || style.disclaimer === '') return markdown
  return `${DISCLAIMER_PREFIX}${style.disclaimer}${DISCLAIMER_SEPARATOR}${markdown}`
}

/**
 * Whether the resolved body opens with its own level-1 heading.
 * HTML and DOCX use the same check, so `meta.title` does not add a second
 * heading. The body is read before a disclaimer is prefixed.
 * @param markdown - the resolved body, before any disclaimer.
 * @returns whether `markdown` starts with `# `.
 */
export function bodyOpensWithLevel1Heading(markdown: string): boolean {
  return markdown.startsWith('# ')
}

/**
 * Render a resolved body as Markdown. A title is added only when the body does
 * not open with its own level-1 heading, as upstream.
 * @param markdown - the resolved body.
 * @param meta - rendering metadata.
 * @returns the Markdown document.
 */
function renderMarkdown(markdown: string, meta: RenderMeta): string {
  const body = applyDisclaimer(meta.style, markdown)
  if (meta.title === undefined || meta.title === '' || bodyOpensWithLevel1Heading(markdown)) return body
  return `# ${meta.title}\n\n${body}`
}

/** The Markdown renderer. */
export const markdownRenderer: Renderer = { format: 'markdown', render: renderMarkdown }
