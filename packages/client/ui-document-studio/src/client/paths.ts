/**
 * Workspace-relative path helpers for the studio's inject wiring.
 * @module @deepseek-ai/dsh-client-ui-document-studio/client/paths
 */

/** Extensions the document workline delivers. */
export const DELIVERABLE_EXTENSIONS = ['.md', '.html', '.htm', '.pdf', '.docx', '.pptx'] as const

/**
 * Whether a path carries a deliverable extension.
 * @param path - produced-file path, using `/` or `\` separators.
 * @returns true for a file the document workline produces.
 */
export function isDeliverablePath(path: string): boolean {
  const lower = path.toLowerCase()
  return DELIVERABLE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

/**
 * The workspace-relative directory containing one produced file ('' at the workspace root).
 * @param path - Workspace-relative file path, using `/` or `\` separators.
 * @returns The path's parent directory, or '' when the file sits at the workspace root.
 */
export function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? '' : path.slice(0, index)
}
