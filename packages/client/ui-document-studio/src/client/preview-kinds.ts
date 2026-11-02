/**
 * Preview kind predicates shared by the studio view and its preview pane.
 * @module @deepseek-ai/dsh-client-ui-document-studio/client/preview-kinds
 */

/**
 * Whether a produced path renders as an inline HTML frame.
 * @param path - produced-file path.
 * @returns true for `.html` and `.htm`.
 */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * Whether a produced path renders as Markdown.
 * @param path - produced-file path.
 * @returns true for `.md`.
 */
export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path)
}

/**
 * Whether a produced path renders as text in the preview pane.
 * @param path - produced-file path.
 * @returns true for HTML and the plain-text formats.
 */
export function isTextPreviewable(path: string): boolean {
  return isHtmlPath(path) || /\.(md|txt|json|ya?ml|csv|log)$/i.test(path)
}
